# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versioning
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html): patch for
fixes, minor for features.

## [Unreleased]

## [0.6.1] - 2026-11-14

### Fixed

- Preserve real characters when object-layer MCP templates combine `{env:...}`
  and `{file:...}` references; unreadable file references now resolve to an
  empty string, matching the V2.2.6 host behavior. (`def4f89`)
- Harden hot reload: watcher failures retry with bounded backoff, content-hash
  polling catches same-metadata rewrites, POSIX chmod-only recovery works, and
  normalized/symlinked paths share one ownership state. (`def4f89`)
- Use own-property checks so prototype-named environment keys can be withdrawn
  correctly, and warn when instances sharing one file have conflicting reload
  options. (`def4f89`)
- Invalid `pollIntervalMs` values, including fractions, now fall back to the
  5000 ms default with a warning instead of being silently floored. (`fb282cc`)
- Allow additional startup time for the real V1 server on Windows runners. (`e3920bf`)

### Security

- Stage npm releases with provenance for independent maintainer 2FA approval
  instead of publishing directly from CI. (`fb282cc`)
- Add daily npm registry/GitHub Release reconciliation, including dist-tag and
  `latest` checks, a 24-hour approval grace period, and deduplicated alerts. (`fb282cc`)
- Refresh dependencies to address the undici/zod/ip-address and nested glob
  advisories covered by the dependency updates. (`f6bb2f1`, `8ba1d9a`)

### Documentation

- Add concise compromised-version response guidance and update the maintainer
  release/runbook documentation. (`fb282cc`)
- Record the CodeQL dependabot group, SSH branch refresh, and local e2e HOME
  sandbox. (`cf8456c`)

### Internal

- Add a real V2 multi-location measurement; the current host uses independent
  plugin module state across locations. (`fb282cc`)
- Bump actions/setup-node from 7.0.0 to 7.1.0 (#11) (`4b2b8b1`)
- Bump github/codeql-action from 4.38.2 to 4.39.1 (#16) (`32e893a`)
- Bump the CodeQL group with 2 updates (#18) (`964a755`)
- Pin the V2 host spec to 2.2.6, aligned with the plugin SDK (#20) (`c57b3e9`)

## [0.6.0] - 2026-10-05

### Added

- New `pollIntervalMs` option (default `5000`): interval of the mtime poll
  backing the file watcher when `watch` is on. `0` disables the poll (not
  recommended). (`78134e8`)
- Generate CHANGELOG.md during npm version, release notes from changelog (`2be4ce0`)
- Dedupe generated entries against curated lines and repeated subjects (#7) (`401086d`)

### Fixed

- Hot reload could permanently miss an edit when the OS dropped the
  file-watch event — observed with FSEvents on loaded macOS CI runners,
  where no event arrived within 60 s. The event watcher is now backed by a
  low-frequency mtime poll, so a dropped event degrades to a few seconds'
  delay instead of a missed reload until restart. (`78134e8`)
- Unit tests are now hermetic on machines that export ambient
  `XDG_*`/`OPENCODE_*` variables: the test entry point strips them, and the
  inline-content rescan test pins its scan input. (`8bdfe06`, `d0cb49f`)

### Documentation

- Add CHANGELOG.md and link it from both READMEs (`b49f329`)
- Sync contributor docs with changelog automation and weekly CI (`0a1b658`)
- State tested platforms — badge plus a line in Install (`a7b86f8`)
- Close gaps in the PR/release workflow writeup (#5) (`b039192`)

### Internal

- Weekly e2e against latest hosts for upstream drift detection (`c0c6de4`)
- Add macOS to unit and e2e matrices; slim README Development sections (`66cee07`)
- Bump http-cache-semantics to 4.3.0 (GHSA-ch52-4w7c-c8xp, via npm audit fix) (`31230b0`)
- Normalize lockfile resolved hosts to npmmirror (`dc60ac6`)
- Harden workflows — SHA-pin actions, least-privilege tokens, dependabot, CodeQL (`8126660`)
- Add single 'gate' check context for the upcoming PR-gated main (#3) (`301f1d2`)
- Bump actions/checkout from 6.1.0 to 7.0.1 (#1) (`68a9cd5`)
- Bump actions/setup-node from 6.5.0 to 7.0.0 (#2) (`dec0481`)
- Platform-scaled hot-reload waitFor ceiling (darwin 60s, others 15s) (#4) (`59194ba`)

## [0.5.0] - 2026-10-04

### Added

- Hot-reload demo GIF in the README, with a re-recordable asciinema harness
  under `test/e2e/demo/`.
- Community health files: `SECURITY.md`, `CONTRIBUTING.md`, Contributor
  Covenant 2.1 `CODE_OF_CONDUCT.md` (bilingual), issue/PR templates, and
  README badges (npm version/downloads, CI, license).

## [0.4.5] - 2026-10-04

### Fixed

- Raw-config scan aligned with the host's actual semantics as of v2.0.22:
  both the flat `mcp.<name>` and nested `mcp.servers.<name>` shapes are
  scanned with the nested entry winning within one file; the first source in
  precedence order that *defines* a server name claims it (with or without
  refs); host-dropped entries (`{"enabled": bool}` toggles, `mcp.timeout`)
  claim nothing; `.opencode/` directories all outrank direct ancestor files;
  V2 does not read `config.json`.
- Homepage URL no longer carries a `#readme` fragment.

### Changed

- Version policy switched to bump-at-release-time: `package.json` on `main`
  always mirrors the latest published npm version, and the bump happens only
  in the release commit. (Commit messages before this release may carry
  `(vX.Y.Z)` suffixes from the previous policy.)

## [0.4.4] - 2026-10-03

### Fixed

- Corrected the V1 install instructions: V1 has no plugin CLI command — npm
  plugins named in the `plugin` config key are auto-installed at startup.
  The zh-CN README was brought to full parity.

### Added

- Tag-triggered, CI-gated npm releases via trusted publishing (OIDC
  provenance), with automatic GitHub Releases. The full CI matrix (unit +
  real-host e2e, ubuntu + windows) replays before any publish.

## [0.4.3] - 2026-10-03

First public release.

### Added

- Injects secrets from `~/.config/opencode/secrets.env` into `process.env`
  at startup on both V1 (`>= 1.14.34`) and V2 hosts, with options `path`,
  `override`, `required`, `watch`, `mcpReconnect`, `quiet`, `debug`.
- Hot reload on file change (~1 s), with precise MCP reconnection limited to
  servers referencing a changed variable (V2 only), a permanent `{env:...}`
  re-substitution transform, and a bounded rotating log that never records
  values.
- Bilingual READMEs (English / 简体中文).
- Real-host end-to-end tests on Linux and Windows, plus Windows unit CI.

### Fixed

- Bounded log file, always-on env-ref transform, resilient file watcher.
- Scan the flat V2 `mcp.<name>` config shape; evidence-based V1 floor
  (1.14.34).
- Windows: platform-aware `~\` expansion, npm via `cmd.exe` in the e2e
  harness.

[Unreleased]: https://github.com/bytesnail/opencode-secrets-env/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/bytesnail/opencode-secrets-env/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/bytesnail/opencode-secrets-env/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/bytesnail/opencode-secrets-env/compare/v0.4.5...v0.5.0
[0.4.5]: https://github.com/bytesnail/opencode-secrets-env/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/bytesnail/opencode-secrets-env/commits/v0.4.4
[0.4.3]: https://www.npmjs.com/package/opencode-secrets-env/v/0.4.3
