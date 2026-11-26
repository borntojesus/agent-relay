import type { IncomingMessage, ServerResponse } from "node:http";
import type { Relay } from "../relay.ts";
import type { Caller } from "../tokens.ts";
import { isWorker, machinesOf } from "../grants.ts";
import { TaskError, WAIT_MAX_S } from "../tasks/service.ts";
import { HttpError, readBody, send } from "./util.ts";

function bodyObj(body: unknown): Record<string, unknown> {
  if (body === undefined) return {};
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "body must be a JSON object");
  return body as Record<string, unknown>;
}

/** `wait` in seconds, 0..30, default 25. */
function waitMs(url: URL): number {
  const raw = url.searchParams.get("wait");
  if (raw === null || raw === "") return 25_000;
  if (!/^\d{1,3}$/.test(raw))
    throw new HttpError(400, "wait is a whole number of seconds");
  return Math.min(Number(raw), WAIT_MAX_S) * 1000;
}

/**
 * The worker routes (docs/worker-api.md). The bearer must be a worker token
 * (one `machine:<id>` grant) of the machine's own owner; the machine is taken
 * from the token, never the request, and a task of any other machine is 404.
 * Every call marks the machine seen and records `X-Worker-Version`.
 */
export async function handleWorker(
  relay: Relay,
  caller: Caller,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
): Promise<void> {
  const actor = `worker:${caller.label}`;
  const ids = isWorker(caller.grants) ? machinesOf(caller.grants) : [];
  const machine = ids.length === 1 ? relay.tasks.machine(ids[0]!) : undefined;
  if (!machine || machine.owner !== caller.owner) {
    relay.audit.write({
      actor,
      owner: caller.owner,
      action: "worker.auth",
      target: path,
      ok: false,
      detail: "not a worker token",
    });
    throw new HttpError(
      403,
      "not a worker token (needs one machine:<id> grant)",
    );
  }
  const m = machine.id;
  const audit = (
    action: string,
    target: string,
    ok: boolean,
    detail?: string,
  ) =>
    relay.audit.write({
      actor,
      owner: caller.owner,
      action,
      target,
      ok,
      ...(detail ? { detail } : {}),
    });
  const version = req.headers["x-worker-version"];
  relay.tasks.touch(m, Array.isArray(version) ? version[0] : version);

  // A long-poll ends early when the worker hangs up.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const get = req.method === "GET";
  const post = req.method === "POST";
  const label = caller.label;

  /** Runs a route; a refusal gets an audit row ok false (when `action` is set) and its HTTP status. */
  const run = async <T>(
    action: string | null,
    target: string,
    fn: () => T | Promise<T>,
    okDetail?: (out: T) => string,
  ): Promise<T> => {
    try {
      const out = await fn();
      if (action) audit(action, target, true, okDetail?.(out));
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof TaskError || err instanceof HttpError)
        audit(action ?? "worker.call", target, false, msg);
      if (err instanceof TaskError)
        throw new HttpError(err.status, err.message);
      throw err;
    }
  };

  if (path === "/worker/next" && get) {
    const wait = waitMs(url);
    const task = await relay.tasks.next(m, label, wait, abort.signal);
    if (!task) {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
      }
      return;
    }
    audit("worker.task.claim", task.id, true, `machine=${m}`);
    if (res.writableEnded || res.destroyed) {
      relay.tasks.unclaim(m, task.id);
      return;
    }
    send(res, 200, { task });
    return;
  }

  if (path === "/worker/heartbeat" && post) {
    const body = bodyObj(await readBody(req));
    send(
      res,
      200,
      await run(null, m, () => relay.tasks.heartbeat(m, body.running)),
    );
    return;
  }

  const taskRoute =
    /^\/worker\/tasks\/([^/]+)\/(events|status|tool-approvals)$/.exec(path);
  if (taskRoute && post) {
    const id = decodeURIComponent(taskRoute[1]!);
    const body = bodyObj(await readBody(req));
    if (taskRoute[2] === "events") {
      // Events are the task log itself; only a refusal goes to the audit log.
      send(
        res,
        200,
        await run(null, id, () =>
          relay.tasks.workerEvents(m, id, body.events, label),
        ),
      );
      return;
    }
    if (taskRoute[2] === "status") {
      const out = await run(
        "worker.task.status",
        id,
        () => relay.tasks.workerStatus(m, id, body, label),
        (o) => o.status,
      );
      send(res, 200, out);
      return;
    }
    const out = await run(
      "worker.task.approval",
      id,
      () => relay.tasks.requestApproval(m, id, body, label),
      (o) => `${o.id} ${String(body.tool ?? "")}`.slice(0, 200),
    );
    send(res, 201, out);
    return;
  }

  const apv = /^\/worker\/tool-approvals\/([^/]+)$/.exec(path);
  if (apv && get) {
    const id = decodeURIComponent(apv[1]!);
    const wait = waitMs(url);
    const out = await run(null, id, () =>
      relay.tasks.approvalStatus(m, id, wait, abort.signal),
    );
    if (!res.writableEnded && !res.destroyed) send(res, 200, out);
    return;
  }

  throw new HttpError(404, "not found");
}
