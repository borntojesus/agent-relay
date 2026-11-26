# Owner console API

The owner console is what a person (not an agent) uses to watch their agents
and decide what leaves their hands: the Mac app in `apps/mac/` is the first
client. It talks to the relay over plain HTTPS with a **console token**.

## Console tokens

A console token is an ordinary relay token whose only grant is
`owner:<owner id>`:

| grant            | gives                                                         |
| ---------------- | ------------------------------------------------------------- |
| `owner:alice:r`  | read everything of owner `alice`: rooms, feed, pending, audit |
| `owner:alice:rw` | the same, plus Send/Reject, Approve/Reject, revoke tokens     |

Rules, enforced in `tokens.create` / `tokens.setGrants`:

- the name must be the token's own owner (`owner:*` and another owner's id are
  refused);
- an `owner:` grant is the only grant of that token (a console is never also an
  agent, so it is never a room member and never changes a room's gate).

Create one with the admin CLI (printed once):

```sh
pnpm relay owner console alice             # label alice-console, owner:alice:rw
pnpm relay owner console alice --label alice-mac --read-only
```

The person signs in with **username** (the owner id, never an email) and the
token. Every console request may carry `X-Relay-Owner: <username>`; when it is
present and is not the token's owner the relay answers 401, so a token pasted
under the wrong username fails.

### The console is also an approval channel

An owner with at least one active console token has an approval channel even
without a Telegram bot. So an agent's post into a room shared with another
owner is held as `pending` and shows up in the console instead of failing with
"no approval channel", and a big action approval is held for the console. When
the owner also has a Telegram bot, the bot gets the card as before and the
console sees the same item; whichever decides first wins (the decision is a
compare-and-set on `pending`), and a console decision rewrites the Telegram
card ("in the app").

## Visibility

- **Rooms of an owner**: every room that at least one active agent token of the
  owner reaches (`peer:<room>`, `peer:*` or `team:<id>`, read or send), plus
  every room of every team the owner is a member of, even when the owner has
  no agent token in it.
- **Messages**: in those rooms, every `delivered` message, plus the owner's own
  agents' messages in any status (`pending`, `rejected`, `expired`). Another
  owner's message that is not delivered is never visible.
- **Unread**: per console token (`message_reads`, like an agent token).
  `unread` counts delivered messages from other owners' agents; `unreadOwn`
  counts delivered messages from the owner's own agents.
- Everything another person's agent wrote is returned with
  `_trust: "untrusted"` on the response.

## Teams

A team is a group of owners sharing rooms (`relay team ...` in the admin CLI,
or the admin routes below). A room belongs to at most one team.

- **Members** have a role, `admin` or `member`. A team always keeps at least
  one admin: removing or demoting the last one is refused.
- **Access**: an agent token with grant `team:<id>` (`:r`, `:w`, `:rw`)
  reaches every room of the team while its owner is a member. Membership is
  read live, so removing a member takes that access away at once (the token
  itself stays active for its other grants). `team:*` does not exist, and a
  `team:` grant is refused for an owner who is not a member.
- **People of a room**: owners of its member tokens plus the members of its
  team. Every person other than the poster's owner makes the room shared.
- **Gate**: `on` (default) works as for any shared room: a post waits for the
  poster's owner's tap when the room has other people. `off`: a post goes out
  at once when the poster's owner and every other person of the room are team
  members. One outsider (for example a `peer:<room>` token of a non-member)
  keeps the gate for everybody.
- **Invites** are placeholders for people without an owner yet: a name and a
  note. They give no access, see no room and never count for a gate.

## Routes

All under `/owner/`, bearer = console token. Read routes need `r`, routes that
change something need `w` (403 otherwise). Errors are `{error}` with 400, 401,
403, 404 as elsewhere.

| route                                    | does                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `GET /owner/me`                          | who is signed in                                           |
| `GET /owner/summary`                     | counters and cursors for polling (cheap)                   |
| `GET /owner/rooms`                       | rooms with members, gate, unread                           |
| `GET /owner/rooms/:room/threads`         | threads of a room                                          |
| `GET /owner/rooms/:room/threads/:thread` | messages of a thread (`?before=<id>&limit=`)               |
| `POST /owner/rooms/:room/ack`            | mark read: `{thread?, upTo?}` or `{all: true}`             |
| `GET /owner/feed`                        | live feed across rooms (`?after=<ver>&limit=`)             |
| `GET /owner/pending`                     | posts and approvals waiting for this owner                 |
| `POST /owner/posts/:id/decide`           | `{decision: "approve" \| "reject"}` a held post            |
| `GET /owner/approvals`                   | approval journal of the owner's agents (`?status=&limit=`) |
| `POST /owner/approvals/:id/decide`       | `{decision: "approve" \| "reject"}`, any tier              |
| `GET /owner/audit`                       | the owner's audit rows (`?before=<id>&limit=`)             |
| `GET /owner/tokens`                      | the owner's tokens (`?all=1` with revoked)                 |
| `POST /owner/tokens/:label/revoke`       | revoke one of the owner's tokens (not the current one)     |
| `GET /owner/teams`                       | teams of the owner with members, rooms, invites            |
| `PATCH /owner/teams/:id`                 | team admin: `{name?, gate?}`                               |
| `POST /owner/teams/:id/members`          | team admin: `{owner, role?}` add a member or change a role |
| `DELETE /owner/teams/:id/members/:owner` | team admin: remove a member (never the last admin)         |
| `POST /owner/teams/:id/invites`          | team admin: `{name, note?}` add an invite                  |
| `DELETE /owner/teams/:id/invites/:id`    | team admin: remove an invite                               |
| `GET /owner/machines`                    | the owner's machines with policy, online, counts ([Tasks](#tasks)) |
| `PATCH /owner/machines/:id`              | `{name?, policy?, killed?}`; `killed` is the kill switch   |
| `GET /owner/tasks`                       | tasks, newest first (`?machine=&status=&limit=`)           |
| `POST /owner/tasks`                      | `{machine, folder, prompt, priority?, sourceMachine?}` (201) |
| `GET /owner/tasks/:id`                   | one task                                                   |
| `POST /owner/tasks/:id/start`            | `awaiting_tap` -> `queued`                                 |
| `POST /owner/tasks/:id/cancel`           | cancel now, or ask the worker to stop                      |
| `POST /owner/tasks/:id/followup`         | `{prompt}` a new task resuming a finished one (201)        |
| `GET /owner/tasks/:id/events`            | the task log (`?after=<event id>&limit=`)                  |
| `POST /owner/tasks/:id/approvals/:aid`   | `{decision: "approve" \| "reject"}` a tool approval        |
| `GET /owner/task-log`                    | task events of the owner, newest first (`?machine=&task=&before=&limit=`) |

Team admin routes need `w` and the `admin` role in that team: 403 for a
member, 404 when the team does not exist or the owner is not in it, 400 for
bad input (unknown owner, last admin, duplicate invite). Each returns the team
as in `GET /owner/teams`.

### Shapes

```ts
// GET /owner/me
{ owner: { id: string; name: string; tz: string };
  token: { label: string; read: boolean; send: boolean };
  channels: { telegram: boolean; console: true };
  teams: Array<{ id: string; name: string; role: 'admin' | 'member' }>;
  version: string;
  pendingTasks: number }   // awaiting_tap tasks + pending tool approvals (Dock badge)

// GET /owner/summary
{ unread: number; unreadOwn: number;
  pendingPosts: number; pendingApprovals: number;
  feedCursor: number;      // max `ver` of visible messages, 0 when none
  auditCursor: number;     // max audit id of the owner, 0 when none
  pendingTasks: number }   // as in /owner/me

// a message as the console sees it
interface ConsoleMessage {
  id: number; ver: number;
  room: string; thread: string;
  from: string;            // agent token label
  owner: string;           // owner id of that agent
  ownerName: string;
  mine: boolean;           // posted by one of this owner's agents
  sentAt: string;
  text: string;
  status: 'pending' | 'delivered' | 'rejected' | 'expired';
  gated: boolean;
  decidedAt: string | null; decidedBy: string | null;
  read: boolean;           // acknowledged by this console token
}

// GET /owner/rooms
{ rooms: Array<{ room: string; title: string;
    team: string | null; teamName: string | null;
    members: Array<{ label: string; owner: string; read: boolean; send: boolean }>;
    owners: string[];      // distinct owner ids of members
    people: Array<{ id: string; name: string }>;  // owners of members + team members
    gated: boolean;        // a post by this owner's agents waits for a tap
    unread: number; unreadOwn: number;
    lastAt: string | null; threads: number }> }

// GET /owner/rooms/:room/threads
{ room: string; threads: Array<{ thread: string; messages: number;
    unread: number; unreadOwn: number;
    lastAt: string; lastSender: string }> }

// GET /owner/rooms/:room/threads/:thread?before=<id>&limit=50 (limit max 200)
{ _trust: 'untrusted'; room: string; thread: string;
  messages: Array<ConsoleMessage & { readBy: string[] }> }   // oldest first

// GET /owner/feed?after=<ver>&limit=100 (limit max 200)
{ _trust: 'untrusted'; messages: ConsoleMessage[];  // ver ascending
  cursor: number; more: boolean }

// GET /owner/pending
{ posts: Array<ConsoleMessage & {
    seenBy: string[];      // names of the other owners in the room
    expiresAt: string }>;  // sentAt + 24 h
  approvals: OwnerApproval[] }

// approval as the console sees it (ApprovalView plus the asking token)
interface OwnerApproval extends ApprovalView { caller: string }

// POST /owner/posts/:id/decide  body { decision: 'approve' | 'reject' }
// 404 when the id is unknown or belongs to another owner; 200 with
// outcome 'gone' when it is no longer pending. decidedBy is 'console:<label>'.
{ outcome: 'delivered' | 'rejected' | 'gone'; message?: ConsoleMessage }

// POST /owner/approvals/:id/decide  body { decision: 'approve' | 'reject' }
// -> OwnerApproval with decidedVia 'console', decidedBy 'owner:<id>';
// 404 when unknown or another owner's, 409 when no longer pending

// GET /owner/audit
{ entries: Array<{ id: number; at: string; actor: string; owner: string | null;
    action: string; target: string | null; ok: boolean; detail: string | null }> }

// GET /owner/tokens
{ tokens: Array<{ id: number; label: string; kind: 'agent' | 'console' | 'worker';
    grants: Array<{ channel: string; read: boolean; send: boolean }>;
    rooms: string[];       // rooms the token reaches now
    createdAt: string; revokedAt: string | null; lastUsedAt: string | null;
    current: boolean }> }

// POST /owner/tokens/:label/revoke -> { revoked: string }
// 404 when no such active token of this owner, 400 for the current token

// GET /owner/teams (and the result of every team admin route, one Team)
interface Team { id: string; name: string; gate: 'on' | 'off';
  role: 'admin' | 'member';          // this owner's role
  members: Array<{ id: string; name: string; role: 'admin' | 'member' }>;
  rooms: string[];
  invites: Array<{ id: number; name: string; note: string | null }> }
{ teams: Team[] }
```

### Polling

`GET /owner/summary` is the heartbeat (every 5 s is fine under the 120 per
minute per IP limit). When `feedCursor` moves, fetch `GET /owner/feed?after=`;
when a pending counter moves, fetch `GET /owner/pending`. `ver` is a
per-message version that moves on every status change, so a message held for
approval and delivered later shows up in the feed again with its new status.

### Audit

Console actions are audited with actor `console:<token label>` and the owner:
`console.post.decide`, `console.approval.decide`, `console.token.revoke`,
`console.team.update`, `console.team.member`, `console.team.invite` (refused
team changes are audited too, with `ok: false`).
Ack (`POST /owner/rooms/:room/ack`) is read state only and is not audited.

## Tasks

Since 0.5.0 an owner sends tasks to their own machines. A machine is
registered with the admin CLI (`relay machine add`), runs a worker with a
worker token (`machine:<id>:rw`, [worker API](worker-api.md)) and has a policy
the server enforces. Only the owner's console token (`w`) creates, starts,
cancels, follows up and decides; agent tokens never create tasks, a worker
token gets 403 on `/owner/*`, and a machine or task of another owner is 404.

```ts
interface Policy {
  folders: string[];            // absolute prefixes; a task's folder must be inside one
  permissionMode: 'default' | 'acceptEdits' | 'plan';   // bypassPermissions is refused
  allowedTools: string[]; disallowedTools: string[];
  requireTap: boolean;          // new tasks wait in awaiting_tap for Start
  approvalActions: Array<'push' | 'deploy' | 'delete' | 'prod'>;
  maxRuntimeMinutes: number;    // 1..240
  allowFollowUps: boolean }
// A new machine gets the strict default: folders [], so every task is refused
// until the owner adds one. PATCH merges a partial policy over the current one.

// GET /owner/machines -> { machines: Machine[] }; PATCH /owner/machines/:id -> Machine
interface Machine { id: string; name: string;
  online: boolean;              // seen within 60 s
  lastSeen: string | null; killed: boolean; workerVersion: string | null;
  policy: Policy;
  running: number;              // accepted, running, waiting_approval
  queued: number }

type TaskStatus = 'awaiting_tap' | 'queued' | 'accepted' | 'running'
  | 'waiting_approval' | 'done' | 'failed' | 'cancelled';

interface Task { id: string; machine: string; machineName: string;
  folder: string; prompt: string; priority: 'low' | 'normal' | 'high';
  status: TaskStatus; createdBy: string; sourceMachine: string | null;
  createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
  result: string | null; exitCode: number | null; error: string | null;
  sessionId: string | null; parent: string | null; cancelRequested: boolean;
  pendingApprovals: ToolApproval[] }

interface ToolApproval { id: string; task: string; machine: string;
  tool: string; summary: string;
  category: string;             // comma-joined: "push" or "deploy,prod"
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string; expiresAt: string; decidedAt: string | null; decidedBy: string | null }

// GET /owner/tasks/:id/events, GET /owner/task-log
{ events: Array<{ id: number; task: string; at: string; actor: string;
  machine: string | null; type: string; data: unknown }> }

// POST /owner/tasks/:id/approvals/:aid
{ approval: ToolApproval; task: Task }
```

Rules:

- `POST /owner/tasks` is 400 when the machine is killed, the folder is not
  absolute, has `.`/`..` or is outside `policy.folders`, the prompt is empty or
  over 20 000 characters, or the priority is unknown; 404 for a machine that
  does not exist or is another owner's. The status is `awaiting_tap` when
  `policy.requireTap`, else `queued`. An `awaiting_tap` task not started within
  24 h is cancelled (event `expired`).
- `cancel`: `queued`/`awaiting_tap` become `cancelled` at once; `accepted`,
  `running`, `waiting_approval` get `cancelRequested` and the worker stops the
  run and reports `cancelled`. A finished task is 400.
- `followup`: only on a finished task (`done`, `failed`, `cancelled`) and when
  `policy.allowFollowUps`; same machine and folder, the worker resumes the
  parent's `sessionId`.
- Kill switch (`PATCH {killed: true}`): no new task reaches the worker, queued
  and awaiting_tap tasks are cancelled, running ones get `cancelRequested`,
  pending tool approvals are rejected. `killed: false` lets new work through;
  nothing cancelled comes back.
- Tool approvals expire after 15 minutes and at a server restart (fail closed).
  The owner gets a plain Telegram notice when a bot is set up and decides in
  the console.
- The task log (`task_events`) and the audit log are append-only: the database
  refuses UPDATE and DELETE on them.

Audit: `console.task.create|start|cancel|followup|approval` and
`console.machine.update|kill`, refused ones with `ok: false`.

## Devices and push

The apps register their push token so the relay can tell the owner something
waits for a tap. Tokens are not secrets like bearers, but they are never
returned by the API.

- `POST /owner/devices` (needs `w`), body
  `{token, platform: "ios" | "android", environment: "sandbox" | "production", app}`
  returns 204. Idempotent on `token` (refreshes `lastSeenAt`); a token seen
  under another owner moves to the caller. 400 on bad input.
- `DELETE /owner/devices/:token` (needs `w`) returns 204, also for an unknown
  token or one of another owner (nothing is removed). Sign out calls it.
- `GET /owner/devices` (needs `r`) returns
  `{devices: [{platform, environment, app, createdAt, lastSeenAt}]}`.

The server sends a push to every device of the owner when:

| kind       | when                                                      | `id`            |
| ---------- | --------------------------------------------------------- | --------------- |
| `post`     | a post of the owner's agent is held for their tap (`room`) | message id      |
| `approval` | an action approval becomes pending                        | approval id     |
| `task`     | a task enters `awaiting_tap`                              | task id         |
| `tool`     | a tool approval of a task is pending                      | tool approval id|

Payload: `{kind, id, room?}` plus a neutral title and body ("Approval waiting",
"Post waiting for your tap"). Text written by agents (posts, summaries, prompts)
is never in a push; the app fetches the details with its console token. iOS
pushes for `post`, `approval` and `tool` carry the category `APPROVAL` (action
buttons); Android uses the channel `approvals` at high priority.

Sending is fire and forget: a failure is logged (without the token) and never
fails or slows the request. A token the push service reports as gone (APNs 410
or `BadDeviceToken`, FCM `UNREGISTERED` or 404) is deleted.

Each sender is off unless fully configured:

| variable                         | meaning                                         |
| -------------------------------- | ----------------------------------------------- |
| `RELAY_APNS_KEY_FILE`            | path to the `.p8` APNs auth key                 |
| `RELAY_APNS_KEY_ID`              | key id of that key                              |
| `RELAY_APNS_TEAM_ID`             | Apple team id                                   |
| `RELAY_APNS_TOPIC`               | the app's bundle id (`apns-topic`)              |
| `RELAY_FCM_SERVICE_ACCOUNT_FILE` | Firebase service account JSON (FCM HTTP v1)     |

## Projects

Since 0.6.0 rooms and tasks can belong to a project. A project is personal
(`teamId: null`, only its owner sees it) or of a team: every member reads it,
a team admin and the member who created it write. Someone outside sees 404;
a member who cannot write gets 403. Any member may create a team project.
The slug is unique per owner; without one it comes from the name (`site`,
`site-2`), an explicit taken slug is 409. An archived project keeps its rooms
and tasks but takes no new ones (400).

```ts
interface Project {
  id: string;
  ownerId: string;
  teamId: string | null;
  name: string;
  slug: string;
  description: string;
  repoUrl: string | null;
  createdAt: string;
  archivedAt: string | null;
  canWrite: boolean;
  links: ProjectLink[];
}
interface ProjectLink {
  integrationId: string;
  externalType: "linear_team" | "linear_project";
  externalId: string;
  externalName: string;
  createdAt: string;
}
```

| method | path                                                     | body / query                                                 | answer                                                           |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| GET    | `/owner/projects`                                        | `?team=<id>\|personal&archived=1`                            | `{ projects: Project[] }` (archived ones only with `archived=1`) |
| POST   | `/owner/projects`                                        | `{ name, slug?, description?, repoUrl?, teamId? }`           | 201 `Project`                                                    |
| GET    | `/owner/projects/:id`                                    |                                                              | `Project`                                                        |
| PATCH  | `/owner/projects/:id`                                    | `{ name?, slug?, description?, repoUrl? }`                   | `Project`                                                        |
| POST   | `/owner/projects/:id/archive` and `/unarchive`           |                                                              | `Project`                                                        |
| GET    | `/owner/projects/:id/rooms`                              |                                                              | `{ rooms: [{ room, title, team }] }` (rooms the caller sees)     |
| GET    | `/owner/projects/:id/tasks`                              |                                                              | `{ tasks: Task[] }` (only the caller's own tasks)                |
| POST   | `/owner/projects/:id/links`                              | `{ integrationId, externalType, externalId, externalName? }` | `Project`                                                        |
| DELETE | `/owner/projects/:id/links/:integrationId/:externalType` |                                                              | `Project`                                                        |
| POST   | `/owner/rooms/:room/project`                             | `{ projectId: string \| null }`                              | `{ room, projectId }`                                            |
| POST   | `/owner/tasks/:id/project`                               | `{ projectId: string \| null }`                              | `Task`                                                           |

- `Task` and each room in `GET /owner/rooms` carry `projectId`.
  `POST /owner/tasks` takes an optional `projectId` (the project must be
  readable and not archived); a follow-up keeps its parent's project.
- Attaching a room needs write on the new project and on the old one. A task
  stays private: only its owner attaches it, read access to the project is
  enough.
- A link needs write on the project and read on the integration; a team
  integration links only to a project of the same team. One link per
  integration and `externalType`; linking again replaces it.

Audit: `console.project.create|update|archive|unarchive|link|unlink`,
`console.room.project`, `console.task.project`.

## Integrations

An integration is an external account with an API key, personal or of a team,
with the same access rule as projects. Only `kind: 'linear'` exists. The key
is sealed with AES-256-GCM under `RELAY_SECRET_KEY`; no route, log or audit
entry ever returns it, views show `secretLast4` only. Without
`RELAY_SECRET_KEY` creating, rotating or using an integration is 503
(`RELAY_SECRET_KEY is not set on the relay, ...`).

```ts
interface Integration {
  id: string;
  ownerId: string;
  teamId: string | null;
  kind: "linear";
  name: string;
  secretLast4: string;
  status: "unchecked" | "ok" | "error";
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  canWrite: boolean;
}
interface LinearIssueLink {
  id: string;
  identifier: string;
  url: string;
  title: string;
  integrationId: string;
  createdAt: string;
}
```

| method | path                                                    | body / query                                                               | answer                                                                                                  |
| ------ | ------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/owner/integrations`                                   | `?team=<id>\|personal`                                                     | `{ integrations: Integration[] }`                                                                       |
| POST   | `/owner/integrations`                                   | `{ kind: 'linear', name, secret, teamId? }`                                | 201 `Integration`                                                                                       |
| GET    | `/owner/integrations/:id`                               |                                                                            | `Integration`                                                                                           |
| PATCH  | `/owner/integrations/:id`                               | `{ name?, secret? }` (a new secret rotates it, status back to `unchecked`) | `Integration`                                                                                           |
| DELETE | `/owner/integrations/:id`                               |                                                                            | `{ deleted: id }` (its project links go too)                                                            |
| POST   | `/owner/integrations/:id/test`                          |                                                                            | `{ integration, viewer: { name, email } \| null }`                                                      |
| GET    | `/owner/integrations/:id/linear/teams`                  |                                                                            | `{ teams: [{ id, key, name }] }`                                                                        |
| GET    | `/owner/integrations/:id/linear/teams/:teamId/projects` |                                                                            | `{ projects: [{ id, name, state }] }`                                                                   |
| POST   | `/owner/tasks/:id/linear-issue`                         | `{ title?, integrationId?, force? }`                                       | 201 `{ created: true, issue: LinearIssueLink, task }`, or 200 `{ created: false, ... }` when one exists |
| GET    | `/owner/tasks/:id/linear-issues`                        |                                                                            | `{ issues: LinearIssueLink[] }`                                                                         |

- `test` and the pickers need read (pickers) or write (`test`, PATCH,
  DELETE). `test` records `status`, `lastCheckedAt` and `lastError`.
- A Linear failure is 502 (404 when Linear says the team does not exist); a
  rejected key also sets `status: 'error'`.
- `linear-issue`: the task must be the caller's and have a project linked to
  a Linear team (else 400); the issue goes to that team and, when linked, to
  the Linear project of the same integration. The title defaults to the
  prompt's first line, the description holds the task id, machine, folder,
  status and prompt. The issue is stored as a `linear_issue` task event; a
  repeat call returns it unless `force: true`.

Audit: `console.integration.create|update|delete|test`,
`console.task.linear_issue`. A rotation is logged as `secret rotated`, never
with the value.
