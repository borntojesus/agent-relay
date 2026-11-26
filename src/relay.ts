import type { DatabaseSync } from "node:sqlite";
import { AuditLog } from "./audit.ts";
import { TokenStore } from "./tokens.ts";
import { TeamStore } from "./teams.ts";
import { RoomStore } from "./rooms/store.ts";
import { RoomService } from "./rooms/service.ts";
import { ActionApprovals } from "./approvals/actions.ts";
import { ConsoleChannel, type OwnerChannel } from "./approvals/channel.ts";
import { OwnerBot } from "./telegram/owner-bot.ts";
import { TaskStore } from "./tasks/store.ts";
import { TaskService } from "./tasks/service.ts";
import { botTokenVar } from "./config.ts";
import { DeviceStore } from "./push/devices.ts";
import { createDispatcher } from "./push/dispatcher.ts";
import type { PushSender } from "./push/types.ts";
import { ProjectStore } from "./projects.ts";
import { IntegrationStore } from "./integrations/store.ts";
import { SecretBox, parseSecretKey } from "./integrations/secrets.ts";

export interface Relay {
  db: DatabaseSync;
  tokens: TokenStore;
  teams: TeamStore;
  audit: AuditLog;
  rooms: RoomService;
  approvals: ActionApprovals;
  /** Tasks between an owner's own machines (0.5.0). */
  tasks: TaskService;
  /** Push tokens of the owners' devices (0.6.0). */
  devices: DeviceStore;
  /** Projects grouping rooms and tasks (0.6.0). */
  projects: ProjectStore;
  /** External accounts such as Linear, with sealed secrets (0.6.0). */
  integrations: IntegrationStore;
  /** The configured approval channel (Telegram, tests) of each owner that has one; console-only owners are not here. */
  channels: Map<string, OwnerChannel>;
  bots: OwnerBot[];
}

export interface RelayOptions {
  db: DatabaseSync;
  /** Bot tokens by env var name (RELAY_BOT_TOKEN_<OWNER>). */
  botTokens?: Record<string, string>;
  /** Channels to use instead of Telegram bots (tests, other front ends). */
  channels?: Map<string, OwnerChannel>;
  /** Push senders (APNs, FCM, fakes in tests); none means no push. */
  pushSenders?: PushSender[];
  bigProjects?: RegExp;
  fetchFn?: typeof fetch;
  /** RELAY_SECRET_KEY (32 bytes, base64 or hex); without it integrations cannot hold secrets. */
  secretKey?: string;
  /** fetch for integration APIs (Linear); tests pass a fake. */
  integrationFetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Wires the stores and services on one database. An owner gets a Telegram bot
 * when there is a bot token for them and they have a Telegram user id.
 */
export function createRelay(o: RelayOptions): Relay {
  const now = o.now ?? Date.now;
  const tokens = new TokenStore(o.db, now);
  const teams = new TeamStore(o.db, now);
  const audit = new AuditLog(o.db, now);
  const channels = o.channels ?? new Map<string, OwnerChannel>();
  // An owner with only a console token still has an approval channel: the
  // console reads held items from the database (docs/console-api.md).
  const consoleChannel = new ConsoleChannel();
  const channelFor = (owner: string): OwnerChannel | undefined =>
    channels.get(owner) ??
    (tokens.hasConsole(owner) ? consoleChannel : undefined);
  const devices = new DeviceStore(o.db, now);
  const onPending = createDispatcher(devices, o.pushSenders ?? [], o.log);
  const rooms = new RoomService({
    onPending,
    store: new RoomStore(o.db),
    tokens,
    teams,
    channelFor,
    now,
    ...(o.log ? { log: o.log } : {}),
  });
  const approvals = new ActionApprovals({
    db: o.db,
    tokens,
    channelFor,
    now: () => new Date(now()),
    onPending,
    ...(o.bigProjects ? { bigProjects: o.bigProjects } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  const tasks = new TaskService({
    store: new TaskStore(o.db),
    ownerExists: (id) => Boolean(tokens.owner(id)),
    onPending,
    now,
    // A notice (no buttons) in the owner's own channel; the decision is made in the console.
    notify: (owner, text) => {
      const ch = channels.get(owner);
      if (!ch) return;
      void ch
        .send(text)
        .catch((err: unknown) =>
          o.log?.(
            `[tasks] notice to ${owner} failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
    ...(o.log ? { log: o.log } : {}),
  });
  const projects = new ProjectStore(o.db, teams, now);
  const integrations = new IntegrationStore({
    db: o.db,
    teams,
    ...(o.secretKey ? { box: new SecretBox(parseSecretKey(o.secretKey)) } : {}),
    ...(o.integrationFetch ? { fetchFn: o.integrationFetch } : {}),
    now,
  });
  const bots: OwnerBot[] = [];
  if (!o.channels) {
    for (const owner of tokens.owners()) {
      const botToken = o.botTokens?.[botTokenVar(owner.id)];
      if (!botToken) continue;
      if (!owner.telegramUser) {
        o.log?.(
          `[relay] owner ${owner.id} has a bot token but no Telegram user id; no bot`,
        );
        continue;
      }
      const bot = new OwnerBot({
        owner: owner.id,
        botToken,
        userId: owner.telegramUser,
        rooms,
        approvals,
        ...(o.fetchFn ? { fetchFn: o.fetchFn } : {}),
        ...(o.log ? { log: o.log } : {}),
      });
      bots.push(bot);
      channels.set(owner.id, bot);
    }
  }
  return {
    db: o.db,
    tokens,
    teams,
    audit,
    rooms,
    approvals,
    tasks,
    devices,
    projects,
    integrations,
    channels,
    bots,
  };
}
