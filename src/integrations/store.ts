import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { TeamStore } from "../teams.ts";
import {
  ScopedError,
  accessOf,
  camel,
  randomId,
  zodMessage,
} from "../projects.ts";
import { SecretKeyError, type SecretBox } from "./secrets.ts";
import {
  LinearClient,
  LinearError,
  type FetchFn,
  type LinearIssue,
} from "./linear.ts";

/**
 * Integrations (0.6.0): one external account per row, personal or of a team,
 * with the same access rule as projects. The secret is sealed with
 * `SecretBox`; views carry only its last four characters, and nothing here
 * puts the secret into an error, a view or an audit detail.
 */

export const INTEGRATION_KINDS = ["linear"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export type IntegrationStatus = "unchecked" | "ok" | "error";

export interface IntegrationRow {
  id: string;
  ownerId: string;
  teamId: string | null;
  kind: IntegrationKind;
  name: string;
  secretEnc: string;
  secretLast4: string;
  status: IntegrationStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export type IntegrationView = Omit<IntegrationRow, "secretEnc"> & {
  canWrite: boolean;
};

/** A Linear issue created for a task (stored as a `linear_issue` task event). */
export interface TaskIssueLink extends LinearIssue {
  integrationId: string;
  createdAt: string;
}

const secret = z
  .string()
  .trim()
  .min(8, "secret is at least 8 characters")
  .max(500)
  .refine((v) => !/\s/.test(v), { message: "secret has no spaces" });

const createSchema = z.strictObject({
  kind: z.enum(INTEGRATION_KINDS),
  name: z.string().trim().min(1, "name is required").max(80),
  secret,
  teamId: z.union([z.string(), z.null()]).optional(),
});

const updateSchema = z.strictObject({
  name: z.string().trim().min(1, "name is required").max(80).optional(),
  secret: secret.optional(),
});

const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toRow(r: Record<string, unknown>): IntegrationRow {
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    teamId: s(r.team_id),
    kind: String(r.kind) as IntegrationKind,
    name: String(r.name),
    secretEnc: String(r.secret_enc),
    secretLast4: String(r.secret_last4),
    status: String(r.status) as IntegrationStatus,
    lastCheckedAt: s(r.last_checked_at),
    lastError: s(r.last_error),
    createdAt: String(r.created_at),
  };
}

const NO_KEY =
  "RELAY_SECRET_KEY is not set on the relay, so it cannot store or use integration secrets";

export class IntegrationStore {
  private readonly db: DatabaseSync;
  private readonly teams: TeamStore;
  private readonly box: SecretBox | undefined;
  private readonly fetchFn: FetchFn | undefined;
  private readonly now: () => number;

  constructor(o: {
    db: DatabaseSync;
    teams: TeamStore;
    box?: SecretBox;
    fetchFn?: FetchFn;
    now?: () => number;
  }) {
    this.db = o.db;
    this.teams = o.teams;
    this.box = o.box;
    this.fetchFn = o.fetchFn;
    this.now = o.now ?? Date.now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private sealer(): SecretBox {
    if (!this.box) throw new ScopedError(503, NO_KEY);
    return this.box;
  }

  row(id: string): IntegrationRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM integrations WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return r ? toRow(r) : undefined;
  }

  view(i: IntegrationRow, owner: string): IntegrationView {
    const { secretEnc: _drop, ...rest } = i;
    return { ...rest, canWrite: accessOf(this.teams, i, owner) === "write" };
  }

  must(owner: string, id: unknown, need: "read" | "write"): IntegrationRow {
    const i = typeof id === "string" ? this.row(id) : undefined;
    const a = i ? accessOf(this.teams, i, owner) : undefined;
    if (!i || !a) throw new ScopedError(404, "no such integration");
    if (need === "write" && a !== "write")
      throw new ScopedError(
        403,
        "only a team admin or the integration's creator can change this integration",
      );
    return i;
  }

  list(owner: string, f: { team?: string } = {}): IntegrationView[] {
    const teamIds = this.teams.ofOwner(owner).map((t) => t.id);
    const rows = (
      this.db
        .prepare("SELECT * FROM integrations ORDER BY name, id")
        .all() as Array<Record<string, unknown>>
    )
      .map(toRow)
      .filter((i) =>
        i.teamId === null ? i.ownerId === owner : teamIds.includes(i.teamId),
      )
      .filter((i) =>
        f.team === undefined
          ? true
          : f.team === "personal"
            ? i.teamId === null
            : i.teamId === f.team,
      );
    return rows.map((i) => this.view(i, owner));
  }

  create(owner: string, raw: Record<string, unknown>): IntegrationView {
    const parsed = createSchema.safeParse(camel(raw));
    if (!parsed.success) throw new ScopedError(400, zodMessage(parsed.error));
    const b = parsed.data;
    let teamId: string | null = null;
    if (typeof b.teamId === "string" && b.teamId.trim()) {
      teamId = b.teamId.trim().toLowerCase();
      if (!this.teams.get(teamId) || !this.teams.isMember(teamId, owner))
        throw new ScopedError(404, "no such team");
    }
    const sealed = this.sealer().encrypt(b.secret);
    const id = randomId("in_", 12);
    this.db
      .prepare(
        `INSERT INTO integrations (id, owner_id, team_id, kind, name, secret_enc, secret_last4, status, last_checked_at, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unchecked', NULL, NULL, ?)`,
      )
      .run(
        id,
        owner,
        teamId,
        b.kind,
        b.name,
        sealed,
        b.secret.slice(-4),
        this.iso(),
      );
    return this.view(this.row(id)!, owner);
  }

  /** Renames and/or rotates the secret; a new secret resets the status to `unchecked`. */
  update(
    owner: string,
    id: string,
    raw: Record<string, unknown>,
  ): { view: IntegrationView; changed: string[] } {
    const i = this.must(owner, id, "write");
    const parsed = updateSchema.safeParse(camel(raw));
    if (!parsed.success) throw new ScopedError(400, zodMessage(parsed.error));
    const b = parsed.data;
    const changed = Object.keys(b);
    if (!changed.length)
      throw new ScopedError(400, "say what changes: name, secret or both");
    if (b.secret !== undefined) {
      const sealed = this.sealer().encrypt(b.secret);
      this.db
        .prepare(
          "UPDATE integrations SET secret_enc = ?, secret_last4 = ?, status = 'unchecked', last_checked_at = NULL, last_error = NULL WHERE id = ?",
        )
        .run(sealed, b.secret.slice(-4), i.id);
    }
    if (b.name !== undefined)
      this.db
        .prepare("UPDATE integrations SET name = ? WHERE id = ?")
        .run(b.name, i.id);
    return { view: this.view(this.row(i.id)!, owner), changed };
  }

  /** Deletes the integration and every project link to it. */
  remove(owner: string, id: string): void {
    const i = this.must(owner, id, "write");
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM project_links WHERE integration_id = ?")
        .run(i.id);
      this.db.prepare("DELETE FROM integrations WHERE id = ?").run(i.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** A Linear client with the integration's key; 503 when the key cannot be opened. */
  linear(i: IntegrationRow): LinearClient {
    if (i.kind !== "linear")
      throw new ScopedError(400, "not a Linear integration");
    let key: string;
    try {
      key = this.sealer().decrypt(i.secretEnc);
    } catch (err) {
      if (err instanceof SecretKeyError)
        throw new ScopedError(503, err.message);
      throw err;
    }
    return new LinearClient(key, this.fetchFn ?? fetch);
  }

  private setStatus(
    id: string,
    status: IntegrationStatus,
    error: string | null,
  ): void {
    this.db
      .prepare(
        "UPDATE integrations SET status = ?, last_checked_at = ?, last_error = ? WHERE id = ?",
      )
      .run(status, this.iso(), error ? error.slice(0, 500) : null, id);
  }

  /** Runs Linear's viewer query and records the outcome; never throws for a Linear failure. */
  async test(
    owner: string,
    id: string,
  ): Promise<{
    view: IntegrationView;
    viewer: { name: string; email: string | null } | null;
  }> {
    const i = this.must(owner, id, "write");
    const client = this.linear(i);
    try {
      const v = await client.viewer();
      this.setStatus(i.id, "ok", null);
      return {
        view: this.view(this.row(i.id)!, owner),
        viewer: { name: v.name, email: v.email },
      };
    } catch (err) {
      if (!(err instanceof LinearError)) throw err;
      this.setStatus(i.id, "error", err.message);
      return { view: this.view(this.row(i.id)!, owner), viewer: null };
    }
  }

  /** Runs a Linear call; a Linear failure is 502 (and marks a rejected key as `error`). */
  async call<T>(
    i: IntegrationRow,
    fn: (c: LinearClient) => Promise<T>,
  ): Promise<T> {
    const client = this.linear(i);
    try {
      return await fn(client);
    } catch (err) {
      if (!(err instanceof LinearError)) throw err;
      if (err.httpStatus === 401 || err.httpStatus === 403)
        this.setStatus(i.id, "error", err.message);
      throw new ScopedError(err.httpStatus === 404 ? 404 : 502, err.message);
    }
  }

  /** Records a created issue on the task's append-only log. */
  addTaskIssue(t: { id: string; machine: string }, actor: string, integrationId: string, issue: LinearIssue): TaskIssueLink {
    const at = this.iso();
    const data = { integrationId, id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title };
    this.db
      .prepare("INSERT INTO task_events (task, at, actor, machine, type, data) VALUES (?, ?, ?, ?, 'linear_issue', ?)")
      .run(t.id, at, actor, t.machine, JSON.stringify(data));
    return { ...issue, integrationId, createdAt: at };
  }

  /** Linear issues already created for a task, oldest first. */
  taskIssues(task: string): TaskIssueLink[] {
    return (
      this.db
        .prepare(
          "SELECT at, data FROM task_events WHERE task = ? AND type = 'linear_issue' ORDER BY id",
        )
        .all(task) as Array<{
        at: string;
        data: string | null;
      }>
    ).flatMap((r) => {
      try {
        const d = JSON.parse(r.data ?? "null") as Partial<TaskIssueLink> | null;
        if (!d || typeof d.identifier !== "string" || typeof d.url !== "string")
          return [];
        return [
          {
            id: String(d.id ?? ""),
            identifier: d.identifier,
            url: d.url,
            title: String(d.title ?? ""),
            integrationId: String(d.integrationId ?? ""),
            createdAt: r.at,
          },
        ];
      } catch {
        return [];
      }
    });
  }
}
