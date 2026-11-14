import { execFileSync } from "node:child_process"
import { appendFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export interface RegistrySnapshot {
  versions: string[]
  distTags: Record<string, string>
  time: Record<string, string>
}

export interface GitHubReleaseRecord {
  tagName: string
  isDraft: boolean
  publishedAt: string | null
}

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const APPROVAL_GRACE_MS = 24 * 60 * 60 * 1000

export function findReleaseMismatches(snapshot: RegistrySnapshot, releases: GitHubReleaseRecord[], now: Date): string[] {
  const approvedVersions = new Set(
    releases
      .filter((release) => !release.isDraft && release.publishedAt !== null && /^v.+/.test(release.tagName))
      .map((release) => release.tagName.slice(1)),
  )
  const cutoff = now.getTime() - RECENT_WINDOW_MS
  const mismatches: string[] = []
  for (const version of snapshot.versions) {
    const publishedAt = Date.parse(snapshot.time[version] ?? "")
    if (Number.isFinite(publishedAt) && publishedAt >= cutoff && !approvedVersions.has(version)) {
      mismatches.push(`npm version ${version} has no GitHub Release (expected v${version})`)
    }
  }
  for (const [tag, version] of Object.entries(snapshot.distTags)) {
    if (!approvedVersions.has(version)) {
      mismatches.push(`npm dist-tag ${tag} points to ${version}, which has no GitHub Release`)
    }
  }
  const newestApprovedRelease = releases
    .filter((release) => !release.isDraft && release.publishedAt !== null && /^v.+/.test(release.tagName))
    .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""))[0]
  // A release approved inside the grace period is already the newest valid
  // target; do not compare it backwards to the previous mature release.
  if (newestApprovedRelease && snapshot.distTags.latest === newestApprovedRelease.tagName.slice(1)) return mismatches
  const newestMatureRelease = releases
    .filter((release) => {
      const publishedAt = Date.parse(release.publishedAt ?? "")
      return !release.isDraft && /^v.+/.test(release.tagName) && Number.isFinite(publishedAt) && publishedAt <= now.getTime() - APPROVAL_GRACE_MS
    })
    .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""))[0]
  if (newestMatureRelease) {
    const expected = newestMatureRelease.tagName.slice(1)
    const actual = snapshot.distTags.latest
    if (actual !== expected) {
      mismatches.push(`npm latest (${actual ?? "missing"}) does not match newest approved GitHub Release v${expected}`)
    }
  }
  return mismatches
}

function readJson<T>(command: string, args: string[]): T {
  return JSON.parse(execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as T
}

export function unwrapNpmObject<T>(value: T | [T]): T {
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "object" && value[0] !== null && !Array.isArray(value[0])) {
    return value[0]
  }
  return value as T
}

function readNpmObject<T>(args: string[]): T {
  return unwrapNpmObject(readJson<T | [T]>("npm", args))
}

function runLiveAudit(): void {
  const repository = process.env.GITHUB_REPOSITORY ?? "bytesnail/opencode-secrets-env"
  const snapshot: RegistrySnapshot = {
    versions: readJson<string[]>("npm", ["view", "opencode-secrets-env", "versions", "--json"]),
    distTags: readNpmObject<Record<string, string>>(["view", "opencode-secrets-env", "dist-tags", "--json"]),
    time: readNpmObject<Record<string, string>>(["view", "opencode-secrets-env", "time", "--json"]),
  }
  const releases = readJson<GitHubReleaseRecord[]>("gh", [
    "release",
    "list",
    "--repo",
    repository,
    "--limit",
    "200",
    "--json",
    "tagName,isDraft,publishedAt",
  ])
  const mismatches = findReleaseMismatches(snapshot, releases, new Date())
  const lines = [
    "# npm release audit",
    "",
    ...(mismatches.length > 0
      ? ["Registry metadata does not match approved GitHub Releases:", "", ...mismatches.map((line) => `- ${line}`)]
      : ["No registry/GitHub Release mismatches found."]),
    "",
  ]
  const report = lines.join("\n")
  writeFileSync("npm-release-audit.md", report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)
  console.log(report)
  if (mismatches.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runLiveAudit()
