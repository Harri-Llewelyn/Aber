#!/usr/bin/env node
/**
 * The dashboard under its Content-Security-Policy, in a real browser. Opens the pages served before
 * sign-in, signs in as the seeded Administrator, opens every page frontend/src/navigation.jsx
 * declares, an area plan and two 3D models, signs out, and fails listing each violation the
 * browser reported.
 *
 *   node test-harness/csp-walk.mjs [--base=http://app.localhost] [--public-only] [--chrome=PATH]
 *
 * Headless Chrome over the DevTools protocol, through Node's own WebSocket: nothing to install.
 * Chrome is --chrome, else $CHROME or $CHROME_BIN (GitHub's Ubuntu runners set it), else the usual
 * install path. ABER_ADMIN_EMAIL and ABER_ADMIN_PASSWORD default to values-dev.yaml's seed.
 *
 * A violation is a securitypolicyviolation event, a console, log or exception message from a page
 * or one of its workers naming the Content Security Policy, or a DevTools CSP issue. A report-only
 * refusal counts as one too, so the walk reads the same under either mode of
 * frontend.contentSecurityPolicy. The area, its plan and the two devices with their models are made
 * through the API as the signed-in Administrator, and deleted before sign-out. Exit 0 is a clean
 * walk, 1 a violation or a page that did not open, 2 a walk that could not start.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const BASE = arg('base', process.env.CSP_WALK_BASE || 'http://app.localhost').replace(/\/+$/, '')
const PUBLIC_ONLY = process.argv.includes('--public-only')
const EMAIL = process.env.ABER_ADMIN_EMAIL || 'admin@aber.local'
const PASSWORD = process.env.ABER_ADMIN_PASSWORD || 'aber123'
const SETTLE_MS = Number(arg('settle-ms', '1500'))
const BINDING = '__aberCspViolation'
const CSP = /content[- ]security[- ]policy/i

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function die (message) {
  console.error(`csp-walk: ${message}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------------------------
// What to walk: the pages the navigation declares, and the paths App.jsx serves before sign-in.
// ---------------------------------------------------------------------------------------------
function pagesToWalk () {
  const nav = readFileSync(join(REPO, 'frontend/src/navigation.jsx'), 'utf8')
  const start = nav.indexOf('export const TABS = [')
  const block = start < 0 ? '' : nav.slice(start, nav.indexOf('\n]', start))
  const tabs = [...block.matchAll(/\{\s*id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1])
  const app = readFileSync(join(REPO, 'frontend/src/App.jsx'), 'utf8')
  const publicPaths = ['/', ...[...app.matchAll(/^const \w+_PATH = '(\/[^']*)'/gm)].map((m) => m[1])]
  if (tabs.length < 10) die(`found ${tabs.length} page(s) in navigation.jsx's TABS; the walk reads it by shape and the shape changed`)
  if (publicPaths.length < 3) die('found no *_PATH constant in App.jsx; the walk reads the public paths there and they moved')
  return { tabs, publicPaths }
}

// ---------------------------------------------------------------------------------------------
// The fixtures: a plan and two models. The models are one Draco-compressed, textured quad, as a
// .glb (the texture from a blob: URL) and as a .gltf (buffer and texture as data: URLs), so the
// viewer runs its WASM decoder in a blob: worker and fetches both URL schemes three.js uses.
// ---------------------------------------------------------------------------------------------
// three r183's draco_encoder.js, sequential encoding: 4 points, 2 faces, POSITION (attribute 0,
// 11-bit) and TEX_COORD (attribute 1, 10-bit).
const DRACO_QUAD = Buffer.from(
  'RFJBQ08CAgEAAAACBAEAAQIAAgMBAgAJAwAAAwkCAAECAgABAQADAwEwARADADSCiAQAAAAA/wcAAAABAQADAwEgASADACCE' +
  'hgIAAAAA/wMAAAAAAL8AAAC/AAAAAAAAgD8LAAAAAAAAAAAAAIA/Cg==', 'base64')

function png (width, height, pixel) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4)
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

const TEXTURE = png(2, 2, (x, y) => ((x + y) % 2 ? [0x1f, 0x6f, 0xb2, 0xff] : [0xf2, 0xa9, 0x00, 0xff]))

function gltf (embedded) {
  const quad = embedded ? { uri: `data:application/octet-stream;base64,${DRACO_QUAD.toString('base64')}` } : {}
  const image = embedded
    ? { uri: `data:image/png;base64,${TEXTURE.toString('base64')}` }
    : { bufferView: 1, mimeType: 'image/png' }
  return {
    asset: { version: '2.0', generator: 'Aber csp-walk' },
    extensionsUsed: ['KHR_draco_mesh_compression'],
    extensionsRequired: ['KHR_draco_mesh_compression'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, TEXCOORD_0: 1 },
        indices: 2,
        material: 0,
        extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0, TEXCOORD_0: 1 } } },
      }],
    }],
    accessors: [
      { componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] },
      { componentType: 5126, count: 4, type: 'VEC2' },
      { componentType: 5125, count: 6, type: 'SCALAR' },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 }, doubleSided: true }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    textures: [{ source: 0, sampler: 0 }],
    images: [image],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: DRACO_QUAD.length },
      ...(embedded ? [] : [{ buffer: 0, byteOffset: DRACO_QUAD.length, byteLength: TEXTURE.length }]),
    ],
    buffers: [{ byteLength: DRACO_QUAD.length + (embedded ? 0 : TEXTURE.length), ...quad }],
  }
}

function glb () {
  const pad = (buf, fill) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, fill)])
  const json = pad(Buffer.from(JSON.stringify(gltf(false))), 0x20)
  const bin = pad(Buffer.concat([DRACO_QUAD, TEXTURE]), 0)
  const head = Buffer.alloc(20)
  head.writeUInt32LE(0x46546c67, 0) // glTF
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8)
  head.writeUInt32LE(json.length, 12)
  head.writeUInt32LE(0x4e4f534a, 16) // JSON
  const binHead = Buffer.alloc(8)
  binHead.writeUInt32LE(bin.length, 0)
  binHead.writeUInt32LE(0x004e4942, 4) // BIN
  return Buffer.concat([head, json, binHead, bin])
}

const PLAN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">' +
  '<rect x="10" y="10" width="380" height="280" fill="none" stroke="#555" stroke-width="4"/>' +
  '<rect x="40" y="40" width="140" height="100" fill="#ddd"/></svg>'

// ---------------------------------------------------------------------------------------------
// Chrome, and the DevTools protocol over one browser-level WebSocket with flattened sessions.
// ---------------------------------------------------------------------------------------------
function chromePath () {
  const given = arg('chrome', process.env.CHROME || process.env.CHROME_BIN)
  if (given) return given
  const env = process.env
  const candidates = process.platform === 'win32'
    ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
        .filter(Boolean).map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find((p) => existsSync(p))
}

async function launch () {
  const binary = chromePath()
  if (!binary) die('no Chrome found; pass --chrome=PATH or set CHROME')
  const profile = mkdtempSync(join(tmpdir(), 'csp-walk-'))
  const args = [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // Chrome's own traffic (updates, sync, field trials) stays out of the run.
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    // WebGL for the 3D viewer, rendered in software.
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=1440,1000', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ]
  // A CI runner is a throwaway machine opening one site, and its kernel may refuse the sandbox's
  // user namespaces.
  if (process.platform === 'linux' && process.env.CI) args.unshift('--no-sandbox')
  const chrome = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome did not open its DevTools endpoint:\n${stderr.slice(-1500)}`)), 30000)
    chrome.stderr.on('data', (d) => {
      stderr += d
      const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) { clearTimeout(timer); resolveEndpoint(m[1]) }
    })
    chrome.on('exit', (code) => reject(new Error(`Chrome exited (${code}):\n${stderr.slice(-1500)}`)))
  }).catch((e) => die(e.message))
  const ws = new WebSocket(endpoint)
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = () => reject(new Error(`could not connect to ${endpoint}`)) })
    .catch((e) => die(e.message))
  const close = () => {
    try { ws.close() } catch { /* already closed */ }
    chrome.kill()
    // Chrome holds the profile for a moment after the kill on Windows.
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }) } catch { /* left in tmp */ } }, 1000)
  }
  return { ws, close }
}

function protocol (ws) {
  let next = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`))
      else p.resolve(msg.result)
    } else {
      for (const listener of listeners) listener(msg)
    }
  }
  const send = (method, params = {}, sessionId) => new Promise((resolveSend, reject) => {
    const id = ++next
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no answer in 60s`)) }, 60000)
    pending.set(id, { resolve: resolveSend, reject, method, timer })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { send, on: (listener) => listeners.push(listener) }
}

// Runs in every document before its own scripts. A violation event is composed, so one listener on
// the document also hears those raised inside a shadow root.
const LISTENER = `document.addEventListener('securitypolicyviolation', (e) => {
  window.${BINDING}(JSON.stringify({
    directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, disposition: e.disposition,
    source: e.sourceFile, line: e.lineNumber, sample: e.sample,
  }))
}, true)`

// ---------------------------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------------------------
const { tabs, publicPaths } = pagesToWalk()
const { ws, close } = await launch()
const cdp = protocol(ws)
const reports = [] // { page, text }
const problems = [] // pages that did not open, fixtures that could not be made
const walked = []
let current = '(start)'

const record = (text) => {
  if (!reports.some((r) => r.page === current && r.text === text)) reports.push({ page: current, text })
}

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
const page = (method, params) => cdp.send(method, params, sessionId)

cdp.on(({ method, params, sessionId: from }) => {
  if (method === 'Runtime.bindingCalled' && params.name === BINDING) {
    const v = JSON.parse(params.payload)
    const where = v.source ? ` at ${v.source}${v.line ? `:${v.line}` : ''}` : ''
    record(`${v.disposition === 'report' ? '[report-only] ' : ''}${v.directive} refused ${v.blocked || 'inline'}${where}` +
      `${v.sample ? ` "${v.sample}"` : ''}`)
  } else if (method === 'Log.entryAdded' && CSP.test(params.entry.text)) {
    record(params.entry.text + (params.entry.url ? ` (${params.entry.url})` : ''))
  } else if (method === 'Runtime.consoleAPICalled') {
    const text = params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    if (CSP.test(text)) record(text)
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails
    const text = d.exception?.description || d.text
    if (CSP.test(text)) record(text)
  } else if (method === 'Audits.issueAdded' && params.issue.code === 'ContentSecurityPolicyIssue') {
    const d = params.issue.details.contentSecurityPolicyIssueDetails || {}
    record(`${d.isReportOnly ? '[report-only] ' : ''}${d.violatedDirective} (${d.contentSecurityPolicyViolationType})` +
      `${d.blockedURL ? ` ${d.blockedURL}` : ''}`)
  } else if (method === 'Target.attachedToTarget' && from === sessionId) {
    // A worker the page started (the model viewer's decoders): its own console, before it runs.
    const child = params.sessionId
    Promise.all([cdp.send('Runtime.enable', {}, child), cdp.send('Log.enable', {}, child)])
      .catch(() => {})
      .finally(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {}))
  }
})

for (const domain of ['Page', 'Runtime', 'Log', 'Audits']) await page(`${domain}.enable`)
await page('Runtime.addBinding', { name: BINDING })
await page('Page.addScriptToEvaluateOnNewDocument', { source: LISTENER })
await page('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })

async function evaluate (expression) {
  const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

/** Poll until `expression` is truthy. A navigation in flight makes an evaluation fail; that retries. */
async function until (expression, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true
    await sleep(250)
  }
  return false
}

/** Open a path, wait for `ready`, let its loads settle. Records a problem if it never got ready. */
async function visit (path, ready, ms, label = path) {
  current = label
  const started = Date.now()
  await page('Page.navigate', { url: BASE + path })
  const ok = await until(ready, ms)
  if (ok) {
    await until("!document.querySelector('.spinner')", 20000)
    await sleep(SETTLE_MS)
  } else {
    problems.push(`${path}: did not render within ${(ms || 30000) / 1000}s (waited for ${ready})`)
  }
  walked.push({ label, seconds: (Date.now() - started) / 1000 })
  return ok
}

const RENDERED = "document.querySelector('#root')?.childElementCount > 0"
const SIGN_IN_FORM = "!!document.querySelector('#auth-email')"
const SHELL = "!!document.querySelector('.sidebar')"

/** A call to the API from the page, as the dashboard makes it: its config.js address, key and session. */
async function api (method, path, { json, base64, type } = {}) {
  const request = JSON.stringify({ method, path, json, base64, type })
  return evaluate(`(async () => {
    const p = ${request};
    const cfg = window.__ABER_CONFIG__ || {};
    const entry = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k));
    const session = entry ? JSON.parse(localStorage.getItem(entry)) : null;
    if (!cfg.VITE_SUPABASE_URL || !session) return { status: 0, text: 'no API address in config.js, or no session' };
    const headers = { apikey: cfg.VITE_SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + session.access_token };
    let body;
    if (p.json) {
      headers['Content-Type'] = 'application/json';
      headers.Prefer = 'return=representation';
      body = JSON.stringify(p.json);
    } else if (p.base64) {
      headers['Content-Type'] = p.type;
      headers['x-upsert'] = 'true';
      body = Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0));
    }
    const res = await fetch(cfg.VITE_SUPABASE_URL + p.path, { method: p.method, headers, body });
    return { status: res.status, text: await res.text() };
  })()`)
}

async function must (what, call) {
  const r = await call
  if (r.status < 200 || r.status > 299) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 300)}`)
  return r.text ? JSON.parse(r.text) : null
}

/** A PATCH that row-level security filters answers 200 with no rows. */
async function attach (what, call) {
  const rows = await must(`attach ${what}`, call)
  if (!rows?.length) throw new Error(`attach ${what}: no row was updated`)
}

const fixtures = { area: null, devices: [], objects: [] }

async function makeFixtures () {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const [area] = await must('create an area', api('POST', '/rest/v1/areas', { json: { name: `CSP walk ${stamp}` } }))
  fixtures.area = area.id
  const planPath = `${area.id}/plan-${Date.now()}.svg`
  await must('upload its plan', api('POST', `/storage/v1/object/area-plans/${planPath}`,
    { base64: Buffer.from(PLAN).toString('base64'), type: 'image/svg+xml' }))
  fixtures.objects.push(['area-plans', planPath])
  await attach('the plan', api('PATCH', `/rest/v1/areas?id=eq.${area.id}`, { json: { plan_path: planPath, plan_aspect: 400 / 300 } }))

  const models = [['csp-walk.glb', 'model/gltf-binary', glb()],
    ['csp-walk.gltf', 'model/gltf+json', Buffer.from(JSON.stringify(gltf(true)))]]
  for (const [file, type, bytes] of models) {
    const [device] = await must('create a device', api('POST', '/rest/v1/devices',
      { json: { name: `CSP walk ${file} ${stamp}`, location_scope: 'site_wide' } }))
    fixtures.devices.push(device.id)
    const path = `${device.id}/${file}`
    await must(`upload ${file}`, api('POST', `/storage/v1/object/asset-3d-models/${path}`, { base64: bytes.toString('base64'), type }))
    fixtures.objects.push(['asset-3d-models', path])
    await attach(file, api('PATCH', `/rest/v1/devices?id=eq.${device.id}`, { json: { model_3d_path: path } }))
  }
}

async function removeFixtures () {
  const left = []
  for (const [bucket, path] of fixtures.objects) {
    const r = await api('DELETE', `/storage/v1/object/${bucket}`, { json: { prefixes: [path] } }).catch((e) => ({ status: 0, text: e.message }))
    if (r.status > 299 || r.status === 0) left.push(`${bucket}/${path}`)
  }
  for (const id of fixtures.devices) {
    const r = await api('DELETE', `/rest/v1/devices?id=eq.${id}`).catch((e) => ({ status: 0, text: e.message }))
    if (r.status > 299 || r.status === 0) left.push(`device ${id}`)
  }
  if (fixtures.area) {
    const r = await api('DELETE', `/rest/v1/areas?id=eq.${fixtures.area}`).catch((e) => ({ status: 0, text: e.message }))
    if (r.status > 299 || r.status === 0) left.push(`area ${fixtures.area}`)
  }
  if (left.length) console.log(`  left behind (delete by hand): ${left.join(', ')}`)
}

let policy = null
try {
  for (const path of publicPaths) {
    await visit(path, path === '/' ? SIGN_IN_FORM : RENDERED)
    if (!policy) {
      policy = await evaluate(`fetch(location.origin + '/', { cache: 'no-store' }).then((r) => ({
        enforce: r.headers.get('content-security-policy'), reportOnly: r.headers.get('content-security-policy-report-only') }))`)
    }
  }

  if (!PUBLIC_ONLY) {
    await visit('/', SIGN_IN_FORM, 30000, '(sign-in)')
    // React owns the inputs: a value goes through the native setter and an input event.
    await evaluate(`(() => {
      const set = (el, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('#auth-email'), ${JSON.stringify(EMAIL)});
      set(document.querySelector('#auth-password'), ${JSON.stringify(PASSWORD)});
      document.querySelector('#auth-email').form.requestSubmit();
      return true;
    })()`)
    if (!await until(SHELL, 45000)) {
      const said = await evaluate("document.querySelector('#root')?.innerText?.slice(0, 400)").catch(() => '')
      throw new Error(`sign-in as ${EMAIL} did not reach the dashboard. The page says:\n${said}`)
    }

    for (const tab of tabs) {
      await visit(`/${tab}`, SHELL)
      const at = await evaluate('location.pathname')
      if (at !== `/${tab}`) problems.push(`/${tab}: the dashboard moved to ${at}, so the page was not walked`)
    }

    try {
      await makeFixtures()
    } catch (e) {
      problems.push(`the area plan and the 3D models could not be made, so neither view was walked: ${e.message}`)
    }
    if (fixtures.area && fixtures.objects.some(([bucket]) => bucket === 'area-plans')) {
      const PLAN_DRAWN = "[...document.querySelectorAll('img.area-plan-image')].some((i) => i.complete && i.naturalWidth > 0)"
      await visit(`/site-map?area=${fixtures.area}`, PLAN_DRAWN)
      await visit(`/areas?search=${fixtures.area}`, PLAN_DRAWN)
    }
    for (const id of fixtures.devices) {
      const MODEL = "document.querySelector('[data-testid=\"model-3d-viewer\"]')"
      const shown = await visit(`/devices?search=${id}`, `${MODEL}?.loaded === true || !!document.querySelector('[data-testid="model-3d-viewer-error"]')`, 60000)
      if (shown && !await evaluate(`${MODEL}?.loaded === true`)) {
        problems.push(`/devices?search=${id}: the 3D viewer shows its error instead of the model`)
      }
    }

    current = '(clean-up)'
    await removeFixtures()

    // Sign-out also ends the gateway's Studio and forge sessions, with a request to each door.
    current = '(sign-out)'
    await evaluate("document.querySelector('.user-avatar').click()")
    await until("!!document.querySelector('.user-popover-action-danger')", 5000)
    await evaluate("document.querySelector('.user-popover-action-danger').click()")
    if (!await until(SIGN_IN_FORM, 15000)) problems.push('(sign-out): the sign-in form did not come back')
    await sleep(SETTLE_MS + 2000)
    walked.push({ label: '(sign-out)', seconds: 0 })
  }
} catch (e) {
  problems.push(`${current}: ${e.message}`)
} finally {
  close()
}

// ---------------------------------------------------------------------------------------------
// The report, into the run's log.
// ---------------------------------------------------------------------------------------------
console.log(`CSP walk of ${BASE}: ${walked.length} page(s)${PUBLIC_ONLY ? ', before sign-in only' : ''}`)
if (policy?.enforce) console.log(`  Content-Security-Policy: ${policy.enforce}`)
if (policy?.reportOnly) console.log(`  Content-Security-Policy-Report-Only: ${policy.reportOnly}`)
if (policy && !policy.enforce && !policy.reportOnly) {
  problems.push('the dashboard sends no Content-Security-Policy, so the walk proves nothing')
}
const labels = [...new Set([...walked.map((w) => w.label), ...reports.map((r) => r.page)])]
for (const label of labels) {
  const mine = reports.filter((r) => r.page === label)
  const seconds = walked.filter((w) => w.label === label).reduce((n, w) => n + w.seconds, 0)
  console.log(`  ${mine.length ? 'FAIL' : 'ok  '} ${label}${seconds ? ` (${seconds.toFixed(1)}s)` : ''}`)
  for (const r of mine) console.log(`         ${r.text}`)
}
for (const p of problems) console.log(`  PROBLEM ${p}`)
// The browser tells of one refusal several ways: an event, a console entry, a DevTools issue.
const failing = new Set(reports.map((r) => r.page)).size
console.log(`\n${failing} page(s) with a CSP violation (${reports.length} report(s)), ${problems.length} problem(s).`)
process.exit(reports.length || problems.length ? 1 : 0)
