#!/usr/bin/env node
/**
 * A site's install and a site's upgrade, rehearsed on a k3d cluster made for the run.
 *
 *   node scripts/site-rehearsal.mjs install   install the checkout as a new site: values from the
 *                                             checkout's setup.mjs, the runbook's site.yaml, the
 *                                             checkout's chart and images
 *   node scripts/site-rehearsal.mjs upgrade   install the last release as a site would (its own
 *                                             setup.mjs, the published chart and images), then
 *                                             `helm upgrade` it to the checkout with the same values
 *
 * Options:  --cluster=<name>      the k3d cluster to create, default aber-rehearsal; refused if it exists
 *           --kubeconfig=<file>   where the cluster's kubeconfig is written, default a file in the
 *                                 temporary directory; the default kubeconfig is never touched
 *           --from=<tag>          upgrade from this tag instead of the last release (`upgrade`)
 *           --keep                leave the cluster up after a pass (a failure always leaves it)
 *
 * What both end with: every StatefulSet, Deployment and DaemonSet rolls out, `helm test` passes,
 * every running pod's built image is the checkout's, the first administrator signs in through
 * Traefik with the password from the values file, and admin@aber.local with aber123 is refused.
 * `upgrade` also asserts the upgrade's db-init Job completed, which replays the migration chain
 * onto the last release's database, and that the administrator signs in before and after.
 *
 * The checkout's images are tagged <Chart.yaml version>-ci.<commit>, which no release carries, and
 * the checkout's chart is packaged with that as its version and appVersion, as release.yml packages
 * a release. Otherwise a tree between releases names the last release's tag, and the node would
 * hold the published and the built image under one name. No host port is published: the sign-in
 * goes through a port-forward to Traefik, with the Host and SNI of api.<domain>.
 *
 * CI's site-install-rehearsal and upgrade-rehearsal jobs run this; docs/testing.md has the rest.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IMAGES, IMG_NS, buildImages, capture, die, ensureCertManager, ensureTraefikConfig, forwardReady,
  freePort, importImages, must, preflight, printRestartedContainers, run, sleep, step,
} from './dev-cluster.mjs'
import { CHART_REF, readChartVersion } from './lib/release-chart.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NS = 'aber'
const RELEASE = 'aber'
// A domain no resolver answers: every request names its host itself, and setup.mjs refuses a
// loopback one. The administrator's address only has to have an email's shape.
const DOMAIN = 'rehearsal.aber.test'
const API_HOST = `api.${DOMAIN}`
const ADMIN_EMAIL = `admin@${DOMAIN}`
const DEMO = { email: 'admin@aber.local', password: 'aber123' }

const argv = process.argv.slice(2)
const mode = argv.find(a => !a.startsWith('--'))
const option = name => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
if (!['install', 'upgrade'].includes(mode)) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('\n').slice(2)
    .map(l => l.replace(/^ \* ?/, '')).join('\n'))
  process.exit(mode ? 1 : 0)
}
const CLUSTER = option('cluster') || 'aber-rehearsal'
// The values (credentials included), site.yaml, the packaged chart and, by default, the kubeconfig.
const WORK = mkdtempSync(path.join(os.tmpdir(), 'aber-rehearsal-'))
const KUBECONFIG = path.resolve(option('kubeconfig') || path.join(WORK, 'kubeconfig'))
const VALUES = path.join(WORK, 'values-local.yaml')
const SITE = path.join(WORK, 'site.yaml')

const timings = []
const forwards = new Set()
let passed = false
let worktree = null

async function phase (title, fn) {
  step(title)
  const start = Date.now()
  const result = await fn()
  timings.push([title, Date.now() - start])
  return result
}

function minutes (ms) {
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------
function git (...args) {
  const r = capture('git', args)
  if (!r.ok) die(`git ${args.join(' ')}: ${r.err}`)
  return r.out
}

/** A tag no release can have, so the node never holds a built and a published image under one name. */
function candidateVersion () {
  return `${readChartVersion(REPO)}-ci.${git('rev-parse', '--short=8', 'HEAD')}`
}

/** The highest release tag by version that is not this commit, or the tag --from names. */
function previousRelease () {
  const head = git('rev-parse', 'HEAD')
  const wanted = option('from')
  const tags = git('tag', '-l', 'v*', '--sort=-v:refname').split('\n')
    .filter(t => /^v\d+\.\d+\.\d+$/.test(t))
    .filter(t => wanted ? t === wanted : git('rev-parse', `${t}^{commit}`) !== head)
  if (!tags.length) {
    die(wanted ? `no release tag ${wanted}` : 'no release tag other than this commit; fetch the tags (git fetch --tags)')
  }
  return { tag: tags[0], version: tags[0].slice(1) }
}

// ---------------------------------------------------------------------------------------------
// The site's values
// ---------------------------------------------------------------------------------------------
/** `npm run setup` as an operator runs it, from the checkout or from a worktree of a release tag. */
function writeValues (tag) {
  let root = REPO
  if (tag) {
    worktree = path.join(WORK, `release-${tag}`)
    must('git', ['worktree', 'add', '--quiet', '--detach', worktree, tag], `could not check out ${tag} into a worktree`)
    root = worktree
  }
  try {
    must('node', [path.join(root, 'scripts', 'setup.mjs'), `--domain=${DOMAIN}`, `--admin-email=${ADMIN_EMAIL}`,
      `--out=${VALUES}`], `${tag || 'the checkout'}'s setup.mjs did not write the values`, { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })
  } finally {
    removeWorktree()
  }
  console.log(`  ${VALUES}, from ${tag ? `${tag}'s` : "the checkout's"} setup.mjs`)
}

function removeWorktree () {
  if (!worktree) return
  run('git', ['worktree', 'remove', '--force', worktree], { stdio: 'ignore' })
  run('git', ['worktree', 'prune'], { stdio: 'ignore' })
  worktree = null
}

/** What the runbook's site.yaml says (deploy/k8s/README.md, Install, A): what only a site can say. */
function writeSiteValues (nodeAddress) {
  writeFileSync(SITE, [
    'global:',
    '  scheme: https',
    'ingestion:',
    '  primaryHostId: rehearsal',
    '  sparkplugGroup: rehearsal',
    'supabaseFunctions:',
    '  aas:',
    `    baseIri: https://${DOMAIN}/ids/asset/`,
    'ingress:',
    '  tls:',
    '    enabled: true',
    '    certManager:',
    '      clusterIssuer: aber-ca',
    'mosquitto:',
    '  tls:',
    '    enabled: true',
    '    clusterIssuer: aber-ca',
    `    extraIpSans: [${nodeAddress}]`,
    '',
  ].join('\n'))
  console.log(`  ${SITE}, the broker certificate naming ${nodeAddress}`)
}

/** The first administrator and the publishable key, read back out of the file setup.mjs wrote. */
function siteCredentials () {
  const text = readFileSync(VALUES, 'utf8')
  const pick = (re, what) => re.exec(text)?.[1] || die(`${VALUES} has no ${what}`)
  return {
    email: pick(/^supabaseAuth:\s*\n\s+firstAdministrator:\s*\n\s+email:\s*"([^"]+)"/m, 'supabaseAuth.firstAdministrator.email'),
    password: pick(/^\s+firstAdministratorPassword:\s*"([^"]+)"/m, 'secrets.firstAdministratorPassword'),
    apikey: pick(/^\s+publishableKey:\s*"([^"]+)"/m, 'secrets.publishableKey'),
  }
}

// ---------------------------------------------------------------------------------------------
// The cluster
// ---------------------------------------------------------------------------------------------
function createCluster () {
  const list = capture('k3d', ['cluster', 'list', '-o', 'json'])
  if (list.ok && JSON.parse(list.out || '[]').some(c => c.name === CLUSTER)) {
    die(`a cluster named ${CLUSTER} exists. A rehearsal starts from a new one: k3d cluster delete ${CLUSTER}`)
  }
  must('k3d', ['cluster', 'create', CLUSTER, '--agents', '0', '--k3s-arg', '--disable=metrics-server@server:0',
    '--kubeconfig-update-default=false', '--kubeconfig-switch-context=false', '--wait'], 'k3d could not create the cluster')
  // Loopback, not the host name k3d writes on Windows and macOS: the API port is published there.
  const config = capture('k3d', ['kubeconfig', 'get', CLUSTER])
  if (!config.ok) die(`k3d could not print the kubeconfig: ${config.err}`)
  mkdirSync(path.dirname(KUBECONFIG), { recursive: true })
  writeFileSync(KUBECONFIG, config.out.replace(/server: https:\/\/[^\s:]+:(\d+)/, 'server: https://127.0.0.1:$1') + '\n')
  // Every kubectl and helm below, the ones dev-cluster.mjs runs included, inherit this.
  process.env.KUBECONFIG = KUBECONFIG
  const address = capture('kubectl', ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'])
  if (!address.ok || !address.out) die(`the cluster is not answering: ${address.err}`)
  console.log(`  kubeconfig ${KUBECONFIG}; node ${address.out}`)
  return address.out
}

// ---------------------------------------------------------------------------------------------
// The candidate: the checkout's chart and images
// ---------------------------------------------------------------------------------------------
/** The chart packaged as release.yml packages it, with the candidate as version and appVersion. */
function packageChart (version) {
  must('node', ['scripts/sync-helm-chart-files.mjs', '--check'], 'the chart\'s mirrored files are stale: run node scripts/sync-helm-chart-files.mjs')
  must('helm', ['package', 'deploy/helm/aber', '--version', version, '--app-version', version, '--destination', WORK],
    'helm could not package the chart')
  const chart = path.join(WORK, `aber-${version}.tgz`)
  if (!existsSync(chart)) die(`helm package wrote no ${chart}`)
  return chart
}

/** The built images this site pulls, read off the rendered chart; every one must carry the candidate tag. */
function imagesToBuild (chart, version) {
  const r = capture('helm', ['template', RELEASE, chart, '-n', NS, '-f', VALUES, '-f', SITE], { maxBuffer: 64 * 1024 * 1024 })
  if (!r.ok) die(`the packaged chart does not render with the site's values:\n${r.err}`)
  const refs = [...new Set([...r.out.matchAll(/image:\s*"?([^"\s]+)"?/g)].map(m => m[1]).filter(i => i.startsWith(`${IMG_NS}/`)))]
  const stray = refs.filter(i => !i.endsWith(`:${version}`))
  if (stray.length) die(`the render names built images at another tag; the node would pull them:\n  ${stray.join('\n  ')}`)
  const names = refs.map(i => i.slice(IMG_NS.length + 1).split(':')[0])
  const unknown = names.filter(n => !IMAGES.some(i => i.name === n))
  if (unknown.length) die(`the chart names images dev-cluster.mjs does not build: ${unknown.join(', ')}`)
  console.log(`  ${names.length} of the ${IMAGES.length} built images: ${names.join(', ')}`)
  return names
}

/** The host copies are never read again once imported; the tag is this run's alone. */
function dropHostCopies (names, version) {
  run('docker', ['image', 'rm', ...names.map(n => `${IMG_NS}/${n}:${version}`)], { stdio: 'ignore' })
}

// ---------------------------------------------------------------------------------------------
// Install, upgrade, and the checks
// ---------------------------------------------------------------------------------------------
// No --wait: on the first install it deadlocks (deploy/k8s/README.md). Helm still waits for the
// post-install and post-upgrade hooks, db-init among them.
function helm (verb, chart, extra = []) {
  must('helm', [verb, RELEASE, chart, '-n', NS, ...extra, '-f', VALUES, '-f', SITE, '--timeout', '15m'],
    `helm ${verb} failed`)
}

function rollOut () {
  const workloads = capture('kubectl', ['-n', NS, 'get', 'statefulset,deploy,daemonset', '-o', 'name']).out.split('\n').filter(Boolean)
  if (!workloads.length) die('the release has no workloads')
  for (const w of workloads) {
    must('kubectl', ['-n', NS, 'rollout', 'status', w, '--timeout=10m'], `${w} did not roll out`)
  }
}

function helmTest () {
  must('helm', ['test', RELEASE, '-n', NS, '--timeout', '5m'], 'helm test failed')
}

/** Every running pod's built image carries `version`: the proof that the upgrade replaced them all. */
function assertRunningImages (version) {
  const pods = JSON.parse(capture('kubectl', ['-n', NS, 'get', 'pods', '-o', 'json']).out).items
    .filter(p => p.status.phase === 'Running' && !p.metadata.deletionTimestamp)
  const seen = new Map()
  const wrong = []
  for (const p of pods) {
    for (const c of [...(p.spec.initContainers || []), ...p.spec.containers]) {
      if (!c.image.startsWith(`${IMG_NS}/`)) continue
      seen.set(c.image, (seen.get(c.image) || 0) + 1)
      if (!c.image.endsWith(`:${version}`)) wrong.push(`${p.metadata.name}/${c.name} runs ${c.image}`)
    }
  }
  for (const [image, n] of seen) console.log(`  ${image}  ${n} container(s)`)
  if (!seen.size) die('no running pod runs an image this repository builds')
  if (wrong.length) die(`running pods are not on the checkout's images:\n  ${wrong.join('\n  ')}`)
}

/** The upgrade's own db-init: the candidate image, completed. Its pod replayed every migration. */
function assertUpgradeMigrated (version) {
  const r = capture('kubectl', ['-n', NS, 'get', 'job', `${RELEASE}-db-init`, '-o', 'json'])
  if (!r.ok) die(`job/${RELEASE}-db-init is gone: ${r.err}`)
  const job = JSON.parse(r.out)
  const image = job.spec.template.spec.containers[0].image
  if (!image.endsWith(`:${version}`)) die(`job/${RELEASE}-db-init ran ${image}, not the upgrade's db-init`)
  if (!(job.status.succeeded >= 1)) die(`job/${RELEASE}-db-init did not complete: ${JSON.stringify(job.status)}`)
  console.log(`  job/${RELEASE}-db-init completed on ${image}; its last lines:`)
  run('kubectl', ['-n', NS, 'logs', `job/${RELEASE}-db-init`, '--tail', '8'])
}

// ---------------------------------------------------------------------------------------------
// Sign-in, through Traefik
// ---------------------------------------------------------------------------------------------
async function forwardTraefik () {
  const port = await freePort()
  const child = spawn('kubectl', ['-n', 'kube-system', 'port-forward', 'svc/traefik', `${port}:443`],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  forwards.add(child)
  if (!(await forwardReady(child))) die('the port-forward to Traefik did not open')
  return { port, close: () => { child.kill(); forwards.delete(child) } }
}

function request ({ port, ca, method = 'GET', urlPath, headers = {}, body }) {
  return new Promise(resolve => {
    const req = https.request({
      host: '127.0.0.1', port, servername: API_HOST, ca, method, path: urlPath, timeout: 20_000,
      agent: false, headers: { Host: API_HOST, ...headers },
    }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', d => { data += d })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', error => resolve({ status: 0, body: error.message }))
    if (body) req.write(body)
    req.end()
  })
}

/** The certificate Traefik serves for api.<domain>, issued from the internal CA, verified against it. */
async function reachApi (port, apikey) {
  const deadline = Date.now() + 300_000
  let last = ''
  while (Date.now() < deadline) {
    const ca = capture('kubectl', ['-n', NS, 'get', 'secret', 'aber-tls', '-o', 'jsonpath={.data.ca\\.crt}']).out
    if (ca) {
      const tls = { port, ca: Buffer.from(ca, 'base64') }
      const r = await request({ ...tls, urlPath: '/auth/v1/health', headers: { apikey } })
      if (r.status === 200) return tls
      last = `${r.status} ${r.body}`.slice(0, 200)
    } else {
      last = 'the aber-tls Secret holds no ca.crt yet'
    }
    await sleep(5000)
  }
  die(`https://${API_HOST}/auth/v1/health never answered 200 through Traefik with a certificate from the internal CA: ${last}`)
}

function signIn (tls, apikey, { email, password }) {
  return request({
    ...tls, method: 'POST', urlPath: '/auth/v1/token?grant_type=password',
    headers: { apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
}

/** GoTrue answers a wrong password or an unknown address with 400 invalid_credentials. */
async function checkSignIn () {
  const site = siteCredentials()
  const forward = await forwardTraefik()
  const tls = await reachApi(forward.port, site.apikey)
  const admin = await signIn(tls, site.apikey, site)
  const token = admin.status === 200 && /"access_token"\s*:\s*"[^"]+"/.test(admin.body)
  if (!token) die(`${site.email} could not sign in with the password from the values file: ${admin.status} ${admin.body.slice(0, 300)}`)
  console.log(`  ${site.email} signed in through Traefik (https://${API_HOST}, a certificate from the internal CA)`)
  const demo = await signIn(tls, site.apikey, DEMO)
  if (demo.status !== 400 || demo.body.includes('access_token')) {
    die(`${DEMO.email} with the demo password was not refused: ${demo.status} ${demo.body.slice(0, 300)}`)
  }
  console.log(`  ${DEMO.email} with the demo password is refused: ${demo.status} ${demo.body.slice(0, 120)}`)
  forward.close()
}

// ---------------------------------------------------------------------------------------------
// The two rehearsals
// ---------------------------------------------------------------------------------------------
async function rehearse () {
  const candidate = candidateVersion()
  const from = mode === 'upgrade' ? previousRelease() : null
  console.log(from
    ? `Upgrade rehearsal: ${from.tag}, as published, to the checkout as ${candidate}`
    : `Install rehearsal: the checkout as ${candidate}, as a new site`)

  await phase(`values from ${from ? `${from.tag}'s` : "the checkout's"} setup.mjs`, () => writeValues(from?.tag))
  const nodeAddress = await phase(`cluster ${CLUSTER}`, async () => {
    const address = createCluster()
    await ensureTraefikConfig()
    ensureCertManager()
    return address
  })
  writeSiteValues(nodeAddress)
  const chart = packageChart(candidate)
  const names = imagesToBuild(chart, candidate)
  await phase(`build the checkout's images as ${candidate}`, () => buildImages(candidate, names))
  await phase('import them into the node', () => {
    importImages(candidate, names, CLUSTER)
    dropHostCopies(names, candidate)
  })

  if (from) {
    await phase(`helm install ${from.tag}, the published chart`, () =>
      helm('install', CHART_REF, ['--version', from.version, '--create-namespace']))
    await phase(`${from.tag} rolls out and passes helm test`, () => { rollOut(); helmTest() })
    await phase(`the first administrator signs in to ${from.tag}`, checkSignIn)
    await phase(`helm upgrade to ${candidate}, with the same values`, () => helm('upgrade', chart))
    await phase('the upgrade\'s db-init replayed the migration chain', () => assertUpgradeMigrated(candidate))
  } else {
    await phase(`helm install ${candidate}`, () => helm('install', chart, ['--create-namespace']))
  }
  await phase('every workload rolls out', rollOut)
  await phase('helm test', helmTest)
  await phase('every running pod is on the checkout\'s images', () => assertRunningImages(candidate))
  await phase('the first administrator signs in; the demo account is refused', checkSignIn)
  passed = true
}

function summary () {
  const total = timings.reduce((t, [, ms]) => t + ms, 0)
  console.log('')
  for (const [title, ms] of timings) console.log(`  ${minutes(ms).padStart(7)}  ${title}`)
  console.log(`  ${minutes(total).padStart(7)}  in all`)
}

// A failure leaves the cluster for whoever reads it next (CI's diagnostics step, or a person).
process.on('exit', code => {
  for (const child of forwards) child.kill()
  removeWorktree()
  summary()
  if (passed && code === 0) {
    if (argv.includes('--keep')) {
      console.log(`\nPASSED. The cluster is kept: KUBECONFIG=${KUBECONFIG}; k3d cluster delete ${CLUSTER} when done.`)
    } else {
      run('k3d', ['cluster', 'delete', CLUSTER], { stdio: 'ignore' })
      rmSync(WORK, { recursive: true, force: true })
      console.log(`\nPASSED. Cluster ${CLUSTER} deleted.`)
    }
    return
  }
  if (process.env.KUBECONFIG === KUBECONFIG) {
    run('kubectl', ['-n', NS, 'get', 'pods', '-o', 'wide'])
    printRestartedContainers(NS)
    console.error(`\nThe cluster is left as it failed: KUBECONFIG=${KUBECONFIG}; the values are in ${WORK}.` +
      `\nDelete it with: k3d cluster delete ${CLUSTER}`)
  } else {
    rmSync(WORK, { recursive: true, force: true })
  }
})

preflight(['git', 'docker', 'k3d', 'kubectl', 'helm'])
await rehearse()
process.exit(0)
