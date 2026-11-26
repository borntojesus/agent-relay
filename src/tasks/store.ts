import type { DatabaseSync } from "node:sqlite";

/**
 * SQL for machines, tasks, the task log and tool approvals (schema in
 * src/db.ts). No rules here: `TaskService` decides who may do what and which
 * status follows which. `task_events` is append-only (triggers), so this
 * store only ever inserts into it.
 */

export const TASK_STATUSES = [
  "queued",
  "awaiting_tap",
  "accepted",
  "running",
  "waiting_approval",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL: readonly TaskStatus[] = ["done", "failed", "cancelled"];
export const ACTIVE: readonly TaskStatus[] = [
  "accepted",
  "running",
  "waiting_approval",
];

export type Priority = "low" | "normal" | "high";
export const PRIORITIES: readonly Priority[] = ["low", "normal", "high"];

export type ToolApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

export interface MachineRow {
  id: string;
  owner: string;
  name: string;
  policy: string;
  killed: boolean;
  lastSeen: string | null;
  workerVersion: string | null;
  createdAt: string;
}

export interface TaskRow {
  id: string;
  owner: string;
  machine: string;
  createdBy: string;
  sourceMachine: string | null;
  folder: string;
  prompt: string;
  priority: Priority;
  status: TaskStatus;
  sessionId: string | null;
  result: string | null;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequested: boolean;
  policySnapshot: string;
  parent: string | null;
  /** The project the task belongs to (0.6.0); set through the console, never by a worker. */
  projectId?: string | null;
}

export interface TaskEvent {
  id: number;
  task: string;
  at: string;
  actor: string;
  machine: string | null;
  type: string;
  data: unknown;
}

export interface ToolApprovalRow {
  id: string;
  task: string;
  machine: string;
  owner: string;
  tool: string;
  summary: string;
  category: string;
  status: ToolApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  expiresAt: string;
}

type Raw = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toMachine(r: Raw): MachineRow {
  return {
    id: String(r.id),
    owner: String(r.owner),
    name: String(r.name),
    policy: String(r.policy),
    killed: Number(r.killed) === 1,
    lastSeen: s(r.last_seen),
    workerVersion: s(r.worker_version),
    createdAt: String(r.created_at),
  };
}

function toTask(r: Raw): TaskRow {
  return {
    id: String(r.id),
    owner: String(r.owner),
    machine: String(r.machine),
    createdBy: String(r.created_by),
    sourceMachine: s(r.source_machine),
    folder: String(r.folder),
    prompt: String(r.prompt),
    priority: String(r.priority) as Priority,
    status: String(r.status) as TaskStatus,
    sessionId: s(r.session_id),
    result: s(r.result),
    exitCode:
      r.exit_code === null || r.exit_code === undefined
        ? null
        : Number(r.exit_code),
    error: s(r.error),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    startedAt: s(r.started_at),
    finishedAt: s(r.finished_at),
    cancelRequested: Number(r.cancel_requested) === 1,
    policySnapshot: String(r.policy_snapshot),
    parent: s(r.parent),
    projectId: s(r.project_id),
  };
}

function toEvent(r: Raw): TaskEvent {
  let data: unknown = null;
  if (r.data !== null && r.data !== undefined) {
    try {
      data = JSON.parse(String(r.data));
    } catch {
      data = String(r.data);
    }
  }
  return {
    id: Number(r.id),
    task: String(r.task),
    at: String(r.at),
    actor: String(r.actor),
    machine: s(r.machine),
    type: String(r.type),
    data,
  };
}

function toApproval(r: Raw): ToolApprovalRow {
  return {
    id: String(r.id),
    task: String(r.task),
    machine: String(r.machine),
    owner: String(r.owner),
    tool: String(r.tool),
    summary: String(r.summary),
    category: String(r.category),
    status: String(r.status) as ToolApprovalStatus,
    createdAt: String(r.created_at),
    decidedAt: s(r.decided_at),
    decidedBy: s(r.decided_by),
    expiresAt: String(r.expires_at),
  };
}

/** Event data is stored as JSON of at most this many bytes; bigger data keeps a preview. */
export const EVENT_DATA_MAX = 8 * 1024;

export function capEventData(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  const json = JSON.stringify(data);
  if (json === undefined) return null;
  if (Buffer.byteLength(json, "utf8") <= EVENT_DATA_MAX) return json;
  return JSON.stringify({ _truncated: true, preview: json.slice(0, 4000) });
}

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Runs `fn` in one transaction (BEGIN IMMEDIATE), so a claim or a decision is atomic. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // machines

  insertMachine(m: {
    id: string;
    owner: string;
    name: string;
    policy: string;
    at: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO machines (id, owner, name, policy, killed, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      )
      .run(m.id, m.owner, m.name, m.policy, m.at);
  }

  machine(id: string): MachineRow | undefined {
    const r = this.db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as
      | Raw
      | undefined;
    return r ? toMachine(r) : undefined;
  }

  machines(owner?: string): MachineRow[] {
    const rows = (
      owner
        ? this.db
            .prepare("SELECT * FROM machines WHERE owner = ? ORDER BY id")
            .all(owner)
        : this.db.prepare("SELECT * FROM machines ORDER BY owner, id").all()
    ) as Raw[];
    return rows.map(toMachine);
  }

  updateMachine(
    id: string,
    f: { name?: string; policy?: string; killed?: boolean },
  ): void {
    if (f.name !== undefined)
      this.db
        .prepare("UPDATE machines SET name = ? WHERE id = ?")
        .run(f.name, id);
    if (f.policy !== undefined)
      this.db
        .prepare("UPDATE machines SET policy = ? WHERE id = ?")
        .run(f.policy, id);
    if (f.killed !== undefined)
      this.db
        .prepare("UPDATE machines SET killed = ? WHERE id = ?")
        .run(f.killed ? 1 : 0, id);
  }

  seen(id: string, at: string, version: string | null): void {
    if (version)
      this.db
        .prepare(
          "UPDATE machines SET last_seen = ?, worker_version = ? WHERE id = ?",
        )
        .run(at, version, id);
    else
      this.db
        .prepare("UPDATE machines SET last_seen = ? WHERE id = ?")
        .run(at, id);
  }

  countByStatus(machine: string, statuses: readonly TaskStatus[]): number {
    const marks = statuses.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE machine = ? AND status IN (${marks})`,
        )
        .get(machine, ...statuses) as {
        n: number;
      }
    ).n;
  }

  // tasks

  insertTask(t: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, owner, machine, created_by, source_machine, folder, prompt, priority, status, session_id,
           result, exit_code, error, created_at, updated_at, started_at, finished_at, cancel_requested, policy_snapshot, parent, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.owner,
        t.machine,
        t.createdBy,
        t.sourceMachine,
        t.folder,
        t.prompt,
        t.priority,
        t.status,
        t.createdAt,
        t.updatedAt,
        t.policySnapshot,
        t.parent,
        t.projectId ?? null,
      );
  }

  task(id: string): TaskRow | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Raw
      | undefined;
    return r ? toTask(r) : undefined;
  }

  tasks(
    owner: string,
    f: { machine?: string; status?: TaskStatus; limit: number },
  ): TaskRow[] {
    const where = ["owner = ?"];
    const params: Array<string | number> = [owner];
    if (f.machine) {
      where.push("machine = ?");
      params.push(f.machine);
    }
    if (f.status) {
      where.push("status = ?");
      params.push(f.status);
    }
    params.push(f.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as Raw[];
    return rows.map(toTask);
  }

  tasksWhere(sql: string, ...params: Array<string | number>): TaskRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM tasks WHERE ${sql}`)
        .all(...params) as Raw[]
    ).map(toTask);
  }

  /** The next task a worker takes: highest priority, then oldest. */
  nextQueued(machine: string): TaskRow | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM tasks WHERE machine = ? AND status = 'queued'
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at, rowid LIMIT 1`,
      )
      .get(machine) as Raw | undefined;
    return r ? toTask(r) : undefined;
  }

  /** Compare-and-set on the status; true when the row was in `from` and changed. */
  setStatus(
    id: string,
    from: readonly TaskStatus[],
    to: TaskStatus,
    at: string,
    extra: { startedAt?: string; finishedAt?: string } = {},
  ): boolean {
    const marks = from.map(() => "?").join(", ");
    const res = this.db
      .prepare(
        `UPDATE tasks SET status = ?, updated_at = ?, started_at = COALESCE(started_at, ?), finished_at = COALESCE(finished_at, ?)
         WHERE id = ? AND status IN (${marks})`,
      )
      .run(
        to,
        at,
        extra.startedAt ?? null,
        extra.finishedAt ?? null,
        id,
        ...from,
      );
    return Number(res.changes) === 1;
  }

  setOutcome(
    id: string,
    f: {
      sessionId?: string;
      result?: string;
      exitCode?: number;
      error?: string;
    },
    at: string,
  ): void {
    this.db
      .prepare(
        `UPDATE tasks SET session_id = COALESCE(?, session_id), result = COALESCE(?, result),
           exit_code = COALESCE(?, exit_code), error = COALESCE(?, error), updated_at = ? WHERE id = ?`,
      )
      .run(
        f.sessionId ?? null,
        f.result ?? null,
        f.exitCode ?? null,
        f.error ?? null,
        at,
        id,
      );
  }

  requestCancel(id: string, at: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET cancel_requested = 1, updated_at = ? WHERE id = ?",
      )
      .run(at, id);
  }

  // events

  addEvent(e: {
    task: string;
    at: string;
    actor: string;
    machine: string | null;
    type: string;
    data?: unknown;
  }): number {
    const res = this.db
      .prepare(
        "INSERT INTO task_events (task, at, actor, machine, type, data) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(e.task, e.at, e.actor, e.machine, e.type, capEventData(e.data));
    return Number(res.lastInsertRowid);
  }

  events(task: string, after: number, limit: number): TaskEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM task_events WHERE task = ? AND id > ? ORDER BY id LIMIT ?",
        )
        .all(task, after, limit) as Raw[]
    ).map(toEvent);
  }

  /** Events of one owner's tasks, newest first, paged by id. */
  log(
    owner: string,
    f: { machine?: string; task?: string; before?: number; limit: number },
  ): TaskEvent[] {
    const where = ["e.id < ?", "t.owner = ?"];
    const params: Array<string | number> = [
      f.before ?? Number.MAX_SAFE_INTEGER,
      owner,
    ];
    if (f.machine) {
      where.push("t.machine = ?");
      params.push(f.machine);
    }
    if (f.task) {
      where.push("e.task = ?");
      params.push(f.task);
    }
    params.push(f.limit);
    return (
      this.db
        .prepare(
          `SELECT e.* FROM task_events e JOIN tasks t ON t.id = e.task WHERE ${where.join(" AND ")} ORDER BY e.id DESC LIMIT ?`,
        )
        .all(...params) as Raw[]
    ).map(toEvent);
  }

  // tool approvals

  insertApproval(a: ToolApprovalRow): void {
    this.db
      .prepare(
        `INSERT INTO task_tool_approvals (id, task, machine, owner, tool, summary, category, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        a.id,
        a.task,
        a.machine,
        a.owner,
        a.tool,
        a.summary,
        a.category,
        a.createdAt,
        a.expiresAt,
      );
  }

  approval(id: string): ToolApprovalRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM task_tool_approvals WHERE id = ?")
      .get(id) as Raw | undefined;
    return r ? toApproval(r) : undefined;
  }

  approvalsOf(task: string, status?: ToolApprovalStatus): ToolApprovalRow[] {
    const rows = (
      status
        ? this.db
            .prepare(
              "SELECT * FROM task_tool_approvals WHERE task = ? AND status = ? ORDER BY created_at, id",
            )
            .all(task, status)
        : this.db
            .prepare(
              "SELECT * FROM task_tool_approvals WHERE task = ? ORDER BY created_at, id",
            )
            .all(task)
    ) as Raw[];
    return rows.map(toApproval);
  }

  approvalsWhere(
    sql: string,
    ...params: Array<string | number>
  ): ToolApprovalRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM task_tool_approvals WHERE ${sql}`)
        .all(...params) as Raw[]
    ).map(toApproval);
  }

  /** Compare-and-set on `pending`. */
  decideApproval(
    id: string,
    status: Exclude<ToolApprovalStatus, "pending">,
    by: string,
    at: string,
  ): boolean {
    const res = this.db
      .prepare(
        "UPDATE task_tool_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, by, at, id);
    return Number(res.changes) === 1;
  }

  countPending(owner: string): { awaitingTap: number; toolApprovals: number } {
    const a = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE owner = ? AND status = 'awaiting_tap'",
      )
      .get(owner) as {
      n: number;
    };
    const b = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM task_tool_approvals WHERE owner = ? AND status = 'pending'",
      )
      .get(owner) as { n: number };
    return { awaitingTap: a.n, toolApprovals: b.n };
  }
}
