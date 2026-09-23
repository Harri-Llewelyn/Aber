#!/usr/bin/env node
/**
 * Known vulnerabilities in what is pinned NOW: `npm audit` over frontend/package-lock.json and
 * pip-audit over the Python requirements files. Renovate answers a different question (what is
 * old). An advisory accepted after review goes in scripts/lint/dependency-allowlist.json under its
 * id, with the reason; anything else at `high` or above fails.
 *
 *   node scripts/audit-dependencies.mjs
 *
 * pip-audit runs in a pinned Python container, so nothing is installed on the host. Needs Docker
 * and network access to the advisory databases.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON_IMAGE = 'python:3.13-slim'
const PIP_AUDIT = 'pip-audit==2.9.0'
const REQUIREMENTS = ['ingestion/requirements.txt', 'i3x/requirements.txt']
const GATE = new Set(['high', 'critical'])

const allow = JSON.parse(readFileSync(resolve(REPO, 'scripts/lint/dependency-allowlist.json'), 'utf8'))
const findings = []
const scanned = {}

// npm: severity per advisory, by its GHSA id.
{
  // Dev dependencies included: the build is part of the supply chain too.
  const r = spawnSync('npm', ['audit', '--json'], {
    cwd: resolve(REPO, 'frontend'), encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 26,
  })
  const report = JSON.parse(r.stdout || '{}')
  scanned.npm = report.metadata?.dependencies?.total ?? 0
  if (!report.vulnerabilities || !scanned.npm) {
    console.error(`npm audit gave no report:\n${(r.stderr || r.stdout || '').slice(-1000)}`)
    process.exit(2)
  }
  for (const v of Object.values(report.vulnerabilities)) {
    for (const via of v.via) {
      if (typeof via !== 'object') continue
      const id = (via.url || '').split('/').pop() || via.title
      findings.push({ tool: 'npm', id, severity: via.severity, what: `${via.name} ${via.range}: ${via.title}` })
    }
  }
}

// pip-audit reports no severity, so every Python advisory is gated.
{
  const mounts = ['-v', `${REPO.replace(/\\/g, '/')}:/src:ro`]
  const args = REQUIREMENTS.flatMap((f) => ['-r', `/src/${f}`]).join(' ')
  const r = spawnSync('docker', ['run', '--rm', ...mounts, PYTHON_IMAGE, 'sh', '-c',
    `pip install -q --disable-pip-version-check ${PIP_AUDIT} >/dev/null && pip-audit ${args} --format json --progress-spinner off 2>/dev/null`],
  { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  let report
  try { report = JSON.parse(r.stdout) } catch {
    console.error(`pip-audit gave no report:\n${(r.stderr || r.stdout || '').slice(-1000)}`)
    process.exit(2)
  }
  scanned.pip = (report.dependencies || []).length
  if (!scanned.pip) {
    console.error('pip-audit scanned no dependencies; that is not a pass.')
    process.exit(2)
  }
  for (const dep of report.dependencies || []) {
    for (const v of dep.vulns || []) {
      findings.push({ tool: 'pip', id: v.id, severity: 'high', what: `${dep.name} ${dep.version}: fixed in ${v.fix_versions.join(', ') || 'no release'}` })
    }
  }
}

const unique = [...new Map(findings.map((f) => [`${f.tool}:${f.id}`, f])).values()]
const gated = unique.filter((f) => GATE.has(f.severity))
const fresh = gated.filter((f) => !(f.id in allow))
for (const f of unique) {
  const mark = f.id in allow ? 'allowed' : GATE.has(f.severity) ? 'NEW    ' : 'below  '
  console.log(`  ${mark} ${f.tool} ${f.severity.padEnd(8)} ${f.id}  ${f.what}`)
}
const stale = Object.keys(allow).filter((id) => !unique.some((f) => f.id === id))
for (const id of stale) console.log(`  stale   allow-list entry no longer reported, delete it: ${id}`)
console.log(`\n${scanned.npm} npm and ${scanned.pip} Python packages: ${unique.length} advisories, ${gated.length} at high or critical, ${fresh.length} not reviewed.`)
process.exit(fresh.length ? 1 : 0)
