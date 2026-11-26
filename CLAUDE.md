# agent-relay: notes for agents

Standalone relay for multi-party agent rooms and action approvals. Overview,
config and API in README.md. This file is the working notes.

## Stack

- Node 22.18+ runs TypeScript directly (type stripping). No build step, no
  bundler. tsconfig has `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `allowImportingTsExtensions`: **no enums, no parameter properties, no
  namespaces; imports end in `.ts`; type-only imports use `import type`.**
- Storage: `node:sqlite` (`DatabaseSync`), one file, schema in `src/db.ts`
  (`migrate` is idempotent `CREATE TABLE IF NOT EXISTS`).
- MCP: `@modelcontextprotocol/sdk` Streamable HTTP in stateless mode, a fresh
  `McpServer` per request built from the caller's grants. zod 4.
- Tests: vitest 3. pnpm only.

## Commands

```sh
pnpm install
pnpm test                      # all tests, offline (fake channels, fake Telegram)
pnpm typecheck                 # must stay clean
pnpm start                     # src/index.ts
pnpm relay <owner|room|token|audit> ...   # admin CLI on RELAY_DB
pnpm build:mac [--x64]         # dist/agent-relay-macos-* (Node SEA, one binary)
```

## Layout

| path                        | what                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `src/db.ts`                 | schema                                                       |
| `src/grants.ts`             | `peer:*` / `approval:*` grants, parsing, `canRead`/`canSend` |
| `src/tokens.ts`             | owners and tokens (sha256 of the bearer only), `authenticate`|
| `src/audit.ts`              | audit log                                                    |
| `src/teams.ts`              | `TeamStore`: teams, members (admin/member), invites          |
| `src/rooms/`                | `RoomStore` (SQL) and `RoomService` (gate, read state, limits)|
| `src/approvals/actions.ts`  | tiered action approvals                                      |
| `src/approvals/channel.ts`  | `OwnerChannel` interface, `NotStartedError`                  |
| `src/telegram/owner-bot.ts` | one bot per owner: cards, taps, `/start`                     |
| `src/mcp/server.ts`         | MCP tools                                                    |
| `src/http/server.ts`        | HTTP routes, limits, auth                                    |
| `src/http/console.ts`       | `/owner/*` console routes (docs/console-api.md)              |
| `src/http/worker.ts`        | `/worker/*` routes for a machine's worker (docs/worker-api.md)|
| `src/tasks/store.ts`        | `TaskStore` (SQL): machines, tasks, task events, tool approvals|
| `src/tasks/service.ts`      | `TaskService`: policy (zod), lifecycle, kill switch, long-polls|
| `src/http/util.ts`          | `HttpError`, `send`, `readBody`, body limit                  |
| `vitest.config.ts`          | test include (`test/**/*.test.ts`, keeps `apps/` out)        |
| `src/relay.ts`              | wiring                                                       |
| `src/serve.ts`, `src/admin.ts` | server boot and admin CLI; `src/index.ts`, `bin/relay.ts` call them |
| `src/cli.ts`                | single entry of the Mac binary: `serve`, admin nouns, `--version` |
| `Dockerfile`, `compose.yaml` | Docker image and compose file |
| `test/helpers.ts`           | `world()`: owners alice and bob, fake channels, fixed clock  |

## Rules that matter

- **The gate is computed, not configured.** A room is gated for a poster when
  any active member token belongs to another owner (`otherOwners`). Adding or
  revoking a token flips it; there is no room flag.
- **Only the poster's owner decides.** `rooms.decide(owner, id, nonce, ...)` and
  `approvals.tap(owner, ...)` check the owner and the nonce in the database. A
  bot passes its own owner id, so a card forwarded to another bot is "gone" /
  "unknown". Keep that check in the store, not in the bot.
- **Fail closed.** Expired, restarted (approvals pending at boot are expired)
  and undeliverable requests never approve. A card that fails with
  `NotStartedError` (owner never pressed Start) keeps a room post pending and
  shows it on `/start`; any other failure rejects the post and says nothing was
  sent.
- **Untrusted text.** Everything another agent wrote comes back with
  `_trust: 'untrusted'` and a notice. Do not drop that when adding tools.
- **Never log or store bearers.** Tokens are shown once by the CLI; only the
  sha256 is kept.
- Examples in code and docs use neutral names (alice, bob, team, shared,
  web-app) and `127.0.0.1`. No private hosts, domains or real people.

## Gotchas

- Bearer tokens must have at least one grant; `tokens.create` refuses an empty
  list.
- `RELAY_BOT_TOKEN_<OWNER>`: the owner id is uppercased and `-` becomes `_`. A
  bot starts only when the owner also has a Telegram user id.
- `createRelay({channels})` (tests) replaces the bots entirely.
- Time in tests is `world().clock.t` (ms); approvals take `now(): Date`, rooms
  take ms, `createRelay` adapts both.
- Mac binary: esbuild bundles `src/cli.ts` to CJS, so no top-level `await` on
  that path (keep it inside `serve()`). The SEA base must be the official
  nodejs.org binary: Homebrew node links shared libs and has no SEA fuse
  ("Single executable application is disabled").
- pnpm needs `allowBuilds` for esbuild in `pnpm-workspace.yaml` (vitest).
