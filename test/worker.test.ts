import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../src/worker/config.ts";
import { Worker } from "../src/worker/worker.ts";
import {
  FakeRelay,
  SELF,
  TOKEN,
  fakeClaude,
  shortTmp,
  task,
} from "./worker-fakes.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(
  opts: {
    minuteMs?: number;
    baseEnv?: NodeJS.ProcessEnv;
    oauthToken?: string;
  } = {},
) {
  const relay = await new FakeRelay().start();
  const dir = shortTmp();
  const folder = join(dir, "work");
  mkdirSync(folder);
  const runDir = join(dir, "run");
  const config: WorkerConfig = {
    server: relay.base,
    machine: "web-app",
    token: TOKEN,
    claudePath: fakeClaude(dir),
    maxParallel: 1,
    ...(opts.oauthToken ? { oauthToken: opts.oauthToken } : {}),
  };
  const logs: string[] = [];
  const make = () =>
    new Worker({
      config,
      runDir,
      version: "0.5.0-test",
      selfCommand: SELF,
      log: (l) => logs.push(l),
      heartbeatMs: 100,
      pollWaitSeconds: 1,
      backoffMinMs: 20,
      backoffMaxMs: 100,
      killGraceMs: 300,
      flushIntervalMs: 50,
      approvalWaitSeconds: 1,
      ...(opts.minuteMs ? { minuteMs: opts.minuteMs } : {}),
      ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}),
    });
  const worker = make();
  const running = worker.run();
  cleanup.push(async () => {
    await worker.stop();
    await running;
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const record = () =>
    JSON.parse(readFileSync(join(folder, ".fake-claude.json"), "utf8")) as {
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      prompt: string;
      settingsMode?: string;
      hook?: {
        decision: string;
        reason: string;
        status: number;
        stderr: string;
      };
    };
  const final = (id: string) =>
    relay.waitFor(() =>
      relay.statuses.find((s) => s.task === id && s.status !== "running"),
    );
  return { relay, dir, folder, runDir, worker, logs, record, final, make };
}

describe("worker", () => {
  it("runs a task: started, progress, running with session, finished, done", async () => {
    const { relay, folder, record, final, logs } = await setup();
    relay.enqueue(task("tk_ok", folder, { mode: "ok" }));
    const done = await final("tk_ok");
    expect(done).toMatchObject({
      status: "done",
      result: "all done",
      exitCode: 0,
      sessionId: "sess-1",
    });
    expect(relay.statuses.map((s) => s.status)).toEqual(["running", "done"]);
    expect(relay.statuses[0]).toMatchObject({ sessionId: "sess-1" });
    const types = relay.events.map((e) => e.type);
    expect(types).toContain("started");
    expect(types).toContain("progress");
    expect(types.at(-1)).toBe("finished");
    expect(relay.events.find((e) => e.type === "started")!.data).toMatchObject({
      claudeVersion: "9.9.9-fake",
    });
    expect(relay.events.find((e) => e.type === "progress")!.data).toEqual({
      text: "working on it",
    });
    expect(relay.events.find((e) => e.type === "finished")!.data).toMatchObject(
      { exitCode: 0, costUsd: 0.01, numTurns: 2 },
    );
    expect([...relay.versions]).toEqual(["0.5.0-test"]);
    // Never logs the token.
    expect(logs.join("\n")).not.toContain(TOKEN);
    const r = record();
    expect(r.prompt).toBe(JSON.stringify({ mode: "ok" }));
    expect(r.argv).not.toContain(r.prompt);
  });

  it("passes the policy as flags and never bypasses permissions", async () => {
    const { relay, folder, record, final } = await setup();
    relay.enqueue(
      task(
        "tk_args",
        folder,
        { mode: "ok" },
        {},
        { resumeSessionId: "sess-old" },
      ),
    );
    await final("tk_args");
    const { argv } = record();
    expect(argv.slice(0, 6)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--allowedTools",
        "Read",
        "Bash(git status:*)",
        "--disallowedTools",
        "WebFetch",
        "--resume",
        "sess-old",
        "--setting-sources",
        "project,local",
      ]),
    );
    expect(argv.at(-2)).toBe("--settings");
    expect(argv.join(" ")).not.toMatch(/dangerously|bypassPermissions/);
  });

  it("gives the child a minimal env without API keys or the relay token", async () => {
    const baseEnv = {
      HOME: "/Users/alice",
      USER: "alice",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp/",
      ANTHROPIC_API_KEY: "sk-ant-nope",
      ANTHROPIC_AUTH_TOKEN: "nope",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "from-parent-env",
      SECRET_THING: "x",
    };
    const { relay, folder, record, final } = await setup({
      baseEnv,
      oauthToken: "oat-from-config",
    });
    relay.enqueue(task("tk_env", folder, { mode: "ok" }));
    await final("tk_env");
    const { env } = record();
    const names = Object.keys(env).filter(
      (k) => !k.startsWith("__CF") && k !== "PWD" && k !== "SHLVL" && k !== "_",
    );
    expect(names.sort()).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "HOME",
      "LANG",
      "PATH",
      "RELAY_HOOK_SOCKET",
      "RELAY_TASK",
      "TMPDIR",
      "USER",
    ]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-from-config");
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it("refuses a folder outside policy.folders, including through a symlink", async () => {
    const { relay, dir, folder, final } = await setup();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    relay.enqueue(
      task("tk_out", outside, { mode: "ok" }, { folders: [folder] }),
    );
    expect(await final("tk_out")).toMatchObject({
      status: "failed",
      error: "folder not allowed",
    });
    // A symlink inside the allowed folder that points outside.
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(folder, "escape"));
    relay.enqueue(
      task(
        "tk_link",
        join(folder, "escape"),
        { mode: "ok" },
        { folders: [folder] },
      ),
    );
    expect(await final("tk_link")).toMatchObject({
      status: "failed",
      error: "folder not allowed",
    });
    expect(existsSync(join(outside, ".fake-claude.json"))).toBe(false);
  });

  it("reports a failing claude as failed with the error and stderr tail", async () => {
    const { relay, folder, final } = await setup();
    relay.enqueue(task("tk_fail", folder, { mode: "fail" }));
    const f = await final("tk_fail");
    expect(f).toMatchObject({ status: "failed", exitCode: 1 });
    expect(f.error).toContain("it broke");
    expect(f.error).toContain("boom on stderr");
  });

  it("lets a harmless tool through without an approval and reports the tool event", async () => {
    const { relay, folder, record, final } = await setup();
    relay.enqueue(
      task("tk_read", folder, {
        mode: "tool",
        tool: { name: "Read", input: { file_path: "/x/a.ts" } },
      }),
    );
    expect(await final("tk_read")).toMatchObject({
      status: "done",
      result: "tool:none",
    });
    expect(relay.approvals.size).toBe(0);
    expect(relay.events.find((e) => e.type === "tool")!.data).toEqual({
      name: "Read",
      input: { file_path: "/x/a.ts" },
      category: [],
    });
    expect(relay.events.find((e) => e.type === "tool_result")!.data).toEqual({
      name: "Read",
      ok: true,
    });
    expect(record().settingsMode).toBe("600");
  });

  it("holds a git push for the owner: approved passes, rejected denies", async () => {
    const { relay, folder, record, final } = await setup();
    const push = {
      mode: "tool",
      tool: { name: "Bash", input: { command: "git push origin main" } },
    };
    relay.enqueue(task("tk_push1", folder, push));
    const a = await relay.waitFor(() =>
      [...relay.approvals.values()].find((x) => x.task === "tk_push1"),
    );
    expect(a).toMatchObject({
      tool: "Bash",
      category: "push",
      summary: "Bash: git push origin main",
    });
    await new Promise((r) => setTimeout(r, 300)); // still blocked
    expect(relay.statusOf("tk_push1")).toBe("running");
    relay.decide(a.id, "approved");
    expect(await final("tk_push1")).toMatchObject({
      status: "done",
      result: "tool:none",
    });
    expect(
      relay.events.find((e) => e.task === "tk_push1" && e.type === "tool")!
        .data,
    ).toMatchObject({ category: ["push"] });

    relay.enqueue(task("tk_push2", folder, push));
    const b = await relay.waitFor(() =>
      [...relay.approvals.values()].find((x) => x.task === "tk_push2"),
    );
    relay.decide(b.id, "rejected");
    const f = await final("tk_push2");
    expect(f.result).toBe(
      "tool:deny:agent-relay: the owner rejected this action",
    );
    expect(record().hook).toMatchObject({ decision: "deny", status: 0 });
  });

  it("denies when the approval expires or the relay cannot take it (fail closed)", async () => {
    const { relay, folder, final } = await setup();
    const rm = {
      mode: "tool",
      tool: { name: "Bash", input: { command: "rm -rf build" } },
    };
    relay.enqueue(task("tk_exp", folder, rm));
    const a = await relay.waitFor(() =>
      [...relay.approvals.values()].find((x) => x.task === "tk_exp"),
    );
    relay.decide(a.id, "expired");
    expect((await final("tk_exp")).result).toBe(
      "tool:deny:agent-relay: the approval expired",
    );

    relay.failApprovals = true;
    relay.enqueue(task("tk_503", folder, rm));
    expect((await final("tk_503")).result).toMatch(
      /^tool:deny:agent-relay: could not ask the owner/,
    );
  });

  it("skips the approval for a category the policy does not gate", async () => {
    const { relay, folder, final } = await setup();
    relay.enqueue(
      task(
        "tk_free",
        folder,
        {
          mode: "tool",
          tool: { name: "Bash", input: { command: "git push" } },
        },
        { approvalActions: ["deploy"] },
      ),
    );
    expect(await final("tk_free")).toMatchObject({
      status: "done",
      result: "tool:none",
    });
    expect(relay.approvals.size).toBe(0);
  });

  it("cancels on request: SIGTERM, reported cancelled", async () => {
    const { relay, folder, final } = await setup();
    relay.enqueue(task("tk_cancel", folder, { mode: "sleep", ms: 30_000 }));
    await relay.waitFor(() => relay.statusOf("tk_cancel") === "running");
    relay.cancel.add("tk_cancel");
    const t0 = Date.now();
    expect(await final("tk_cancel")).toMatchObject({
      status: "cancelled",
      error: "cancelled by the owner",
      sessionId: "sess-1",
    });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("SIGKILLs a child that ignores SIGTERM after the grace period", async () => {
    const { relay, folder, final, logs } = await setup();
    relay.enqueue(task("tk_stub", folder, { mode: "stubborn", ms: 30_000 }));
    await relay.waitFor(() => relay.statusOf("tk_stub") === "running");
    relay.cancel.add("tk_stub");
    expect(await final("tk_stub")).toMatchObject({ status: "cancelled" });
    expect(logs.join("\n")).toContain("SIGKILL");
  });

  it("stops everything on the kill switch", async () => {
    const { relay, folder, final } = await setup();
    relay.enqueue(task("tk_kill", folder, { mode: "sleep", ms: 30_000 }));
    await relay.waitFor(() => relay.statusOf("tk_kill") === "running");
    relay.killed = true;
    expect(await final("tk_kill")).toMatchObject({
      status: "cancelled",
      error: "kill switch is on for this machine",
    });
  });

  it("fails a task past maxRuntimeMinutes", async () => {
    const { relay, folder, final } = await setup({ minuteMs: 300 });
    relay.enqueue(
      task(
        "tk_slow",
        folder,
        { mode: "sleep", ms: 30_000 },
        { maxRuntimeMinutes: 1 },
      ),
    );
    expect(await final("tk_slow")).toMatchObject({
      status: "failed",
      error: "max runtime of 1 min exceeded",
    });
  });

  it("cleans up the hook socket and the settings file", async () => {
    const { relay, folder, runDir, final } = await setup();
    relay.enqueue(task("tk_clean", folder, { mode: "ok" }));
    await final("tk_clean");
    await relay.waitFor(
      () => !readdirSync(runDir).some((f) => f.startsWith("tk_clean")),
    );
    expect((statSync(runDir).mode & 0o777).toString(8)).toBe("700");
    const state = JSON.parse(
      readFileSync(join(runDir, "state.json"), "utf8"),
    ) as { tasks: unknown[] };
    expect(state.tasks).toEqual([]);
  });

  it("runs one task at a time", async () => {
    const { relay, folder, final } = await setup();
    relay.enqueue(task("tk_a", folder, { mode: "sleep", ms: 400 }));
    relay.enqueue(task("tk_b", folder, { mode: "ok" }));
    await relay.waitFor(() => relay.statusOf("tk_a") === "running");
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.queue.map((t) => t.id)).toEqual(["tk_b"]);
    await final("tk_a");
    await final("tk_b");
  });
});

describe("worker restart and reconnect", () => {
  it('reports tasks left in state.json as failed "worker restarted"', async () => {
    const relay = await new FakeRelay().start();
    const dir = shortTmp();
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        tasks: [
          { id: "tk_old", since: "x" },
          { id: "tk_gone", since: "x" },
        ],
      }),
    );
    writeFileSync(join(runDir, "tk_old.sock"), "");
    const worker = new Worker({
      config: {
        server: relay.base,
        machine: "web-app",
        token: TOKEN,
        claudePath: "/bin/false",
        maxParallel: 1,
      },
      runDir,
      version: "t",
      selfCommand: SELF,
      log: () => {},
      heartbeatMs: 100,
      pollWaitSeconds: 1,
    });
    const running = worker.run();
    try {
      await relay.waitFor(() =>
        relay.statuses.find((s) => s.task === "tk_old"),
      );
      expect(relay.statuses).toEqual([
        { task: "tk_old", status: "failed", error: "worker restarted" },
      ]);
      await relay.waitFor(
        () =>
          (
            JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as {
              tasks: unknown[];
            }
          ).tasks.length === 0,
      );
      expect(existsSync(join(runDir, "tk_old.sock"))).toBe(false);
    } finally {
      await worker.stop();
      await running;
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a relay outage and picks up work when it is back", async () => {
    const { relay, folder, final, logs } = await setup();
    relay.down = true;
    await relay.waitFor(
      () => logs.filter((l) => l.includes("relay unreachable")).length >= 2,
    );
    relay.down = false;
    relay.enqueue(task("tk_after", folder, { mode: "ok" }));
    expect(await final("tk_after")).toMatchObject({ status: "done" });
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("heartbeats with the running task ids", async () => {
    const { relay, folder, final } = await setup();
    relay.enqueue(task("tk_hb", folder, { mode: "sleep", ms: 500 }));
    await relay.waitFor(() =>
      relay.heartbeats.some((h) => h.includes("tk_hb")),
    );
    await final("tk_hb");
  });
});
