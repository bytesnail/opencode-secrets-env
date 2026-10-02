import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultSecretsPath, expandPath, loadSecrets, missingRequired } from "../env.ts"

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "opencode-secrets-env-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("loadSecrets applies variables from the file to the target env", () => {
  withTempDir((dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, "API_KEY=secret-1\nOTHER=secret-2\n", { mode: 0o600 })
    const env: Record<string, string | undefined> = {}

    const result = loadSecrets({ path: file, env })

    assert.equal(env.API_KEY, "secret-1")
    assert.equal(env.OTHER, "secret-2")
    assert.deepEqual(result.applied.sort(), ["API_KEY", "OTHER"])
    assert.deepEqual(result.skipped, [])
    assert.equal(result.file, file)
    assert.equal(result.insecurePermissions, false)
    assert.equal(result.error, undefined)
  })
})

test("loadSecrets keeps existing variables unless override is enabled", () => {
  withTempDir((dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, "API_KEY=from-file\nNEW_KEY=new\n", { mode: 0o600 })
    const env: Record<string, string | undefined> = { API_KEY: "from-shell" }

    const first = loadSecrets({ path: file, env })
    assert.equal(env.API_KEY, "from-shell")
    assert.equal(env.NEW_KEY, "new")
    assert.deepEqual(first.applied, ["NEW_KEY"])
    assert.deepEqual(first.skipped, ["API_KEY"])

    const second = loadSecrets({ path: file, env, override: true })
    assert.equal(env.API_KEY, "from-file")
    assert.deepEqual(second.applied.sort(), ["API_KEY", "NEW_KEY"])
    assert.deepEqual(second.skipped, [])
  })
})

test("loadSecrets treats an existing empty string as already set", () => {
  withTempDir((dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, "API_KEY=from-file\n", { mode: 0o600 })
    const env: Record<string, string | undefined> = { API_KEY: "" }

    const result = loadSecrets({ path: file, env })
    assert.equal(env.API_KEY, "")
    assert.deepEqual(result.skipped, ["API_KEY"])
  })
})

test("loadSecrets supports dotenv quoting, export prefix and comments", () => {
  withTempDir((dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(
      file,
      [
        "# a comment",
        "export EXPORTED=one",
        'QUOTED="two words"',
        "SINGLE='three words'",
        "INLINE=value # trailing comment",
        "EMPTY=",
        "",
      ].join("\n"),
      { mode: 0o600 },
    )
    const env: Record<string, string | undefined> = {}

    loadSecrets({ path: file, env })

    assert.equal(env.EXPORTED, "one")
    assert.equal(env.QUOTED, "two words")
    assert.equal(env.SINGLE, "three words")
    assert.equal(env.INLINE, "value")
    assert.equal(env.EMPTY, "")
  })
})

test("loadSecrets returns an empty result when the file does not exist", () => {
  withTempDir((dir) => {
    const result = loadSecrets({ path: join(dir, "missing.env"), env: {} })
    assert.equal(result.file, undefined)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.applied, [])
    assert.deepEqual(result.parsed, [])
  })
})

test("loadSecrets reports unreadable files as errors", () => {
  if (process.platform === "win32") return
  withTempDir((dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, "API_KEY=x\n", { mode: 0o600 })
    chmodSync(file, 0o000)

    const result = loadSecrets({ path: file, env: {} })
    assert.equal(result.file, undefined)
    assert.ok(result.error instanceof Error)
  })
})

test("loadSecrets flags group/world readable files as insecure", () => {
  if (process.platform === "win32") return
  withTempDir((dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, "API_KEY=x\n", { mode: 0o644 })

    const result = loadSecrets({ path: file, env: {} })
    assert.equal(result.insecurePermissions, true)
  })
})

test("loadSecrets resolves the default location from XDG_CONFIG_HOME", () => {
  withTempDir((dir) => {
    const config = join(dir, "xdg")
    mkdirSync(join(config, "opencode"), { recursive: true })
    const file = join(config, "opencode", "secrets.env")
    writeFileSync(file, "API_KEY=xdg-secret\n", { mode: 0o600 })
    const env: Record<string, string | undefined> = {}

    const result = loadSecrets({ env, xdgConfigHome: config })

    assert.equal(env.API_KEY, "xdg-secret")
    assert.equal(result.file, file)
  })
})

test("defaultSecretsPath prefers XDG_CONFIG_HOME and falls back to ~/.config", () => {
  assert.equal(
    defaultSecretsPath({ xdgConfigHome: "/xdg", home: "/home/user" }),
    join("/xdg", "opencode", "secrets.env"),
  )
  assert.equal(
    defaultSecretsPath({ xdgConfigHome: "", home: "/home/user" }),
    join("/home/user", ".config", "opencode", "secrets.env"),
  )
})

test("expandPath expands tilde, keeps absolute paths and resolves relative ones", () => {
  assert.equal(expandPath("~", "/base", "/home/user"), "/home/user")
  assert.equal(expandPath("~/secrets.env", "/base", "/home/user"), join("/home/user", "secrets.env"))
  assert.equal(expandPath("/etc/secrets.env", "/base", "/home/user"), "/etc/secrets.env")
  assert.equal(expandPath("secrets.env", "/base", "/home/user"), join("/base", "secrets.env"))
})

test("missingRequired lists variables absent from the environment", () => {
  assert.deepEqual(missingRequired(["A", "B", "C"], { A: "1", B: "" }), ["C"])
  assert.deepEqual(missingRequired([], {}), [])
})
