/**
 * `agent-relay worker run`: the loop launchd keeps alive. Long-polls the relay
 * for tasks of this machine, runs at most maxParallel at once, heartbeats
 * every 15 s, reconnects with backoff, and on startup reports tasks left over
 * from a previous process (run/state.json) as failed "worker restarted".
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HttpStatusError, WorkerClient } from "./client.ts";
import type { WorkerConfig } from "./config.ts";
import { TaskRun, type RunnerDeps } from "./runner.ts";

export interface WorkerOptions {
  config: WorkerConfig;
  runDir: string;
  version: string;
  selfCommand: string[];
  log?: (line: string) => void;
  fetch?: typeof fetch;
  baseEnv?: NodeJS.ProcessEnv;
  heartbeatMs?: number;
  pollWaitSeconds?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  killGraceMs?: number;
  flushIntervalMs?: number;
  approvalWaitSeconds?: number;
  minuteMs?: number;
}

interface StateFile {
  tasks: Array<{ id: string; since: string }>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const msg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export class Worker {
  readonly client: WorkerClient;
  #o: WorkerOptions;
  #log: (line: string) => void;
  #runs = new Map<string, TaskRun>();
  #done = new Map<string, Promise<void>>();
  #stopped = false;
  #abort = new AbortController();
  #heartbeat: NodeJS.Timeout | null = null;
  #slotFree: (() => void) | null = null;
  #statePath: string;
  #recover: string[] = [];
  #killed = false;

  constructor(opts: WorkerOptions) {
    this.#o = opts;
    this.#log =
      opts.log ??
      ((line) => console.log(`${new Date().toISOString()} ${line}`));
    this.#statePath = join(opts.runDir, "state.json");
    this.client = new WorkerClient({
      server: opts.config.server,
      token: opts.config.token,
      version: opts.version,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  get running(): string[] {
    return [...this.#runs.keys()];
  }

  get killed(): boolean {
    return this.#killed;
  }

  #readState(): StateFile {
    try {
      const raw = JSON.parse(
        readFileSync(this.#statePath, "utf8"),
      ) as Partial<StateFile>;
      return {
        tasks: Array.isArray(raw.tasks)
          ? raw.tasks.filter((t) => t && typeof t.id === "string")
          : [],
      };
    } catch {
      return { tasks: [] };
    }
  }

  #writeState(): void {
    const ids = new Set([...this.#runs.keys(), ...this.#recover]);
    const prev = new Map(this.#readState().tasks.map((t) => [t.id, t.since]));
    const state: StateFile = {
      tasks: [...ids].map((id) => ({
        id,
        since: prev.get(id) ?? new Date().toISOString(),
      })),
    };
    const tmp = `${this.#statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#statePath);
  }

  /** Clean the run directory and queue left-over tasks for a "worker restarted" report. */
  #prepare(): void {
    mkdirSync(this.#o.runDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#o.runDir, 0o700);
    this.#recover = this.#readState().tasks.map((t) => t.id);
    for (const f of readdirSync(this.#o.runDir)) {
      if (
        f.endsWith(".sock") ||
        f.endsWith(".settings.json") ||
        f.endsWith(".tmp")
      ) {
        try {
          unlinkSync(join(this.#o.runDir, f));
        } catch {
          /* best effort */
        }
      }
    }
  }

  async #reportRecovered(): Promise<void> {
    for (const id of [...this.#recover]) {
      try {
        await this.client.status(id, {
          status: "failed",
          error: "worker restarted",
        });
        this.#log(`[worker] reported ${id} failed: worker restarted`);
      } catch (err) {
        if (
          !(
            err instanceof HttpStatusError &&
            err.status >= 400 &&
            err.status < 500
          )
        ) {
          this.#log(`[worker] cannot report ${id} yet: ${msg(err)}`);
          throw err;
        }
        this.#log(
          `[worker] relay refused the restart report for ${id} (${err.status}); dropping it`,
        );
      }
      this.#recover = this.#recover.filter((x) => x !== id);
      this.#writeState();
    }
  }

  async #beat(): Promise<void> {
    try {
      const r = await this.client.heartbeat(this.running);
      this.#killed = r.killed;
      if (r.killed) for (const run of this.#runs.values()) run.stop("kill");
      for (const id of r.cancel) this.#runs.get(id)?.stop("cancel");
    } catch (err) {
      this.#log(`[worker] heartbeat failed: ${msg(err)}`);
    }
  }

  #start(task: NonNullable<Awaited<ReturnType<WorkerClient["next"]>>>): void {
    const deps: RunnerDeps = {
      client: this.client,
      config: this.#o.config,
      runDir: this.#o.runDir,
      selfCommand: this.#o.selfCommand,
      log: this.#log,
      ...(this.#o.baseEnv ? { baseEnv: this.#o.baseEnv } : {}),
      ...(this.#o.killGraceMs !== undefined
        ? { killGraceMs: this.#o.killGraceMs }
        : {}),
      ...(this.#o.flushIntervalMs !== undefined
        ? { flushIntervalMs: this.#o.flushIntervalMs }
        : {}),
      ...(this.#o.approvalWaitSeconds !== undefined
        ? { approvalWaitSeconds: this.#o.approvalWaitSeconds }
        : {}),
      ...(this.#o.minuteMs !== undefined ? { minuteMs: this.#o.minuteMs } : {}),
    };
    const run = new TaskRun(task, deps);
    this.#runs.set(task.id, run);
    this.#writeState();
    this.#log(
      `[worker] claimed ${task.id} (${task.priority}) in ${task.folder}`,
    );
    const done = run
      .run()
      .catch((err: unknown) => {
        this.#log(`[task ${task.id}] crashed: ${msg(err)}`);
        return false;
      })
      .then((reported) => {
        this.#runs.delete(task.id);
        this.#done.delete(task.id);
        // Not reported: keep it so the next start (or the next loop) says "worker restarted".
        if (!reported) this.#recover.push(task.id);
        this.#writeState();
        this.#slotFree?.();
      });
    this.#done.set(task.id, done);
  }

  /** Run until stop(). */
  async run(): Promise<void> {
    this.#prepare();
    const hbMs = this.#o.heartbeatMs ?? 15_000;
    this.#heartbeat = setInterval(() => void this.#beat(), hbMs);
    const min = this.#o.backoffMinMs ?? 1000;
    const max = this.#o.backoffMaxMs ?? 60_000;
    let backoff = min;
    this.#log(
      `[worker] ${this.#o.version} machine ${this.#o.config.machine} -> ${this.#o.config.server}`,
    );
    await this.#beat();
    while (!this.#stopped) {
      try {
        if (this.#recover.length) await this.#reportRecovered();
        if (this.#runs.size >= this.#o.config.maxParallel) {
          await new Promise<void>((resolve) => {
            this.#slotFree = resolve;
          });
          this.#slotFree = null;
          continue;
        }
        const t0 = Date.now();
        const task = await this.client.next(
          this.#o.pollWaitSeconds ?? 25,
          this.#abort.signal,
        );
        backoff = min;
        if (this.#stopped) {
          // Claimed while stopping: hand it back as failed so it does not hang in 'accepted'.
          if (task)
            await this.client
              .status(task.id, { status: "failed", error: "worker stopped" })
              .catch(() => {});
          break;
        }
        if (task) this.#start(task);
        else if (Date.now() - t0 < 1000)
          await sleep(this.#killed ? hbMs : 2000, this.#abort.signal);
      } catch (err) {
        if (this.#stopped) break;
        this.#log(
          `[worker] relay unreachable: ${msg(err)}; retry in ${Math.round(backoff / 1000)} s`,
        );
        await sleep(backoff, this.#abort.signal);
        backoff = Math.min(backoff * 2, max);
      }
    }
  }

  /** Stop polling, stop running tasks (reported "worker stopped"), wait for them. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abort.abort();
    this.#slotFree?.();
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    for (const run of this.#runs.values()) run.stop("shutdown");
    await Promise.all(this.#done.values());
  }
}

export function stateTasks(runDir: string): string[] {
  const p = join(runDir, "state.json");
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<StateFile>;
    return Array.isArray(raw.tasks) ? raw.tasks.map((t) => t.id) : [];
  } catch {
    return [];
  }
}
