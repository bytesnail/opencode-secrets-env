// Demo stub MCP stdio server (adapted from test/e2e/stub-mcp.mjs).
// On startup it appends one JSON line recording its pid and the two delivery
// paths for the secret:
//   inherited   — DEMO_API_KEY from the host process env (plugin injection)
//   substituted — API_KEY produced by {env:DEMO_API_KEY} in the MCP config
// Afterwards it answers initialize / tools/list and stays alive.
import { appendFileSync } from "node:fs"

const dump = process.env.STUB_DUMP
if (dump) {
  appendFileSync(
    dump,
    JSON.stringify({
      pid: process.pid,
      name: "demo",
      inherited: process.env.DEMO_API_KEY ?? null,
      substituted: process.env.API_KEY ?? null,
    }) + "\n",
  )
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
          ? { protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: {}, serverInfo: { name: "demo", version: "0.0.0" } }
          : msg.method === "tools/list"
            ? { tools: [] }
            : {}
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n")
    }
  }
})
setInterval(() => {}, 1000)
