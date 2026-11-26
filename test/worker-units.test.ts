import {
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  redactConfig,
  validateConfig,
  writeConfig,
} from "../src/worker/config.ts";
import { runHook, startHookServer } from "../src/worker/hook.ts";
import {
  childEnv,
  claudeArgs,
  hookSettings,
  resolveAllowedFolder,
  shellQuote,
} from "../src/worker/runner.ts";
import { StreamParser } from "../src/worker/stream.ts";
import { shortTmp } from "./worker-fakes.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = shortTmp("aru-");
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const good = {
  server: "http://127.0.0.1:8080/",
  machine: "web-app",
  token: "wk_x",
  claudePath: "/opt/homebrew/bin/claude",
  maxParallel: 1,
};

describe("worker config", () => {
  it("validates and normalizes", () => {
    expect(validateConfig(good)).toEqual({
      ...good,
      server: "http://127.0.0.1:8080",
    });
    expect(() => validateConfig({ ...good, token: "" })).toThrow(ConfigError);
    expect(() => validateConfig({ ...good, claudePath: "claude" })).toThrow(
      /absolute/,
    );
    expect(() => validateConfig({ ...good, server: "ftp://x" })).toThrow(
      /http/,
    );
    expect(() => validateConfig({ ...good, maxParallel: 0 })).toThrow(
      /maxParallel/,
    );
    expect(
      validateConfig({ ...good, settingSources: "user, project,local" })
        .settingSources,
    ).toBe("user,project,local");
    expect(() =>
      validateConfig({ ...good, settingSources: "global" }),
    ).toThrow(/settingSources/);
    expect(
      redactConfig({ ...validateConfig(good), oauthToken: "oat" }),
    ).toMatchObject({ token: "***", oauthToken: "***" });
  });

  it("writes 0600 and refuses a wider mode", () => {
    const p = join(tmp(), "a", "worker.json");
    writeConfig(p, validateConfig(good));
    expect((statSync(p).mode & 0o777).toString(8)).toBe("600");
    expect(loadConfig(p).token).toBe("wk_x");
    chmodSync(p, 0o644);
    expect(() => loadConfig(p)).toThrow(/must be 600/);
    chmodSync(p, 0o640);
    expect(() => loadConfig(p)).toThrow(/must be 600/);
    expect(() => loadConfig(join(tmp(), "missing.json"))).toThrow(
      /worker install/,
    );
  });
});

describe("folder check", () => {
  it("accepts inside, refuses outside, prefix tricks, .. and symlinks out", () => {
    const d = tmp();
    const root = join(d, "code");
    mkdirSync(join(root, "app"), { recursive: true });
    mkdirSync(join(d, "codebase"));
    mkdirSync(join(d, "secret"));
    symlinkSync(join(d, "secret"), join(root, "link"));
    symlinkSync(root, join(d, "alias"));
    const real = (p: string) => resolveAllowedFolder(p, [root]);
    expect(real(root)).toBeTruthy();
    expect(real(join(root, "app"))).toMatch(/\/code\/app$/);
    expect(real(join(d, "codebase"))).toBeNull();
    expect(real(join(root, "..", "secret"))).toBeNull();
    expect(real(join(root, "link"))).toBeNull();
    expect(real("relative/path")).toBeNull();
    expect(real(join(root, "nope"))).toBeNull();
    // An allowed folder given through a symlink still matches by realpath.
    expect(resolveAllowedFolder(join(root, "app"), [join(d, "alias")])).toMatch(
      /\/code\/app$/,
    );
    expect(resolveAllowedFolder(join(root, "app"), [])).toBeNull();
  });
});

describe("child env and args", () => {
  it("keeps only the allowlist and the subscription token", () => {
    const env = childEnv(
      {
        HOME: "/h",
        USER: "u",
        PATH: "/usr/bin",
        LANG: "C",
        TMPDIR: "/t",
        SHELL: "/bin/zsh",
        ANTHROPIC_API_KEY: "k",
        ANTHROPIC_BASE_URL: "b",
        ANTHROPIC_AUTH_TOKEN: "a",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "parent",
        OTHER: "x",
      },
      "/opt/claude/bin/claude",
      { RELAY_TASK: "tk_1", ANTHROPIC_API_KEY: "sneaky" },
    );
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "LANG",
      "PATH",
      "RELAY_TASK",
      "SHELL",
      "TMPDIR",
      "USER",
    ]);
    expect(env.PATH!.split(":")[0]).toBe("/opt/claude/bin");
    expect(childEnv({}, "/c/claude", {}, "oat").CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "oat",
    );
  });

  it("builds claude args with the settings file last", () => {
    expect(
      claudeArgs({
        permissionMode: "default",
        allowedTools: [],
        disallowedTools: [],
        settingsPath: "/s.json",
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "default",
      "--settings",
      "/s.json",
    ]);
    expect(
      claudeArgs({
        permissionMode: "plan",
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
        settingsPath: "/s",
        resumeSessionId: "s1",
        settingSources: "project",
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "plan",
      "--allowedTools",
      "Read",
      "--disallowedTools",
      "Bash",
      "--setting-sources",
      "project",
      "--resume",
      "s1",
      "--settings",
      "/s",
    ]);
  });

  it("quotes the hook command for the shell", () => {
    expect(
      shellQuote(
        "/Users/a/Library/Application Support/agent-relay/bin/agent-relay",
      ),
    ).toBe(
      "'/Users/a/Library/Application Support/agent-relay/bin/agent-relay'",
    );
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    const s = hookSettings(["/a b/agent-relay"]) as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ command: string; timeout: number }>;
        }>;
      };
    };
    expect(s.hooks.PreToolUse[0]!.matcher).toBe("*");
    expect(s.hooks.PreToolUse[0]!.hooks[0]).toMatchObject({
      command: "'/a b/agent-relay' worker hook",
      timeout: 1000,
    });
  });
});

describe("stream-json parser", () => {
  it("maps init, text, tools and the result, across chunk borders and junk", () => {
    const seen: unknown[] = [];
    const p = new StreamParser({
      onInit: (i) => seen.push(["init", i]),
      onText: (t) => seen.push(["text", t]),
      onToolUse: (id, name) => seen.push(["use", id, name]),
      onToolResult: (id, name, ok) => seen.push(["result", id, name, ok]),
      onResult: (r) => seen.push(["done", r]),
    });
    const lines = [
      {
        type: "system",
        subtype: "init",
        session_id: "s1",
        claude_code_version: "2.1.0",
        cwd: "/w",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hi" },
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        total_cost_usd: 0.5,
        num_turns: 3,
        session_id: "s1",
      },
    ];
    const text =
      "not json\n" +
      lines.map((l) => JSON.stringify(l)).join("\n") +
      "\n{broken\n";
    for (let i = 0; i < text.length; i += 7) p.push(text.slice(i, i + 7));
    p.end();
    expect(seen).toEqual([
      ["init", { sessionId: "s1", claudeVersion: "2.1.0", cwd: "/w" }],
      ["text", "hi"],
      ["use", "t1", "Bash"],
      ["result", "t1", "Bash", false],
      [
        "done",
        {
          isError: false,
          subtype: "success",
          result: "ok",
          costUsd: 0.5,
          numTurns: 3,
          sessionId: "s1",
        },
      ],
    ]);
  });

  it("treats a non-success subtype as an error", () => {
    let r: unknown;
    const p = new StreamParser({ onResult: (x) => (r = x) });
    p.push(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: false,
      }) + "\n",
    );
    expect(r).toMatchObject({ isError: true });
  });
});

describe("hook", () => {
  const input = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "x",
  });
  const denied = (out: { stdout: string }) =>
    (
      JSON.parse(out.stdout) as {
        hookSpecificOutput: {
          permissionDecision: string;
          permissionDecisionReason: string;
        };
      }
    ).hookSpecificOutput;

  it("denies without env, with bad input, or with no worker listening", async () => {
    expect(denied(await runHook(input, {})).permissionDecision).toBe("deny");
    expect(
      denied(
        await runHook("nope", { RELAY_TASK: "t", RELAY_HOOK_SOCKET: "/x" }),
      ).permissionDecisionReason,
    ).toMatch(/not JSON/);
    const out = await runHook(input, {
      RELAY_TASK: "t",
      RELAY_HOOK_SOCKET: join(tmp(), "none.sock"),
    });
    expect(out.exitCode).toBe(0);
    expect(denied(out)).toMatchObject({ permissionDecision: "deny" });
    expect(denied(out).permissionDecisionReason).toMatch(/unreachable/);
  });

  it("prints nothing on ok, denies on deny, socket is 0600", async () => {
    const sock = join(tmp(), "h.sock");
    const asked: unknown[] = [];
    const server = await startHookServer(sock, async (req) => {
      asked.push(req);
      return req.tool === "Bash"
        ? { decision: "deny", reason: "no" }
        : { decision: "ok" };
    });
    try {
      expect((statSync(sock).mode & 0o777).toString(8)).toBe("600");
      expect(
        denied(
          await runHook(input, { RELAY_TASK: "tk_1", RELAY_HOOK_SOCKET: sock }),
        ).permissionDecisionReason,
      ).toBe("agent-relay: no");
      const ok = await runHook(input.replace('"Bash"', '"Read"'), {
        RELAY_TASK: "tk_1",
        RELAY_HOOK_SOCKET: sock,
      });
      expect(ok).toEqual({ stdout: "", exitCode: 0 });
      expect(asked[0]).toEqual({
        task: "tk_1",
        tool: "Bash",
        input: { command: "ls" },
        toolUseId: "x",
      });
    } finally {
      await server.close();
    }
  });

  it("denies when the worker hangs past the timeout or throws", async () => {
    const sock = join(tmp(), "h.sock");
    const server = await startHookServer(sock, (req) =>
      req.tool === "Bash"
        ? new Promise(() => {})
        : Promise.reject(new Error("kaput")),
    );
    try {
      expect(
        denied(
          await runHook(
            input,
            { RELAY_TASK: "t", RELAY_HOOK_SOCKET: sock },
            200,
          ),
        ).permissionDecisionReason,
      ).toMatch(/timed out/);
      expect(
        denied(
          await runHook(input.replace('"Bash"', '"Read"'), {
            RELAY_TASK: "t",
            RELAY_HOOK_SOCKET: sock,
          }),
        ).permissionDecisionReason,
      ).toMatch(/kaput/);
    } finally {
      await server.close();
    }
  });

  it("refuses a socket path too long for macOS", async () => {
    await expect(
      startHookServer("/tmp/" + "x".repeat(120), async () => ({
        decision: "ok",
      })),
    ).rejects.toThrow(/too long/);
  });

  it("works end to end through the CLI entry", async () => {
    const { spawnSync } = await import("node:child_process");
    const { SELF } = await import("./worker-fakes.ts");
    const r = spawnSync(SELF[0]!, [SELF[1]!, "worker", "hook"], {
      input,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
    writeFileSync(join(tmp(), "noop"), "");
  });
});
