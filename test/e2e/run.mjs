// End-to-end harness: installs a real OpenCode host (V1 = opencode-ai,
// V2 = @opencode/cli), installs the plugin from `npm pack` output, boots the
// host with an isolated HOME/XDG environment, and asserts the full chain:
// plugin load -> secrets injected -> stub MCP server spawned with the values
// -> hot reload -> MCP reconnect picks up the new values (V2 only; V1 hosts
// have no MCP transform API).
//
// Usage: node test/e2e/run.mjs --host v1|v2 [--keep]
//
// Host versions are pinned for reproducibility; bump them deliberately.
// OPENCODE_E2E_V1_SPEC / OPENCODE_E2E_V2_SPEC override (e.g. to probe a newer
// release before adopting it, or an older one before lowering a floor).
// The pins track the latest stable hosts; package.json's engines.opencode
// floor is the oldest V1 release passing this harness (see the README's
// Development section).

import { execFile, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HOST_SPECS = {
  v1: process.env.OPENCODE_E2E_V1_SPEC ?? "opencode-ai@1.18.34",
  v2: process.env.OPENCODE_E2E_V2_SPEC ?? "@opencode/cli@2.0.22",
}

const SECRET_KEY = "E2E_SECRET"
const VALUE_ONE = "e2e-value-one"
const VALUE_TWO = "e2e-value-two"

const args = process.argv.slice(2)
const host = args[args.indexOf("--host") + 1]
const keep = args.includes("--keep")
if (host !== "v1" && host !== "v2") {
  console.error("usage: node test/e2e/run.mjs --host v1|v2 [--keep]")
  process.exit(2)
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const stubPath = join(repoRoot, "test", "e2e", "stub-mcp.mjs")
const workdir = mkdtempSync(join(tmpdir(), `opencode-secrets-env-e2e-${host}-`))

const failures = []
function check(name, condition, detail = "") {
  if (condition) console.log(`ok   - ${name}`)
  else {
    console.error(`FAIL - ${name}${detail ? ` (${detail})` : ""}`)
    failures.push(name)
  }
}

function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, argv, { timeout: 120_000, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${argv.join(" ")} failed: ${error.message}\n${stdout}\n${stderr}`))
      else resolve({ stdout, stderr })
    })
  })
}

// execFile cannot run npm's .cmd shim on Windows (CVE-2024-27980 hardening);
// go through cmd.exe there. Host installs download tens of MB, hence the
// longer timeout.
function npm(argv, options = {}) {
  const timeout = options.timeout ?? 300_000
  return process.platform === "win32"
    ? run("cmd.exe", ["/d", "/s", "/c", "npm", ...argv], { ...options, timeout })
    : run("npm", argv, { ...options, timeout })
}

async function poll(description, condition, timeoutMs = 60_000) {
  const start = Date.now()
  for (;;) {
    if (await condition()) return true
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

function readDump(dumpFile) {
  return readLines(dumpFile).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Setup: pack the plugin, install it, install the host CLI
// ---------------------------------------------------------------------------

console.log(`e2e host=${host} workdir=${workdir}`)

const { stdout: packName } = await npm(["pack", "--silent", "--pack-destination", workdir], { cwd: repoRoot })
const tarball = join(workdir, packName.trim().split("\n").at(-1))

// Installing the tarball via npm resolves the plugin's declared dependencies
// and unpacks it in one step (tar on Windows would be a portability trap).
const pluginRoot = join(workdir, "plugin")
await npm(["install", "--prefix", pluginRoot, "--loglevel=error", tarball])
const pluginDir = join(pluginRoot, "node_modules", "opencode-secrets-env")
check("plugin package installs from tarball", existsSync(join(pluginDir, "index.ts")))

const hostRoot = join(workdir, "host")
// The host's postinstall links the real platform binary into place; scripts
// must stay enabled or the bin is a stub that only prints an error.
await npm(["install", "--prefix", hostRoot, "--loglevel=error", HOST_SPECS[host]])
const hostPkg = host === "v1" ? "opencode-ai" : "@opencode/cli"
const hostBinDir = join(hostRoot, "node_modules", ...hostPkg.split("/"), "bin")
// Current hosts link the REAL binary to bin/opencode.exe on every platform
// (the .bin/opencode shim is a .cmd on Windows; the exe path avoids it).
// Older V1 hosts (<= ~1.15) instead ship a node wrapper at bin/opencode that
// spawns the platform binary; it works on POSIX (on Windows a wrapper script
// cannot be execFile'd, so probing pre-.exe hosts is POSIX-only).
const bin = ["opencode.exe", "opencode"].map((name) => join(hostBinDir, name)).find((candidate) => existsSync(candidate))
check("host binary exists", bin !== undefined, hostBinDir)

// ---------------------------------------------------------------------------
// Isolated environment + real configuration
// ---------------------------------------------------------------------------

const home = join(workdir, "home")
const xdgConfig = join(workdir, "xdg-config")
const xdgData = join(workdir, "xdg-data")
const project = join(workdir, "project")
const dumpFile = join(workdir, "stub-dump.jsonl")
const secretsFile = join(xdgConfig, "opencode", "secrets.env")
const pluginLog = join(xdgData, "opencode", "log", "opencode-secrets-env.log")
for (const dir of [home, dirname(secretsFile), project]) mkdirSync(dir, { recursive: true })

const env = { ...process.env }
// Never let ambient OpenCode variables leak into the isolated instance.
for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_")) delete env[key]
Object.assign(env, {
  HOME: home,
  USERPROFILE: home, // Windows: os.homedir() source
  HOMEDRIVE: home.slice(0, 2), // Windows fallback, e.g. "C:"
  HOMEPATH: home.slice(2).replaceAll("/", "\\"),
  OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
  XDG_CACHE_HOME: join(workdir, "xdg-cache"),
  XDG_STATE_HOME: join(workdir, "xdg-state"),
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  STUB_DUMP: dumpFile,
})

function writeSecrets(value) {
  writeFileSync(secretsFile, `${SECRET_KEY}=${value}\n`, { mode: 0o600 })
  if (process.platform !== "win32") chmodSync(secretsFile, 0o600)
}
writeSecrets(VALUE_ONE)

// Plugin entry: "plugin" with [name, options] tuples is the one form that
// both host generations load the same way. V1's config schema decodes the
// singular "plugin" key only, as string | [name, options] — {package,
// options} objects are rejected there. V2 additionally accepts the plural
// "plugins" key with {package, options} objects (its `plugin add` command
// writes that form). On V1 the plural key feeds the embedded next-gen
// loader, whose plugin context has no location/mcp — this plugin cannot
// run through it, so the singular key is required on V1.
writeFileSync(
  join(xdgConfig, "opencode", "opencode.jsonc"),
  JSON.stringify({ autoupdate: false, plugin: [[pluginDir, { debug: true }]] }, null, 2),
)

// MCP server config in each host's canonical shape: V1 defines servers
// directly at mcp.<name>, V2 nests them under mcp.servers.<name>. Each host
// still accepts the other's form (the unit tests cover the cross-shape
// scanning); the plugin scans both.
const stubServer = {
  type: "local",
  command: [process.execPath, stubPath],
  environment: { STUB_SUBSTITUTED: `{env:${SECRET_KEY}}` },
}
const mcpConfig = host === "v1" ? { mcp: { stub: stubServer } } : { mcp: { servers: { stub: stubServer } } }
writeFileSync(join(project, "opencode.jsonc"), JSON.stringify(mcpConfig, null, 2))

const port = 20000 + Math.floor(Math.random() * 25000)

// ---------------------------------------------------------------------------
// Host flows
// ---------------------------------------------------------------------------

async function v2Flow() {
  // The managed service uses a FIXED default port; on a shared machine (or a
  // developer box already running OpenCode) it would collide, so pick one.
  await run(bin, ["service", "set", "port", String(port)], { cwd: project, env })
  await run(bin, ["service", "start"], { cwd: project, env })
  try {
    // A location boots (plugin load + eager MCP connect) when a CLI command
    // touches the running service from the project directory.
    await run(bin, ["mcp", "list"], { cwd: project, env })

    await poll("initial stub spawn", () => readDump(dumpFile).length >= 1)
    const [first] = readDump(dumpFile)
    check("v2: plugin injected into host environment (inherited by MCP process)", first.inherited === VALUE_ONE, JSON.stringify(first))
    check("v2: {env:...} substitution delivered to MCP config", first.substituted === VALUE_ONE, JSON.stringify(first))
    check(
      "v2: plugin log records startup injection",
      readLines(pluginLog).some((line) => line.includes("startup: 1 injected")),
    )

    writeSecrets(VALUE_TWO)
    await poll(
      "hot reload + reconnect",
      () => readLines(pluginLog).some((line) => line.includes("reconnecting MCP server(s)")) && readDump(dumpFile).length >= 2,
    )
    const [_, second] = readDump(dumpFile)
    check("v2: MCP server respawned after reload", second.pid !== first.pid, `pids ${first.pid} -> ${second.pid}`)
    check("v2: respawned MCP process inherited the new value", second.inherited === VALUE_TWO, JSON.stringify(second))
    check("v2: respawned MCP config re-substituted the new value", second.substituted === VALUE_TWO, JSON.stringify(second))
  } finally {
    await run(bin, ["service", "stop"], { cwd: project, env }).catch(() => {})
  }
}

async function v1Flow() {
  const password = "e2e-pw"
  const serveOut = join(workdir, "serve.stdout.log")
  const serveErr = join(workdir, "serve.stderr.log")
  const outFd = (await import("node:fs")).openSync(serveOut, "w")
  const errFd = (await import("node:fs")).openSync(serveErr, "w")
  const serve = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: project,
    env: { ...env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", outFd, errFd],
  })
  serve.once("exit", () => {})
  try {
    const base = `http://127.0.0.1:${port}`
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    const createSession = () =>
      new Promise((resolve) => {
        // agent: false — a fresh socket per attempt. With the default
        // keep-alive agent, one socket that stalls during the server's
        // startup window silently swallows every later request.
        const req = request(
          `${base}/session`,
          { method: "POST", agent: false, headers: { authorization: auth, "content-type": "application/json" } },
          (res) => {
            res.resume()
            resolve(res.statusCode === 200)
          },
        )
        req.on("error", () => resolve(false))
        req.setTimeout(5000, () => {
          req.destroy()
          resolve(false)
        })
        req.end("{}")
      })
    // V1's serve does not bootstrap the project (or load plugins) until the
    // first session is created over HTTP.
    await poll("v1 server session endpoint", () => createSession())
    await poll("plugin load", () => readLines(pluginLog).some((line) => line.includes("startup: 1 injected")))
    check("v1: plugin injected on session bootstrap", true)

    writeSecrets(VALUE_TWO)
    await poll("hot reload", () => readLines(pluginLog).some((line) => line.includes("reload: 1 updated")))
    check("v1: hot reload applied in the long-running server", true)

    // V1 connects MCP lazily (a session needs a model), but `mcp list` runs a
    // short-lived in-process bootstrap that loads the plugin and connects.
    await run(bin, ["mcp", "list"], { cwd: project, env })
    await poll("stub spawn via mcp list", () => readDump(dumpFile).length >= 1)
    const [first] = readDump(dumpFile)
    check("v1: MCP process inherited the injected secret", first.inherited === VALUE_TWO, JSON.stringify(first))
    // Documented V1 limitation: config substitution runs before the plugin
    // injects, and V1 has no transform API to repair it afterwards.
    check("v1: {env:...} config substitution stays empty (documented V1 limitation)", first.substituted === "")
  } finally {
    serve.kill()
    // The process may have exited before the listener attached (or may
    // ignore SIGTERM on Windows) — never block forever on the exit event.
    if (serve.exitCode === null) {
      await Promise.race([new Promise((resolve) => serve.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5000))])
    }
  }
}

try {
  if (host === "v2") await v2Flow()
  else await v1Flow()
} catch (cause) {
  failures.push(`uncaught: ${(cause instanceof Error ? cause.message : String(cause))}`)
}

if (failures.length > 0) {
  console.error(`\ne2e ${host}: ${failures.length} failure(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  for (const log of ["serve.stdout.log", "serve.stderr.log"]) {
    const file = join(workdir, log)
    if (existsSync(file)) console.error(`\n--- ${log} (tail) ---\n${readLines(file).slice(-15).join("\n")}`)
  }
}

if (keep) console.log(`workdir kept: ${workdir}`)
else rmSync(workdir, { recursive: true, force: true })

if (failures.length > 0) process.exit(1)
console.log(`\ne2e ${host}: all checks passed`)
