/**
 * A small Linear GraphQL client: POST https://api.linear.app/graphql with the
 * personal API key in `Authorization` (no `Bearer`). `fetch` is injected, so
 * tests run against a fake and never touch the network. Error messages never
 * carry the key.
 */

export const LINEAR_URL = "https://api.linear.app/graphql";

export class LinearError extends Error {
  /** HTTP status of Linear's answer, 0 when the request did not get one. */
  readonly httpStatus: number;
  constructor(message: string, httpStatus = 0) {
    super(message);
    this.name = "LinearError";
    this.httpStatus = httpStatus;
  }
}

export interface LinearViewer {
  id: string;
  name: string;
  email: string | null;
}
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}
export interface LinearProject {
  id: string;
  name: string;
  state: string | null;
}
export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
}

export type FetchFn = typeof fetch;

export class LinearClient {
  private readonly key: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(key: string, fetchFn: FetchFn = fetch, timeoutMs = 15_000) {
    this.key = key;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  private scrub(text: string): string {
    return this.key ? text.split(this.key).join("[key]") : text;
  }

  async query<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(LINEAR_URL, {
        method: "POST",
        headers: {
          Authorization: this.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new LinearError(
        this.scrub(
          `Linear is unreachable: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    let body: { data?: T; errors?: Array<{ message?: string }> } | undefined;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = undefined;
    }
    if (res.status === 401 || res.status === 403)
      throw new LinearError("Linear rejected the API key", res.status);
    const first = body?.errors?.[0]?.message;
    if (!res.ok || first || !body?.data) {
      throw new LinearError(
        this.scrub(
          `Linear error${res.ok ? "" : ` ${res.status}`}: ${(first ?? "no data").slice(0, 300)}`,
        ),
        res.status,
      );
    }
    return body.data;
  }

  async viewer(): Promise<LinearViewer> {
    const d = await this.query<{
      viewer: { id: string; name: string; email?: string | null };
    }>("query { viewer { id name email } }");
    return {
      id: d.viewer.id,
      name: d.viewer.name,
      email: d.viewer.email ?? null,
    };
  }

  async teams(): Promise<LinearTeam[]> {
    const d = await this.query<{ teams: { nodes: LinearTeam[] } }>(
      "query { teams(first: 250) { nodes { id key name } } }",
    );
    return d.teams.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name }));
  }

  async projects(teamId: string): Promise<LinearProject[]> {
    const d = await this.query<{
      team: {
        projects: {
          nodes: Array<{ id: string; name: string; state?: string | null }>;
        };
      } | null;
    }>(
      "query ($id: String!) { team(id: $id) { projects(first: 250) { nodes { id name state } } } }",
      { id: teamId },
    );
    if (!d.team) throw new LinearError("no such Linear team", 404);
    return d.team.projects.nodes.map((p) => ({
      id: p.id,
      name: p.name,
      state: p.state ?? null,
    }));
  }

  async createIssue(i: {
    teamId: string;
    projectId?: string | null;
    title: string;
    description: string;
  }): Promise<LinearIssue> {
    const input: Record<string, unknown> = {
      teamId: i.teamId,
      title: i.title,
      description: i.description,
    };
    if (i.projectId) input.projectId = i.projectId;
    const d = await this.query<{
      issueCreate: { success: boolean; issue: LinearIssue | null };
    }>(
      "mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url title } } }",
      { input },
    );
    if (!d.issueCreate.success || !d.issueCreate.issue)
      throw new LinearError("Linear did not create the issue");
    const x = d.issueCreate.issue;
    return { id: x.id, identifier: x.identifier, url: x.url, title: x.title };
  }
}
