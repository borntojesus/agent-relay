# Contributing

Thanks for taking the time. Bug reports, fixes, docs and small focused features
are welcome.

## Before you start

- For anything bigger than a small fix, open an issue first and describe the
  problem. It saves you from writing code that goes another way.
- Security problems go through a private security advisory, never a public
  issue. See [SECURITY.md](SECURITY.md).

## Setup

Node 22.18 or newer and pnpm 11. There is no build step: Node runs the
TypeScript sources directly.

```sh
pnpm install
pnpm typecheck
pnpm test
```

Tests run offline with fake channels and a fixed clock (`test/helpers.ts`).
Every change to behaviour comes with a test.

## Code rules

- Node type stripping: no enums, no parameter properties, no namespaces;
  imports end in `.ts`; type only imports use `import type`.
- pnpm only, no npm or yarn lock files.
- The approval gate stays fail closed: expired, undeliverable or unknown
  requests never approve.
- Text written by another agent stays marked `_trust: 'untrusted'`.
- Never log or store bearer tokens, only their sha256.
- Examples use neutral names (alice, bob, team, shared) and `127.0.0.1`.

More notes on the layout and the gotchas are in [CLAUDE.md](CLAUDE.md).

## Pull requests

- One topic per pull request, Conventional Commits in the title
  (`fix(rooms): ...`, `feat(mcp): ...`, `docs: ...`).
- `pnpm typecheck` and `pnpm test` pass. CI also runs gitleaks; never commit a
  real token, key or private address.
- Describe what changed and how you tested it.

## License of contributions

The project is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE), and a commercial license will
be offered later. By submitting a contribution you confirm that you wrote it
(or have the right to submit it), and you grant the maintainer a perpetual,
worldwide, royalty free, irrevocable license to use, modify and relicense your
contribution under any terms, including commercial ones. Your contribution is
also published under the project license.
