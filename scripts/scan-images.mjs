#!/usr/bin/env node
/**
 * Fixable HIGH and CRITICAL vulnerabilities in the third-party images the chart runs, with `trivy
 * image`. The image list is rendered out of the chart, never written here; the images this
 * repository builds are left out because release.yml scans each one before pushing it. A finding
 * accepted after review is listed in scripts/lint/image-allowlist.json under its image repository,
 * in a group with a reason and an expiry date. Anything else fails, and so do a group on or past
 * its expiry date and an entry that no longer matches a finding.
 *
 *   node scripts/scan-images.mjs [--trivy-binary] [--reports <dir>]
 *
 * Trivy runs as the pinned container scan:config uses, with the trivy-cache volume; with
 * --trivy-binary, or under GitHub Actions, it runs the `trivy` on PATH, which install-trivy pins to
 * the same release. Images are read from their registry. Needs helm, and Docker unless
 * --trivy-binary. Writes a Markdown summary to $GITHUB_STEP_SUMMARY when that is set.
 *
 * --reports <dir> also keeps each image's Trivy JSON report in <dir>, with the vulnerability
 * database the scan used in trivy-version.json. release.yml keeps them for the summary the chart
 * ships (scripts/image-scan-summary.mjs). Exit codes: 1 for a problem above, 2 for an image Trivy
 * could not scan or a chart that rendered too few images.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969'
const ALLOWLIST = 'scripts/lint/image-allowlist.json'
const OWN = 'ghcr.io/harri-llewelyn/'
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }

// The repository an allow-list group is keyed by: the reference without its tag or digest.
function repositoryOf (ref) {
  const bare = ref.split('@')[0]
  const slash = bare.lastIndexOf('/')
  const colon = bare.lastIndexOf(':')
  return colon > slash ? bare.slice(0, colon) : bare
}

/**
 * Every image a full render of `chart` names, with the optional workloads switched on so their
 * images are scanned too. The images this repository builds are left out unless `own`.
 */
export function renderedImages ({ chart = join(REPO, 'deploy/helm/aber'), own = false } = {}) {
  const render = spawnSync('helm', ['template', 'aber', chart,
    '-f', join(REPO, 'deploy/helm/aber/values-dev.yaml'),
    '--set', 'backup.enabled=true', '--set', 'backupService.enabled=true',
    '--set', 'playback.enabled=true', '--set', 'e2e.enabled=true'],
  { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (render.status !== 0) {
    console.error(`helm template failed:\n${render.stderr || render.error?.message}`)
    process.exit(2)
  }
  const images = new Set()
  for (const m of render.stdout.matchAll(/^\s+image:\s+"?([^"\s]+)/gm)) {
    if (own || !m[1].startsWith(OWN)) images.add(m[1])
  }
  // A scan that finds nothing to scan must not report success: if the render changes shape and the
  // pattern stops matching, silence would look exactly like "no vulnerabilities".
  if (images.size < 10) {
    console.error(`Only ${images.size} image(s) parsed out of the rendered chart, expected 10+.`)
    console.error('The parser has probably drifted from the chart\'s formatting.')
    process.exit(2)
  }
  return [...images].sort()
}

function trivy (args, binary) {
  return binary
    ? spawnSync('trivy', args, { env, encoding: 'utf8', maxBuffer: 1 << 28 })
    : spawnSync('docker', ['run', '--rm', '-v', 'trivy-cache:/root/.cache/trivy', IMAGE, ...args],
      { env, encoding: 'utf8', maxBuffer: 1 << 28 })
}

/**
 * One image's Trivy JSON report, as text. Fixable HIGH and CRITICAL only: an unfixed finding has
 * no version to move to, and failing on it would train everyone to ignore this scan.
 */
export function scanImage (image, { binary }) {
  const r = trivy(['image', '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', '--scanners', 'vuln',
    '--image-src', 'remote', '--timeout', '15m', '--format', 'json', '--quiet', image], binary)
  if (r.status !== 0 || !r.stdout.trim()) {
    console.error(`trivy did not scan ${image}:\n${(r.stderr || r.error?.message || '').slice(-1500)}`)
    process.exit(2)
  }
  return r.stdout
}

/** The vulnerability database the scans used, as `trivy version --format json` gives it. */
export function trivyVersion ({ binary }) {
  const r = trivy(['version', '--format', 'json'], binary)
  if (r.status !== 0 || !r.stdout.trim()) {
    console.error(`trivy version failed:\n${(r.stderr || r.error?.message || '').slice(-1500)}`)
    process.exit(2)
  }
  return r.stdout
}

/** A report's findings, one per vulnerability and package however many targets carry it. */
export function findingsOf (report) {
  const keys = new Map()
  for (const res of report.Results || []) {
    for (const v of res.Vulnerabilities || []) {
      const key = `${v.VulnerabilityID} ${v.PkgName}`
      if (!keys.has(key)) keys.set(key, { severity: v.Severity, fixed: v.FixedVersion, target: res.Target })
    }
  }
  return keys
}

function main () {
  const argv = process.argv.slice(2)
  const binary = argv.includes('--trivy-binary') || process.env.GITHUB_ACTIONS === 'true'
  const annotate = process.env.GITHUB_ACTIONS === 'true'
  const reportsAt = argv.indexOf('--reports')
  const reports = reportsAt === -1 ? null : argv[reportsAt + 1]
  if (reportsAt !== -1 && !reports) {
    console.error('--reports needs a directory')
    process.exit(2)
  }

  const problems = []
  const problem = (line) => {
    problems.push(line)
    console.log(annotate ? `::error::${line}` : `  ${line}`)
  }

  const images = renderedImages()
  if (reports) mkdirSync(reports, { recursive: true })

  const allow = JSON.parse(readFileSync(join(REPO, ALLOWLIST), 'utf8'))
  const today = new Date().toISOString().slice(0, 10)
  const rows = []
  const seen = new Map()

  console.log(`Scanning ${images.length} image(s) with ${binary ? 'the trivy on PATH' : IMAGE.split('@')[0]}`)
  for (const image of images) {
    const repo = repositoryOf(image)
    const group = allow[repo]
    const raw = scanImage(image, { binary })
    // One file per image; the reference itself is the report's ArtifactName.
    if (reports) writeFileSync(join(reports, `${image.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`), raw)
    const found = findingsOf(JSON.parse(raw))
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
  if (reports) writeFileSync(join(reports, 'trivy-version.json'), trivyVersion({ binary }))

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
}

// Run, unless imported for the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
