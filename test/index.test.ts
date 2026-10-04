import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"

const KEY = "OPENCODE_SECRETS_ENV_E2E_KEY"

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-secrets-env-"))
  try {
    await run(dir)
  } finally {
    delete process.env[KEY]
    rmSync(dir, { recursive: true, force: true })
  }
}

test("plugin entry exposes the V2 id and setup plus the V1 server()", () => {
  assert.equal(plugin.id, "opencode-secrets-env")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(typeof plugin.server, "function")
})

test("server() injects secrets from the configured file and dispose withdraws them", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, `${KEY}=from-file\n`, { mode: 0o600 })

    const hooks = await plugin.server({ directory: dir }, { path: file, watch: false, quiet: true })
    assert.equal(process.env[KEY], "from-file")

    await hooks.dispose()
    assert.equal(process.env[KEY], undefined)
  })
})

test("server() resolves a relative path option against the location directory", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "secrets.env"), `${KEY}=relative\n`, { mode: 0o600 })

    const hooks = await plugin.server({ directory: dir }, { path: "secrets.env", watch: false, quiet: true })
    assert.equal(process.env[KEY], "relative")
    await hooks.dispose()
  })
})

test("server() keeps real environment values by default and never withdraws them", async () => {
  process.env[KEY] = "from-shell"
  try {
    await withTempDir(async (dir) => {
      const file = join(dir, "secrets.env")
      writeFileSync(file, `${KEY}=from-file\n`, { mode: 0o600 })

      const hooks = await plugin.server({ directory: dir }, { path: file, watch: false, quiet: true })
      assert.equal(process.env[KEY], "from-shell")
      await hooks.dispose()
      assert.equal(process.env[KEY], "from-shell")
    })
  } finally {
    delete process.env[KEY]
  }
})

test("server() without a secrets file is a no-op", async () => {
  await withTempDir(async (dir) => {
    const hooks = await plugin.server({ directory: dir }, { path: join(dir, "missing.env"), watch: false, quiet: true })
    assert.equal(process.env[KEY], undefined)
    await hooks.dispose()
  })
})

test("server() hot-reloads edits and withdrawals when the file changes", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, `${KEY}=one\n`, { mode: 0o600 })
    const hooks = await plugin.server({ directory: dir }, { path: file, quiet: true })
    assert.equal(process.env[KEY], "one")

    writeFileSync(file, `${KEY}=two\n`, { mode: 0o600 })
    await waitFor(() => process.env[KEY] === "two")

    writeFileSync(file, "# key removed\n", { mode: 0o600 })
    await waitFor(() => process.env[KEY] === undefined)

    await hooks.dispose()
  })
})

test("server() picks up a secrets file created after startup", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "secrets.env")
    const hooks = await plugin.server({ directory: dir }, { path: file, quiet: true })
    assert.equal(process.env[KEY], undefined)

    writeFileSync(file, `${KEY}=late\n`, { mode: 0o600 })
    await waitFor(() => process.env[KEY] === "late")

    await hooks.dispose()
    assert.equal(process.env[KEY], undefined)
  })
})

test("server() picks up the secrets file when its directory is created after startup", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "nested", "deeper", "secrets.env")
    const hooks = await plugin.server({ directory: dir }, { path: file, quiet: true })
    assert.equal(process.env[KEY], undefined)

    mkdirSync(join(dir, "nested", "deeper"), { recursive: true })
    writeFileSync(file, `${KEY}=nested\n`, { mode: 0o600 })
    await waitFor(() => process.env[KEY] === "nested")

    await hooks.dispose()
    assert.equal(process.env[KEY], undefined)
  })
})

test("server() shares one store across instances of the same file until the last dispose", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, `${KEY}=shared\n`, { mode: 0o600 })

    const first = await plugin.server({ directory: dir }, { path: file, watch: false, quiet: true })
    const second = await plugin.server({ directory: dir }, { path: file, watch: false, quiet: true })
    assert.equal(process.env[KEY], "shared")

    // The first dispose must not withdraw keys the second instance still uses.
    await first.dispose()
    assert.equal(process.env[KEY], "shared")

    await second.dispose()
    assert.equal(process.env[KEY], undefined)
  })
})

test("server() dispose is idempotent", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "secrets.env")
    writeFileSync(file, `${KEY}=x\n`, { mode: 0o600 })

    const hooks = await plugin.server({ directory: dir }, { path: file, watch: false, quiet: true })
    assert.equal(process.env[KEY], "x")
    await hooks.dispose()
    await hooks.dispose()
    assert.equal(process.env[KEY], undefined)
  })
})

test("server() reports 'up to date' when a reload changes nothing", async () => {
  await withTempDir(async (dir) => {
    const previousXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(dir, "data")
    try {
      const log = join(dir, "data", "opencode", "log", "opencode-secrets-env.log")
      const file = join(dir, "secrets.env")
      writeFileSync(file, `${KEY}=one\n`, { mode: 0o600 })
      const hooks = await plugin.server({ directory: dir }, { path: file })
      await waitFor(() => readLog(log).includes("startup: 1 injected"))

      // Rewriting identical content must not be misreported as an empty file.
      writeFileSync(file, `${KEY}=one\n`, { mode: 0o600 })
      await waitFor(() => readLog(log).includes("reload: up to date (1 entry)"))
      assert.ok(!readLog(log).includes("no entries"))

      // Once the file really has no entries, the message says so again.
      writeFileSync(file, "# empty\n", { mode: 0o600 })
      await waitFor(() => readLog(log).includes("reload: 1 withdrawn"))
      writeFileSync(file, "# still empty\n", { mode: 0o600 })
      await waitFor(() => readLog(log).includes("reload: no entries in"))

      await hooks.dispose()
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousXdg
    }
  })
})

function readLog(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

test("server() warns about missing required variables even without a secrets file", async () => {
  await withTempDir(async (dir) => {
    const previousXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(dir, "data")
    try {
      const log = join(dir, "data", "opencode", "log", "opencode-secrets-env.log")
      const hooks = await plugin.server({ directory: dir }, { path: join(dir, "missing.env"), watch: false, required: [KEY] })
      // The required contract is "must exist after loading" — a missing file
      // does not excuse a missing variable.
      assert.ok(readLog(log).includes(`required environment variable(s) missing: ${KEY}`))
      await hooks.dispose()
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousXdg
    }
  })
})

test("server() rotates the plugin log when it grows past the cap", async () => {
  await withTempDir(async (dir) => {
    const previousXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(dir, "data")
    try {
      const logDir = join(dir, "data", "opencode", "log")
      mkdirSync(logDir, { recursive: true })
      const log = join(logDir, "opencode-secrets-env.log")
      writeFileSync(log, "x".repeat(300 * 1024))

      const hooks = await plugin.server({ directory: dir }, { path: join(dir, "missing.env"), watch: false })
      await hooks.dispose()

      assert.equal(statSync(`${log}.old`).size, 300 * 1024)
      assert.ok(statSync(log).size < 1024)
      assert.ok(existsSync(log))
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousXdg
    }
  })
})

// Platform-scaled ceiling: fast platforms return as soon as the 50 ms poll
// sees the condition, so the ceiling only matters on slow ones — and then it
// is almost always macOS: fs.watch there is FSEvents, whose delivery latency
// has no SLA and has exceeded 15 s on loaded shared CI runners (2026-10-04
// CI storm: 4 timeouts in ~30 min, all darwin). 60 s matches the ceiling the
// e2e harness already uses successfully (test/e2e/run.mjs poll()); Linux
// inotify / Windows ReadDirectoryChangesW have never come close to 15 s.
async function waitFor(
  condition: () => boolean,
  timeoutMs = process.platform === "darwin" ? 60_000 : 15_000,
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    const waitedMs = Date.now() - start
    if (waitedMs > timeoutMs)
      throw new Error(`timed out waiting for the hot reload (${process.platform}, gave up after ${waitedMs} ms)`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
