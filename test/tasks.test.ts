import { describe, expect, it } from "vitest";
import { GrantError, parseGrants, parseGrantSpec } from "../src/grants.ts";
import {
  DEFAULT_POLICY,
  parsePolicy,
  TaskError,
  TOOL_APPROVAL_TTL_MS,
  AWAITING_TAP_TTL_MS,
} from "../src/tasks/service.ts";
import { addMachine, flush, world } from "./helpers.ts";

const W = "worker:mini-worker";

function setup(policy: Record<string, unknown> = {}) {
  const w = world();
  addMachine(w, "mini", "alice", policy);
  const t = w.relay.tasks;
  const make = (body: Record<string, unknown> = {}) =>
    t.create("alice", "alice-console", {
      machine: "mini",
      folder: "/work/app",
      prompt: "run the tests",
      ...body,
    });
  return { w, t, make };
}

const err = (fn: () => unknown): TaskError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof TaskError) return e;
    throw e;
  }
  throw new Error("expected a TaskError");
};

describe("policy schema", () => {
  it("a new machine gets the strict default", () => {
    const w = world();
    const m = w.relay.tasks.addMachine({
      id: "box",
      owner: "alice",
      name: "Box",
    });
    expect(m.policy).toEqual(DEFAULT_POLICY);
    expect(m.policy.folders).toEqual([]);
    expect(m.policy.requireTap).toBe(true);
    expect(m.policy.permissionMode).toBe("default");
  });

  it("refuses bypassPermissions, runtime out of 1..240, relative paths, .. and unknown keys", () => {
    expect(
      err(() => parsePolicy({ permissionMode: "bypassPermissions" })).message,
    ).toMatch(/bypassPermissions/);
    expect(err(() => parsePolicy({ maxRuntimeMinutes: 0 })).status).toBe(400);
    expect(err(() => parsePolicy({ maxRuntimeMinutes: 241 })).status).toBe(400);
    expect(parsePolicy({ maxRuntimeMinutes: 240 }).maxRuntimeMinutes).toBe(240);
    expect(err(() => parsePolicy({ folders: ["work"] })).status).toBe(400);
    expect(err(() => parsePolicy({ folders: ["/work/../etc"] })).status).toBe(
      400,
    );
    expect(err(() => parsePolicy({ approvalActions: ["format"] })).status).toBe(
      400,
    );
    expect(err(() => parsePolicy({ shell: true })).status).toBe(400);
    expect(err(() => parsePolicy([])).status).toBe(400);
  });

  it("tool rules are Tool or Tool(pattern), at most 64 of at most 200 chars", () => {
    const ok = [
      "Read",
      "mcp__web-app__search",
      "Bash(git status:*)",
      "Bash(pnpm test:*)",
      "WebFetch(domain:example.com)",
    ];
    expect(parsePolicy({ allowedTools: ok }).allowedTools).toEqual(ok);
    for (const bad of [
      "",
      "Bash(",
      "Bash()",
      "(x)",
      "Read Write",
      "Bash(ls)x",
      "1Read",
      `Bash(${"x".repeat(200)})`,
    ]) {
      expect(err(() => parsePolicy({ allowedTools: [bad] })).status).toBe(400);
      expect(err(() => parsePolicy({ disallowedTools: [bad] })).status).toBe(
        400,
      );
    }
    const many = Array.from({ length: 65 }, (_, i) => `Tool${i}`);
    expect(err(() => parsePolicy({ allowedTools: many })).status).toBe(400);
    expect(parsePolicy({ allowedTools: many.slice(0, 64) }).allowedTools).toHaveLength(64);
  });

  it("a partial update merges over the current policy", () => {
    const { t } = setup();
    const m = t.updateMachine(
      "alice",
      "mini",
      { policy: { maxRuntimeMinutes: 60 } },
      "alice-console",
    );
    expect(m.policy.folders).toEqual(["/work"]);
    expect(m.policy.maxRuntimeMinutes).toBe(60);
  });
});

describe("machine grants", () => {
  it("needs rw, one per token, an existing machine of the same owner, and nothing else", () => {
    const w = world();
    w.relay.tasks.addMachine({ id: "mini", owner: "alice", name: "mini" });
    expect(() => parseGrants(["machine:*:rw"])).toThrow(GrantError);
    expect(() => parseGrantSpec("machine:*:rw")).toThrow(GrantError);
    const mk = (label: string, owner: string, ...g: string[]) =>
      w.relay.tokens.create({ label, owner, grants: g.map(parseGrantSpec) });
    expect(() => mk("a", "alice", "machine:mini:r")).toThrow(GrantError);
    expect(() => mk("b", "alice", "machine:mini:rw", "peer:team:rw")).toThrow(
      GrantError,
    );
    expect(() => mk("c", "alice", "machine:mini:rw", "owner:alice:rw")).toThrow(
      GrantError,
    );
    expect(() => mk("d", "alice", "machine:nope:rw")).toThrow(GrantError);
    expect(() => mk("e", "bob", "machine:mini:rw")).toThrow(GrantError);
    expect(mk("f", "alice", "machine:mini:rw").info.grants).toHaveLength(1);
  });
});

describe("creating tasks", () => {
  it("queued without requireTap, awaiting_tap with it, with a created event", () => {
    const { t, make, w } = setup();
    const a = make({ priority: "high" });
    expect(a).toMatchObject({
      status: "queued",
      machine: "mini",
      machineName: "mini",
      priority: "high",
      createdBy: "alice-console",
    });
    expect(t.events("alice", a.id).map((e) => e.type)).toEqual(["created"]);
    t.updateMachine("alice", "mini", { policy: { requireTap: true } }, "x");
    expect(make().status).toBe("awaiting_tap");
    expect(w.relay.tasks.pendingCount("alice")).toBe(1);
  });

  it("refuses a killed machine, a folder outside the policy, an empty or long prompt, a bad priority, another owner", () => {
    const { t, make } = setup();
    expect(err(() => make({ folder: "/etc" })).message).toMatch(/policy/);
    expect(err(() => make({ folder: "/workshop" })).status).toBe(400);
    expect(err(() => make({ folder: "/work/../etc" })).status).toBe(400);
    expect(err(() => make({ folder: "work" })).status).toBe(400);
    expect(err(() => make({ prompt: "  " })).message).toMatch(/prompt/);
    expect(err(() => make({ prompt: "x".repeat(20_001) })).status).toBe(400);
    expect(err(() => make({ priority: "urgent" })).status).toBe(400);
    expect(err(() => make({ machine: "nope" })).status).toBe(404);
    expect(
      err(() =>
        t.create("bob", "bob-console", {
          machine: "mini",
          folder: "/work",
          prompt: "p",
        }),
      ).status,
    ).toBe(404);
    t.updateMachine("alice", "mini", { killed: true }, "x");
    expect(err(() => make()).message).toMatch(/killed/);
  });

  it("a default-policy machine refuses every task until it has a folder", () => {
    const w = world();
    w.relay.tasks.addMachine({ id: "box", owner: "alice", name: "Box" });
    expect(
      err(() =>
        w.relay.tasks.create("alice", "c", {
          machine: "box",
          folder: "/",
          prompt: "p",
        }),
      ).status,
    ).toBe(400);
  });
});

describe("lifecycle", () => {
  it("claims by priority then age, runs, finishes; result and session are kept", () => {
    const { t, make, w } = setup();
    const low = make({ priority: "low" });
    w.clock.t += 1000;
    const n1 = make();
    w.clock.t += 1000;
    const hi = make({ priority: "high" });
    w.clock.t += 1000;
    const n2 = make();
    const order = [
      t.claim("mini", W)!,
      t.claim("mini", W)!,
      t.claim("mini", W)!,
      t.claim("mini", W)!,
    ].map((x) => x.id);
    expect(order).toEqual([hi.id, n1.id, n2.id, low.id]);
    expect(t.claim("mini", W)).toBeUndefined();
    expect(t.get("alice", hi.id).status).toBe("accepted");
    expect(
      t.workerStatus(
        "mini",
        hi.id,
        { status: "running", sessionId: "sess-1" },
        W,
      ).status,
    ).toBe("running");
    t.workerEvents("mini", hi.id, [{ type: "progress", data: { text: "hi" } }], W);
    const out = t.workerStatus(
      "mini",
      hi.id,
      { status: "done", result: "all green", exitCode: 0 },
      W,
    );
    expect(out).toMatchObject({ status: "done", cancel: false, killed: false });
    const v = t.get("alice", hi.id);
    expect(v).toMatchObject({
      status: "done",
      result: "all green",
      exitCode: 0,
      sessionId: "sess-1",
    });
    expect(v.startedAt).not.toBeNull();
    expect(v.finishedAt).not.toBeNull();
    expect(t.events("alice", hi.id).map((e) => e.type)).toEqual([
      "created",
      "accepted",
      "status",
      "progress",
      "status",
    ]);
  });

  it("refuses illegal transitions and unknown event types", () => {
    const { t, make } = setup();
    const a = make();
    expect(
      err(() => t.workerStatus("mini", a.id, { status: "running" }, W)).message,
    ).toMatch(/illegal/);
    expect(
      err(() => t.workerStatus("mini", a.id, { status: "queued" }, W)).status,
    ).toBe(400);
    t.claim("mini", W);
    expect(
      err(() =>
        t.workerStatus("mini", a.id, { status: "done", exitCode: 1.5 }, W),
      ).status,
    ).toBe(400);
    expect(
      err(() => t.workerStatus("mini", a.id, { status: "done", result: 7 }, W))
        .status,
    ).toBe(400);
    t.workerStatus(
      "mini",
      a.id,
      { status: "failed", error: "boom", exitCode: 1 },
      W,
    );
    expect(
      err(() => t.workerStatus("mini", a.id, { status: "running" }, W)).status,
    ).toBe(400);
    expect(
      err(() => t.workerStatus("mini", a.id, { status: "done" }, W)).status,
    ).toBe(400);
    expect(
      err(() => t.workerEvents("mini", a.id, [{ type: "status" }], W)).status,
    ).toBe(400);
    expect(err(() => t.workerEvents("mini", a.id, [], W)).status).toBe(400);
    expect(
      err(() =>
        t.workerEvents("mini", a.id, Array(51).fill({ type: "progress" }), W),
      ).status,
    ).toBe(400);
  });

  it("a worker of another machine gets 404", () => {
    const { t, make, w } = setup();
    addMachine(w, "other", "alice");
    const a = make();
    expect(
      err(() => t.workerStatus("other", a.id, { status: "running" }, W)).status,
    ).toBe(404);
    expect(
      err(() => t.workerEvents("other", a.id, [{ type: "progress" }], W)).status,
    ).toBe(404);
    expect(t.claim("other", W)).toBeUndefined();
  });

  it("start moves awaiting_tap to queued; start on anything else is 400", () => {
    const { t, make } = setup({ requireTap: true });
    const a = make();
    expect(t.claim("mini", W)).toBeUndefined();
    expect(t.startTask("alice", a.id, "c").status).toBe("queued");
    expect(err(() => t.startTask("alice", a.id, "c")).status).toBe(400);
    expect(err(() => t.startTask("bob", a.id, "c")).status).toBe(404);
    expect(t.claim("mini", W)!.id).toBe(a.id);
  });

  it("cancel: queued at once, running by request, terminal is 400", () => {
    const { t, make } = setup();
    const q = make();
    const r = make();
    expect(t.cancel("alice", q.id, "c").status).toBe("cancelled");
    expect(err(() => t.cancel("alice", q.id, "c")).status).toBe(400);
    t.claim("mini", W);
    t.workerStatus("mini", r.id, { status: "running" }, W);
    const v = t.cancel("alice", r.id, "c");
    expect(v).toMatchObject({ status: "running", cancelRequested: true });
    expect(t.heartbeat("mini", [r.id])).toEqual({
      cancel: [r.id],
      killed: false,
    });
    expect(t.workerEvents("mini", r.id, [{ type: "progress" }], W).cancel).toBe(
      true,
    );
    expect(
      t.workerStatus("mini", r.id, { status: "cancelled" }, W).status,
    ).toBe("cancelled");
  });

  it("a follow-up resumes the parent session and needs a finished parent and the policy", () => {
    const { t, make } = setup();
    const p = make();
    expect(
      err(() => t.followup("alice", p.id, { prompt: "more" }, "c")).status,
    ).toBe(400);
    t.claim("mini", W);
    t.workerStatus("mini", p.id, { status: "done", sessionId: "sess-9" }, W);
    const f = t.followup("alice", p.id, { prompt: "and now the docs" }, "c");
    expect(f).toMatchObject({
      parent: p.id,
      folder: "/work/app",
      status: "queued",
    });
    expect(t.events("alice", p.id).at(-1)!.type).toBe("followup");
    const claimed = t.claim("mini", W)!;
    expect(claimed).toMatchObject({
      id: f.id,
      resumeSessionId: "sess-9",
      parent: p.id,
    });
    expect(
      err(() => t.followup("bob", p.id, { prompt: "x" }, "c")).status,
    ).toBe(404);
    t.updateMachine(
      "alice",
      "mini",
      { policy: { allowFollowUps: false } },
      "c",
    );
    expect(
      err(() => t.followup("alice", p.id, { prompt: "x" }, "c")).message,
    ).toMatch(/follow-ups/);
  });

  it("a task whose folder left the policy fails at claim", () => {
    const { t, make } = setup();
    const a = make();
    t.updateMachine("alice", "mini", { policy: { folders: ["/other"] } }, "c");
    expect(t.claim("mini", W)).toBeUndefined();
    expect(t.get("alice", a.id)).toMatchObject({ status: "failed" });
  });

  it("unclaim puts an accepted task back", () => {
    const { t, make } = setup();
    const a = make();
    t.claim("mini", W);
    t.unclaim("mini", a.id);
    expect(t.get("alice", a.id).status).toBe("queued");
  });
});

describe("kill switch", () => {
  it("cancels queued and awaiting_tap, requests cancel on running, rejects approvals, blocks claim and start", () => {
    const { t, make } = setup();
    const running = make();
    t.claim("mini", W);
    t.workerStatus("mini", running.id, { status: "running" }, W);
    const apv = t.requestApproval(
      "mini",
      running.id,
      { tool: "Bash", summary: "git push", category: "push" },
      W,
    );
    const queued = make();
    t.updateMachine("alice", "mini", { policy: { requireTap: true } }, "c");
    const tap = make();
    const m = t.updateMachine("alice", "mini", { killed: true }, "c");
    expect(m.killed).toBe(true);
    expect(t.get("alice", queued.id).status).toBe("cancelled");
    expect(t.get("alice", tap.id).status).toBe("cancelled");
    expect(t.get("alice", running.id).cancelRequested).toBe(true);
    expect(t.get("alice", running.id).pendingApprovals).toEqual([]);
    expect(t.heartbeat("mini", [running.id])).toEqual({
      cancel: [running.id],
      killed: true,
    });
    expect(
      err(() =>
        t.requestApproval(
          "mini",
          running.id,
          { tool: "Bash", summary: "s", category: "push" },
          W,
        ),
      ).message,
    ).toMatch(/killed/);
    expect(t.claim("mini", W)).toBeUndefined();
    t.updateMachine("alice", "mini", { killed: false }, "c");
    expect(t.get("alice", queued.id).status).toBe("cancelled");
    expect(apv.id).toMatch(/^ta_/);
  });

  it("only the machine owner may change it", () => {
    const { t } = setup();
    expect(
      err(() => t.updateMachine("bob", "mini", { killed: true }, "c")).status,
    ).toBe(404);
    expect(err(() => t.updateMachine("alice", "mini", {}, "c")).status).toBe(
      400,
    );
    expect(
      err(() => t.updateMachine("alice", "mini", { killed: "yes" }, "c"))
        .status,
    ).toBe(400);
  });
});

describe("tool approvals", () => {
  function running() {
    const s = setup();
    const a = s.make();
    s.t.claim("mini", W);
    s.t.workerStatus("mini", a.id, { status: "running" }, W);
    return { ...s, a };
  }

  it("waiting_approval until decided; approve puts it back to running and notifies the owner", async () => {
    const { t, a, w } = running();
    const r = t.requestApproval(
      "mini",
      a.id,
      { tool: "Bash", summary: "git push origin main", category: ["push"] },
      W,
    );
    await flush();
    expect(w.ch.alice!.notices().at(-1)).toMatch(/git push origin main/);
    expect(t.get("alice", a.id)).toMatchObject({ status: "waiting_approval" });
    expect(t.get("alice", a.id).pendingApprovals.map((p) => p.id)).toEqual([
      r.id,
    ]);
    expect(t.pendingCount("alice")).toBe(1);
    expect(err(() => t.decide("bob", a.id, r.id, "approve", "c")).status).toBe(
      404,
    );
    expect(err(() => t.decide("alice", a.id, r.id, "maybe", "c")).status).toBe(
      400,
    );
    expect(
      err(() => t.decide("alice", a.id, "ta_nope", "approve", "c")).status,
    ).toBe(404);
    const d = t.decide("alice", a.id, r.id, "approve", "c");
    expect(d.approval.status).toBe("approved");
    expect(d.task.status).toBe("running");
    expect(err(() => t.decide("alice", a.id, r.id, "reject", "c")).status).toBe(
      409,
    );
    expect((await t.approvalStatus("mini", r.id, 0)).status).toBe("approved");
    await expect(t.approvalStatus("other", r.id, 0)).rejects.toThrow(TaskError);
  });

  it("refuses bad categories, missing fields and finished tasks", () => {
    const { t, a } = running();
    expect(
      err(() =>
        t.requestApproval(
          "mini",
          a.id,
          { tool: "Bash", summary: "s", category: "format" },
          W,
        ),
      ).status,
    ).toBe(400);
    expect(
      err(() =>
        t.requestApproval(
          "mini",
          a.id,
          { tool: "", summary: "s", category: "push" },
          W,
        ),
      ).status,
    ).toBe(400);
    expect(
      err(() =>
        t.requestApproval("mini", a.id, { tool: "Bash", category: "push" }, W),
      ).status,
    ).toBe(400);
    t.workerStatus("mini", a.id, { status: "done" }, W);
    expect(
      err(() =>
        t.requestApproval(
          "mini",
          a.id,
          { tool: "Bash", summary: "s", category: "push" },
          W,
        ),
      ).status,
    ).toBe(400);
  });

  it("expires after 15 minutes (fail closed)", async () => {
    const { t, a, w } = running();
    const r = t.requestApproval(
      "mini",
      a.id,
      { tool: "Bash", summary: "deploy", category: "deploy,prod" },
      W,
    );
    w.clock.t += TOOL_APPROVAL_TTL_MS;
    expect((await t.approvalStatus("mini", r.id, 0)).status).toBe("expired");
    expect(
      err(() => t.decide("alice", a.id, r.id, "approve", "c")).status,
    ).toBe(409);
    expect(t.get("alice", a.id).status).toBe("running");
  });

  it("a finished task expires its pending approvals", () => {
    const { t, a } = running();
    const r = t.requestApproval(
      "mini",
      a.id,
      { tool: "Bash", summary: "s", category: "delete" },
      W,
    );
    t.workerStatus("mini", a.id, { status: "failed" }, W);
    expect(t.get("alice", a.id).pendingApprovals).toEqual([]);
    expect(
      t.log("alice", { task: a.id }).find((e) => e.type === "approval_decided")!
        .data,
    ).toMatchObject({ id: r.id, status: "expired" });
  });

  it("pending approvals expire at boot; awaiting_tap expires after 24 h", async () => {
    const { t, a, w, make } = running();
    const r = t.requestApproval(
      "mini",
      a.id,
      { tool: "Bash", summary: "s", category: "push" },
      W,
    );
    expect(t.restart()).toBe(1);
    expect((await t.approvalStatus("mini", r.id, 0)).status).toBe("expired");
    t.updateMachine("alice", "mini", { policy: { requireTap: true } }, "c");
    const tap = make();
    w.clock.t += AWAITING_TAP_TTL_MS + 1;
    expect(t.get("alice", tap.id).status).toBe("cancelled");
    expect(t.events("alice", tap.id).map((e) => e.type)).toContain("expired");
  });
});

describe("long-poll", () => {
  it("next wakes when a task is queued", async () => {
    const { t, make } = setup();
    const p = t.next("mini", W, 5000);
    await flush();
    expect(t.waiting()).toBe(1);
    const a = make();
    expect((await p)!.id).toBe(a.id);
    expect(t.waiting()).toBe(0);
  });

  it("next returns nothing after the wait, or when aborted", async () => {
    const { t } = setup();
    expect(await t.next("mini", W, 20)).toBeUndefined();
    const ac = new AbortController();
    const p = t.next("mini", W, 5000, ac.signal);
    await flush();
    ac.abort();
    expect(await p).toBeUndefined();
    expect(t.waiting()).toBe(0);
  });

  it("an approval long-poll wakes on the decision", async () => {
    const { t, make } = setup();
    const a = make();
    t.claim("mini", W);
    const r = t.requestApproval(
      "mini",
      a.id,
      { tool: "Bash", summary: "s", category: "push" },
      W,
    );
    const p = t.approvalStatus("mini", r.id, 5000);
    await flush();
    t.decide("alice", a.id, r.id, "reject", "c");
    expect((await p).status).toBe("rejected");
  });
});

describe("append-only logs", () => {
  it("task_events and audit refuse UPDATE and DELETE", () => {
    const { w, make } = setup();
    make();
    w.relay.audit.write({ actor: "cli", action: "x", target: "y", ok: true });
    for (const table of ["task_events", "audit"]) {
      expect(() =>
        w.relay.db.exec(`UPDATE ${table} SET actor = 'evil'`),
      ).toThrow(/append-only/);
      expect(() => w.relay.db.exec(`DELETE FROM ${table}`)).toThrow(
        /append-only/,
      );
    }
  });
});
