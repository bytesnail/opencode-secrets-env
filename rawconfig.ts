import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * One {env:NAME} reference found in a raw config file: where it lives inside
 * the server definition, and the template containing the reference.
 */
export interface EnvReference {
  /** Path of object keys / array indices from the server definition root. */
  path: readonly (string | number)[]
  /** The raw string, e.g. "Bearer {env:API_KEY}". */
  template: string
}

/** Server name -> references found in its raw definition. */
export type ServerReferences = Map<string, EnvReference[]>

const ENV_REF = /\{env:([^{}]+)\}/g
/** Non-global twin of ENV_REF for one-shot tests (a global regex would keep lastIndex state). */
const ENV_REF_ONCE = /\{env:[^{}]+\}/

/**
 * Substitute {env:NAME} tokens with current environment values, mirroring
 * OpenCode's behavior: missing variables become an empty string.
 */
export function substitute(template: string, env: Record<string, string | undefined> = process.env): string {
  return template.replace(ENV_REF, (_match, name: string) => env[name] ?? "")
}

/**
 * True when the value contains at least one {env:NAME} reference. Uses the
 * same pattern as substitution, so an empty name ("{env:}") does not count.
 */
export function hasEnvRef(value: string): boolean {
  return ENV_REF_ONCE.test(value)
}

/** Variable names referenced by {env:NAME} tokens in a template. */
export function templateNames(template: string): string[] {
  const names: string[] = []
  for (const match of template.matchAll(ENV_REF)) {
    if (match[1]) names.push(match[1])
  }
  return names
}

/**
 * Minimal JSONC support: strip comments and trailing commas while respecting
 * string literals (including escape sequences). Good enough for OpenCode
 * config files without taking a dependency.
 *
 * Two string-aware passes are used so that comment markers (`//`, `/*`) and
 * comma/bracket sequences *inside* string values are never touched — a naive
 * regex pass would silently corrupt values such as "https://x/a,}".
 */
export function stripJsonc(input: string): string {
  return stripTrailingCommas(stripComments(input))
}

/** Remove line and block comments, honoring string literals. */
function stripComments(input: string): string {
  let out = ""
  let i = 0
  let inString = false
  while (i < input.length) {
    const ch = input[i]!
    const next = input[i + 1]
    if (inString) {
      out += ch
      if (ch === "\\" && next !== undefined) {
        out += next
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * Remove trailing commas (a comma followed only by whitespace before `}` or
 * `]`), honoring string literals. Runs after comment removal, so a comment
 * sitting between the comma and the bracket is already gone.
 */
function stripTrailingCommas(input: string): string {
  let out = ""
  let i = 0
  let inString = false
  while (i < input.length) {
    const ch = input[i]!
    if (inString) {
      out += ch
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1]
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < input.length && /\s/.test(input[j]!)) j++
      const closing = input[j]
      if (closing === "}" || closing === "]") {
        i++ // drop the comma; the bracket is emitted on a later iteration
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

export function parseJsonc(content: string): unknown {
  return JSON.parse(stripJsonc(content))
}

/**
 * Walk a server definition and collect every string that contains an
 * {env:...} reference, recording the path to it.
 */
function collectRefs(value: unknown, path: readonly (string | number)[], out: EnvReference[]): void {
  if (typeof value === "string") {
    if (hasEnvRef(value)) out.push({ path, template: value })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRefs(item, [...path, index], out))
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectRefs(item, [...path, key], out)
    }
  }
}

/**
 * Set `value` at `path` inside `target`, mirroring the location where a
 * reference was found in the raw config.
 */
export function setAtPath(target: unknown, path: readonly (string | number)[], value: string): void {
  if (path.length === 0 || target === null || typeof target !== "object") return
  let current = target as Record<string | number, unknown>
  for (const segment of path.slice(0, -1)) {
    const next = current[segment]
    if (next === null || typeof next !== "object") return
    current = next as Record<string | number, unknown>
  }
  const last = path[path.length - 1]!
  if (typeof current[last] === "string") current[last] = value
}

/**
 * Extract MCP server references from one parsed config document.
 *
 * Two shapes exist in the wild: OpenCode V1's schema defines servers
 * directly at `mcp.<name>` (and accepts the nested `mcp.servers.<name>`
 * envelope for V2-style configs), while V2's canonical schema nests them
 * under `mcp.servers.<name>` (and still migrates flat legacy entries), so
 * both shapes must be scanned. Within one file a nested entry wins over a
 * flat one with the same name — matching the V2 hosts, the only place
 * these references are consumed (V1 has no MCP transform API). The
 * `servers` key itself is reserved as the V2 container and is never a
 * server name.
 */
function refsFromConfig(config: unknown, into: ServerReferences): void {
  if (config === null || typeof config !== "object") return
  const mcp = (config as Record<string, unknown>).mcp
  if (mcp === null || typeof mcp !== "object") return
  const container = mcp as Record<string, unknown>

  // Nested (V2 canonical) entries first: on V2 a nested entry overrides a
  // flat legacy one with the same name, so it must claim the name here too.
  const nested = container.servers
  if (nested !== null && typeof nested === "object") {
    for (const [name, definition] of Object.entries(nested as Record<string, unknown>)) {
      collectServerRefs(name, definition, into)
    }
  }
  for (const [name, definition] of Object.entries(container)) {
    if (name === "servers") continue
    collectServerRefs(name, definition, into)
  }
}

function collectServerRefs(name: string, definition: unknown, into: ServerReferences): void {
  if (into.has(name)) return // higher-precedence file or nested entry already claimed it
  const refs: EnvReference[] = []
  collectRefs(definition, [], refs)
  if (refs.length > 0) into.set(name, refs)
}

function readConfigFile(file: string): unknown | undefined {
  let content: string
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    return parseJsonc(content)
  } catch {
    return undefined
  }
}

/**
 * Candidate config files for a location, highest precedence first, matching
 * OpenCode's discovery: `.opencode/` variants from nearest to farthest
 * ancestor, then direct config files from nearest to farthest, then the
 * global config.
 */
export function configCandidates(locationDirectory: string, input: { xdgConfigHome?: string; home?: string } = {}): string[] {
  const ancestors: string[] = []
  let current = resolve(locationDirectory)
  for (;;) {
    ancestors.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  const files: string[] = []
  for (const directory of ancestors) {
    files.push(join(directory, ".opencode", "opencode.jsonc"), join(directory, ".opencode", "opencode.json"))
  }
  for (const directory of ancestors) {
    files.push(join(directory, "opencode.jsonc"), join(directory, "opencode.json"))
  }
  const xdg = input.xdgConfigHome ?? process.env.XDG_CONFIG_HOME
  const home = input.home ?? homedir()
  const globalDir = xdg ? join(xdg, "opencode") : join(home, ".config", "opencode")
  // OpenCode merges the global files in this order (later wins), so the
  // precedence here is jsonc > json > config.json.
  files.push(join(globalDir, "opencode.jsonc"), join(globalDir, "opencode.json"), join(globalDir, "config.json"))
  return files
}

/**
 * Scan every applicable raw config file for MCP server definitions that use
 * {env:...} references. OpenCode substitutes these references when it loads
 * the config, so the plugin API never shows them — the raw files are the
 * only place the references still exist.
 */
export function scanServerEnvRefs(locationDirectory: string, input: { xdgConfigHome?: string; home?: string } = {}): ServerReferences {
  const refs: ServerReferences = new Map()
  for (const file of configCandidates(locationDirectory, input)) {
    const config = readConfigFile(file)
    if (config !== undefined) refsFromConfig(config, refs)
  }
  return refs
}

/**
 * Memoizing wrapper around {@link scanServerEnvRefs}: re-reads the config
 * files only when one of them changed (by path/size/mtime), so it is cheap
 * enough to call inside transform callbacks and reload handlers.
 */
export function makeRefScanner(locationDirectory: string, input: { xdgConfigHome?: string; home?: string } = {}): () => ServerReferences {
  let cached: ServerReferences | undefined
  let signature = ""
  return () => {
    let current = ""
    for (const file of configCandidates(locationDirectory, input)) {
      try {
        const stat = statSync(file)
        current += `${file}:${stat.size}:${stat.mtimeMs};`
      } catch {
        // Missing candidate: contributes nothing to the signature.
      }
    }
    if (cached === undefined || current !== signature) {
      cached = scanServerEnvRefs(locationDirectory, input)
      signature = current
    }
    return cached
  }
}

// ---------------------------------------------------------------------------
// Reconnect targeting
// ---------------------------------------------------------------------------

export type McpReconnectOption = boolean | "all" | readonly string[]

export interface McpServerState {
  name: string
  disabled: boolean
}

/**
 * Decide which MCP servers must be reconnected after a hot reload.
 *
 * - `false`           -> none
 * - `"all"`           -> every enabled server (covers servers that read the
 *   inherited environment without explicit {env:...} references)
 * - `["a", "b"]`      -> exactly those servers, when enabled
 * - `true` (default)  -> precise: only enabled servers whose raw config
 *   references at least one of the changed variables
 */
export function selectReconnectTargets(
  servers: readonly McpServerState[],
  refs: ServerReferences,
  changedKeys: ReadonlySet<string>,
  option: McpReconnectOption,
): string[] {
  if (option === false) return []
  const enabled = servers.filter((server) => !server.disabled)
  if (option === "all") return enabled.map((server) => server.name)
  if (Array.isArray(option)) {
    const allowlist = new Set(option)
    return enabled.filter((server) => allowlist.has(server.name)).map((server) => server.name)
  }
  const targets: string[] = []
  for (const server of enabled) {
    const serverRefs = refs.get(server.name)
    if (!serverRefs) continue
    const referenced = serverRefs.some((ref) => templateNames(ref.template).some((name) => changedKeys.has(name)))
    if (referenced) targets.push(server.name)
  }
  return targets
}
