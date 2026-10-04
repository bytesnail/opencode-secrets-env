## What & why

<!-- One concern per PR. Describe the user-visible behavior change. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (the e2e matrix runs in CI)
- [ ] `README.md` and `README.zh-CN.md` updated **in sync** (if user-facing)
- [ ] Log-message wording and its tests updated together (log wording is a test contract — see AGENTS.md)
- [ ] `package.json` `version` untouched (bumps happen only in release commits)
- [ ] Commit subjects use conventional prefixes (`feat:`/`fix:`/`docs:`/…) — they feed the release changelog draft
- [ ] No real secrets in tests, fixtures, or screenshots
