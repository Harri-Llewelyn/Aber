#!/usr/bin/env node
/**
 * The development loop on a local k3d cluster: build, import, install, wait, test.
 *
 *   node scripts/dev-cluster.mjs up        create the cluster if absent, build and import the ten
 *                                          images, install or upgrade the chart, wait until the stack
 *                                          is consuming, run `helm test`
 *   node scripts/dev-cluster.mjs test      the stack lane and validate.py from the host, through
 *                                          port-forwards on the ports the suites default to
 *   node scripts/dev-cluster.mjs forward   open those port-forwards and hold them until Ctrl+C
 *   node scripts/dev-cluster.mjs reset     uninstall, drop every claim, reinstall -- a blank stack
 *                                          on the same cluster with the same images
 *   node scripts/dev-cluster.mjs status    what is running and where to reach it
 *   node scripts/dev-cluster.mjs down      delete the cluster
 *
 * Options:  --no-build          reuse the images already built (`up`)
 *           --only=a,b          build and import only these images (`up`)
 *           --no-tls            skip cert-manager, the broker's TLS listener and the databases' TLS (`up`)
 *           --e2e               also run the in-cluster conformance Jobs (`up`, `test`)
 *           --no-validate       skip validate.py, run the lane only (`test`)
 *           --filter=<text>     only suites whose path contains the text (`test`)
 *           --no-dns-check      run the lane on a machine where the Ingress hosts do not resolve;
 *                               every suite that follows one FAILS rather than skips, so pair it
 *                               with --filter and an override (`test`)
 *           --domain=<base>     the base domain of every host, default localhost: browsers treat
 *                               *.localhost as a secure context, which the Studio and forge
 *                               logins need over plain HTTP. Give <LAN address>.nip.io to reach
 *                               the stack from other machines, where the resolver answers nip.io
 *                               names with private addresses (many home routers refuse to, as
 *                               DNS-rebind protection); those two logins then need TLS (`up`).
 *                               Note that *.localhost is resolved by browsers and by
 *                               systemd-resolved, and by neither Python nor Node -- so the two
 *                               suites that follow an Ingress host need a hosts entry, an
 *                               override, or 127.0.0.1.nip.io (`test` says which, and refuses
 *                               to run rather than let them fail on DNS)
 *
 * It is the sequence CI's k8s-validation job runs, made repeatable on a laptop: the stack lane
 * reaches the cluster through port-forwards, and the suites that reach into containers use kubectl.
 *
 * Node rather than a shell script for the reason stack-reset.mjs gives: on Windows `npm` resolves
 * `bash` to WSL, where Docker is not available by default, and a loop that fails half-way through
 * a teardown is worse than none.
 */
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHART = 'deploy/helm/aber'
const CLUSTER = process.env.ABER_DEV_CLUSTER || 'aber'
const NS = process.env.ABER_DEV_NAMESPACE || 'aber'
const RELEASE = 'aber'
const IMG_NS = 'ghcr.io/harri-llewelyn/aber'
// The runbook's pin. cert-manager is cluster administration, installed once, not a chart dependency.
const CERT_MANAGER_VERSION = 'v1.16.2'

// Every image the chart names, tagged exactly as it pulls them: an empty `image.tag` resolves to
// Chart.appVersion, and any other name means the pod pulls the published image instead of this
// tree. Same list, same contexts, as the runbook and ci.yml.
const IMAGES = [
  { name: 'edge-runtime', file: 'supabase/functions/Dockerfile', context: '.' },
  { name: 'ingestion', file: 'ingestion/Dockerfile', context: '.' },
  { name: 'node-red', file: 'node-red/Dockerfile', context: 'node-red' },
  // VITE_APP_VERSION must be passed: the context is `frontend`, so vite.config.js has no .git to
  // read and the account menu reads "unknown". DESCRIBE, not VERSION -- the tag is Chart.appVersion,
  // which on a tree ahead of it would claim a release this bundle is not.
  { name: 'frontend', file: 'frontend/Dockerfile', context: 'frontend', args: ['VITE_RUNTIME_CONFIG=true', 'VITE_APP_VERSION=DESCRIBE'] },
  { name: 'i3x-service', file: 'i3x/Dockerfile', context: '.' },
  { name: 'gateway-credential', file: 'gateway-credential/Dockerfile', context: 'gateway-credential' },
  { name: 'backup-service', file: 'backup-service/Dockerfile', context: 'backup-service' },
  { name: 'db-init', file: 'supabase/db-init/Dockerfile', context: 'supabase' },
  // Carries docs/openapi.yaml and docs/i3x-openapi.yaml, so a spec edit needs this rebuild.
  { name: 'swagger-ui', file: 'swagger-ui/Dockerfile', context: '.' },
  // Extends the ingestion image, so it is built last and told which one.
  { name: 'test-runner', file: 'test-harness/Dockerfile', context: '.', args: [`INGESTION_IMAGE=${IMG_NS}/ingestion:VERSION`] },
]

// The host ports the suites default to, forwarded to the Services that stand behind them, so every
// host-side tool -- validate.py, the stack lane, the provisioning scripts -- keeps its defaults.
// MQTT is not here: the k3d load balancer publishes 1883 and 8883 when the cluster was created
// with those ports, and a forward is added below only when it was not. The two databases are
// relayed, a forward per connection: `openRelay` says why.
const FORWARDS = [
  { local: 5433, service: 'timescaledb', remote: 5432, what: 'historian', relay: true },
  { local: 54322, service: 'supabase-db', remote: 5432, what: 'Supabase Postgres', relay: true },
  { local: 54321, service: 'supabase-kong', remote: 8000, what: 'Supabase API (the gateway)' },
  { local: 54323, service: 'supabase-kong', remote: 8001, what: 'Studio, behind the gateway login' },
  { local: 3003, service: 'supabase-kong', remote: 8002, what: 'the forge, behind the gateway' },
  // The forge over SSH, which the appliance suites push to with a deploy key: the k3d load
  // balancer publishes 22 on the cluster network only.
  { local: 2222, service: 'gitea', remote: 22, what: 'the forge over SSH' },
  { local: 1880, service: 'node-red', remote: 1880, what: 'Node-RED' },
  { local: 3002, service: 'grafana', remote: 3000, what: 'Grafana' },
  { local: 3000, service: 'frontend', remote: 3000, what: 'the dashboard' },
  { local: 8090, service: 'i3x-service', remote: 8090, what: 'i3X' },
  { local: 8088, service: 'swagger-ui', remote: 8080, what: 'API docs' },
  { local: 9090, service: 'prometheus', remote: 9090, what: 'Prometheus' },
  { local: 3100, service: 'loki', remote: 3100, what: 'Loki' },
  { local: 9108, service: 'ingestion-metrics', remote: 9108, what: 'ingestion metrics' },
  { local: 12345, service: 'alloy', remote: 12345, what: 'Alloy' },
]
const MQTT_FORWARDS = [
  { local: 1883, service: 'mosquitto', remote: 1883, what: 'MQTT' },
  { local: 8883, service: 'mosquitto', remote: 8883, what: 'MQTTS', tlsOnly: true },
  { local: 9001, service: 'mosquitto', remote: 9001, what: 'MQTT over WebSockets' },
]

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`,
            green: s => `\x1b[32m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` }

const argv = process.argv.slice(2)
const command = argv.find(a => !a.startsWith('--')) || 'help'
const flag = name => argv.includes(`--${name}`)
const option = name => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

// ---------------------------------------------------------------------------------------------
// Process helpers. `run` streams, `capture` returns stdout, `must` stops the loop on failure with
// the command that failed on screen -- which is the only diagnostic most failures need.
// ---------------------------------------------------------------------------------------------
function run (cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit', ...opts })
}
// `run` without blocking the event loop, for a step that runs while this process is relaying
// the database forwards (`openRelay`); resolves like spawnSync's result.
function runAsync (cmd, args, opts = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: REPO, stdio: 'inherit', ...opts })
    child.on('error', error => resolve({ status: null, error }))
    child.on('exit', (status, signal) => resolve({ status, signal }))
  })
}
function capture (cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', ...opts })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
function must (cmd, args, why, opts = {}) {
  const r = run(cmd, args, opts)
  if (r.status !== 0) die(`${why}\n  ${cmd} ${args.join(' ')} exited ${r.status}`)
}
function die (message) {
  console.error(`\n${c.red('FAILED')} ${message}`)
  process.exit(1)
}
function step (title) {
  console.log(`\n${c.bold('==')} ${title}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const kubectl = (...args) => capture('kubectl', ['-n', NS, ...args])

function appVersion () {
  const chart = readFileSync(path.join(REPO, CHART, 'Chart.yaml'), 'utf8')
  const m = chart.match(/^appVersion:\s*"?([^"\s]+)"?/m)
  if (!m) die('Chart.yaml has no appVersion')
  return m[1]
}

/**
 * What this working tree calls itself, for the account menu -- the string `npm run dev` bakes.
 * Empty when git cannot answer, which the frontend renders as "unknown"; never fatal.
 */
function describeVersion () {
  return capture('git', ['describe', '--tags', '--always', '--dirty']).out
}

// ---------------------------------------------------------------------------------------------
// The cluster
// ---------------------------------------------------------------------------------------------
function preflight (tools) {
  for (const t of tools) {
    if (!capture(t, ['version', '--client'].slice(0, t === 'kubectl' ? 2 : 1)).ok && !capture(t, ['--version']).ok) {
      die(`${t} is not on PATH. The runbook's prerequisites: docker, k3d, kubectl, helm.`)
    }
  }
}

function clusterExists () {
  const r = capture('k3d', ['cluster', 'list', '-o', 'json'])
  if (!r.ok) return false
  return JSON.parse(r.out || '[]').some(cl => cl.name === CLUSTER)
}

function ensureCluster () {
  step(`cluster ${CLUSTER}`)
  if (clusterExists()) {
    console.log(`  exists`)
  } else {
    // Port 80 is Traefik; 1883 and 8883 are the broker's LoadBalancer, for appliances on the LAN.
    must('k3d', ['cluster', 'create', CLUSTER, '--agents', '0',
      '--port', '80:80@loadbalancer', '--port', '1883:1883@loadbalancer', '--port', '8883:8883@loadbalancer',
      '--k3s-arg', '--disable=metrics-server@server:0', '--wait'], 'k3d could not create the cluster')
  }
  // k3d writes the API endpoint as host.docker.internal on Windows and macOS, which some adapters
  // resolve to an address nothing answers on. Loopback always works: the port is published there.
  const port = capture('docker', ['port', `k3d-${CLUSTER}-serverlb`, '6443']).out.split(':').pop()
  if (port) capture('kubectl', ['config', 'set-cluster', `k3d-${CLUSTER}`, `--server=https://127.0.0.1:${port}`])
  capture('kubectl', ['config', 'use-context', `k3d-${CLUSTER}`])
  const nodes = capture('kubectl', ['get', 'nodes', '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}'])
  if (!nodes.ok || !nodes.out.includes('True')) die(`the cluster is not answering: ${nodes.err || nodes.out}`)
  console.log(`  context k3d-${CLUSTER}, API on 127.0.0.1:${port}`)
}

// The runbook's Traefik setting, applied the same way, so the dev loop measures the client address
// a site gets. k3s's helm controller redeploys Traefik with it; the Service changing is the signal.
async function ensureTraefikConfig () {
  step('Traefik keeps the client address')
  const policy = () => capture('kubectl', ['-n', 'kube-system', 'get', 'svc', 'traefik',
    '-o', 'jsonpath={.spec.externalTrafficPolicy}']).out
  must('kubectl', ['apply', '-f', 'deploy/k8s/traefik-config.yaml'], 'the Traefik HelmChartConfig did not apply')
  for (let i = 0; i < 60; i++) {
    if (policy() === 'Local') { console.log('  externalTrafficPolicy Local'); return }
    await sleep(3000)
  }
  die(`Traefik's Service is on externalTrafficPolicy ${policy() || '(none)'} after 3 minutes, not Local`)
}

function lbPublishes (port) {
  return capture('docker', ['port', `k3d-${CLUSTER}-serverlb`]).out.split('\n').some(l => l.startsWith(`${port}/tcp`))
}

function ensureCertManager () {
  step('cert-manager and the internal CA')
  const ready = () => capture('kubectl', ['get', 'clusterissuer', 'aber-ca',
    '-o', 'jsonpath={.status.conditions[?(@.type=="Ready")].status}']).out === 'True'
  if (ready()) { console.log('  ClusterIssuer aber-ca is Ready'); return }
  if (!capture('kubectl', ['get', 'namespace', 'cert-manager']).ok) {
    must('kubectl', ['apply', '-f',
      `https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml`],
    'cert-manager did not apply')
  }
  // The webhook validates every Certificate and ClusterIssuer; applying the CA before it answers
  // fails as `no endpoints available for service "cert-manager-webhook"`.
  must('kubectl', ['-n', 'cert-manager', 'wait', '--for=condition=Available', 'deployment', '--all', '--timeout=300s'],
    'cert-manager did not become available')
  must('kubectl', ['apply', '-f', 'deploy/k8s/internal-ca.yaml'], 'the internal CA did not apply')
  must('kubectl', ['-n', 'cert-manager', 'wait', '--for=condition=Ready', 'certificate/aber-ca', '--timeout=120s'],
    'the root certificate was not issued')
  must('kubectl', ['wait', '--for=condition=Ready', 'clusterissuer/aber-ca', '--timeout=120s'],
    'the ClusterIssuer did not become Ready')
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------
function buildImages (version, only) {
  const describe = describeVersion()
  step(`build ${only ? only.join(', ') : 'the ten images'} as ${IMG_NS}/<name>:${version}`)
  for (const img of IMAGES) {
    if (only && !only.includes(img.name)) continue
    const args = ['build', '-f', img.file, '-t', `${IMG_NS}/${img.name}:${version}`]
    // Substituted in the value, never the name: `VITE_APP_VERSION` ends in `VERSION`, so replacing
    // across the whole `NAME=value` rewrites the name itself, and Docker only warns at an
    // unrecognised --build-arg.
    for (const a of img.args || []) {
      const eq = a.indexOf('=')
      const value = a.slice(eq + 1).replace('VERSION', version).replace('DESCRIBE', describe)
      args.push('--build-arg', `${a.slice(0, eq)}=${value}`)
    }
    args.push(img.context)
    console.log(`  ${c.dim(`docker ${args.join(' ')}`)}`)
    must('docker', args, `the ${img.name} image did not build`)
  }
}

function imagesInNode () {
  return capture('docker', ['exec', `k3d-${CLUSTER}-server-0`, 'ctr', '-n', 'k8s.io', 'images', 'ls', '-q']).out
}

function importImages (version, only) {
  const names = IMAGES.map(i => i.name).filter(n => !only || only.includes(n))
  const refs = names.map(n => `${IMG_NS}/${n}:${version}`)
  step(`import ${names.length} image(s) into the cluster`)
  // Verified, not trusted: `k3d image import` can fail per node and still exit 0
  // (docs/incidents.md, "k3d image import reported success it did not achieve").
  for (let attempt = 1; attempt <= 3; attempt++) {
    run('k3d', ['image', 'import', '-c', CLUSTER, ...refs])
    const present = imagesInNode()
    const missing = refs.filter(r => !present.includes(r))
    if (!missing.length) { console.log(`  all ${refs.length} present in the node`); return }
    console.log(`  not in the node after attempt ${attempt}: ${missing.join(' ')}`)
  }
  die('the node does not hold every image; the cluster would pull the published ones instead')
}

/**
 * A rebuilt image keeps its tag, and a running pod keeps the image it started with, so after an
 * import the workloads that run a rebuilt image are restarted. Without this a code change is
 * built, imported and silently not running.
 */
function restartWorkloadsUsing (refs) {
  const r = kubectl('get', 'deploy,statefulset,daemonset', '-o', 'json')
  if (!r.ok) return
  const workloads = JSON.parse(r.out).items.filter(w =>
    (w.spec.template.spec.containers || []).concat(w.spec.template.spec.initContainers || [])
      .some(ct => refs.includes(ct.image)))
  if (!workloads.length) return
  step(`restart the workloads running a rebuilt image`)
  for (const w of workloads) {
    const kind = w.kind.toLowerCase()
    console.log(`  ${kind}/${w.metadata.name}`)
    run('kubectl', ['-n', NS, 'rollout', 'restart', `${kind}/${w.metadata.name}`], { stdio: 'ignore' })
  }
}

function assertImagesPresent (version) {
  const present = imagesInNode()
  const missing = IMAGES.map(i => `${IMG_NS}/${i.name}:${version}`).filter(r => !present.includes(r))
  if (missing.length) {
    die(`--no-build, but the node lacks ${missing.length} image(s):\n  ${missing.join('\n  ')}\n` +
        'Run without --no-build, or the pods pull the published images -- three of which do not exist.')
  }
}

// ---------------------------------------------------------------------------------------------
// The release
// ---------------------------------------------------------------------------------------------
/**
 * The address of the interface that carries the default route, learned without sending a packet:
 * connecting a UDP socket makes the kernel pick the source address it would use.
 */
function lanAddress () {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4')
    s.on('error', () => resolve(null))
    try {
      s.connect(53, '8.8.8.8', () => { const a = s.address().address; s.close(); resolve(a) })
    } catch { resolve(null) }
  }).then(a => a || Object.values(os.networkInterfaces()).flat()
    .find(i => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))?.address || null)
}

function releaseValues () {
  const r = capture('helm', ['get', 'values', RELEASE, '-n', NS, '-a', '-o', 'json'])
  return r.ok ? JSON.parse(r.out) : {}
}

/**
 * A secret the dev values leave empty, generated once and carried across upgrades: a value that
 * changed on every `up` would sign every appliance out of the forge sweep it was enrolled under.
 */
function keptSecret (key) {
  return releaseValues().secrets?.[key] || crypto.randomBytes(32).toString('hex')
}

async function installChart ({ tls, e2e }) {
  const domain = option('domain') || 'localhost'
  step(`helm upgrade --install ${RELEASE} on ${domain} (${tls ? 'broker TLS on' : 'no TLS'}${e2e ? ', e2e Jobs on' : ''})`)
  must('node', ['scripts/sync-helm-chart-files.mjs'], 'the chart files are not mirrored')
  if (!capture('kubectl', ['get', 'namespace', NS]).ok) must('kubectl', ['create', 'namespace', NS], 'namespace')
  const sets = ['--set', `global.publicBaseDomain=${domain}`,
    // The backup service (the dashboard's Backups page) and its nightly CronJob, taking
    // everything a full backup takes; the stack lane asserts on the set of components.
    '--set', 'backup.enabled=true', '--set', 'backupService.enabled=true',
    '--set', 'backup.includeStorage=true', '--set', 'backup.includeForge=true',
    '--set', 'backup.includeBroker=true',
    '--set', `secrets.forgeSweepSecret=${keptSecret('forgeSweepSecret')}`]
  // What an appliance is told to dial. The browser-facing hosts stay on the loopback domain, which
  // resolves on this machine whatever the resolver does; the two functions that hand an appliance
  // an address refuse loopback, so they get this machine's LAN address instead. An appliance
  // reaches the broker by that address (it is in the certificate); the API host it is given
  // resolves only where the resolver returns private nip.io answers.
  const ip = await lanAddress()
  if (ip) {
    sets.push('--set', `supabaseFunctions.gatewayEnrolment.mqttPublicHost=${ip}`,
      '--set', `supabaseFunctions.gatewayEnrolment.supabasePublicUrl=http://api.${ip}.nip.io`,
      // The model URL an exported shell carries: the same address, for the same reason.
      '--set', `supabaseFunctions.aas.modelPublicBase=http://api.${ip}.nip.io/storage/v1/object/public/asset-3d-models`)
    if (tls) sets.push('--set', `mosquitto.tls.extraIpSans={${ip}}`)
    console.log(`  appliances are told to dial ${ip}`)
  } else {
    console.log('  no LAN address found: enrolment stays unconfigured, as the dev values leave it')
  }
  // The broker's listener and both databases, from the one internal CA.
  if (tls) sets.push('--set', 'mosquitto.tls.enabled=true', '--set', 'postgresTls.enabled=true',
    // The CA the two listeners are issued from joins the backup (ensureCertManager names it).
    '--set', 'backup.ca.secretName=aber-ca-key-pair')
  if (e2e) {
    // The validate Job follows browser-facing URLs, which resolve to the pod itself under the dev
    // domain; hostAliases point them at Traefik instead.
    const ip = capture('kubectl', ['-n', 'kube-system', 'get', 'svc', 'traefik', '-o', 'jsonpath={.spec.clusterIP}']).out
    sets.push('--set', 'e2e.enabled=true', '--set', `e2e.ingressIp=${ip}`)
    // Plain Jobs, not hooks, and a Job's pod template is immutable: a completed run left in place
    // makes the next upgrade fail with `field is immutable` the moment their spec changes.
    run('kubectl', ['-n', NS, 'delete', 'job', `${RELEASE}-e2e-validate`, `${RELEASE}-e2e-aas-export`, '--ignore-not-found'])
  }
  // No --wait: Helm would block on workloads whose initContainers wait for the roles the
  // post-install hooks create. The hooks themselves are waited for regardless.
  must('helm', ['upgrade', '--install', RELEASE, CHART, '-n', NS, '-f', `${CHART}/values-dev.yaml`,
    ...sets, '--timeout', '15m'], 'helm did not install the release')
}

async function waitForStack () {
  step('wait for the init hooks')
  for (const job of ['db-roles-init', 'db-init', 'storage-init']) {
    must('kubectl', ['-n', NS, 'wait', '--for=condition=complete', `job/${RELEASE}-${job}`, '--timeout=10m'],
      `${job} did not complete`)
  }
  step('wait for every workload')
  const workloads = kubectl('get', 'statefulset,deploy,daemonset', '-o', 'name').out.split('\n').filter(Boolean)
  for (const w of workloads) {
    must('kubectl', ['-n', NS, 'rollout', 'status', w, '--timeout=10m'], `${w} did not roll out`)
  }
  step('wait for the ingestion daemon to be consuming')
  // Rolled out is not subscribed: the daemon connects and subscribes after its process starts, and
  // a suite that publishes before then fails a block of checks at once. Same gate as CI's.
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const r = kubectl('exec', 'deploy/ingestion', '-c', 'ingestion', '--', 'python', '-c',
      "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:9108/metrics',timeout=5).read().decode())")
    // COMPARED AS NUMBERS. A gauge's value is a float in the exposition format, so the same 1 is
    // spelled `1` by one exporter and `1.0` by another; matching the text made this wait depend on
    // which. It read `1.0` as "not subscribed" and timed out against a daemon that was.
    const up = Number(/^aber_ingestion_up (\S+)/m.exec(r.out)?.[1])
    const connected = Number(/^aber_ingestion_mqtt_connected (\S+)/m.exec(r.out)?.[1])
    if (up === 1 && connected === 1) { console.log('  subscribed'); return }
    await sleep(3000)
  }
  die('the ingestion daemon never reported itself subscribed (aber_ingestion_mqtt_connected)')
}

function helmTest () {
  step('helm test (the postgres_fdw gate)')
  must('helm', ['test', RELEASE, '-n', NS, '--timeout', '5m'], 'helm test failed')
}

// ---------------------------------------------------------------------------------------------
// Port-forwards
// ---------------------------------------------------------------------------------------------
function portOpen (port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.setTimeout(500, () => { s.destroy(); resolve(false) })
  })
}

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

function spawnForward (f, local) {
  return spawn('kubectl', ['-n', NS, 'port-forward', `svc/${f.service}`, `${local}:${f.remote}`],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
}

// Resolves true once kubectl reports the listener open, false if it exited or timed out first.
// Read from its stdout rather than probed: a probe is a connection the Service behind sees.
function forwardReady (child, ms = 15_000) {
  return new Promise(resolve => {
    let out = ''
    let settled = false
    const settle = ok => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok) } }
    const timer = setTimeout(() => settle(false), ms)
    child.stdout.on('data', d => { if (!settled) { out += d; if (out.includes('Forwarding from')) settle(true) } })
    child.on('exit', () => settle(false))
  })
}

// A libpq session over TLS ends with a Terminate message and then a TLS close_notify. The backend
// exits on the Terminate without reading the alert, the kernel answers the unread bytes with a
// reset, and containerd closes the whole port-forward session on that error: kubectl prints
// "lost connection to pod" and exits, with every other connection on that forward. So once
// postgresTls is on, a forward shared by a test run dies at its first disconnect. The database
// ports are relayed instead: each host connection gets a forward of its own, opened ahead of
// time, and a session that ends with a reset takes down only the forward it used. The relay
// runs on this process's event loop, so whatever runs while it is open must not block that
// loop: the suites run through `runAsync`, not `run`.
async function openRelay (f) {
  const WARM = 3
  const ready = []
  const waiting = []
  const live = new Set()
  let pending = 0
  let closed = false
  const prepare = async () => {
    pending++
    const port = await freePort()
    const child = spawnForward(f, port)
    live.add(child)
    child.on('exit', () => live.delete(child))
    const ok = await forwardReady(child)
    pending--
    if (!ok || closed) {
      child.kill()
      while (waiting.length && !pending) waiting.shift()(null)
      return
    }
    const fw = { child, port }
    if (waiting.length) waiting.shift()(fw); else ready.push(fw)
  }
  const fill = () => { while (!closed && ready.length + pending < WARM) prepare() }
  const take = () => {
    while (ready.length) { const fw = ready.shift(); if (fw.child.exitCode === null) return Promise.resolve(fw) }
    fill()
    return new Promise(resolve => waiting.push(resolve))
  }
  const handle = async client => {
    const fw = await take()
    fill()
    if (!fw) { client.destroy(); return }
    const up = net.connect({ host: '127.0.0.1', port: fw.port })
    const end = () => { client.destroy(); up.destroy(); fw.child.kill() }
    up.on('connect', () => { client.pipe(up); up.pipe(client) })
    for (const s of [client, up]) { s.on('error', end); s.on('close', end) }
    fw.child.on('exit', end)
  }
  const listen = host => new Promise((resolve, reject) => {
    const server = net.createServer({ pauseOnConnect: true }, handle)
    server.on('error', reject)
    server.listen(f.local, host, () => resolve(server))
  })
  // Both loopbacks, as kubectl itself listens: libpq tries ::1 first for `localhost`, and a
  // refused IPv6 connect costs two seconds on Windows.
  const servers = [await listen('127.0.0.1')]
  try { servers.push(await listen('::1')) } catch { /* no IPv6 loopback on this machine */ }
  fill()
  return { close: () => { closed = true; servers.forEach(s => s.close()); for (const ch of live) ch.kill() } }
}

async function openForwards ({ tls }) {
  const wanted = [...FORWARDS]
  for (const f of MQTT_FORWARDS) {
    if (f.tlsOnly && !tls) continue
    if (!lbPublishes(f.local)) wanted.push(f)
  }
  const handles = []
  const close = () => handles.forEach(h => h.close())
  const opened = []
  for (const f of wanted) {
    if (await portOpen(f.local)) {
      console.log(`  ${c.dim(`${f.local} is already listening on this machine; not forwarded (${f.what})`)}`)
      continue
    }
    if (f.relay) {
      handles.push(await openRelay(f))
    } else {
      const child = spawnForward(f, f.local)
      handles.push({ close: () => child.kill() })
      if (!(await forwardReady(child))) {
        close()
        die(`the port-forward for ${f.what} (${f.local} -> ${f.service}:${f.remote}) did not open`)
      }
    }
    opened.push(f)
  }
  return { opened, close }
}

function printForwards (opened) {
  for (const f of opened) console.log(`  127.0.0.1:${String(f.local).padEnd(6)} -> ${f.service}:${f.remote}  ${c.dim(f.what)}`)
}

// ---------------------------------------------------------------------------------------------
// The environment the host-side suites read
// ---------------------------------------------------------------------------------------------
function clusterSecrets () {
  const r = kubectl('get', 'secret', `${RELEASE}-secrets`, '-o', 'json')
  if (!r.ok) die(`could not read the release Secret: ${r.err}`)
  const data = JSON.parse(r.out).data || {}
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]))
}

function tlsEnabled () {
  return releaseValues().mosquitto?.tls?.enabled === true
}

// With postgresTls on, both databases refuse plaintext, so a host-side client through the
// port-forwards verifies them like an in-cluster one: libpq reads these two variables, and the
// certificate names `localhost` (values-dev.yaml). The CA comes from the issued Secret.
function dbTlsEnvironment () {
  if (releaseValues().postgresTls?.enabled !== true) return {}
  const r = kubectl('get', 'secret', 'supabase-db-tls', '-o', 'jsonpath={.data.ca\\.crt}')
  if (!r.ok || !r.out) die('postgresTls is on but the supabase-db-tls Secret holds no ca.crt yet; is the Certificate issued?')
  const file = path.join(os.tmpdir(), 'aber-db-ca.crt')
  writeFileSync(file, Buffer.from(r.out, 'base64'))
  return { PGSSLMODE: 'verify-full', PGSSLROOTCERT: file }
}

function testEnvironment () {
  // Every credential from the cluster's own Secret, so a cluster installed with other values
  // fails rather than passes with the dev ones; the suites carry their own defaults for the
  // non-secret settings. Then the topology: the forwards above, on the port numbers the suites
  // default to, except where a suite follows a browser-facing URL, which only the Ingress answers.
  const secrets = clusterSecrets()
  const domain = releaseValues().global?.publicBaseDomain || 'localhost'
  const modelBase = kubectl('get', 'deploy/supabase-functions', '-o',
    'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="AAS_MODEL_PUBLIC_BASE")].value}').out
  // READ OFF THE RUNNING DAEMON, not out of a values file. validate.py's check 15 asserts that the
  // primary host announced itself on `spBv1.0/STATE/<this>`, and asserting against anything other
  // than the value the daemon was actually given would make the check agree with itself.
  const primaryHostId = kubectl('get', 'deploy/ingestion', '-o',
    'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="PRIMARY_HOST_ID")].value}').out
  // Off the running daemon for the same reason: validate.py publishes under this group and the
  // gateway row it seeds carries it, so reading anything but what the daemon was given would let
  // the run exercise the deprecated single-argument resolution arm and still pass.
  const sparkplugGroup = kubectl('get', 'deploy/ingestion', '-o',
    'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="SPARKPLUG_GROUP")].value}').out
  return {
    ...process.env,
    ...secrets,
    KUBE_NAMESPACE: NS,
    HELM_RELEASE: RELEASE,
    DB_HOST: 'localhost', DB_PORT: '5433',
    TS_TEST_HOST: 'localhost', TS_TEST_PORT: '5433',
    SUPABASE_DB_HOST: 'localhost', SUPABASE_DB_PORT: '54322',
    SUPABASE_DB_PASSWORD: secrets.POSTGRES_PASSWORD,
    ...dbTlsEnvironment(),
    SUPABASE_URL: 'http://127.0.0.1:54321',
    MQTT_HOST: 'localhost', MQTT_PORT: '1883',
    MQTT_TEST_HOST: '127.0.0.1', MQTT_TEST_PORT: '1883',
    MQTT_USER: secrets.MQTT_VALIDATOR_USER, MQTT_PASSWORD: secrets.MQTT_VALIDATOR_PASSWORD,
    // validate.py signs in to the editor through its OAuth client, whose callback is the Ingress host.
    NODERED_BASE_URL: process.env.NODERED_BASE_URL || `http://nodered.${domain}`,
    // What the exporter embeds, so the suite's loopback judgement is made on the real value.
    AAS_MODEL_PUBLIC_BASE: modelBase,
    PRIMARY_HOST_ID: primaryHostId,
    SPARKPLUG_GROUP: sparkplugGroup,
    // The forge's door is an OAuth flow whose registered callback is the Ingress host.
    GITEA_TEST_URL: process.env.GITEA_TEST_URL || `http://git.${domain}`,
    // Where a suite that acts as an appliance clones and pushes from this host; the clone URL
    // enrolment hands out names the forge's own address, which only the cluster network reaches.
    GITEA_TEST_SSH: 'ssh://git@127.0.0.1:2222',
    LOKI_TEST_URL: 'http://127.0.0.1:3100',
    PROMETHEUS_TEST_URL: 'http://127.0.0.1:9090',
    // Skips would otherwise read as passes: here the seed and both stores are guaranteed.
    REQUIRE_SEEDED_ACCOUNTS: '1',
    REQUIRE_LOG_PIPELINE: '1',
    // values-dev.yaml runs the playback worker, so the replay suite has no reason to skip here
    // and every reason not to: a fully-skipped suite reports OK and exits 0.
    REQUIRE_PLAYBACK_REPLAY: '1',
    // The chart installs the forge, so an unreachable one here is a fault and not a configuration.
    // Without this the three forge suites skip as a class -- `OK (skipped=3)`, exit 0 -- and the
    // lane reports every suite passed while none of their assertions ran.
    REQUIRE_FORGE: '1',
  }
}

// A NAME IS NOT AN ADDRESS, and two of the variables above are names: the flows behind them are
// OAuth flows whose registered callback is the Ingress host, so a forward cannot stand in.
// `*.localhost` is resolved by browsers themselves and by systemd-resolved, and by neither Python's
// `getaddrinfo` nor Node's -- which is exactly why this stayed hidden, since a person opening the
// same URL sees it work. Without a resolver for those names the suites behind them fail on DNS, or,
// before #222, SKIPPED on it as a class in a run that still reported OK.
//
// EVERY INGRESS HOST, NOT JUST THE TWO NAMED ABOVE. The door's flow leaves those two: the gateway
// redirects to the OAuth authorize endpoint it is REGISTERED with, which is `api.<domain>`, a host
// no variable mentions. Checking only the variables would clear a machine the door still cannot run
// on. It is all-or-nothing anyway -- a resolver either answers the wildcard or it does not -- and
// the fix is one action either way. Taken from the cluster's own Ingress objects, as CI's hosts
// entry is, so neither can drift from the chart.
async function assertIngressHostsResolve () {
  const r = kubectl('get', 'ingress', '-o',
    'jsonpath={range .items[*]}{range .spec.rules[*]}{.host} {end}{end}')
  const hosts = [...new Set((r.out || '').split(/\s+/).filter(Boolean))]
  if (!hosts.length) return  // no Ingress: nothing follows a name, so nothing to check
  const unresolved = []
  for (const host of hosts) {
    try { await dns.lookup(host) } catch { unresolved.push(host) }
  }
  if (!unresolved.length) return
  const diagnosis =
    `the stack's own hostnames do not resolve from this process:\n` +
    unresolved.map(h => `  ${h}`).join('\n') + '\n\n' +
    'Browsers resolve *.localhost themselves; Python and Node do not, so the suites that follow\n' +
    'a browser-facing URL would fail on DNS rather than on anything they assert. Either:\n' +
    '  * bring the stack up with --domain=127.0.0.1.nip.io, which resolves everywhere and needs\n' +
    '    no privileges (the Studio and forge logins then need TLS -- see --domain above); or\n' +
    `  * add them to ${process.platform === 'win32'
        ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts'} against 127.0.0.1, which is what CI does:\n` +
    `      127.0.0.1 ${hosts.join(' ')}\n`
  // THE ESCAPE IS A FLAG, NOT AN ABSENCE. A subset of the lane is worth running on a machine where
  // neither fix is available -- overriding GITEA_TEST_URL to the forward covers every forge suite
  // except the door -- but it has to be asked for, and it has to say what is being given up.
  // `--no-dns-check` only lets the failures through; it does not make them quiet, because
  // REQUIRE_FORGE still stands and #222 is what quiet cost.
  if (!flag('no-dns-check')) {
    die(diagnosis + '\nOr pass --no-dns-check to run anyway, with:\n' +
        '  GITEA_TEST_URL=http://127.0.0.1:3003, which reaches the forge through the forward and\n' +
        '  covers every forge suite EXCEPT the door -- forge-membership follows the registered\n' +
        '  OAuth callback, so it needs the names whatever that is set to, and will fail here.')
  }
  console.warn(`\n${c.red('WARNING')} --no-dns-check: ${diagnosis}\n` +
               'Every suite that follows one of those names will FAIL, not skip. Use --filter.')
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------
async function up () {
  preflight(['docker', 'k3d', 'kubectl', 'helm'])
  const version = appVersion()
  const tls = !flag('no-tls')
  const only = option('only')?.split(',').map(s => s.trim()).filter(Boolean)
  if (only) {
    const unknown = only.filter(n => !IMAGES.some(i => i.name === n))
    if (unknown.length) die(`--only names no image: ${unknown.join(', ')}. Known: ${IMAGES.map(i => i.name).join(', ')}`)
  }
  ensureCluster()
  await ensureTraefikConfig()
  if (tls) ensureCertManager()
  if (flag('no-build')) {
    assertImagesPresent(version)
  } else {
    buildImages(version, only)
    importImages(version, only)
  }
  await installChart({ tls, e2e: flag('e2e') })
  if (!flag('no-build')) {
    restartWorkloadsUsing(IMAGES.filter(i => !only || only.includes(i.name)).map(i => `${IMG_NS}/${i.name}:${version}`))
  }
  await waitForStack()
  helmTest()
  if (flag('e2e')) await waitForE2e()
  status()
}

async function waitForE2e () {
  step('in-cluster conformance Jobs')
  for (const [job, timeoutS] of [['e2e-validate', 1200], ['e2e-aas-export', 900]]) {
    const name = `job/${RELEASE}-${job}`
    const deadline = Date.now() + timeoutS * 1000
    let outcome = 'timeout'
    while (Date.now() < deadline) {
      if (kubectl('get', name, '-o', 'jsonpath={.status.succeeded}').out === '1') { outcome = 'succeeded'; break }
      if (kubectl('get', name, '-o', 'jsonpath={.status.conditions[?(@.type=="Failed")].status}').out === 'True') { outcome = 'failed'; break }
      await sleep(10_000)
    }
    run('kubectl', ['-n', NS, 'logs', name, '--all-containers', '--tail=-1'])
    console.log(`  ${job}: ${outcome}`)
    if (outcome !== 'succeeded') die(`${job} ${outcome}`)
  }
}

async function test () {
  preflight(['kubectl', 'helm'])
  const tls = tlsEnabled()
  // The preflight before the forwards, so a machine that cannot run the lane says so without first
  // opening seventeen tunnels `die` would leave behind.
  await assertIngressHostsResolve()
  const env = testEnvironment()
  step('port-forwards')
  const forwards = await openForwards({ tls })
  printForwards(forwards.opened)
  const python = process.env.PYTHON || 'python'
  let failed = false
  try {
    if (!flag('no-validate')) {
      step('validate.py')
      const r = await runAsync(python, ['ingestion/validate.py'], { env })
      if (r.status !== 0) { failed = true; console.error(c.red('validate.py failed')) }
    }
    step('the stack lane')
    const args = ['scripts/run-python-suites.mjs', '--lane', 'stack']
    if (option('filter')) args.push('--filter', option('filter'))
    const r = await runAsync('node', args, { env })
    if (r.status !== 0) failed = true
    if (flag('e2e')) await waitForE2e()
  } finally {
    forwards.close()
  }
  if (failed) die('the stack did not pass')
  console.log(`\n${c.green('PASSED')} ${flag('no-validate') ? 'the stack lane' : 'validate.py and the stack lane'}` +
    `${option('filter') ? ` (filter ${option('filter')})` : ''}, against ${CLUSTER}`)
}

async function forward () {
  preflight(['kubectl'])
  step('port-forwards (Ctrl+C to close)')
  const forwards = await openForwards({ tls: tlsEnabled() })
  printForwards(forwards.opened)
  await new Promise(resolve => { process.on('SIGINT', resolve); process.on('SIGTERM', resolve) })
  forwards.close()
}

async function reset () {
  preflight(['kubectl', 'helm'])
  step(`reset: uninstall ${RELEASE}, drop every claim, reinstall`)
  run('helm', ['uninstall', RELEASE, '-n', NS, '--timeout', '10m'])
  // The chart keeps its claims on uninstall by design (helm.sh/resource-policy: keep); a reset is
  // the one time they go. The namespace goes with them so nothing else lingers either.
  run('kubectl', ['delete', 'namespace', NS, '--ignore-not-found', '--timeout=5m'])
  await installChart({ tls: !flag('no-tls'), e2e: flag('e2e') })
  await waitForStack()
  helmTest()
  status()
}

function down () {
  preflight(['k3d'])
  step(`delete cluster ${CLUSTER}`)
  must('k3d', ['cluster', 'delete', CLUSTER], 'k3d could not delete the cluster')
}

function status () {
  step('status')
  run('kubectl', ['-n', NS, 'get', 'pods', '-o', 'wide'])
  const base = releaseValues().global?.publicBaseDomain || 'localhost'
  console.log(`
  dashboard  http://app.${base}/         Grafana   http://grafana.${base}/  (admin/admin)
  API        http://api.${base}/         Node-RED  http://nodered.${base}/
  forge      http://git.${base}/         docs      http://docs.${base}/
  MQTT       ${lbPublishes(1883) ? '127.0.0.1:1883' : 'not published by the load balancer; `forward` opens it'}
  next       node scripts/dev-cluster.mjs test | forward | reset | down`)
}

function help () {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('\n').slice(2)
    .map(l => l.replace(/^ \* ?/, '')).join('\n'))
}

if (!existsSync(path.join(REPO, CHART, 'Chart.yaml'))) die('run from the repository checkout')
const commands = { up, test, forward, reset, down, status, help }
if (!commands[command]) die(`unknown command ${command}; one of ${Object.keys(commands).join(', ')}`)
await commands[command]()
