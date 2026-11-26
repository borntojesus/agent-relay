# Worker API

A worker runs on one of the owner's machines, takes tasks the owner queued in
the console ([console API, Tasks](console-api.md#tasks)) and reports back. All
routes are under `/worker/`, bearer = a worker token.

## Setup

```sh
pnpm relay machine add mini --owner alice --name "Mac mini"
pnpm relay machine policy mini --json '{"folders":["/Users/alice/code"],"permissionMode":"acceptEdits"}'
pnpm relay token add mini-worker --owner alice --grants machine:mini:rw   # printed once
pnpm relay machine kill mini on|off
```

`machine policy <id> --json` replaces the policy: the strict defaults plus the
fields given. Without `--json` it prints the policy.

A worker token has exactly one grant, `machine:<id>:rw`, for a machine of the
same owner; `machine:*` and a machine grant next to any other grant are
refused. The machine always comes from the token, never from the request: a
task of another machine is 404, and a worker token gets 403 on `/owner/*` (and
any other token gets 403 on `/worker/*`).

Every call marks the machine seen (online = seen within 60 s) and records the
`X-Worker-Version` header. Limit: 600 requests per minute per worker token
(instead of the per-IP limit), body 256 KB.

## Routes

| route                                     | does                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /worker/next?wait=<s>`               | claim the next task; long-poll up to `wait` (default 25, max 30); 204 when none      |
| `POST /worker/heartbeat`                  | `{running: [taskId]}` -> `{cancel: [taskId], killed}`                                |
| `POST /worker/tasks/:id/events`           | `{events: [{type, data}]}` (1..50) -> `{cancel, killed}`                             |
| `POST /worker/tasks/:id/status`           | `{status, sessionId?, result?, exitCode?, error?}` -> `{id, status, cancel, killed}` |
| `POST /worker/tasks/:id/tool-approvals`   | `{tool, summary, category}` -> 201 `{id, expiresAt}`                                 |
| `GET /worker/tool-approvals/:id?wait=<s>` | `{status}`; long-poll while `pending`                                                |

```ts
// GET /worker/next -> 200
{
  task: {
    id: string;
    folder: string;
    prompt: string;
    priority: "low" | "normal" | "high";
    parent: string | null;
    resumeSessionId: string | null; // the parent's sessionId for a follow-up
    policy: Policy;
  }
} // the machine's current policy (console-api.md)
```

- `next` claims the highest priority, then oldest, `queued` task of the
  machine and moves it to `accepted`. A killed machine gets nothing. A task
  whose folder is no longer inside `policy.folders` fails at claim. When the
  worker hung up before the answer was sent, the task goes back to `queued`.
  The worker still realpaths the folder and checks it against the policy.
- Status transitions: `running` from `accepted` (or `running`, to update
  `sessionId`); `done`, `failed`, `cancelled` from `accepted`, `running`,
  `waiting_approval`. Anything else is 400. `result` is cut to 64 KB, `error`
  to 4000, `sessionId` to 200; `exitCode` is a whole number. A finished task
  expires its pending tool approvals.
- Event types: `started`, `progress`, `tool`, `tool_result`, `log`,
  `finished`. `data` over 8 KB is stored as `{_truncated: true, preview}`. The
  server writes its own events (`created`, `accepted`, `status`,
  `cancel_requested`, `approval_requested`, `approval_decided`, `followup`,
  `expired`); a worker cannot.
- `cancel: true` (events, status, heartbeat) means stop the run and report
  `cancelled`: the owner cancelled it or the kill switch is on.
- Tool approvals: `category` is one or more of `push`, `deploy`, `delete`,
  `prod` (a string, comma-joined, or a list). The task moves to
  `waiting_approval` and back to `running` when nothing else is pending. A
  request on a killed machine or a finished task is 400. A request expires
  after 15 minutes and at a server restart; `expired` and `rejected` both
  mean do not run the tool.

## Statuses

```
awaiting_tap --start--> queued --next--> accepted --> running <--> waiting_approval
      |                    |                 \___________|____________/
      +--cancel/24h--------+--cancel/kill--> cancelled       done | failed | cancelled
```

## Audit

Actor `worker:<token label>`: `worker.task.claim`, `worker.task.status`,
`worker.task.approval`, and `worker.auth` for a token that is not a worker.
Refusals of any worker route are audited with `ok: false`; accepted events are
the task log itself and are not audited again.
