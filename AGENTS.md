# AGENTS.md

OpenCode plugin (single npm package, TypeScript source, **no build step** — hosts load `index.ts` directly). Don't add a compile step or build artifacts; keep runtime dependencies minimal (they install into the user's host).

## Commands

```sh
npm run typecheck          # tsc --noEmit — run before tests; prepublishOnly runs typecheck && test
npm test                   # unit tests: node --test on TS directly (type stripping — hence node >=22.18)
node --test test/rawconfig.test.ts   # single test file
npm run test:e2e           # real-host e2e: downloads pinned V1+V2 hosts (~100MB each), takes minutes
```

## Dual-host contract (V1 = `opencode-ai` 1.x, V2 = `@opencode/cli` 2.x)

Behavioral facts verified against host source; getting these wrong is the historical failure mode of this repo:

- **MCP config shapes**: V1 canonical is **flat** `mcp.<name>`; V2 canonical is **nested** `mcp.servers.<name>` (each host also accepts the other's form). `rawconfig.ts` must scan both; within one file the **nested** entry wins (matches V2, the only consumer of the scan — V1 has no MCP transform API).
- **Plugin config key**: singular `plugin` (string | `[name, options]` tuple) is the only form both hosts load for this plugin. Plural `plugins` with `{package, options}` objects is V2-native only.
- **Plugin install mechanics**: V1 has **no plugin CLI** — npm plugins named in the config's `plugin` key are auto-installed at startup (Bun, cached in `~/.cache/opencode/node_modules`). Only V2 ships `opencode plugin add` (which writes the plural key). Docs must never show a V1 CLI install command; it does not exist.
- **Entry points**: V2 uses `Plugin.define({ id, setup(ctx) })` with `ctx.mcp.transform`; V1 uses `server(input, options)` returning `{ dispose }` — no `ctx.mcp` on V1, so env-ref re-substitution and MCP reconnection are V2-only features.

## Version anchors

- `test/e2e/run.mjs` `HOST_SPECS` pins the real hosts (currently `opencode-ai@1.18.34` / `@opencode/cli@2.0.22` = latest stable). Bump deliberately; probe other versions with `OPENCODE_E2E_V1_SPEC=opencode-ai@<ver> node test/e2e/run.mjs --host v1`.
- `engines.opencode` (`>=1.14.34`) is the oldest V1 release passing the e2e harness (bisected; boundary is the `mcp list` bootstrap refactor in anomalyco/opencode#25521). Don't lower it without a passing probe. The upstream repo was renamed from `sst/opencode` to `anomalyco/opencode` (PR numbers and old links redirect); older commit messages here still cite the `sst/` name.
- e2e harness needs **no** `npm ci` (node builtins only). On Windows, npm runs via `cmd.exe` (CVE-2024-27980); host binary is `bin/opencode.exe`. Probing V1 hosts ≤~1.15 (node wrapper at `bin/opencode`) works POSIX-only.

## Conventions

- Two READMEs (`README.md` English, `README.zh-CN.md`) — keep them in sync; both are user-facing docs, not translations to drift.
- Plugin log wording is a **test contract**: the e2e harness and `test/index.test.ts` grep the log for phrases like `startup: N injected`, `reload: N updated/withdrawn`, `reconnecting MCP server(s)` — reword messages and tests together. The log rotates at ~256 KiB keeping one `.old` generation; when debugging a missing line, check both files.
- Fix/feat commits bump the patch version in `package.json` and sync the lockfile with `npm install --package-lock-only` (see git history for the message pattern).
- CI (`.github/workflows/ci.yml`): unit tests on ubuntu+windows × node 22.18/24, e2e matrix os × host. Windows-specific branches (permission checks, `~\` expansion) are why Windows CI exists — don't remove it.
