import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http/server.ts";
import { openDb } from "../src/db.ts";
import { GrantError, parseGrants, parseGrantSpec } from "../src/grants.ts";
import { flush, world, type World } from "./helpers.ts";

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function up(w: World) {
  const server = createHttpServer(w.relay);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    path: string,
    token: string,
    init: RequestInit & { json?: unknown } = {},
  ) => {
    const { json, ...rest } = init;
    const r = await fetch(base + path, {
      ...rest,
      ...(json !== undefined
        ? { method: "POST", body: JSON.stringify(json) }
        : {}),
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
    };
  };
  return { call };
}

/** No Telegram channels: alice and bob each have an agent in `shared` and a console. */
function consoleWorld(channels: string[] = []) {
  const w = world({ channels });
  const a1 = w.agent(
    "alice-mac",
    "alice",
    "peer:team:rw",
    "peer:shared:rw",
    "approval:ops:w",
  );
  const a2 = w.agent("alice-phone", "alice", "peer:team:rw");
  const b1 = w.agent("bob-mac", "bob", "peer:shared:rw");
  const ac = w.agent("alice-console", "alice", "owner:alice:rw");
  const bc = w.agent("bob-console", "bob", "owner:bob:rw");
  return { w, a1, a2, b1, ac, bc };
}

describe("console grants", () => {
  it("parses owner grants and refuses owner:*", () => {
    expect(parseGrantSpec("owner:alice:r")).toEqual({
      channel: "owner:alice",
      read: true,
      send: false,
    });
    expect(() => parseGrantSpec("owner:*:rw")).toThrow(GrantError);
    expect(() =>
      parseGrants([{ channel: "owner:*", read: true, send: true }]),
    ).toThrow(GrantError);
  });

  it("a console grant names the own owner and is the only grant", () => {
    const w = world();
    expect(() => w.agent("x1", "alice", "owner:bob:rw")).toThrow(GrantError);
    expect(() =>
      w.agent("x2", "alice", "owner:alice:rw", "peer:team:rw"),
    ).toThrow(GrantError);
    expect(w.relay.tokens.hasConsole("alice")).toBe(false);
    w.agent("alice-console", "alice", "owner:alice:r");
    expect(w.relay.tokens.hasConsole("alice")).toBe(true);
    expect(() =>
      w.relay.tokens.setGrants("alice-console", [
        parseGrantSpec("owner:alice:rw"),
        parseGrantSpec("peer:team:r"),
      ]),
    ).toThrow(GrantError);
    w.agent("alice-mac", "alice", "peer:team:rw");
    expect(() =>
      w.relay.tokens.setGrants("alice-mac", [parseGrantSpec("owner:bob:r")]),
    ).toThrow(GrantError);
    // A console is never a room member.
    expect(w.relay.rooms.members("team").map((m) => m.label)).toEqual([
      "alice-mac",
    ]);
  });

  it("writes last_used_at at most once a minute", () => {
    const w = world();
    const a = w.agent("alice-mac", "alice", "peer:team:rw");
    const first = w.relay.tokens.ofOwner("alice")[0]!.lastUsedAt;
    expect(first).toBe(new Date(w.clock.t).toISOString());
    w.clock.t += 30_000;
    w.relay.tokens.authenticate(a.token);
    expect(w.relay.tokens.ofOwner("alice")[0]!.lastUsedAt).toBe(first);
    w.clock.t += 31_000;
    w.relay.tokens.authenticate(a.token);
    expect(w.relay.tokens.ofOwner("alice")[0]!.lastUsedAt).toBe(
      new Date(w.clock.t).toISOString(),
    );
  });
});

describe("migrations", () => {
  it("adds ver and last_used_at to an old database and backfills ver = id", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    try {
      const file = join(dir, "relay.db");
      let db = openDb(file);
      db.exec(
        "INSERT INTO owners (id, name, created_at) VALUES ('alice', 'Alice', 'x')",
      );
      db.exec("INSERT INTO rooms (name, created_at) VALUES ('team', 'x')");
      for (let i = 0; i < 2; i++) {
        db.exec(
          `INSERT INTO messages (room, thread, sender_token, sender_label, sender_owner, sent_at, text, status, gated, nonce)
           VALUES ('team', 't', 1, 'a', 'alice', 'x', 'hi', 'delivered', 0, 'n')`,
        );
      }
      // Back to the 0.1.0 shape.
      db.exec(
        "DROP INDEX messages_ver; ALTER TABLE messages DROP COLUMN ver; ALTER TABLE tokens DROP COLUMN last_used_at",
      );
      db.close();
      db = openDb(file);
      db.close();
      db = openDb(file); // idempotent
      expect(
        db.prepare("SELECT id, ver FROM messages ORDER BY id").all(),
      ).toEqual([
        { id: 1, ver: 1 },
        { id: 2, ver: 2 },
      ]);
      expect(
        (
          db.prepare("PRAGMA table_info(tokens)").all() as Array<{
            name: string;
          }>
        ).some((c) => c.name === "last_used_at"),
      ).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("owner console", () => {
  it("without Telegram, a console holds a cross-owner post as pending", async () => {
    const w = world({ channels: [] });
    const a1 = w.agent("alice-mac", "alice", "peer:shared:rw");
    w.agent("bob-mac", "bob", "peer:shared:rw");
    await expect(
      w.relay.rooms
        .for(a1.caller)!
        .post({ room: "shared", thread: "plan", text: "hi" }),
    ).rejects.toThrow(/no approval channel/);
    w.agent("alice-console", "alice", "owner:alice:rw");
    const r = await w.relay.rooms
      .for(a1.caller)!
      .post({ room: "shared", thread: "plan", text: "hi" });
    expect(r.status).toBe("pending_approval");
    // /health lists configured channels only.
    expect(w.relay.channels.size).toBe(0);
  });

  it("shows a pending post only to its owner, and a decision delivers it and moves it in the feed", async () => {
    const { w, a1, ac, bc } = consoleWorld();
    const { call } = await up(w);
    const posted = await w.relay.rooms
      .for(a1.caller)!
      .post({ room: "shared", thread: "plan", text: "ship friday?" });
    expect(posted.status).toBe("pending_approval");

    const pa = await call("/owner/pending", ac.token);
    expect(pa.body.posts).toHaveLength(1);
    expect(pa.body.posts[0]).toMatchObject({
      id: posted.id,
      status: "pending",
      mine: true,
      seenBy: ["Bob"],
      from: "alice-mac",
    });
    expect(pa.body.posts[0].expiresAt).toBe(
      new Date(w.clock.t + 24 * 3600_000).toISOString(),
    );

    // Bob sees nothing of it: not pending, not in the feed, not in the thread.
    expect((await call("/owner/pending", bc.token)).body.posts).toEqual([]);
    expect((await call("/owner/feed", bc.token)).body.messages).toEqual([]);
    expect(
      (await call("/owner/rooms/shared/threads/plan", bc.token)).body.messages,
    ).toEqual([]);
    expect((await call("/owner/summary", bc.token)).body.feedCursor).toBe(0);

    const feed0 = await call("/owner/feed", ac.token);
    expect(feed0.body._trust).toBe("untrusted");
    expect(feed0.body.messages.map((m: any) => m.status)).toEqual(["pending"]);
    const cursor = feed0.body.cursor as number;
    expect((await call("/owner/summary", ac.token)).body).toMatchObject({
      pendingPosts: 1,
      feedCursor: cursor,
    });

    // Bob cannot decide alice's post.
    expect(
      (
        await call(`/owner/posts/${posted.id}/decide`, bc.token, {
          json: { decision: "approve" },
        })
      ).status,
    ).toBe(404);

    const d = await call(`/owner/posts/${posted.id}/decide`, ac.token, {
      json: { decision: "approve" },
    });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      outcome: "delivered",
      message: { status: "delivered", decidedBy: "console:alice-console" },
    });

    const feed1 = await call(`/owner/feed?after=${cursor}`, ac.token);
    expect(feed1.body.messages).toHaveLength(1);
    expect(feed1.body.messages[0]).toMatchObject({
      id: posted.id,
      status: "delivered",
    });
    expect(feed1.body.messages[0].ver).toBeGreaterThan(cursor);
    expect(
      (await call("/owner/feed", bc.token)).body.messages.map((m: any) => m.id),
    ).toEqual([posted.id]);

    // Second decision: gone.
    expect(
      (
        await call(`/owner/posts/${posted.id}/decide`, ac.token, {
          json: { decision: "reject" },
        })
      ).body.outcome,
    ).toBe("gone");
    const audit = w.relay.audit.ofOwner("alice");
    expect(
      audit.some(
        (a) =>
          a.action === "console.post.decide" &&
          a.actor === "console:alice-console" &&
          a.ok,
      ),
    ).toBe(true);
  });

  it("rewrites the Telegram card when the console decides first", async () => {
    const { w, a1, ac } = consoleWorld(["alice", "bob"]);
    const { call } = await up(w);
    const posted = await w.relay.rooms
      .for(a1.caller)!
      .post({ room: "shared", thread: "plan", text: "hello bob" });
    const card = w.ch.alice!.cards().at(-1)!;
    await call(`/owner/posts/${posted.id}/decide`, ac.token, {
      json: { decision: "reject" },
    });
    await flush();
    expect(w.ch.alice!.edits.at(-1)).toMatchObject({
      id: card.id,
      text: expect.stringContaining("Rejected (in the app)"),
    });
    // The Telegram tap afterwards changes nothing.
    const [, id, nonce] =
      card.keyboard.inline_keyboard[0]![0]!.callback_data.split(":");
    expect(
      w.relay.rooms.decide("alice", Number(id), nonce!, "approve", "owner:111")
        .outcome,
    ).toBe("gone");
  });

  it("holds a big approval for the console and decides it there", async () => {
    const { w, a1, ac, bc } = consoleWorld();
    const { call } = await up(w);
    const ask = {
      project: "web-app",
      action: "deploy",
      summary: "deploy web-app",
      requester: "alice-mac",
      clientProject: false,
      effect: {},
      ttlMinutes: 15,
      card: false,
    };
    const v = await w.relay.approvals.create(
      {
        key: a1.caller.key,
        label: "alice-mac",
        owner: "alice",
        grants: a1.caller.grants,
      },
      ask,
    );
    expect(v).toMatchObject({ status: "pending", tier: "big" });

    const p = await call("/owner/pending", ac.token);
    expect(p.body.approvals).toHaveLength(1);
    expect(p.body.approvals[0]).toMatchObject({
      id: v.id,
      caller: "alice-mac",
    });
    expect((await call("/owner/summary", ac.token)).body.pendingApprovals).toBe(
      1,
    );
    expect((await call("/owner/pending", bc.token)).body.approvals).toEqual([]);
    expect(
      (
        await call(`/owner/approvals/${v.id}/decide`, bc.token, {
          json: { decision: "approve" },
        })
      ).status,
    ).toBe(404);

    const d = await call(`/owner/approvals/${v.id}/decide`, ac.token, {
      json: { decision: "approve" },
    });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      status: "approved",
      decidedVia: "console",
      decidedBy: "owner:alice",
      caller: "alice-mac",
    });
    expect(
      (
        await call(`/owner/approvals/${v.id}/decide`, ac.token, {
          json: { decision: "reject" },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("/owner/approvals?status=approved", ac.token)).body.approvals,
    ).toHaveLength(1);
    expect(
      (await call("/owner/approvals?status=pending", ac.token)).body.approvals,
    ).toHaveLength(0);
    expect((await call("/owner/approvals?status=nope", ac.token)).status).toBe(
      400,
    );
  });

  it("a read-only console reads but cannot decide; a wrong username or an agent token is refused", async () => {
    const w = world({ channels: [] });
    const a1 = w.agent("alice-mac", "alice", "peer:team:rw");
    const ro = w.agent("alice-watch", "alice", "owner:alice:r");
    const { call } = await up(w);
    const me = await call("/owner/me", ro.token);
    expect(me.body).toMatchObject({
      owner: { id: "alice", name: "Alice", tz: "Europe/Berlin" },
      token: { label: "alice-watch", read: true, send: false },
      channels: { telegram: false, console: true },
      version: "0.6.0",
    });
    expect((await call("/owner/summary", ro.token)).status).toBe(200);
    expect(
      (
        await call("/owner/posts/1/decide", ro.token, {
          json: { decision: "approve" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("/owner/tokens/alice-mac/revoke", ro.token, { json: {} }))
        .status,
    ).toBe(403);

    expect(
      (
        await call("/owner/me", ro.token, {
          headers: { "X-Relay-Owner": "bob" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("/owner/me", ro.token, {
          headers: { "X-Relay-Owner": "alice" },
        })
      ).status,
    ).toBe(200);
    expect((await call("/owner/me", a1.token)).status).toBe(403);
  });

  it("lists the owner tokens and revokes one, never the current one or another owner's", async () => {
    const { w, ac } = consoleWorld();
    const { call } = await up(w);
    const list = await call("/owner/tokens", ac.token);
    const byLabel = Object.fromEntries(
      list.body.tokens.map((t: any) => [t.label, t]),
    );
    expect(Object.keys(byLabel).sort()).toEqual([
      "alice-console",
      "alice-mac",
      "alice-phone",
    ]);
    expect(byLabel["alice-mac"]).toMatchObject({
      kind: "agent",
      rooms: ["shared", "team"],
      current: false,
    });
    expect(byLabel["alice-console"]).toMatchObject({
      kind: "console",
      rooms: [],
      current: true,
    });
    expect(byLabel["alice-console"].lastUsedAt).toBe(
      new Date(w.clock.t).toISOString(),
    );

    expect(
      (await call("/owner/tokens/alice-console/revoke", ac.token, { json: {} }))
        .status,
    ).toBe(400);
    expect(
      (await call("/owner/tokens/bob-mac/revoke", ac.token, { json: {} }))
        .status,
    ).toBe(404);
    const r = await call("/owner/tokens/alice-phone/revoke", ac.token, {
      json: {},
    });
    expect(r).toMatchObject({ status: 200, body: { revoked: "alice-phone" } });
    expect(
      (await call("/owner/tokens", ac.token)).body.tokens.map(
        (t: any) => t.label,
      ),
    ).not.toContain("alice-phone");
    const all = await call("/owner/tokens?all=1", ac.token);
    expect(
      all.body.tokens.find((t: any) => t.label === "alice-phone"),
    ).toMatchObject({ rooms: [], revokedAt: expect.any(String) });
    expect(
      w.relay.audit
        .ofOwner("alice")
        .some(
          (a) =>
            a.action === "console.token.revoke" &&
            a.target === "alice-phone" &&
            a.ok,
        ),
    ).toBe(true);
  });

  it("pages the owner audit by id", async () => {
    const { w, ac } = consoleWorld();
    const { call } = await up(w);
    for (let i = 0; i < 5; i++)
      w.relay.audit.write({
        actor: "alice-mac",
        owner: "alice",
        action: `act.${i}`,
        ok: true,
      });
    w.relay.audit.write({
      actor: "bob-mac",
      owner: "bob",
      action: "bob.only",
      ok: true,
    });
    const p1 = await call("/owner/audit?limit=2", ac.token);
    expect(p1.body.entries.map((e: any) => e.action)).toEqual([
      "act.4",
      "act.3",
    ]);
    const p2 = await call(
      `/owner/audit?limit=2&before=${p1.body.entries[1].id}`,
      ac.token,
    );
    expect(p2.body.entries.map((e: any) => e.action)).toEqual([
      "act.2",
      "act.1",
    ]);
    const summary = await call("/owner/summary", ac.token);
    expect(summary.body.auditCursor).toBe(p1.body.entries[0].id);
    const all = await call("/owner/audit?limit=200", ac.token);
    expect(all.body.entries.every((e: any) => e.owner === "alice")).toBe(true);
  });

  it("counts unread from other owners apart from unreadOwn, and ack clears them", async () => {
    const { w, a1, a2, b1, ac, bc } = consoleWorld();
    const { call } = await up(w);
    await w.relay.rooms
      .for(a2.caller)!
      .post({ room: "team", thread: "build", text: "green" });
    const held = await w.relay.rooms
      .for(b1.caller)!
      .post({ room: "shared", thread: "plan", text: "from bob" });
    expect((await call("/owner/summary", ac.token)).body).toMatchObject({
      unread: 0,
      unreadOwn: 1,
      pendingPosts: 0,
    });
    await call(`/owner/posts/${held.id}/decide`, bc.token, {
      json: { decision: "approve" },
    });
    expect((await call("/owner/summary", ac.token)).body).toMatchObject({
      unread: 1,
      unreadOwn: 1,
    });
    await w.relay.rooms
      .for(a1.caller)!
      .post({ room: "shared", thread: "plan", text: "from alice" });
    expect((await call("/owner/summary", ac.token)).body).toMatchObject({
      unread: 1,
      unreadOwn: 1,
      pendingPosts: 1,
    });

    const rooms = (await call("/owner/rooms", ac.token)).body.rooms;
    const shared = rooms.find((r: any) => r.room === "shared");
    expect(shared).toMatchObject({
      owners: ["alice", "bob"],
      gated: true,
      unread: 1,
      unreadOwn: 0,
      threads: 1,
    });
    expect(rooms.find((r: any) => r.room === "team")).toMatchObject({
      owners: ["alice"],
      gated: false,
      unreadOwn: 1,
    });
    // Bob's console sees only rooms his agents reach.
    expect(
      (await call("/owner/rooms", bc.token)).body.rooms.map((r: any) => r.room),
    ).toEqual(["shared"]);
    expect((await call("/owner/rooms/team/threads", bc.token)).status).toBe(
      404,
    );

    const threads = (await call("/owner/rooms/shared/threads", ac.token)).body
      .threads;
    expect(threads[0]).toMatchObject({
      thread: "plan",
      messages: 2,
      unread: 1,
      unreadOwn: 0,
    });
    const thread = await call("/owner/rooms/shared/threads/plan", ac.token);
    expect(thread.body._trust).toBe("untrusted");
    expect(
      thread.body.messages.map((m: any) => [m.text, m.status, m.mine]),
    ).toEqual([
      ["from bob", "delivered", false],
      ["from alice", "pending", true],
    ]);

    const acked = await call("/owner/rooms/shared/ack", ac.token, {
      json: { all: true },
    });
    expect(acked.body).toMatchObject({ acknowledged: 1, unread: 0 });
    await call("/owner/rooms/team/ack", ac.token, {
      json: { thread: "build" },
    });
    expect((await call("/owner/summary", ac.token)).body).toMatchObject({
      unread: 0,
      unreadOwn: 0,
    });
    // Ack is read state only, not audited.
    expect(
      w.relay.audit.ofOwner("alice").some((a) => a.action.includes("ack")),
    ).toBe(false);
    expect(
      (await call("/owner/rooms/shared/threads/plan", ac.token)).body
        .messages[0].readBy,
    ).toEqual(["alice-console"]);
  });
});
