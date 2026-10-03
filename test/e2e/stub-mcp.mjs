// Minimal MCP stdio server for E2E tests. On startup it appends a JSON line
// recording its pid and the environment variables that prove delivery:
//   inherited  — the variable the plugin injected into the host's process.env
//   substituted — the value produced by {env:...} substitution in MCP config
// Afterwards it answers initialize / tools/list and otherwise stays alive.
import { appendFileSync } from "node:fs"

const dump = process.env.STUB_DUMP
if (dump) {
  const record = {
    pid: process.pid,
    at: Date.now(),
    inherited: process.env.E2E_SECRET ?? null,
    substituted: process.env.STUB_SUBSTITUTED ?? null,
  }
  appendFileSync(dump, JSON.stringify(record) + "\n")
}

let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && msg.method) {
      const result =
        msg.method === "initialize"
          ? { protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: {}, serverInfo: { name: "stub", version: "0.0.0" } }
          : msg.method === "tools/list"
            ? { tools: [] }
            : {}
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n")
    }
  }
})
setInterval(() => {}, 1000)
