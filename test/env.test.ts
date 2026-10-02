import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SecretsStore,
  defaultSecretsPath,
  expandPath,
  missingRequired,
  readSecrets,
} from "../env.ts"

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "opencode-secrets-env-"))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// readSecrets
// ---------------------------------------------------------------------------

test("readSecrets parses dotenv quoting, export prefix and comments", () => {
  withTempDir((dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(
      file,
      ["# a comment", "export EXPORTED=one", 'QUOTED="two words"', "SINGLE='three words'", "INLINE=value # trailing comment", "EMPTY=", ""].join("\n"),
      { mode: 0o600 },
    )

    const result = readSecrets(file)
    assert.equal(result.found, true)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.parsed, {
      EXPORTED: "one",
      QUOTED: "two words",
      SINGLE: "three words",
      INLINE: "value",
      EMPTY: "",
    })
  })
})

test("readSecrets reports missing files without an error", () => {
  withTempDir((dir) => {
    const result = readSecrets(join(dir, "missing.env"))
    assert.equal(result.found, false)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.parsed, {})
  })
})

test("readSecrets reports unreadable files as errors", () => {
  if (process.platform === "win32") return
  withTempDir((dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, "API_KEY=x\n", { mode: 0o600 })
    chmodSync(file, 0o000)

    const result = readSecrets(file)
    assert.equal(result.found, false)
    assert.ok(result.error instanceof Error)
  })
})

test("readSecrets flags group/world readable files as insecure", () => {
  if (process.platform === "win32") return
  withTempDir((dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, "API_KEY=x\n", { mode: 0o644 })
    assert.equal(readSecrets(file).insecurePermissions, true)
    chmodSync(file, 0o600)
    assert.equal(readSecrets(file).insecurePermissions, false)
  })
})

// ---------------------------------------------------------------------------
// SecretsStore
// ---------------------------------------------------------------------------

test("SecretsStore injects new keys and tracks ownership", () => {
  const env: Record<string, string | undefined> = {}
  const store = new SecretsStore(env)

  const result = store.apply({ A: "1", B: "2" })
  assert.equal(env.A, "1")
  assert.equal(env.B, "2")
  assert.deepEqual(result.added.sort(), ["A", "B"])
  assert.deepEqual(result.kept, [])
  assert.deepEqual(store.keys().sort(), ["A", "B"])
})

test("SecretsStore keeps real environment values unless override is set", () => {
  const env: Record<string, string | undefined> = { REAL: "from-shell" }
  const store = new SecretsStore(env)

  const first = store.apply({ REAL: "from-file", NEW: "n" })
  assert.equal(env.REAL, "from-shell")
  assert.deepEqual(first.kept, ["REAL"])
  assert.deepEqual(first.added, ["NEW"])
  assert.deepEqual(store.keys(), ["NEW"])

  // Each apply is a full file snapshot: include NEW so it is not withdrawn.
  const second = store.apply({ REAL: "from-file", NEW: "n" }, { override: true })
  assert.equal(env.REAL, "from-file")
  assert.equal(env.NEW, "n")
  assert.deepEqual(second.added, ["REAL"])
  assert.deepEqual(second.removed, [])
  assert.deepEqual(store.keys().sort(), ["NEW", "REAL"])
})

test("SecretsStore updates owned keys on reload but never real ones", () => {
  const env: Record<string, string | undefined> = { REAL: "from-shell" }
  const store = new SecretsStore(env)

  store.apply({ OWNED: "v1", REAL: "ignored" })
  const reload = store.apply({ OWNED: "v2", REAL: "ignored-again" })
  assert.equal(env.OWNED, "v2")
  assert.equal(env.REAL, "from-shell")
  assert.deepEqual(reload.updated, ["OWNED"])
  assert.deepEqual(reload.kept, ["REAL"])
})

test("SecretsStore withdraws keys that disappear from the file", () => {
  const env: Record<string, string | undefined> = {}
  const store = new SecretsStore(env)

  store.apply({ STAY: "1", LEAVE: "2" })
  const reload = store.apply({ STAY: "1" })
  assert.equal(env.STAY, "1")
  assert.equal(env.LEAVE, undefined)
  assert.deepEqual(reload.removed, ["LEAVE"])
  assert.deepEqual(store.keys(), ["STAY"])
})

test("SecretsStore restores the original value when an overridden key is withdrawn", () => {
  const env: Record<string, string | undefined> = { REAL: "from-shell" }
  const store = new SecretsStore(env)

  store.apply({ REAL: "from-file" }, { override: true })
  assert.equal(env.REAL, "from-file")

  const reload = store.apply({}, { override: true })
  assert.equal(env.REAL, "from-shell")
  assert.deepEqual(reload.removed, ["REAL"])
  assert.deepEqual(store.keys(), [])
})

test("SecretsStore releases everything it owns", () => {
  const env: Record<string, string | undefined> = { REAL: "from-shell" }
  const store = new SecretsStore(env)

  store.apply({ A: "1", REAL: "overridden" }, { override: true })
  const released = store.release()
  assert.deepEqual(released.sort(), ["A", "REAL"])
  assert.equal(env.A, undefined)
  assert.equal(env.REAL, "from-shell")
})

test("SecretsStore treats an existing empty string as a real value", () => {
  const env: Record<string, string | undefined> = { EMPTY: "" }
  const store = new SecretsStore(env)

  const result = store.apply({ EMPTY: "from-file" })
  assert.equal(env.EMPTY, "")
  assert.deepEqual(result.kept, ["EMPTY"])
})

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

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

test("defaultSecretsPath resolution works end to end", () => {
  withTempDir((dir) => {
    const config = join(dir, "xdg")
    mkdirSync(join(config, "opencode"), { recursive: true })
    const file = join(config, "opencode", "secrets.env")
    writeFileSync(file, "API_KEY=xdg-secret\n", { mode: 0o600 })

    const resolved = defaultSecretsPath({ xdgConfigHome: config })
    assert.equal(resolved, file)
    const read = readSecrets(resolved)
    assert.equal(read.parsed.API_KEY, "xdg-secret")
  })
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
