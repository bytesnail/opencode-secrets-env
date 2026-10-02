import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"

type ServerConfig = Record<string, unknown>

interface Editor {
  list(): [string, ServerConfig][]
  get(name: string): ServerConfig | undefined
  update(name: string, update: (config: ServerConfig) => void): void
}

type TransformCallback = (editor: Editor) => void

/**
 * Faithful fake of the host's MCP domain: registered transforms are replayed
 * in order against a fresh clone of the base config whenever a transform is
 * added or disposed — the same rebuild cycle the real host performs. The
 * plugin therefore sees the same list/get/update view OpenCode would give it.
 */
class FakeMcp {
  private readonly base: Record<string, ServerConfig>
  private transforms: TransformCallback[] = []
  /** Config as materialized by the latest rebuild. */
  materialized: Record<string, ServerConfig>
  /** Every server's `disabled` flag, snapshotted after each rebuild. */
  readonly history: Array<Record<string, boolean>> = []

  constructor(base: Record<string, ServerConfig>) {
    this.base = base
    this.materialized = {}
    this.rebuild()
  }

  get rebuilds(): number {
    return this.history.length
  }

  private rebuild(): void {
    const configs = structuredClone(this.base)
    const editor: Editor = {
      list: () => Object.entries(configs),
      get: (name) => configs[name],
      update: (name, update) => {
        const config = configs[name]
        if (config) update(config)
      },
    }
    for (const transform of this.transforms) transform(editor)
    this.materialized = configs
    this.history.push(Object.fromEntries(Object.entries(configs).map(([name, config]) => [name, config.disabled === true])))
  }

  async transform(callback: TransformCallback): Promise<{ dispose(): Promise<void> }> {
    this.transforms.push(callback)
    this.rebuild()
    return {
      dispose: async () => {
        this.transforms = this.transforms.filter((registered) => registered !== callback)
        this.rebuild()
      },
    }
  }
}

const KEY_ONE = "OPENCODE_SECRETS_ENV_FAKE_ONE"
const KEY_TWO = "OPENCODE_SECRETS_ENV_FAKE_TWO"

const RAW_CONFIG = `{
  "mcp": { "servers": {
    "one": { "type": "local", "command": ["run"], "environment": { "K": "{env:${KEY_ONE}}" } },
    "two": { "type": "local", "command": ["run"], "environment": { "K": "{env:${KEY_TWO}}" } },
    "off": { "type": "local", "command": ["run"], "disabled": true, "environment": { "K": "{env:${KEY_ONE}}" } },
    "plain": { "type": "local", "command": ["run"] }
  } }
}`

/** What the host materialized before the plugin stepped in: refs substituted
 * against an environment that did not have the values yet (empty strings). */
const BASE_SERVERS: Record<string, ServerConfig> = {
  one: { type: "local", command: ["run"], environment: { K: "" } },
  two: { type: "local", command: ["run"], environment: { K: "" } },
  off: { type: "local", command: ["run"], disabled: true, environment: { K: "" } },
  plain: { type: "local", command: ["run"] },
}

async function withFixture(run: (fixture: { dir: string; secrets: string; mcp: FakeMcp }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-secrets-env-mcp-"))
  try {
    writeFileSync(join(dir, "opencode.jsonc"), RAW_CONFIG)
    const secrets = join(dir, "secrets.env")
    writeFileSync(secrets, `${KEY_ONE}=a\n${KEY_TWO}=b\n`, { mode: 0o600 })
    await run({ dir, secrets, mcp: new FakeMcp(BASE_SERVERS) })
  } finally {
    delete process.env[KEY_ONE]
    delete process.env[KEY_TWO]
    rmSync(dir, { recursive: true, force: true })
  }
}

async function setup(options: Record<string, unknown>, directory: string, mcp: FakeMcp): Promise<() => void> {
  const cleanup = await (plugin.setup as (context: unknown) => Promise<(() => void) | void>)({
    options,
    location: { directory },
    mcp,
  })
  assert.equal(typeof cleanup, "function")
  return cleanup as () => void
}

function envValue(mcp: FakeMcp, server: string): unknown {
  const config = mcp.materialized[server] as { environment?: Record<string, unknown> } | undefined
  return config?.environment?.K
}

async function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the MCP reconnect cycle")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test("setup() re-substitutes {env:...} references and reconnects only the affected servers on reload", async () => {
  await withFixture(async ({ dir, secrets, mcp }) => {
    const cleanup = await setup({ path: secrets, quiet: true }, dir, mcp)

    // Injection plus the permanent env-ref transform repaired the empty
    // substitutions the host had materialized.
    assert.equal(process.env[KEY_ONE], "a")
    assert.equal(envValue(mcp, "one"), "a")
    assert.equal(envValue(mcp, "two"), "b")

    writeFileSync(secrets, `${KEY_ONE}=changed\n${KEY_TWO}=b\n`, { mode: 0o600 })
    await waitFor(() => envValue(mcp, "one") === "changed" && mcp.materialized["one"]?.disabled !== true)

    // Only "one" was cycled: it is the sole enabled server referencing the
    // changed key. Unrelated servers were never disabled, and the server the
    // user disabled stayed disabled throughout.
    assert.ok(mcp.history.some((flags) => flags["one"] === true))
    assert.ok(mcp.history.every((flags) => flags["two"] === false))
    assert.ok(mcp.history.every((flags) => flags["plain"] === false))
    assert.ok(mcp.history.every((flags) => flags["off"] === true))
    assert.equal(envValue(mcp, "two"), "b")

    cleanup()
    // The cleanup disposes the transform asynchronously; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 50))
    // With the plugin's transform gone, the host's own (empty) substitution
    // is what remains.
    assert.equal(envValue(mcp, "one"), "")
    assert.equal(mcp.history.at(-1)?.["one"], false)
  })
})

test("setup() with mcpReconnect: false applies reloads without cycling any server", async () => {
  await withFixture(async ({ dir, secrets, mcp }) => {
    const cleanup = await setup({ path: secrets, quiet: true, mcpReconnect: false }, dir, mcp)
    const rebuildsAfterSetup = mcp.rebuilds

    writeFileSync(secrets, `${KEY_ONE}=changed\n${KEY_TWO}=b\n`, { mode: 0o600 })
    await waitFor(() => process.env[KEY_ONE] === "changed")

    // No disable/dispose cycle: the materialized config keeps the old value
    // until the host rebuilds it for its own reasons.
    assert.equal(mcp.rebuilds, rebuildsAfterSetup)
    assert.equal(envValue(mcp, "one"), "a")

    cleanup()
  })
})
