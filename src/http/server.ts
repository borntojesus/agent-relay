import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Relay } from "../relay.ts";
import type { Caller } from "../tokens.ts";
import { createMcpServer, VERSION } from "../mcp/server.ts";
import {
  formatUnreadText,
  RoomInputError,
  RoomNotFoundError,
} from "../rooms/service.ts";
import {
  ApprovalConflictError,
  ApprovalForbiddenError,
  ApprovalInputError,
  parseApprovalRequest,
} from "../approvals/actions.ts";
import { HttpError, readBody, send } from "./util.ts";
import { handleOwner } from "./console.ts";
import { handleWorker } from "./worker.ts";
import { TaskError } from "../tasks/service.ts";

const REQS_PER_MIN = 120;
/** A worker streams events about once a second; it is limited per token, not per address (two machines may share one). */
const WORKER_REQS_PER_MIN = 600;
const BAD_AUTH_PER_MIN = 10;

export interface HttpOptions {
  trustProxy?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/** Fixed one-minute windows per key. */
class Window {
  private readonly hits = new Map<string, { start: number; n: number }>();
  private readonly limit: number;
  private readonly now: () => number;
  constructor(limit: number, now: () => number) {
    this.limit = limit;
    this.now = now;
  }
  over(key: string): boolean {
    const w = this.hits.get(key);
    return Boolean(w && this.now() - w.start < 60_000 && w.n >= this.limit);
  }
  hit(key: string): boolean {
    const t = this.now();
    let w = this.hits.get(key);
    if (!w || t - w.start >= 60_000) {
      if (this.hits.size > 10_000) this.hits.clear();
      w = { start: t, n: 0 };
      this.hits.set(key, w);
    }
    w.n++;
    return w.n > this.limit;
  }
}

/**
 * The relay's HTTP surface: `/health` open, everything else behind a bearer
 * token. `/mcp` is stateless Streamable HTTP: a fresh MCP server per request.
 */
export function createHttpServer(relay: Relay, opts: HttpOptions = {}): Server {
  const now = opts.now ?? Date.now;
  const perIp = new Window(REQS_PER_MIN, now);
  const perWorker = new Window(WORKER_REQS_PER_MIN, now);
  const badAuth = new Window(BAD_AUTH_PER_MIN, now);

  const ipOf = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      // Behind a Cloudflare tunnel the edge sets CF-Connecting-IP to the real client; a
      // proxy in between (Caddy) may rewrite X-Forwarded-For to the tunnel's address.
      const cf = req.headers["cf-connecting-ip"];
      const cfIp = (Array.isArray(cf) ? cf[0] : cf)?.trim();
      if (cfIp) return cfIp;
      const fwd = req.headers["x-forwarded-for"];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const auth = (req: IncomingMessage, ip: string): Caller => {
    if (badAuth.over(ip))
      throw new HttpError(429, "too many bad tokens; wait a minute");
    const h = req.headers.authorization ?? "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(h)?.[1];
    const caller = relay.tokens.authenticate(bearer);
    if (!caller) {
      badAuth.hit(ip);
      relay.audit.write({
        actor: "anonymous",
        action: "auth",
        ok: false,
        detail: ip,
      });
      throw new HttpError(401, "missing or unknown bearer token");
    }
    return caller;
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ip = ipOf(req);
    const workerPath = path.startsWith("/worker/");
    if (!workerPath && perIp.hit(ip))
      throw new HttpError(429, "too many requests; wait a minute");

    if (path === "/health" && req.method === "GET") {
      send(res, 200, {
        ok: true,
        service: "agent-relay",
        version: VERSION,
        channels: [...relay.channels.keys()].sort(),
      });
      return;
    }

    if (path === "/mcp") {
      const caller = auth(req, ip);
      if (req.method !== "POST") {
        send(res, 405, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "stateless server: POST only" },
          id: null,
        });
        return;
      }
      const body = await readBody(req);
      const server = createMcpServer({
        caller,
        rooms: relay.rooms,
        approvals: relay.approvals,
        audit: relay.audit,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (path.startsWith("/owner/")) {
      const caller = auth(req, ip);
      await handleOwner(relay, caller, req, res, url, path);
      return;
    }

    if (path.startsWith("/worker/")) {
      const caller = auth(req, ip);
      if (perWorker.hit(caller.key))
        throw new HttpError(429, "too many requests; wait a minute");
      await handleWorker(relay, caller, req, res, url, path);
      return;
    }

    if (path === "/unread" && req.method === "GET") {
      const caller = auth(req, ip);
      const tools = relay.rooms.for(caller);
      const format = url.searchParams.get("format") ?? "text";
      if (!tools || !tools.canRead) {
        if (format === "json")
          send(res, 200, { messages: [], unread: 0, more: false });
        else send(res, 200, "", "text/plain");
        return;
      }
      const args: Record<string, unknown> = {};
      for (const k of ["room", "thread", "limit"]) {
        const v = url.searchParams.get(k);
        if (v) args[k] = v;
      }
      if (!args.limit) args.limit = 20;
      const out = tools.unread(args);
      if (format === "json") send(res, 200, { _trust: "untrusted", ...out });
      else
        send(
          res,
          200,
          formatUnreadText(out.messages, out.unread),
          "text/plain",
        );
      return;
    }

    if (path === "/approvals" || path.startsWith("/approvals/")) {
      const caller = auth(req, ip);
      const ac = {
        key: caller.key,
        label: caller.label,
        owner: caller.owner,
        grants: caller.grants,
      };
      if (path === "/approvals" && req.method === "POST") {
        const view = await relay.approvals.create(
          ac,
          parseApprovalRequest(await readBody(req)),
        );
        relay.audit.write({
          actor: caller.label,
          owner: caller.owner,
          action: "approval.request",
          target: view.id,
          ok: true,
          detail: `${view.tier} ${view.action}`,
        });
        send(res, 201, view);
        return;
      }
      if (path === "/approvals" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const since = url.searchParams.get("since") ?? undefined;
        send(res, 200, {
          approvals: relay.approvals.journal(caller.key, {
            limit,
            ...(since ? { since } : {}),
          }),
        });
        return;
      }
      const m = /^\/approvals\/([0-9a-f]{24})(\/decide)?$/.exec(path);
      if (m && !m[2] && req.method === "GET") {
        const v = relay.approvals.status(caller.key, m[1]!);
        if (!v) throw new HttpError(404, "no such approval");
        send(res, 200, v);
        return;
      }
      if (m && m[2] && req.method === "POST") {
        const body = (await readBody(req)) as
          | { decision?: unknown }
          | undefined;
        const v = await relay.approvals.decideInApp(ac, m[1]!, body?.decision);
        if (!v) throw new HttpError(404, "no such approval");
        relay.audit.write({
          actor: caller.label,
          owner: caller.owner,
          action: "approval.decide",
          target: v.id,
          ok: true,
          detail: v.status,
        });
        send(res, 200, v);
        return;
      }
    }
    throw new HttpError(404, "not found");
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status =
        err instanceof HttpError
          ? err.status
          : err instanceof TaskError
            ? err.status
          : err instanceof ApprovalInputError || err instanceof RoomInputError
            ? 400
            : err instanceof ApprovalForbiddenError
              ? 403
              : err instanceof RoomNotFoundError
                ? 404
                : err instanceof ApprovalConflictError
                  ? 409
                  : err instanceof URIError
                    ? 400
                    : 500;
      if (status === 500)
        opts.log?.(
          `[http] ${req.method} ${req.url}: ${err instanceof Error ? err.stack : String(err)}`,
        );
      if (!res.headersSent)
        send(res, status, {
          error:
            status === 500
              ? "internal error"
              : err instanceof Error
                ? err.message
                : String(err),
        });
      else res.end();
    });
  });
}
