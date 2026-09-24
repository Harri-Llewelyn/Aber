#!/usr/bin/env node
/**
 * Static analysis of the source with Semgrep's community rulesets (p/default, p/security-audit), in
 * a pinned container with metrics off. Each finding is keyed by rule, file and the text of the line
 * it points at, so it survives unrelated edits; one accepted after review is listed in
 * scripts/lint/semgrep-allowlist.json with its reason, and anything else fails.
 *
 *   node scripts/scan-source.mjs
 *
 * Interim until the repository is public, when CodeQL's default setup is free (#387). Needs Docker
 * and network access to fetch the rulesets.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'semgrep/semgrep:1.140.0'

// The checkout, walked rather than listed through git: a worktree's .git names a host path the
// container cannot resolve, and Semgrep then scans nothing and reports success.
const r = spawnSync('docker', ['run', '--rm', '-v', `${REPO.replace(/\\/g, '/')}:/src:ro`, '-w', '/src', IMAGE,
  'semgrep', 'scan', '--config', 'p/default', '--config', 'p/security-audit', '--metrics', 'off',
  '--no-git-ignore', '--json', '--quiet',
  '--exclude', 'node_modules', '--exclude', '.cache', '--exclude', '*.generated.ts',
  '--exclude', 'coverage', '--exclude', 'dist',
  // Go templates, which no YAML parser reads; the rendered chart is scanned by scan-config.mjs.
  '--exclude', 'deploy/helm/aber/templates'],
{ encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
let report
try { report = JSON.parse(r.stdout) } catch {
  console.error(`semgrep did not produce a report:\n${(r.stderr || '').slice(-1500)}`)
  process.exit(2)
}
const scanned = report.paths?.scanned?.length ?? 0
if (!scanned) {
  console.error('semgrep scanned no files; that is not a pass.')
  process.exit(2)
}

const lineOf = (path, n) => {
  try { return readFileSync(join(REPO, path), 'utf8').split('\n')[n - 1]?.trim() ?? '' } catch { return '' }
}
export const keyOf = (ruleId, path, text) =>
  `${ruleId.split('.').pop()} ${path} ${createHash('sha256').update(text).digest('hex').slice(0, 12)}`

const findings = report.results.map((x) => ({
  key: keyOf(x.check_id, x.path, lineOf(x.path, x.start.line)),
  where: `${x.path}:${x.start.line}`,
  severity: x.extra.severity,
  message: (x.extra.message || '').split('\n')[0].slice(0, 160),
}))
const allow = JSON.parse(readFileSync(join(REPO, 'scripts/lint/semgrep-allowlist.json'), 'utf8'))
const keys = new Set(findings.map((f) => f.key))
const fresh = findings.filter((f) => !(f.key in allow))
for (const f of fresh) console.log(`  NEW   ${f.severity} ${f.where}\n        ${f.message}\n        key: ${f.key}`)
for (const k of Object.keys(allow).filter((k) => !keys.has(k))) console.log(`  stale allow-list entry no longer found, delete it: ${k}`)
console.log(`\n${scanned} files, ${report.errors.length} not parsed, ${findings.length} findings: `
  + `${findings.length - fresh.length} reviewed, ${fresh.length} new.`)
process.exit(fresh.length ? 1 : 0)
