#!/usr/bin/env node
/**
 * Misconfiguration in what the chart renders and in the Dockerfiles this repository builds, with
 * `trivy config`: no security context, a writable root filesystem, root users, host mounts. Each
 * finding is keyed by check and resource; one accepted after review is listed in
 * scripts/lint/config-allowlist.json with its reason, and anything else at HIGH or above fails.
 *
 *   node scripts/scan-config.mjs
 *
 * The chart is rendered from values-prod.yaml.example, the shape a site deploys, with placeholder
 * values for the keys that example leaves to the site. Needs helm and Docker.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969'
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const slash = (p) => p.replace(/\\/g, '/')

// A finding's stable identity: the check and the resource, never a line number.
export function keyOf (id, target, message) {
  const m = message.match(/^Container '([^']+)' of (\w+) '([^']+)'/)
    || message.match(/^(container|pod) (\S+) in \S+ namespace/)
    || message.match(/^(ConfigMap) '([^']+)'/)
    || message.match(/^(daemonset|deployment|statefulset) (\S+) in/i)
  if (id.startsWith('DS-')) return `${id} ${target}`
  if (m && m.length === 4) return `${id} ${m[2]}/${m[3]} container/${m[1]}`
  if (m) return `${id} ${m[1]}/${m[2]}`
  return `${id} ${target} ${message}`
}

function trivy (label, args, mounts) {
  const r = spawnSync('docker', ['run', '--rm', '-v', 'trivy-cache:/root/.cache/trivy', ...mounts, IMAGE,
    'config', ...args, '--severity', 'HIGH,CRITICAL', '--format', 'json', '--quiet'],
  { env, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.status !== 0 || !r.stdout.trim()) {
    console.error(`trivy (${label}) did not run:\n${(r.stderr || '').slice(-1500)}`)
    process.exit(2)
  }
  const report = JSON.parse(r.stdout)
  const out = []
  for (const res of report.Results || []) {
    for (const m of res.Misconfigurations || []) {
      out.push({ key: keyOf(m.ID, res.Target.replace(/^\/(repo|scan)\//, ''), m.Message), severity: m.Severity, title: m.Title })
    }
  }
  console.log(`  ${label}: ${(report.Results || []).length} file(s) scanned, ${out.length} finding(s)`)
  return out
}

const work = mkdtempSync(join(tmpdir(), 'scan-config-'))
try {
  const render = spawnSync('helm', ['template', 'aber', join(REPO, 'deploy/helm/aber'),
    '-f', join(REPO, 'deploy/helm/aber/values-prod.yaml.example'),
    '--set', 'secrets.existingSecret=scan-config', '--set', 'ingestion.primaryHostId=scan-config',
    '--set', 'ingestion.sparkplugGroup=scan-config'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (render.status !== 0) {
    console.error(`helm template failed:\n${render.stderr}`)
    process.exit(2)
  }
  writeFileSync(join(work, 'rendered.yaml'), render.stdout)

  console.log('Scanning configuration')
  const findings = [
    ...trivy('rendered chart', ['/scan/rendered.yaml'], ['-v', `${slash(work)}:/scan:ro`]),
    ...trivy('Dockerfiles', ['/repo', '--misconfig-scanners', 'dockerfile',
      '--skip-dirs', '/repo/frontend/node_modules', '--skip-dirs', '/repo/.cache', '--skip-dirs', '/repo/node_modules'],
    ['-v', `${slash(REPO)}:/repo:ro`]),
  ]

  const allow = JSON.parse(readFileSync(join(REPO, 'scripts/lint/config-allowlist.json'), 'utf8'))
  const keys = new Set(findings.map((f) => f.key))
  const fresh = findings.filter((f) => !(f.key in allow))
  for (const f of fresh) console.log(`  NEW   ${f.severity} ${f.key}\n        ${f.title}`)
  for (const k of Object.keys(allow).filter((k) => !keys.has(k))) {
    console.log(`  stale allow-list entry no longer found, delete it: ${k}`)
  }
  console.log(`\n${findings.length} finding(s) at HIGH or above, ${findings.length - fresh.length} reviewed, ${fresh.length} new.`)
  process.exitCode = fresh.length ? 1 : 0
} finally {
  rmSync(work, { recursive: true, force: true })
}
