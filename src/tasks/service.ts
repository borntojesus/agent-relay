import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { OnPending } from "../push/types.ts";
import { NAME } from "../grants.ts";
import {
  ACTIVE,
  PRIORITIES,
  TASK_STATUSES,
  TERMINAL,
  type MachineRow,
  type Priority,
  type TaskEvent,
  type TaskRow,
  type TaskStatus,
  type TaskStore,
  type ToolApprovalRow,
  type ToolApprovalStatus,
} from "./store.ts";

/**
 * Tasks between an owner's own machines (docs/worker-api.md). The owner's
 * console creates a task for one of their machines; the worker on that
 * machine claims it, runs it under the machine's policy and reports back.
 *
 * The rules live here: who may touch which task, which status follows which,
 * the policy, the kill switch and tool approvals. Every state change writes a
 * row in the append-only `task_events`. Fail closed: a tool approval that is
 * not decided in 15 minutes, or is pending when the relay starts, is expired,
 * and a killed machine gets no work.
 */

export const CATEGORIES = ["push", "deploy", "delete", "prod"] as const;
export type ApprovalCategory = (typeof CATEGORIES)[number];

export const PROMPT_MAX = 20_000;
export const RESULT_MAX = 64 * 1024;
export const EVENTS_PER_CALL = 50;
export const TOOL_APPROVAL_TTL_MS = 15 * 60_000;
export const AWAITING_TAP_TTL_MS = 24 * 60 * 60_000;
export const ONLINE_MS = 60_000;
export const WAIT_MAX_S = 30;
export const WORKER_EVENT_TYPES = [
  "started",
  "progress",
  "tool",
  "tool_result",
  "log",
  "finished",
] as const;

/** A refused task call; `status` is the HTTP status it answers with. */
export class TaskError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "TaskError";
    this.status = status;
  }
}

// --- policy

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** An absolute path without `.`/`..` segments, with duplicate and trailing slashes dropped; undefined otherwise. */
export function normalizeFolder(p: unknown): string | undefined {
  if (
    typeof p !== "string" ||
    !p.startsWith("/") ||
    p.length > 1024 ||
    CONTROL.test(p)
  )
    return undefined;
  const parts = p.split("/").filter(Boolean);
  if (parts.some((x) => x === ".." || x === ".")) return undefined;
  return `/${parts.join("/")}`;
}

/** True when `folder` is `prefix` or inside it. Both normalized. */
export function folderInside(folder: string, prefix: string): boolean {
  return prefix === "/" || folder === prefix || folder.startsWith(`${prefix}/`);
}

const folderSchema = z
  .string()
  .refine((p) => normalizeFolder(p) !== undefined, {
    message: "a folder is an absolute path without . or .. segments",
  })
  .transform((p) => normalizeFolder(p)!);
/** A tool rule: `Tool` or `Tool(pattern)`, e.g. `Read`, `mcp__srv__tool`, `Bash(git status:*)`. */
export const TOOL_RULE = /^[A-Za-z_][A-Za-z0-9_.-]*(\(.+\))?$/s;
export const TOOLS_MAX = 64;
const toolSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((t) => !CONTROL.test(t), {
    message: "a tool has no control characters",
  })
  .refine((t) => TOOL_RULE.test(t), {
    message: "a tool is Tool or Tool(pattern)",
  });

export const policySchema = z.strictObject({
  folders: z.array(folderSchema).max(50),
  permissionMode: z.enum(["default", "acceptEdits", "plan"]),
  allowedTools: z.array(toolSchema).max(TOOLS_MAX),
  disallowedTools: z.array(toolSchema).max(TOOLS_MAX),
  requireTap: z.boolean(),
  approvalActions: z.array(z.enum(CATEGORIES)),
  maxRuntimeMinutes: z.number().int().min(1).max(240),
  allowFollowUps: z.boolean(),
});
export type Policy = z.infer<typeof policySchema>;

/** A new machine refuses every task until its owner adds a folder. */
export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  folders: [],
  permissionMode: "default",
  allowedTools: ["Read", "Glob", "Grep"],
  disallowedTools: [],
  requireTap: true,
  approvalActions: [...CATEGORIES],
  maxRuntimeMinutes: 30,
  allowFollowUps: true,
}) as Policy;

/** Validates a policy; fields left out come from `base`. Throws TaskError 400. */
export function parsePolicy(
  raw: unknown,
  base: Policy = DEFAULT_POLICY,
): Policy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new TaskError(400, "policy is a JSON object");
  const r = raw as Record<string, unknown>;
  if (r.permissionMode === "bypassPermissions")
    throw new TaskError(
      400,
      "policy.permissionMode: bypassPermissions is never allowed",
    );
  const out = policySchema.safeParse({ ...base, ...r });
  if (!out.success) {
    const issue = out.error.issues[0]!;
    throw new TaskError(
      400,
      `policy.${issue.path.join(".") || "?"}: ${issue.message}`,
    );
  }
  const p = out.data;
  return {
    ...p,
    folders: [...new Set(p.folders)],
    allowedTools: [...new Set(p.allowedTools)],
    disallowedTools: [...new Set(p.disallowedTools)],
    approvalActions: [...new Set(p.approvalActions)],
  };
}

function readPolicy(json: string): Policy {
  try {
    return parsePolicy(JSON.parse(json));
  } catch {
    // A row that no longer validates is treated as the strict default.
    return { ...DEFAULT_POLICY, folders: [] };
  }
}

// --- views

export interface MachineView {
  id: string;
  name: string;
  online: boolean;
  lastSeen: string | null;
  killed: boolean;
  workerVersion: string | null;
  policy: Policy;
  /** Tasks accepted, running or waiting for a tool approval. */
  running: number;
  /** Tasks in `queued`. */
  queued: number;
}

export interface ToolApprovalView {
  id: string;
  task: string;
  machine: string;
  tool: string;
  summary: string;
  category: string;
  status: ToolApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface TaskView {
  id: string;
  machine: string;
  machineName: string;
  folder: string;
  prompt: string;
  priority: Priority;
  status: TaskStatus;
  createdBy: string;
  sourceMachine: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: string | null;
  exitCode: number | null;
  error: string | null;
  sessionId: string | null;
  parent: string | null;
  cancelRequested: boolean;
  /** The project of the task, null when none (0.6.0). */
  projectId: string | null;
  pendingApprovals: ToolApprovalView[];
}

/** What a worker gets from `/worker/next`. */
export interface WorkTask {
  id: string;
  folder: string;
  prompt: string;
  priority: Priority;
  parent: string | null;
  resumeSessionId: string | null;
  policy: Policy;
}

export interface EventView {
  id: number;
  task: string;
  at: string;
  actor: string;
  machine: string | null;
  type: string;
  data: unknown;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function randomId(prefix: string, n: number): string {
  const bytes = randomBytes(n);
  let out = prefix;
  for (let i = 0; i < n; i++) out += BASE32[bytes[i]! & 31];
  return out;
}

const oneLine = (v: string) =>
  v
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();

function capBytes(v: string, max: number): string {
  const b = Buffer.from(v, "utf8");
  if (b.length <= max) return v;
  return b.subarray(0, max).toString("utf8").replace(/�+$/, "");
}

export interface TaskServiceDeps {
  store: TaskStore;
  ownerExists: (owner: string) => boolean;
  now: () => number;
  /** A notice to the owner's own channel (Telegram), for tool approvals. Fire and forget. */
  notify?: (owner: string, text: string) => void;
  /** Told when a task awaits the owner's tap or a tool approval is pending (push). Never awaited. */
  onPending?: OnPending;
  log?: (line: string) => void;
}

export class TaskService {
  private readonly store: TaskStore;
  private readonly deps: TaskServiceDeps;
  private readonly waiters = new Map<string, Set<() => void>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: TaskServiceDeps) {
    this.deps = deps;
    this.store = deps.store;
  }

  private iso(offsetMs = 0): string {
    return new Date(this.deps.now() + offsetMs).toISOString();
  }

  // --- waiting (long-poll)

  private wake(key: string): void {
    const set = this.waiters.get(key);
    if (!set) return;
    this.waiters.delete(key);
    for (const done of [...set]) done();
  }

  /** Resolves when `key` is woken, after `ms`, or when `signal` aborts. Never blocks the loop. */
  private wait(key: string, ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let set = this.waiters.get(key);
      if (!set) {
        set = new Set();
        this.waiters.set(key, set);
      }
      const own = set;
      const done = () => {
        clearTimeout(timer);
        own.delete(done);
        if (!own.size && this.waiters.get(key) === own)
          this.waiters.delete(key);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      own.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** How many long-polls are waiting (tests). */
  waiting(): number {
    let n = 0;
    for (const s of this.waiters.values()) n += s.size;
    return n;
  }

  // --- lifecycle

  /** At boot: pending tool approvals expire (fail closed), then a sweep runs every `sweepMs`. */
  boot(sweepMs = 30_000): number {
    const n = this.restart();
    this.sweep();
    if (!this.timer) {
      this.timer = setInterval(() => {
        try {
          this.sweep();
        } catch (err) {
          this.deps.log?.(
            `[tasks] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }, sweepMs);
      this.timer.unref?.();
    }
    return n;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const key of [...this.waiters.keys()]) this.wake(key);
  }

  /** Every tool approval still pending (from before a restart) expires. */
  restart(): number {
    const pending = this.store.approvalsWhere("status = 'pending'");
    for (const a of pending)
      this.closeApproval(a, "expired", "restart", "server");
    return pending.length;
  }

  /** Expires tool approvals past their time and tasks left in awaiting_tap for 24 h. */
  sweep(): void {
    const now = this.iso();
    for (const a of this.store.approvalsWhere(
      "status = 'pending' AND expires_at <= ?",
      now,
    )) {
      this.closeApproval(a, "expired", "timeout", "server");
    }
    for (const t of this.store.tasksWhere(
      "status = 'awaiting_tap' AND created_at <= ?",
      this.iso(-AWAITING_TAP_TTL_MS),
    )) {
      if (
        this.store.setStatus(t.id, ["awaiting_tap"], "cancelled", now, {
          finishedAt: now,
        })
      ) {
        this.store.addEvent({
          task: t.id,
          at: now,
          actor: "server",
          machine: t.machine,
          type: "expired",
          data: { from: "awaiting_tap", to: "cancelled" },
        });
      }
    }
  }

  // --- machines

  addMachine(m: {
    id: string;
    owner: string;
    name: string;
    policy?: unknown;
  }): MachineView {
    const id = String(m.id ?? "")
      .trim()
      .toLowerCase();
    if (!NAME.test(id))
      throw new TaskError(
        400,
        "machine id: lowercase letters, digits and dashes, up to 32",
      );
    if (!this.deps.ownerExists(m.owner))
      throw new TaskError(404, `no such owner: ${m.owner}`);
    const name = oneLine(String(m.name ?? ""));
    if (!name || name.length > 80)
      throw new TaskError(400, "machine name is 1 to 80 characters");
    if (this.store.machine(id))
      throw new TaskError(409, `machine ${id} exists`);
    const policy =
      m.policy === undefined ? { ...DEFAULT_POLICY } : parsePolicy(m.policy);
    this.store.insertMachine({
      id,
      owner: m.owner,
      name,
      policy: JSON.stringify(policy),
      at: this.iso(),
    });
    return this.machineView(this.store.machine(id)!);
  }

  machine(id: string): MachineRow | undefined {
    return this.store.machine(id);
  }

  allMachines(): MachineView[] {
    return this.store.machines().map((m) => this.machineView(m));
  }

  machinesOf(owner: string): MachineView[] {
    return this.store.machines(owner).map((m) => this.machineView(m));
  }

  policyOf(id: string): Policy {
    const m = this.store.machine(id);
    if (!m) throw new TaskError(404, "no such machine");
    return readPolicy(m.policy);
  }

  machineView(m: MachineRow): MachineView {
    return {
      id: m.id,
      name: m.name,
      online: Boolean(
        m.lastSeen && Date.parse(m.lastSeen) >= this.deps.now() - ONLINE_MS,
      ),
      lastSeen: m.lastSeen,
      killed: m.killed,
      workerVersion: m.workerVersion,
      policy: readPolicy(m.policy),
      running: this.store.countByStatus(m.id, ACTIVE),
      queued: this.store.countByStatus(m.id, ["queued"]),
    };
  }

  /** A machine of `owner`; any other (or none) is 404. */
  ownMachine(owner: string, id: unknown): MachineRow {
    const m =
      typeof id === "string"
        ? this.store.machine(id.trim().toLowerCase())
        : undefined;
    if (!m || m.owner !== owner) throw new TaskError(404, "no such machine");
    return m;
  }

  /**
   * Changes a machine (owner console or admin CLI). `owner` null = the admin.
   * A partial policy is merged over the current one, then validated whole.
   */
  updateMachine(
    owner: string | null,
    id: string,
    f: { name?: unknown; policy?: unknown; killed?: unknown },
    actor: string,
  ): MachineView {
    const m =
      owner === null ? this.store.machine(id) : this.ownMachine(owner, id);
    if (!m) throw new TaskError(404, "no such machine");
    if (
      f.name === undefined &&
      f.policy === undefined &&
      f.killed === undefined
    ) {
      throw new TaskError(400, "say what changes: name, policy, killed");
    }
    let name: string | undefined;
    if (f.name !== undefined) {
      name = typeof f.name === "string" ? oneLine(f.name) : "";
      if (!name || name.length > 80)
        throw new TaskError(400, "machine name is 1 to 80 characters");
    }
    const policy =
      f.policy === undefined
        ? undefined
        : parsePolicy(f.policy, readPolicy(m.policy));
    if (f.killed !== undefined && typeof f.killed !== "boolean")
      throw new TaskError(400, "killed is true or false");
    this.store.tx(() => {
      this.store.updateMachine(m.id, {
        ...(name !== undefined ? { name } : {}),
        ...(policy ? { policy: JSON.stringify(policy) } : {}),
      });
      if (typeof f.killed === "boolean" && f.killed !== m.killed)
        this.applyKill(m, f.killed, actor);
    });
    this.wake(`m:${m.id}`);
    return this.machineView(this.store.machine(m.id)!);
  }

  /**
   * The kill switch. On: the worker gets no new task, every queued or
   * awaiting_tap task is cancelled at once, every running one gets
   * cancel_requested, and pending tool approvals are rejected. Off: new work
   * flows again; nothing cancelled comes back.
   */
  private applyKill(m: MachineRow, on: boolean, actor: string): void {
    const now = this.iso();
    this.store.updateMachine(m.id, { killed: on });
    if (!on) return;
    for (const t of this.store.tasksWhere(
      "machine = ? AND status NOT IN ('done', 'failed', 'cancelled')",
      m.id,
    )) {
      if (t.status === "queued" || t.status === "awaiting_tap") {
        if (
          this.store.setStatus(t.id, [t.status], "cancelled", now, {
            finishedAt: now,
          })
        ) {
          this.store.addEvent({
            task: t.id,
            at: now,
            actor,
            machine: m.id,
            type: "status",
            data: { from: t.status, to: "cancelled", reason: "killed" },
          });
        }
      } else {
        this.store.requestCancel(t.id, now);
        this.store.addEvent({
          task: t.id,
          at: now,
          actor,
          machine: m.id,
          type: "cancel_requested",
          data: { reason: "killed" },
        });
      }
    }
    for (const a of this.store.approvalsWhere(
      "machine = ? AND status = 'pending'",
      m.id,
    )) {
      this.closeApproval(a, "rejected", "killed", actor);
    }
  }

  // --- tasks (owner console)

  private view(t: TaskRow): TaskView {
    return {
      id: t.id,
      machine: t.machine,
      machineName: this.store.machine(t.machine)?.name ?? t.machine,
      folder: t.folder,
      prompt: t.prompt,
      priority: t.priority,
      status: t.status,
      createdBy: t.createdBy,
      sourceMachine: t.sourceMachine,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      result: t.result,
      exitCode: t.exitCode,
      error: t.error,
      sessionId: t.sessionId,
      parent: t.parent,
      cancelRequested: t.cancelRequested,
      projectId: t.projectId ?? null,
      pendingApprovals: this.store
        .approvalsOf(t.id, "pending")
        .map(approvalView),
    };
  }

  /** A task of `owner`; any other (or none) is 404. */
  private ownTask(owner: string, id: string): TaskRow {
    const t = this.store.task(id);
    if (!t || t.owner !== owner) throw new TaskError(404, "no such task");
    return t;
  }

  get(owner: string, id: string): TaskView {
    this.sweep();
    return this.view(this.ownTask(owner, id));
  }

  list(
    owner: string,
    f: { machine?: string; status?: string; limit?: number } = {},
  ): TaskView[] {
    this.sweep();
    if (
      f.status !== undefined &&
      !TASK_STATUSES.includes(f.status as TaskStatus)
    ) {
      throw new TaskError(400, `status is one of ${TASK_STATUSES.join(", ")}`);
    }
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200);
    return this.store
      .tasks(owner, {
        ...(f.machine ? { machine: f.machine.toLowerCase() } : {}),
        ...(f.status ? { status: f.status as TaskStatus } : {}),
        limit,
      })
      .map((t) => this.view(t));
  }

  create(
    owner: string,
    actor: string,
    body: Record<string, unknown>,
    parent?: TaskRow,
    /** A project the caller already checked access to (console); a follow-up inherits the parent's. */
    projectId?: string | null,
  ): TaskView {
    const m = this.ownMachine(owner, body.machine);
    if (m.killed)
      throw new TaskError(400, "the machine is killed (kill switch on)");
    const policy = readPolicy(m.policy);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw new TaskError(400, "prompt is required");
    if (prompt.length > PROMPT_MAX)
      throw new TaskError(
        400,
        `prompt is longer than ${PROMPT_MAX} characters`,
      );
    const folder = normalizeFolder(body.folder);
    if (!folder)
      throw new TaskError(
        400,
        "folder is an absolute path without . or .. segments",
      );
    if (!policy.folders.some((p) => folderInside(folder, p))) {
      throw new TaskError(
        400,
        "folder is not inside any folder of the machine policy",
      );
    }
    const priority = (body.priority ?? "normal") as Priority;
    if (!PRIORITIES.includes(priority))
      throw new TaskError(400, "priority is low, normal or high");
    let sourceMachine: string | null = null;
    if (body.sourceMachine !== undefined && body.sourceMachine !== null) {
      if (
        typeof body.sourceMachine !== "string" ||
        !NAME.test(body.sourceMachine)
      ) {
        throw new TaskError(400, "sourceMachine is a machine id");
      }
      sourceMachine = body.sourceMachine;
    }
    const now = this.iso();
    const status: TaskStatus = policy.requireTap ? "awaiting_tap" : "queued";
    const id = randomId("tk_", 12);
    this.store.tx(() => {
      this.store.insertTask({
        id,
        owner,
        machine: m.id,
        createdBy: actor,
        sourceMachine,
        folder,
        prompt,
        priority,
        status,
        sessionId: null,
        result: null,
        exitCode: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        cancelRequested: false,
        policySnapshot: JSON.stringify(policy),
        parent: parent?.id ?? null,
        projectId: projectId ?? parent?.projectId ?? null,
      });
      this.store.addEvent({
        task: id,
        at: now,
        actor,
        machine: m.id,
        type: "created",
        data: {
          status,
          priority,
          folder,
          ...(parent ? { parent: parent.id } : {}),
          ...(sourceMachine ? { sourceMachine } : {}),
          ...((projectId ?? parent?.projectId) ? { project: projectId ?? parent?.projectId } : {}),
        },
      });
      if (parent)
        this.store.addEvent({
          task: parent.id,
          at: now,
          actor,
          machine: m.id,
          type: "followup",
          data: { task: id },
        });
    });
    if (status === "queued") this.wake(`m:${m.id}`);
    else this.deps.onPending?.(owner, { kind: "task", id });
    return this.view(this.store.task(id)!);
  }

  /** The owner's Start on an awaiting_tap task. */
  startTask(owner: string, id: string, actor: string): TaskView {
    this.sweep();
    const t = this.ownTask(owner, id);
    if (t.status !== "awaiting_tap")
      throw new TaskError(400, `cannot start a task that is ${t.status}`);
    if (this.store.machine(t.machine)?.killed)
      throw new TaskError(400, "the machine is killed (kill switch on)");
    const now = this.iso();
    if (!this.store.setStatus(t.id, ["awaiting_tap"], "queued", now))
      throw new TaskError(409, "the task changed meanwhile");
    this.store.addEvent({
      task: t.id,
      at: now,
      actor,
      machine: t.machine,
      type: "status",
      data: { from: "awaiting_tap", to: "queued" },
    });
    this.wake(`m:${t.machine}`);
    return this.view(this.store.task(t.id)!);
  }

  cancel(owner: string, id: string, actor: string): TaskView {
    const t = this.ownTask(owner, id);
    const now = this.iso();
    if (TERMINAL.includes(t.status))
      throw new TaskError(400, `the task is already ${t.status}`);
    if (t.status === "queued" || t.status === "awaiting_tap") {
      if (
        !this.store.setStatus(t.id, [t.status], "cancelled", now, {
          finishedAt: now,
        })
      )
        throw new TaskError(409, "the task changed meanwhile");
      this.store.addEvent({
        task: t.id,
        at: now,
        actor,
        machine: t.machine,
        type: "status",
        data: { from: t.status, to: "cancelled" },
      });
    } else if (!t.cancelRequested) {
      this.store.requestCancel(t.id, now);
      this.store.addEvent({
        task: t.id,
        at: now,
        actor,
        machine: t.machine,
        type: "cancel_requested",
        data: null,
      });
    }
    return this.view(this.store.task(t.id)!);
  }

  followup(
    owner: string,
    id: string,
    body: Record<string, unknown>,
    actor: string,
  ): TaskView {
    const parent = this.ownTask(owner, id);
    if (!TERMINAL.includes(parent.status))
      throw new TaskError(
        400,
        "a follow-up needs a finished task (done, failed or cancelled)",
      );
    const m = this.ownMachine(owner, parent.machine);
    if (!readPolicy(m.policy).allowFollowUps)
      throw new TaskError(400, "the machine policy does not allow follow-ups");
    return this.create(
      owner,
      actor,
      {
        machine: parent.machine,
        folder: parent.folder,
        prompt: body.prompt,
        priority: body.priority ?? parent.priority,
        sourceMachine: body.sourceMachine,
      },
      parent,
    );
  }

  events(owner: string, id: string, after = 0, limit = 500): EventView[] {
    const t = this.ownTask(owner, id);
    return this.store.events(t.id, after, Math.min(Math.max(limit, 1), 1000));
  }

  log(
    owner: string,
    f: {
      machine?: string;
      task?: string;
      before?: number;
      limit?: number;
    } = {},
  ): EventView[] {
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 100), 1), 500);
    return this.store.log(owner, {
      ...(f.machine ? { machine: f.machine.toLowerCase() } : {}),
      ...(f.task ? { task: f.task } : {}),
      ...(f.before !== undefined ? { before: f.before } : {}),
      limit,
    });
  }

  /** The owner's decision on a tool approval. */
  decide(
    owner: string,
    taskId: string,
    approvalId: string,
    decision: unknown,
    actor: string,
  ): { approval: ToolApprovalView; task: TaskView } {
    const t = this.ownTask(owner, taskId);
    let a = this.store.approval(approvalId);
    if (!a || a.task !== t.id)
      throw new TaskError(404, "no such tool approval");
    if (decision !== "approve" && decision !== "reject")
      throw new TaskError(400, "decision is approve or reject");
    a = this.expireIfDue(a);
    if (a.status !== "pending")
      throw new TaskError(409, `the tool approval is already ${a.status}`);
    if (
      !this.closeApproval(
        a,
        decision === "approve" ? "approved" : "rejected",
        "console",
        actor,
      )
    ) {
      throw new TaskError(409, "the tool approval was decided meanwhile");
    }
    return {
      approval: approvalView(this.store.approval(a.id)!),
      task: this.view(this.store.task(t.id)!),
    };
  }

  /** awaiting_tap tasks plus pending tool approvals, for the Dock badge. */
  pendingCount(owner: string): number {
    this.sweep();
    const c = this.store.countPending(owner);
    return c.awaitingTap + c.toolApprovals;
  }

  // --- tool approvals (shared)

  private expireIfDue(a: ToolApprovalRow): ToolApprovalRow {
    if (a.status === "pending" && Date.parse(a.expiresAt) <= this.deps.now()) {
      this.closeApproval(a, "expired", "timeout", "server");
      return this.store.approval(a.id)!;
    }
    return a;
  }

  /**
   * Decides a pending tool approval (compare-and-set), logs it on the task and,
   * when nothing else waits, puts a waiting_approval task back to running.
   */
  private closeApproval(
    a: ToolApprovalRow,
    status: "approved" | "rejected" | "expired",
    via: string,
    actor: string,
  ): boolean {
    const now = this.iso();
    const ok = this.store.decideApproval(a.id, status, `${via}:${actor}`, now);
    if (!ok) return false;
    this.store.addEvent({
      task: a.task,
      at: now,
      actor,
      machine: a.machine,
      type: "approval_decided",
      data: { id: a.id, tool: a.tool, status, via },
    });
    const t = this.store.task(a.task);
    if (
      t &&
      t.status === "waiting_approval" &&
      this.store.approvalsOf(t.id, "pending").length === 0
    ) {
      if (this.store.setStatus(t.id, ["waiting_approval"], "running", now)) {
        this.store.addEvent({
          task: t.id,
          at: now,
          actor: "server",
          machine: t.machine,
          type: "status",
          data: { from: "waiting_approval", to: "running" },
        });
      }
    }
    this.wake(`a:${a.id}`);
    return true;
  }

  // --- worker

  /** Marks the machine seen; every worker call does this. */
  touch(machine: string, version: string | undefined): void {
    const v = version ? oneLine(version).slice(0, 40) : "";
    this.store.seen(machine, this.iso(), v || null);
  }

  /** A task of the worker's machine; any other (or none) is 404. */
  private machineTask(machine: string, id: string): TaskRow {
    const t = this.store.task(id);
    if (!t || t.machine !== machine) throw new TaskError(404, "no such task");
    return t;
  }

  /** Claims the oldest highest-priority queued task, or undefined (none, or the machine is killed). */
  claim(machine: string, actor: string): WorkTask | undefined {
    return this.store.tx(() => {
      for (;;) {
        const m = this.store.machine(machine);
        if (!m || m.killed) return undefined;
        const t = this.store.nextQueued(machine);
        if (!t) return undefined;
        const policy = readPolicy(m.policy);
        const now = this.iso();
        if (!policy.folders.some((p) => folderInside(t.folder, p))) {
          // The owner narrowed the policy after the task was made: fail closed.
          this.store.setStatus(t.id, ["queued"], "failed", now, {
            finishedAt: now,
          });
          this.store.setOutcome(
            t.id,
            { error: "folder not allowed by the machine policy any more" },
            now,
          );
          this.store.addEvent({
            task: t.id,
            at: now,
            actor: "server",
            machine,
            type: "status",
            data: { from: "queued", to: "failed", error: "folder not allowed" },
          });
          continue;
        }
        if (!this.store.setStatus(t.id, ["queued"], "accepted", now)) continue;
        this.store.addEvent({
          task: t.id,
          at: now,
          actor,
          machine,
          type: "accepted",
          data: null,
        });
        const parent = t.parent ? this.store.task(t.parent) : undefined;
        return {
          id: t.id,
          folder: t.folder,
          prompt: t.prompt,
          priority: t.priority,
          parent: t.parent,
          resumeSessionId: parent?.sessionId ?? null,
          policy,
        };
      }
    });
  }

  /** Puts a just-claimed task back in the queue when the worker hung up before it got the answer. */
  unclaim(machine: string, id: string): void {
    const now = this.iso();
    if (this.store.setStatus(id, ['accepted'], 'queued', now)) {
      this.store.addEvent({ task: id, at: now, actor: 'server', machine, type: 'status', data: { from: 'accepted', to: 'queued', reason: 'worker hung up' } });
      this.wake(`m:${machine}`);
    }
  }

  /** Long-poll for the next task: claims at once or waits up to `waitMs` for one. */
  async next(
    machine: string,
    actor: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<WorkTask | undefined> {
    const deadline =
      performance.now() + Math.min(Math.max(waitMs, 0), WAIT_MAX_S * 1000);
    for (;;) {
      this.sweep();
      const t = this.claim(machine, actor);
      if (t) return t;
      const left = deadline - performance.now();
      if (left <= 0 || signal?.aborted || this.store.machine(machine)?.killed)
        return undefined;
      await this.wait(`m:${machine}`, left, signal);
      if (signal?.aborted) return undefined;
    }
  }

  /** Appends worker events (max 50) to a task of its machine. */
  workerEvents(
    machine: string,
    id: string,
    events: unknown,
    actor: string,
  ): { cancel: boolean; killed: boolean } {
    const t = this.machineTask(machine, id);
    if (!Array.isArray(events) || events.length === 0)
      throw new TaskError(400, "events is a non-empty list");
    if (events.length > EVENTS_PER_CALL)
      throw new TaskError(400, `at most ${EVENTS_PER_CALL} events per call`);
    const rows = events.map((e) => {
      if (!e || typeof e !== "object" || Array.isArray(e))
        throw new TaskError(400, "an event is {type, data}");
      const r = e as Record<string, unknown>;
      if (
        !WORKER_EVENT_TYPES.includes(
          r.type as (typeof WORKER_EVENT_TYPES)[number],
        )
      ) {
        throw new TaskError(
          400,
          `event type is one of ${WORKER_EVENT_TYPES.join(", ")}`,
        );
      }
      return { type: String(r.type), data: r.data ?? null };
    });
    const now = this.iso();
    this.store.tx(() => {
      for (const r of rows)
        this.store.addEvent({
          task: t.id,
          at: now,
          actor,
          machine,
          type: r.type,
          data: r.data,
        });
    });
    return this.cancelState(t.id, machine);
  }

  private cancelState(
    id: string,
    machine: string,
  ): { cancel: boolean; killed: boolean } {
    const t = this.store.task(id)!;
    const killed = Boolean(this.store.machine(machine)?.killed);
    return {
      cancel: t.cancelRequested || killed || t.status === "cancelled",
      killed,
    };
  }

  /** The worker reports a status. Illegal transitions are 400. */
  workerStatus(
    machine: string,
    id: string,
    body: Record<string, unknown>,
    actor: string,
  ): { id: string; status: TaskStatus; cancel: boolean; killed: boolean } {
    const t = this.machineTask(machine, id);
    const to = body.status as TaskStatus;
    const from: Partial<Record<TaskStatus, readonly TaskStatus[]>> = {
      running: ["accepted", "running"],
      done: ACTIVE,
      failed: ACTIVE,
      cancelled: ACTIVE,
    };
    const allowed = from[to];
    if (!allowed)
      throw new TaskError(400, "status is running, done, failed or cancelled");
    if (!allowed.includes(t.status))
      throw new TaskError(400, `illegal transition ${t.status} -> ${to}`);
    const str = (k: string, max: number): string | undefined => {
      const v = body[k];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "string")
        throw new TaskError(400, `${k} must be a string`);
      return capBytes(v, max);
    };
    const sessionId = str("sessionId", 200);
    const result = str("result", RESULT_MAX);
    const error = str("error", 4000);
    let exitCode: number | undefined;
    if (body.exitCode !== undefined && body.exitCode !== null) {
      if (typeof body.exitCode !== "number" || !Number.isInteger(body.exitCode))
        throw new TaskError(400, "exitCode is a whole number");
      exitCode = body.exitCode;
    }
    const now = this.iso();
    const terminal = TERMINAL.includes(to);
    this.store.tx(() => {
      if (
        t.status !== to &&
        !this.store.setStatus(
          t.id,
          allowed,
          to,
          now,
          terminal ? { finishedAt: now } : { startedAt: now },
        )
      ) {
        throw new TaskError(409, "the task changed meanwhile");
      }
      this.store.setOutcome(
        t.id,
        {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(result !== undefined ? { result } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(error !== undefined ? { error } : {}),
        },
        now,
      );
      if (t.status !== to) {
        this.store.addEvent({
          task: t.id,
          at: now,
          actor,
          machine,
          type: "status",
          data: {
            from: t.status,
            to,
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(error !== undefined ? { error: error.slice(0, 500) } : {}),
          },
        });
      }
    });
    if (terminal) {
      for (const a of this.store.approvalsOf(t.id, "pending"))
        this.closeApproval(a, "expired", "finished", "server");
    }
    return {
      id: t.id,
      status: this.store.task(t.id)!.status,
      ...this.cancelState(t.id, machine),
    };
  }

  /** A tool call that needs the owner: the task waits in waiting_approval. */
  requestApproval(
    machine: string,
    id: string,
    body: Record<string, unknown>,
    actor: string,
  ): { id: string; expiresAt: string } {
    const t = this.machineTask(machine, id);
    const m = this.store.machine(machine)!;
    if (m.killed)
      throw new TaskError(400, "the machine is killed (kill switch on)");
    if (!ACTIVE.includes(t.status))
      throw new TaskError(400, `the task is ${t.status}`);
    const tool = typeof body.tool === "string" ? oneLine(body.tool) : "";
    if (!tool || tool.length > 100)
      throw new TaskError(400, "tool is 1 to 100 characters");
    const summary =
      typeof body.summary === "string"
        ? oneLine(body.summary).slice(0, 500)
        : "";
    if (!summary) throw new TaskError(400, "summary is required");
    const cats = Array.isArray(body.category)
      ? body.category
      : typeof body.category === "string"
        ? body.category.split(",")
        : [];
    const category = [...new Set(cats.map((c) => String(c).trim()))].filter(
      Boolean,
    );
    if (
      !category.length ||
      category.some((c) => !CATEGORIES.includes(c as ApprovalCategory))
    ) {
      throw new TaskError(
        400,
        `category is one or more of ${CATEGORIES.join(", ")}`,
      );
    }
    const now = this.iso();
    const expiresAt = this.iso(TOOL_APPROVAL_TTL_MS);
    const aid = randomId("ta_", 16);
    this.store.tx(() => {
      this.store.insertApproval({
        id: aid,
        task: t.id,
        machine,
        owner: t.owner,
        tool,
        summary,
        category: category.join(","),
        status: "pending",
        createdAt: now,
        expiresAt,
        decidedAt: null,
        decidedBy: null,
      });
      this.store.addEvent({
        task: t.id,
        at: now,
        actor,
        machine,
        type: "approval_requested",
        data: { id: aid, tool, summary, category },
      });
      if (
        t.status !== "waiting_approval" &&
        this.store.setStatus(t.id, [t.status], "waiting_approval", now)
      ) {
        this.store.addEvent({
          task: t.id,
          at: now,
          actor: "server",
          machine,
          type: "status",
          data: { from: t.status, to: "waiting_approval" },
        });
      }
    });
    this.deps.onPending?.(t.owner, { kind: "tool", id: aid });
    this.deps.notify?.(
      t.owner,
      `Task ${t.id} on ${m.name} wants to run ${tool} (${category.join(", ")}):\n${summary}\n\nApprove or reject it in the agent-relay app within 15 minutes; otherwise it is refused.`,
    );
    return { id: aid, expiresAt };
  }

  /** Long-poll on a tool approval of the worker's machine. */
  async approvalStatus(
    machine: string,
    id: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<{ status: ToolApprovalStatus }> {
    const first = this.store.approval(id);
    if (!first || first.machine !== machine)
      throw new TaskError(404, "no such tool approval");
    let a = this.expireIfDue(first);
    if (a.status === "pending") {
      const left = Math.min(
        Math.max(waitMs, 0),
        WAIT_MAX_S * 1000,
        Math.max(Date.parse(a.expiresAt) - this.deps.now(), 0),
      );
      await this.wait(`a:${id}`, left, signal);
      a = this.expireIfDue(this.store.approval(id)!);
    }
    return { status: a.status };
  }

  /** Which of the worker's running tasks it must stop, and the kill switch. */
  heartbeat(
    machine: string,
    running: unknown,
  ): { cancel: string[]; killed: boolean } {
    if (running !== undefined && !Array.isArray(running))
      throw new TaskError(400, "running is a list of task ids");
    const killed = Boolean(this.store.machine(machine)?.killed);
    const cancel: string[] = [];
    for (const raw of (running ?? []) as unknown[]) {
      if (typeof raw !== "string") continue;
      const t = this.store.task(raw);
      if (!t || t.machine !== machine) continue;
      if (killed || t.cancelRequested || TERMINAL.includes(t.status))
        cancel.push(t.id);
    }
    return { cancel, killed };
  }
}

function approvalView(a: ToolApprovalRow): ToolApprovalView {
  return {
    id: a.id,
    task: a.task,
    machine: a.machine,
    tool: a.tool,
    summary: a.summary,
    category: a.category,
    status: a.status,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    decidedAt: a.decidedAt,
    decidedBy: a.decidedBy,
  };
}

export type { TaskEvent };
