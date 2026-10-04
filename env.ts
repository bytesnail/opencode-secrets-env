import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { parse } from "dotenv"

/**
 * Result of reading a secrets file from disk.
 */
export interface ReadResult {
  /** True when the file exists and was read. */
  found: boolean
  /** Parsed key/value pairs (empty when the file is missing). */
  parsed: Record<string, string>
  /** True when the file is readable by group or others on a POSIX system. */
  insecurePermissions: boolean
  /** Error encountered while reading (other than "not found"). */
  error?: Error
}

/**
 * Outcome of applying one version of a secrets file to the environment.
 */
export interface ApplyResult {
  /** Keys newly injected into the environment. */
  added: string[]
  /** Owned keys whose value changed. */
  updated: string[]
  /** Owned keys withdrawn because they disappeared from the file. */
  removed: string[]
  /** Keys skipped because the real environment provides them. */
  kept: string[]
}

/**
 * Resolve the default secrets file location following the host's own global
 * config directory resolution: OPENCODE_CONFIG_DIR when set, then
 * $XDG_CONFIG_HOME/opencode, otherwise ~/.config/opencode.
 */
export function defaultSecretsPath(input: { xdgConfigHome?: string; home?: string; configDir?: string } = {}): string {
  const configDir = input.configDir ?? (process.env.OPENCODE_CONFIG_DIR || undefined)
  if (configDir) return join(configDir, "secrets.env")
  const xdg = input.xdgConfigHome ?? process.env.XDG_CONFIG_HOME
  if (xdg) return join(xdg, "opencode", "secrets.env")
  const home = input.home ?? homedir()
  return join(home, ".config", "opencode", "secrets.env")
}

/**
 * Expand "~" and resolve relative paths against `base`.
 */
export function expandPath(path: string, base: string, home: string = homedir()): string {
  if (path === "~") return home
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2))
  if (isAbsolute(path)) return path
  return resolve(base, path)
}

/**
 * Read and parse a secrets file (dotenv format). A missing file is not an
 * error: `found` is false and `parsed` is empty. Values are never exposed
 * beyond the returned `parsed` object, and callers must not log them.
 */
export function readSecrets(file: string): ReadResult {
  let content: string
  try {
    content = readFileSync(file, "utf8")
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return { found: false, parsed: {}, insecurePermissions: false }
    }
    return { found: false, parsed: {}, insecurePermissions: false, error }
  }

  let insecurePermissions = false
  try {
    const { mode } = statSync(file)
    if (process.platform !== "win32" && (mode & 0o077) !== 0) insecurePermissions = true
  } catch {
    // Best effort only; never fail the load because of a stat problem.
  }

  return { found: true, parsed: parse(content), insecurePermissions }
}

/**
 * Tracks which environment variables the plugin injected so hot reloads can
 * update or withdraw exactly those keys — and never touch variables that came
 * from the real environment.
 *
 * One store per secrets file. Because every plugin instance in the service
 * shares one module (and one `process.env`), ownership recorded here is
 * honored by every later apply, no matter which location triggers it.
 */
export class SecretsStore {
  /**
   * Owned key -> the value the environment held before we took ownership
   * (`undefined` when the variable did not exist).
   */
  private readonly managed = new Map<string, string | undefined>()

  private readonly env: Record<string, string | undefined>

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env
  }

  /** Keys currently owned by this store. */
  keys(): string[] {
    return [...this.managed.keys()]
  }

  /**
   * Apply one version of the secrets file.
   *
   * - unknown key + free slot      -> inject and claim ownership ("added")
   * - unknown key + real env value -> leave it alone ("kept"), unless
   *   `override` is set, in which case the real value is saved and restored
   *   when the key is later withdrawn
   * - owned key                    -> update in place ("updated" when changed)
   * - owned key missing from file  -> withdraw, restoring the previous value
   *   or deleting the variable ("removed")
   */
  apply(parsed: Record<string, string>, options: { override?: boolean } = {}): ApplyResult {
    const added: string[] = []
    const updated: string[] = []
    const removed: string[] = []
    const kept: string[] = []

    for (const [key, value] of Object.entries(parsed)) {
      if (this.managed.has(key)) {
        if (this.env[key] !== value) {
          this.env[key] = value
          updated.push(key)
        }
        continue
      }
      const existing = this.env[key]
      if (existing === undefined) {
        this.managed.set(key, undefined)
        this.env[key] = value
        added.push(key)
        continue
      }
      if (options.override) {
        this.managed.set(key, existing)
        this.env[key] = value
        added.push(key)
        continue
      }
      kept.push(key)
    }

    for (const [key, previous] of [...this.managed]) {
      if (key in parsed) continue
      if (previous === undefined) delete this.env[key]
      else this.env[key] = previous
      this.managed.delete(key)
      removed.push(key)
    }

    return { added, updated, removed, kept }
  }

  /**
   * Withdraw every owned key, restoring the environment to its original
   * state. Used when the plugin unloads.
   */
  release(): string[] {
    return this.apply({}, {}).removed
  }
}

/**
 * Compute which of the `required` keys are still missing from `env`.
 */
export function missingRequired(required: readonly string[], env: Record<string, string | undefined> = process.env): string[] {
  return required.filter((key) => env[key] === undefined)
}
