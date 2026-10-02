import { readFileSync } from "node:fs"
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

/**
 * Substitute {env:NAME} tokens with current environment values, mirroring
 * OpenCode's behavior: missing variables become an empty string.
 */
export function substitute(template: string, env: Record<string, string | undefined> = process.env): string {
  return template.replace(ENV_REF, (_match, name: string) => env[name] ?? "")
}

/** True when the value contains at least one {env:...} reference. */
export function hasEnvRef(value: string): boolean {
  return value.includes("{env:")
}

/**
 * Minimal JSONC support: strip comments and trailing commas while respecting
 * string literals (including escape sequences). Good enough for OpenCode
 * config files without taking a dependency.
 */
export function stripJsonc(input: string): string {
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
  // Remove trailing commas: a comma followed only by whitespace before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1")
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
 */
function refsFromConfig(config: unknown, into: ServerReferences): void {
  if (config === null || typeof config !== "object") return
  const servers = (config as Record<string, unknown>).mcp
  if (servers === null || typeof servers !== "object") return
  const entries = (servers as Record<string, unknown>).servers
  if (entries === null || typeof entries !== "object") return
  for (const [name, definition] of Object.entries(entries as Record<string, unknown>)) {
    if (into.has(name)) continue // higher-precedence file already claimed it
    const refs: EnvReference[] = []
    collectRefs(definition, [], refs)
    if (refs.length > 0) into.set(name, refs)
  }
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
  files.push(join(globalDir, "opencode.jsonc"), join(globalDir, "opencode.json"))
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
