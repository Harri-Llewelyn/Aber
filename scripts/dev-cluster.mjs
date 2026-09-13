#!/usr/bin/env node
/**
 * The development loop on a local k3d cluster: build, import, install, wait, test.
 *
 *   node scripts/dev-cluster.mjs up        create the cluster if absent, build and import the nine
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
 *           --no-tls            skip cert-manager and the broker's TLS listener (`up`)
 *           --e2e               also run the in-cluster conformance Jobs (`up`, `test`)
 *           --no-validate       skip validate.py, run the lane only (`test`)
 *           --filter=<text>     only suites whose path contains the text (`test`)
 *           --domain=<base>     the base domain of every host, default localhost: browsers treat
 *                               *.localhost as a secure context, which the Studio and forge
 *                               logins need over plain HTTP. Give <LAN address>.nip.io to reach
 *                               the stack from other machines, where the resolver answers nip.io
 *                               names with private addresses (many home routers refuse to, as
 *                               DNS-rebind protection); those two logins then need TLS (`up`)
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
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHART = 'deploy/helm/acs-cymru'
const CLUSTER = process.env.ACS_DEV_CLUSTER || 'acs-cymru'
const NS = process.env.ACS_DEV_NAMESPACE || 'acs-cymru'
const RELEASE = 'acs-cymru'
const IMG_NS = 'ghcr.io/harri-llewelyn/acs-cymru'
// The runbook's pin. cert-manager is cluster administration, installed once, not a chart dependency.
const CERT_MANAGER_VERSION = 'v1.16.2'

// Every image the chart names, tagged exactly as it pulls them: an empty `image.tag` resolves to
// Chart.appVersion, and any other name means the pod pulls the published image instead of this
// tree. Same list, same contexts, as the runbook and ci.yml.
const IMAGES = [
  { name: 'edge-runtime', file: 'supabase/functions/Dockerfile', context: '.' },
  { name: 'ingestion', file: 'ingestion/Dockerfile', context: '.' },
  { name: 'node-red', file: 'node-red/Dockerfile', context: 'node-red' },
  { name: 'frontend', file: 'frontend/Dockerfile', context: 'frontend', args: ['VITE_RUNTIME_CONFIG=true'] },
  { name: 'i3x-service', file: 'i3x/Dockerfile', context: '.' },
  { name: 'gateway-credential', file: 'gateway-credential/Dockerfile', context: 'gateway-credential' },
  { name: 'backup-service', file: 'backup-service/Dockerfile', context: 'backup-service' },
  { name: 'db-init', file: 'supabase/db-init/Dockerfile', context: 'supabase' },
  // Extends the ingestion image, so it is built last and told which one.
  { name: 'test-runner', file: 'test-harness/Dockerfile', context: '.', args: [`INGESTION_IMAGE=${IMG_NS}/ingestion:VERSION`] },
]

// The host ports the suites default to, forwarded to the Services that stand behind them, so every
// host-side tool -- validate.py, the stack lane, the provisioning scripts -- keeps its defaults.
// MQTT is not here: the k3d load balancer publishes 1883 and 8883 when the cluster was created
// with those ports, and a forward is added below only when it was not.
const FORWARDS = [
  { local: 5433, service: 'timescaledb', remote: 5432, what: 'historian' },
  { local: 54322, service: 'supabase-db', remote: 5432, what: 'Supabase Postgres' },
  { local: 54321, service: 'supabase-kong', remote: 8000, what: 'Supabase API (the gateway)' },
  { local: 54323, service: 'supabase-kong', remote: 8001, what: 'Studio, behind the gateway login' },
  { local: 3003, service: 'supabase-kong', remote: 8002, what: 'the forge, behind the gateway' },
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

function lbPublishes (port) {
  return capture('docker', ['port', `k3d-${CLUSTER}-serverlb`]).out.split('\n').some(l => l.startsWith(`${port}/tcp`))
}

function ensureCertManager () {
  step('cert-manager and the internal CA')
  const ready = () => capture('kubectl', ['get', 'clusterissuer', 'acs-cymru-ca',
    '-o', 'jsonpath={.status.conditions[?(@.type=="Ready")].status}']).out === 'True'
  if (ready()) { console.log('  ClusterIssuer acs-cymru-ca is Ready'); return }
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
  must('kubectl', ['-n', 'cert-manager', 'wait', '--for=condition=Ready', 'certificate/acs-cymru-ca', '--timeout=120s'],
    'the root certificate was not issued')
  must('kubectl', ['wait', '--for=condition=Ready', 'clusterissuer/acs-cymru-ca', '--timeout=120s'],
    'the ClusterIssuer did not become Ready')
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------
function buildImages (version, only) {
  step(`build ${only ? only.join(', ') : 'the nine images'} as ${IMG_NS}/<name>:${version}`)
  for (const img of IMAGES) {
    if (only && !only.includes(img.name)) continue
    const args = ['build', '-f', img.file, '-t', `${IMG_NS}/${img.name}:${version}`]
    for (const a of img.args || []) args.push('--build-arg', a.replace('VERSION', version))
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
  if (tls) sets.push('--set', 'mosquitto.tls.enabled=true')
  if (e2e) {
    // The validate Job follows browser-facing URLs, which resolve to the pod itself under the dev
    // domain; hostAliases point them at Traefik instead.
    const ip = capture('kubectl', ['-n', 'kube-system', 'get', 'svc', 'traefik', '-o', 'jsonpath={.spec.clusterIP}']).out
    sets.push('--set', 'e2e.enabled=true', '--set', `e2e.ingressIp=${ip}`)
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
    const up = /^acs_ingestion_up (\S+)/m.exec(r.out)?.[1]
    const connected = /^acs_ingestion_mqtt_connected (\S+)/m.exec(r.out)?.[1]
    if (up === '1' && connected === '1') { console.log('  subscribed'); return }
    await sleep(3000)
  }
  die('the ingestion daemon never reported itself subscribed (acs_ingestion_mqtt_connected)')
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

async function openForwards ({ tls }) {
  const wanted = [...FORWARDS]
  for (const f of MQTT_FORWARDS) {
    if (f.tlsOnly && !tls) continue
    if (!lbPublishes(f.local)) wanted.push(f)
  }
  const children = []
  const opened = []
  for (const f of wanted) {
    if (await portOpen(f.local)) {
      console.log(`  ${c.dim(`${f.local} is already listening on this machine; not forwarded (${f.what})`)}`)
      continue
    }
    const child = spawn('kubectl', ['-n', NS, 'port-forward', `svc/${f.service}`, `${f.local}:${f.remote}`],
      { cwd: REPO, stdio: 'ignore', windowsHide: true })
    children.push(child)
    const started = Date.now()
    while (!(await portOpen(f.local))) {
      if (child.exitCode !== null || Date.now() - started > 15_000) {
        children.forEach(ch => ch.kill())
        die(`the port-forward for ${f.what} (${f.local} -> ${f.service}:${f.remote}) did not open`)
      }
      await sleep(250)
    }
    opened.push(f)
  }
  return { children, opened, close: () => children.forEach(ch => ch.kill()) }
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

function testEnvironment () {
  // Every credential from the cluster's own Secret, so a cluster installed with other values
  // fails rather than passes with the dev ones; the suites carry their own defaults for the
  // non-secret settings. Then the topology: the forwards above, on the port numbers the suites
  // default to, except where a suite follows a browser-facing URL, which only the Ingress answers.
  const secrets = clusterSecrets()
  const domain = releaseValues().global?.publicBaseDomain || 'localhost'
  const modelBase = kubectl('get', 'deploy/supabase-functions', '-o',
    'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="AAS_MODEL_PUBLIC_BASE")].value}').out
  return {
    ...process.env,
    ...secrets,
    ACS_STACK: 'k8s',
    KUBE_NAMESPACE: NS,
    HELM_RELEASE: RELEASE,
    DB_HOST: 'localhost', DB_PORT: '5433',
    TS_TEST_HOST: 'localhost', TS_TEST_PORT: '5433',
    SUPABASE_DB_HOST: 'localhost', SUPABASE_DB_PORT: '54322',
    SUPABASE_DB_PASSWORD: secrets.POSTGRES_PASSWORD,
    SUPABASE_URL: 'http://127.0.0.1:54321',
    MQTT_HOST: 'localhost', MQTT_PORT: '1883',
    MQTT_TEST_HOST: '127.0.0.1', MQTT_TEST_PORT: '1883',
    MQTT_USER: secrets.MQTT_VALIDATOR_USER, MQTT_PASSWORD: secrets.MQTT_VALIDATOR_PASSWORD,
    // validate.py signs in to the editor through its OAuth client, whose callback is the Ingress host.
    NODERED_BASE_URL: `http://nodered.${domain}`,
    // What the exporter embeds, so the suite's loopback judgement is made on the real value.
    AAS_MODEL_PUBLIC_BASE: modelBase,
    // The forge's door is an OAuth flow whose registered callback is the Ingress host.
    GITEA_TEST_URL: `http://git.${domain}`,
    LOKI_TEST_URL: 'http://127.0.0.1:3100',
    PROMETHEUS_TEST_URL: 'http://127.0.0.1:9090',
    // Skips would otherwise read as passes: here the seed and both stores are guaranteed.
    REQUIRE_SEEDED_ACCOUNTS: '1',
    REQUIRE_LOG_PIPELINE: '1',
  }
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
  step('port-forwards')
  const forwards = await openForwards({ tls })
  printForwards(forwards.opened)
  const env = testEnvironment()
  const python = process.env.PYTHON || 'python'
  let failed = false
  try {
    if (!flag('no-validate')) {
      step('validate.py')
      const r = run(python, ['ingestion/validate.py'], { env })
      if (r.status !== 0) { failed = true; console.error(c.red('validate.py failed')) }
    }
    step('the stack lane')
    const args = ['scripts/run-python-suites.mjs', '--lane', 'stack']
    if (option('filter')) args.push('--filter', option('filter'))
    const r = run('node', args, { env })
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
