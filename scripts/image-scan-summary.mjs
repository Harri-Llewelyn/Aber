#!/usr/bin/env node
/**
 * The known-CVE summary a release's chart carries, built from the Trivy JSON reports release.yml
 * keeps: per image reference, the fixable CRITICAL and HIGH findings, when it was scanned and the
 * date of the vulnerability database the scan used. db-init writes it into directory_services, and
 * the Directory shows it beside each version.
 *
 *   node scripts/image-scan-summary.mjs --reports <dir> --version <V> --out <file>
 *   node scripts/image-scan-summary.mjs --check <chart directory or packaged .tgz>
 *
 * The first walks <dir>: every `*.json` but `trivy-version.json` is a report, and the
 * `trivy-version.json` in its own directory dates its database. A report whose ArtifactName is a
 * path scanned an image this repository built from its OCI layout, named for the image; its
 * reference is ghcr.io/harri-llewelyn/aber/<name>:<V>. An image built FROM a third-party product
 * under Aber's tag also gets that product's version, read from its Dockerfile.
 *
 * The second fails unless the chart's files/image-scans.json has an entry for exactly the images a
 * full render of that chart names, so a release cannot ship a summary that leaves a row unscanned.
 */
import { gunzipSync } from 'node:zlib'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findingsOf, renderedImages } from './scan-images.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NAMESPACE = 'ghcr.io/harri-llewelyn/aber'
const SUMMARY_FILE = 'files/image-scans.json'

// Images this repository builds FROM a third-party product and tags with Aber's version. The
// Directory shows the product's version for these, which is the tag of the Dockerfile's last FROM.
const UPSTREAM = {
  'node-red': 'node-red/Dockerfile',
  'swagger-ui': 'swagger-ui/Dockerfile',
  'timescaledb': 'timescaledb/Dockerfile',
  'supabase-db': 'supabase/db/Dockerfile',
}

const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  return at === -1 ? null : argv[at + 1] || null
}
const die = (message) => {
  console.error(message)
  process.exit(2)
}

function upstreamVersion (name) {
  const file = UPSTREAM[name]
  if (!file) return null
  const froms = [...readFileSync(join(REPO, file), 'utf8').matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1])
  const ref = (froms.at(-1) || '').split('@')[0]
  const colon = ref.lastIndexOf(':')
  if (colon <= ref.lastIndexOf('/')) die(`${file}'s last FROM (${ref || 'none'}) names no tag to read a version from`)
  return ref.slice(colon + 1)
}

function walk (dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function summarise (reportsDir, version, out) {
  if (!/^\d+\.\d+\.\d+/.test(version || '')) die(`--version needs the release's version, not ${version}`)
  const images = {}
  const files = walk(reportsDir).filter((f) => f.endsWith('.json') && basename(f) !== 'trivy-version.json')
  if (!files.length) die(`no Trivy report under ${reportsDir}`)
  let scanner = null

  for (const file of files.sort()) {
    const dbFile = join(dirname(file), 'trivy-version.json')
    if (!existsSync(dbFile)) die(`${file} has no trivy-version.json beside it to date its database`)
    const trivy = JSON.parse(readFileSync(dbFile, 'utf8'))
    const report = JSON.parse(readFileSync(file, 'utf8'))
    const name = String(report.ArtifactName || '')
    const built = /^(\/|[A-Za-z]:[\\/])/.test(name)
    const ref = built ? `${NAMESPACE}/${basename(name)}:${version}` : name
    if (!ref) die(`${file} names no image`)
    if (images[ref]) die(`two reports for ${ref}`)
    const scannedAt = Date.parse(report.CreatedAt)
    const dbAt = Date.parse(trivy.VulnerabilityDB?.UpdatedAt)
    if (Number.isNaN(scannedAt) || Number.isNaN(dbAt)) die(`${file} has no scan time or database date`)

    const severities = [...findingsOf(report).values()].map((f) => f.severity)
    images[ref] = {
      critical: severities.filter((s) => s === 'CRITICAL').length,
      high: severities.filter((s) => s === 'HIGH').length,
      scanned_at: new Date(scannedAt).toISOString(),
      vulnerability_db_at: new Date(dbAt).toISOString(),
    }
    const upstream = built ? upstreamVersion(basename(name)) : null
    if (upstream) images[ref].upstream = upstream
    scanner = scanner || trivy.Version
  }

  const sorted = Object.fromEntries(Object.keys(images).sort().map((k) => [k, images[k]]))
  mkdirSync(dirname(resolve(out)), { recursive: true })
  writeFileSync(out, `${JSON.stringify({ release: version, scanner: `Trivy ${scanner}`, images: sorted }, null, 2)}\n`)
  console.log(`Wrote ${out}: ${Object.keys(sorted).length} image(s).`)
}

/** One file out of a gzipped tar, or null. Helm packages with plain ustar headers. */
function fromTgz (tgz, suffix) {
  const tar = gunzipSync(readFileSync(tgz))
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512)
    if (header.every((b) => b === 0)) break
    const field = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '')
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/')
    const size = parseInt(field(124, 136).trim() || '0', 8)
    if (name.endsWith(`/${suffix}`)) return tar.subarray(at + 512, at + 512 + size).toString('utf8')
    at += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

function check (chart) {
  const text = chart.endsWith('.tgz')
    ? fromTgz(chart, SUMMARY_FILE)
    : (existsSync(join(chart, SUMMARY_FILE)) ? readFileSync(join(chart, SUMMARY_FILE), 'utf8') : null)
  if (!text) die(`${chart} carries no ${SUMMARY_FILE}`)
  const summary = JSON.parse(text)
  const entries = summary.images || {}
  const rendered = renderedImages({ chart, own: true })
  const problems = [
    ...rendered.filter((i) => !entries[i]).map((i) => `${i} runs in the chart and has no scan`),
    ...Object.keys(entries).filter((i) => !rendered.includes(i)).map((i) => `${i} has a scan and the chart does not run it`),
    ...Object.entries(entries)
      .filter(([, e]) => !Number.isInteger(e.critical) || !Number.isInteger(e.high)
        || Number.isNaN(Date.parse(e.scanned_at)) || Number.isNaN(Date.parse(e.vulnerability_db_at)))
      .map(([i]) => `${i}'s entry lacks a count, a scan time or a database date`),
  ]

  const rows = Object.entries(entries).map(([i, e]) =>
    `| \`${i}\` | ${e.critical} | ${e.high} | ${String(e.scanned_at).slice(0, 10)} | ${String(e.vulnerability_db_at).slice(0, 10)} | ${e.upstream || ''} |`)
  console.log(`${chart}: ${Object.keys(entries).length} scanned image(s), ${rendered.length} in the chart, ${problems.length} problem(s).`)
  for (const p of problems) console.log(`  ${p}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `### Known CVEs the chart carries (${summary.scanner || 'Trivy'})`, '',
      '| Image | Fixable CRITICAL | Fixable HIGH | Scanned | Database | Upstream |',
      '| :--- | ---: | ---: | :--- | :--- | :--- |', ...rows, '', ''].join('\n'))
  }
  process.exitCode = problems.length ? 1 : 0
}

if (option('--check')) {
  check(option('--check'))
} else if (option('--reports') && option('--out')) {
  summarise(option('--reports'), option('--version'), option('--out'))
} else {
  die('usage: image-scan-summary.mjs --reports <dir> --version <V> --out <file> | --check <chart>')
}
