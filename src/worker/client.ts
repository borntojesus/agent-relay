/**
 * HTTP client for the relay's Worker API (`/worker/*`). The bearer is only in
 * the Authorization header; errors carry the method, path and status, never
 * the header.
 */

export type PermissionMode = "default" | "acceptEdits" | "plan";

export interface TaskPolicy {
  folders: string[];
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  requireTap?: boolean;
  approvalActions: string[];
  maxRuntimeMinutes: number;
  allowFollowUps?: boolean;
}

export interface ClaimedTask {
  id: string;
  folder: string;
  prompt: string;
  priority: string;
  parent: string | null;
  resumeSessionId: string | null;
  policy: TaskPolicy;
}

export interface TaskEvent {
  type: "started" | "progress" | "tool" | "tool_result" | "log" | "finished";
  data: Record<string, unknown>;
}

export interface StatusBody {
  status: "running" | "done" | "failed" | "cancelled";
  sessionId?: string;
  result?: string;
  exitCode?: number;
  error?: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export class HttpStatusError extends Error {
  status: number;
  constructor(method: string, path: string, status: number, detail: string) {
    super(`${method} ${path} -> ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
  }
}

export interface ClientOptions {
  server: string;
  token: string;
  version: string;
  fetch?: typeof fetch;
}

/** Long-polls get this much extra over `wait` before the client gives up. */
const POLL_SLACK_MS = 10_000;
const CALL_TIMEOUT_MS = 20_000;

export class WorkerClient {
  #server: string;
  #token: string;
  #version: string;
  #fetch: typeof fetch;

  constructor(opts: ClientOptions) {
    this.#server = opts.server.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#version = opts.version;
    this.#fetch = opts.fetch ?? fetch;
  }

  async #call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = CALL_TIMEOUT_MS,
    abort?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.#fetch(this.#server + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "X-Worker-Version": this.#version,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: abort
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), abort])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(
        `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    if (res.status === 204) return { status: 204, json: null };
    if (!res.ok) {
      let detail = "";
      try {
        const j = JSON.parse(text) as { error?: unknown };
        if (typeof j.error === "string") detail = j.error.slice(0, 200);
      } catch {
        /* not JSON */
      }
      throw new HttpStatusError(method, path, res.status, detail);
    }
    try {
      return { status: res.status, json: text ? JSON.parse(text) : null };
    } catch {
      throw new Error(`${method} ${path}: response is not JSON`);
    }
  }

  /** Claim the next task, or null after `wait` seconds (or when the machine is killed). */
  async next(
    waitSeconds = 25,
    abort?: AbortSignal,
  ): Promise<ClaimedTask | null> {
    const r = await this.#call(
      "GET",
      `/worker/next?wait=${waitSeconds}`,
      undefined,
      waitSeconds * 1000 + POLL_SLACK_MS,
      abort,
    );
    if (r.status === 204 || !r.json) return null;
    const task = (r.json as { task?: ClaimedTask }).task;
    return task ?? null;
  }

  async events(
    taskId: string,
    events: TaskEvent[],
  ): Promise<{ cancel: boolean; killed: boolean }> {
    const r = await this.#call(
      "POST",
      `/worker/tasks/${encodeURIComponent(taskId)}/events`,
      { events },
    );
    const j = (r.json ?? {}) as { cancel?: unknown; killed?: unknown };
    return { cancel: j.cancel === true, killed: j.killed === true };
  }

  async status(taskId: string, body: StatusBody): Promise<void> {
    await this.#call(
      "POST",
      `/worker/tasks/${encodeURIComponent(taskId)}/status`,
      body,
    );
  }

  async createToolApproval(
    taskId: string,
    body: { tool: string; summary: string; category: string },
  ): Promise<string> {
    const r = await this.#call(
      "POST",
      `/worker/tasks/${encodeURIComponent(taskId)}/tool-approvals`,
      body,
    );
    const id = (r.json as { id?: unknown } | null)?.id;
    if (typeof id !== "string")
      throw new Error("tool-approvals: no id in the response");
    return id;
  }

  async toolApprovalStatus(
    id: string,
    waitSeconds = 25,
  ): Promise<ApprovalStatus> {
    const r = await this.#call(
      "GET",
      `/worker/tool-approvals/${encodeURIComponent(id)}?wait=${waitSeconds}`,
      undefined,
      waitSeconds * 1000 + POLL_SLACK_MS,
    );
    const s = (r.json as { status?: unknown } | null)?.status;
    if (
      s === "pending" ||
      s === "approved" ||
      s === "rejected" ||
      s === "expired"
    )
      return s;
    throw new Error("tool-approvals: unknown status in the response");
  }

  async heartbeat(
    running: string[],
  ): Promise<{ cancel: string[]; killed: boolean }> {
    const r = await this.#call("POST", "/worker/heartbeat", { running });
    const j = (r.json ?? {}) as { cancel?: unknown; killed?: unknown };
    return {
      cancel: Array.isArray(j.cancel)
        ? j.cancel.filter((x): x is string => typeof x === "string")
        : [],
      killed: j.killed === true,
    };
  }
}

