/**
 * Offline fakes for the worker tests: a relay implementing the Worker API of
 * the 0.5.0 contract, and a `claude` stand-in that speaks stream-json.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { ClaimedTask, TaskPolicy } from "../src/worker/client.ts";

export const TOKEN = "wk_test_secret_token";
export const CLI = resolve(import.meta.dirname, "../src/cli.ts");
export const SELF = [process.execPath, CLI];

/** Short dir under /tmp: unix socket paths are limited to 104 bytes on macOS. */
export const shortTmp = (prefix = "arw-") => mkdtempSync(join("/tmp", prefix));

export function policy(over: Partial<TaskPolicy> = {}): TaskPolicy {
  return {
    folders: [],
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Bash(git status:*)"],
    disallowedTools: ["WebFetch"],
    requireTap: false,
    approvalActions: ["push", "deploy", "delete", "prod"],
    maxRuntimeMinutes: 30,
    allowFollowUps: true,
    ...over,
  };
}

export interface Approval {
  id: string;
  task: string;
  tool: string;
  summary: string;
  category: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

type Waiter = () => void;

export class FakeRelay {
  server: Server;
  base = "";
  queue: ClaimedTask[] = [];
  events: Array<{ task: string; type: string; data: Record<string, unknown> }> =
    [];
  statuses: Array<{
    task: string;
    status: string;
    sessionId?: string;
    result?: string;
    exitCode?: number;
    error?: string;
  }> = [];
  approvals = new Map<string, Approval>();
  cancel = new Set<string>();
  killed = false;
  heartbeats: string[][] = [];
  versions = new Set<string>();
  /** Respond 500 to everything while true. */
  down = false;
  failApprovals = false;
  #waiters: Waiter[] = [];
  #n = 0;

  constructor() {
    this.server = createServer((req, res) => void this.#handle(req, res));
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    for (const w of this.#waiters.splice(0)) w();
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  enqueue(task: ClaimedTask): void {
    this.queue.push(task);
    this.#wake();
  }

  decide(id: string, status: Approval["status"]): void {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`no approval ${id}`);
    a.status = status;
    this.#wake();
  }

  statusOf(task: string): string | undefined {
    return this.statuses.filter((s) => s.task === task).at(-1)?.status;
  }

  async waitFor<T>(
    fn: () => T | undefined | null | false,
    timeoutMs = 8000,
  ): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  #wake(): void {
    for (const w of this.#waiters.splice(0)) w();
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const w = () => {
        clearTimeout(t);
        resolve();
      };
      function done() {
        resolve();
      }
      this.#waiters.push(w);
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body?: unknown) => {
      res.writeHead(
        code,
        body === undefined ? {} : { "Content-Type": "application/json" },
      );
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return send(401, { error: "unauthorized" });
    const v = req.headers["x-worker-version"];
    if (typeof v === "string") this.versions.add(v);
    if (this.down) return send(500, { error: "down" });
    const url = new URL(req.url ?? "/", "http://x");
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >)
        : {};
    }
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if (req.method === "GET" && p === "/worker/next") {
      const deadline =
        Date.now() + Number(url.searchParams.get("wait") ?? 0) * 1000;
      for (;;) {
        if (this.killed) return send(204);
        const task = this.queue.shift();
        if (task) return send(200, { task });
        if (Date.now() >= deadline || !this.server.listening) return send(204);
        await this.#wait(deadline - Date.now());
      }
    }
    if (
      req.method === "POST" &&
      (m = /^\/worker\/tasks\/([^/]+)\/events$/.exec(p))
    ) {
      const task = decodeURIComponent(m[1]!);
      for (const e of (body.events as Array<{
        type: string;
        data: Record<string, unknown>;
      }>) ?? [])
        this.events.push({ task, ...e });
      return send(200, { cancel: this.cancel.has(task), killed: this.killed });
    }
    if (
      req.method === "POST" &&
      (m = /^\/worker\/tasks\/([^/]+)\/status$/.exec(p))
    ) {
      const task = decodeURIComponent(m[1]!);
      if (task === "tk_gone") return send(404, { error: "not found" });
      this.statuses.push({ task, ...(body as { status: string }) });
      return send(200, { ok: true });
    }
    if (
      req.method === "POST" &&
      (m = /^\/worker\/tasks\/([^/]+)\/tool-approvals$/.exec(p))
    ) {
      if (this.failApprovals) return send(503, { error: "unavailable" });
      const id = `ta_${++this.#n}`;
      this.approvals.set(id, {
        id,
        task: decodeURIComponent(m[1]!),
        tool: String(body.tool),
        summary: String(body.summary),
        category: String(body.category),
        status: "pending",
      });
      this.#wake();
      return send(200, { id });
    }
    if (
      req.method === "GET" &&
      (m = /^\/worker\/tool-approvals\/([^/]+)$/.exec(p))
    ) {
      const a = this.approvals.get(decodeURIComponent(m[1]!));
      if (!a) return send(404, { error: "not found" });
      const deadline =
        Date.now() + Number(url.searchParams.get("wait") ?? 0) * 1000;
      while (
        a.status === "pending" &&
        Date.now() < deadline &&
        this.server.listening
      )
        await this.#wait(deadline - Date.now());
      return send(200, { status: a.status });
    }
    if (req.method === "POST" && p === "/worker/heartbeat") {
      const running = (body.running as string[]) ?? [];
      this.heartbeats.push(running);
      return send(200, {
        cancel: running.filter((id) => this.cancel.has(id)),
        killed: this.killed,
      });
    }
    return send(404, { error: "not found" });
  }
}

/**
 * A fake `claude`. The scenario comes as JSON on stdin (the prompt):
 *   { mode: 'ok' | 'fail' | 'sleep' | 'stubborn' | 'tool', ms?, tool?: { name, input } }
 * It writes its argv, env and hook outcome to <cwd>/.fake-claude.json.
 */
export function fakeClaude(dir: string): string {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const sc = JSON.parse(input || '{}');
  const record = { argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), prompt: input };
  const save = () => fs.writeFileSync('.fake-claude.json', JSON.stringify(record));
  save();
  const sid = sc.session || 'sess-1';
  out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), claude_code_version: '9.9.9-fake' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } });
  if (sc.mode === 'stubborn') process.on('SIGTERM', () => {});
  // stdout to a pipe is asynchronous on macOS: exit only after the result line is flushed,
  // or process.exit() can drop it (the worker then sees no result: a flaky 'failed').
  let finished = false;
  const finish = (text, isError, code) => {
    if (finished) return;
    finished = true;
    const line = JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: !!isError, result: text, total_cost_usd: 0.01, num_turns: 2, duration_ms: 5, session_id: sid }) + '\\n';
    process.stdout.write(line, () => process.exit(code || 0));
  };
  if (sc.mode === 'sleep' || sc.mode === 'stubborn') { setTimeout(() => finish('woke up'), sc.ms || 60000); return; }
  if (sc.mode === 'fail') { process.stderr.write('boom on stderr\\n', () => finish('it broke', true, 1)); return; }
  if (sc.mode === 'tool') {
    const i = process.argv.indexOf('--settings');
    const settings = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
    record.settingsMode = (fs.statSync(process.argv[i + 1]).mode & 0o777).toString(8);
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: sc.tool.name, input: sc.tool.input }] } });
    const r = spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: sc.tool.name, tool_input: sc.tool.input, tool_use_id: 'tu_1' }), encoding: 'utf8' });
    let decision = 'none', reason = '';
    if (r.stdout.trim()) { const o = JSON.parse(r.stdout); decision = o.hookSpecificOutput.permissionDecision; reason = o.hookSpecificOutput.permissionDecisionReason; }
    if (r.status !== 0) decision = 'error:' + r.status;
    record.hook = { decision, reason, status: r.status, stderr: r.stderr };
    save();
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: decision !== 'none' }] } });
    finish('tool:' + decision + (reason ? ':' + reason : ''));
  }
  finish('all done');
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

export function task(
  id: string,
  folder: string,
  scenario: Record<string, unknown>,
  pol: Partial<TaskPolicy> = {},
  extra: Partial<ClaimedTask> = {},
): ClaimedTask {
  return {
    id,
    folder,
    prompt: JSON.stringify(scenario),
    priority: "normal",
    parent: null,
    resumeSessionId: null,
    policy: policy({ folders: [folder], ...pol }),
    ...extra,
  };
}
