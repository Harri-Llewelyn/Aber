#!/usr/bin/env node
/**
 * Misconfiguration in what the chart renders and in the Dockerfiles this repository builds, with
 * `trivy config`: no security context, a writable root filesystem, root users, host mounts. Each
 * finding is keyed by check and resource; one accepted after review is listed in
 * scripts/lint/config-allowlist.json with its reason, and anything else at HIGH or above fails.
 *
 *   node scripts/scan-config.mjs
 *
 * The chart is rendered twice from values-prod.yaml.example, with placeholder values for the keys
 * that example leaves to the site: once as a site deploys it, and once with
 * scripts/lint/config-scan-every-workload.yaml on top, which turns on every workload the example
 * leaves off. Each finding names the render it came from. Needs helm and Docker.
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

const PROD = join(REPO, 'deploy/helm/aber/values-prod.yaml.example')
const RENDERS = [
  { label: 'as a site deploys it', file: 'site.yaml', values: [PROD] },
  { label: 'every workload on', file: 'every-workload.yaml', values: [PROD, join(REPO, 'scripts/lint/config-scan-every-workload.yaml')] },
]

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

// One trivy run: the files it read, relative to the mount, and each finding with its file.
function trivy (label, args, mounts) {
  const r = spawnSync('docker', ['run', '--rm', '-v', 'trivy-cache:/root/.cache/trivy', ...mounts, IMAGE,
    'config', ...args, '--severity', 'HIGH,CRITICAL', '--format', 'json', '--quiet'],
  { env, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.status !== 0 || !r.stdout.trim()) {
    console.error(`trivy (${label}) did not run:\n${(r.stderr || '').slice(-1500)}`)
    process.exit(2)
  }
  const report = JSON.parse(r.stdout)
  const targets = []
  const out = []
  for (const res of report.Results || []) {
    const target = res.Target.replace(/^\/(repo|scan)\//, '')
    targets.push(target)
    for (const m of res.Misconfigurations || []) {
      out.push({ key: keyOf(m.ID, target, m.Message), target, severity: m.Severity, title: m.Title })
    }
  }
  return { targets, findings: out }
}

const work = mkdtempSync(join(tmpdir(), 'scan-config-'))
try {
  for (const r of RENDERS) {
    const render = spawnSync('helm', ['template', 'aber', join(REPO, 'deploy/helm/aber'),
      ...r.values.flatMap((v) => ['-f', v]),
      '--set', 'secrets.existingSecret=scan-config', '--set', 'ingestion.primaryHostId=scan-config',
      '--set', 'ingestion.sparkplugGroup=scan-config'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    if (render.status !== 0) {
      console.error(`helm template (${r.label}) failed:\n${render.stderr}`)
      process.exit(2)
    }
    writeFileSync(join(work, r.file), render.stdout)
  }

  console.log('Scanning configuration')
  // Both renders in one run: trivy's start-up, loading its checks, is most of a run's time. The
  // renders are manifests, so only the kubernetes scanner reads them.
  const chart = trivy('rendered chart', ['/scan', '--misconfig-scanners', 'kubernetes'], ['-v', `${slash(work)}:/scan:ro`])
  for (const r of RENDERS) {
    if (!chart.targets.includes(r.file)) {
      console.error(`trivy read no ${r.file} (the chart ${r.label}); that is not a pass.`)
      process.exit(2)
    }
    console.log(`  chart, ${r.label}: ${chart.findings.filter((f) => f.target === r.file).length} finding(s)`)
  }
  const images = trivy('Dockerfiles', ['/repo', '--misconfig-scanners', 'dockerfile',
    '--skip-dirs', '/repo/frontend/node_modules', '--skip-dirs', '/repo/.cache', '--skip-dirs', '/repo/node_modules'],
  ['-v', `${slash(REPO)}:/repo:ro`])
  console.log(`  Dockerfiles: ${images.targets.length} file(s) scanned, ${images.findings.length} finding(s)`)

  // One entry per key, however many renders raise it, naming the renders that do in their order.
  const labelOf = new Map(RENDERS.map((r) => [r.file, `chart, ${r.label}`]))
  const byRender = RENDERS.flatMap((r) => chart.findings.filter((f) => f.target === r.file))
  const byKey = new Map()
  for (const f of [...byRender, ...images.findings]) {
    const seen = byKey.get(f.key) ?? { ...f, where: [] }
    const where = labelOf.get(f.target) ?? f.target
    if (!seen.where.includes(where)) seen.where.push(where)
    byKey.set(f.key, seen)
  }
  const findings = [...byKey.values()]

  const allow = JSON.parse(readFileSync(join(REPO, 'scripts/lint/config-allowlist.json'), 'utf8'))
  const fresh = findings.filter((f) => !(f.key in allow))
  for (const f of fresh) console.log(`  NEW   ${f.severity} ${f.key}\n        ${f.title}\n        in: ${f.where.join('; ')}`)
  for (const k of Object.keys(allow).filter((k) => !byKey.has(k))) {
    console.log(`  stale allow-list entry no longer found, delete it: ${k}`)
  }
  console.log(`\n${findings.length} finding(s) at HIGH or above, ${findings.length - fresh.length} reviewed, ${fresh.length} new.`)
  process.exitCode = fresh.length ? 1 : 0
} finally {
  rmSync(work, { recursive: true, force: true })
}
