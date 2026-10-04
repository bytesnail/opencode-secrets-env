# Contributing

Issues and pull requests are welcome — in English or 中文, whichever is more
comfortable.

## Setup

- Node.js >= 22.18 — unit tests run TypeScript directly via type stripping,
  hence the floor.
- `npm install`

## Commands

```sh
npm run typecheck    # tsc --noEmit — run before tests
npm test             # unit tests (node --test on TS sources)
npm run test:e2e     # real-host e2e: downloads pinned V1+V2 hosts (~100MB each), takes minutes
```

CI runs the full matrix (ubuntu + windows × node 22.18/24 × unit/e2e against
both hosts), so a green local `typecheck` + `test` is enough for most PRs —
CI does the rest.

## House rules (these have bitten before)

- **No build step.** Hosts load `index.ts` directly and the package is
  published as TypeScript source. Don't add compile steps or build artifacts,
  and keep runtime dependencies minimal — they install into every user's host.
- **Don't touch `package.json`'s `version`.** It always mirrors the latest
  published npm version; the bump happens only in release commits.
- **Log wording is a test contract.** The e2e harness and
  `test/index.test.ts` grep the log for phrases like `startup: N injected`
  and `reconnecting MCP server(s)`. Reword a message and its tests together.
- **Keep `README.md` and `README.zh-CN.md` in sync.** Both are user-facing;
  a change to one belongs in the other.
- **Read `AGENTS.md` before touching host-facing behavior** (`rawconfig.ts`,
  config-source precedence, MCP config shapes, plugin loading). It records
  the verified V1/V2 contract — getting it wrong is this repo's historical
  failure mode.

## Where things live

- `index.ts` — plugin entry: V2 via `Plugin.define({ id, setup(ctx) })`, V1
  (>= 1.14.34) via the exported `server(input, options)`; also option
  normalization.
- `env.ts` — pure secrets-file loading / injection / withdrawal logic.
- `rawconfig.ts` — raw config-source scanning for `{env:...}` references
  (flat V1 `mcp.<name>` and nested V2 `mcp.servers.<name>` shapes).
- `test/` — `node --test` unit tests, plus `test/e2e/run.mjs` which packs the
  plugin and asserts the full chain against the real pinned hosts.

## Pull requests

- One concern per PR; describe the user-visible behavior change.
- Update both READMEs when user-facing behavior or options change.
- Add or adjust unit tests for logic changes; e2e coverage for
  host-interaction changes.
- **Never include real secrets** in tests, fixtures, or screenshots.
