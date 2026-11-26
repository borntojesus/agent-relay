import { openDb } from "../src/db.ts";
import { createRelay, type Relay } from "../src/relay.ts";
import type { Keyboard, OwnerChannel } from "../src/approvals/channel.ts";
import type { Caller } from "../src/tokens.ts";
import { parseGrantSpec } from "../src/grants.ts";
import type { PushSender } from "../src/push/types.ts";

/** An approval channel that records what it was asked to show. */
export class FakeChannel implements OwnerChannel {
  sent: Array<{ id: number; text: string; keyboard?: Keyboard }> = [];
  edits: Array<{ id: number; text: string }> = [];
  fail?: Error;
  link = "https://t.me/example_bot";
  private next = 100;

  async send(
    text: string,
    keyboard?: Keyboard,
  ): Promise<{ messageId: number }> {
    if (this.fail) throw this.fail;
    const id = this.next++;
    this.sent.push({ id, text, ...(keyboard ? { keyboard } : {}) });
    return { messageId: id };
  }

  async edit(id: number, text: string): Promise<void> {
    this.edits.push({ id, text });
  }

  cards(): Array<{ id: number; text: string; keyboard: Keyboard }> {
    return this.sent.filter(
      (s): s is { id: number; text: string; keyboard: Keyboard } =>
        Boolean(s.keyboard),
    );
  }

  notices(): string[] {
    return this.sent.filter((s) => !s.keyboard).map((s) => s.text);
  }

  /** The callback data of the buttons of the last card. */
  lastButtons(): string[] {
    const c = this.cards().at(-1);
    return c
      ? c.keyboard.inline_keyboard.flat().map((b) => b.callback_data)
      : [];
  }
}

export interface World {
  relay: Relay;
  clock: { t: number };
  ch: Record<string, FakeChannel>;
  logs: string[];
  /** Creates a token and returns its caller and bearer. */
  agent(
    label: string,
    owner: string,
    ...grants: string[]
  ): { caller: Caller; token: string };
}

/** Two owners (alice, bob) with fake channels, a fixed clock and rooms as asked. */
export function world(
  opts: {
    rooms?: string[];
    channels?: string[];
    bigProjects?: RegExp;
    pushSenders?: PushSender[];
    secretKey?: string;
    integrationFetch?: typeof fetch;
  } = {},
): World {
  const clock = { t: Date.parse("2026-11-23T10:00:00Z") };
  const ch: Record<string, FakeChannel> = {};
  const channels = new Map<string, OwnerChannel>();
  for (const o of opts.channels ?? ["alice", "bob"]) {
    ch[o] = new FakeChannel();
    channels.set(o, ch[o]);
  }
  const logs: string[] = [];
  const relay = createRelay({
    db: openDb(),
    channels,
    now: () => clock.t,
    log: (l) => logs.push(l),
    ...(opts.pushSenders ? { pushSenders: opts.pushSenders } : {}),
    ...(opts.bigProjects ? { bigProjects: opts.bigProjects } : {}),
    ...(opts.secretKey ? { secretKey: opts.secretKey } : {}),
    ...(opts.integrationFetch
      ? { integrationFetch: opts.integrationFetch }
      : {}),
  });
  relay.tokens.addOwner({
    id: "alice",
    name: "Alice",
    telegramUser: "111",
    tz: "Europe/Berlin",
  });
  relay.tokens.addOwner({ id: "bob", name: "Bob", telegramUser: "222" });
  for (const r of opts.rooms ?? ["team", "shared"]) relay.rooms.addRoom(r, r);
  const agent = (label: string, owner: string, ...grants: string[]) => {
    const { token } = relay.tokens.create({
      label,
      owner,
      grants: grants.map(parseGrantSpec),
    });
    return { caller: relay.tokens.authenticate(token)!, token };
  };
  return { relay, clock, ch, logs, agent };
}

/** Lets fire-and-forget promises settle. */
export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A machine of `owner` with a permissive test policy (overridable) and its worker token. */
export function addMachine(
  w: World,
  id: string,
  owner: string,
  policy: Record<string, unknown> = {},
): { token: string; caller: Caller } {
  w.relay.tasks.addMachine({
    id,
    owner,
    name: id,
    policy: { folders: ["/work"], requireTap: false, ...policy },
  });
  return w.agent(`${id}-worker`, owner, `machine:${id}:rw`);
}

/** Starts the HTTP server of `w` on a free port; `call(path, token, {json?, method?})` returns status and parsed body. */
export async function serveHttp(w: World): Promise<{
  call: (
    path: string,
    token: string,
    init?: RequestInit & { json?: unknown },
  ) => Promise<{ status: number; body: any; text: string }>;
  close: () => void;
}> {
  const { createHttpServer } = await import("../src/http/server.ts");
  const server = createHttpServer(w.relay);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const call = async (
    path: string,
    token: string,
    init: RequestInit & { json?: unknown } = {},
  ) => {
    const { json, ...rest } = init;
    const r = await fetch(base + path, {
      ...(json !== undefined
        ? { method: "POST", body: JSON.stringify(json) }
        : {}),
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(rest.headers ?? {}),
      },
    });
    const text = await r.text();
    return {
      status: r.status,
      body: (text ? JSON.parse(text) : undefined) as any,
      text,
    };
  };
  return { call, close: () => server.close() };
}
