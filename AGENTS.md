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
- **Scan/host alignment** (verified against `anomalyco/opencode@v2.0.22` source — `packages/core/src/config{,/discovery,/variable,/normalize}.ts`, `config/plugin/mcp.ts`, `cli/src/server-process.ts`): the host substitutes `{env:...}` with `/\{env:([^}]+)\}/g` (name may contain `{`), then `{file:...}` (`/\{file:([^}]+)\}/g`, `~/`-only expansion, resolved against the config file's dir, trimmed + JSON-escaped) at **text level** before JSONC parse. Documents merge per server name **last-definition-wins, whole-server** (no deep merge), so the scanner's first source in precedence order that *defines* a name claims it — with or without refs. Host-dropped entries (`{"enabled": bool}` enabled-only toggles, `mcp.timeout` config) define nothing and claim nothing. Config sources lowest→highest: wellknown remote (unscannable locally) → global dir (`opencode.json` then `.jsonc`; **`config.json` is NOT read by V2**) → `OPENCODE_CONFIG` explicit file → direct ancestor files (farthest→nearest, json before jsonc) → `.opencode/` dirs (farthest→nearest — **all** `.opencode` beat **all** direct files) → `OPENCODE_CONFIG_CONTENT` (inline JSONC). `OPENCODE_CONFIG_DIR` replaces the whole global config dir (also for `defaultSecretsPath`); `OPENCODE_CONFIG_PROJECT_DISABLE ?? OPENCODE_DISABLE_PROJECT_CONFIG` (truthy = `1`/`true`) skips all project files.
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
- Fix/feat/docs commits must **not** touch `package.json`'s `version` — on `main` it always mirrors the latest published npm version. The bump happens only in the release commit (see Release). Commits up to `v0.4.6` predate this policy (bump-at-commit-time, with `(vX.Y.Z)` suffixes in commit messages), which is why 0.4.5/0.4.6 exist in git history but were never published to npm.
- CI (`.github/workflows/ci.yml`): unit tests on ubuntu+windows × node 22.18/24, e2e matrix os × host. Windows-specific branches (permission checks, `~\` expansion) are why Windows CI exists — don't remove it.

## Release

Releases are **CI-gated** by `.github/workflows/release.yml`: pushing a `v<version>` tag replays the full CI matrix (unit + real-host e2e, ubuntu+windows — reused from `ci.yml` via `workflow_call`) and only then publishes to npm with provenance and creates the GitHub Release. There is deliberately **no** `NPM_TOKEN` anywhere — npm's trusted-publisher binding only accepts this workflow's OIDC identity, so local `npm publish` fails by design.

- Release flow (**bump-at-release-time**): pick the semver level from the changes accumulated on `main` since the last tag, run `npm version <patch|minor|major> --no-git-tag-version` (bumps `package.json` and syncs `package-lock.json` in one step), commit as `chore: release vX.Y.Z` and push `main`. Then `v=$(node -p "require('./package.json').version") && git tag -m "v$v" "v$v" && git push origin "v$v"` — the `-m` is not optional on machines with `tag.gpgSign=true` (a bare `git tag` opens an editor and fails non-interactively). The guard job fails the run when tag ≠ package.json version or the version is already on npm.
- The `npm publish` step must stay directly in `release.yml`: npm validates the *calling* workflow's filename against the trusted-publisher binding — a publish hidden behind `workflow_call` would mismatch (reusing `ci.yml` for the test matrix only is fine).
- One-time bootstrap (**done** 2026-10-03 — the binding is live and the v0.4.4 rehearsal published through it; keep for forks/re-creation): trusted publishing can only be configured once the package exists on npm (npm/cli#8544), so the **first** publish is a one-time manual `npm publish` (that one version carries no provenance). Then npmjs.com → package → Settings → Trusted publisher → GitHub Actions: org/user `bytesnail`, repo `opencode-secrets-env`, workflow filename `release.yml` (case-sensitive, `.yml` included; npm does not validate the fields until a publish runs), allowed action `npm publish`.
- Version policy: every release's semver level is a deliberate maintainer decision — `patch` for fixes, `minor` for features; going 1.0.0 is its own deliberate decision. Never bump the version outside a release commit.
- GitHub rulesets are configured (manage with `gh api repos/bytesnail/opencode-secrets-env/rulesets`): `v*` tags are immutable — creation restricted to repo admins, no update/deletion/force-push; `main` is protected against deletion and force-pushes. Recreate equivalent rules in a fork before relying on them.
- Optional hardening: restrict the binding to `npm stage publish` (every release then needs 2FA approval on npmjs.com), or put the publish job in a GitHub `environment` with required reviewers — the environment name must then also be entered in the trusted-publisher binding.
- `npm pack --dry-run` audits the tarball — the `files` whitelist must never ship `test/`, `.github/` or `AGENTS.md`.
- GitHub's repo **Packages** sidebar lists **GitHub Packages registry artifacts only** — an npmjs.com package never appears there, provenance or not (verified empty on this repo 2026-10-03). The link works the other way: provenance + the `repository` field make the npmjs package page point back to this repo/commit/workflow (live since v0.4.4). Populating the sidebar would need a mirror publish to `npm.pkg.github.com` — cosmetic only (GPR npm requires auth even for public installs); deliberately skipped. GitHub-side discoverability comes from the README npm badge and the Releases section.
