import assert from "node:assert/strict"
import { test } from "node:test"
import { poll, v1SessionEndpointTimeoutMs } from "./poll.ts"

test("V1 session endpoint allows extra startup time only on Windows", () => {
  assert.equal(v1SessionEndpointTimeoutMs("win32"), 120_000)
  assert.equal(v1SessionEndpointTimeoutMs("linux"), 60_000)
  assert.equal(v1SessionEndpointTimeoutMs("darwin"), 60_000)
})

test("poll timeout reports platform, elapsed time and attempt count", async () => {
  let attempts = 0
  const error = await poll(
    "never ready",
    () => {
      attempts += 1
      return false
    },
    0,
  ).then(
    () => null,
    (cause) => cause,
  )

  assert.ok(error instanceof Error)
  assert.match(error.message, /^timed out waiting for: never ready/)
  assert.match(error.message, new RegExp(`platform=${process.platform}`))
  assert.match(error.message, /elapsed_ms=\d+/)
  assert.match(error.message, new RegExp(`attempts=${attempts}(?:\\)|$)`))
})
