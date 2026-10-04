#!/usr/bin/env node
/**
 * The HTTP surface as a browser meets it, with OWASP ZAP's baseline scan: the response headers,
 * cookies and CORS of every host the release's Ingress serves. ZAP spiders each host for a minute
 * and reports passively; it sends nothing a browser would not. Each finding is keyed by host label
 * and ZAP alert reference (`app 10038-1`); one accepted after review is listed in
 * scripts/lint/http-allowlist.json with its reason, and anything else at Low or above fails.
 *
 *   node scripts/scan-http.mjs [--cluster=aber] [--namespace=aber] [--context=NAME]
 *
 * Needs a running stack and Docker. ZAP runs on the k3d cluster's Docker network with every Ingress
 * host resolved to the cluster's load balancer, so the Host header and the sign-in redirects
 * between hosts are the real ones. A host that produces no report fails the scan: silence is not
 * a clean result.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'zaproxy/zap-stable:2.17.0@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef'
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const slash = (p) => p.replace(/\\/g, '/')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const CLUSTER = arg('cluster', process.env.ABER_DEV_CLUSTER || 'aber')
const NAMESPACE = arg('namespace', 'aber')
const CONTEXT = arg('context', null)

function run (cmd, args) {
  return spawnSync(cmd, args, { env, encoding: 'utf8', maxBuffer: 1 << 28 })
}
function die (message) {
  console.error(message)
  process.exit(2)
}

// Every host the Ingress routes, with its scheme: https where the Ingress terminates TLS for it.
const ingress = run('kubectl', [...(CONTEXT ? ['--context', CONTEXT] : []), '-n', NAMESPACE, 'get', 'ingress', '-o', 'json'])
if (ingress.status !== 0) die(`kubectl could not list the Ingress in ${NAMESPACE}:\n${ingress.stderr}`)
const items = JSON.parse(ingress.stdout).items
const tlsHosts = new Set(items.flatMap((i) => (i.spec.tls || []).flatMap((t) => t.hosts || [])))
const hosts = [...new Set(items.flatMap((i) => (i.spec.rules || []).map((r) => r.host).filter(Boolean)))]
if (hosts.length === 0) die(`The Ingress in ${NAMESPACE} routes no hosts.`)

// The load balancer's address on the cluster's own network.
const network = `k3d-${CLUSTER}`
const inspect = run('docker', ['inspect', `k3d-${CLUSTER}-serverlb`, '--format', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`])
const address = inspect.stdout.trim()
if (inspect.status !== 0 || !address) die(`No load balancer k3d-${CLUSTER}-serverlb on ${network}; is the cluster up?`)

const allow = JSON.parse(readFileSync(join(REPO, 'scripts/lint/http-allowlist.json'), 'utf8'))
const label = (host) => host.split('.')[0]
const addHosts = hosts.flatMap((h) => ['--add-host', `${h}:${address}`])

const work = mkdtempSync(join(tmpdir(), 'scan-http-'))
chmodSync(work, 0o777) // ZAP writes its report as uid 1000.
try {
  const findings = []
  const scanned = new Set()
  console.log(`Scanning ${hosts.length} host(s) through ${address} on ${network}`)
  for (const host of hosts) {
    const name = label(host)
    if (name in allow.hosts) {
      console.log(`  ${host}: skipped, ${allow.hosts[name]}`)
      continue
    }
    const scheme = tlsHosts.has(host) ? 'https' : 'http'
    const r = run('docker', ['run', '--rm', '--network', network, ...addHosts, '-v', `${slash(work)}:/zap/wrk:rw`,
      IMAGE, 'zap-baseline.py', '-t', `${scheme}://${host}/`, '-J', `${name}.json`, '-m', '1', '-I'])
    const report = join(work, `${name}.json`)
    if (!existsSync(report)) die(`ZAP produced no report for ${host}:\n${(r.stdout + r.stderr).slice(-1500)}`)
    scanned.add(name)
    let count = 0
    for (const site of JSON.parse(readFileSync(report, 'utf8')).site || []) {
      for (const a of site.alerts) {
        if (Number(a.riskcode) < 1) continue
        findings.push({ key: `${name} ${a.alertRef}`, risk: a.riskdesc.split(' ')[0], title: a.alert })
        count++
      }
    }
    console.log(`  ${scheme}://${host}/: ${count} finding(s) at Low or above`)
  }

  const keys = new Set(findings.map((f) => f.key))
  const fresh = findings.filter((f) => !(f.key in allow.findings))
  for (const f of fresh) console.log(`  NEW   ${f.risk} ${f.key}\n        ${f.title}`)
  for (const k of Object.keys(allow.findings).filter((k) => scanned.has(k.split(' ')[0]) && !keys.has(k))) {
    console.log(`  stale allow-list entry no longer found, delete it: ${k}`)
  }
  console.log(`\n${findings.length} finding(s) at Low or above, ${findings.length - fresh.length} reviewed, ${fresh.length} new.`)
  process.exitCode = fresh.length ? 1 : 0
} finally {
  rmSync(work, { recursive: true, force: true })
}
