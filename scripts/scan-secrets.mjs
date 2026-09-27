#!/usr/bin/env node
/**
 * Secrets in the repository, with gitleaks: every commit reachable from any ref, and what is not
 * committed yet (the diff against HEAD and untracked files). Committed findings accepted after
 * review are listed by fingerprint in .gitleaksignore, each group under its reason; anything else
 * fails. An uncommitted finding is never accepted: it is fixed before the commit.
 *
 *   node scripts/scan-secrets.mjs                 # history (--all) and uncommitted changes
 *   node scripts/scan-secrets.mjs --git-dir=PATH  # history of another clone, e.g. a mirror
 *
 * BEFORE THE REPOSITORY GOES PUBLIC, scan a mirror clone rather than this checkout: publishing
 * exposes every pull request's head (refs/pull/N/head), including branches deleted after merging,
 * and a normal clone does not fetch them.
 *
 *   git clone --mirror https://github.com/Harri-Llewelyn/Aber.git /tmp/aber-mirror.git
 *   node scripts/scan-secrets.mjs --git-dir=/tmp/aber-mirror.git
 *
 * Output is redacted: a finding names its file, line and rule, never its value. Needs Docker.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f'
const argDir = process.argv.find((a) => a.startsWith('--git-dir='))?.slice('--git-dir='.length)
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const mount = (p) => resolve(p).replace(/\\/g, '/')
const git = (...args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })

function gitleaks (label, args, { mounts = [], input } = {}) {
  console.log(`\n== ${label}`)
  const r = spawnSync('docker', [
    'run', '--rm', '-i', '-v', `${mount(REPO)}/.gitleaksignore:/ignore:ro`, ...mounts, IMAGE,
    ...args, '--redact', '--no-banner', '--gitleaks-ignore-path', '/ignore', '--exit-code', '1',
  ], { env, input, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.error) {
    console.error(`could not run docker: ${r.error.message}`)
    process.exit(2)
  }
  process.stdout.write(r.stdout)
  process.stdout.write(r.stderr)
  // A scan that reached nothing reports "no leaks found" and exits 0: a false pass, refused here.
  if (/\[git\] fatal|not a git repository/.test(r.stderr) || / 0 commits scanned/.test(r.stderr)) {
    console.error(`${label}: gitleaks scanned nothing, so this is not a pass.`)
    return false
  }
  return r.status === 0
}

// History. The git directory is mounted rather than the checkout because a worktree's `.git` is a
// file naming a host path the container cannot resolve.
const gitDir = argDir || resolve(REPO, git('rev-parse', '--git-common-dir').stdout.trim())
const history = gitleaks(`history of ${argDir || 'every ref'}`, ['git', '/scan', '--log-opts=--all'],
  { mounts: ['-v', `${mount(gitDir)}:/scan:ro`] })

let pending = true
if (!argDir) {
  const diff = git('diff', 'HEAD', '--no-color').stdout
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').stdout.split('\0').filter(Boolean)
  const text = diff + untracked.map((f) => `\n--- ${f}\n${readFileSync(resolve(REPO, f), 'utf8')}`).join('')
  pending = text.trim()
    ? gitleaks(`uncommitted changes (${untracked.length} untracked file(s))`, ['stdin'], { input: text })
    : (console.log('\n== uncommitted changes: none'), true)
}

if (!history || !pending) {
  console.error('\nA secret was found that .gitleaksignore does not accept. Rotate it first; then decide whether')
  console.error('history needs rewriting. A committed finding is added to .gitleaksignore only with its reason.')
  process.exit(1)
}
console.log('\nNo secret outside the reviewed list in .gitleaksignore.')
