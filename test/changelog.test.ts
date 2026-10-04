import assert from "node:assert/strict"
import { test } from "node:test"
import { classify, dedupeKey, renderChangelog } from "../scripts/changelog.ts"

const REPO = "https://github.com/example/repo"

const FIXTURE = `# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed

- A hand-curated entry already written during development.

## [0.5.0] - 2026-10-04

### Added

- Something from the last release.

[Unreleased]: ${REPO}/compare/v0.5.0...HEAD
[0.5.0]: ${REPO}/compare/v0.4.5...v0.5.0
[0.4.5]: ${REPO}/compare/v0.4.4...v0.4.5
`

test("classify buckets conventional-commit subjects", () => {
  assert.deepEqual(classify("feat: add watch mode"), { bucket: "Added", text: "Add watch mode" })
  assert.deepEqual(classify("fix(cli): drop bad flag"), { bucket: "Fixed", text: "Drop bad flag" })
  assert.deepEqual(classify("perf: faster scan"), { bucket: "Changed", text: "Faster scan" })
  assert.deepEqual(classify("docs: fix typo"), { bucket: "Documentation", text: "Fix typo" })
  assert.deepEqual(classify("ci: pin runners"), { bucket: "Internal", text: "Pin runners" })
  assert.deepEqual(classify("fix!: change api"), {
    bucket: "Fixed",
    text: "**BREAKING:** Change api",
  })
  assert.equal(classify("not a conventional subject"), null)
})

test("renderChangelog carries curated entries, appends buckets, refreshes links", () => {
  const out = renderChangelog(FIXTURE, {
    version: "0.5.1",
    date: "2026-10-05",
    prevTag: "v0.5.0",
    repoUrl: REPO,
    commits: [
      { hash: "aaa1111", subject: "fix: plug leak" },
      { hash: "bbb2222", subject: "feat: add flag" },
      { hash: "ccc3333", subject: "random merge noise" },
    ],
  })
  assert.ok(out)

  // Unreleased is emptied; the new dated section follows it.
  const unreleasedBody = out.slice(out.indexOf("## [Unreleased]"), out.indexOf("## [0.5.1]"))
  assert.equal(unreleasedBody, "## [Unreleased]\n\n")

  // Curated entry carried verbatim; generated fix merges into the curated
  // "### Fixed" subsection instead of duplicating the heading.
  assert.match(out, /## \[0\.5\.1\] - 2026-10-05\n\n### Fixed\n\n- A hand-curated entry already written during development\.\n- Plug leak \(`aaa1111`\)/)
  assert.equal(out.match(/### Fixed/g)?.length, 1, "no duplicate bucket headings")
  const addedAt = out.indexOf("### Added\n\n- Add flag (`bbb2222`)")
  const fixedAt = out.indexOf("### Fixed")
  assert.ok(addedAt > fixedAt && addedAt < out.indexOf("## [0.5.0]"), "new buckets follow curated content")
  assert.ok(!out.includes("random merge noise"), "non-conventional subjects excluded")

  // Older sections and links untouched; link defs updated.
  assert.match(out, /## \[0\.5\.0\] - 2026-10-04/)
  assert.match(out, /\[Unreleased\]: https:\/\/github\.com\/example\/repo\/compare\/v0\.5\.1\.\.\.HEAD/)
  assert.match(out, /\[0\.5\.1\]: https:\/\/github\.com\/example\/repo\/compare\/v0\.5\.0\.\.\.v0\.5\.1/)
  assert.match(out, /\[0\.4\.5\]: https:\/\/github\.com\/example\/repo\/compare\/v0\.4\.4\.\.\.v0\.4\.5/)
})

test("dedupeKey normalizes bullets, hashes, punctuation and case", () => {
  assert.equal(dedupeKey("- Plug leak (`aaa1111`)"), "plug leak")
  assert.equal(dedupeKey("- Plug leak (`aaa1111`, `bbb2222`)."), "plug leak")
  assert.equal(dedupeKey("- Plug Leak."), "plug leak")
  assert.equal(dedupeKey("Plug leak"), "plug leak")
  assert.notEqual(dedupeKey("- Add flag"), dedupeKey("- Add flag validation"))
})

test("renderChangelog drops generated entries duplicating curated lines or earlier commits", () => {
  const out = renderChangelog(FIXTURE, {
    version: "0.5.1",
    date: "2026-10-05",
    prevTag: "v0.5.0",
    repoUrl: REPO,
    commits: [
      // Same text as the curated Fixed line (curated has no hash, ends with ".").
      { hash: "aaa1111", subject: "fix: a hand-curated entry already written during development" },
      // Same subject twice: only the first (oldest) survives.
      { hash: "bbb2222", subject: "fix: plug leak" },
      { hash: "ccc3333", subject: "fix: plug leak" },
      // Same text under a different bucket is still a duplicate.
      { hash: "ddd4444", subject: "feat: plug leak" },
      // Merely sharing a prefix is not a duplicate.
      { hash: "eee5555", subject: "fix: plug leak detection" },
    ],
  })
  assert.ok(out)
  assert.equal(out.match(/hand-curated entry/g)?.length, 1, "curated entry not duplicated")
  assert.equal(out.match(/- Plug leak \(`bbb2222`\)/g)?.length, 1, "first occurrence kept")
  assert.ok(!out.includes("ccc3333"), "second same-subject commit dropped")
  assert.ok(!out.includes("ddd4444"), "cross-bucket duplicate dropped")
  assert.ok(out.includes("- Plug leak detection (`eee5555`)"), "prefix-only lookalike kept")
})

test("renderChangelog is a no-op when the version section exists", () => {
  assert.equal(
    renderChangelog(FIXTURE, {
      version: "0.5.0",
      date: "2026-10-05",
      prevTag: "v0.4.5",
      repoUrl: REPO,
      commits: [],
    }),
    null,
  )
})

test("renderChangelog handles empty Unreleased and missing [Unreleased] link", () => {
  const text = `# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- First.\n`
  const out = renderChangelog(text, {
    version: "0.2.0",
    date: "2026-10-05",
    prevTag: "v0.1.0",
    repoUrl: REPO,
    commits: [{ hash: "ddd4444", subject: "chore: tidy" }],
  })
  assert.ok(out)
  assert.match(out, /## \[0\.2\.0\] - 2026-10-05\n\n### Internal\n\n- Tidy \(`ddd4444`\)/)
  assert.match(out, /\[Unreleased\]: https:\/\/github\.com\/example\/repo\/compare\/v0\.2\.0\.\.\.HEAD/)
  assert.match(out, /\[0\.2\.0\]: https:\/\/github\.com\/example\/repo\/compare\/v0\.1\.0\.\.\.v0\.2\.0/)
})

test("renderChangelog falls back to a placeholder when there is nothing to say", () => {
  const out = renderChangelog("# Changelog\n\n## [Unreleased]\n\n", {
    version: "0.1.0",
    date: "2026-10-05",
    prevTag: null,
    repoUrl: REPO,
    commits: [],
  })
  assert.ok(out)
  assert.match(out, /## \[0\.1\.0\] - 2026-10-05\n\n- Maintenance release\./)
  assert.match(out, /\[0\.1\.0\]: https:\/\/github\.com\/example\/repo\/commits\/v0\.1\.0/)
})
