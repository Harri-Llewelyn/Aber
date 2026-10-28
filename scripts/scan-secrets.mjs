#!/usr/bin/env node
/**
 * Secrets in the repository, with gitleaks: committed history, and what is not committed yet (the
 * diff against HEAD and untracked files). Committed findings accepted after review are listed by
 * fingerprint in .gitleaksignore, each group under its reason; anything else fails. An uncommitted
 * finding is never accepted: it is fixed before the commit.
 *
 *   node scripts/scan-secrets.mjs                   # every ref's history, and uncommitted changes
 *   node scripts/scan-secrets.mjs --history=head    # only the history of the checked-out commit
 *   node scripts/scan-secrets.mjs --ignore-union    # every ref, accepting what ANY ref's list accepts
 *   node scripts/scan-secrets.mjs --git-dir=PATH    # history of another clone, e.g. a mirror
 *
 * WHICH SCOPE, AND WHY. Each branch reviews its own findings in its own .gitleaksignore, so one
 * open branch's accepted finding is unknown to every other branch's list.
 *   --history=all (the default) scans every ref against the checkout's own list: what a person
 *     runs before pushing.
 *   --history=head is CI's Secret Scan job (pull requests and pushes to main). On a pull request
 *     HEAD is the merge commit, main's history plus the branch's commits, so a pull request fails
 *     only on what it would add to main, never on another open branch's finding.
 *   --ignore-union is secret-scan.yml (each push to main, and daily): every ref, pull request
 *     heads included, against this checkout's list joined with every scanned ref's own. A finding
 *     no list accepts fails there, wherever it was pushed.
 *
 * A MIRROR CLONE holds every ref GitHub serves, pull request heads (refs/pull/N/head) included,
 * which a normal clone does not fetch. Scan one to check everything a visitor can fetch.
 *
 *   git clone --mirror https://github.com/Harri-Llewelyn/Aber.git /tmp/aber-mirror.git
 *   node scripts/scan-secrets.mjs --git-dir=/tmp/aber-mirror.git --ignore-union
 *
 * Output is redacted: a finding is printed as its fingerprint (commit, file, rule and line) and the
 * refs that reach it, never its value. Needs Docker.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f'
const HISTORY = ['all', 'head']
const USAGE = 'usage: node scripts/scan-secrets.mjs [--history=all|head] [--ignore-union] [--git-dir=PATH]'

/** The command line, or `{ error }`. An unknown argument is refused rather than ignored. */
export function parseArgs (argv) {
  const opts = { history: 'all', union: false, gitDir: undefined }
  for (const arg of argv) {
    if (arg.startsWith('--history=')) opts.history = arg.slice('--history='.length)
    else if (arg.startsWith('--git-dir=') && arg.length > '--git-dir='.length) opts.gitDir = arg.slice('--git-dir='.length)
    else if (arg === '--ignore-union') opts.union = true
    else return { error: `unknown argument ${arg}\n${USAGE}` }
  }
  if (!HISTORY.includes(opts.history)) return { error: `--history takes ${HISTORY.join(' or ')}, not "${opts.history}"\n${USAGE}` }
  if (opts.union && opts.history !== 'all') return { error: '--ignore-union reads every ref\'s list, so it scans every ref: drop --history=head' }
  return opts
}

const fingerprints = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

/**
 * `base` (the checkout's .gitleaksignore) followed by each other list's fingerprints that it does
 * not already hold, under a comment naming the first ref that accepts them. `lists` is [[ref, text]].
 */
export function unionIgnore (base, lists) {
  const seen = new Set(fingerprints(base))
  const added = []
  let text = base.endsWith('\n') || !base ? base : `${base}\n`
  for (const [ref, list] of lists) {
    const fresh = [...new Set(fingerprints(list))].filter((f) => !seen.has(f))
    if (!fresh.length) continue
    fresh.forEach((f) => seen.add(f))
    added.push([ref, fresh.length])
    text += `\n# Accepted on ${ref}\n${fresh.join('\n')}\n`
  }
  return { text, added }
}

/**
 * `git cat-file --batch` output for one `<ref>:.gitleaksignore` request per ref, in order, as
 * [[ref, text]] for each ref that has the file. Sizes are in bytes, so this reads a Buffer.
 */
export function parseCatFileBatch (out, refs) {
  const lists = []
  let at = 0
  for (const ref of refs) {
    const eol = out.indexOf(0x0a, at)
    if (eol < 0) throw new Error(`git cat-file --batch stopped before ${ref}`)
    const header = out.subarray(at, eol).toString('utf8').split(' ')
    at = eol + 1
    // "<oid> <type> <size>" for an object; "<name> missing" (or "ambiguous") when there is none.
    if (header.length !== 3 || !/^\d+$/.test(header[2])) continue
    const size = Number(header[2])
    if (header[1] === 'blob') lists.push([ref, out.subarray(at, at + size).toString('utf8')])
    at += size + 1
  }
  return lists
}

/** Every ref in `gitDir`, and HEAD, with the .gitleaksignore each one carries. */
export function refLists (gitDir) {
  const run = (args, input) => {
    const r = spawnSync('git', ['--git-dir', gitDir, ...args], { input, maxBuffer: 1 << 28 })
    if (r.status !== 0) throw new Error(`git ${args[0]} failed in ${gitDir}: ${String(r.stderr || r.error).trim()}`)
    return r.stdout
  }
  const refs = ['HEAD', ...run(['for-each-ref', '--format=%(refname)']).toString('utf8').split('\n').filter(Boolean)]
  return parseCatFileBatch(run(['cat-file', '--batch'], refs.map((r) => `${r}:.gitleaksignore\n`).join('')), refs)
}

/**
 * One line per finding in gitleaks' JSON report: the fingerprint .gitleaksignore would take (it
 * names the rule), the refs that reach a committed finding's commit, and the file an uncommitted
 * one is in, from the `+++ b/` header above its line in the text scanned. Never the value.
 */
export function describeFindings (findings, { refsOf = () => [], text = '' } = {}) {
  const lines = text.split('\n')
  return findings.map((f) => {
    if (!f.Commit) {
      const header = lines.slice(0, f.StartLine).reverse().find((l) => l.startsWith('+++ b/'))
      return `   ${f.Fingerprint}${header ? `  (in ${header.slice('+++ b/'.length)}, not committed)` : ''}`
    }
    const refs = refsOf(f.Commit)
    const more = refs.length > 3 ? ` and ${refs.length - 3} more` : ''
    return `   ${f.Fingerprint}${refs.length ? `  (on ${refs.slice(0, 3).join(', ')}${more})` : ''}`
  }).join('\n')
}

function main () {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error) {
    console.error(opts.error)
    process.exit(2)
  }
  const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
  const mount = (p) => resolve(p).replace(/\\/g, '/')
  const git = (...args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })

  // The git directory is mounted rather than the checkout because a worktree's `.git` is a file
  // naming a host path the container cannot resolve. HEAD is resolved here for the same reason: in
  // a worktree, the common directory's HEAD is the main checkout's.
  const gitDir = opts.gitDir ? resolve(opts.gitDir) : resolve(REPO, git('rev-parse', '--git-common-dir').stdout.trim())
  let scope = '--all'
  if (opts.history === 'head') {
    const head = opts.gitDir ? spawnSync('git', ['--git-dir', gitDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }) : git('rev-parse', 'HEAD')
    scope = head.stdout.trim()
    if (head.status !== 0 || !/^[0-9a-f]{40,64}$/.test(scope)) {
      console.error(`could not resolve HEAD: ${(head.stderr || '').trim()}`)
      process.exit(2)
    }
  }

  let ignore = join(REPO, '.gitleaksignore')
  if (opts.union) {
    const { text, added } = unionIgnore(readFileSync(ignore, 'utf8'), refLists(gitDir))
    const scratch = mkdtempSync(join(tmpdir(), 'scan-secrets-'))
    process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
    ignore = join(scratch, 'gitleaksignore')
    writeFileSync(ignore, text)
    console.log(`\n== accepted findings: this checkout's .gitleaksignore, and ${added.length} ref(s) that accept more`)
    for (const [ref, n] of added) console.log(`   ${ref}: ${n} more`)
  }

  const refsOf = (commit) => spawnSync('git', ['--git-dir', gitDir, 'for-each-ref', '--contains', commit, '--format=%(refname)'],
    { encoding: 'utf8' }).stdout?.split('\n').filter(Boolean) ?? []

  // The report goes to stdout as JSON, and only its fingerprints and rules are printed.
  function gitleaks (label, args, { mounts = [], input } = {}) {
    console.log(`\n== ${label}`)
    const r = spawnSync('docker', [
      'run', '--rm', '-i', '-v', `${mount(ignore)}:/ignore:ro`, ...mounts, IMAGE,
      ...args, '--redact', '--no-banner', '--gitleaks-ignore-path', '/ignore', '--exit-code', '1',
      '--report-format', 'json', '--report-path', '-',
    ], { env, input, encoding: 'utf8', maxBuffer: 1 << 28 })
    if (r.error) {
      console.error(`could not run docker: ${r.error.message}`)
      process.exit(2)
    }
    process.stdout.write(r.stderr)
    let findings = []
    try {
      findings = JSON.parse(r.stdout || '[]')
    } catch {
      process.stdout.write(r.stdout)
    }
    if (findings.length) console.log(describeFindings(findings, input === undefined ? { refsOf } : { text: input }))
    // A scan that reached nothing reports "no leaks found" and exits 0: a false pass, refused here.
    if (/\[git\] fatal|not a git repository/.test(r.stderr) || / 0 commits scanned/.test(r.stderr)) {
      console.error(`${label}: gitleaks scanned nothing, so this is not a pass.`)
      return false
    }
    return r.status === 0
  }

  const what = opts.history === 'head' ? `the history of ${scope.slice(0, 12)} (HEAD)` : 'every ref'
  const history = gitleaks(`${what} in ${opts.gitDir || 'this clone'}`, ['git', '/scan', `--log-opts=${scope}`],
    { mounts: ['-v', `${mount(gitDir)}:/scan:ro`] })

  let pending = true
  if (!opts.gitDir) {
    const diff = git('diff', 'HEAD', '--no-color').stdout
    const untracked = git('ls-files', '--others', '--exclude-standard', '-z').stdout.split('\0').filter(Boolean)
    const text = diff + untracked.map((f) => `\n+++ b/${f}\n${readFileSync(resolve(REPO, f), 'utf8')}`).join('')
    pending = text.trim()
      ? gitleaks(`uncommitted changes (${untracked.length} untracked file(s))`, ['stdin'], { input: text })
      : (console.log('\n== uncommitted changes: none'), true)
  }

  if (!history || !pending) {
    const lists = opts.union ? 'no .gitleaksignore, of this checkout or of any ref,' : '.gitleaksignore does not'
    console.error(`\nA secret was found that ${lists} accept${opts.union ? 's' : ''}. Rotate it first; then decide whether`)
    console.error('history needs rewriting. A committed finding is added to .gitleaksignore only with its reason.')
    if (!history && !opts.union && opts.history === 'all') {
      console.error('A finding on another branch that it has reviewed in its own list passes with --ignore-union.')
    }
    process.exit(1)
  }
  console.log(`\nNo secret outside the reviewed list in ${opts.union ? 'the .gitleaksignore of this checkout or any ref' : '.gitleaksignore'}.`)
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) main()
