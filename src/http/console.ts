import type { IncomingMessage, ServerResponse } from "node:http";
import type { Relay } from "../relay.ts";
import type { Caller } from "../tokens.ts";
import { canRead, canSend, isConsole, isWorker } from "../grants.ts";
import { TeamError } from "../teams.ts";
import { VERSION } from "../mcp/server.ts";
import { TaskError } from "../tasks/service.ts";
import { z } from "zod";
import { HttpError, readBody, send } from "./util.ts";
import { handleProjects, projectIdOf } from "./projects.ts";
import { ScopedError } from "../projects.ts";

/** A positive whole number from a query value, or undefined when absent. */
function intParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return undefined;
  if (!/^\d{1,15}$/.test(raw))
    throw new HttpError(400, `${key} is a whole number`);
  return Number(raw);
}

const DEVICE = z.object({
  token: z.string().trim().min(8).max(512).regex(/^[A-Za-z0-9:_\-.=]+$/),
  platform: z.enum(["ios", "android"]),
  environment: z.enum(["sandbox", "production"]),
  app: z.string().trim().min(1).max(128),
});

function bodyObj(body: unknown): Record<string, unknown> {
  if (body === undefined) return {};
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "body must be a JSON object");
  return body as Record<string, unknown>;
}

/**
 * The owner console routes (docs/console-api.md). The bearer must be a console
 * token (`owner:<id>` grant); read routes need its read right, routes that
 * change something its send right. Ownership itself is checked in the stores
 * and services, which all take the owner id from the token, never the request.
 */
export async function handleOwner(
  relay: Relay,
  caller: Caller,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
): Promise<void> {
  const owner = caller.owner;
  const channel = `owner:${owner}`;
  if (!isConsole(caller.grants))
    throw new HttpError(403, "not a console token (needs an owner:<id> grant)");
  const asked = req.headers["x-relay-owner"];
  const askedOwner = (Array.isArray(asked) ? asked[0] : asked)
    ?.trim()
    .toLowerCase();
  if (askedOwner !== undefined && askedOwner !== owner)
    throw new HttpError(401, "this token does not belong to that username");
  const read = canRead(caller.grants, channel);
  const write = canSend(caller.grants, channel);
  const need = (right: "r" | "w"): void => {
    if (right === "r" && !read)
      throw new HttpError(403, "this console token cannot read");
    if (right === "w" && !write)
      throw new HttpError(403, "this console token is read-only");
  };
  const actor = `console:${caller.label}`;
  const audit = (
    action: string,
    target: string,
    ok: boolean,
    detail?: string,
  ) =>
    relay.audit.write({
      actor,
      owner,
      action,
      target,
      ok,
      ...(detail ? { detail } : {}),
    });
  const rooms = () =>
    relay.rooms.forOwner(owner, {
      tokenId: caller.tokenId,
      label: caller.label,
    });
  const get = req.method === "GET";
  const post = req.method === "POST";
  const patch = req.method === "PATCH";
  const del = req.method === "DELETE";
  const nameOfOwner = (id: string) => relay.tokens.owner(id)?.name ?? id;
  /** A team as its member sees it (GET /owner/teams). */
  const teamView = (id: string) => {
    const t = relay.teams.get(id)!;
    return {
      id: t.id,
      name: t.name,
      gate: t.gate,
      role: relay.teams.role(t.id, owner) ?? "member",
      members: relay.teams.members(t.id).map((m) => ({
        id: m.owner,
        name: nameOfOwner(m.owner),
        role: m.role,
      })),
      rooms: relay.rooms.roomsOfTeam(t.id),
      invites: relay.teams
        .invites(t.id)
        .map((i) => ({ id: i.id, name: i.name, note: i.note })),
    };
  };

  if (path === "/owner/me" && get) {
    need("r");
    const o = relay.tokens.owner(owner)!;
    send(res, 200, {
      owner: { id: o.id, name: o.name, tz: o.tz },
      token: { label: caller.label, read, send: write },
      channels: { telegram: relay.channels.has(owner), console: true },
      teams: relay.teams
        .ofOwner(owner)
        .map((t) => ({ id: t.id, name: t.name, role: t.role })),
      version: VERSION,
      pendingTasks: relay.tasks.pendingCount(owner),
    });
    return;
  }

  if (path === "/owner/summary" && get) {
    need("r");
    const counters = rooms().counters();
    send(res, 200, {
      unread: counters.unread,
      unreadOwn: counters.unreadOwn,
      pendingPosts: counters.pendingPosts,
      pendingApprovals: (await relay.approvals.ownerPending(owner)).length,
      feedCursor: counters.feedCursor,
      auditCursor: relay.audit.maxId(owner),
      pendingTasks: relay.tasks.pendingCount(owner),
    });
    return;
  }

  if (path === "/owner/teams" && get) {
    need("r");
    send(res, 200, {
      teams: relay.teams.ofOwner(owner).map((t) => teamView(t.id)),
    });
    return;
  }

  const teamRoute =
    /^\/owner\/teams\/([^/]+)(?:\/(members|invites)(?:\/([^/]+))?)?$/.exec(
      path,
    );
  if (teamRoute && (patch || post || del)) {
    need("w");
    const id = decodeURIComponent(teamRoute[1]!).toLowerCase();
    const sub = teamRoute[2];
    const item = teamRoute[3] ? decodeURIComponent(teamRoute[3]) : undefined;
    const action =
      sub === "members"
        ? "console.team.member"
        : sub === "invites"
          ? "console.team.invite"
          : "console.team.update";
    const route =
      (!sub && patch) ||
      (sub && !item && post) ||
      (sub && item !== undefined && del);
    if (!route) throw new HttpError(404, "not found");
    // A team the owner is not in answers like one that does not exist.
    const role = relay.teams.get(id) ? relay.teams.role(id, owner) : undefined;
    if (!role) {
      audit(action, id, false, "no such team");
      throw new HttpError(404, "no such team");
    }
    if (role !== "admin") {
      audit(action, id, false, "not a team admin");
      throw new HttpError(403, "only a team admin can change the team");
    }
    try {
      let detail: string;
      if (!sub) {
        const body = bodyObj(await readBody(req));
        const name = body.name;
        const gate = body.gate;
        if (name === undefined && gate === undefined)
          throw new HttpError(400, "say what changes: name, gate or both");
        if (name !== undefined && (typeof name !== "string" || !name.trim()))
          throw new HttpError(400, "name is a non-empty string");
        if (gate !== undefined && gate !== "on" && gate !== "off")
          throw new HttpError(400, "gate is on or off");
        if (gate !== undefined) relay.teams.setGate(id, gate);
        if (typeof name === "string") relay.teams.rename(id, name);
        detail = [
          name !== undefined ? `name=${String(name).trim()}` : "",
          gate !== undefined ? `gate=${String(gate)}` : "",
        ]
          .filter(Boolean)
          .join(" ");
      } else if (sub === "members" && post) {
        const body = bodyObj(await readBody(req));
        if (typeof body.owner !== "string" || !body.owner.trim())
          throw new HttpError(400, "owner is required");
        const m = relay.teams.setMember(id, body.owner, body.role ?? "member");
        detail = `add ${m.owner} ${m.role}`;
      } else if (sub === "members") {
        const who = item!.toLowerCase();
        if (!relay.teams.removeMember(id, who))
          throw new HttpError(404, "no such member");
        detail = `remove ${who}`;
      } else if (post) {
        const body = bodyObj(await readBody(req));
        if (typeof body.name !== "string")
          throw new HttpError(400, "name is required");
        const note =
          typeof body.note === "string" ? body.note : null;
        const inv = relay.teams.invite(id, body.name, note);
        detail = `invite #${inv.id} ${inv.name}`;
      } else {
        if (!/^\d{1,15}$/.test(item!))
          throw new HttpError(400, "invite id is a whole number");
        if (!relay.teams.uninvite(id, { id: Number(item) }))
          throw new HttpError(404, "no such invite");
        detail = `uninvite #${item}`;
      }
      audit(action, id, true, detail);
    } catch (err) {
      audit(action, id, false, err instanceof Error ? err.message : String(err));
      if (err instanceof TeamError) throw new HttpError(400, err.message);
      throw err;
    }
    send(res, 200, teamView(id));
    return;
  }

  if (path === "/owner/rooms" && get) {
    need("r");
    const out = rooms().list();
    send(res, 200, {
      ...out,
      rooms: out.rooms.map((r) => ({ ...r, projectId: relay.projects.roomProject(r.room) })),
    });
    return;
  }

  const roomRoute =
    /^\/owner\/rooms\/([^/]+)\/(threads|ack)(?:\/([^/]+))?$/.exec(path);
  if (roomRoute) {
    const room = decodeURIComponent(roomRoute[1]!);
    if (roomRoute[2] === "threads" && !roomRoute[3] && get) {
      need("r");
      send(res, 200, rooms().threads(room));
      return;
    }
    if (roomRoute[2] === "threads" && roomRoute[3] && get) {
      need("r");
      const before = intParam(url, "before");
      const limit = intParam(url, "limit");
      const out = rooms().read(room, decodeURIComponent(roomRoute[3]), {
        ...(before !== undefined ? { before } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      send(res, 200, { _trust: "untrusted", ...out });
      return;
    }
    if (roomRoute[2] === "ack" && !roomRoute[3] && post) {
      // Read state only: needs read, not audited.
      need("r");
      send(res, 200, rooms().ack(room, bodyObj(await readBody(req))));
      return;
    }
  }

  if (path === "/owner/feed" && get) {
    need("r");
    const after = intParam(url, "after");
    const limit = intParam(url, "limit");
    const out = rooms().feed({
      ...(after !== undefined ? { after: String(after) } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    send(res, 200, { _trust: "untrusted", ...out });
    return;
  }

  if (path === "/owner/pending" && get) {
    need("r");
    send(res, 200, {
      posts: rooms().pending(),
      approvals: await relay.approvals.ownerPending(owner),
    });
    return;
  }

  const postDecide = /^\/owner\/posts\/(\d{1,15})\/decide$/.exec(path);
  if (postDecide && post) {
    need("w");
    const id = Number(postDecide[1]);
    const body = bodyObj(await readBody(req));
    const out = rooms().decide(id, body.decision);
    if (!out) {
      audit("console.post.decide", `#${id}`, false, "no such message");
      throw new HttpError(404, "no such message");
    }
    audit("console.post.decide", `#${id}`, out.outcome !== "gone", out.outcome);
    send(res, 200, out);
    return;
  }

  if (path === "/owner/approvals" && get) {
    need("r");
    const status = url.searchParams.get("status") || undefined;
    const limit = intParam(url, "limit");
    send(res, 200, {
      approvals: await relay.approvals.ownerJournal(owner, {
        ...(status ? { status } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    });
    return;
  }

  const apvDecide = /^\/owner\/approvals\/([0-9a-f]{24})\/decide$/.exec(path);
  if (apvDecide && post) {
    need("w");
    const id = apvDecide[1]!;
    const body = bodyObj(await readBody(req));
    try {
      const v = await relay.approvals.decideByOwner(owner, id, body.decision);
      if (!v) throw new HttpError(404, "no such approval");
      audit(
        "console.approval.decide",
        id,
        true,
        `${v.status} ${v.tier} ${v.action}`,
      );
      send(res, 200, v);
    } catch (err) {
      audit(
        "console.approval.decide",
        id,
        false,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
    return;
  }

  if (path === "/owner/audit" && get) {
    need("r");
    const before = intParam(url, "before");
    const limit = intParam(url, "limit");
    send(res, 200, {
      entries: relay.audit.ofOwner(owner, {
        ...(before !== undefined ? { before } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    });
    return;
  }

  if (path === "/owner/tokens" && get) {
    need("r");
    const all = ["1", "true"].includes(url.searchParams.get("all") ?? "");
    send(res, 200, {
      tokens: relay.tokens.ofOwner(owner, all).map((t) => ({
        id: t.id,
        label: t.label,
        kind: isWorker(t.grants)
          ? "worker"
          : isConsole(t.grants)
            ? "console"
            : "agent",
        grants: t.grants,
        rooms: t.revokedAt ? [] : relay.rooms.roomsOfToken(t),
        createdAt: t.createdAt,
        revokedAt: t.revokedAt,
        lastUsedAt: t.lastUsedAt,
        current: t.id === caller.tokenId,
      })),
    });
    return;
  }

  const revoke = /^\/owner\/tokens\/([^/]+)\/revoke$/.exec(path);
  if (revoke && post) {
    need("w");
    const label = decodeURIComponent(revoke[1]!).toLowerCase();
    const out = relay.tokens.revokeOwn(owner, label, caller.tokenId);
    audit(
      "console.token.revoke",
      label,
      out === "revoked",
      out === "revoked" ? undefined : out,
    );
    if (out === "missing") throw new HttpError(404, "no such active token");
    if (out === "current")
      throw new HttpError(
        400,
        "a console cannot revoke the token it is signed in with",
      );
    send(res, 200, { revoked: label });
    return;
  }

  // --- devices and push (0.6.0; docs/console-api.md "Devices and push")

  if (path === "/owner/devices" && get) {
    need("r");
    send(res, 200, {
      devices: relay.devices.list(owner).map((d) => ({
        platform: d.platform,
        environment: d.environment,
        app: d.app,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
      })),
    });
    return;
  }

  if (path === "/owner/devices" && post) {
    need("w");
    const parsed = DEVICE.safeParse(bodyObj(await readBody(req)));
    if (!parsed.success)
      throw new HttpError(400, "token, platform (ios|android), environment (sandbox|production) and app are required");
    relay.devices.upsert({ ...parsed.data, owner });
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const deviceRoute = /^\/owner\/devices\/([^/]+)$/.exec(path);
  if (deviceRoute && del) {
    need("w");
    relay.devices.delete(owner, decodeURIComponent(deviceRoute[1]!));
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  // --- machines and tasks (0.5.0; docs/console-api.md "Tasks")

  /** Runs a task/machine route that changes something: audited ok true, or ok false with the reason. */
  const change = async <T>(
    action: string,
    target: string,
    fn: () => T | Promise<T>,
    detail?: (out: T) => string,
  ): Promise<T> => {
    try {
      const out = await fn();
      audit(action, target, true, detail?.(out));
      return out;
    } catch (err) {
      audit(action, target, false, err instanceof Error ? err.message : String(err));
      if (err instanceof TaskError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  const viewOnly = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof TaskError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };

  if (path === "/owner/machines" && get) {
    need("r");
    send(res, 200, { machines: relay.tasks.machinesOf(owner) });
    return;
  }

  const machineRoute = /^\/owner\/machines\/([^/]+)$/.exec(path);
  if (machineRoute && patch) {
    need("w");
    const id = decodeURIComponent(machineRoute[1]!).toLowerCase();
    const body = bodyObj(await readBody(req));
    const out = await change(
      body.killed === true ? "console.machine.kill" : "console.machine.update",
      id,
      () => relay.tasks.updateMachine(owner, id, body, caller.label),
      () =>
        [
          body.name !== undefined ? "name" : "",
          body.policy !== undefined ? "policy" : "",
          body.killed !== undefined ? `killed=${String(body.killed)}` : "",
        ]
          .filter(Boolean)
          .join(" "),
    );
    send(res, 200, out);
    return;
  }

  if (path === "/owner/tasks" && get) {
    need("r");
    const limit = intParam(url, "limit");
    const machine = url.searchParams.get("machine") || undefined;
    const status = url.searchParams.get("status") || undefined;
    send(res, 200, {
      tasks: viewOnly(() =>
        relay.tasks.list(owner, {
          ...(machine ? { machine } : {}),
          ...(status ? { status } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
    });
    return;
  }

  if (path === "/owner/tasks" && post) {
    need("w");
    const body = bodyObj(await readBody(req));
    const out = await change(
      "console.task.create",
      typeof body.machine === "string" ? body.machine : "-",
      () => {
        // An optional project: readable by the owner and not archived.
        const pid = projectIdOf(body);
        if (pid) {
          try {
            relay.projects.attachable(owner, pid, "read");
          } catch (err) {
            if (err instanceof ScopedError) throw new HttpError(err.status, err.message);
            throw err;
          }
        }
        return relay.tasks.create(owner, caller.label, body, undefined, pid ?? null);
      },
      (t) => `${t.id} ${t.status} ${t.folder}`,
    );
    send(res, 201, out);
    return;
  }

  if (path === "/owner/task-log" && get) {
    need("r");
    const before = intParam(url, "before");
    const limit = intParam(url, "limit");
    const machine = url.searchParams.get("machine") || undefined;
    const task = url.searchParams.get("task") || undefined;
    send(res, 200, {
      events: relay.tasks.log(owner, {
        ...(machine ? { machine } : {}),
        ...(task ? { task } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    });
    return;
  }

  const taskRoute =
    /^\/owner\/tasks\/([^/]+)(?:\/(start|cancel|followup|events|approvals)(?:\/([^/]+))?)?$/.exec(
      path,
    );
  if (taskRoute) {
    const id = decodeURIComponent(taskRoute[1]!);
    const sub = taskRoute[2];
    const item = taskRoute[3] ? decodeURIComponent(taskRoute[3]) : undefined;
    if (!sub && get) {
      need("r");
      send(res, 200, viewOnly(() => relay.tasks.get(owner, id)));
      return;
    }
    if (sub === "events" && !item && get) {
      need("r");
      const after = intParam(url, "after");
      const limit = intParam(url, "limit");
      send(res, 200, {
        events: viewOnly(() => relay.tasks.events(owner, id, after ?? 0, limit ?? 500)),
      });
      return;
    }
    if ((sub === "start" || sub === "cancel") && !item && post) {
      need("w");
      const out = await change(
        `console.task.${sub}`,
        id,
        () =>
          sub === "start"
            ? relay.tasks.startTask(owner, id, caller.label)
            : relay.tasks.cancel(owner, id, caller.label),
        (t) => `${t.status}${t.cancelRequested ? " cancel_requested" : ""}`,
      );
      send(res, 200, out);
      return;
    }
    if (sub === "followup" && !item && post) {
      need("w");
      const body = bodyObj(await readBody(req));
      const out = await change(
        "console.task.followup",
        id,
        () => relay.tasks.followup(owner, id, body, caller.label),
        (t) => `${t.id} ${t.status}`,
      );
      send(res, 201, out);
      return;
    }
    if (sub === "approvals" && item && post) {
      need("w");
      const body = bodyObj(await readBody(req));
      const out = await change(
        "console.task.approval",
        `${id} ${item}`,
        () => relay.tasks.decide(owner, id, item, body.decision, caller.label),
        (o) => o.approval.status,
      );
      send(res, 200, out);
      return;
    }
  }

  // --- projects and integrations (0.6.0; docs/console-api.md "Projects")
  const handled = await handleProjects(
    {
      relay,
      owner,
      actor,
      need,
      audit,
      visibleRooms: () => rooms().rooms,
    },
    req,
    res,
    url,
    path,
  );
  if (handled) return;

  throw new HttpError(404, "not found");
}
