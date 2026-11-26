import type { DatabaseSync } from "node:sqlite";
import { NAME } from "./grants.ts";

export type TeamGate = "on" | "off";
export type TeamRole = "admin" | "member";

/** A group of owners sharing rooms (README, docs/console-api.md). */
export interface Team {
  id: string;
  name: string;
  /** `off`: a post by a member into a team room whose other owners are all members is not gated. */
  gate: TeamGate;
  createdAt: string;
}

export interface TeamMember {
  owner: string;
  role: TeamRole;
  addedAt: string;
}

/** A person invited to a team who has no owner or token yet: no access, never part of a gate. */
export interface TeamInvite {
  id: number;
  name: string;
  note: string | null;
  createdAt: string;
}

export class TeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamError";
  }
}

function gateOf(raw: unknown): TeamGate {
  if (raw !== "on" && raw !== "off") throw new TeamError("gate is on or off");
  return raw;
}

function roleOf(raw: unknown): TeamRole {
  if (raw !== "admin" && raw !== "member")
    throw new TeamError("role is admin or member");
  return raw;
}

function toTeam(r: Record<string, unknown>): Team {
  return {
    id: String(r.id),
    name: String(r.name),
    gate: String(r.gate) as TeamGate,
    createdAt: String(r.created_at),
  };
}

/**
 * Teams and their members. Membership is what a `team:<id>` grant and the
 * console's team rooms hang on, so every check reads it live: removing a
 * member takes their team access away at once.
 */
export class TeamStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Creates a team; an existing id is an error (rename with `rename`). */
  add(t: { id: string; name: string; gate?: unknown }): Team {
    const id = t.id.trim().toLowerCase();
    if (!NAME.test(id))
      throw new TeamError(
        "team id: lowercase letters, digits and dashes, up to 32",
      );
    const name = t.name.trim();
    if (!name) throw new TeamError("team name is required");
    if (name.length > 80)
      throw new TeamError("team name is at most 80 characters");
    const gate = t.gate === undefined ? "on" : gateOf(t.gate);
    if (this.get(id)) throw new TeamError(`team ${id} already exists`);
    this.db
      .prepare(
        "INSERT INTO teams (id, name, gate, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, name, gate, this.iso());
    return this.get(id)!;
  }

  get(id: string): Team | undefined {
    const r = this.db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? toTeam(r) : undefined;
  }

  list(): Team[] {
    return (
      this.db.prepare("SELECT * FROM teams ORDER BY id").all() as Array<
        Record<string, unknown>
      >
    ).map(toTeam);
  }

  private must(id: string): Team {
    const t = this.get(id.trim().toLowerCase());
    if (!t) throw new TeamError(`no such team: ${id}`);
    return t;
  }

  rename(id: string, name: string): Team {
    const t = this.must(id);
    const n = name.trim();
    if (!n) throw new TeamError("team name is required");
    if (n.length > 80)
      throw new TeamError("team name is at most 80 characters");
    this.db.prepare("UPDATE teams SET name = ? WHERE id = ?").run(n, t.id);
    return this.get(t.id)!;
  }

  setGate(id: string, gate: unknown): Team {
    const t = this.must(id);
    this.db
      .prepare("UPDATE teams SET gate = ? WHERE id = ?")
      .run(gateOf(gate), t.id);
    return this.get(t.id)!;
  }

  /** Adds an owner or changes their role. Demoting the last admin is refused. */
  setMember(id: string, owner: string, role: unknown = "member"): TeamMember {
    const t = this.must(id);
    const o = owner.trim().toLowerCase();
    const r = roleOf(role);
    if (!this.db.prepare("SELECT 1 FROM owners WHERE id = ?").get(o))
      throw new TeamError(`no such owner: ${owner}`);
    const prev = this.role(t.id, o);
    if (prev === "admin" && r !== "admin" && this.admins(t.id).length === 1) {
      throw new TeamError(
        `${o} is the last admin of ${t.id}; make another member admin first`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO team_members (team, owner, role, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(team, owner) DO UPDATE SET role = excluded.role`,
      )
      .run(t.id, o, r, this.iso());
    return this.members(t.id).find((m) => m.owner === o)!;
  }

  /** Removes a member; false when they were not one. The last admin cannot be removed. */
  removeMember(id: string, owner: string): boolean {
    const t = this.must(id);
    const o = owner.trim().toLowerCase();
    const prev = this.role(t.id, o);
    if (!prev) return false;
    if (prev === "admin" && this.admins(t.id).length === 1) {
      throw new TeamError(
        `${o} is the last admin of ${t.id}; make another member admin first`,
      );
    }
    this.db
      .prepare("DELETE FROM team_members WHERE team = ? AND owner = ?")
      .run(t.id, o);
    return true;
  }

  members(id: string): TeamMember[] {
    return (
      this.db
        .prepare(
          "SELECT owner, role, added_at FROM team_members WHERE team = ? ORDER BY owner",
        )
        .all(id) as Array<Record<string, unknown>>
    ).map((r) => ({
      owner: String(r.owner),
      role: String(r.role) as TeamRole,
      addedAt: String(r.added_at),
    }));
  }

  private admins(id: string): TeamMember[] {
    return this.members(id).filter((m) => m.role === "admin");
  }

  /** The owner's role in a team, undefined when not a member. */
  role(id: string, owner: string): TeamRole | undefined {
    const r = this.db
      .prepare("SELECT role FROM team_members WHERE team = ? AND owner = ?")
      .get(id, owner) as { role: string } | undefined;
    return r ? (r.role as TeamRole) : undefined;
  }

  isMember(id: string, owner: string): boolean {
    return this.role(id, owner) !== undefined;
  }

  /** Teams the owner is a member of, with their role. */
  ofOwner(owner: string): Array<Team & { role: TeamRole }> {
    return (
      this.db
        .prepare(
          "SELECT t.*, m.role AS role FROM teams t JOIN team_members m ON m.team = t.id WHERE m.owner = ? ORDER BY t.id",
        )
        .all(owner) as Array<Record<string, unknown>>
    ).map((r) => ({ ...toTeam(r), role: String(r.role) as TeamRole }));
  }

  // Invites: placeholders for people without an owner yet. They give nothing.

  invites(id: string): TeamInvite[] {
    return (
      this.db.prepare("SELECT * FROM team_invites WHERE team = ? ORDER BY id").all(id) as Array<Record<string, unknown>>
    ).map((r) => ({ id: Number(r.id), name: String(r.name), note: (r.note as string | null) ?? null, createdAt: String(r.created_at) }));
  }

  invite(id: string, name: string, note?: string | null): TeamInvite {
    const t = this.must(id);
    const n = String(name ?? "").trim();
    if (!n) throw new TeamError("invite name is required");
    if (n.length > 80) throw new TeamError("invite name is at most 80 characters");
    const nt = note == null ? null : String(note).trim().slice(0, 200) || null;
    if (this.invites(t.id).some((x) => x.name === n)) throw new TeamError(`${n} is already invited to ${t.id}`);
    const res = this.db
      .prepare("INSERT INTO team_invites (team, name, note, created_at) VALUES (?, ?, ?, ?)")
      .run(t.id, n, nt, this.iso());
    return this.invites(t.id).find((x) => x.id === Number(res.lastInsertRowid))!;
  }

  /** Removes an invite by id or by display name; false when there was none. */
  uninvite(id: string, which: { id?: number; name?: string }): boolean {
    const t = this.must(id);
    const res =
      which.id !== undefined
        ? this.db.prepare("DELETE FROM team_invites WHERE team = ? AND id = ?").run(t.id, which.id)
        : this.db.prepare("DELETE FROM team_invites WHERE team = ? AND name = ?").run(t.id, String(which.name ?? "").trim());
    return Number(res.changes) === 1;
  }

  /** Turns an invite into a real member: adds the owner and deletes the invite, in one transaction. */
  memberFromInvite(id: string, owner: string, inviteName: string, role: unknown = "member"): TeamMember {
    const t = this.must(id);
    const n = inviteName.trim();
    if (!this.invites(t.id).some((x) => x.name === n)) throw new TeamError(`no invite ${JSON.stringify(n)} in ${t.id}`);
    this.db.exec("BEGIN");
    try {
      const m = this.setMember(t.id, owner, role);
      this.uninvite(t.id, { name: n });
      this.db.exec("COMMIT");
      return m;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
