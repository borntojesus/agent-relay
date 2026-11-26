/**
 * `agent-relay worker <run|install|uninstall|status|hook>`.
 */
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isSea } from "node:sea";
import { loadConfig, workerPaths } from "./config.ts";
import { runHook } from "./hook.ts";
import {
  install,
  realExec,
  status,
  uninstall,
  type LaunchdContext,
  type Self,
} from "./launchd.ts";
import { Worker } from "./worker.ts";

export const WORKER_HELP = `usage:
  agent-relay worker run                       run the worker loop in the foreground (what launchd runs)
  agent-relay worker install --server <url> --machine <id> --claude <abs path> [--max-parallel N] [--dry-run]
                                               token on stdin: line 1 = relay worker token,
                                               optional line 2 = CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)
  agent-relay worker uninstall [--purge] [--dry-run]
  agent-relay worker status [--json]
  agent-relay worker hook                      PreToolUse hook (called by Claude Code, not by hand)
`;

export function selfInfo(): Self {
  let sea = false;
  try {
    sea = isSea();
  } catch {
    sea = false;
  }
  if (sea) return { sea: true, execPath: process.execPath };
  const script = process.argv[1];
  return {
    sea: false,
    execPath: process.execPath,
    ...(script ? { cliPath: resolve(script) } : {}),
  };
}

export function selfCommand(self: Self): string[] {
  if (self.sea) return [self.execPath];
  if (!self.cliPath) throw new Error("cannot tell where src/cli.ts is");
  return [self.execPath, self.cliPath];
}

function flags(args: string[]): Map<string, string | true> {
  const m = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf("=");
    if (eq > 0) m.set(a.slice(2, eq), a.slice(eq + 1));
    else if (args[i + 1] !== undefined && !args[i + 1]!.startsWith("--"))
      m.set(a.slice(2), args[++i]!);
    else m.set(a.slice(2), true);
  }
  return m;
}

function str(f: Map<string, string | true>, k: string): string | undefined {
  const v = f.get(k);
  return typeof v === "string" ? v : undefined;
}

function readStdin(): string {
  if (process.stdin.isTTY)
    process.stderr.write(
      "paste the worker token (and optionally a CLAUDE_CODE_OAUTH_TOKEN on a second line), then Ctrl-D:\n",
    );
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function context(f: Map<string, string | true>): LaunchdContext {
  // --home is for tests and odd setups; the default is the real home.
  const home = str(f, "home") ?? homedir();
  return {
    paths: workerPaths(home),
    self: selfInfo(),
    uid: userInfo().uid,
    exec: realExec,
    out: (t) => process.stdout.write(t),
  };
}

export async function runWorkerCli(
  args: string[],
  version: string,
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "hook") {
    const out = await runHook(readFileSync(0, "utf8"), process.env);
    process.stdout.write(out.stdout);
    return out.exitCode;
  }
  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(WORKER_HELP);
    return 0;
  }
  const f = flags(rest);
  if (sub === "run") {
    const paths = workerPaths(str(f, "home") ?? homedir());
    const config = loadConfig(paths.config);
    const worker = new Worker({
      config,
      runDir: paths.runDir,
      version,
      selfCommand: selfCommand(selfInfo()),
    });
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      console.log(`${new Date().toISOString()} [worker] stopping`);
      const force = setTimeout(() => process.exit(1), 15_000);
      force.unref();
      void worker.stop().then(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    await worker.run();
    return 0;
  }
  if (sub === "install") {
    const server = str(f, "server");
    const machine = str(f, "machine");
    const claude = str(f, "claude");
    if (!server || !machine || !claude)
      throw new Error("install needs --server, --machine and --claude");
    if (!isAbsolute(claude))
      throw new Error("--claude must be an absolute path (see: which claude)");
    if (f.has("token"))
      throw new Error(
        "the token is read from stdin, never from the command line",
      );
    const dryRun = f.has("dry-run");
    let token = "";
    let oauthToken: string | undefined;
    if (!dryRun) {
      const lines = readStdin()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      token = lines[0] ?? "";
      oauthToken = lines[1];
      if (!token) throw new Error("no token on stdin");
    }
    const maxParallel = str(f, "max-parallel");
    install(context(f), {
      server,
      machine,
      claudePath: claude,
      token,
      dryRun,
      ...(oauthToken ? { oauthToken } : {}),
      ...(maxParallel ? { maxParallel: Number(maxParallel) } : {}),
    });
    return 0;
  }
  if (sub === "uninstall") {
    uninstall(context(f), { purge: f.has("purge"), dryRun: f.has("dry-run") });
    return 0;
  }
  if (sub === "status") {
    const s = status(context(f));
    if (f.has("json")) {
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    } else {
      const lines = [
        `installed: ${s.installed ? "yes" : "no"} (${s.paths.plist})`,
        `loaded:    ${s.loaded ? `yes, ${s.state ?? "unknown state"}${s.pid ? `, pid ${s.pid}` : ""}` : "no"}`,
        `config:    ${s.config ? `${String(s.config.machine)} -> ${String(s.config.server)} (claude ${String(s.config.claudePath)})` : `error: ${s.configError}`}`,
        `tasks:     ${s.runningTasks.length ? s.runningTasks.join(", ") : "none"}`,
        `log:       ${s.paths.log}`,
      ];
      process.stdout.write(lines.join("\n") + "\n");
    }
    return s.config && s.loaded ? 0 : 1;
  }
  throw new Error(`unknown worker command: ${sub}\n\n${WORKER_HELP}`);
}
