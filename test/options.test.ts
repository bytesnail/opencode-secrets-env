import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeOptions } from "../index.ts"

test("normalizeOptions applies defaults for missing input", () => {
  assert.deepEqual(normalizeOptions(undefined), {
    path: undefined,
    override: false,
    watch: true,
    pollIntervalMs: 5000,
    mcpReconnect: true,
    quiet: false,
    debug: false,
    required: [],
  })
  assert.deepEqual(normalizeOptions({}), normalizeOptions(undefined))
})

test("normalizeOptions passes through well-typed values", () => {
  assert.deepEqual(
    normalizeOptions({
      path: "~/secrets/work.env",
      override: true,
      watch: false,
      pollIntervalMs: 2500,
      mcpReconnect: "all",
      quiet: true,
      debug: true,
      required: ["A", "B"],
    }),
    {
      path: "~/secrets/work.env",
      override: true,
      watch: false,
      pollIntervalMs: 2500,
      mcpReconnect: "all",
      quiet: true,
      debug: true,
      required: ["A", "B"],
    },
  )
})

test("normalizeOptions falls back to defaults on wrongly typed values", () => {
  const options = normalizeOptions({
    path: 42,
    override: "yes",
    watch: 0,
    pollIntervalMs: "fast",
    quiet: 1,
    debug: "true",
    required: "A",
  })
  assert.equal(options.path, undefined)
  assert.equal(options.override, false)
  assert.equal(options.watch, true)
  assert.equal(options.pollIntervalMs, 5000)
  assert.match(options.pollIntervalWarning ?? "", /pollIntervalMs/)
  assert.equal(options.quiet, false)
  assert.equal(options.debug, false)
  assert.deepEqual(options.required, [])
  // Negative, non-finite and fractional intervals fall back with a warning.
  for (const value of [-1, Number.NaN, 0.6, 1.9, 1500.9]) {
    const normalized = normalizeOptions({ pollIntervalMs: value })
    assert.equal(normalized.pollIntervalMs, 5000)
    assert.match(normalized.pollIntervalWarning ?? "", /pollIntervalMs/)
  }
  // Zero is meaningful: it disables the poll net without a warning.
  const disabled = normalizeOptions({ pollIntervalMs: 0 })
  assert.equal(disabled.pollIntervalMs, 0)
  assert.equal(disabled.pollIntervalWarning, undefined)
})

test("normalizeOptions treats an empty path as unset", () => {
  assert.equal(normalizeOptions({ path: "" }).path, undefined)
})

test("normalizeOptions trims the path and treats whitespace-only as unset", () => {
  assert.equal(normalizeOptions({ path: "  ~/secrets.env  " }).path, "~/secrets.env")
  assert.equal(normalizeOptions({ path: "   " }).path, undefined)
})

test("normalizeOptions normalizes the mcpReconnect variants", () => {
  assert.equal(normalizeOptions({ mcpReconnect: false }).mcpReconnect, false)
  assert.equal(normalizeOptions({ mcpReconnect: true }).mcpReconnect, true)
  assert.equal(normalizeOptions({ mcpReconnect: "all" }).mcpReconnect, "all")
  assert.deepEqual(normalizeOptions({ mcpReconnect: ["a", "b"] }).mcpReconnect, ["a", "b"])
  // Unknown values are not silently turned into "never reconnect".
  assert.equal(normalizeOptions({ mcpReconnect: "ALL" }).mcpReconnect, true)
  assert.equal(normalizeOptions({ mcpReconnect: 0 }).mcpReconnect, true)
  // Empty and invalid entries are filtered out of the allowlist.
  assert.deepEqual(normalizeOptions({ mcpReconnect: ["a", "", 1, null, "b"] }).mcpReconnect, ["a", "b"])
  assert.deepEqual(normalizeOptions({ mcpReconnect: [] }).mcpReconnect, [])
})

test("normalizeOptions filters empty and non-string required keys", () => {
  assert.deepEqual(normalizeOptions({ required: ["A", "", 2, "B"] }).required, ["A", "B"])
})
