/**
 * Worker paths and worker.json. The relay token lives only in worker.json,
 * mode 0600; a wider mode refuses to start.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const LABEL = "org.antonyuk.agent-relay.worker";

export interface WorkerPaths {
  home: string;
  /** ~/Library/Application Support/agent-relay */
  appDir: string;
  config: string;
  binDir: string;
  bin: string;
  runDir: string;
  state: string;
  plist: string;
  log: string;
}

export function workerPaths(home: string = homedir()): WorkerPaths {
  const appDir = join(home, "Library", "Application Support", "agent-relay");
  const runDir = join(appDir, "run");
  return {
    home,
    appDir,
    config: join(appDir, "worker.json"),
    binDir: join(appDir, "bin"),
    bin: join(appDir, "bin", "agent-relay"),
    runDir,
    state: join(runDir, "state.json"),
    plist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    log: join(home, "Library", "Logs", "agent-relay-worker.log"),
  };
}

export interface WorkerConfig {
  server: string;
  machine: string;
  token: string;
  claudePath: string;
  maxParallel: number;
  /** Long-lived subscription token from `claude setup-token`; optional. */
  oauthToken?: string;
  /**
   * --setting-sources for claude. Default DEFAULT_SETTING_SOURCES ("project,local"):
   * the user's global ~/.claude settings (broad allow lists, hooks) never widen
   * the machine policy. "user,project,local" brings them back.
   */
  settingSources?: string;
}

export const DEFAULT_SETTING_SOURCES = "project,local";
const SETTING_SOURCES = ["user", "project", "local"];

export class ConfigError extends Error {}

const MACHINE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function validateConfig(raw: unknown): WorkerConfig {
  if (!raw || typeof raw !== "object")
    throw new ConfigError("worker.json: not an object");
  const c = raw as Record<string, unknown>;
  const str = (k: string) => {
    const v = c[k];
    if (typeof v !== "string" || !v.trim())
      throw new ConfigError(`worker.json: "${k}" is required`);
    return v.trim();
  };
  const server = str("server").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new ConfigError('worker.json: "server" is not a URL');
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ConfigError('worker.json: "server" must be http(s)');
  const machine = str("machine");
  if (!MACHINE.test(machine))
    throw new ConfigError('worker.json: "machine" is not a valid id');
  const token = str("token");
  const claudePath = str("claudePath");
  if (!isAbsolute(claudePath))
    throw new ConfigError('worker.json: "claudePath" must be absolute');
  const maxParallel = c.maxParallel === undefined ? 1 : c.maxParallel;
  if (
    typeof maxParallel !== "number" ||
    !Number.isInteger(maxParallel) ||
    maxParallel < 1 ||
    maxParallel > 4
  ) {
    throw new ConfigError('worker.json: "maxParallel" must be 1..4');
  }
  const out: WorkerConfig = { server, machine, token, claudePath, maxParallel };
  if (c.oauthToken !== undefined && c.oauthToken !== "") {
    if (typeof c.oauthToken !== "string")
      throw new ConfigError('worker.json: "oauthToken" must be a string');
    out.oauthToken = c.oauthToken.trim();
  }
  if (c.settingSources !== undefined && c.settingSources !== "") {
    if (
      typeof c.settingSources !== "string" ||
      !c.settingSources
        .split(",")
        .every((x) => SETTING_SOURCES.includes(x.trim()))
    ) {
      throw new ConfigError(
        'worker.json: "settingSources" is a comma list of user, project, local (e.g. "project,local")',
      );
    }
    out.settingSources = c.settingSources
      .split(",")
      .map((x) => x.trim())
      .join(",");
  }
  return out;
}

/** Load worker.json; refuses a file readable or writable by group or others. */
export function loadConfig(path: string): WorkerConfig {
  if (!existsSync(path))
    throw new ConfigError(
      `no config at ${path}; run "agent-relay worker install" first`,
    );
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new ConfigError(
      `${path} has mode ${mode.toString(8)}; it holds the worker token and must be 600 (chmod 600 it)`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  return validateConfig(raw);
}

/** Write worker.json atomically with mode 0600 (directory 0700). */
export function writeConfig(path: string, config: WorkerConfig): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** For printing: never shows a secret. */
export function redactConfig(config: WorkerConfig): Record<string, unknown> {
  return {
    ...config,
    token: "***",
    ...(config.oauthToken ? { oauthToken: "***" } : {}),
  };
}
