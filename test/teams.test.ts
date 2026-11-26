import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { GrantError, parseGrants, parseGrantSpec } from "../src/grants.ts";
import { createHttpServer } from "../src/http/server.ts";
import { runAdmin } from "../src/admin.ts";
import { TeamError } from "../src/teams.ts";
import { world, type World } from "./helpers.ts";

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function up(w: World) {
  const server = createHttpServer(w.relay);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (
    path: string,
    token: string,
    init: { method?: string; json?: unknown } = {},
  ) => {
    const r = await fetch(base + path, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const text = await r.text();
    return {
      status: r.status,
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  };
}

/**
 * alice (admin) and bob are members of team `acme`, carol is an owner outside
 * it. Room `acme-general` belongs to acme; `team` and `shared` are personal rooms.
 */
function teamWorld(gate: "on" | "off" = "on") {
  const w = world({ channels: ["alice", "bob", "carol"] });
  w.relay.tokens.addOwner({ id: "carol", name: "Carol" });
  w.relay.teams.add({ id: "acme", name: "Acme", gate });
  w.relay.teams.setMember("acme", "alice", "admin");
  w.relay.teams.setMember("acme", "bob");
  w.relay.rooms.addRoom("acme-general", "General", "acme");
  return w;
}

describe("migration to 0.4.0", () => {
  it("opens a database made by the 0.3.0 schema, adds teams and rooms.team, keeps data, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    try {
      const file = join(dir, "relay.db");
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT NOT NULL, telegram_user TEXT, tz TEXT NOT NULL DEFAULT 'UTC', created_at TEXT NOT NULL);
        CREATE TABLE tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL UNIQUE, owner TEXT NOT NULL REFERENCES owners(id),
          hash TEXT NOT NULL UNIQUE, grants TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT);
        CREATE TABLE rooms (name TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL REFERENCES rooms(name), thread TEXT NOT NULL,
          sender_token INTEGER NOT NULL, sender_label TEXT NOT NULL, sender_owner TEXT NOT NULL, sent_at TEXT NOT NULL, text TEXT NOT NULL,
          status TEXT NOT NULL, gated INTEGER NOT NULL, nonce TEXT NOT NULL, card_id INTEGER, decided_at TEXT, decided_by TEXT,
          ver INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX messages_ver ON messages (ver);
        INSERT INTO owners (id, name, created_at) VALUES ('alice', 'Alice', 'x');
        INSERT INTO tokens (label, owner, hash, grants, created_at) VALUES ('alice-mac', 'alice', 'h', '[{"channel":"peer:team","read":true,"send":true}]', 'x');
        INSERT INTO rooms (name, title, created_at) VALUES ('team', 'Team', 'x');
        INSERT INTO messages (room, thread, sender_token, sender_label, sender_owner, sent_at, text, status, gated, nonce, ver)
          VALUES ('team', 't', 1, 'alice-mac', 'alice', 'x', 'hi', 'delivered', 0, 'n', 1);
      `);
      old.close();
      openDb(file).close();
      const db = openDb(file); // second open: idempotent
      const cols = (
        db.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toContain("team");
      expect(db.prepare("SELECT name, title, team FROM rooms").all()).toEqual([
        { name: "team", title: "Team", team: null },
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({
        n: 1,
      });
      for (const t of ["teams", "team_members", "team_invites"]) {
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(t),
        ).toEqual({ name: t });
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("teams store", () => {
  it("creates, renames, gates and lists members; refuses bad input", () => {
    const w = teamWorld();
    const { teams } = w.relay;
    expect(teams.get("acme")).toMatchObject({
      id: "acme",
      name: "Acme",
      gate: "on",
    });
    expect(() => teams.add({ id: "acme", name: "Again" })).toThrow(TeamError);
    expect(() => teams.add({ id: "Bad Id", name: "x" })).toThrow(TeamError);
    expect(() => teams.add({ id: "x", name: "x", gate: "maybe" })).toThrow(
      TeamError,
    );
    expect(teams.rename("acme", "Acme Inc").name).toBe("Acme Inc");
    expect(teams.setGate("acme", "off").gate).toBe("off");
    expect(() => teams.setMember("acme", "nobody")).toThrow(TeamError);
    expect(teams.members("acme").map((m) => [m.owner, m.role])).toEqual([
      ["alice", "admin"],
      ["bob", "member"],
    ]);
    expect(teams.ofOwner("bob").map((t) => [t.id, t.role])).toEqual([
      ["acme", "member"],
    ]);
    expect(teams.ofOwner("carol")).toEqual([]);
  });

  it("never removes or demotes the last admin", () => {
    const w = teamWorld();
    const { teams } = w.relay;
    expect(() => teams.removeMember("acme", "alice")).toThrow(/last admin/);
    expect(() => teams.setMember("acme", "alice", "member")).toThrow(
      /last admin/,
    );
    teams.setMember("acme", "bob", "admin");
    expect(teams.removeMember("acme", "alice")).toBe(true);
    expect(teams.removeMember("acme", "alice")).toBe(false);
  });

  it("keeps invites as placeholders and turns one into a member", () => {
    const w = teamWorld();
    const { teams } = w.relay;
    const inv = teams.invite("acme", "Carol C", "joins next week");
    expect(teams.invites("acme")).toMatchObject([
      { id: inv.id, name: "Carol C", note: "joins next week" },
    ]);
    expect(() => teams.invite("acme", "Carol C")).toThrow(TeamError);
    // An invite gives nothing: no room, no gate.
    expect(w.relay.rooms.people("acme-general")).toEqual(["alice", "bob"]);
    teams.memberFromInvite("acme", "carol", "Carol C");
    expect(teams.invites("acme")).toEqual([]);
    expect(teams.isMember("acme", "carol")).toBe(true);
    expect(() => teams.memberFromInvite("acme", "carol", "Nobody")).toThrow(
      TeamError,
    );
    teams.invite("acme", "Dave");
    expect(teams.uninvite("acme", { name: "Dave" })).toBe(true);
    expect(teams.uninvite("acme", { name: "Dave" })).toBe(false);
  });
});

describe("team grants", () => {
  it("parses team:<id>, refuses team:*", () => {
    expect(parseGrantSpec("team:acme:rw")).toEqual({
      channel: "team:acme",
      read: true,
      send: true,
    });
    expect(() => parseGrantSpec("team:*:rw")).toThrow(GrantError);
    expect(() => parseGrants([{ channel: "team:*", read: true }])).toThrow(
      GrantError,
    );
    expect(() =>
      parseGrants([
        { channel: "owner:alice", read: true },
        { channel: "team:acme", read: true },
      ]),
    ).not.toThrow();
  });

  it("is refused for a non-member, an unknown team, and next to an owner: grant", () => {
    const w = teamWorld();
    expect(() => w.agent("carol-mac", "carol", "team:acme:rw")).toThrow(
      /not a member/,
    );
    expect(() => w.agent("alice-x", "alice", "team:nope:rw")).toThrow(
      /no such team/,
    );
    expect(() =>
      w.agent("alice-c", "alice", "owner:alice:rw", "team:acme:r"),
    ).toThrow(GrantError);
    w.agent("carol-mac", "carol", "peer:team:rw");
    expect(() =>
      w.relay.tokens.setGrants("carol-mac", [parseGrantSpec("team:acme:rw")]),
    ).toThrow(/not a member/);
  });

  it("reaches every room of the team and nothing else; peer_rooms shows the team", async () => {
    const w = teamWorld();
    const bob = w.agent("bob-mac", "bob", "team:acme:rw");
    w.relay.rooms.addRoom("acme-ops", "Ops", "acme");
    const t = w.relay.rooms.for(bob.caller)!;
    expect(t.rooms).toEqual(["acme-general", "acme-ops"]);
    expect(t.list().rooms[0]).toMatchObject({
      room: "acme-general",
      team: "acme",
      members: [{ label: "bob-mac", owner: "bob" }],
    });
    expect(() => t.threads({ room: "shared" })).toThrow(/no such room/);
    expect(w.relay.rooms.roomsOfToken(bob.caller)).toEqual([
      "acme-general",
      "acme-ops",
    ]);
  });

  it("removing the member takes the team grant access away at once", async () => {
    const w = teamWorld();
    const bob = w.agent("bob-mac", "bob", "team:acme:rw");
    expect(w.relay.rooms.for(bob.caller)).toBeDefined();
    w.relay.teams.removeMember("acme", "bob");
    expect(w.relay.rooms.for(bob.caller)).toBeUndefined();
    expect(w.relay.rooms.members("acme-general")).toEqual([]);
    const con = w.agent("bob-console", "bob", "owner:bob:r");
    expect(
      w.relay.rooms.forOwner("bob", {
        tokenId: con.caller.tokenId,
        label: "bob-console",
      }).rooms,
    ).toEqual([]);
  });

  it("moving a room out of the team takes it away from team grants", () => {
    const w = teamWorld();
    const bob = w.agent("bob-mac", "bob", "team:acme:rw");
    w.relay.rooms.setRoomTeam("acme-general", null);
    expect(w.relay.rooms.for(bob.caller)).toBeUndefined();
    expect(() => w.relay.rooms.setRoomTeam("acme-general", "nope")).toThrow(
      /no such team/,
    );
  });
});

describe("team gate", () => {
  it("gate on: a team member without agents in the room still makes a post wait for the tap", async () => {
    const w = teamWorld("on");
    const alice = w.agent("alice-mac", "alice", "team:acme:rw");
    const r = await w.relay.rooms
      .for(alice.caller)!
      .post({ room: "acme-general", thread: "plan", text: "hello team" });
    expect(r.status).toBe("pending_approval");
    expect(w.ch.alice!.cards()).toHaveLength(1);
    expect(w.ch.alice!.cards()[0]!.text).toContain("Bob");
    expect(w.relay.rooms.for(alice.caller)!.list().rooms[0]!.gated).toBe(true);
  });

  it("gate off: members talk without a tap", async () => {
    const w = teamWorld("off");
    const alice = w.agent("alice-mac", "alice", "team:acme:rw");
    const bob = w.agent("bob-mac", "bob", "team:acme:rw");
    const r = await w.relay.rooms
      .for(alice.caller)!
      .post({ room: "acme-general", thread: "plan", text: "hello team" });
    expect(r.status).toBe("delivered");
    expect(w.ch.alice!.sent).toHaveLength(0);
    expect(
      w.relay.rooms
        .for(bob.caller)!
        .unread({})
        .messages.map((m) => m.text),
    ).toEqual(["hello team"]);
    expect(w.relay.rooms.for(alice.caller)!.list().rooms[0]!.gated).toBe(false);
  });

  it("gate off: a non-member in the room keeps the gate, for members and for the non-member", async () => {
    const w = teamWorld("off");
    const alice = w.agent("alice-mac", "alice", "team:acme:rw");
    const carol = w.agent("carol-mac", "carol", "peer:acme-general:rw");
    expect(
      (
        await w.relay.rooms
          .for(alice.caller)!
          .post({ room: "acme-general", thread: "p", text: "a" })
      ).status,
    ).toBe("pending_approval");
    expect(
      (
        await w.relay.rooms
          .for(carol.caller)!
          .post({ room: "acme-general", thread: "p", text: "c" })
      ).status,
    ).toBe("pending_approval");
    expect(w.relay.rooms.people("acme-general")).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });
});

describe("console and teams", () => {
  it("a member sees the team room without any agent token; teams, me and rooms carry the team", async () => {
    const w = teamWorld();
    const bob = w.agent("bob-mac", "bob", "team:acme:rw");
    await w.relay.rooms
      .for(bob.caller)!
      .post({ room: "acme-general", thread: "plan", text: "hi" });
    const ac = w.agent("alice-console", "alice", "owner:alice:rw");
    const call = await up(w);

    const me = await call("/owner/me", ac.token);
    expect(me.body.teams).toEqual([
      { id: "acme", name: "Acme", role: "admin" },
    ]);
    expect(me.body.version).toBe("0.6.0");

    const teams = await call("/owner/teams", ac.token);
    expect(teams.body).toEqual({
      teams: [
        {
          id: "acme",
          name: "Acme",
          gate: "on",
          role: "admin",
          members: [
            { id: "alice", name: "Alice", role: "admin" },
            { id: "bob", name: "Bob", role: "member" },
          ],
          rooms: ["acme-general"],
          invites: [],
        },
      ],
    });

    const rooms = await call("/owner/rooms", ac.token);
    expect(rooms.body.rooms).toHaveLength(1);
    expect(rooms.body.rooms[0]).toMatchObject({
      room: "acme-general",
      team: "acme",
      teamName: "Acme",
      owners: ["bob"],
      people: [
        { id: "alice", name: "Alice" },
        { id: "bob", name: "Bob" },
      ],
      gated: true,
    });
    // Bob's post is pending (gated), so alice does not see it yet; after the tap she does.
    expect((await call("/owner/feed", ac.token)).body.messages).toEqual([]);
    w.relay.rooms.decide(
      "bob",
      1,
      w.relay.db.prepare("SELECT nonce FROM messages WHERE id = 1").get()!
        .nonce as string,
      "approve",
      "t",
    );
    expect(
      (await call("/owner/feed", ac.token)).body.messages.map(
        (m: any) => m.text,
      ),
    ).toEqual(["hi"]);
    expect(
      (await call("/owner/rooms/acme-general/threads", ac.token)).status,
    ).toBe(200);

    const carolCon = w.agent("carol-console", "carol", "owner:carol:r");
    expect((await call("/owner/teams", carolCon.token)).body).toEqual({
      teams: [],
    });
    expect(
      (await call("/owner/rooms/acme-general/threads", carolCon.token)).status,
    ).toBe(404);
  });

  it("a personal room keeps team and teamName null", async () => {
    const w = teamWorld();
    w.agent("alice-mac", "alice", "peer:team:rw");
    const ac = w.agent("alice-console", "alice", "owner:alice:r");
    const call = await up(w);
    const room = (await call("/owner/rooms", ac.token)).body.rooms.find(
      (r: any) => r.room === "team",
    );
    expect(room).toMatchObject({
      team: null,
      teamName: null,
      people: [{ id: "alice", name: "Alice" }],
      gated: false,
    });
  });

  it("team admins change the team, members and invites; others are refused; all audited", async () => {
    const w = teamWorld();
    const ac = w.agent("alice-console", "alice", "owner:alice:rw");
    const bc = w.agent("bob-console", "bob", "owner:bob:rw");
    const cc = w.agent("carol-console", "carol", "owner:carol:rw");
    const ar = w.agent("alice-watch", "alice", "owner:alice:r");
    const call = await up(w);

    const patched = await call("/owner/teams/acme", ac.token, {
      method: "PATCH",
      json: { name: "Acme Inc", gate: "off" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      id: "acme",
      name: "Acme Inc",
      gate: "off",
    });
    expect(
      (
        await call("/owner/teams/acme", ac.token, {
          method: "PATCH",
          json: { gate: "maybe" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("/owner/teams/acme", ac.token, { method: "PATCH", json: {} }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("/owner/teams/acme", bc.token, {
          method: "PATCH",
          json: { name: "x" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/owner/teams/acme", cc.token, {
          method: "PATCH",
          json: { name: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("/owner/teams/acme", ar.token, {
          method: "PATCH",
          json: { name: "x" },
        })
      ).status,
    ).toBe(403);

    const added = await call("/owner/teams/acme/members", ac.token, {
      json: { owner: "carol" },
    });
    expect(added.status).toBe(200);
    expect(added.body.members.map((m: any) => m.id)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
    expect(
      (
        await call("/owner/teams/acme/members", ac.token, {
          json: { owner: "nobody" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/owner/teams/acme/members", bc.token, {
          json: { owner: "carol", role: "admin" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/owner/teams/acme/members/alice", ac.token, {
          method: "DELETE",
        })
      ).status,
    ).toBe(400);
    const removed = await call("/owner/teams/acme/members/carol", ac.token, {
      method: "DELETE",
    });
    expect(removed.body.members.map((m: any) => m.id)).toEqual([
      "alice",
      "bob",
    ]);
    expect(
      (
        await call("/owner/teams/acme/members/carol", ac.token, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);

    const invited = await call("/owner/teams/acme/invites", ac.token, {
      json: { name: "Dave D", note: "contractor" },
    });
    expect(invited.status).toBe(200);
    expect(invited.body.invites).toEqual([
      { id: expect.any(Number), name: "Dave D", note: "contractor" },
    ]);
    const inviteId = invited.body.invites[0].id;
    expect(
      (
        await call(`/owner/teams/acme/invites/${inviteId}`, bc.token, {
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(`/owner/teams/acme/invites/${inviteId}`, ac.token, {
          method: "DELETE",
        })
      ).body.invites,
    ).toEqual([]);
    expect(
      (
        await call(`/owner/teams/acme/invites/${inviteId}`, ac.token, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);

    const actions = w.relay.audit
      .ofOwner("alice", { limit: 50 })
      .map((a) => `${a.action}:${a.ok ? "ok" : "fail"}`);
    expect(actions).toContain("console.team.update:ok");
    expect(actions).toContain("console.team.member:ok");
    expect(actions).toContain("console.team.member:fail");
    expect(actions).toContain("console.team.invite:ok");
    expect(
      w.relay.audit
        .ofOwner("bob", { limit: 50 })
        .map((a) => `${a.action}:${a.ok ? "ok" : "fail"}`),
    ).toContain("console.team.update:fail");
  });
});

describe("admin CLI", () => {
  it("creates a team, members, invites, a team room and a team token; every change audited", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-cli-"));
    const prev = process.env.RELAY_DB;
    process.env.RELAY_DB = join(dir, "relay.db");
    const out: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const err = vi
      .spyOn(console, "error")
      .mockImplementation(
        (...a: unknown[]) => void out.push(`ERR ${a.join(" ")}`),
      );
    try {
      const run = (...args: string[]) => {
        process.exitCode = undefined;
        runAdmin(args);
        expect(process.exitCode, out.join("\n")).toBeUndefined();
      };
      run("owner", "add", "alice", "--name", "Alice");
      run("owner", "add", "bob", "--name", "Bob");
      run("team", "add", "acme", "--name", "Acme");
      run("team", "rename", "acme", "--name", "Acme Inc");
      run("team", "member", "acme", "alice", "--role", "admin");
      run("team", "invite", "acme", "--name", "Bob B", "--note", "soon");
      run("team", "member", "acme", "bob", "--from-invite", "Bob B");
      run("team", "invite", "acme", "--name", "Carol C");
      run("team", "uninvite", "acme", "--name", "Carol C");
      run("team", "gate", "acme", "off");
      run(
        "room",
        "add",
        "acme-general",
        "--title",
        "General",
        "--team",
        "acme",
      );
      run("room", "add", "side");
      run("room", "team", "side", "acme");
      run("room", "team", "side", "none");
      run(
        "token",
        "create",
        "bob-mac",
        "--owner",
        "bob",
        "--grant",
        "team:acme:rw",
      );
      out.length = 0;
      run("team", "list");
      expect(out.join("\n")).toContain(
        "acme\tAcme Inc\tgate=off\tmembers: alice(admin), bob(member)\tinvited: -\trooms: acme-general",
      );
      run("team", "member", "acme", "bob", "--remove");

      const db = openDb(process.env.RELAY_DB);
      const actions = (
        db
          .prepare("SELECT action FROM audit WHERE actor = 'cli' ORDER BY id")
          .all() as Array<{ action: string }>
      ).map((a) => a.action);
      db.close();
      for (const a of [
        "team.add",
        "team.rename",
        "team.member",
        "team.invite",
        "team.uninvite",
        "team.gate",
        "room.team",
        "token.create",
      ]) {
        expect(actions).toContain(a);
      }
    } finally {
      log.mockRestore();
      err.mockRestore();
      process.exitCode = undefined;
      if (prev === undefined) delete process.env.RELAY_DB;
      else process.env.RELAY_DB = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
