import { appendFileSync, mkdirSync, watch, type FSWatcher } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { SecretsStore, defaultSecretsPath, expandPath, missingRequired, readSecrets } from "./env.ts"
import { scanServerEnvRefs, setAtPath, substitute, type ServerReferences } from "./rawconfig.ts"

const ID = "opencode-secrets-env"
const PREFIX = `[${ID}]`

interface NormalizedOptions {
  path?: string
  override: boolean
  watch: boolean
  /** true = all enabled servers, string[] = only these servers, false = none. */
  mcpReconnect: boolean | string[]
  quiet: boolean
  debug: boolean
  required: string[]
}

/**
 * Read the raw `options` object from the plugin configuration entry and
 * normalize it into a strict shape. Unknown or wrongly typed values fall
 * back to defaults so a typo never breaks startup.
 */
function normalizeOptions(raw: Record<string, unknown> | undefined): NormalizedOptions {
  const options = raw ?? {}
  return {
    path: typeof options.path === "string" && options.path.length > 0 ? options.path : undefined,
    override: options.override === true,
    watch: options.watch !== false,
    mcpReconnect: Array.isArray(options.mcpReconnect)
      ? options.mcpReconnect.filter((name): name is string => typeof name === "string" && name.length > 0)
      : options.mcpReconnect !== false,
    quiet: options.quiet === true,
    debug: options.debug === true,
    required: Array.isArray(options.required)
      ? options.required.filter((key): key is string => typeof key === "string" && key.length > 0)
      : [],
  }
}

/**
 * The OpenCode background service runs with stdout/stderr detached, so
 * console output from plugins is lost. Keep a small dedicated log file next
 * to OpenCode's own logs so users can verify what happened at startup.
 */
function logFilePath(): string {
  const data = process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "opencode")
    : join(homedir(), ".local", "share", "opencode")
  return join(data, "log", `${ID}.log`)
}

function appendLog(line: string): void {
  try {
    const file = logFilePath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8")
  } catch {
    // Logging must never break the plugin.
  }
}

type Emit = (level: "info" | "debug" | "warn", message: string) => void

function makeEmit(options: { quiet: boolean; debug: boolean }): Emit {
  return (level, message) => {
    if (level === "debug" && !options.debug) return
    if (level !== "warn" && options.quiet) return
    const line = `${PREFIX}${level === "warn" ? " warning:" : ""} ${message}`
    appendLog(line)
    if (level === "warn") console.warn(line)
    else console.log(line)
  }
}

// ---------------------------------------------------------------------------
// Service-wide shared state
//
// Every location loads the same module, so these maps are shared by all
// plugin instances in the service process — which is exactly what the single
// shared `process.env` needs.
// ---------------------------------------------------------------------------

interface McpRegistration {
  dispose(): Promise<void>
}

interface McpLike {
  transform(callback: (editor: McpEditorLike) => void): Promise<McpRegistration>
}

interface McpEditorLike {
  list(): readonly (readonly [string, Record<string, unknown>])[]
  get(name: string): Record<string, unknown> | undefined
  update(name: string, update: (config: Record<string, unknown>) => void): void
}

interface Instance {
  directory: string
  file: string
  options: NormalizedOptions
  mcp: McpLike
  emit: Emit
}

interface FileState {
  store: SecretsStore
  instances: Set<Instance>
  watcher?: FSWatcher
  timer?: ReturnType<typeof setTimeout>
  busy: boolean
  queued: boolean
}

const files = new Map<string, FileState>()

function stateFor(file: string): FileState {
  let state = files.get(file)
  if (!state) {
    state = { store: new SecretsStore(), instances: new Set(), busy: false, queued: false }
    files.set(file, state)
  }
  return state
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Loading & reporting
// ---------------------------------------------------------------------------

function report(emit: Emit, file: string, result: ReturnType<SecretsStore["apply"]>, context: string): void {
  const { added, updated, removed, kept } = result
  const changed = added.length + updated.length + removed.length
  if (changed === 0 && kept.length === 0) {
    emit("info", `${context}: no entries in ${file}`)
    return
  }
  if (changed === 0) {
    emit("info", `${context}: nothing to change (${kept.length} entr(y/ies) provided by the real environment)`)
    return
  }
  const parts: string[] = []
  if (added.length > 0) parts.push(`${added.length} injected`)
  if (updated.length > 0) parts.push(`${updated.length} updated`)
  if (removed.length > 0) parts.push(`${removed.length} withdrawn`)
  emit("info", `${context}: ${parts.join(", ")} (${file})`)
  if (added.length > 0) emit("debug", `injected keys: ${added.join(", ")}`)
  if (updated.length > 0) emit("debug", `updated keys: ${updated.join(", ")}`)
  if (removed.length > 0) emit("debug", `withdrawn keys: ${removed.join(", ")}`)
  if (kept.length > 0) emit("debug", `kept from real environment: ${kept.join(", ")}`)
}

function checkRequired(instance: Instance): void {
  const missing = missingRequired(instance.options.required)
  if (missing.length > 0) {
    instance.emit("warn", `required environment variable(s) missing: ${missing.join(", ")}`)
  }
}

function loadOnce(instance: Instance, context: string): ReturnType<SecretsStore["apply"]> {
  const { file, options, emit } = instance
  const state = stateFor(file)
  const read = readSecrets(file)

  if (read.error) {
    emit("warn", `failed to read secrets file: ${read.error.message}`)
    return { added: [], updated: [], removed: [], kept: [] }
  }
  if (!read.found) {
    const result = state.store.apply({}, options)
    if (result.added.length + result.updated.length + result.removed.length === 0) {
      emit("info", `${context}: no secrets file at ${file}, skipping`)
    } else {
      report(emit, file, result, context)
    }
    return result
  }
  if (read.insecurePermissions) {
    emit("warn", `${file} is readable by other users — consider running: chmod 600 ${file}`)
  }

  const result = state.store.apply(read.parsed, options)
  report(emit, file, result, context)
  checkRequired(instance)
  return result
}

// ---------------------------------------------------------------------------
// MCP reconnection
//
// OpenCode resolves {env:NAME} references against the live environment each
// time it (re)connects a server, but connected servers keep the environment
// they were started with. So after a hot reload, reconnect the affected
// servers: disable them through a transform (OpenCode disconnects), then
// dispose the transform (the original config is restored and OpenCode
// reconnects with the new values). Servers the user disabled are untouched.
// ---------------------------------------------------------------------------

async function reconnectMcp(instance: Instance): Promise<void> {
  const option = instance.options.mcpReconnect
  if (option === false) return
  const allowlist = Array.isArray(option) ? new Set(option) : undefined

  const targets: string[] = []
  let registration: McpRegistration
  try {
    registration = await instance.mcp.transform((editor) => {
      for (const [name, config] of editor.list()) {
        if (config.disabled === true) continue
        if (allowlist && !allowlist.has(name)) continue
        editor.update(name, (server) => {
          server.disabled = true
        })
        targets.push(name)
      }
    })
  } catch (cause) {
    instance.emit("warn", `failed to inspect MCP servers for reconnection: ${(cause as Error).message}`)
    return
  }

  if (targets.length === 0) {
    await registration.dispose()
    return
  }

  instance.emit("info", `reconnecting MCP server(s) to apply new values: ${targets.join(", ")}`)
  await sleep(1000)
  try {
    await registration.dispose()
  } catch (cause) {
    instance.emit("warn", `failed to re-enable MCP server(s): ${(cause as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Hot reload
// ---------------------------------------------------------------------------

async function reload(file: string): Promise<void> {
  const state = stateFor(file)
  if (state.busy) {
    state.queued = true
    return
  }
  state.busy = true
  try {
    do {
      state.queued = false
      const first = [...state.instances][0]
      if (!first) return
      const result = loadOnce(first, "reload")
      const changed = result.added.length + result.updated.length + result.removed.length
      if (changed === 0) continue
      for (const instance of state.instances) {
        try {
          await reconnectMcp(instance)
        } catch (cause) {
          instance.emit("warn", `MCP reconnection failed: ${(cause as Error).message}`)
        }
      }
    } while (state.queued)
  } finally {
    state.busy = false
  }
}

function ensureWatcher(instance: Instance): void {
  if (!instance.options.watch) return
  const state = stateFor(instance.file)
  if (state.watcher) return

  const directory = dirname(instance.file)
  const target = basename(instance.file)
  try {
    // Watch the parent directory rather than the file itself: editors that
    // save atomically (write temp + rename) replace the inode, which would
    // silently end a file-level watch.
    state.watcher = watch(directory, { persistent: false }, (_event, filename) => {
      if (filename !== target) return
      const current = stateFor(instance.file)
      if (current.timer) clearTimeout(current.timer)
      current.timer = setTimeout(() => {
        current.timer = undefined
        void reload(instance.file)
      }, 300)
    })
    state.watcher.on("error", () => {
      instance.emit("warn", `file watcher for ${instance.file} stopped; restart the service to apply future edits`)
      state.watcher = undefined
    })
    instance.emit("debug", `watching ${instance.file} for changes`)
  } catch {
    instance.emit("debug", `cannot watch ${directory}; edits to ${instance.file} need a service restart`)
  }
}

function dropWatcherAndStore(file: string): void {
  const state = files.get(file)
  if (!state || state.instances.size > 0) return
  if (state.timer) clearTimeout(state.timer)
  state.watcher?.close()
  const released = state.store.release()
  if (released.length > 0) {
    appendLog(`${PREFIX} unloaded: withdrew ${released.length} injected key(s) from ${file}`)
  }
  files.delete(file)
}

// ---------------------------------------------------------------------------
// Plugin entry points
// ---------------------------------------------------------------------------

/**
 * OpenCode substitutes {env:...} in MCP configs when it materializes them and
 * caches the result, so a server can keep running with stale (or, on first
 * connect, empty) values. The raw references only exist in the config files.
 * Register a permanent transform that re-substitutes every referenced field
 * from the live environment whenever the MCP config is (re)built — every
 * (re)connect then sees current values.
 */
async function registerEnvRefTransform(instance: Instance): Promise<McpRegistration | undefined> {
  const refs: ServerReferences = scanServerEnvRefs(instance.directory)
  if (refs.size === 0) return undefined
  try {
    const registration = await instance.mcp.transform((editor) => {
      for (const [name, serverRefs] of refs) {
        editor.update(name, (server) => {
          for (const ref of serverRefs) {
            setAtPath(server, ref.path, substitute(ref.template))
          }
        })
      }
    })
    instance.emit("debug", `re-substituting {env:...} references for MCP server(s): ${[...refs.keys()].join(", ")}`)
    return registration
  } catch (cause) {
    instance.emit("warn", `failed to register MCP env substitution: ${(cause as Error).message}`)
    return undefined
  }
}

function activate(options: NormalizedOptions, base: string, mcp: McpLike, directory: string): (() => void) | undefined {
  const emit = makeEmit(options)
  const file = options.path ? expandPath(options.path, base) : defaultSecretsPath()
  const instance: Instance = { directory, file, options, mcp, emit }

  stateFor(file).instances.add(instance)
  loadOnce(instance, "startup")
  ensureWatcher(instance)

  const envRefTransform = registerEnvRefTransform(instance)

  return () => {
    void envRefTransform.then((registration) => registration?.dispose()).catch(() => {})
    const state = files.get(file)
    state?.instances.delete(instance)
    dropWatcherAndStore(file)
  }
}

export default {
  ...Plugin.define({
    id: ID,
    setup(ctx) {
      return activate(normalizeOptions(ctx.options), ctx.location.directory, ctx.mcp, ctx.location.directory)
    },
  }),

  // OpenCode V1 (>= 1.18.29) entry point. V1 has no plugin options and no MCP
  // transform API, so it gets the default behavior without MCP reconnection.
  async server() {
    activate(normalizeOptions(undefined), process.cwd(), noopMcp, process.cwd())
    return {}
  },
}

const noopMcp: McpLike = {
  transform: async () => ({ dispose: async () => {} }),
}
