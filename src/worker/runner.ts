/**
 * One task: check the folder, spawn `claude -p` with the policy, stream
 * progress to the relay, gate tool calls through the PreToolUse hook, stop on
 * cancel / kill switch / max runtime, report the final status.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { categorize, type Category } from "../tasks/categories.ts";
import type {
  ClaimedTask,
  StatusBody,
  TaskEvent,
  WorkerClient,
} from "./client.ts";
import { DEFAULT_SETTING_SOURCES, type WorkerConfig } from "./config.ts";
import {
  startHookServer,
  type HookReply,
  type HookRequest,
  type HookServer,
} from "./hook.ts";
import { StreamParser, type StreamResult } from "./stream.ts";

export type StopReason = "cancel" | "kill" | "timeout" | "shutdown";

export const ALLOWED_MODES = ["default", "acceptEdits", "plan"] as const;

export const RESULT_CAP = 64 * 1024;
const INPUT_CAP = 2048;
const STDERR_TAIL = 2000;
const MAX_EVENTS_PER_CALL = 50;

export interface RunnerDeps {
  client: WorkerClient;
  config: Pick<WorkerConfig, "claudePath" | "oauthToken" | "settingSources">;
  runDir: string;
  /** argv of this binary: [sea binary] or [node, /abs/src/cli.ts]. */
  selfCommand: string[];
  log: (line: string) => void;
  baseEnv?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  flushIntervalMs?: number;
  approvalWaitSeconds?: number;
  /** Length of a policy minute (tests shrink it). */
  minuteMs?: number;
}

/** realpath of `folder` when it sits inside realpath of one of `allowed`, else null. */
export function resolveAllowedFolder(
  folder: string,
  allowed: readonly string[],
): string | null {
  if (typeof folder !== "string" || !isAbsolute(folder)) return null;
  let real: string;
  try {
    real = realpathSync(folder);
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  for (const a of allowed) {
    if (typeof a !== "string" || !isAbsolute(a)) continue;
    let root: string;
    try {
      root = realpathSync(a);
    } catch {
      continue;
    }
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (real === root || real.startsWith(prefix)) return real;
  }
  return null;
}

const KEEP_ENV = ["HOME", "USER", "LANG", "TMPDIR", "SHELL"] as const;

/**
 * Minimal child env. Built from an allowlist, then scrubbed again: no
 * ANTHROPIC_* (API key, auth token, base URL) and no CLAUDE_CODE_* other than
 * the subscription token from worker.json.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  claudePath: string,
  extra: Record<string, string>,
  oauthToken?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of KEEP_ENV) {
    const v = base[k];
    if (typeof v === "string" && v) env[k] = v;
  }
  const path = [
    dirname(claudePath),
    ...(base.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  env.PATH = [...new Set(path.filter(Boolean))].join(delimiter);
  Object.assign(env, extra);
  for (const k of Object.keys(env)) {
    if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_CODE_"))
      delete env[k];
  }
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return env;
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.,:=+-]+$/.test(s)
    ? s
    : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function hookSettings(selfCommand: string[]): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: [...selfCommand, "worker", "hook"]
                .map(shellQuote)
                .join(" "),
              // Longer than the relay's 15 min approval expiry.
              timeout: 1000,
            },
          ],
        },
      ],
    },
  };
}

export function claudeArgs(opts: {
  permissionMode: string;
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  settingsPath: string;
  resumeSessionId?: string | null;
  settingSources?: string;
}): string[] {
  // The prompt goes on stdin: never in argv (ps), never parsed as an option.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.permissionMode,
  ];
  if (opts.allowedTools.length)
    args.push("--allowedTools", ...opts.allowedTools);
  if (opts.disallowedTools.length)
    args.push("--disallowedTools", ...opts.disallowedTools);
  if (opts.settingSources) args.push("--setting-sources", opts.settingSources);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  // Last, so the variadic tool lists above always end at an option.
  args.push("--settings", opts.settingsPath);
  return args;
}

function truncateInput(input: unknown): unknown {
  let s: string;
  try {
    s = JSON.stringify(input) ?? "";
  } catch {
    return "[unserializable]";
  }
  return s.length <= INPUT_CAP ? input : s.slice(0, INPUT_CAP) + "…";
}

function summarize(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick =
    typeof i.command === "string"
      ? i.command
      : typeof i.file_path === "string"
        ? i.file_path
        : typeof i.url === "string"
          ? i.url
          : JSON.stringify(input ?? null);
  const s = `${tool}: ${pick}`;
  return s.length > 500 ? s.slice(0, 500) + "…" : s;
}

function capBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  return Buffer.from(s).subarray(0, max).toString("utf8").replace(/�$/, "");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TaskRun {
  readonly task: ClaimedTask;
  #d: RunnerDeps;
  #child: ChildProcess | null = null;
  #exited = false;
  #stopReason: StopReason | null = null;
  #killTimer: NodeJS.Timeout | null = null;
  #events: TaskEvent[] = [];
  #text = "";
  #flushing: Promise<void> = Promise.resolve();
  #sessionId: string | null = null;
  #result: StreamResult | null = null;
  #stderr = "";

  constructor(task: ClaimedTask, deps: RunnerDeps) {
    this.task = task;
    this.#d = deps;
  }

  get id(): string {
    return this.task.id;
  }

  get stopReason(): StopReason | null {
    return this.#stopReason;
  }

  /** Stop the child: SIGTERM to its process group, SIGKILL after the grace period. First reason wins. */
  stop(reason: StopReason): void {
    if (this.#stopReason) return;
    this.#stopReason = reason;
    this.#d.log(`[task ${this.id}] stopping: ${reason}`);
    const child = this.#child;
    if (!child || this.#exited || child.pid === undefined) return;
    this.#signal("SIGTERM");
    this.#killTimer = setTimeout(() => {
      if (!this.#exited) {
        this.#d.log(`[task ${this.id}] still alive after SIGTERM, SIGKILL`);
        this.#signal("SIGKILL");
      }
    }, this.#d.killGraceMs ?? 5000);
  }

  #signal(sig: NodeJS.Signals): void {
    const pid = this.#child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        this.#child?.kill(sig);
      } catch {
        /* gone */
      }
    }
  }

  #event(type: TaskEvent["type"], data: Record<string, unknown>): void {
    this.#takeText();
    this.#events.push({ type, data });
  }

  /** Turn buffered text into a progress event, so it keeps its place before later events. */
  #takeText(): void {
    if (!this.#text) return;
    this.#events.push({
      type: "progress",
      data: { text: capBytes(this.#text, 7000) },
    });
    this.#text = "";
  }

  /** Send queued events (progress text batched into one event). */
  flush(): Promise<void> {
    this.#flushing = this.#flushing.then(async () => {
      this.#takeText();
      while (this.#events.length) {
        const batch = this.#events.splice(0, MAX_EVENTS_PER_CALL);
        try {
          const r = await this.#d.client.events(this.id, batch);
          if (r.killed) this.stop("kill");
          else if (r.cancel) this.stop("cancel");
        } catch (err) {
          this.#d.log(
            `[task ${this.id}] events not sent: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
    });
    return this.#flushing;
  }

  async #status(body: StatusBody, attempts = 1): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.#d.client.status(this.id, body);
        return true;
      } catch (err) {
        this.#d.log(
          `[task ${this.id}] status ${body.status} not sent: ${err instanceof Error ? err.message : String(err)}`,
        );
        const code = (err as { status?: number }).status;
        if (code !== undefined && code >= 400 && code < 500) return true; // the relay refused it: retrying will not help
        if (i + 1 < attempts) await sleep(Math.min(1000 * 2 ** i, 8000));
      }
    }
    return false;
  }

  async #onHook(req: HookRequest): Promise<HookReply> {
    if (req.task !== this.id)
      return { decision: "deny", reason: "hook for another task" };
    const category = categorize(req.tool, req.input);
    this.#event("tool", {
      name: req.tool,
      input: truncateInput(req.input),
      category,
    });
    const need = category.filter((c: Category) =>
      this.task.policy.approvalActions.includes(c),
    );
    if (!need.length) return { decision: "ok" };
    await this.flush();
    if (this.#stopReason)
      return { decision: "deny", reason: "task is stopping" };
    let approvalId: string;
    try {
      approvalId = await this.#d.client.createToolApproval(this.id, {
        tool: req.tool,
        summary: summarize(req.tool, req.input),
        category: need[0]!,
      });
    } catch (err) {
      return {
        decision: "deny",
        reason: `could not ask the owner (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    this.#d.log(
      `[task ${this.id}] ${req.tool} needs approval (${need.join(", ")}), waiting`,
    );
    for (;;) {
      if (this.#stopReason || this.#exited)
        return { decision: "deny", reason: "task is stopping" };
      let status: string;
      try {
        status = await this.#d.client.toolApprovalStatus(
          approvalId,
          this.#d.approvalWaitSeconds ?? 25,
        );
      } catch (err) {
        return {
          decision: "deny",
          reason: `approval check failed (${err instanceof Error ? err.message : String(err)})`,
        };
      }
      if (status === "approved") return { decision: "ok" };
      if (status === "rejected")
        return { decision: "deny", reason: "the owner rejected this action" };
      if (status === "expired")
        return { decision: "deny", reason: "the approval expired" };
    }
  }

  /** Run to the end and report. Resolves true when the final status reached the relay. */
  async run(): Promise<boolean> {
    const { task } = this;
    const policy = task.policy;
    const t0 = Date.now();
    const cwd = resolveAllowedFolder(task.folder, policy.folders ?? []);
    if (!cwd) {
      this.#d.log(`[task ${this.id}] folder not allowed: ${task.folder}`);
      return this.#status({ status: "failed", error: "folder not allowed" }, 5);
    }
    if (!(ALLOWED_MODES as readonly string[]).includes(policy.permissionMode)) {
      return this.#status(
        {
          status: "failed",
          error: `permission mode not allowed: ${String(policy.permissionMode)}`,
        },
        5,
      );
    }
    if (this.#stopReason) return this.#status(this.#stopStatus(), 5);

    mkdirSync(this.#d.runDir, { recursive: true, mode: 0o700 });
    const socketPath = join(this.#d.runDir, `${this.id}.sock`);
    const settingsPath = join(this.#d.runDir, `${this.id}.settings.json`);
    let hook: HookServer | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    let runtimeTimer: NodeJS.Timeout | null = null;
    let exitCode: number | null = null;
    let spawnError: string | null = null;
    try {
      hook = await startHookServer(socketPath, (req) => this.#onHook(req));
      writeFileSync(
        settingsPath,
        JSON.stringify(hookSettings(this.#d.selfCommand)),
        { mode: 0o600 },
      );
      chmodSync(settingsPath, 0o600);

      const args = claudeArgs({
        permissionMode: policy.permissionMode,
        allowedTools: policy.allowedTools ?? [],
        disallowedTools: policy.disallowedTools ?? [],
        settingsPath,
        resumeSessionId: task.resumeSessionId,
        settingSources:
          this.#d.config.settingSources ?? DEFAULT_SETTING_SOURCES,
      });
      const env = childEnv(
        this.#d.baseEnv ?? process.env,
        this.#d.config.claudePath,
        { RELAY_TASK: this.id, RELAY_HOOK_SOCKET: socketPath },
        this.#d.config.oauthToken,
      );

      const parser = new StreamParser({
        onInit: (init) => {
          this.#sessionId = init.sessionId;
          this.#event("started", {
            pid: this.#child?.pid ?? null,
            claudeVersion: init.claudeVersion ?? null,
            cwd: init.cwd ?? cwd,
          });
          // Chained after the events so 'running' always lands before the final status.
          const sent = this.flush().then(() =>
            this.#status({ status: "running", sessionId: init.sessionId }),
          );
          this.#flushing = sent.then(() => undefined);
        },
        onText: (text) => {
          this.#text += (this.#text ? "\n" : "") + text;
        },
        onToolResult: (_id, name, ok) =>
          this.#event("tool_result", { name, ok }),
        onResult: (r) => {
          this.#result = r;
          if (r.sessionId) this.#sessionId = r.sessionId;
        },
      });

      const child = spawn(this.#d.config.claudePath, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      this.#child = child;
      this.#d.log(
        `[task ${this.id}] claude started (pid ${child.pid ?? "?"}) in ${cwd}`,
      );
      if (this.#stopReason) this.#signal("SIGTERM");
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => parser.push(c));
      child.stderr.on("data", (c: string) => {
        this.#stderr = (this.#stderr + c).slice(-STDERR_TAIL);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(task.prompt);

      flushTimer = setInterval(
        () => void this.flush(),
        this.#d.flushIntervalMs ?? 1000,
      );
      const maxMs =
        Math.max(1, Number(policy.maxRuntimeMinutes) || 30) *
        (this.#d.minuteMs ?? 60_000);
      runtimeTimer = setTimeout(() => this.stop("timeout"), maxMs);

      exitCode = await new Promise<number | null>((resolve) => {
        child.on("error", (err) => {
          spawnError = err.message;
          resolve(null);
        });
        child.on("close", (code) => resolve(code));
      });
      parser.end();
    } catch (err) {
      spawnError = err instanceof Error ? err.message : String(err);
    } finally {
      this.#exited = true;
      if (flushTimer) clearInterval(flushTimer);
      if (runtimeTimer) clearTimeout(runtimeTimer);
      if (this.#killTimer) clearTimeout(this.#killTimer);
      if (hook) await hook.close();
      try {
        if (existsSync(settingsPath)) unlinkSync(settingsPath);
      } catch {
        /* best effort */
      }
    }

    const r = this.#result;
    this.#event("finished", {
      exitCode,
      durationMs: Date.now() - t0,
      ...(r?.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      ...(r?.numTurns !== undefined ? { numTurns: r.numTurns } : {}),
    });
    await this.flush();

    const session = this.#sessionId ? { sessionId: this.#sessionId } : {};
    const code = exitCode === null ? {} : { exitCode };
    let final: StatusBody;
    if (this.#stopReason) {
      final = {
        ...this.#stopStatus(),
        ...session,
        ...code,
        ...(r?.result ? { result: capBytes(r.result, RESULT_CAP) } : {}),
      };
    } else if (spawnError) {
      final = {
        status: "failed",
        error: `cannot run claude: ${spawnError}`,
        ...session,
      };
    } else if (exitCode === 0 && r && !r.isError) {
      final = {
        status: "done",
        result: capBytes(r.result ?? "", RESULT_CAP),
        exitCode: 0,
        ...session,
      };
    } else {
      const why = r?.isError
        ? r.result || r.subtype || "error"
        : `claude exited with code ${exitCode}${r ? "" : " without a result"}`;
      const tail = this.#stderr.trim()
        ? `\n${this.#stderr.trim().slice(-500)}`
        : "";
      final = {
        status: "failed",
        error: capBytes(`${why}${tail}`, 8000),
        ...code,
        ...session,
        ...(r?.result ? { result: capBytes(r.result, RESULT_CAP) } : {}),
      };
    }
    this.#d.log(
      `[task ${this.id}] ${final.status}${final.error ? `: ${final.error.split("\n")[0]}` : ""}`,
    );
    return this.#status(final, 5);
  }

  #stopStatus(): StatusBody {
    switch (this.#stopReason) {
      case "cancel":
        return { status: "cancelled", error: "cancelled by the owner" };
      case "kill":
        return {
          status: "cancelled",
          error: "kill switch is on for this machine",
        };
      case "timeout":
        return {
          status: "failed",
          error: `max runtime of ${this.task.policy.maxRuntimeMinutes} min exceeded`,
        };
      default:
        return { status: "failed", error: "worker stopped" };
    }
  }
}
