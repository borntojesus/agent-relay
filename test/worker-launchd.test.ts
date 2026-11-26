import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LABEL, workerPaths } from "../src/worker/config.ts";
import {
  install,
  programArguments,
  status,
  uninstall,
  type Exec,
  type LaunchdContext,
} from "../src/worker/launchd.ts";
import { SELF, shortTmp } from "./worker-fakes.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup(opts: { sea?: boolean; fail?: boolean; print?: string } = {}) {
  const root = shortTmp("arl-");
  dirs.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const claude = join(root, "claude");
  writeFileSync(claude, "#!/bin/sh\n", { mode: 0o755 });
  const seaBin = join(root, "agent-relay-sea");
  writeFileSync(seaBin, "binary", { mode: 0o755 });
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "bootstrap" && opts.fail)
      return {
        code: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error",
      };
    if (args[0] === "print")
      return opts.print
        ? { code: 0, stdout: opts.print, stderr: "" }
        : { code: 113, stdout: "", stderr: "not found" };
    return { code: 0, stdout: "", stderr: "" };
  };
  let out = "";
  const ctx: LaunchdContext = {
    paths: workerPaths(home),
    self: opts.sea
      ? { sea: true, execPath: seaBin }
      : { sea: false, execPath: "/usr/local/bin/node", cliPath: "/src/cli.ts" },
    uid: 501,
    exec,
    out: (t) => (out += t),
  };
  return { root, home, claude, seaBin, calls, ctx, out: () => out };
}

const opts = (claude: string) => ({
  server: "http://127.0.0.1:8080",
  machine: "web-app",
  claudePath: claude,
  token: "wk_secret_value",
});

describe("worker install", () => {
  it("dry run prints the plan and writes nothing", () => {
    const s = setup({ sea: true });
    install(s.ctx, { ...opts(s.claude), dryRun: true });
    expect(readdirSync(s.home)).toEqual([]);
    expect(s.calls).toEqual([]);
    expect(s.out()).toContain(`<string>${LABEL}</string>`);
    expect(s.out()).toContain("launchctl bootstrap gui/501");
    expect(s.out()).not.toContain("wk_secret_value");
  });

  it("copies the binary, writes worker.json 0600 and the plist, then bootout and bootstrap", () => {
    const s = setup({ sea: true });
    install(s.ctx, { ...opts(s.claude), oauthToken: "oat_x", maxParallel: 2 });
    const p = s.ctx.paths;
    expect((statSync(p.config).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(readFileSync(p.config, "utf8"))).toMatchObject({
      token: "wk_secret_value",
      oauthToken: "oat_x",
      maxParallel: 2,
      machine: "web-app",
    });
    expect(readFileSync(p.bin, "utf8")).toBe("binary");
    expect((statSync(p.bin).mode & 0o777).toString(8)).toBe("755");
    const pl = readFileSync(p.plist, "utf8");
    expect(pl).toContain(
      `<string>${p.bin}</string>\n    <string>worker</string>\n    <string>run</string>`,
    );
    expect(pl).toContain("<key>KeepAlive</key>");
    expect(pl).not.toContain("wk_secret_value");
    expect(s.calls).toEqual([
      ["launchctl", "bootout", `gui/501/${LABEL}`],
      ["launchctl", "bootstrap", "gui/501", p.plist],
    ]);
    expect(s.out()).not.toContain("wk_secret_value");
  });

  it("node mode runs node with cli.ts and copies nothing", () => {
    const s = setup();
    expect(programArguments(s.ctx.paths, s.ctx.self)).toEqual([
      "/usr/local/bin/node",
      "/src/cli.ts",
      "worker",
      "run",
    ]);
    install(s.ctx, opts(s.claude));
    expect(existsSync(s.ctx.paths.bin)).toBe(false);
    expect(readFileSync(s.ctx.paths.plist, "utf8")).toContain(
      "<string>/src/cli.ts</string>",
    );
  });

  it("throws when bootstrap fails or claude is missing", () => {
    const s = setup({ fail: true });
    expect(() => install(s.ctx, opts(s.claude))).toThrow(
      /bootstrap failed \(5\)/,
    );
    expect(() => install(s.ctx, opts(join(s.root, "nope")))).toThrow(
      /claude not found/,
    );
  });

  it("uninstall keeps worker.json unless --purge", () => {
    const s = setup({ sea: true });
    install(s.ctx, opts(s.claude));
    uninstall(s.ctx);
    expect(existsSync(s.ctx.paths.plist)).toBe(false);
    expect(existsSync(s.ctx.paths.config)).toBe(true);
    uninstall(s.ctx, { purge: true });
    expect(existsSync(s.ctx.paths.config)).toBe(false);
    expect(existsSync(s.ctx.paths.binDir)).toBe(false);
  });

  it("status reads launchctl print and the redacted config", () => {
    const s = setup({
      print: `${LABEL} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n}`,
    });
    expect(status(s.ctx)).toMatchObject({
      installed: false,
      loaded: true,
      state: "running",
      pid: 4242,
      config: null,
    });
    install(s.ctx, opts(s.claude));
    const st = status(s.ctx);
    expect(st.installed).toBe(true);
    expect(st.config).toMatchObject({ token: "***", machine: "web-app" });
    expect(status(setup().ctx)).toMatchObject({
      loaded: false,
      state: null,
      pid: null,
    });
  });
});

describe("worker CLI", () => {
  const cli = (args: string[], input = "") =>
    spawnSync(SELF[0]!, [SELF[1]!, "worker", ...args], {
      input,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
    });

  it("refuses --token on the command line", () => {
    const s = setup();
    const r = cli([
      "install",
      "--server",
      "http://127.0.0.1:1",
      "--machine",
      "m",
      "--claude",
      s.claude,
      "--home",
      s.home,
      "--token",
      "wk_leak",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/stdin, never from the command line/);
    expect(readdirSync(s.home)).toEqual([]);
  });

  it("install --dry-run with --home prints the plist and writes nothing", () => {
    const s = setup();
    const r = cli([
      "install",
      "--server",
      "http://127.0.0.1:1",
      "--machine",
      "m",
      "--claude",
      s.claude,
      "--home",
      s.home,
      "--dry-run",
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      join(s.home, "Library", "LaunchAgents", `${LABEL}.plist`),
    );
    expect(readdirSync(s.home)).toEqual([]);
  });

  it("refuses a relative claude path", () => {
    const r = cli([
      "install",
      "--server",
      "http://127.0.0.1:1",
      "--machine",
      "m",
      "--claude",
      "claude",
      "--dry-run",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/absolute/);
  });
});
