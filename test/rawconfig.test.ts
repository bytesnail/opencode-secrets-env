import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  configCandidates,
  hasEnvRef,
  makeRefScanner,
  parseJsonc,
  resolveTemplate,
  scanServerEnvRefs,
  selectReconnectTargets,
  setAtPath,
  stripJsonc,
  substitute,
  templateNames,
  type ScanEnvironment,
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

/**
 * Hermetic scan environment: pins every field so ambient OPENCODE_* variables
 * on a developer machine cannot leak into a test.
 */
function scanInput(dir: string, extra: Partial<ScanEnvironment> = {}): ScanEnvironment {
  return {
    xdgConfigHome: join(dir, "xdg"),
    home: join(dir, "home"),
    configDir: "",
    configFile: "",
    configContent: "",
    projectConfig: true,
    ...extra,
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

test("substitute matches the host's pattern, which allows '{' inside a name", () => {
  // The host substitutes with /\{env:([^}]+)\}/g; only "}" terminates a name.
  assert.equal(substitute("{env:A{B}", { "A{B": "odd" }), "odd")
  assert.equal(hasEnvRef("{env:A{B}"), true)
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

test("resolveTemplate resolves {env:...} and {file:...} in host order", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "token.txt"), "  file-secret\n\n")
    const ref = { path: ["headers", "X"], template: "{env:SCHEME} {file:token.txt}", dir }
    assert.equal(resolveTemplate(ref, { SCHEME: "Bearer" }), "Bearer file-secret")
  })
})

test("resolveTemplate resolves {file:...} against the config file's directory and expands ~", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.txt"), "relative")
    assert.equal(resolveTemplate({ path: [], template: "{file:a.txt}", dir }, {}), "relative")
    assert.equal(resolveTemplate({ path: [], template: "{file:~/none-opencode-secrets-env}", dir }, {}), "{file:~/none-opencode-secrets-env}")
  })
})

test("resolveTemplate escapes file content like JSON and leaves unreadable files literal", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "multiline.txt"), 'line "one"\nline two')
    assert.equal(resolveTemplate({ path: [], template: "{file:multiline.txt}", dir }, {}), 'line \\"one\\"\\nline two')
    // The host fails the whole config load for a missing {file:} target, so
    // the field never materializes; keep the literal token rather than
    // inventing a value.
    assert.equal(resolveTemplate({ path: [], template: "{file:missing.txt}", dir }, {}), "{file:missing.txt}")
  })
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

    const refs = scanServerEnvRefs(project, scanInput(dir))
    assert.deepEqual([...refs.keys()].sort(), ["local-one", "remote-one"])
    assert.deepEqual(refs.get("local-one"), [{ path: ["environment", "KEY"], template: "{env:PROJECT_KEY}", dir: project }])
    assert.deepEqual(refs.get("remote-one"), [
      { path: ["headers", "Authorization"], template: "Bearer {env:GLOBAL_KEY}", dir: join(xdg, "opencode") },
    ])
  })
})

test("scanServerEnvRefs prefers the higher precedence definition", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(join(project, ".opencode"), { recursive: true })
    writeFileSync(join(project, "opencode.jsonc"), `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:LOW}" } } } } }`)
    writeFileSync(join(project, ".opencode", "opencode.jsonc"), `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:HIGH}" } } } } }`)

    const refs = scanServerEnvRefs(project, scanInput(dir))
    assert.deepEqual(refs.get("s"), [{ path: ["environment", "K"], template: "{env:HIGH}", dir: join(project, ".opencode") }])
  })
})

test("scanServerEnvRefs lets a higher precedence definition without references claim the name", () => {
  // The host replaces a server wholesale with the highest-priority document
  // that defines it. A ref-less winner must block the loser's references, or
  // the transform would write substituted values into a server whose winning
  // definition never referenced them.
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, "opencode.jsonc"), `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"] } } } }`)
    const xdg = join(dir, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    writeFileSync(
      join(xdg, "opencode", "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:LOSER}" } } } } }`,
    )

    const refs = scanServerEnvRefs(project, scanInput(dir))
    assert.equal(refs.size, 0)
  })
})

test("scanServerEnvRefs returns an empty map when nothing references env", () => {
  withTempDir((dir) => {
    const refs = scanServerEnvRefs(dir, scanInput(dir))
    assert.equal(refs.size, 0)
  })
})

test("scanServerEnvRefs does not record phantom references with empty names", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["run", "{env:}"] } } } }`,
    )
    const refs = scanServerEnvRefs(dir, scanInput(dir))
    assert.equal(refs.size, 0)
  })
})

test("scanServerEnvRefs does not scan the legacy global config.json, which V2 dropped", () => {
  // V2's discovery only reads opencode.json/jsonc (verified against the host
  // source); V1 never consumes the scan. A stale config.json must not
  // contribute references.
  withTempDir((dir) => {
    const xdg = join(dir, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    writeFileSync(
      join(xdg, "opencode", "config.json"),
      `{ "mcp": { "servers": { "legacy": { "type": "remote", "url": "https://x", "headers": { "X": "{env:LEGACY_KEY}" } } } } }`,
    )

    const refs = scanServerEnvRefs(join(dir, "project"), scanInput(dir))
    assert.equal(refs.size, 0)
  })
})

// OpenCode V1's canonical schema defines servers directly at mcp.<name>;
// V2 nests them under mcp.servers.<name> and migrates the flat form as
// legacy. Both shapes must scan.

test("scanServerEnvRefs reads the flat V1 mcp shape", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{ "mcp": { "flat": { "type": "remote", "url": "https://x", "headers": { "Authorization": "Bearer {env:FLAT_KEY}" } } } }`,
    )
    const refs = scanServerEnvRefs(dir, scanInput(dir))
    assert.deepEqual(refs.get("flat"), [{ path: ["headers", "Authorization"], template: "Bearer {env:FLAT_KEY}", dir }])
  })
})

// Within one file V2 (the only host generation consuming these references)
// lets the nested mcp.servers entry override a flat legacy one of the same
// name — the scanner must match that precedence.

test("scanServerEnvRefs finds both shapes in one file and lets the nested entry win", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{
      "mcp": {
        "shared": { "type": "local", "command": ["run"], "environment": { "K": "{env:FLAT_LOSES}" } },
        "flat-only": { "type": "local", "command": ["run"], "environment": { "K": "{env:WRONG}" } },
        "servers": {
          "shared": { "type": "local", "command": ["run"], "environment": { "K": "{env:NESTED_WINS}" } },
          "nested-only": { "type": "local", "command": ["run"], "environment": { "K": "{env:NESTED_KEY}" } }
        }
      }
    }`,
    )
    const refs = scanServerEnvRefs(dir, scanInput(dir))
    assert.deepEqual([...refs.keys()].sort(), ["flat-only", "nested-only", "shared"])
    assert.deepEqual(refs.get("shared"), [{ path: ["environment", "K"], template: "{env:NESTED_WINS}", dir }])
    assert.deepEqual(refs.get("nested-only"), [{ path: ["environment", "K"], template: "{env:NESTED_KEY}", dir }])
    assert.deepEqual(refs.get("flat-only"), [{ path: ["environment", "K"], template: "{env:WRONG}", dir }])
  })
})

test("scanServerEnvRefs ignores enabled-only toggle entries in the flat shape", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      `{ "mcp": { "some-builtin": { "enabled": false }, "real": { "type": "local", "command": ["run", "{env:REAL_KEY}"] } } }`,
    )
    const refs = scanServerEnvRefs(dir, scanInput(dir))
    assert.deepEqual([...refs.keys()], ["real"])
    assert.deepEqual(refs.get("real"), [{ path: ["command", 1], template: "{env:REAL_KEY}", dir }])
  })
})

test("scanServerEnvRefs does not let dropped entries claim a server name", () => {
  // The host drops enabled-only toggles and mcp.timeout with diagnostics, so
  // they define nothing; a lower-precedence file's real definition (and its
  // references) must still win the name.
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(project, "opencode.jsonc"),
      `{ "mcp": {
        "s": { "enabled": false },
        "timeout": { "catalog": 5000 },
        "servers": { "toggled": { "enabled": true }, "also-dropped": "not-a-server" }
      } }`,
    )
    const xdg = join(dir, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    writeFileSync(
      join(xdg, "opencode", "opencode.jsonc"),
      `{ "mcp": { "servers": {
        "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:GLOBAL}" } },
        "toggled": { "type": "local", "command": ["a", "{env:TOGGLED}"] }
      } } }`,
    )

    const refs = scanServerEnvRefs(project, scanInput(dir))
    assert.deepEqual(refs.get("s"), [{ path: ["environment", "K"], template: "{env:GLOBAL}", dir: join(xdg, "opencode") }])
    assert.deepEqual(refs.get("toggled"), [{ path: ["command", 1], template: "{env:TOGGLED}", dir: join(xdg, "opencode") }])
    assert.equal(refs.has("timeout"), false)
    assert.equal(refs.has("also-dropped"), false)
  })
})

test("scanServerEnvRefs applies file precedence across shapes", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    // Project file defines "s" with the nested (V2) shape.
    writeFileSync(join(project, "opencode.jsonc"), `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:PROJECT}" } } } } }`)
    const xdg = join(dir, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    // Global file defines the same server with the flat (V1) shape — must lose.
    writeFileSync(join(xdg, "opencode", "opencode.jsonc"), `{ "mcp": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:GLOBAL}" } } } }`)

    const refs = scanServerEnvRefs(project, scanInput(dir))
    assert.deepEqual(refs.get("s"), [{ path: ["environment", "K"], template: "{env:PROJECT}", dir: project }])
  })
})

test("scanServerEnvRefs ranks inline OPENCODE_CONFIG_CONTENT above every file", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(project, "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:PROJECT}" } } } } }`,
    )
    const content = `{ "mcp": { "servers": {
      "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:CONTENT}" } },
      "inline-only": { "type": "remote", "url": "https://x/{env:INLINE}" }
    } } }`

    const refs = scanServerEnvRefs(project, scanInput(dir, { configContent: content }))
    assert.deepEqual(refs.get("s"), [{ path: ["environment", "K"], template: "{env:CONTENT}", dir: resolve(project) }])
    assert.deepEqual(refs.get("inline-only"), [{ path: ["url"], template: "https://x/{env:INLINE}", dir: resolve(project) }])
  })
})

test("scanServerEnvRefs ignores malformed inline content like the host does", () => {
  withTempDir((dir) => {
    const refs = scanServerEnvRefs(dir, scanInput(dir, { configContent: `{ "mcp": never closed` }))
    assert.equal(refs.size, 0)
  })
})

test("scanServerEnvRefs slots the explicit OPENCODE_CONFIG file between project and global", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    const explicit = join(dir, "custom.jsonc")
    writeFileSync(explicit, `{ "mcp": { "servers": {
      "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:EXPLICIT}" } },
      "explicit-only": { "type": "local", "command": ["a", "{env:EXPLICIT_ONLY}"] }
    } } }`)
    const xdg = join(dir, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    writeFileSync(
      join(xdg, "opencode", "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:GLOBAL}" } } } } }`,
    )

    // The explicit file beats the global one for "s".
    const refs = scanServerEnvRefs(project, scanInput(dir, { configFile: explicit }))
    assert.deepEqual(refs.get("s"), [{ path: ["environment", "K"], template: "{env:EXPLICIT}", dir }])
    assert.deepEqual(refs.get("explicit-only"), [{ path: ["command", 1], template: "{env:EXPLICIT_ONLY}", dir }])

    // But a project definition beats the explicit file.
    writeFileSync(
      join(project, "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:PROJECT}" } } } } }`,
    )
    const withProject = scanServerEnvRefs(project, scanInput(dir, { configFile: explicit }))
    assert.deepEqual(withProject.get("s"), [{ path: ["environment", "K"], template: "{env:PROJECT}", dir: project }])
  })
})

test("scanServerEnvRefs resolves the global directory through OPENCODE_CONFIG_DIR", () => {
  withTempDir((dir) => {
    const configDir = join(dir, "managed")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, "opencode.jsonc"),
      `{ "mcp": { "servers": { "managed": { "type": "local", "command": ["a", "{env:MANAGED}"] } } } }`,
    )

    const refs = scanServerEnvRefs(join(dir, "project"), scanInput(dir, { configDir }))
    assert.deepEqual(refs.get("managed"), [{ path: ["command", 1], template: "{env:MANAGED}", dir: configDir }])
  })
})

test("scanServerEnvRefs skips project files when project config is disabled", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(project, "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a", "{env:PROJECT}"] } } } }`,
    )
    const xdg = join(dir, "xdg")
    mkdirSync(join(xdg, "opencode"), { recursive: true })
    writeFileSync(
      join(xdg, "opencode", "opencode.jsonc"),
      `{ "mcp": { "servers": { "g": { "type": "local", "command": ["a", "{env:GLOBAL}"] } } } }`,
    )

    const enabled = scanServerEnvRefs(project, scanInput(dir))
    assert.deepEqual([...enabled.keys()].sort(), ["g", "s"])
    const disabled = scanServerEnvRefs(project, scanInput(dir, { projectConfig: false }))
    assert.deepEqual([...disabled.keys()], ["g"])
  })
})

test("configCandidates orders .opencode before direct configs and ends with global", () => {
  const candidates = configCandidates(join("/", "a", "b"), scanInput("/", { xdgConfigHome: "/xdg", home: "/home/u" }))
  const text = candidates.join("\n")
  assert.ok(text.indexOf(join("/", "a", "b", ".opencode", "opencode.jsonc")) < text.indexOf(join("/", ".opencode", "opencode.jsonc")))
  assert.ok(text.indexOf(join("/", ".opencode", "opencode.jsonc")) < text.indexOf(join("/", "a", "b", "opencode.jsonc")))
  assert.ok(text.indexOf(join("/", "opencode.jsonc")) < text.indexOf(join("/xdg", "opencode", "opencode.jsonc")))
})

test("configCandidates ends with the global jsonc/json pair and slots the explicit file before them", () => {
  const candidates = configCandidates(join("/", "a"), scanInput("/", { xdgConfigHome: "/xdg", home: "/home/u", configFile: "/etc/custom.jsonc" }))
  const explicit = candidates.indexOf(resolve("/etc/custom.jsonc"))
  const globalJsonc = candidates.indexOf(join("/xdg", "opencode", "opencode.jsonc"))
  const globalJson = candidates.indexOf(join("/xdg", "opencode", "opencode.json"))
  assert.ok(explicit !== -1 && globalJsonc !== -1 && globalJson !== -1)
  assert.ok(explicit === candidates.length - 3)
  assert.ok(globalJsonc === candidates.length - 2 && globalJson === candidates.length - 1)
})

test("configCandidates honors OPENCODE_CONFIG_DIR and the project-config switch", () => {
  const withConfigDir = configCandidates(join("/", "a"), scanInput("/", { configDir: "/managed" }))
  assert.deepEqual(withConfigDir.slice(-2), [join("/managed", "opencode.jsonc"), join("/managed", "opencode.json")])

  const withoutProject = configCandidates(join("/", "a", "b"), scanInput("/", { xdgConfigHome: "/xdg", projectConfig: false }))
  assert.deepEqual(withoutProject, [join("/xdg", "opencode", "opencode.jsonc"), join("/xdg", "opencode", "opencode.json")])
})

test("makeRefScanner memoizes until a config source appears or changes", () => {
  withTempDir((dir) => {
    const project = join(dir, "project")
    mkdirSync(project, { recursive: true })
    const input = scanInput(dir)
    const scanner = makeRefScanner(project, input)

    const empty = scanner()
    assert.equal(empty.size, 0)
    // No source change -> the exact same Map instance is returned.
    assert.equal(scanner(), empty)

    writeFileSync(
      join(project, "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:A}" } } } } }`,
    )
    const first = scanner()
    assert.notEqual(first, empty)
    assert.deepEqual(first.get("s"), [{ path: ["environment", "K"], template: "{env:A}", dir: project }])
    assert.equal(scanner(), first)

    // Same path but different content (different size) -> rescan.
    writeFileSync(
      join(project, "opencode.jsonc"),
      `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a"], "environment": { "K": "{env:BB}" } } } } }`,
    )
    const second = scanner()
    assert.notEqual(second, first)
    assert.deepEqual(second.get("s"), [{ path: ["environment", "K"], template: "{env:BB}", dir: project }])
  })
})

test("makeRefScanner rescans when the inline content changes", () => {
  withTempDir((dir) => {
    let content = ""
    const input: ScanEnvironment = {}
    // Read the mutable variable like the real environment read does.
    Object.defineProperty(input, "configContent", { get: () => content, enumerable: true })
    const scanner = makeRefScanner(dir, input)

    const empty = scanner()
    assert.equal(empty.size, 0)
    content = `{ "mcp": { "servers": { "s": { "type": "local", "command": ["a", "{env:LATE}"] } } } }`
    const next = scanner()
    assert.notEqual(next, empty)
    assert.deepEqual(next.get("s"), [{ path: ["command", 1], template: "{env:LATE}", dir: resolve(dir) }])
  })
})

test("templateNames extracts referenced variable names", () => {
  assert.deepEqual(templateNames("Bearer {env:TOKEN}"), ["TOKEN"])
  assert.deepEqual(templateNames("{env:A}-{env:B}"), ["A", "B"])
  assert.deepEqual(templateNames("plain"), [])
})

test("selectReconnectTargets with true only picks servers referencing changed keys", () => {
  const refs: ServerReferences = new Map([
    ["uses-changed", [{ path: ["environment", "K"], template: "{env:CHANGED_KEY}", dir: "/x" }]],
    ["uses-other", [{ path: ["headers", "X"], template: "Bearer {env:OTHER_KEY}", dir: "/x" }]],
  ])
  const servers = [
    { name: "uses-changed", disabled: false },
    { name: "uses-other", disabled: false },
    { name: "no-refs", disabled: false },
    { name: "disabled-but-referencing", disabled: true },
  ]
  const withDisabled: ServerReferences = new Map(refs)
  withDisabled.set("disabled-but-referencing", [{ path: ["environment", "K"], template: "{env:CHANGED_KEY}", dir: "/x" }])

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
