#!/usr/bin/env node
/**
 * The daily release check (releaseCheck.enabled, off by default). Asks GitHub's API for the latest
 * Aber release, compares its MAJOR.MINOR.PATCH core with the release this stack runs, and records
 * the answer through record_release_check(): one row, which the account menu reads. It sends no
 * GitHub credential, since the repository is public, and `releases/latest` already leaves out
 * drafts and pre-releases. A check that fails is recorded with its reason, the menu shows nothing
 * for it, and the run exits 1.
 *
 * Runs in the chart's node image, mounted from a ConfigMap, with nothing installed. Env:
 * RELEASE_VERSION, the chart's appVersion; SUPABASE_URL, the gateway; SUPABASE_PUBLISHABLE_KEY, for
 * the gateway's own check; SUPABASE_RELEASE_CHECK_KEY, the bearer, which names
 * Service_ReleaseCheck, the one principal the gate admits; and HTTPS_PROXY with
 * NODE_USE_ENV_PROXY=1 when releaseCheck.proxy is set.
 */
const LATEST = 'https://api.github.com/repos/Harri-Llewelyn/Aber/releases/latest'
const TIMEOUT_MS = 30_000

// The pattern frontend/src/utils/releaseVersion.js compares on; check-docs-drift.mjs holds the two equal.
const CORE = /^v?(\d+)\.(\d+)\.(\d+)/

function core (version) {
  const m = CORE.exec(String(version ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function isNewer (a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

// A failure in words an operator can act on, without the stack trace.
function reason (e) {
  if (e?.name === 'TimeoutError') return `no answer within ${TIMEOUT_MS / 1000} s (blocked by a NetworkPolicy or a firewall?)`
  const code = e?.cause?.code || e?.cause?.message
  return code ? `${e.message} (${code})` : String(e?.message || e)
}

async function latestRelease () {
  let r
  try {
    r = await fetch(LATEST, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'aber-release-check' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(`could not reach api.github.com: ${reason(e)}`)
  }
  if (!r.ok) throw new Error(`api.github.com answered ${r.status} ${r.statusText}`)
  const body = await r.json()
  const version = core(body?.tag_name)
  if (!version || typeof body?.html_url !== 'string') {
    throw new Error(`the latest release names no MAJOR.MINOR.PATCH version (tag ${JSON.stringify(String(body?.tag_name)).slice(0, 60)})`)
  }
  return { version, url: body.html_url }
}

async function record (args) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/record_release_check`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
      authorization: `Bearer ${process.env.SUPABASE_RELEASE_CHECK_KEY || ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`record_release_check answered ${r.status}: ${(await r.text()).slice(0, 300)}`)
}

const running = core(process.env.RELEASE_VERSION)
if (!running) {
  console.error(`RELEASE_VERSION ${JSON.stringify(process.env.RELEASE_VERSION)} is not a MAJOR.MINOR.PATCH version.`)
  process.exit(1)
}
const runningText = running.join('.')

let outcome
try {
  outcome = await latestRelease()
} catch (e) {
  const why = String(e.message).slice(0, 500)
  console.error(`The release check failed: ${why}`)
  try {
    await record({ p_running: runningText, p_error: why })
  } catch (e2) {
    console.error(`It could not be recorded either: ${reason(e2)}`)
  }
  process.exit(1)
}

const latest = outcome.version.join('.')
const newer = isNewer(outcome.version, running)
try {
  await record({ p_running: runningText, p_latest: latest, p_url: outcome.url, p_newer: newer })
} catch (e) {
  console.error(`The latest release is ${latest}, and it could not be recorded: ${reason(e)}`)
  process.exit(1)
}
console.log(newer
  ? `Aber ${latest} is available; this stack runs ${runningText}. Release notes: ${outcome.url}`
  : `This stack runs ${runningText}; the latest release is ${latest}.`)
