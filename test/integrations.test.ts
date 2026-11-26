import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  SecretBox,
  SecretKeyError,
  parseSecretKey,
} from "../src/integrations/secrets.ts";
import {
  LINEAR_URL,
  LinearClient,
  LinearError,
} from "../src/integrations/linear.ts";
import { loadConfig } from "../src/config.ts";
import { addMachine, serveHttp, world } from "./helpers.ts";

const KEY_HEX = "11".repeat(32);
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const SECRET = "lin_api_TESTSECRET0123456789abcdWXYZ"; // gitleaks:allow (fake test key)

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

interface Call {
  url: string;
  auth: string | null;
  query: string;
  variables: Record<string, unknown>;
}

/** A fake Linear: answers by the operation in the query and records every call. */
function fakeLinear(opts: { reject?: boolean } = {}) {
  const calls: Call[] = [];
  const state = { reject: opts.reject ?? false };
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      auth: headers.get("authorization"),
      query: body.query,
      variables: body.variables,
    });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (state.reject || headers.get("authorization") !== SECRET)
      return json(401, {
        errors: [{ message: "Authentication required, not authenticated" }],
      });
    if (body.query.includes("viewer"))
      return json(200, {
        data: {
          viewer: { id: "u1", name: "Alice", email: "alice@example.com" },
        },
      });
    if (body.query.includes("team(id")) {
      if (body.variables.id !== "t1")
        return json(200, { data: { team: null } });
      return json(200, {
        data: {
          team: {
            projects: {
              nodes: [{ id: "p1", name: "Launch", state: "started" }],
            },
          },
        },
      });
    }
    if (body.query.includes("teams"))
      return json(200, {
        data: { teams: { nodes: [{ id: "t1", key: "WEB", name: "Web" }] } },
      });
    if (body.query.includes("issueCreate")) {
      return json(200, {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "i1",
              identifier: "WEB-12",
              url: "https://linear.app/example/issue/WEB-12",
              title: (body.variables.input as any).title,
            },
          },
        },
      });
    }
    return json(400, { errors: [{ message: "unknown query" }] });
  }) as typeof fetch;
  return { fn, calls, state };
}

async function setup(o: { secretKey?: string | null; reject?: boolean } = {}) {
  const linear = fakeLinear(o.reject ? { reject: true } : {});
  const w = world({
    channels: [],
    ...(o.secretKey === null ? {} : { secretKey: o.secretKey ?? KEY_HEX }),
    integrationFetch: linear.fn,
  });
  w.relay.tokens.addOwner({ id: "carol", name: "Carol" });
  w.relay.teams.add({ id: "web", name: "Web" });
  w.relay.teams.setMember("web", "alice", "admin");
  w.relay.teams.setMember("web", "bob", "member");
  addMachine(w, "mini", "alice");
  addMachine(w, "bob-box", "bob");
  const alice = w.agent("alice-console", "alice", "owner:alice:rw").token;
  const bob = w.agent("bob-console", "bob", "owner:bob:rw").token;
  const carol = w.agent("carol-console", "carol", "owner:carol:rw").token;
  const { call, close } = await serveHttp(w);
  closers.push(close);
  const audit = (action: string) =>
    w.relay.audit.recent(1000).filter((a) => a.action === action)
      .reverse();
  return { w, call, alice, bob, carol, audit, linear };
}

describe("secrets", () => {
  it("round-trips with a hex or base64 key and refuses another key", () => {
    const box = new SecretBox(parseSecretKey(KEY_HEX));
    const sealed = box.encrypt(SECRET);
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain(SECRET);
    expect(box.encrypt(SECRET)).not.toBe(sealed); // fresh IV each time
    expect(box.decrypt(sealed)).toBe(SECRET);
    const other = new SecretBox(parseSecretKey(KEY_B64));
    expect(other.decrypt(other.encrypt("x"))).toBe("x");
    expect(() => other.decrypt(sealed)).toThrow(SecretKeyError);
    expect(() => box.decrypt(sealed.slice(0, -4) + "AAAA")).toThrow(
      SecretKeyError,
    );
  });

  it("rejects keys that are not 32 bytes, at boot", () => {
    expect(() => parseSecretKey("abc")).toThrow(SecretKeyError);
    expect(() => parseSecretKey(randomBytes(16).toString("base64"))).toThrow(
      SecretKeyError,
    );
    expect(() => loadConfig({ RELAY_SECRET_KEY: "short" })).toThrow(
      /RELAY_SECRET_KEY/,
    );
    expect(loadConfig({ RELAY_SECRET_KEY: KEY_B64 }).secretKey).toBe(KEY_B64);
    expect(loadConfig({}).secretKey).toBeUndefined();
  });
});

describe("linear client", () => {
  it("posts GraphQL with the raw key and maps answers", async () => {
    const f = fakeLinear();
    const c = new LinearClient(SECRET, f.fn);
    expect(await c.viewer()).toEqual({
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
    });
    expect(await c.teams()).toEqual([{ id: "t1", key: "WEB", name: "Web" }]);
    expect(await c.projects("t1")).toEqual([
      { id: "p1", name: "Launch", state: "started" },
    ]);
    const issue = await c.createIssue({
      teamId: "t1",
      projectId: "p1",
      title: "Fix",
      description: "d",
    });
    expect(issue.identifier).toBe("WEB-12");
    expect(
      f.calls.every((x) => x.url === LINEAR_URL && x.auth === SECRET),
    ).toBe(true);
    expect(f.calls.at(-1)!.variables).toEqual({
      input: { teamId: "t1", projectId: "p1", title: "Fix", description: "d" },
    });
    await expect(c.projects("nope")).rejects.toThrow(LinearError);
  });

  it("reports a rejected key without echoing it", async () => {
    const c = new LinearClient("wrong-key-123456", fakeLinear().fn);
    const err = (await c.viewer().then(
      () => undefined,
      (e: unknown) => e,
    )) as LinearError;
    expect(err).toBeInstanceOf(LinearError);
    expect(err.httpStatus).toBe(401);
    expect(err.message).not.toContain("wrong-key-123456");
  });
});

describe("console: integrations", () => {
  it("creates with a sealed secret and never returns it", async () => {
    const { w, call, alice, audit } = await setup();
    const r = await call("/owner/integrations", alice, {
      json: { kind: "linear", name: "Linear", secret: SECRET },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      kind: "linear",
      name: "Linear",
      secretLast4: "WXYZ",
      status: "unchecked",
      teamId: null,
      canWrite: true,
    });
    expect(r.body.secretEnc).toBeUndefined();
    expect(r.text).not.toContain(SECRET);
    const id = r.body.id;

    const row = w.relay.db
      .prepare("SELECT secret_enc FROM integrations WHERE id = ?")
      .get(id) as { secret_enc: string };
    expect(row.secret_enc).not.toContain(SECRET);

    for (const path of [
      "/owner/integrations",
      `/owner/integrations/${id}`,
      "/owner/audit?limit=200",
    ]) {
      expect((await call(path, alice)).text).not.toContain(SECRET);
    }
    const dump = JSON.stringify(w.relay.audit.recent(1000));
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("TESTSECRET");
    expect(audit("console.integration.create")).toHaveLength(1);
  });

  it("validates kind and input with zod", async () => {
    const { call, alice } = await setup();
    expect(
      (
        await call("/owner/integrations", alice, {
          json: { kind: "github", name: "x", secret: SECRET },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/owner/integrations", alice, {
          json: { kind: "linear", name: "x", secret: "short" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/owner/integrations", alice, {
          json: { kind: "linear", name: "", secret: SECRET },
        })
      ).status,
    ).toBe(400);
  });

  it("refuses to store a secret without RELAY_SECRET_KEY, with a clear message", async () => {
    const { call, alice, audit } = await setup({ secretKey: null });
    const r = await call("/owner/integrations", alice, {
      json: { kind: "linear", name: "Linear", secret: SECRET },
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/RELAY_SECRET_KEY is not set/);
    expect(r.text).not.toContain(SECRET);
    expect(audit("console.integration.create")[0]!.ok).toBe(false);
  });

  it("tests the key: ok, then error after rotating to a rejected one", async () => {
    const { call, alice, linear, audit } = await setup();
    const id = (
      await call("/owner/integrations", alice, {
        json: { kind: "linear", name: "Linear", secret: SECRET },
      })
    ).body.id;
    let r = await call(`/owner/integrations/${id}/test`, alice, { json: {} });
    expect(r.status).toBe(200);
    expect(r.body.integration).toMatchObject({ status: "ok", lastError: null });
    expect(r.body.integration.lastCheckedAt).toBeTruthy();
    expect(r.body.viewer).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(linear.calls[0]!.auth).toBe(SECRET);

    // Rotate: new last4, status back to unchecked.
    r = await call(`/owner/integrations/${id}`, alice, {
      method: "PATCH",
      json: { secret: "lin_api_OTHERKEY_9876" }, // gitleaks:allow (fake test key)
    });
    expect(r.body).toMatchObject({ secretLast4: "9876", status: "unchecked" });
    expect(r.text).not.toContain("OTHERKEY");
    r = await call(`/owner/integrations/${id}/test`, alice, { json: {} });
    expect(r.body.integration.status).toBe("error");
    expect(r.body.integration.lastError).toMatch(/rejected the API key/);
    expect(r.body.viewer).toBeNull();
    const rows = audit("console.integration.update");
    expect(rows[0]!.detail).toBe("secret rotated");
    expect(JSON.stringify(w_audit(audit))).not.toContain("OTHERKEY");
  });

  it("team integrations: members read and pick, only admins and the creator write; strangers 404", async () => {
    const { call, alice, bob, carol } = await setup();
    const r = await call("/owner/integrations", alice, {
      json: {
        kind: "linear",
        name: "Team Linear",
        secret: SECRET,
        teamId: "web",
      },
    });
    const id = r.body.id;
    expect(
      (await call("/owner/integrations", bob)).body.integrations.map(
        (i: any) => [i.id, i.canWrite],
      ),
    ).toEqual([[id, false]]);
    expect(
      (await call(`/owner/integrations/${id}/linear/teams`, bob)).body,
    ).toEqual({ teams: [{ id: "t1", key: "WEB", name: "Web" }] });
    expect(
      (await call(`/owner/integrations/${id}/linear/teams/t1/projects`, bob))
        .body,
    ).toEqual({
      projects: [{ id: "p1", name: "Launch", state: "started" }],
    });
    expect(
      (await call(`/owner/integrations/${id}/linear/teams/zz/projects`, bob))
        .status,
    ).toBe(404);
    expect(
      (
        await call(`/owner/integrations/${id}`, bob, {
          method: "PATCH",
          json: { name: "mine" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(`/owner/integrations/${id}/test`, bob, { json: {} })).status,
    ).toBe(403);
    expect(
      (await call(`/owner/integrations/${id}`, bob, { method: "DELETE" }))
        .status,
    ).toBe(403);
    expect((await call(`/owner/integrations/${id}`, carol)).status).toBe(404);
    expect(
      (await call(`/owner/integrations/${id}/linear/teams`, carol)).status,
    ).toBe(404);
    expect(
      (await call("/owner/integrations", carol)).body.integrations,
    ).toEqual([]);
    expect(
      (
        await call("/owner/integrations", carol, {
          json: { kind: "linear", name: "x", secret: SECRET, teamId: "web" },
        })
      ).status,
    ).toBe(404);
  });

  it("a Linear failure on a picker is 502 and marks a rejected key", async () => {
    const { call, alice, linear } = await setup();
    const id = (
      await call("/owner/integrations", alice, {
        json: { kind: "linear", name: "L", secret: SECRET },
      })
    ).body.id;
    linear.state.reject = true;
    const r = await call(`/owner/integrations/${id}/linear/teams`, alice);
    expect(r.status).toBe(502);
    expect(r.text).not.toContain(SECRET);
    expect((await call(`/owner/integrations/${id}`, alice)).body.status).toBe(
      "error",
    );
  });

  it("deletes an integration with its project links", async () => {
    const { call, alice, audit } = await setup();
    const id = (
      await call("/owner/integrations", alice, {
        json: { kind: "linear", name: "L", secret: SECRET },
      })
    ).body.id;
    const p = (await call("/owner/projects", alice, { json: { name: "Site" } }))
      .body;
    await call(`/owner/projects/${p.id}/links`, alice, {
      json: {
        integrationId: id,
        externalType: "linear_team",
        externalId: "t1",
        externalName: "Web",
      },
    });
    expect(
      (await call(`/owner/integrations/${id}`, alice, { method: "DELETE" }))
        .body,
    ).toEqual({ deleted: id });
    expect((await call(`/owner/projects/${p.id}`, alice)).body.links).toEqual(
      [],
    );
    expect((await call(`/owner/integrations/${id}`, alice)).status).toBe(404);
    expect(audit("console.integration.delete")[0]!.ok).toBe(true);
  });
});

function w_audit(audit: (a: string) => unknown[]): unknown[] {
  return [
    "console.integration.create",
    "console.integration.update",
    "console.integration.test",
  ].flatMap((a) => audit(a));
}

describe("console: project links and Linear issues", () => {
  async function linked() {
    const s = await setup();
    const { call, alice } = s;
    const integ = (
      await call("/owner/integrations", alice, {
        json: { kind: "linear", name: "L", secret: SECRET, teamId: "web" },
      })
    ).body;
    const project = (
      await call("/owner/projects", alice, {
        json: { name: "Site", teamId: "web" },
      })
    ).body;
    return { ...s, integ, project };
  }

  it("links and unlinks a project; access and team rules apply", async () => {
    const { call, alice, bob, carol, integ, project, audit } = await linked();
    let r = await call(`/owner/projects/${project.id}/links`, alice, {
      json: {
        integrationId: integ.id,
        externalType: "linear_team",
        externalId: "t1",
        externalName: "Web",
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.links).toEqual([
      expect.objectContaining({
        integrationId: integ.id,
        externalType: "linear_team",
        externalId: "t1",
        externalName: "Web",
      }),
    ]);
    // Re-linking the same type replaces it.
    r = await call(`/owner/projects/${project.id}/links`, alice, {
      json: {
        integration_id: integ.id,
        external_type: "linear_team",
        external_id: "t1",
        external_name: "Web 2",
      },
    });
    expect(r.body.links).toHaveLength(1);
    expect(r.body.links[0].externalName).toBe("Web 2");
    // Bad type, member, stranger.
    expect(
      (
        await call(`/owner/projects/${project.id}/links`, alice, {
          json: {
            integrationId: integ.id,
            externalType: "jira",
            externalId: "x",
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`/owner/projects/${project.id}/links`, bob, {
          json: {
            integrationId: integ.id,
            externalType: "linear_project",
            externalId: "p1",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(`/owner/projects/${project.id}/links`, carol, {
          json: {
            integrationId: integ.id,
            externalType: "linear_project",
            externalId: "p1",
          },
        })
      ).status,
    ).toBe(404);
    // A team integration does not link to a personal project.
    const personal = (
      await call("/owner/projects", alice, { json: { name: "Mine" } })
    ).body;
    expect(
      (
        await call(`/owner/projects/${personal.id}/links`, alice, {
          json: {
            integrationId: integ.id,
            externalType: "linear_team",
            externalId: "t1",
          },
        })
      ).status,
    ).toBe(400);

    r = await call(
      `/owner/projects/${project.id}/links/${integ.id}/linear_team`,
      alice,
      { method: "DELETE" },
    );
    expect(r.body.links).toEqual([]);
    expect(
      (
        await call(
          `/owner/projects/${project.id}/links/${integ.id}/linear_team`,
          alice,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(404);
    expect(audit("console.project.link").map((a) => a.ok)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(audit("console.project.unlink").map((a) => a.ok)).toEqual([
      true,
      false,
    ]);
  });

  it("creates a Linear issue for a task in the linked team and project, once", async () => {
    const { call, alice, bob, carol, integ, project, linear, audit } =
      await linked();
    await call(`/owner/projects/${project.id}/links`, alice, {
      json: {
        integrationId: integ.id,
        externalType: "linear_team",
        externalId: "t1",
        externalName: "Web",
      },
    });
    await call(`/owner/projects/${project.id}/links`, alice, {
      json: {
        integrationId: integ.id,
        externalType: "linear_project",
        externalId: "p1",
        externalName: "Launch",
      },
    });

    // A task without a project cannot get an issue.
    const loose = (
      await call("/owner/tasks", alice, {
        json: { machine: "mini", folder: "/work/app", prompt: "x" },
      })
    ).body;
    expect(
      (await call(`/owner/tasks/${loose.id}/linear-issue`, alice, { json: {} }))
        .status,
    ).toBe(400);

    const task = (
      await call("/owner/tasks", alice, {
        json: {
          machine: "mini",
          folder: "/work/app",
          prompt: "Fix the login page\nmore detail",
          projectId: project.id,
        },
      })
    ).body;
    let r = await call(`/owner/tasks/${task.id}/linear-issue`, alice, {
      json: {},
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      created: true,
      task: task.id,
      issue: {
        identifier: "WEB-12",
        url: "https://linear.app/example/issue/WEB-12",
        integrationId: integ.id,
        title: "Fix the login page",
      },
    });
    const sent = linear.calls.at(-1)!;
    expect(sent.query).toContain("issueCreate");
    const input = sent.variables.input as Record<string, string>;
    expect(input).toMatchObject({
      teamId: "t1",
      projectId: "p1",
      title: "Fix the login page",
    });
    expect(input.description).toContain(task.id);
    expect(input.description).toContain("Status: queued");

    // Stored on the task log and listed; a second call returns the existing one.
    const events = (await call(`/owner/tasks/${task.id}/events`, alice)).body
      .events;
    expect(
      events.find((e: any) => e.type === "linear_issue").data,
    ).toMatchObject({ identifier: "WEB-12" });
    expect(
      (await call(`/owner/tasks/${task.id}/linear-issues`, alice)).body.issues,
    ).toHaveLength(1);
    const n = linear.calls.length;
    r = await call(`/owner/tasks/${task.id}/linear-issue`, alice, { json: {} });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(false);
    expect(linear.calls.length).toBe(n);

    // Tasks are private: bob and carol get 404 for alice's task.
    expect(
      (await call(`/owner/tasks/${task.id}/linear-issue`, bob, { json: {} }))
        .status,
    ).toBe(404);
    expect(
      (await call(`/owner/tasks/${task.id}/linear-issue`, carol, { json: {} }))
        .status,
    ).toBe(404);

    // A team member files their own task to the team's Linear with the team key.
    const bobTask = (
      await call("/owner/tasks", bob, {
        json: {
          machine: "bob-box",
          folder: "/work/x",
          prompt: "Lint",
          projectId: project.id,
        },
      })
    ).body;
    r = await call(`/owner/tasks/${bobTask.id}/linear-issue`, bob, {
      json: { title: "Custom title" },
    });
    expect(r.status).toBe(201);
    expect((linear.calls.at(-1)!.variables.input as any).title).toBe(
      "Custom title",
    );
    expect(r.text).not.toContain(SECRET);

    expect(audit("console.task.linear_issue").map((a) => a.ok)).toEqual([
      false,
      true,
      true,
      false,
      false,
      true,
    ]);
  });

  it("without a linked Linear team the issue call is 400", async () => {
    const { call, alice, project } = await linked();
    const task = (
      await call("/owner/tasks", alice, {
        json: {
          machine: "mini",
          folder: "/work/app",
          prompt: "x",
          projectId: project.id,
        },
      })
    ).body;
    const r = await call(`/owner/tasks/${task.id}/linear-issue`, alice, {
      json: {},
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not linked to a Linear team/);
  });
});
