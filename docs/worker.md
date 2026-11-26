# Worker: tasks on your own machines

The worker is a small launchd agent that runs on each Mac you want to send
tasks to. It long-polls the relay for tasks addressed to its machine, runs
`claude -p` headless in the task folder on your Claude subscription, streams
progress back, and asks you before risky tool calls (push, deploy, delete,
prod).

## Install

1. In the relay, register the machine and mint a worker token (owner console
   or `agent-relay machine ...`). The token is shown once.
2. Find claude: `which claude` (an absolute path is required).
3. Optional: `claude setup-token` gives a long-lived `CLAUDE_CODE_OAUTH_TOKEN`,
   useful when the login keychain is locked (headless Mac, after reboot).
4. Install. The token is read from stdin, never from the command line:

```sh
# preview: prints the config (redacted), the plist and the launchctl calls
agent-relay worker install --server https://relay.example --machine web-app \
  --claude /opt/homebrew/bin/claude --dry-run

# real install: line 1 = worker token, optional line 2 = oauth token
pbpaste | agent-relay worker install --server https://relay.example \
  --machine web-app --claude /opt/homebrew/bin/claude [--max-parallel 1]
```

`--token` is refused on purpose: argv shows up in `ps` and shell history.

Install does:

- writes `~/Library/Application Support/agent-relay/worker.json` (mode 0600,
  directory 0700);
- when run from the single binary, copies it to
  `~/Library/Application Support/agent-relay/bin/agent-relay`, so the plist
  never points at a Downloads folder;
- writes `~/Library/LaunchAgents/org.antonyuk.agent-relay.worker.plist`
  (RunAtLoad, KeepAlive, background, logs to
  `~/Library/Logs/agent-relay-worker.log`);
- `launchctl bootout` (ignored if not loaded), then
  `launchctl bootstrap gui/<uid> <plist>`.

Running from source (`node src/cli.ts worker install ...`) installs a plist
that runs `node src/cli.ts worker run` instead of copying a binary.

Other commands:

```sh
agent-relay worker status [--json]       # launchd state, pid, config (redacted), tasks in flight
agent-relay worker uninstall [--purge]   # bootout + remove plist; --purge also removes config, binary, run state
agent-relay worker run                   # the loop itself (launchd runs this)
agent-relay worker hook                  # PreToolUse hook, called by claude, not by you
```

`install`, `uninstall` and `status` take `--home <dir>` (tests, odd setups);
`install` and `uninstall` take `--dry-run`.

## Config

`worker.json`:

| field            | meaning                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `server`         | relay base URL, http(s)                                                   |
| `machine`        | machine id as registered in the relay                                     |
| `token`          | worker bearer token                                                       |
| `claudePath`     | absolute path to `claude`                                                 |
| `maxParallel`    | tasks at once, 1 to 4 (default 1)                                         |
| `oauthToken`     | optional `CLAUDE_CODE_OAUTH_TOKEN` passed to claude                       |
| `settingSources` | `--setting-sources` for claude; default `project,local` (see below)      |

The worker refuses to start if the file is readable by group or others. Fix
with `chmod 600`.

## How a task runs

1. `GET /worker/next?wait=25` claims a task (long poll). A heartbeat goes out
   every 15 s with the running task ids; its answer carries cancels and the
   kill switch. When the relay is unreachable the worker backs off from 1 s up
   to 60 s.
2. The folder is resolved with `realpath` and must sit inside one of the
   policy folders (also resolved), compared as a prefix plus `/`. Symlinks
   and `..` cannot escape; `/a/code` does not admit `/a/codebase`.
3. claude runs as
   `claude -p --output-format stream-json --verbose --permission-mode <mode>
[--allowedTools ...] [--disallowedTools ...] [--resume <session>]
--settings <run/<task>.settings.json>` with the prompt on stdin. Modes
   allowed: `default`, `acceptEdits`, `plan`. `bypassPermissions` and
   `--dangerously-skip-permissions` are never used.
4. Progress (text, tool calls, results) is batched to
   `POST /worker/tasks/<id>/events` about once a second. The final status
   carries the result (capped at 64 KB), exit code and session id, so a
   follow-up task can `--resume`.
5. Cancel, the kill switch and `maxRuntimeMinutes` stop the run: SIGTERM to
   the process group, SIGKILL after 5 s.

## Security model

- **Token.** Lives only in `worker.json` (0600). Never in argv, the plist,
  logs or the child env.
- **Child env.** Built from an allowlist (`HOME`, `USER`, `LANG`, `TMPDIR`,
  `SHELL`, a fixed `PATH`) plus `RELAY_TASK` and `RELAY_HOOK_SOCKET`. Every
  `ANTHROPIC_*` and `CLAUDE_CODE_*` variable is dropped, so the run cannot be
  switched to an API key, a different base URL or another provider; only
  `CLAUDE_CODE_OAUTH_TOKEN` from `worker.json` is added back.
- **Approval gate.** The worker injects a PreToolUse hook (`matcher: "*"`)
  through a temporary `--settings` file (0600, in the 0700 run directory,
  removed when the task ends). The hook asks the worker over a unix socket
  (0600). The worker classifies the call (`src/tasks/categories.ts`); if a
  category is in the task's `approvalActions`, it creates a tool approval in
  the relay and waits for your tap. Approved means the hook gives no decision,
  so claude's own permission rules (`allowedTools`, mode) still apply: the gate
  only ever takes permissions away. Rejected, expired, relay errors, a dead
  socket, a timeout or a stopping task all deny.
- **Fail closed.** A task the worker could not finish reporting is kept in
  `run/state.json` and reported as failed "worker restarted" on the next start.

## Troubleshooting

| symptom                                      | look at                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `worker status` says not loaded              | `tail ~/Library/Logs/agent-relay-worker.log`; reinstall; `launchctl print gui/$(id -u)/org.antonyuk.agent-relay.worker` |
| "worker.json mode is 644, must be 600"       | `chmod 600 ~/Library/Application\ Support/agent-relay/worker.json`                                                      |
| "relay unreachable" in the log               | server URL, VPN, token revoked (401)                                                                                    |
| task fails with "folder not allowed"         | the folder is outside the machine policy folders (after resolving symlinks)                                             |
| claude says not logged in                    | log in once interactively on that Mac, or install with an oauth token on stdin line 2                                   |
| every tool call is denied "agent-relay: ..." | the reason after the prefix: unreachable socket, approval rejected or expired, relay down                               |
| tasks stuck as running after a crash         | they are reported failed "worker restarted" on the next start; `worker status` lists `run/state.json`                   |

By default the worker runs claude with `--setting-sources project,local`: the
user's global `~/.claude/settings.json` (broad allow lists, its own hooks) does
not load, so it cannot widen the machine policy. The folder's own
`.claude/settings.json` and `.claude/settings.local.json` still load, and the
worker's `--settings` file (the PreToolUse gate) is always added on top. To
bring the global settings back on a machine, set
`"settingSources": "user,project,local"` in `worker.json` (a comma list of
`user`, `project`, `local`).
