import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

/**
 * One {env:NAME} reference found in a raw config source: where it lives inside
 * the server definition, and the template containing the reference.
 */
export interface EnvReference {
  /** Path of object keys / array indices from the server definition root. */
  path: readonly (string | number)[]
  /** The raw string, e.g. "Bearer {env:API_KEY}". */
  template: string
  /**
   * Directory {file:...} tokens in the template resolve against: the config
   * file's directory, or the location directory for inline content — matching
   * the host's substitution context.
   */
  dir: string
}

/** Server name -> references found in its raw definition. */
export type ServerReferences = Map<string, EnvReference[]>

// The same patterns the host substitutes with (packages/core/src/config/
// variable.ts at v2.0.22): the name may contain anything except "}".
const ENV_REF = /\{env:([^}]+)\}/g
/** Non-global twin of ENV_REF for one-shot tests (a global regex would keep lastIndex state). */
const ENV_REF_ONCE = /\{env:[^}]+\}/
const FILE_REF = /\{file:([^}]+)\}/g

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
 * Resolve a raw template the way the host does when loading a config file:
 * {env:NAME} first (missing variables become ""), then {file:path} against the
 * config file's directory. A template containing {file:...} must never be
 * re-substituted for the {env:...} part alone — that would overwrite the
 * host-materialized file content with the literal token.
 */
export function resolveTemplate(ref: EnvReference, env: Record<string, string | undefined> = process.env): string {
  return substituteFileRefs(substitute(ref.template, env), ref.dir)
}

/**
 * Substitute {file:path} tokens, mirroring the host: "~/" expands, relative
 * paths resolve against the config file's directory, and the file content is
 * trimmed and JSON-escaped. An unreadable target is left as a literal token —
 * the host fails the whole config load in that case, so the field never
 * materializes anyway.
 */
function substituteFileRefs(text: string, dir: string): string {
  if (!text.includes("{file:")) return text
  return text.replace(FILE_REF, (token, filePath: string) => {
    const expanded = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath
    const resolved = isAbsolute(expanded) ? expanded : resolve(dir, expanded)
    try {
      return JSON.stringify(readFileSync(resolved, "utf8").trim()).slice(1, -1)
    } catch {
      return token
    }
  })
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
function collectRefs(value: unknown, path: readonly (string | number)[], dir: string, out: EnvReference[]): void {
  if (typeof value === "string") {
    if (hasEnvRef(value)) out.push({ path, template: value, dir })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRefs(item, [...path, index], dir, out))
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectRefs(item, [...path, key], dir, out)
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
 * flat one with the same name — matching V2's normalizeMcp (native servers
 * override migrated legacy ones), and V2 is the only consumer of this scan
 * (V1 has no MCP transform API). The `servers` key itself is reserved as
 * the V2 container and is never a server name.
 *
 * The host merges documents by LAST-DEFINITION-WINS per server name (the
 * whole server, not a deep merge), so the first source in scan order that
 * defines a name at all claims it — even when that definition has no
 * references. Claiming only definitions *with* references would let a
 * lower-precedence source's references leak into a server the host
 * materialized from a different definition.
 *
 * Mirroring the host's normalizeMcp, two flat entries never define (and so
 * never claim) a server: enabled-only legacy toggles (`{"enabled": bool}`,
 * dropped with a diagnostic) and `mcp.timeout` (timeout configuration).
 */
function refsFromConfig(config: unknown, dir: string, into: ServerReferences, claimed: Set<string>): void {
  if (config === null || typeof config !== "object") return
  const mcp = (config as Record<string, unknown>).mcp
  if (mcp === null || typeof mcp !== "object") return
  const container = mcp as Record<string, unknown>

  // Nested (V2 canonical) entries first: on V2 a nested entry overrides a
  // flat legacy one with the same name, so it must claim the name here too.
  const nested = container.servers
  if (isRecord(nested)) {
    for (const [name, definition] of Object.entries(nested)) {
      // Entries that fail the host's schema decode are dropped without
      // defining the server — cheaply discriminable cases mirrored here.
      if (!isRecord(definition) || isEnabledOnlyToggle(definition)) continue
      collectServerRefs(name, definition, dir, into, claimed)
    }
  }
  for (const [name, definition] of Object.entries(container)) {
    if (name === "servers") continue
    if (isEnabledOnlyToggle(definition)) continue
    if (name === "timeout" && !isDirectServer(definition)) continue
    if (!isRecord(definition)) continue
    collectServerRefs(name, definition, dir, into, claimed)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Mirrors the host's isDirectLegacyMcp: a flat entry that is a server in its own right. */
function isDirectServer(value: unknown): boolean {
  return isRecord(value) && (value.type === "local" || value.type === "remote")
}

/** Mirrors the host's isEnabledOnlyMcp: `{"enabled": bool}` and no `type`. */
function isEnabledOnlyToggle(value: unknown): boolean {
  return isRecord(value) && !Object.hasOwn(value, "type") && typeof value.enabled === "boolean"
}

function collectServerRefs(name: string, definition: unknown, dir: string, into: ServerReferences, claimed: Set<string>): void {
  if (claimed.has(name)) return // a higher-precedence source already defined this server
  claimed.add(name)
  const refs: EnvReference[] = []
  collectRefs(definition, [], dir, refs)
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
 * The config-source environment the scanner mirrors from the host (verified
 * against the V2 service bootstrap, which reads these variables into its
 * config options). Every field defaults to the live environment; tests
 * inject explicit values.
 */
export interface ScanEnvironment {
  /** Defaults to XDG_CONFIG_HOME. */
  xdgConfigHome?: string
  /** Defaults to os.homedir(). */
  home?: string
  /** Defaults to OPENCODE_CONFIG_DIR: replaces the whole global config directory. */
  configDir?: string
  /** Defaults to OPENCODE_CONFIG: an explicit extra config file. */
  configFile?: string
  /** Defaults to OPENCODE_CONFIG_CONTENT: inline JSONC, the highest-precedence source. */
  configContent?: string
  /** Defaults to !truthy(OPENCODE_CONFIG_PROJECT_DISABLE ?? OPENCODE_DISABLE_PROJECT_CONFIG). */
  projectConfig?: boolean
}

/** The host's truthy(): "1" or case-insensitive "true". */
function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true"
}

function resolveScanEnvironment(input: ScanEnvironment) {
  // Empty strings are normalized to undefined: they carry no path/content,
  // and letting them through would resolve against the current directory.
  const configDir = input.configDir ?? process.env.OPENCODE_CONFIG_DIR
  const configFile = input.configFile ?? process.env.OPENCODE_CONFIG
  const configContent = input.configContent ?? process.env.OPENCODE_CONFIG_CONTENT
  return {
    xdgConfigHome: input.xdgConfigHome ?? process.env.XDG_CONFIG_HOME,
    home: input.home ?? homedir(),
    configDir: configDir || undefined,
    configFile: configFile || undefined,
    configContent: configContent || undefined,
    projectConfig:
      input.projectConfig ??
      !truthy(process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG),
  }
}

/**
 * Candidate config files for a location, highest precedence first, matching
 * the host's document order (later documents win): `.opencode/` variants from
 * nearest to farthest ancestor beat ALL direct config files (nearest to
 * farthest), which beat the explicit OPENCODE_CONFIG file, which beats the
 * global directory (jsonc over json). Within one directory the jsonc variant
 * ranks above json. OPENCODE_CONFIG_CONTENT ranks above every file but is
 * handled by {@link scanServerEnvRefs} itself, since it is not a file.
 */
export function configCandidates(locationDirectory: string, input: ScanEnvironment = {}): string[] {
  const env = resolveScanEnvironment(input)
  const files: string[] = []
  if (env.projectConfig) {
    const ancestors: string[] = []
    let current = resolve(locationDirectory)
    for (;;) {
      ancestors.push(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    for (const directory of ancestors) {
      files.push(join(directory, ".opencode", "opencode.jsonc"), join(directory, ".opencode", "opencode.json"))
    }
    for (const directory of ancestors) {
      files.push(join(directory, "opencode.jsonc"), join(directory, "opencode.json"))
    }
  }
  if (env.configFile) files.push(resolve(env.configFile))
  const globalDir = env.configDir ?? (env.xdgConfigHome ? join(env.xdgConfigHome, "opencode") : join(env.home, ".config", "opencode"))
  files.push(join(globalDir, "opencode.jsonc"), join(globalDir, "opencode.json"))
  return files
}

/**
 * Scan every applicable raw config source for MCP server definitions that use
 * {env:...} references. OpenCode substitutes these references when it loads
 * the config, so the plugin API never shows them — the raw sources are the
 * only place the references still exist. Sources are scanned highest
 * precedence first and the first source defining a server name claims it,
 * mirroring the host's last-definition-wins document merge.
 */
export function scanServerEnvRefs(locationDirectory: string, input: ScanEnvironment = {}): ServerReferences {
  const env = resolveScanEnvironment(input)
  const refs: ServerReferences = new Map()
  const claimed = new Set<string>()
  if (env.configContent !== undefined) {
    // Inline content ranks above every file. Its {file:...} tokens resolve
    // against the location directory, as in the host. Malformed content is
    // rejected by the host the same way it rejects a malformed file.
    try {
      refsFromConfig(parseJsonc(env.configContent), resolve(locationDirectory), refs, claimed)
    } catch {
      // Rejected inline content contributes nothing.
    }
  }
  for (const file of configCandidates(locationDirectory, input)) {
    const config = readConfigFile(file)
    if (config !== undefined) refsFromConfig(config, dirname(file), refs, claimed)
  }
  return refs
}

/**
 * Memoizing wrapper around {@link scanServerEnvRefs}: re-reads the config
 * sources only when one of them changed (by path/size/mtime, plus the inline
 * content itself), so it is cheap enough to call inside transform callbacks
 * and reload handlers.
 */
export function makeRefScanner(locationDirectory: string, input: ScanEnvironment = {}): () => ServerReferences {
  let cached: ServerReferences | undefined
  let signature = ""
  return () => {
    const env = resolveScanEnvironment(input)
    let current = `content:${env.configContent ?? ""};`
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
