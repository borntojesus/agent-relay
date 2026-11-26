import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { slugify } from "../src/projects.ts";
import { addMachine, serveHttp, world } from "./helpers.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

/** alice (admin of web), bob (member of web), carol (outside); a machine of alice and of bob. */
async function setup() {
  const w = world({ channels: [], rooms: ["team", "shared", "web-room"] });
  w.relay.tokens.addOwner({ id: "carol", name: "Carol" });
  w.relay.teams.add({ id: "web", name: "Web" });
  w.relay.teams.setMember("web", "alice", "admin");
  w.relay.teams.setMember("web", "bob", "member");
  w.relay.rooms.setRoomTeam("web-room", "web");
  addMachine(w, "mini", "alice");
  addMachine(w, "bob-box", "bob");
  // alice's agent reaches "team" so the room is visible in her console.
  w.agent("alice-agent", "alice", "peer:team:rw");
  const alice = w.agent("alice-console", "alice", "owner:alice:rw").token;
  const aliceRo = w.agent("alice-viewer", "alice", "owner:alice:r").token;
  const bob = w.agent("bob-console", "bob", "owner:bob:rw").token;
  const carol = w.agent("carol-console", "carol", "owner:carol:rw").token;
  const { call, close } = await serveHttp(w);
  closers.push(close);
  const audit = (action: string) =>
    w.relay.audit.recent(1000).filter((a) => a.action === action);
  return { w, call, alice, aliceRo, bob, carol, audit };
}

describe("projects: schema", () => {
  it("migrates twice without error and adds project_id to rooms and tasks", () => {
    const db = openDb();
    // openDb already migrated once; reopening the same schema must be a no-op.
    const cols = (t: string) =>
      (
        db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
    expect(cols("rooms")).toContain("project_id");
    expect(cols("tasks")).toContain("project_id");
    expect(cols("projects")).toEqual(
      expect.arrayContaining([
        "id",
        "owner_id",
        "team_id",
        "name",
        "slug",
        "description",
        "repo_url",
        "created_at",
        "archived_at",
      ]),
    );
  });

  it("slugifies names", () => {
    expect(slugify("Web App 2!")).toBe("web-app-2");
    expect(slugify("  ")).toBe("project");
  });
});

describe("console: personal projects", () => {
  it("creates, lists, gets, updates, archives; owner only", async () => {
    const { call, alice, bob, audit } = await setup();
    let r = await call("/owner/projects", alice, {
      json: {
        name: "Web App",
        description: "site",
        repoUrl: "https://example.com/web.git",
      },
    });
    expect(r.status).toBe(201);
    const p = r.body;
    expect(p).toMatchObject({
      ownerId: "alice",
      teamId: null,
      name: "Web App",
      slug: "web-app",
      canWrite: true,
      links: [],
      archivedAt: null,
    });
    expect(p.id).toMatch(/^pj_/);

    // Same name again: slug gets a suffix; an explicit taken slug is 409.
    r = await call("/owner/projects", alice, { json: { name: "Web App" } });
    expect(r.body.slug).toBe("web-app-2");
    r = await call("/owner/projects", alice, {
      json: { name: "Other", slug: "web-app" },
    });
    expect(r.status).toBe(409);
    // Slugs are per owner: bob may use the same one.
    r = await call("/owner/projects", bob, {
      json: { name: "Web App", slug: "web-app" },
    });
    expect(r.status).toBe(201);

    r = await call("/owner/projects", alice);
    expect(r.body.projects.map((x: any) => x.slug)).toEqual([
      "web-app",
      "web-app-2",
    ]);

    // bob cannot see alice's personal project at all.
    expect((await call(`/owner/projects/${p.id}`, bob)).status).toBe(404);
    expect(
      (
        await call(`/owner/projects/${p.id}`, bob, {
          method: "PATCH",
          json: { name: "x" },
        })
      ).status,
    ).toBe(404);

    r = await call(`/owner/projects/${p.id}`, alice, {
      method: "PATCH",
      json: { name: "Web", repo_url: null },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name: "Web",
      repoUrl: null,
      slug: "web-app",
    });
    expect(
      (
        await call(`/owner/projects/${p.id}`, alice, {
          method: "PATCH",
          json: { bogus: 1 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`/owner/projects/${p.id}`, alice, {
          method: "PATCH",
          json: { repoUrl: "javascript:alert(1)" },
        })
      ).status,
    ).toBe(400);

    r = await call(`/owner/projects/${p.id}/archive`, alice, { json: {} });
    expect(r.body.archivedAt).toBeTruthy();
    expect(
      (await call("/owner/projects", alice)).body.projects.map(
        (x: any) => x.id,
      ),
    ).not.toContain(p.id);
    expect(
      (await call("/owner/projects?archived=1", alice)).body.projects.map(
        (x: any) => x.id,
      ),
    ).toContain(p.id);
    r = await call(`/owner/projects/${p.id}/unarchive`, alice, { json: {} });
    expect(r.body.archivedAt).toBeNull();

    expect(audit("console.project.create").filter((a) => a.ok)).toHaveLength(3);
    expect(audit("console.project.create").filter((a) => !a.ok)).toHaveLength(
      1,
    );
    expect(audit("console.project.update").length).toBe(4);
    expect(audit("console.project.archive")).toHaveLength(1);
    expect(audit("console.project.unarchive")).toHaveLength(1);
  });

  it("a read-only console token cannot write", async () => {
    const { call, aliceRo } = await setup();
    expect((await call("/owner/projects", aliceRo)).status).toBe(200);
    expect(
      (await call("/owner/projects", aliceRo, { json: { name: "x" } })).status,
    ).toBe(403);
  });
});

describe("console: team projects", () => {
  it("members read, admins and the creator write, strangers see nothing", async () => {
    const { call, alice, bob, carol } = await setup();
    // carol is not in web: 404 like a missing team.
    expect(
      (
        await call("/owner/projects", carol, {
          json: { name: "X", teamId: "web" },
        })
      ).status,
    ).toBe(404);

    const byAdmin = (
      await call("/owner/projects", alice, {
        json: { name: "Site", team_id: "web" },
      })
    ).body;
    expect(byAdmin).toMatchObject({ teamId: "web", canWrite: true });
    const byMember = (
      await call("/owner/projects", bob, {
        json: { name: "Bob's", teamId: "web" },
      })
    ).body;
    expect(byMember).toMatchObject({
      teamId: "web",
      ownerId: "bob",
      canWrite: true,
    });

    // bob reads the admin's project but cannot change it.
    let r = await call(`/owner/projects/${byAdmin.id}`, bob);
    expect(r.status).toBe(200);
    expect(r.body.canWrite).toBe(false);
    expect(
      (
        await call(`/owner/projects/${byAdmin.id}`, bob, {
          method: "PATCH",
          json: { name: "mine" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(`/owner/projects/${byAdmin.id}/archive`, bob, { json: {} }))
        .status,
    ).toBe(403);
    // alice (admin) changes bob's project.
    r = await call(`/owner/projects/${byMember.id}`, alice, {
      method: "PATCH",
      json: { description: "by admin" },
    });
    expect(r.status).toBe(200);
    expect(r.body.description).toBe("by admin");

    // carol sees none of them.
    expect((await call("/owner/projects", carol)).body.projects).toEqual([]);
    expect((await call(`/owner/projects/${byAdmin.id}`, carol)).status).toBe(
      404,
    );

    // team filter
    expect(
      (await call("/owner/projects?team=web", bob)).body.projects,
    ).toHaveLength(2);
    expect(
      (await call("/owner/projects?team=personal", bob)).body.projects,
    ).toHaveLength(0);
    expect(
      (await call("/owner/projects?team=other", bob)).body.projects,
    ).toHaveLength(0);
  });

  it("removing a member takes access away at once", async () => {
    const { w, call, alice, bob } = await setup();
    const p = (
      await call("/owner/projects", alice, {
        json: { name: "Site", teamId: "web" },
      })
    ).body;
    expect((await call(`/owner/projects/${p.id}`, bob)).status).toBe(200);
    w.relay.teams.removeMember("web", "bob");
    expect((await call(`/owner/projects/${p.id}`, bob)).status).toBe(404);
  });
});

describe("console: rooms and tasks in projects", () => {
  it("sets and clears the project of a room the owner can see", async () => {
    const { call, alice, bob, carol, audit } = await setup();
    const team = (
      await call("/owner/projects", alice, {
        json: { name: "Site", teamId: "web" },
      })
    ).body;
    // web-room is a room of team web: alice (admin) attaches it.
    let r = await call("/owner/rooms/web-room/project", alice, {
      json: { projectId: team.id },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ room: "web-room", projectId: team.id });
    expect(
      (await call("/owner/rooms", alice)).body.rooms.find(
        (x: any) => x.room === "web-room",
      ).projectId,
    ).toBe(team.id);
    // bob sees it in the project's rooms but may not move it (no write on the project).
    expect(
      (await call(`/owner/projects/${team.id}/rooms`, bob)).body.rooms,
    ).toEqual([{ room: "web-room", title: "web-room", team: "web" }]);
    expect(
      (
        await call("/owner/rooms/web-room/project", bob, {
          json: { projectId: null },
        })
      ).status,
    ).toBe(403);
    // carol cannot see the room: 404.
    expect(
      (
        await call("/owner/rooms/web-room/project", carol, {
          json: { projectId: null },
        })
      ).status,
    ).toBe(404);
    // projectId is required.
    expect(
      (await call("/owner/rooms/web-room/project", alice, { json: {} })).status,
    ).toBe(400);
    r = await call("/owner/rooms/web-room/project", alice, {
      json: { projectId: null },
    });
    expect(r.body.projectId).toBeNull();
    expect(audit("console.room.project").map((a) => a.ok)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it("tasks take a project on create and later; the list shows only own tasks", async () => {
    const { call, alice, bob, carol } = await setup();
    const team = (
      await call("/owner/projects", alice, {
        json: { name: "Site", teamId: "web" },
      })
    ).body;
    const mine = (
      await call("/owner/projects", alice, { json: { name: "Mine" } })
    ).body;

    let r = await call("/owner/tasks", alice, {
      json: {
        machine: "mini",
        folder: "/work/app",
        prompt: "run tests",
        projectId: team.id,
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.projectId).toBe(team.id);
    const t1 = r.body.id;

    // A member files their own task under the team project.
    r = await call("/owner/tasks", bob, {
      json: {
        machine: "bob-box",
        folder: "/work/x",
        prompt: "lint",
        project_id: team.id,
      },
    });
    expect(r.status).toBe(201);
    // bob cannot use alice's personal project; carol cannot use the team's.
    expect(
      (
        await call("/owner/tasks", bob, {
          json: {
            machine: "bob-box",
            folder: "/work/x",
            prompt: "x",
            projectId: mine.id,
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("/owner/tasks", carol, {
          json: {
            machine: "mini",
            folder: "/work/x",
            prompt: "x",
            projectId: team.id,
          },
        })
      ).status,
    ).toBe(404);

    // Each owner sees their own tasks of the project only.
    expect(
      (await call(`/owner/projects/${team.id}/tasks`, alice)).body.tasks.map(
        (t: any) => t.id,
      ),
    ).toEqual([t1]);
    expect(
      (await call(`/owner/projects/${team.id}/tasks`, bob)).body.tasks,
    ).toHaveLength(1);
    expect((await call(`/owner/projects/${team.id}/tasks`, carol)).status).toBe(
      404,
    );

    // Move and clear.
    r = await call(`/owner/tasks/${t1}/project`, alice, {
      json: { projectId: mine.id },
    });
    expect(r.body.projectId).toBe(mine.id);
    expect((await call(`/owner/tasks/${t1}`, alice)).body.projectId).toBe(
      mine.id,
    );
    expect(
      (
        await call(`/owner/tasks/${t1}/project`, bob, {
          json: { projectId: null },
        })
      ).status,
    ).toBe(404);
    r = await call(`/owner/tasks/${t1}/project`, alice, {
      json: { projectId: null },
    });
    expect(r.body.projectId).toBeNull();

    // An archived project takes nothing new.
    await call(`/owner/projects/${mine.id}/archive`, alice, { json: {} });
    expect(
      (
        await call(`/owner/tasks/${t1}/project`, alice, {
          json: { projectId: mine.id },
        })
      ).status,
    ).toBe(400);
  });
});
