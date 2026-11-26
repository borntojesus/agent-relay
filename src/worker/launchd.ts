/**
 * `worker install | uninstall | status`: the per-user LaunchAgent that keeps
 * `agent-relay worker run` alive. Everything takes the home directory and the
 * command runner as inputs, so tests run against a temp dir and never call
 * launchctl.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  LABEL,
  loadConfig,
  redactConfig,
  validateConfig,
  writeConfig,
  type WorkerConfig,
  type WorkerPaths,
} from "./config.ts";
import { stateTasks } from "./worker.ts";

export interface Self {
  /** Running as the packaged single binary. */
  sea: boolean;
  execPath: string;
  /** Absolute path of src/cli.ts when running under node. */
  cliPath?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: string[]) => ExecResult;

export const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? r.error.message : ""),
  };
};

export interface LaunchdContext {
  paths: WorkerPaths;
  self: Self;
  uid: number;
  exec: Exec;
  out: (text: string) => void;
}

const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** ProgramArguments for launchd: the installed copy of the binary, or node + cli.ts. */
export function programArguments(paths: WorkerPaths, self: Self): string[] {
  if (self.sea) return [paths.bin, "worker", "run"];
  if (!self.cliPath)
    throw new Error(
      "cannot tell where src/cli.ts is; run the worker from the binary or with node src/cli.ts",
    );
  return [self.execPath, self.cliPath, "worker", "run"];
}

export function launchPath(claudePath: string, self: Self): string {
  const dirs = [
    dirname(claudePath),
    ...(self.sea ? [] : [dirname(self.execPath)]),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs)].join(":");
}

export function plist(
  paths: WorkerPaths,
  self: Self,
  claudePath: string,
): string {
  const args = programArguments(paths, self)
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${xml(paths.appDir)}</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(launchPath(claudePath, self))}</string>
  </dict>
</dict>
</plist>
`;
}

export interface InstallOptions {
  server: string;
  machine: string;
  claudePath: string;
  token: string;
  oauthToken?: string;
  maxParallel?: number;
  dryRun?: boolean;
}

/** Install (or reinstall) the worker. Dry run prints what it would do and touches nothing. */
export function install(ctx: LaunchdContext, opts: InstallOptions): void {
  const { paths, self } = ctx;
  if (!opts.dryRun) {
    let ok = false;
    try {
      ok = statSync(opts.claudePath).isFile();
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`claude not found at ${opts.claudePath}`);
  }
  const config: WorkerConfig = validateConfig({
    server: opts.server,
    machine: opts.machine,
    token: opts.token || (opts.dryRun ? "dry-run" : ""),
    claudePath: opts.claudePath,
    maxParallel: opts.maxParallel ?? 1,
    ...(opts.oauthToken ? { oauthToken: opts.oauthToken } : {}),
  });
  const body = plist(paths, self, config.claudePath);
  const domain = `gui/${ctx.uid}`;

  if (opts.dryRun) {
    ctx.out(`# dry run: nothing written, launchctl not called\n`);
    ctx.out(
      `# ${paths.config} (mode 600)\n${JSON.stringify(redactConfig(config), null, 2)}\n`,
    );
    if (self.sea) ctx.out(`# copy ${self.execPath} -> ${paths.bin}\n`);
    ctx.out(`# ${paths.plist}\n${body}`);
    ctx.out(
      `# launchctl bootout ${domain}/${LABEL}\n# launchctl bootstrap ${domain} ${paths.plist}\n`,
    );
    return;
  }

  writeConfig(paths.config, config);
  if (self.sea && self.execPath !== paths.bin) {
    mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
    const tmp = `${paths.bin}.tmp-${process.pid}`;
    copyFileSync(self.execPath, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, paths.bin);
  }
  mkdirSync(dirname(paths.plist), { recursive: true });
  mkdirSync(dirname(paths.log), { recursive: true });
  writeFileSync(paths.plist, body, { mode: 0o644 });
  ctx.exec("launchctl", ["bootout", `${domain}/${LABEL}`]); // not loaded yet: ignore
  const r = ctx.exec("launchctl", ["bootstrap", domain, paths.plist]);
  if (r.code !== 0)
    throw new Error(
      `launchctl bootstrap failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  ctx.out(
    `installed ${LABEL}\n  config ${paths.config}\n  plist  ${paths.plist}\n  log    ${paths.log}\n`,
  );
}

export function uninstall(
  ctx: LaunchdContext,
  opts: { purge?: boolean; dryRun?: boolean } = {},
): void {
  const { paths } = ctx;
  const domain = `gui/${ctx.uid}`;
  if (opts.dryRun) {
    ctx.out(
      `# dry run\n# launchctl bootout ${domain}/${LABEL}\n# rm ${paths.plist}\n`,
    );
    if (opts.purge)
      ctx.out(
        `# rm ${paths.config}\n# rm -r ${paths.binDir} ${paths.runDir}\n`,
      );
    return;
  }
  ctx.exec("launchctl", ["bootout", `${domain}/${LABEL}`]);
  rmSync(paths.plist, { force: true });
  if (opts.purge) {
    rmSync(paths.config, { force: true });
    rmSync(paths.binDir, { recursive: true, force: true });
    rmSync(paths.runDir, { recursive: true, force: true });
  }
  ctx.out(
    `uninstalled ${LABEL}${opts.purge ? " (config, binary and run state removed)" : " (worker.json kept; --purge removes it)"}\n`,
  );
}

export interface WorkerStatus {
  installed: boolean;
  loaded: boolean;
  state: string | null;
  pid: number | null;
  config: Record<string, unknown> | null;
  configError: string | null;
  runningTasks: string[];
  paths: { config: string; plist: string; log: string };
}

export function status(ctx: LaunchdContext): WorkerStatus {
  const { paths } = ctx;
  let config: Record<string, unknown> | null = null;
  let configError: string | null = null;
  try {
    config = redactConfig(loadConfig(paths.config));
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }
  const r = ctx.exec("launchctl", ["print", `gui/${ctx.uid}/${LABEL}`]);
  const loaded = r.code === 0;
  const state = loaded
    ? (/^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? null)
    : null;
  const pidMatch = loaded ? /^\s*pid = (\d+)$/m.exec(r.stdout) : null;
  return {
    installed: existsSync(paths.plist),
    loaded,
    state,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    config,
    configError,
    runningTasks: stateTasks(paths.runDir),
    paths: { config: paths.config, plist: paths.plist, log: paths.log },
  };
}
