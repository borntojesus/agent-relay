/**
 * End to end: the real relay (HTTP server on 127.0.0.1) and the real worker
 * loop, with a fake `claude` (test/worker-fakes.ts). Console calls go through
 * /owner/*, the worker through /worker/*, the hook through its unix socket.
 */
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http/server.ts";
import { Worker } from "../src/worker/worker.ts";
import { SELF, fakeClaude, shortTmp } from "./worker-fakes.ts";
import { addMachine, world } from "./helpers.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function waitFor<T>(
  fn: () =>
    | Promise<T | undefined | null | false>
    | T
    | undefined
    | null
    | false,
  timeoutMs = 10_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setup(policy: Record<string, unknown> = {}) {
  const dir = realpathSync(shortTmp("are-"));
  const allowed = join(dir, "work");
  const outside = join(dir, "outside");
  mkdirSync(allowed);
  mkdirSync(outside);
  const w = world({ channels: [] });
  const wk = addMachine(w, "mini", "alice", {
    folders: [allowed],
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Bash(git status:*)"],
    requireTap: true,
    approvalActions: ["push", "deploy", "delete", "prod"],
    ...policy,
  });
  const ac = w.agent("alice-console", "alice", "owner:alice:rw");
  const server = createHttpServer(w.relay);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (
    path: string,
    init: { method?: string; json?: unknown } = {},
  ) => {
    const r = await fetch(base + path, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${ac.token}`,
        "Content-Type": "application/json",
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
    const text = await r.text();
    return {
      status: r.status,
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  };

  const logs: string[] = [];
  const worker = new Worker({
    config: {
      server: base,
      machine: "mini",
      token: wk.token,
      claudePath: fakeClaude(dir),
      maxParallel: 1,
    },
    runDir: join(dir, "run"),
    version: "0.5.0-e2e",
    selfCommand: SELF,
    log: (l) => logs.push(l),
    heartbeatMs: 100,
    pollWaitSeconds: 1,
    backoffMinMs: 20,
    backoffMaxMs: 100,
    killGraceMs: 300,
    flushIntervalMs: 50,
    approvalWaitSeconds: 1,
  });
  const running = worker.run();
  cleanup.push(async () => {
    await worker.stop();
    await running;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    w.relay.tasks.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const create = (scenario: Record<string, unknown>, folder = allowed) =>
    call("/owner/tasks", {
      json: { machine: "mini", folder, prompt: JSON.stringify(scenario) },
    });
  const get = async (id: string) => (await call(`/owner/tasks/${id}`)).body;
  const until = (id: string, pred: (t: any) => boolean) =>
    waitFor(async () => {
      const t = await get(id);
      return pred(t) ? t : undefined;
    });
  const final = (id: string) =>
    until(id, (t) => ["done", "failed", "cancelled"].includes(t.status));
  const events = async (id: string) =>
    (await call(`/owner/tasks/${id}/events`)).body.events as Array<{
      type: string;
      actor: string;
      data: any;
    }>;
  const record = () =>
    JSON.parse(readFileSync(join(allowed, ".fake-claude.json"), "utf8")) as {
      argv: string[];
      hook?: { decision: string; reason: string };
    };
  return {
    w,
    call,
    create,
    get,
    until,
    final,
    events,
    record,
    allowed,
    outside,
    logs,
    worker,
  };
}

describe("tasks end to end (real relay, real worker, fake claude)", () => {
  it("requireTap -> start -> claim -> running -> events -> done with result and session", async () => {
    const { call, create, get, final, events, record, logs } = await setup();
    const c = await create({ mode: "ok" });
    expect(c.status).toBe(201);
    expect(c.body.status).toBe("awaiting_tap");
    // Not visible to the worker until Start.
    await new Promise((r) => setTimeout(r, 300));
    expect((await get(c.body.id)).status).toBe("awaiting_tap");
    expect((await call("/owner/me")).body.pendingTasks).toBe(1);

    const s = await call(`/owner/tasks/${c.body.id}/start`, { json: {} });
    expect(s.status).toBe(200);
    const t = await final(c.body.id);
    expect(t).toMatchObject({
      status: "done",
      result: "all done",
      exitCode: 0,
      sessionId: "sess-1",
      error: null,
      pendingApprovals: [],
    });
    expect(t.startedAt).toBeTruthy();
    expect(t.finishedAt).toBeTruthy();

    const ev = await events(c.body.id);
    const types = ev.map((e) => e.type);
    for (const k of [
      "created",
      "accepted",
      "started",
      "progress",
      "finished",
      "status",
    ])
      expect(types).toContain(k);
    expect(types.indexOf("accepted")).toBeLessThan(types.indexOf("started"));
    expect(ev.find((e) => e.type === "progress")!.data).toEqual({
      text: "working on it",
    });
    expect(ev.find((e) => e.type === "accepted")!.actor).toBe("mini-worker");
    const statuses = ev
      .filter((e) => e.type === "status")
      .map((e) => e.data.to);
    expect(statuses).toEqual(["queued", "running", "done"]);
    // Default setting sources keep the user's global settings out.
    const { argv } = record();
    expect(argv).toEqual(
      expect.arrayContaining(["--setting-sources", "project,local"]),
    );
    expect(argv).not.toContain("--resume");

    const machines = (await call("/owner/machines")).body.machines;
    expect(machines[0]).toMatchObject({
      id: "mini",
      online: true,
      workerVersion: "0.5.0-e2e",
    });
    const tokens = (await call("/owner/tokens")).body.tokens;
    expect(tokens.find((x: any) => x.label === "mini-worker").kind).toBe(
      "worker",
    );
    expect(logs.join("\n")).not.toMatch(/Bearer|ar_/);
  });

  it("a push waits for the owner: approve continues, reject denies the tool", async () => {
    const { call, create, until, final, events, record } = await setup({
      requireTap: false,
    });
    const push = {
      mode: "tool",
      tool: { name: "Bash", input: { command: "git push origin main" } },
    };
    const a = (await create(push)).body;
    expect(a.status).toBe("queued");
    const waiting = await until(
      a.id,
      (t) => t.status === "waiting_approval" && t.pendingApprovals.length,
    );
    const ap = waiting.pendingApprovals[0];
    expect(ap).toMatchObject({
      tool: "Bash",
      category: "push",
      summary: "Bash: git push origin main",
      status: "pending",
    });
    expect((await call("/owner/me")).body.pendingTasks).toBe(1);
    const d = await call(`/owner/tasks/${a.id}/approvals/${ap.id}`, {
      json: { decision: "approve" },
    });
    expect(d.status).toBe(200);
    expect(d.body.approval.status).toBe("approved");
    expect(d.body.task.status).toBe("running");
    expect(await final(a.id)).toMatchObject({
      status: "done",
      result: "tool:none",
    });
    const ev = await events(a.id);
    expect(ev.find((e) => e.type === "tool")!.data).toMatchObject({
      name: "Bash",
      category: ["push"],
    });
    expect(ev.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "approval_requested",
        "approval_decided",
        "tool_result",
      ]),
    );

    const b = (await create(push)).body;
    const w2 = await until(b.id, (t) => t.pendingApprovals.length > 0);
    const r = await call(
      `/owner/tasks/${b.id}/approvals/${w2.pendingApprovals[0].id}`,
      { json: { decision: "reject" } },
    );
    expect(r.body.approval.status).toBe("rejected");
    expect(await final(b.id)).toMatchObject({
      status: "done",
      result: "tool:deny:agent-relay: the owner rejected this action",
    });
    expect(record().hook).toMatchObject({ decision: "deny" });
  });

  it("cancel of a running task stops the fake claude and ends cancelled", async () => {
    const { call, create, until, final } = await setup({ requireTap: false });
    const t = (await create({ mode: "sleep", ms: 60_000 })).body;
    await until(t.id, (x) => x.status === "running");
    const c = await call(`/owner/tasks/${t.id}/cancel`, { json: {} });
    expect(c.status).toBe(200);
    expect(c.body.cancelRequested).toBe(true);
    const f = await final(t.id);
    expect(f).toMatchObject({
      status: "cancelled",
      error: "cancelled by the owner",
    });
    expect(f.result).toBeNull();
  });

  it("kill switch stops the running task and the queue", async () => {
    const { call, create, until, final, get, worker } = await setup({
      requireTap: false,
    });
    const t = (await create({ mode: "sleep", ms: 60_000 })).body;
    await until(t.id, (x) => x.status === "running");
    const k = await call("/owner/machines/mini", {
      method: "PATCH",
      json: { killed: true },
    });
    expect(k.status).toBe(200);
    expect(k.body.killed).toBe(true);
    expect(await final(t.id)).toMatchObject({
      status: "cancelled",
      error: "kill switch is on for this machine",
    });
    await waitFor(() => worker.killed);
    // A killed machine refuses new tasks.
    const refused = await create({ mode: "ok" });
    expect(refused.status).toBe(400);
    // Off again: work resumes.
    await call("/owner/machines/mini", {
      method: "PATCH",
      json: { killed: false },
    });
    const next = (await create({ mode: "ok" })).body;
    expect((await final(next.id)).status).toBe("done");
    expect((await get(t.id)).status).toBe("cancelled");
  });

  it("a follow-up resumes the parent's claude session", async () => {
    const { call, create, final, record } = await setup({ requireTap: false });
    const p = (await create({ mode: "ok", session: "sess-parent" })).body;
    expect((await final(p.id)).sessionId).toBe("sess-parent");
    const f = await call(`/owner/tasks/${p.id}/followup`, {
      json: { prompt: JSON.stringify({ mode: "ok", session: "sess-parent" }) },
    });
    expect(f.status).toBe(201);
    expect(f.body).toMatchObject({ parent: p.id, status: "queued" });
    expect((await final(f.body.id)).status).toBe("done");
    const { argv } = record();
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-parent");
  });

  it("refuses a folder outside the allowlist at create, and a symlink escape at the worker", async () => {
    const { create, final, allowed, outside } = await setup({
      requireTap: false,
    });
    const r = await create({ mode: "ok" }, outside);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/folder/);
    const dots = await create({ mode: "ok" }, `${allowed}/../outside`);
    expect(dots.status).toBe(400);

    // Lexically inside the allowlist, really outside: the relay accepts it, the worker's realpath check refuses.
    symlinkSync(outside, join(allowed, "escape"));
    const t = await create({ mode: "ok" }, join(allowed, "escape"));
    expect(t.status).toBe(201);
    expect(await final(t.body.id)).toMatchObject({
      status: "failed",
      error: "folder not allowed",
    });
    expect(existsSync(join(outside, ".fake-claude.json"))).toBe(false);
  });
});
