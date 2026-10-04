# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versioning
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html): patch for
fixes, minor for features.

## [Unreleased]

### Fixed

- Hot reload could permanently miss an edit when the OS dropped the
  file-watch event — observed with FSEvents on loaded macOS CI runners,
  where no event arrived within 60 s. The event watcher is now backed by a
  low-frequency mtime poll (default 5 s; new `pollIntervalMs` option), so a
  dropped event degrades to a few seconds' delay instead of a missed reload
  until restart. (`78134e8`)
- Unit tests are now hermetic on machines that export ambient
  `XDG_*`/`OPENCODE_*` variables: the test entry point strips them, and the
  inline-content rescan test pins its scan input. (`8bdfe06`, `d0cb49f`)

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

[Unreleased]: https://github.com/bytesnail/opencode-secrets-env/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/bytesnail/opencode-secrets-env/compare/v0.4.5...v0.5.0
[0.4.5]: https://github.com/bytesnail/opencode-secrets-env/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/bytesnail/opencode-secrets-env/commits/v0.4.4
[0.4.3]: https://www.npmjs.com/package/opencode-secrets-env/v/0.4.3
