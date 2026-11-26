import type { DatabaseSync } from 'node:sqlite';

export interface AuditEntry {
  /** `token:<id>:<label>`, `owner-bot:<owner>`, `console:<label>`, `cli`, `relay`. */
  actor: string;
  owner?: string | null;
  action: string;
  target?: string | null;
  ok: boolean;
  detail?: string | null;
}

export interface AuditRow extends AuditEntry {
  id: number;
  at: string;
}

/** The relay's own audit log: every tool call, REST call, decision and admin change. */
export class AuditLog {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  write(e: AuditEntry): void {
    this.db
      .prepare('INSERT INTO audit (at, actor, owner, action, target, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        new Date(this.now()).toISOString(),
        e.actor,
        e.owner ?? null,
        e.action,
        e.target ?? null,
        e.ok ? 1 : 0,
        e.detail ? e.detail.slice(0, 500) : null,
      );
  }

  recent(limit = 50): AuditRow[] {
    const rows = this.db
      .prepare('SELECT id, at, actor, owner, action, target, ok, detail FROM audit ORDER BY id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 1000)) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  /** One owner's rows, newest first, paged by id (`before`). */
  ofOwner(owner: string, opts: { before?: number; limit?: number } = {}): AuditRow[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
    const rows = this.db
      .prepare('SELECT id, at, actor, owner, action, target, ok, detail FROM audit WHERE owner = ? AND id < ? ORDER BY id DESC LIMIT ?')
      .all(owner, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as Array<Record<string, unknown>>;
    return rows.map(toRow);
  }

  /** The highest audit id of an owner, 0 when none. */
  maxId(owner: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit WHERE owner = ?').get(owner) as { n: number }).n;
  }
}

function toRow(r: Record<string, unknown>): AuditRow {
  return {
    id: Number(r.id),
    at: String(r.at),
    actor: String(r.actor),
    owner: (r.owner as string | null) ?? null,
    action: String(r.action),
    target: (r.target as string | null) ?? null,
    ok: r.ok === 1,
    detail: (r.detail as string | null) ?? null,
  };
}
