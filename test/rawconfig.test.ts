import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  configCandidates,
  hasEnvRef,
  makeRefScanner,
  parseJsonc,
  scanServerEnvRefs,
  selectReconnectTargets,
  setAtPath,
  stripJsonc,
  substitute,
  templateNames,
  type ServerReferences,
} from "../rawconfig.ts"

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "opencode-secrets-env-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("stripJsonc removes comments and trailing commas but keeps strings intact", () => {
  const input = `{
  // line comment
  "url": "https://example.com//path", /* block comment */
  "escaped": "a \\" // not a comment",
  "list": [1, 2,],
}`
  const parsed = JSON.parse(stripJsonc(input)) as Record<string, unknown>
  assert.equal(parsed.url, "https://example.com//path")
  assert.equal(parsed.escaped, 'a " // not a comment')
  assert.deepEqual(parsed.list, [1, 2])
})

test("stripJsonc never touches comma/bracket sequences inside string values", () => {
  // Regression: a regex-based trailing-comma pass corrupted values like these.
  const parsed = JSON.parse(stripJsonc(`{
  "url": "https://x.test/a,}",
  "list": "b, ]",
  "tricky": "say \\", } hi",
  "nested": { "v": "c,}" },
}`)) as Record<string, unknown>
  assert.equal(parsed.url, "https://x.test/a,}")
  assert.equal(parsed.list, "b, ]")
  assert.equal(parsed.tricky, 'say ", } hi')
  assert.deepEqual(parsed.nested, { v: "c,}" })
})

test("stripJsonc drops a trailing comma even when a comment sits before the bracket", () => {
  const parsed = JSON.parse(stripJsonc(`{ "a": [1, 2, /* why */ ], // done
}`)) as Record<string, unknown>
  assert.deepEqual(parsed.a, [1, 2])
})

test("stripJsonc tolerates unterminated comments and strings", () => {
  assert.equal(stripJsonc(`{ "a": 1 /* never closed`), `{ "a": 1 `)
  assert.throws(() => parseJsonc(`{ "a": "never closed`))
})

test("parseJsonc parses a realistic opencode config", () => {
  const config = parseJsonc(`{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "probe": { "type": "local", "command": ["sh", "run.sh"], }
    }
  }
}`) as { mcp: { servers: Record<string, unknown> } }
  assert.equal(Object.keys(config.mcp.servers).length, 1)
})

test("substitute replaces references and empties missing variables", () => {
  const env = { TOKEN: "abc123" }
  assert.equal(substitute("Bearer {env:TOKEN}", env), "Bearer abc123")
  assert.equal(substitute("{env:MISSING}", env), "")
  assert.equal(substitute("no refs", env), "no refs")
  assert.equal(substitute("{env:TOKEN}-{env:TOKEN}", env), "abc123-abc123")
})

test("hasEnvRef detects references", () => {
  assert.equal(hasEnvRef("{env:X}"), true)
  assert.equal(hasEnvRef("prefix {env:X} suffix"), true)
  assert.equal(hasEnvRef("plain"), false)
})

test("hasEnvRef ignores empty reference names, matching substitute()", () => {
  assert.equal(hasEnvRef("{env:}"), false)
  assert.equal(substitute("{env:}", { A: "1" }), "{env:}")
})

test("setAtPath writes nested values along existing string slots", () => {
  const server = {
    type: "local",
    command: ["sh", "-c", "old"],
    environment: { KEY: "old", OTHER: "keep" },
  }
  setAtPath(server, ["environment", "KEY"], "new")
  setAtPath(server, ["command", 2], "new-cmd")
  setAtPath(server, ["missing", "deep"], "ignored")
  assert.equal(server.environment.KEY, "new")
  assert.equal(server.environment.OTHER, "keep")
  assert.equal(server.command[2], "new-cmd")
  assert.equal("missing" in server, false)
})

test("scanServerEnvRefs finds references across the config chain", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(project, "opencode.jsonc"),
      `{
      // project config
      "mcp": { "servers": {
        "local-one": { "type": "local", "command": ["run"], "environment": { "KEY": "{env:PROJECT_KEY}" } },
        "plain": { "type": "local", "command": ["run"] }
      } }
    }`,
    )
    const xdg = join(dir, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    writeFileSync(
      join(xdg, "opencode", "opencode.jsonc"),
      `{
      "mcp": { "servers": {
        "remote-one": { "type": "remote", "url": "https://x", "headers": { "Authorization": "Bearer {env:GLOBAL_KEY}" } }
      } }
    }`,
    )

    const refs = scanServerEnvRefs(project, { xdgConfigHome: xdg, home: join(dir, "home") })
    assert.deepEqual([...refs.keys()].sort(), ["local-one", "remote-one"])
    assert.deepEqual(refs.get("local-one"), [{ path: ["environment", "KEY"], template: "{env:PROJECT_KEY}" }])
    assert.deepEqual(refs.get("remote-one"), [
      { path: ["headers", "Authorization"], template: "Bearer {env:GLOBAL_KEY}" },
    ])
  })
})

test("scanServerEnvRefs prefers the higher precedence definition", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(join(project, ".opencode"), { recursive: true })
    writeFileSync(join(project, "opencode.jsonc"), `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:LOW}" } } } } }`)
    writeFileSync(join(project, ".opencode", "opencode.jsonc"), `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:HIGH}" } } } } }`)

    const refs = scanServerEnvRefs(project, { xdgConfigHome: join(dir, "xdg"), home: join(dir, "home") })
    assert.deepEqual(refs.get("s"), [{ path: ["environment", "K"], template: "{env:HIGH}" }])
  })
})

test("scanServerEnvRefs returns an empty map when nothing references env", () => {
  withTempDir((dir) => {
    const refs = scanServerEnvRefs(dir, { xdgConfigHome: join(dir, "xdg"), home: join(dir, "home") })
    assert.equal(refs.size, 0)
  })
})

test("scanServerEnvRefs does not record phantom references with empty names", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["run", "{env:}"] } } } }`,
    )
    const refs = scanServerEnvRefs(dir, { xdgConfigHome: join(dir, "xdg"), home: join(dir, "home") })
    assert.equal(refs.size, 0)
  })
})

test("scanServerEnvRefs reads servers defined in the legacy global config.json", () => {
  withTempDir((dir) => {
    const xdg = join(dir, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    writeFileSync(
      join(xdg, "opencode", "config.json"),
      `{ "mcp": { "servers": { "legacy": { "type": "remote", "url": "https://x", "headers": { "X": "{env:LEGACY_KEY}" } } } } }`,
    )

    const refs = scanServerEnvRefs(join(dir, "project"), { xdgConfigHome: xdg, home: join(dir, "home") })
    assert.deepEqual(refs.get("legacy"), [{ path: ["headers", "X"], template: "{env:LEGACY_KEY}" }])
  })
})

// OpenCode V2's canonical schema puts server definitions directly at
// mcp.<name> instead of nesting them under mcp.servers.<name>.

test("scanServerEnvRefs reads the flat V2 mcp shape", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{ "mcp": { "flat": { "type": "remote", "url": "https://x", "headers": { "Authorization": "Bearer {env:FLAT_KEY}" } } } }`,
    )
    const refs = scanServerEnvRefs(dir, { xdgConfigHome: join(dir, "xdg"), home: join(dir, "home") })
    assert.deepEqual(refs.get("flat"), [{ path: ["headers", "Authorization"], template: "Bearer {env:FLAT_KEY}" }])
  })
})

test("scanServerEnvRefs finds both shapes in one file and lets the flat entry win", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{
      "mcp": {
        "shared": { "type": "local", "command": ["run"], "environment": { "K": "{env:FLAT_WINS}" } },
        "legacy-only": { "type": "local", "command": ["run"], "environment": { "K": "{env:WRONG}" } },
        "servers": {
          "shared": { "type": "local", "command": ["run"], "environment": { "K": "{env:LEGACY_LOSES}" } },
          "nested-only": { "type": "local", "command": ["run"], "environment": { "K": "{env:NESTED_KEY}" } }
        }
      }
    }`,
    )
    const refs = scanServerEnvRefs(dir, { xdgConfigHome: join(dir, "xdg"), home: join(dir, "home") })
    assert.deepEqual([...refs.keys()].sort(), ["legacy-only", "nested-only", "shared"])
    assert.deepEqual(refs.get("shared"), [{ path: ["environment", "K"], template: "{env:FLAT_WINS}" }])
    assert.deepEqual(refs.get("nested-only"), [{ path: ["environment", "K"], template: "{env:NESTED_KEY}" }])
    assert.deepEqual(refs.get("legacy-only"), [{ path: ["environment", "K"], template: "{env:WRONG}" }])
  })
})

test("scanServerEnvRefs ignores enabled-only toggle entries in the flat shape", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{ "mcp": { "some-builtin": { "enabled": false }, "real": { "type": "local", "command": ["run", "{env:REAL_KEY}"] } } }`,
    )
    const refs = scanServerEnvRefs(dir, { xdgConfigHome: join(dir, "xdg"), home: join(dir, "home") })
    assert.deepEqual([...refs.keys()], ["real"])
    assert.deepEqual(refs.get("real"), [{ path: ["command", 1], template: "{env:REAL_KEY}" }])
  })
})

test("scanServerEnvRefs applies file precedence across shapes", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    // Project file defines "s" with the legacy nested shape.
    writeFileSync(join(project, "opencode.jsonc"), `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:PROJECT}" } } } } }`)
    const xdg = join(dir, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    // Global file defines the same server with the flat shape — must lose.
    writeFileSync(join(xdg, "opencode", "opencode.jsonc"), `{ "mcp": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:GLOBAL}" } } } }`)

    const refs = scanServerEnvRefs(project, { xdgConfigHome: xdg, home: join(dir, "home") })
    assert.deepEqual(refs.get("s"), [{ path: ["environment", "K"], template: "{env:PROJECT}" }])
  })
})

test("configCandidates orders .opencode before direct configs and ends with global", () => {
  const candidates = configCandidates(join("/", "a", "b"), { xdgConfigHome: "/xdg", home: "/home/u" })
  const text = candidates.join("\n")
  assert.ok(text.indexOf(join("/", "a", "b", ".opencode", "opencode.jsonc")) < text.indexOf(join("/", ".opencode", "opencode.jsonc")))
  assert.ok(text.indexOf(join("/", ".opencode", "opencode.jsonc")) < text.indexOf(join("/", "a", "b", "opencode.jsonc")))
  assert.ok(text.indexOf(join("/", "opencode.jsonc")) < text.indexOf(join("/xdg", "opencode", "opencode.jsonc")))
})

test("configCandidates includes the legacy global config.json at the lowest precedence", () => {
  const candidates = configCandidates(join("/", "a"), { xdgConfigHome: "/xdg", home: "/home/u" })
  const globalJsonc = candidates.indexOf(join("/xdg", "opencode", "opencode.jsonc"))
  const globalJson = candidates.indexOf(join("/xdg", "opencode", "opencode.json"))
  const globalConfigJson = candidates.indexOf(join("/xdg", "opencode", "config.json"))
  assert.ok(globalJsonc !== -1 && globalJson !== -1)
  assert.ok(globalConfigJson === candidates.length - 1)
  assert.ok(globalJsonc < globalJson && globalJson < globalConfigJson)
})

test("makeRefScanner memoizes until a config file appears or changes", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    const input = { xdgConfigHome: join(dir, "xdg"), home: join(dir, "home") }
    const scanner = makeRefScanner(project, input)

    const empty = scanner()
    assert.equal(empty.size, 0)
    // No file change -> the exact same Map instance is returned.
    assert.equal(scanner(), empty)

    writeFileSync(
      join(project, "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:A}" } } } } }`,
    )
    const first = scanner()
    assert.notEqual(first, empty)
    assert.deepEqual(first.get("s"), [{ path: ["environment", "K"], template: "{env:A}" }])
    assert.equal(scanner(), first)

    // Same path but different content (different size) -> rescan.
    writeFileSync(
      join(project, "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:BB}" } } } } }`,
    )
    const second = scanner()
    assert.notEqual(second, first)
    assert.deepEqual(second.get("s"), [{ path: ["environment", "K"], template: "{env:BB}" }])
  })
})

test("templateNames extracts referenced variable names", () => {
  assert.deepEqual(templateNames("Bearer {env:TOKEN}"), ["TOKEN"])
  assert.deepEqual(templateNames("{env:A}-{env:B}"), ["A", "B"])
  assert.deepEqual(templateNames("plain"), [])
})

test("selectReconnectTargets with true only picks servers referencing changed keys", () => {
  const refs: ServerReferences = new Map([
    ["uses-changed", [{ path: ["environment", "K"], template: "{env:CHANGED_KEY}" }]],
    ["uses-other", [{ path: ["headers", "X"], template: "Bearer {env:OTHER_KEY}" }]],
  ])
  const servers = [
    { name: "uses-changed", disabled: false },
    { name: "uses-other", disabled: false },
    { name: "no-refs", disabled: false },
    { name: "disabled-but-referencing", disabled: true },
  ]
  const withDisabled: ServerReferences = new Map(refs)
  withDisabled.set("disabled-but-referencing", [{ path: ["environment", "K"], template: "{env:CHANGED_KEY}" }])

  assert.deepEqual(selectReconnectTargets(servers, withDisabled, new Set(["CHANGED_KEY"]), true), ["uses-changed"])
  assert.deepEqual(selectReconnectTargets(servers, withDisabled, new Set(["OTHER_KEY"]), true), ["uses-other"])
  assert.deepEqual(selectReconnectTargets(servers, withDisabled, new Set(["UNRELATED"]), true), [])
})

test("selectReconnectTargets supports all, allowlist and false", () => {
  const refs: ServerReferences = new Map()
  const servers = [
    { name: "a", disabled: false },
    { name: "b", disabled: false },
    { name: "c", disabled: true },
  ]
  const changed = new Set(["KEY"])
  assert.deepEqual(selectReconnectTargets(servers, refs, changed, "all"), ["a", "b"])
  assert.deepEqual(selectReconnectTargets(servers, refs, changed, ["b", "c"]), ["b"])
  assert.deepEqual(selectReconnectTargets(servers, refs, changed, false), [])
})
