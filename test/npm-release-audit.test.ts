import { test } from "node:test"
import assert from "node:assert/strict"
import { findReleaseMismatches, unwrapNpmObject } from "../scripts/npm-release-audit.ts"

const NOW = new Date("2026-11-12T00:00:00.000Z")

test("release audit flags npm latest lagging a mature GitHub Release", () => {
  const releases = [
    { tagName: "v0.6.0", isDraft: false, publishedAt: "2026-11-01T00:00:00.000Z" },
    { tagName: "v0.6.1", isDraft: false, publishedAt: "2026-11-10T00:00:00.000Z" },
  ]
  const mismatches = findReleaseMismatches(
    {
      versions: ["0.6.0", "0.6.1"],
      distTags: { latest: "0.6.0" },
      time: { "0.6.0": "2026-11-01T00:00:00.000Z", "0.6.1": "2026-11-10T00:00:00.000Z" },
    },
    releases,
    NOW,
  )
  assert.ok(mismatches.some((line) => line.includes("latest") && line.includes("0.6.1")))
})

test("release audit flags any dist-tag pointing to an unapproved version", () => {
  const mismatches = findReleaseMismatches(
    {
      versions: ["0.5.9", "0.6.0"],
      distTags: { latest: "0.6.0", beta: "0.5.9" },
      time: { "0.5.9": "2026-10-01T00:00:00.000Z", "0.6.0": "2026-11-01T00:00:00.000Z" },
    },
    [{ tagName: "v0.6.0", isDraft: false, publishedAt: "2026-11-01T00:00:00.000Z" }],
    NOW,
  )
  assert.ok(mismatches.some((line) => line.includes("beta") && line.includes("0.5.9")))
})

test("release audit flags a recent npm version without a GitHub Release", () => {
  const mismatches = findReleaseMismatches(
    {
      versions: ["0.6.0", "0.6.1"],
      distTags: { latest: "0.6.0" },
      time: { "0.6.0": "2026-11-01T00:00:00.000Z", "0.6.1": "2026-11-11T00:00:00.000Z" },
    },
    [{ tagName: "v0.6.0", isDraft: false, publishedAt: "2026-11-01T00:00:00.000Z" }],
    NOW,
  )
  assert.ok(mismatches.some((line) => line.includes("0.6.1") && line.includes("no GitHub Release")))
})

test("release audit allows a staged release during its approval grace period", () => {
  const mismatches = findReleaseMismatches(
    {
      versions: ["0.6.0"],
      distTags: { latest: "0.6.0" },
      time: { "0.6.0": "2026-11-01T00:00:00.000Z" },
    },
    [
      { tagName: "v0.6.0", isDraft: false, publishedAt: "2026-11-01T00:00:00.000Z" },
      { tagName: "v0.6.1", isDraft: false, publishedAt: "2026-11-11T23:00:00.000Z" },
    ],
    NOW,
  )
  assert.deepEqual(mismatches, [])
})

test("release audit accepts plain and npm-12-wrapped object results", () => {
  assert.deepEqual(unwrapNpmObject({ latest: "0.6.0" }), { latest: "0.6.0" })
  assert.deepEqual(unwrapNpmObject([{ latest: "0.6.0" }]), { latest: "0.6.0" })
})

test("release audit accepts a newly approved release inside the grace period", () => {
  const mismatches = findReleaseMismatches(
    {
      versions: ["0.6.0", "0.6.1"],
      distTags: { latest: "0.6.1" },
      time: { "0.6.0": "2026-11-01T00:00:00.000Z", "0.6.1": "2026-11-11T22:00:00.000Z" },
    },
    [
      { tagName: "v0.6.0", isDraft: false, publishedAt: "2026-11-01T00:00:00.000Z" },
      { tagName: "v0.6.1", isDraft: false, publishedAt: "2026-11-11T22:00:00.000Z" },
    ],
    NOW,
  )
  assert.deepEqual(mismatches, [])
})
