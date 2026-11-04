#!/usr/bin/env node
/**
 * Static analysis of the source with Semgrep's community rulesets (p/default, p/security-audit), in
 * a pinned container with metrics off. Each finding is keyed by rule, file and the text of the line
 * it points at, so it survives unrelated edits; one accepted after review is listed in
 * scripts/lint/semgrep-allowlist.json with its reason, and anything else fails.
 *
 * A tracked file Semgrep cannot parse, whole or in part, fails too. Semgrep only warns about one,
 * and no rule reads what it could not parse, so a finding there would pass unseen. UNPARSED below
 * names the exceptions, with their reasons.
 *
 *   node scripts/scan-source.mjs
 *
 * Interim until the repository is public, when CodeQL's default setup is free (#387). Needs Docker
 * and network access to fetch the rulesets.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'semgrep/semgrep:1.140.0'

// Semgrep's error types for a file, or a stretch of one, that no parser read.
const PARSE_ERRORS = new Set(['Lexical error', 'Syntax error', 'Other syntax error', 'AST builder error', 'PartialParsing'])

// Tracked files Semgrep parses only in part: how many lines its parser stops at, and why. Each is
// valid shell that its bash parser does not read, or GitHub's ${{ }} expressions, which are not bash
// until GitHub replaces them, in run steps the two curl rules read as bash. Rewriting a working
// script for a scanner's sake is a change of its own. A further stretch in one of these files, or
// any other tracked file that does not parse, fails the scan.
const SH = "Semgrep's bash parser stops at"
export const UNPARSED = {
  '.github/workflows/ci.yml': { stretches: 2, reason: `${SH} the < in the vitest count step's \${ACTUAL:-<unparsed>}, and at the site-rehearsal upgrade's \${{ matrix.signing }}, a GitHub expression.` },
  '.github/workflows/restore-rehearsal.yml': { stretches: 2, reason: `${SH} \${{ steps.backup.outputs.stamp }}, a GitHub expression, in the fetch and restore steps.` },
  'deploy/helm/aber/files/gitea-scripts/gitea-init.sh': { stretches: 1, reason: `A copy of scripts/gitea-init.sh: ${SH} its one-line case with the pattern *:*.` },
  'deploy/helm/aber/files/supabase-db-pgbackrest/platform-backup.sh': { stretches: 1, reason: `A copy of supabase/db/pgbackrest/platform-backup.sh: ${SH} the | in the pattern of \${slot#*|}.` },
  'deploy/helm/aber/files/timescaledb-pgbackrest/historian-backup.sh': { stretches: 1, reason: `A copy of timescaledb/pgbackrest/historian-backup.sh: ${SH} the | in the pattern of \${slot#*|}.` },
  'deploy/install.sh': { stretches: 5, reason: `${SH} four case patterns (two with a bracket expression, two in a one-line case), and from not_ready_reason() to the end of the file.` },
  'forge/gateway-platform/roles/converge/files/aber-gateway-converge': { stretches: 1, reason: `${SH} the negated brace group in if ! { cp ...; }; then.` },
  'scripts/gitea-init.sh': { stretches: 1, reason: `${SH} the one-line case with the pattern *:*.` },
  'scripts/rehearse-restore.sh': { stretches: 13, reason: `${SH} each < or > in a usage message such as \${1:?usage: backup <dir>}, and at the read-write redirection 3<>.` },
  'supabase/db/pgbackrest/platform-backup.sh': { stretches: 1, reason: `${SH} the | in the pattern of \${slot#*|}.` },
  'supabase/functions/offline-check.sh': { stretches: 2, reason: `${SH} the read-write redirection 3<>.` },
  'timescaledb/pgbackrest/historian-backup.sh': { stretches: 1, reason: `${SH} the | in the pattern of \${slot#*|}.` },
}

export const keyOf = (ruleId, path, text) =>
  `${ruleId.split('.').pop()} ${path} ${createHash('sha256').update(text).digest('hex').slice(0, 12)}`

/**
 * The files a Semgrep JSON report's `errors` say were not wholly parsed, each with the lines its
 * parser stopped at. `failing`: tracked, and not in `excused` or with more such lines than it
 * allows. `untracked`: files git does not track, reported but not failed. `stale`: entries of
 * `excused` that now allow more lines than their file has. `tracked` is a Set of paths, or null
 * when git could not list them, and then every file counts as tracked.
 */
export function parseFailures (errors, tracked, excused = UNPARSED) {
  const byPath = new Map()
  for (const e of errors) {
    const type = Array.isArray(e.type) ? e.type[0] : e.type
    if (!e.path || !PARSE_ERRORS.has(type)) continue
    const starts = (e.spans ?? []).map((s) => s.start.line)
    if (!starts.length) starts.push(Number(/:(\d+):?$/.exec(e.message.split('\n')[0])?.[1]) || 1)
    const file = byPath.get(e.path) ?? { path: e.path, type, lines: [] }
    file.lines = [...new Set([...file.lines, ...starts])].sort((a, b) => a - b)
    byPath.set(e.path, file)
  }
  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  const isTracked = (p) => !tracked || tracked.has(p)
  const allowed = (f) => excused[f.path]?.stretches ?? 0
  return {
    failing: files.filter((f) => isTracked(f.path) && f.lines.length > allowed(f)),
    untracked: files.filter((f) => !isTracked(f.path)),
    stale: Object.entries(excused)
      .map(([path, { stretches }]) => ({ path, stretches, now: byPath.get(path)?.lines.length ?? 0 }))
      .filter((x) => x.now < x.stretches),
  }
}

function main () {
  // The checkout, walked rather than listed through git: a worktree's .git names a host path the
  // container cannot resolve, and Semgrep then scans nothing and reports success. No time limit per
  // rule: check-docs-drift.mjs takes some taint rules past the default 5 s, and three rules timing
  // out on a file skip it for every rule.
  const r = spawnSync('docker', ['run', '--rm', '-v', `${REPO.replace(/\\/g, '/')}:/src:ro`, '-w', '/src', IMAGE,
    'semgrep', 'scan', '--config', 'p/default', '--config', 'p/security-audit', '--metrics', 'off',
    '--no-git-ignore', '--json', '--quiet', '--timeout', '0',
    '--exclude', 'node_modules', '--exclude', '.cache', '--exclude', '*.generated.ts',
    '--exclude', 'coverage', '--exclude', 'dist',
    // Go templates, which no YAML parser reads; the rendered chart is scanned by scan-config.mjs.
    '--exclude', 'deploy/helm/aber/templates'],
  { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  let report
  try { report = JSON.parse(r.stdout) } catch {
    console.error(`semgrep did not produce a report:\n${(r.stderr || '').slice(-1500)}`)
    process.exit(2)
  }
  const scanned = report.paths?.scanned?.length ?? 0
  if (!scanned) {
    console.error('semgrep scanned no files; that is not a pass.')
    process.exit(2)
  }

  const lineOf = (path, n) => {
    try { return readFileSync(join(REPO, path), 'utf8').split('\n')[n - 1]?.trim() ?? '' } catch { return '' }
  }
  const findings = report.results.map((x) => ({
    key: keyOf(x.check_id, x.path, lineOf(x.path, x.start.line)),
    where: `${x.path}:${x.start.line}`,
    severity: x.extra.severity,
    message: (x.extra.message || '').split('\n')[0].slice(0, 160),
  }))
  const allow = JSON.parse(readFileSync(join(REPO, 'scripts/lint/semgrep-allowlist.json'), 'utf8'))
  const keys = new Set(findings.map((f) => f.key))
  const fresh = findings.filter((f) => !(f.key in allow))
  for (const f of fresh) console.log(`  NEW   ${f.severity} ${f.where}\n        ${f.message}\n        key: ${f.key}`)
  for (const k of Object.keys(allow).filter((k) => !keys.has(k))) console.log(`  stale allow-list entry no longer found, delete it: ${k}`)

  // Git lists the tracked files on the host, where a worktree's .git resolves.
  const git = spawnSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 })
  const tracked = git.status === 0 ? new Set(git.stdout.split('\0').filter(Boolean)) : null
  const { failing, untracked, stale } = parseFailures(report.errors, tracked)
  for (const f of failing) {
    const allowed = UNPARSED[f.path] ? `; UNPARSED allows ${UNPARSED[f.path].stretches}` : ''
    console.log(`  UNPARSED ${f.path}:${f.lines.join(',')} (${f.type}${allowed})\n`
      + '        no rule reads what Semgrep cannot parse: rewrite the construct its parser stops at')
  }
  for (const f of untracked) console.log(`  untracked file not wholly parsed: ${f.path}:${f.lines.join(',')}`)
  for (const s of stale) console.log(`  stale UNPARSED entry, ${s.path} now stops ${s.now} time(s), not ${s.stretches}: lower or delete it`)
  for (const e of report.errors.filter((e) => e.path && !PARSE_ERRORS.has(Array.isArray(e.type) ? e.type[0] : e.type))) {
    console.log(`  note: ${e.type} on ${e.path}${e.rule_id ? ` (${e.rule_id.split('.').pop()})` : ''}`)
  }
  const partial = parseFailures(report.errors, tracked, {}).failing.length
  console.log(`\n${scanned} files, ${partial + untracked.length} not wholly parsed (${partial - failing.length} accepted), `
    + `${findings.length} findings: ${findings.length - fresh.length} reviewed, ${fresh.length} new.`)
  process.exit(fresh.length || failing.length ? 1 : 0)
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) main()
