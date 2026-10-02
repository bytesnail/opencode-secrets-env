import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { loadSecrets, missingRequired } from "./env.ts"

const ID = "opencode-secrets-env"
const PREFIX = `[${ID}]`

interface NormalizedOptions {
  path?: string
  override: boolean
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
    // Logging must never break plugin startup.
  }
}

/**
 * Load the secrets file into `process.env` and report what happened.
 * Secret values are never logged — only counts and, in debug mode, key names.
 */
function apply(options: NormalizedOptions, base: string): void {
  const emit = (level: "info" | "debug" | "warn", message: string) => {
    if (level === "debug" && !options.debug) return
    if (level !== "warn" && options.quiet) return
    const line = `${PREFIX}${level === "warn" ? " warning:" : ""} ${message}`
    appendLog(line)
    if (level === "warn") console.warn(line)
    else console.log(line)
  }

  const result = loadSecrets({
    path: options.path,
    override: options.override,
    base,
  })

  if (result.error) {
    emit("warn", `failed to read secrets file: ${result.error.message}`)
    return
  }

  if (!result.file) {
    emit("info", "no secrets file found (expected at ~/.config/opencode/secrets.env), skipping")
    return
  }

  if (result.parsed.length === 0) {
    emit("info", `${result.file} contains no entries, nothing to inject`)
  } else {
    emit("info", `injected ${result.applied.length} secret(s) from ${result.file}`)
    if (result.skipped.length > 0) {
      emit("info", `${result.skipped.length} entr(y/ies) left untouched because they already exist in the environment`)
    }
    emit("debug", `applied keys: ${result.applied.join(", ")}`)
    if (result.skipped.length > 0) emit("debug", `skipped keys: ${result.skipped.join(", ")}`)
  }

  if (result.insecurePermissions) {
    emit("warn", `${result.file} is readable by other users — consider running: chmod 600 ${result.file}`)
  }

  const missing = missingRequired(options.required)
  if (missing.length > 0) {
    emit("warn", `required environment variable(s) still missing after load: ${missing.join(", ")}`)
  }
}

export default {
  ...Plugin.define({
    id: ID,
    setup(ctx) {
      apply(normalizeOptions(ctx.options), ctx.location.directory)
    },
  }),

  // OpenCode V1 (>= 1.18.29) entry point. V1 has no plugin options, so the
  // default behavior applies: load the global secrets.env without overriding
  // existing environment variables.
  async server() {
    apply(normalizeOptions(undefined), process.cwd())
    return {}
  },
}
