/**
 * The PreToolUse hook and its unix socket.
 *
 * Claude Code runs `<agent-relay> worker hook` before every tool call (wired
 * through a temporary `--settings` file). The hook never holds the relay
 * token: it forwards the call to the parent worker over a unix socket (mode
 * 0600, in the 0700 run directory), and the worker reports the `tool` event
 * and, when the call needs it, asks the owner. Anything that goes wrong is a
 * deny (fail closed).
 *
 * Wire format: one JSON line each way.
 *   hook -> worker  { task, tool, input, toolUseId }
 *   worker -> hook  { decision: 'ok' | 'deny', reason? }
 * 'ok' means "no objection": the hook prints nothing and Claude Code's normal
 * permission flow (allowedTools, permission mode) still decides.
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

export interface HookRequest {
  task: string;
  tool: string;
  input: unknown;
  toolUseId?: string;
}

export interface HookReply {
  decision: "ok" | "deny";
  reason?: string;
}

/** macOS limits a unix socket path to 104 bytes (sun_path). */
export const MAX_SOCKET_PATH = 103;
const MAX_REQUEST = 1024 * 1024;

export interface HookServer {
  path: string;
  close(): Promise<void>;
}

/** Worker side: listen on `path` and answer each hook with `handle`. */
export async function startHookServer(
  path: string,
  handle: (req: HookRequest) => Promise<HookReply>,
): Promise<HookServer> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH)
    throw new Error(
      `hook socket path too long (${Buffer.byteLength(path)} bytes): ${path}`,
    );
  if (existsSync(path)) unlinkSync(path);
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
    sock.setEncoding("utf8");
    let buf = "";
    let done = false;
    const reply = (r: HookReply) => {
      if (done) return;
      done = true;
      if (!sock.destroyed) sock.end(JSON.stringify(r) + "\n");
    };
    sock.on("data", (chunk: string) => {
      if (done) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST)
        return reply({ decision: "deny", reason: "hook request too large" });
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let req: HookRequest;
      try {
        const raw = JSON.parse(buf.slice(0, nl)) as Partial<HookRequest>;
        if (typeof raw.task !== "string" || typeof raw.tool !== "string")
          throw new Error("bad request");
        req = {
          task: raw.task,
          tool: raw.tool,
          input: raw.input,
          ...(typeof raw.toolUseId === "string"
            ? { toolUseId: raw.toolUseId }
            : {}),
        };
      } catch {
        return reply({ decision: "deny", reason: "malformed hook request" });
      }
      handle(req).then(reply, (err: unknown) =>
        reply({
          decision: "deny",
          reason: `relay worker error: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          /* already gone */
        }
      }),
  };
}

/** Hook side: send one request, wait for one reply. Errors reject. */
export function askWorker(
  socketPath: string,
  req: HookRequest,
  timeoutMs: number,
): Promise<HookReply> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    sock.setEncoding("utf8");
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timed out waiting for the relay worker"));
    }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      const line = buf.split("\n")[0] ?? "";
      try {
        const r = JSON.parse(line) as Partial<HookReply>;
        if (r.decision === "ok" || r.decision === "deny") {
          resolve({
            decision: r.decision,
            ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
          });
          return;
        }
      } catch {
        /* fall through */
      }
      reject(new Error("no answer from the relay worker"));
    });
  });
}

export interface HookOutcome {
  stdout: string;
  exitCode: number;
}

export function denyOutput(reason: string): string {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
}

/** Longer than the 15 min approval expiry so the relay decides, not this timer. */
export const HOOK_WAIT_MS = 16 * 60 * 1000;

/**
 * `agent-relay worker hook`: stdin is Claude Code's PreToolUse JSON, env
 * carries RELAY_TASK and RELAY_HOOK_SOCKET. Every failure denies.
 */
export async function runHook(
  stdin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = HOOK_WAIT_MS,
): Promise<HookOutcome> {
  const deny = (reason: string): HookOutcome => ({
    stdout: denyOutput(`agent-relay: ${reason}`),
    exitCode: 0,
  });
  const task = env.RELAY_TASK;
  const socket = env.RELAY_HOOK_SOCKET;
  if (!task || !socket)
    return deny("hook has no task or socket (not started by the relay worker)");
  let input: {
    tool_name?: unknown;
    tool_input?: unknown;
    tool_use_id?: unknown;
    hook_event_name?: unknown;
  };
  try {
    input = JSON.parse(stdin) as typeof input;
  } catch {
    return deny("hook input is not JSON");
  }
  if (typeof input.tool_name !== "string")
    return deny("hook input has no tool_name");
  try {
    const reply = await askWorker(
      socket,
      {
        task,
        tool: input.tool_name,
        input: input.tool_input,
        ...(typeof input.tool_use_id === "string"
          ? { toolUseId: input.tool_use_id }
          : {}),
      },
      timeoutMs,
    );
    if (reply.decision === "ok") return { stdout: "", exitCode: 0 };
    return deny(reply.reason ?? "denied");
  } catch (err) {
    return deny(
      `relay worker unreachable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
