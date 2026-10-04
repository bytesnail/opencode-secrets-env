// Unit-test entry point: sanitize the ambient environment, then spawn
// `node --test`. Hermeticity is enforced mechanically here instead of
// relying on every test remembering to pin its ScanEnvironment —
// rawconfig/env resolution deliberately falls back to process.env for
// unset fields, so on desktops that export XDG_CONFIG_HOME (and have a
// real opencode config with {env:...} refs) an unpinned test silently
// reads the developer's actual configuration. Seen in practice: a bare
// `{}` scan input made an "empty scan" assertion find 4 refs from the
// maintainer's real global config.
//
// Usage:
//   node test/run.mjs                        # full unit suite
//   node test/run.mjs test/rawconfig.test.ts # single file(s), same as
//                                            # `node --test <file>` but sanitized
//
// Only the variables that redirect config/data resolution are stripped;
// HOME and friends stay, and tests that need specific variables set them
// inside the process (and restore them) as before.
import { spawnSync } from "node:child_process"

const SANITIZE = [/^OPENCODE_/, /^XDG_(CONFIG_HOME|DATA_HOME|CACHE_HOME|STATE_HOME)$/]
for (const key of Object.keys(process.env)) {
  if (SANITIZE.some((re) => re.test(key))) delete process.env[key]
}

const defaultFiles = [
  "test/env.test.ts",
  "test/rawconfig.test.ts",
  "test/options.test.ts",
  "test/index.test.ts",
  "test/mcp.test.ts",
  "test/changelog.test.ts",
]
const files = process.argv.slice(2)
const result = spawnSync(process.execPath, ["--test", ...(files.length > 0 ? files : defaultFiles)], {
  stdio: "inherit",
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
