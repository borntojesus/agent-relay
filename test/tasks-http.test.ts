import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http/server.ts";
import { addMachine, flush, world, type World } from "./helpers.ts";

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function up(w: World) {
  const server = createHttpServer(w.relay);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (
    path: string,
    token: string,
    init: RequestInit & { json?: unknown } = {},
  ) => {
    const { json, ...rest } = init;
    const r = await fetch(base + path, {
      ...(json !== undefined
        ? { method: "POST", body: JSON.stringify(json) }
        : {}),
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Worker-Version": "0.5.0-test",
        ...(rest.headers ?? {}),
      },
    });
    const text = await r.text();
    return {
      status: r.status,
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  };
}

async function setup() {
  const w = world({ channels: [] });
  const worker = addMachine(w, "mini", "alice");
  const other = addMachine(w, "pc", "alice");
  const bobWorker = addMachine(w, "bob-box", "bob");
  const ac = w.agent("alice-console", "alice", "owner:alice:rw");
  const ro = w.agent("alice-viewer", "alice", "owner:alice:r");
  const bc = w.agent("bob-console", "bob", "owner:bob:rw");
  const ag = w.agent("alice-agent", "alice", "peer:team:rw");
  const call = await up(w);
  const create = (body: Record<string, unknown> = {}) =>
    call("/owner/tasks", ac.token, {
      json: {
        machine: "mini",
        folder: "/work/app",
        prompt: "run tests",
        ...body,
      },
    });
  const audit = (action: string) =>
    w.relay.audit.recent(500).filter((a) => a.action === action);
  return { w, call, create, audit, worker, other, bobWorker, ac, ro, bc, ag };
}

describe("console: machines", () => {
  it("lists own machines only, with online and counts", async () => {
    const { call, ac, bc, worker } = await setup();
    let r = await call("/owner/machines", ac.token);
    expect(r.status).toBe(200);
    expect(r.body.machines.map((m: any) => m.id)).toEqual(["mini", "pc"]);
    expect(r.body.machines[0]).toMatchObject({
      online: false,
      killed: false,
      running: 0,
      queued: 0,
    });
    await call("/worker/heartbeat", worker.token, { json: {} });
    r = await call("/owner/machines", ac.token);
    expect(r.body.machines[0]).toMatchObject({
      online: true,
      workerVersion: "0.5.0-test",
    });
    expect(
      (await call("/owner/machines", bc.token)).body.machines.map(
        (m: any) => m.id,
      ),
    ).toEqual(["bob-box"]);
  });

  it("PATCH changes name, policy and kill; refusals are audited ok false", async () => {
    const { call, ac, ro, bc, audit } = await setup();
    const patch = (token: string, id: string, json: unknown) =>
      call(`/owner/machines/${id}`, token, {
        method: "PATCH",
        body: JSON.stringify(json),
      });
    let r = await patch(ac.token, "mini", {
      name: "Mac mini",
      policy: { maxRuntimeMinutes: 90 },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name: "Mac mini",
      policy: { maxRuntimeMinutes: 90, folders: ["/work"] },
    });
    r = await patch(ac.token, "mini", {
      policy: { permissionMode: "bypassPermissions" },
    });
    expect(r.status).toBe(400);
    expect(audit("console.machine.update").map((a) => a.ok)).toEqual([
      false,
      true,
    ]);
    expect((await patch(ro.token, "mini", { name: "x" })).status).toBe(403);
    expect((await patch(bc.token, "mini", { killed: true })).status).toBe(404);
    expect((await patch(ac.token, "nope", { name: "x" })).status).toBe(404);
    r = await patch(ac.token, "mini", { killed: true });
    expect(r.body.killed).toBe(true);
    expect(audit("console.machine.kill").at(0)!.ok).toBe(true);
  });
});

describe("console: tasks", () => {
  it("create, get, list with filters, events, task-log, pendingTasks", async () => {
    const { call, create, ac, bc, w } = await setup();
    const r = await create({ priority: "high" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: "queued",
      machine: "mini",
      machineName: "mini",
      priority: "high",
      pendingApprovals: [],
    });
    const id = r.body.id;
    expect((await call(`/owner/tasks/${id}`, ac.token)).body.id).toBe(id);
    expect((await call(`/owner/tasks/${id}`, bc.token)).status).toBe(404);
    expect(
      (await call("/owner/tasks?machine=mini&status=queued&limit=5", ac.token))
        .body.tasks,
    ).toHaveLength(1);
    expect(
      (await call("/owner/tasks?machine=pc", ac.token)).body.tasks,
    ).toHaveLength(0);
    expect((await call("/owner/tasks?status=bogus", ac.token)).status).toBe(
      400,
    );
    expect((await call("/owner/tasks", bc.token)).body.tasks).toHaveLength(0);
    const ev = await call(`/owner/tasks/${id}/events?after=0`, ac.token);
    expect(ev.body.events.map((e: any) => e.type)).toEqual(["created"]);
    expect(
      (
        await call(
          `/owner/tasks/${id}/events?after=${ev.body.events[0].id}`,
          ac.token,
        )
      ).body.events,
    ).toEqual([]);
    expect((await call(`/owner/tasks/${id}/events`, bc.token)).status).toBe(
      404,
    );
    expect(
      (await call("/owner/task-log?machine=mini", ac.token)).body.events,
    ).toHaveLength(1);
    expect((await call("/owner/task-log", bc.token)).body.events).toHaveLength(
      0,
    );
    w.relay.tasks.updateMachine(
      "alice",
      "mini",
      { policy: { requireTap: true } },
      "c",
    );
    await create();
    expect((await call("/owner/me", ac.token)).body.pendingTasks).toBe(1);
    expect((await call("/owner/me", bc.token)).body.pendingTasks).toBe(0);
  });

  it("refuses killed machine, folder, prompt, unknown and foreign machines; audited ok false", async () => {
    const { create, call, bc, audit, w } = await setup();
    expect((await create({ folder: "/etc" })).status).toBe(400);
    expect((await create({ prompt: "" })).status).toBe(400);
    expect((await create({ prompt: "x".repeat(20_001) })).status).toBe(400);
    expect((await create({ machine: "nope" })).status).toBe(404);
    expect(
      (
        await call("/owner/tasks", bc.token, {
          json: { machine: "mini", folder: "/work", prompt: "p" },
        })
      ).status,
    ).toBe(404);
    w.relay.tasks.updateMachine("alice", "mini", { killed: true }, "c");
    const r = await create();
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/killed/);
    const rows = audit("console.task.create");
    expect(rows.filter((a) => a.owner === "alice").every((a) => !a.ok)).toBe(
      true,
    );
    expect(rows).toHaveLength(6);
  });

  it("agent, read-only and worker tokens cannot create or change tasks", async () => {
    const { call, ag, ro, worker } = await setup();
    const body = { json: { machine: "mini", folder: "/work", prompt: "p" } };
    expect((await call("/owner/tasks", ag.token, body)).status).toBe(403);
    expect((await call("/owner/tasks", ro.token, body)).status).toBe(403);
    expect((await call("/owner/tasks", worker.token, body)).status).toBe(403);
    expect((await call("/owner/machines", worker.token)).status).toBe(403);
  });

  it("start, cancel, follow-up and approvals over HTTP", async () => {
    const { call, create, ac, bc, ro, worker, w } = await setup();
    w.relay.tasks.updateMachine(
      "alice",
      "mini",
      { policy: { requireTap: true } },
      "c",
    );
    const id = (await create()).body.id;
    expect(
      (await call(`/owner/tasks/${id}/start`, ro.token, { method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (await call(`/owner/tasks/${id}/start`, bc.token, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await call(`/owner/tasks/${id}/start`, ac.token, { method: "POST" }))
        .body.status,
    ).toBe("queued");
    expect(
      (await call(`/owner/tasks/${id}/start`, ac.token, { method: "POST" }))
        .status,
    ).toBe(400);
    const next = await call("/worker/next?wait=0", worker.token);
    expect(next.status).toBe(200);
    expect(next.body.task).toMatchObject({
      id,
      folder: "/work/app",
      resumeSessionId: null,
    });
    await call(`/worker/tasks/${id}/status`, worker.token, {
      json: { status: "running", sessionId: "s1" },
    });
    const apv = await call(`/worker/tasks/${id}/tool-approvals`, worker.token, {
      json: { tool: "Bash", summary: "git push", category: "push" },
    });
    expect(apv.status).toBe(201);
    const aid = apv.body.id;
    const decide = (token: string, decision: string) =>
      call(`/owner/tasks/${id}/approvals/${aid}`, token, {
        json: { decision },
      });
    expect((await decide(bc.token, "approve")).status).toBe(404);
    expect((await decide(ro.token, "approve")).status).toBe(403);
    expect((await decide(ac.token, "perhaps")).status).toBe(400);
    const d = await decide(ac.token, "approve");
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      approval: { status: "approved" },
      task: { status: "running" },
    });
    expect((await decide(ac.token, "reject")).status).toBe(409);
    expect(
      (await call(`/worker/tool-approvals/${aid}?wait=0`, worker.token)).body
        .status,
    ).toBe("approved");
    expect(
      (
        await call(`/owner/tasks/${id}/followup`, ac.token, {
          json: { prompt: "more" },
        })
      ).status,
    ).toBe(400);
    const c = await call(`/owner/tasks/${id}/cancel`, ac.token, {
      method: "POST",
    });
    expect(c.body).toMatchObject({ status: "running", cancelRequested: true });
    expect(
      (
        await call(`/worker/tasks/${id}/status`, worker.token, {
          json: { status: "cancelled" },
        })
      ).body.status,
    ).toBe("cancelled");
    expect(
      (await call(`/owner/tasks/${id}/cancel`, ac.token, { method: "POST" }))
        .status,
    ).toBe(400);
    const f = await call(`/owner/tasks/${id}/followup`, ac.token, {
      json: { prompt: "try again" },
    });
    expect(f.status).toBe(201);
    expect(f.body).toMatchObject({ parent: id, status: "awaiting_tap" });
    await call(`/owner/tasks/${f.body.id}/start`, ac.token, { method: "POST" });
    expect(
      (await call("/worker/next?wait=0", worker.token)).body.task,
    ).toMatchObject({ id: f.body.id, resumeSessionId: "s1" });
  });
});

describe("worker routes", () => {
  it("only a worker token; never /owner/*; a task of another machine is 404", async () => {
    const { call, create, worker, other, bobWorker, ac, ag, audit } =
      await setup();
    expect((await call("/worker/next?wait=0", ac.token)).status).toBe(403);
    expect((await call("/worker/next?wait=0", ag.token)).status).toBe(403);
    expect(audit("worker.auth").length).toBe(2);
    expect((await call("/owner/me", worker.token)).status).toBe(403);
    const id = (await create()).body.id;
    expect((await call("/worker/next?wait=0", other.token)).status).toBe(204);
    expect((await call("/worker/next?wait=0", bobWorker.token)).status).toBe(
      204,
    );
    expect(
      (
        await call(`/worker/tasks/${id}/status`, other.token, {
          json: { status: "running" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(`/worker/tasks/${id}/events`, other.token, {
          json: { events: [{ type: "progress" }] },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(`/worker/tasks/${id}/tool-approvals`, other.token, {
          json: { tool: "Bash", summary: "s", category: "push" },
        })
      ).status,
    ).toBe(404);
    expect((await call("/worker/next?wait=0", worker.token)).body.task.id).toBe(
      id,
    );
    expect((await call("/worker/next?wait=0", worker.token)).status).toBe(204);
    expect((await call("/worker/next?wait=abc", worker.token)).status).toBe(
      400,
    );
    expect((await call("/worker/nothing", worker.token)).status).toBe(404);
  });

  it("events, status transitions, heartbeat and the kill switch", async () => {
    const { call, create, worker, ac, audit } = await setup();
    const id = (await create()).body.id;
    await call("/worker/next?wait=0", worker.token);
    expect(audit("worker.task.claim")).toHaveLength(1);
    let r = await call(`/worker/tasks/${id}/events`, worker.token, {
      json: {
        events: [
          { type: "started", data: { pid: 1 } },
          { type: "progress", data: { text: "x" } },
        ],
      },
    });
    expect(r).toEqual({ status: 200, body: { cancel: false, killed: false } });
    expect(
      (
        await call(`/worker/tasks/${id}/events`, worker.token, {
          json: { events: [{ type: "bogus" }] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`/worker/tasks/${id}/status`, worker.token, {
          json: { status: "queued" },
        })
      ).status,
    ).toBe(400);
    expect(audit("worker.task.status").at(0)!.ok).toBe(false);
    r = await call(`/worker/tasks/${id}/status`, worker.token, {
      json: { status: "running" },
    });
    expect(r.body).toEqual({
      id,
      status: "running",
      cancel: false,
      killed: false,
    });
    await call("/owner/machines/mini", ac.token, {
      method: "PATCH",
      body: JSON.stringify({ killed: true }),
    });
    expect(
      (
        await call("/worker/heartbeat", worker.token, {
          json: { running: [id] },
        })
      ).body,
    ).toEqual({ cancel: [id], killed: true });
    expect(
      (
        await call("/worker/heartbeat", worker.token, {
          json: { running: "x" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`/worker/tasks/${id}/tool-approvals`, worker.token, {
          json: { tool: "Bash", summary: "s", category: "push" },
        })
      ).status,
    ).toBe(400);
    r = await call(`/worker/tasks/${id}/status`, worker.token, {
      json: { status: "cancelled", exitCode: 130 },
    });
    expect(r.body.status).toBe("cancelled");
    const ev = (
      await call(`/owner/tasks/${id}/events`, ac.token)
    ).body.events.map((e: any) => e.type);
    expect(ev).toEqual([
      "created",
      "accepted",
      "started",
      "progress",
      "status",
      "cancel_requested",
      "status",
    ]);
  });

  it("a long-poll next wakes up when the owner queues a task", async () => {
    const { call, create, worker } = await setup();
    const p = call("/worker/next?wait=10", worker.token);
    await new Promise((r) => setTimeout(r, 50));
    const id = (await create()).body.id;
    const r = await p;
    expect(r.status).toBe(200);
    expect(r.body.task.id).toBe(id);
  });

  it("an approval long-poll wakes on the decision", async () => {
    const { call, create, worker, ac } = await setup();
    const id = (await create()).body.id;
    await call("/worker/next?wait=0", worker.token);
    const aid = (
      await call(`/worker/tasks/${id}/tool-approvals`, worker.token, {
        json: { tool: "Bash", summary: "rm -rf build", category: ["delete"] },
      })
    ).body.id;
    expect(
      (await call(`/worker/tool-approvals/${aid}?wait=0`, worker.token)).body
        .status,
    ).toBe("pending");
    const p = call(`/worker/tool-approvals/${aid}?wait=10`, worker.token);
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    await call(`/owner/tasks/${id}/approvals/${aid}`, ac.token, {
      json: { decision: "reject" },
    });
    expect((await p).body.status).toBe("rejected");
  });
});
