import type { IncomingMessage, ServerResponse } from "node:http";
import type { Relay } from "../relay.ts";
import { ScopedError, camel } from "../projects.ts";
import { TaskError, type TaskView } from "../tasks/service.ts";
import { HttpError, readBody, send } from "./util.ts";

/** What the console handler hands over: the signed-in owner and its checks. */
export interface ConsoleContext {
  relay: Relay;
  owner: string;
  /** `console:<label>`, the actor of audit rows and task events. */
  actor: string;
  need(right: "r" | "w"): void;
  audit(action: string, target: string, ok: boolean, detail?: string): void;
  /** Room names this owner can see in the console. */
  visibleRooms(): string[];
}

function bodyObj(body: unknown): Record<string, unknown> {
  if (body === undefined) return {};
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "body must be a JSON object");
  return body as Record<string, unknown>;
}

function toHttp(err: unknown): unknown {
  if (err instanceof ScopedError) return new HttpError(err.status, err.message);
  if (err instanceof TaskError) return new HttpError(err.status, err.message);
  return err;
}

const flag = (url: URL, key: string) =>
  ["1", "true"].includes(url.searchParams.get(key) ?? "");

/** `projectId` (or `project_id`) from a body: a string, null to clear, undefined when absent. */
export function projectIdOf(
  body: Record<string, unknown>,
): string | null | undefined {
  const v = camel(body).projectId;
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string")
    throw new HttpError(400, "projectId is a project id or null");
  return v;
}

/** The first line of a task prompt as an issue title, at most 120 characters. */
export function issueTitle(prompt: string): string {
  const line = (prompt.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line || "Relay task";
}

function issueDescription(t: TaskView): string {
  return [
    t.prompt,
    "",
    "---",
    `Relay task: \`${t.id}\``,
    `Status: ${t.status}`,
    `Machine: ${t.machineName}`,
    `Folder: \`${t.folder}\``,
    `Created: ${t.createdAt}`,
  ].join("\n");
}

/**
 * Projects and integrations under /owner (docs/console-api.md "Projects",
 * "Integrations"). Returns false when the path is not one of these routes.
 */
export async function handleProjects(
  c: ConsoleContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
): Promise<boolean> {
  const { relay, owner } = c;
  const get = req.method === "GET";
  const post = req.method === "POST";
  const patch = req.method === "PATCH";
  const del = req.method === "DELETE";

  /** A write: audited ok true with `detail`, or ok false with the reason. Never put a secret in `detail`. */
  const change = async <T>(
    action: string,
    target: string,
    fn: () => T | Promise<T>,
    detail?: (out: T) => string,
  ): Promise<T> => {
    try {
      const out = await fn();
      c.audit(action, target, true, detail?.(out));
      return out;
    } catch (err) {
      c.audit(
        action,
        target,
        false,
        err instanceof Error ? err.message : String(err),
      );
      throw toHttp(err);
    }
  };
  const view = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toHttp(err);
    }
  };
  const teamFilter = (): string | undefined => {
    const t = url.searchParams.get("team");
    return t ? t.toLowerCase() : undefined;
  };

  // --- projects

  if (path === "/owner/projects" && get) {
    c.need("r");
    const team = teamFilter();
    send(res, 200, {
      projects: relay.projects.list(owner, {
        ...(team ? { team } : {}),
        archived: flag(url, "archived"),
      }),
    });
    return true;
  }

  if (path === "/owner/projects" && post) {
    c.need("w");
    const body = bodyObj(await readBody(req));
    const out = await change(
      "console.project.create",
      typeof body.name === "string" ? body.name.slice(0, 80) : "-",
      () => relay.projects.create(owner, body),
      (p) => `${p.id} ${p.slug}${p.teamId ? ` team=${p.teamId}` : ""}`,
    );
    send(res, 201, out);
    return true;
  }

  const pr =
    /^\/owner\/projects\/([^/]+)(?:\/(archive|unarchive|rooms|tasks|links)(?:\/([^/]+)\/([^/]+))?)?$/.exec(
      path,
    );
  if (pr) {
    const id = decodeURIComponent(pr[1]!);
    const sub = pr[2];
    if (!sub && get) {
      c.need("r");
      send(
        res,
        200,
        await view(() =>
          relay.projects.view(relay.projects.must(owner, id, "read"), owner),
        ),
      );
      return true;
    }
    if (!sub && patch) {
      c.need("w");
      const body = bodyObj(await readBody(req));
      const out = await change(
        "console.project.update",
        id,
        () => relay.projects.update(owner, id, body),
        (o) => o.changed.join(" "),
      );
      send(res, 200, out.view);
      return true;
    }
    if ((sub === "archive" || sub === "unarchive") && !pr[3] && post) {
      c.need("w");
      const out = await change(`console.project.${sub}`, id, () =>
        relay.projects.setArchived(owner, id, sub === "archive"),
      );
      send(res, 200, out);
      return true;
    }
    if (sub === "rooms" && !pr[3] && get) {
      c.need("r");
      await view(() => relay.projects.must(owner, id, "read"));
      const visible = new Set(c.visibleRooms());
      const all = new Map(relay.rooms.allRooms().map((r) => [r.name, r]));
      send(res, 200, {
        rooms: relay.projects
          .roomsOf(id)
          .filter((n) => visible.has(n))
          .map((n) => ({
            room: n,
            title: all.get(n)?.title ?? "",
            team: all.get(n)?.team ?? null,
          })),
      });
      return true;
    }
    if (sub === "tasks" && !pr[3] && get) {
      c.need("r");
      await view(() => relay.projects.must(owner, id, "read"));
      send(res, 200, {
        tasks: relay.projects
          .tasksOf(id, owner)
          .map((t) => relay.tasks.get(owner, t)),
      });
      return true;
    }
    if (sub === "links" && !pr[3] && post) {
      c.need("w");
      const body = camel(bodyObj(await readBody(req)));
      const out = await change(
        "console.project.link",
        id,
        () => {
          const p = relay.projects.must(owner, id, "write");
          const i = relay.integrations.must(owner, body.integrationId, "read");
          if (i.teamId !== null && i.teamId !== p.teamId)
            throw new ScopedError(
              400,
              "a team integration links only to projects of the same team",
            );
          const type = body.externalType;
          if (type !== "linear_team" && type !== "linear_project")
            throw new ScopedError(
              400,
              "externalType is linear_team or linear_project",
            );
          if (i.kind !== "linear")
            throw new ScopedError(
              400,
              "externalType does not fit the integration kind",
            );
          if (
            typeof body.externalId !== "string" ||
            !body.externalId.trim() ||
            body.externalId.length > 200
          )
            throw new ScopedError(400, "externalId is required");
          const name =
            typeof body.externalName === "string"
              ? body.externalName.trim().slice(0, 200)
              : "";
          relay.projects.link(p.id, {
            integrationId: i.id,
            externalType: type,
            externalId: body.externalId.trim(),
            externalName: name,
          });
          return {
            view: relay.projects.view(relay.projects.row(p.id)!, owner),
            detail: `${i.id} ${type} ${body.externalId.trim()}`,
          };
        },
        (o) => o.detail,
      );
      send(res, 200, out.view);
      return true;
    }
    if (sub === "links" && pr[3] && pr[4] && del) {
      c.need("w");
      const integrationId = decodeURIComponent(pr[3]);
      const type = decodeURIComponent(pr[4]);
      const out = await change(
        "console.project.unlink",
        id,
        () => {
          const p = relay.projects.must(owner, id, "write");
          if (!relay.projects.unlink(p.id, integrationId, type))
            throw new ScopedError(404, "no such link");
          return relay.projects.view(relay.projects.row(p.id)!, owner);
        },
        () => `${integrationId} ${type}`,
      );
      send(res, 200, out);
      return true;
    }
  }

  const roomProject = /^\/owner\/rooms\/([^/]+)\/project$/.exec(path);
  if (roomProject && post) {
    c.need("w");
    const room = decodeURIComponent(roomProject[1]!).trim().toLowerCase();
    const body = bodyObj(await readBody(req));
    const out = await change(
      "console.room.project",
      room,
      () => {
        // A room this owner cannot see answers like one that does not exist.
        if (!c.visibleRooms().includes(room))
          throw new ScopedError(404, `no such room: ${room}`);
        const pid = projectIdOf(body);
        if (pid === undefined)
          throw new ScopedError(400, "projectId is required (null clears it)");
        const prev = relay.projects.roomProject(room);
        // Moving a room out of a project is a change to that project too.
        if (prev && relay.projects.row(prev))
          relay.projects.must(owner, prev, "write");
        if (pid !== null) relay.projects.attachable(owner, pid, "write");
        relay.projects.setRoomProject(room, pid);
        return { room, projectId: pid };
      },
      (o) => o.projectId ?? "cleared",
    );
    send(res, 200, out);
    return true;
  }

  const taskSub = /^\/owner\/tasks\/([^/]+)\/(project|linear-issue)$/.exec(
    path,
  );
  if (taskSub && post) {
    c.need("w");
    const id = decodeURIComponent(taskSub[1]!);
    const body = bodyObj(await readBody(req));
    if (taskSub[2] === "project") {
      const out = await change(
        "console.task.project",
        id,
        () => {
          relay.tasks.get(owner, id);
          const pid = projectIdOf(body);
          if (pid === undefined)
            throw new ScopedError(
              400,
              "projectId is required (null clears it)",
            );
          // A member may file their own task under a team project they can read.
          if (pid !== null) relay.projects.attachable(owner, pid, "read");
          relay.projects.setTaskProject(id, pid);
          return relay.tasks.get(owner, id);
        },
        (t) => t.projectId ?? "cleared",
      );
      send(res, 200, out);
      return true;
    }
    const out = await change(
      "console.task.linear_issue",
      id,
      async () => {
        const t = relay.tasks.get(owner, id);
        if (!t.projectId) throw new ScopedError(400, "the task has no project");
        const p = relay.projects.must(owner, t.projectId, "read");
        const existing = relay.integrations.taskIssues(t.id);
        if (existing.length && body.force !== true)
          return { created: false, issue: existing.at(-1)!, task: t.id };
        const links = relay.projects.links(p.id);
        const wanted =
          typeof camel(body).integrationId === "string"
            ? String(camel(body).integrationId)
            : undefined;
        const teams = links.filter(
          (l) =>
            l.externalType === "linear_team" &&
            (!wanted || l.integrationId === wanted),
        );
        if (!teams.length)
          throw new ScopedError(
            400,
            "the project is not linked to a Linear team",
          );
        if (teams.length > 1)
          throw new ScopedError(
            400,
            "the project is linked to several Linear teams; say which with integrationId",
          );
        const team = teams[0]!;
        const lp = links.find(
          (l) =>
            l.externalType === "linear_project" &&
            l.integrationId === team.integrationId,
        );
        const i = relay.integrations.must(owner, team.integrationId, "read");
        const title =
          typeof body.title === "string" && body.title.trim()
            ? body.title.trim().slice(0, 250)
            : issueTitle(t.prompt);
        const issue = await relay.integrations.call(i, (lc) =>
          lc.createIssue({
            teamId: team.externalId,
            projectId: lp?.externalId ?? null,
            title,
            description: issueDescription(t),
          }),
        );
        const link = relay.integrations.addTaskIssue(
          { id: t.id, machine: t.machine },
          c.actor,
          i.id,
          issue,
        );
        return { created: true, issue: link, task: t.id };
      },
      (o) => `${o.created ? "created" : "exists"} ${o.issue.identifier}`,
    );
    send(res, out.created ? 201 : 200, out);
    return true;
  }

  const taskIssues = /^\/owner\/tasks\/([^/]+)\/linear-issues$/.exec(path);
  if (taskIssues && get) {
    c.need("r");
    const id = decodeURIComponent(taskIssues[1]!);
    await view(() => relay.tasks.get(owner, id));
    send(res, 200, { issues: relay.integrations.taskIssues(id) });
    return true;
  }

  // --- integrations

  if (path === "/owner/integrations" && get) {
    c.need("r");
    const team = teamFilter();
    send(res, 200, {
      integrations: relay.integrations.list(owner, team ? { team } : {}),
    });
    return true;
  }

  if (path === "/owner/integrations" && post) {
    c.need("w");
    const body = bodyObj(await readBody(req));
    const out = await change(
      "console.integration.create",
      typeof body.name === "string" ? body.name.slice(0, 80) : "-",
      () => relay.integrations.create(owner, body),
      (i) => `${i.id} ${i.kind}${i.teamId ? ` team=${i.teamId}` : ""}`,
    );
    send(res, 201, out);
    return true;
  }

  const ir =
    /^\/owner\/integrations\/([^/]+)(?:\/(test|linear\/teams)(?:\/([^/]+)\/projects)?)?$/.exec(
      path,
    );
  if (ir) {
    const id = decodeURIComponent(ir[1]!);
    const sub = ir[2];
    if (!sub && get) {
      c.need("r");
      send(
        res,
        200,
        await view(() =>
          relay.integrations.view(
            relay.integrations.must(owner, id, "read"),
            owner,
          ),
        ),
      );
      return true;
    }
    if (!sub && patch) {
      c.need("w");
      const body = bodyObj(await readBody(req));
      const out = await change(
        "console.integration.update",
        id,
        () => relay.integrations.update(owner, id, body),
        (o) =>
          o.changed
            .map((k) => (k === "secret" ? "secret rotated" : k))
            .join(" "),
      );
      send(res, 200, out.view);
      return true;
    }
    if (!sub && del) {
      c.need("w");
      await change("console.integration.delete", id, () =>
        relay.integrations.remove(owner, id),
      );
      send(res, 200, { deleted: id });
      return true;
    }
    if (sub === "test" && !ir[3] && post) {
      c.need("w");
      const out = await change(
        "console.integration.test",
        id,
        () => relay.integrations.test(owner, id),
        (o) => o.view.status,
      );
      send(res, 200, { integration: out.view, viewer: out.viewer });
      return true;
    }
    if (sub === "linear/teams" && get) {
      c.need("r");
      const teamId = ir[3] ? decodeURIComponent(ir[3]) : undefined;
      const out = await view(async () => {
        const i = relay.integrations.must(owner, id, "read");
        return teamId
          ? {
              projects: await relay.integrations.call(i, (lc) =>
                lc.projects(teamId),
              ),
            }
          : { teams: await relay.integrations.call(i, (lc) => lc.teams()) };
      });
      send(res, 200, out);
      return true;
    }
  }

  return false;
}
