import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { TeamStore } from "./teams.ts";

/**
 * Projects (0.6.0): a name that groups rooms and tasks, personal or of a team.
 *
 * Access is computed from team membership on every call, like team rooms:
 * a personal project is its owner's only; a team project is readable by every
 * member of the team and writable by the team's admins and its creator (while
 * they stay a member). Anything the caller cannot read answers as 404.
 */

export class ScopedError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 502 | 503;
  constructor(status: 400 | 403 | 404 | 409 | 502 | 503, message: string) {
    super(message);
    this.name = "ScopedError";
    this.status = status;
  }
}

export type Access = "write" | "read" | undefined;

/** The shared rule for owner-or-team scoped rows (projects, integrations). */
export function accessOf(
  teams: TeamStore,
  row: { ownerId: string; teamId: string | null },
  owner: string,
): Access {
  if (row.teamId === null) return row.ownerId === owner ? "write" : undefined;
  const role = teams.role(row.teamId, owner);
  if (!role) return undefined;
  return role === "admin" || row.ownerId === owner ? "write" : "read";
}

export interface ProjectRow {
  id: string;
  ownerId: string;
  teamId: string | null;
  name: string;
  slug: string;
  description: string;
  repoUrl: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface ProjectLink {
  integrationId: string;
  externalType: "linear_team" | "linear_project";
  externalId: string;
  externalName: string;
  createdAt: string;
}

export interface ProjectView extends ProjectRow {
  canWrite: boolean;
  links: ProjectLink[];
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Turns a name into a slug: lowercase ascii, digits and dashes. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s || "project";
}

const nullableText = (max: number) =>
  z
    .union([z.string().max(max), z.null()])
    .transform((v) => (v === null || !v.trim() ? null : v.trim()));

const repoUrl = z
  .union([z.string().max(500), z.null()])
  .transform((v) => (v === null || !v.trim() ? null : v.trim()))
  .refine(
    (v) => v === null || /^(https?|ssh|git):\/\/\S+$|^git@\S+:\S+$/.test(v),
    {
      message: "repoUrl is an http(s), ssh or git URL",
    },
  );

const createSchema = z.strictObject({
  name: z.string().trim().min(1, "name is required").max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG, "slug: lowercase letters, digits and dashes, up to 64")
    .optional(),
  description: z.string().max(2000).optional(),
  repoUrl: repoUrl.optional(),
  teamId: z.union([z.string(), z.null()]).optional(),
});

const updateSchema = z.strictObject({
  name: z.string().trim().min(1, "name is required").max(80).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG, "slug: lowercase letters, digits and dashes, up to 64")
    .optional(),
  description: nullableText(2000).optional(),
  repoUrl: repoUrl.optional(),
});

/** First zod issue as one line: `path: message`. */
export function zodMessage(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return "invalid input";
  return i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message;
}

/** Accepts camelCase and the snake_case spelling of a key (`teamId` / `team_id`). */
export function camel(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    out[k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    teamId: s(r.team_id),
    name: String(r.name),
    slug: String(r.slug),
    description: String(r.description ?? ""),
    repoUrl: s(r.repo_url),
    createdAt: String(r.created_at),
    archivedAt: s(r.archived_at),
  };
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export function randomId(prefix: string, n: number): string {
  const bytes = randomBytes(n);
  let out = prefix;
  for (let i = 0; i < n; i++) out += BASE32[bytes[i]! & 31];
  return out;
}

export class ProjectStore {
  private readonly db: DatabaseSync;
  private readonly teams: TeamStore;
  private readonly now: () => number;

  constructor(
    db: DatabaseSync,
    teams: TeamStore,
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.teams = teams;
    this.now = now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  row(id: string): ProjectRow | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? toProject(r) : undefined;
  }

  links(id: string): ProjectLink[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM project_links WHERE project_id = ? ORDER BY created_at, integration_id, external_type",
        )
        .all(id) as Array<Record<string, unknown>>
    ).map((r) => ({
      integrationId: String(r.integration_id),
      externalType: String(r.external_type) as ProjectLink["externalType"],
      externalId: String(r.external_id),
      externalName: String(r.external_name ?? ""),
      createdAt: String(r.created_at),
    }));
  }

  view(p: ProjectRow, owner: string): ProjectView {
    return {
      ...p,
      canWrite: accessOf(this.teams, p, owner) === "write",
      links: this.links(p.id),
    };
  }

  /** A project the owner may read (`need: read`) or change (`need: write`); 404 when not readable, 403 when read-only. */
  must(owner: string, id: unknown, need: "read" | "write"): ProjectRow {
    const p = typeof id === "string" ? this.row(id) : undefined;
    const a = p ? accessOf(this.teams, p, owner) : undefined;
    if (!p || !a) throw new ScopedError(404, "no such project");
    if (need === "write" && a !== "write")
      throw new ScopedError(
        403,
        "only a team admin or the project's creator can change this project",
      );
    return p;
  }

  /** Projects the owner can read: own personal ones and those of their teams. */
  list(
    owner: string,
    f: { team?: string; archived?: boolean } = {},
  ): ProjectView[] {
    const teamIds = this.teams.ofOwner(owner).map((t) => t.id);
    let rows: ProjectRow[];
    if (f.team === "personal") {
      rows = this.all(
        "SELECT * FROM projects WHERE team_id IS NULL AND owner_id = ?",
        [owner],
      );
    } else if (f.team) {
      rows = teamIds.includes(f.team)
        ? this.all("SELECT * FROM projects WHERE team_id = ?", [f.team])
        : [];
    } else {
      const marks = teamIds.map(() => "?").join(", ");
      rows = this.all(
        `SELECT * FROM projects WHERE (team_id IS NULL AND owner_id = ?)${teamIds.length ? ` OR team_id IN (${marks})` : ""}`,
        [owner, ...teamIds],
      );
    }
    return rows
      .filter((p) => f.archived || p.archivedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id))
      .map((p) => this.view(p, owner));
  }

  private all(sql: string, args: string[]): ProjectRow[] {
    return (
      this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>
    ).map(toProject);
  }

  private slugTaken(owner: string, slug: string, except?: string): boolean {
    const r = this.db
      .prepare("SELECT id FROM projects WHERE owner_id = ? AND slug = ?")
      .get(owner, slug) as { id: string } | undefined;
    return Boolean(r && r.id !== except);
  }

  create(owner: string, raw: Record<string, unknown>): ProjectView {
    const parsed = createSchema.safeParse(camel(raw));
    if (!parsed.success) throw new ScopedError(400, zodMessage(parsed.error));
    const b = parsed.data;
    let teamId: string | null = null;
    if (typeof b.teamId === "string" && b.teamId.trim()) {
      teamId = b.teamId.trim().toLowerCase();
      // Any member may start a team project; one outside the team gets 404 like a missing team.
      if (!this.teams.get(teamId) || !this.teams.isMember(teamId, owner))
        throw new ScopedError(404, "no such team");
    }
    let slug = b.slug ?? slugify(b.name);
    if (b.slug !== undefined) {
      if (this.slugTaken(owner, slug))
        throw new ScopedError(409, `slug ${slug} is taken`);
    } else {
      const base = slug.slice(0, 60);
      for (let i = 2; this.slugTaken(owner, slug); i++) slug = `${base}-${i}`;
    }
    const id = randomId("pj_", 12);
    this.db
      .prepare(
        "INSERT INTO projects (id, owner_id, team_id, name, slug, description, repo_url, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        id,
        owner,
        teamId,
        b.name,
        slug,
        (b.description ?? "").trim(),
        b.repoUrl ?? null,
        this.iso(),
      );
    return this.view(this.row(id)!, owner);
  }

  update(
    owner: string,
    id: string,
    raw: Record<string, unknown>,
  ): { view: ProjectView; changed: string[] } {
    const p = this.must(owner, id, "write");
    const parsed = updateSchema.safeParse(camel(raw));
    if (!parsed.success) throw new ScopedError(400, zodMessage(parsed.error));
    const b = parsed.data;
    const changed = Object.keys(b);
    if (!changed.length)
      throw new ScopedError(
        400,
        "say what changes: name, slug, description or repoUrl",
      );
    // The slug is unique per creator, not per editor.
    if (b.slug !== undefined && this.slugTaken(p.ownerId, b.slug, p.id))
      throw new ScopedError(409, `slug ${b.slug} is taken`);
    this.db
      .prepare(
        "UPDATE projects SET name = ?, slug = ?, description = ?, repo_url = ? WHERE id = ?",
      )
      .run(
        b.name ?? p.name,
        b.slug ?? p.slug,
        b.description !== undefined ? (b.description ?? "") : p.description,
        b.repoUrl !== undefined ? b.repoUrl : p.repoUrl,
        p.id,
      );
    return { view: this.view(this.row(p.id)!, owner), changed };
  }

  setArchived(owner: string, id: string, archived: boolean): ProjectView {
    const p = this.must(owner, id, "write");
    this.db
      .prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
      .run(archived ? (p.archivedAt ?? this.iso()) : null, p.id);
    return this.view(this.row(p.id)!, owner);
  }

  /** A project that may take a new room or task: readable (`need`) and not archived. */
  attachable(owner: string, id: unknown, need: "read" | "write"): ProjectRow {
    const p = this.must(owner, id, need);
    if (p.archivedAt) throw new ScopedError(400, "the project is archived");
    return p;
  }

  setRoomProject(room: string, projectId: string | null): void {
    this.db
      .prepare("UPDATE rooms SET project_id = ? WHERE name = ?")
      .run(projectId, room);
  }

  setTaskProject(task: string, projectId: string | null): void {
    this.db
      .prepare("UPDATE tasks SET project_id = ? WHERE id = ?")
      .run(projectId, task);
  }

  roomProject(room: string): string | null {
    const r = this.db
      .prepare("SELECT project_id FROM rooms WHERE name = ?")
      .get(room) as { project_id: string | null } | undefined;
    return r?.project_id ?? null;
  }

  /** Room names of a project (the caller filters to rooms it can see). */
  roomsOf(id: string): string[] {
    return (
      this.db
        .prepare("SELECT name FROM rooms WHERE project_id = ? ORDER BY name")
        .all(id) as Array<{ name: string }>
    ).map((r) => r.name);
  }

  /** Task ids of a project owned by `owner`, newest first: tasks stay private to their owner. */
  tasksOf(id: string, owner: string, limit = 200): string[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM tasks WHERE project_id = ? AND owner = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .all(id, owner, limit) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  link(id: string, l: Omit<ProjectLink, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO project_links (project_id, integration_id, external_type, external_id, external_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, integration_id, external_type)
         DO UPDATE SET external_id = excluded.external_id, external_name = excluded.external_name, created_at = excluded.created_at`,
      )
      .run(
        id,
        l.integrationId,
        l.externalType,
        l.externalId,
        l.externalName,
        this.iso(),
      );
  }

  unlink(id: string, integrationId: string, externalType: string): boolean {
    const res = this.db
      .prepare(
        "DELETE FROM project_links WHERE project_id = ? AND integration_id = ? AND external_type = ?",
      )
      .run(id, integrationId, externalType);
    return Number(res.changes) > 0;
  }
}
