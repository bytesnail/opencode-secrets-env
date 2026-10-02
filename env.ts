import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { parse } from "dotenv"

/**
 * Options accepted by {@link loadSecrets}.
 */
export interface LoadOptions {
  /**
   * Explicit path to the secrets file. Supports "~" for the home directory
   * and relative paths, which are resolved against `base`.
   * When omitted, the default OpenCode config location is used
   * (`$XDG_CONFIG_HOME/opencode/secrets.env` or `~/.config/opencode/secrets.env`).
   */
  path?: string
  /**
   * Overwrite variables that already exist in the target environment.
   * Defaults to `false`: the real process environment always wins.
   */
  override?: boolean
  /**
   * Directory used to resolve a relative `path`. Defaults to `process.cwd()`.
   */
  base?: string
  /**
   * Environment object the secrets are applied to. Defaults to `process.env`.
   */
  env?: Record<string, string | undefined>
  /**
   * Overrides for path resolution (mainly for testing). When not provided,
   * the real `XDG_CONFIG_HOME` environment variable and OS home directory
   * are used.
   */
  xdgConfigHome?: string
  home?: string
}

/**
 * Outcome of a {@link loadSecrets} call.
 */
export interface LoadResult {
  /** Absolute path of the file that was loaded, or `undefined` when none was found/readable. */
  file?: string
  /** Keys that were applied to the environment. */
  applied: string[]
  /** Keys skipped because they already existed and `override` was false. */
  skipped: string[]
  /** Every key parsed from the file, in file order. */
  parsed: string[]
  /** True when the file is readable by group or others on a POSIX system. */
  insecurePermissions: boolean
  /** Error encountered while reading the file (other than "not found"). */
  error?: Error
}

/**
 * Resolve the default secrets file location following the XDG Base Directory
 * specification, the same way OpenCode resolves its global config directory.
 */
export function defaultSecretsPath(input: { xdgConfigHome?: string; home?: string } = {}): string {
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
 * Read the secrets file (dotenv format) and apply every entry to the target
 * environment. Missing files are not an error; the result simply reports no
 * file. Values are never included in the result so they cannot be logged
 * accidentally.
 */
export function loadSecrets(options: LoadOptions = {}): LoadResult {
  const target = options.env ?? process.env
  const file = options.path
    ? expandPath(options.path, options.base ?? process.cwd(), options.home ?? homedir())
    : defaultSecretsPath(options)

  const empty = { applied: [], skipped: [], parsed: [], insecurePermissions: false }

  let content: string
  try {
    content = readFileSync(file, "utf8")
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { ...empty }
    return { ...empty, error }
  }

  let insecurePermissions = false
  try {
    const { mode } = statSync(file)
    if (process.platform !== "win32" && (mode & 0o077) !== 0) insecurePermissions = true
  } catch {
    // Best effort only; never fail the load because of a stat problem.
  }

  const parsed = parse(content)
  const keys = Object.keys(parsed)
  const applied: string[] = []
  const skipped: string[] = []

  for (const key of keys) {
    if (!options.override && target[key] !== undefined) {
      skipped.push(key)
      continue
    }
    target[key] = parsed[key]
    applied.push(key)
  }

  return { file, applied, skipped, parsed: keys, insecurePermissions }
}

/**
 * Compute which of the `required` keys are still missing from `env`.
 */
export function missingRequired(required: readonly string[], env: Record<string, string | undefined> = process.env): string[] {
  return required.filter((key) => env[key] === undefined)
}
