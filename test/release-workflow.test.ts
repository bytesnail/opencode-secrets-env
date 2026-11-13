import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")

test("release workflow stages the npm package instead of publishing directly", () => {
  assert.match(workflow, /npm stage publish --provenance/)
  assert.doesNotMatch(workflow, /npm publish --provenance/)
  assert.doesNotMatch(workflow, /Verify the new version is visible on npm/)
})

test("npm release audit runs scheduled reconciliation with issue alerting", () => {
  const audit = readFileSync(new URL("../.github/workflows/npm-release-audit.yml", import.meta.url), "utf8")
  assert.match(audit, /schedule:/)
  assert.match(audit, /node scripts\/npm-release-audit\.ts/)
  assert.match(audit, /issues: write/)
  assert.match(audit, /gh issue create/)
})
