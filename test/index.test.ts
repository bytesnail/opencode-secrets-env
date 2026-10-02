import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the hot reload")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
