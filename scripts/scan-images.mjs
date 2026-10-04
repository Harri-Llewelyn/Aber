#!/usr/bin/env node
/**
 * Fixable HIGH and CRITICAL vulnerabilities in the third-party images the chart runs, with `trivy
 * image`. The image list is rendered out of the chart, never written here; the images this
 * repository builds are left out because release.yml scans each one before pushing it. A finding
 * accepted after review is listed in scripts/lint/image-allowlist.json under its image repository,
 * in a group with a reason and an expiry date. Anything else fails, and so do a group on or past
 * its expiry date and an entry that no longer matches a finding.
 *
 *   node scripts/scan-images.mjs [--trivy-binary]
 *
 * Trivy runs as the pinned container scan:config uses, with the trivy-cache volume; with
 * --trivy-binary, or under GitHub Actions, it runs the `trivy` on PATH, which install-trivy pins to
 * the same release. Images are read from their registry. Needs helm, and Docker unless
 * --trivy-binary. Writes a Markdown summary to $GITHUB_STEP_SUMMARY when that is set.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969'
const ALLOWLIST = 'scripts/lint/image-allowlist.json'
const OWN = 'ghcr.io/harri-llewelyn/'
const binary = process.argv.includes('--trivy-binary') || process.env.GITHUB_ACTIONS === 'true'
const annotate = process.env.GITHUB_ACTIONS === 'true'
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }

const problems = []
const problem = (line) => {
  problems.push(line)
  console.log(annotate ? `::error::${line}` : `  ${line}`)
}

// The repository an allow-list group is keyed by: the reference without its tag or digest.
function repositoryOf (ref) {
  const bare = ref.split('@')[0]
  const slash = bare.lastIndexOf('/')
  const colon = bare.lastIndexOf(':')
  return colon > slash ? bare.slice(0, colon) : bare
}

// Every image a full render names, with the optional workloads switched on so their images are
// scanned too.
function renderedImages () {
  const render = spawnSync('helm', ['template', 'aber', join(REPO, 'deploy/helm/aber'),
    '-f', join(REPO, 'deploy/helm/aber/values-dev.yaml'),
    '--set', 'backup.enabled=true', '--set', 'backupService.enabled=true',
    '--set', 'playback.enabled=true', '--set', 'e2e.enabled=true'],
  { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (render.status !== 0) {
    console.error(`helm template failed:\n${render.stderr}`)
    process.exit(2)
  }
  const images = new Set()
  for (const m of render.stdout.matchAll(/^\s+image:\s+"?([^"\s]+)/gm)) {
    if (!m[1].startsWith(OWN)) images.add(m[1])
  }
  return [...images].sort()
}

// Fixable HIGH and CRITICAL only: an unfixed finding has no version to move to, and failing on it
// would train everyone to ignore this scan.
function scan (image) {
  const args = ['image', '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', '--scanners', 'vuln',
    '--image-src', 'remote', '--timeout', '15m', '--format', 'json', '--quiet', image]
  const r = binary
    ? spawnSync('trivy', args, { env, encoding: 'utf8', maxBuffer: 1 << 28 })
    : spawnSync('docker', ['run', '--rm', '-v', 'trivy-cache:/root/.cache/trivy', IMAGE, ...args],
      { env, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.status !== 0 || !r.stdout.trim()) {
    console.error(`trivy did not scan ${image}:\n${(r.stderr || r.error?.message || '').slice(-1500)}`)
    process.exit(2)
  }
  const keys = new Map()
  for (const res of JSON.parse(r.stdout).Results || []) {
    for (const v of res.Vulnerabilities || []) {
      const key = `${v.VulnerabilityID} ${v.PkgName}`
      if (!keys.has(key)) keys.set(key, { severity: v.Severity, fixed: v.FixedVersion, target: res.Target })
    }
  }
  return keys
}

const images = renderedImages()
// A scan that finds nothing to scan must not report success: if the render changes shape and the
// pattern stops matching, silence would look exactly like "no vulnerabilities".
if (images.length < 10) {
  console.error(`Only ${images.length} image(s) parsed out of the rendered chart, expected 10+.`)
  console.error('The parser has probably drifted from the chart\'s formatting.')
  process.exit(2)
}

const allow = JSON.parse(readFileSync(join(REPO, ALLOWLIST), 'utf8'))
const today = new Date().toISOString().slice(0, 10)
const rows = []
const seen = new Map()

console.log(`Scanning ${images.length} image(s) with ${binary ? 'the trivy on PATH' : IMAGE.split('@')[0]}`)
for (const image of images) {
  const repo = repositoryOf(image)
  const group = allow[repo]
  const found = scan(image)
  const accepted = new Set(group?.accept || [])
  const fresh = [...found.keys()].filter((k) => !accepted.has(k)).sort()
  seen.set(repo, new Set([...(seen.get(repo) || []), ...found.keys()]))
  rows.push({ image, total: found.size, accepted: found.size - fresh.length, fresh: fresh.length })
  console.log(`  ${image}: ${found.size} finding(s), ${fresh.length} new`)
  for (const k of fresh) {
    const f = found.get(k)
    problem(`NEW ${f.severity} ${k} in ${image} (${f.target}), fixed in ${f.fixed}`)
  }
}

for (const [repo, group] of Object.entries(allow)) {
  if (!seen.has(repo)) {
    problem(`stale allow-list group, the chart no longer runs ${repo}: delete it`)
    continue
  }
  if (!group.reason || !/^\d{4}-\d{2}-\d{2}$/.test(group.expires || '') || !Array.isArray(group.accept)) {
    problem(`allow-list group ${repo} needs a reason, an expires date (YYYY-MM-DD) and an accept list`)
    continue
  }
  if (today >= group.expires) {
    problem(`allow-list group ${repo} expired on ${group.expires}: review its findings and renew or remove it`)
  }
  for (const k of group.accept.filter((k) => !seen.get(repo).has(k))) {
    problem(`stale allow-list entry no longer found in ${repo}, delete it: ${k}`)
  }
}

const accepted = rows.reduce((n, r) => n + r.accepted, 0)
const total = rows.reduce((n, r) => n + r.total, 0)
console.log(`\n${images.length} image(s), ${total} fixable HIGH/CRITICAL finding(s), ${accepted} accepted, ${problems.length} problem(s).`)

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ['## Container CVE scan', '', '| Image | Fixable HIGH/CRITICAL | Accepted | New |', '| :--- | ---: | ---: | ---: |',
    ...rows.map((r) => `| \`${r.image}\` | ${r.total} | ${r.accepted} | ${r.fresh ? `**${r.fresh}**` : 0} |`), '']
  if (problems.length) md.push('### Problems', '', ...problems.map((p) => `- ${p}`), '')
  else md.push(`No fixable HIGH or CRITICAL finding outside \`${ALLOWLIST}\`.`, '')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'))
}
process.exitCode = problems.length ? 1 : 0
