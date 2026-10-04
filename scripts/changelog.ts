#!/usr/bin/env node
// npm `version` lifecycle script. `npm version <level> --no-git-tag-version`
// bumps package.json and then runs this: CHANGELOG.md's [Unreleased] section
// becomes a dated section for the new version — entries already curated
// under [Unreleased] are carried over verbatim, then the conventional
// commits since the previous tag are appended as draft entries
// (deduplicated: a commit whose text already appears as a curated line, or
// repeats an earlier commit's subject, is dropped) — and the link
// definitions at the bottom are refreshed. The file is left staged
// (see the `version` script in package.json); review/trim the generated
// entries before committing `chore: release vX.Y.Z`.
//
// Re-running is a no-op once the version's section exists. Pure logic is
// exported for test/changelog.test.ts.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const BUCKETS: [string, string[]][] = [
  ["Added", ["feat"]],
  ["Fixed", ["fix"]],
  ["Changed", ["perf", "refactor"]],
  ["Documentation", ["docs"]],
  ["Internal", ["test", "ci", "build", "chore", "style"]],
]

export interface Commit {
  hash: string
  subject: string
}

export interface RenderOptions {
  version: string
  date: string
  prevTag: string | null
  repoUrl: string
  commits: Commit[]
}

// "fix(scope)!: subject" -> { bucket, text } | null (non-conventional
// subjects are left out of the generated draft; add them by hand).
export function classify(subject: string): { bucket: string; text: string } | null {
  const m = subject.match(/^(\w+)(\([^)]*\))?(!)?:\s+(.+)$/)
  if (!m) return null
  const type = m[1]
  const bang = m[3]
  const rest = m[4]
  if (!type || !rest) return null
  for (const [bucket, types] of BUCKETS) {
    if (types.includes(type)) {
      const text = rest.charAt(0).toUpperCase() + rest.slice(1)
      return { bucket, text: bang ? `**BREAKING:** ${text}` : text }
    }
  }
  return null
}

// Normalizes a changelog bullet for deduplication: drops the leading "- "
// and any trailing commit-hash annotation, trailing punctuation, and case —
// so a curated "- Plug leak." matches the generated "- Plug leak (`aaa1111`)",
// and two commits sharing a subject collapse into one entry.
export function dedupeKey(entry: string): string {
  return entry
    .replace(/^- /, "")
    .replace(/\s*\((`[0-9a-f]+`(, )?)+\)\.?$/i, "")
    .replace(/[\s.]+$/, "")
    .toLowerCase()
}

// Merges generated bucket items into the curated section: buckets whose
// `### <Name>` heading already exists get their items appended in place;
// the rest become new subsections (in BUCKETS order) after the curated text.
function mergeBuckets(curated: string, byBucket: Map<string, string[]>): string {
  const lines = curated.split("\n")
  const out: string[] = []
  const used = new Set<string>()
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    out.push(line)
    i++
    const m = line.match(/^### (.+)$/)
    const items = m?.[1] ? byBucket.get(m[1]) : undefined
    if (!m?.[1] || !items) continue
    let j = i
    while (j < lines.length && !lines[j]!.startsWith("### ")) j++
    let k = j
    while (k - 1 > i && lines[k - 1]!.trim() === "") k--
    out.push(...lines.slice(i, k), ...items, ...lines.slice(k, j))
    used.add(m[1])
    i = j
  }
  const rest: string[] = []
  for (const [bucket] of BUCKETS) {
    if (used.has(bucket)) continue
    const items = byBucket.get(bucket)
    if (items?.length) rest.push(`### ${bucket}\n\n${items.join("\n")}`)
  }
  return [out.join("\n").replace(/\n*$/, ""), ...rest].join("\n\n")
}

// Returns the rewritten changelog, or null when the version's section
// already exists (idempotent re-run). `commits` reads best oldest-first, so
// pass them reversed from git-log order.
export function renderChangelog(text: string, opts: RenderOptions): string | null {
  const { version, date, prevTag, repoUrl, commits } = opts
  if (text.includes(`## [${version}]`)) return null

  const unreleasedAt = text.search(/^## \[Unreleased\]$/m)
  if (unreleasedAt < 0) throw new Error("CHANGELOG.md: no '## [Unreleased]' section")
  const headingEnd = text.indexOf("\n", unreleasedAt) + 1
  let nextAt = text.indexOf("\n## [", headingEnd)
  if (nextAt < 0) nextAt = text.length
  const curated = text.slice(headingEnd, nextAt).trim()

  // Dedupe: seed the seen-set with the curated bullets, then keep only the
  // first generated entry per normalized text (commits arrive oldest-first).
  const seen = new Set<string>()
  for (const line of curated.split("\n")) {
    const bullet = line.trimStart()
    if (bullet.startsWith("- ")) seen.add(dedupeKey(bullet))
  }
  const byBucket = new Map<string, string[]>()
  for (const { hash, subject } of commits) {
    const c = classify(subject)
    if (!c) continue
    const key = dedupeKey(c.text)
    if (seen.has(key)) continue
    seen.add(key)
    let items = byBucket.get(c.bucket)
    if (!items) {
      items = []
      byBucket.set(c.bucket, items)
    }
    items.push(`- ${c.text} (\`${hash}\`)`)
  }
  let body: string
  if (curated) {
    body = mergeBuckets(curated, byBucket)
  } else {
    const sections: string[] = []
    for (const [bucket] of BUCKETS) {
      const items = byBucket.get(bucket)
      if (items?.length) sections.push(`### ${bucket}\n\n${items.join("\n")}`)
    }
    body = sections.join("\n\n")
  }
  if (!body) body = "- Maintenance release."

  const before = text.slice(0, unreleasedAt)
  let after = text.slice(nextAt)

  // Refresh the link definitions: [Unreleased] now diffs against the new
  // tag, and the new version links against the previous one.
  const newLink = prevTag
    ? `[${version}]: ${repoUrl}/compare/${prevTag}...v${version}`
    : `[${version}]: ${repoUrl}/commits/v${version}`
  if (/^\[Unreleased\]: .+$/m.test(after)) {
    after = after.replace(
      /^\[Unreleased\]: .+$/m,
      `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD\n${newLink}`,
    )
  } else {
    after = `${after.replace(/\n*$/, "")}\n\n[Unreleased]: ${repoUrl}/compare/v${version}...HEAD\n${newLink}\n`
  }

  return `${before}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n\n${after.replace(/^\n+/, "")}`
}

function main(): void {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string
    repository: { url: string }
  }
  const version = pkg.version
  const repoUrl = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")
  const text = readFileSync("CHANGELOG.md", "utf8")

  const tagList = execFileSync("git", ["tag", "--list", "v[0-9]*", "--sort=-version:refname"], {
    encoding: "utf8",
  }).trim()
  const prevTag = tagList.split("\n")[0] || null

  const range = prevTag ? `${prevTag}..HEAD` : "HEAD"
  const raw = execFileSync("git", ["log", range, "--no-merges", "--format=%h %s"], {
    encoding: "utf8",
  }).trim()
  const commits: Commit[] = (raw ? raw.split("\n") : [])
    .map((line) => {
      const at = line.indexOf(" ")
      return { hash: line.slice(0, at), subject: line.slice(at + 1) }
    })
    .filter(({ subject }) => !subject.startsWith("chore: release"))
    .reverse()

  const out = renderChangelog(text, {
    version,
    date: new Date().toISOString().slice(0, 10),
    prevTag,
    repoUrl,
    commits,
  })
  if (out === null) {
    console.log(`changelog: ## [${version}] already exists, nothing to do`)
    return
  }
  writeFileSync("CHANGELOG.md", out)
  console.log(
    `changelog: drafted ## [${version}] from ${commits.length} commit(s) since ${prevTag ?? "the beginning"} — review before committing`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
