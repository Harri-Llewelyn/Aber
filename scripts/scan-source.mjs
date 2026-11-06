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
 * So does a tracked file Semgrep never read. What the scan leaves out is .semgrepignore's list,
 * which replaces Semgrep's own (that one leaves out every test/ directory), and every other tracked
 * file must be in the report's paths.scanned. The run passes --max-target-bytes 0, no size limit:
 * past its default of 1 MB, Semgrep drops a file from the scan and reports nothing.
 *
 *   node scripts/scan-source.mjs
 *
 * Interim until the repository is public, when CodeQL's default setup is free (#387). Needs Docker
 * and network access to fetch the rulesets.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'semgrep/semgrep:1.140.0'
export const IGNORE_FILE = '.semgrepignore'

// Semgrep's error types for a file, or a stretch of one, that no parser read.
const PARSE_ERRORS = new Set(['Lexical error', 'Syntax error', 'Other syntax error', 'AST builder error', 'PartialParsing'])

// Tracked files Semgrep parses only in part: how many lines its parser stops at, why, and why the
// lines stay as they are. Each stop is one character Semgrep's bash parser does not read, and it
// reads the rest of the line. A further stop in one of these files, or any other tracked file that
// does not parse, fails the scan. docs/static-analysis.md lists the forms the parser does read.
const SH = "Semgrep's bash parser stops at"
const RW = 'the read-write redirection 3<> that opens a /dev/tcp socket. A one-way < or > would connect too, '
  + 'but offline-check.sh both writes and reads the socket, and each probe opens it the same way.'
export const UNPARSED = {
  'scripts/rehearse-restore.sh': { stretches: 13, reason: `${SH} each < and > in a usage message such as \${1:?usage: backup <dir>}, written as the script's header and usage line write them, and at ${RW}` },
  'supabase/functions/offline-check.sh': { stretches: 2, reason: `${SH} ${RW}` },
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

// Whether one name matches one segment of a pattern: `*` is any run of characters, `?` any one.
const nameMatches = (glob, name) => {
  if (!glob) return !name
  if (glob[0] === '*') return nameMatches(glob.slice(1), name) || (!!name && nameMatches(glob, name.slice(1)))
  return !!name && (glob[0] === '?' || glob[0] === name[0]) && nameMatches(glob.slice(1), name.slice(1))
}

/**
 * An ignore file's patterns as a test of a path: true when the file leaves the path out. Only the
 * part of gitignore's syntax that Semgrep and this test read the same way is accepted: `*` and `?`
 * within a name, a `/` at the start or in the middle to match from the root, and a trailing `/`
 * for a directory. Anything else throws, rather than be read differently from Semgrep.
 */
export function ignoreRules (text) {
  const rules = text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    if (/[\s!\\[\]]|\*\*|^:|\/\//.test(line)) throw new Error(`${IGNORE_FILE}: "${line}" uses syntax this check does not read`)
    const dirOnly = line.endsWith('/')
    const body = dirOnly ? line.slice(0, -1) : line
    return { segments: body.replace(/^\//, '').split('/'), anchored: body.includes('/'), dirOnly }
  })
  // A pattern names the file itself, or a directory above it; a trailing / names only a directory.
  const names = (parts, end, dirOnly) => !(dirOnly && end === parts.length)
  return (path) => {
    const parts = path.split('/')
    return rules.some(({ segments, anchored, dirOnly }) => (anchored
      ? segments.length <= parts.length && names(parts, segments.length, dirOnly)
        && segments.every((glob, i) => nameMatches(glob, parts[i]))
      : parts.some((name, i) => names(parts, i + 1, dirOnly) && nameMatches(segments[0], name))))
  }
}

/**
 * The tracked files the scan did not read as its ignore list says. `missing`: outside the list
 * and not in the report's paths.scanned, which Semgrep does without an error (a size limit, an
 * ignore list of its own). `ignoredButRead`: left out by the list as `ignored` reads it, yet read,
 * so this test and Semgrep read the list differently. `tracked` holds only files on disk.
 */
export function unscanned (tracked, scanned, ignored) {
  const read = new Set(scanned)
  const files = [...tracked].sort()
  return {
    missing: files.filter((p) => !ignored(p) && !read.has(p)),
    ignoredButRead: files.filter((p) => ignored(p) && read.has(p)),
  }
}

function main () {
  // Read here for the check after the run, and by Semgrep from /src for the run: no --exclude, so
  // the file is the one list. Without it Semgrep would apply its own.
  if (!existsSync(join(REPO, IGNORE_FILE))) {
    console.error(`${IGNORE_FILE} is missing, and without it Semgrep leaves out every test/ directory.`)
    process.exit(2)
  }
  const ignored = ignoreRules(readFileSync(join(REPO, IGNORE_FILE), 'utf8'))

  // The checkout, walked rather than listed through git: a worktree's .git names a host path the
  // container cannot resolve, and Semgrep then scans nothing and reports success. No time limit per
  // rule: check-docs-drift.mjs takes some taint rules past the default 5 s, and three rules timing
  // out on a file skip it for every rule.
  const r = spawnSync('docker', ['run', '--rm', '-v', `${REPO.replace(/\\/g, '/')}:/src:ro`, '-w', '/src', IMAGE,
    'semgrep', 'scan', '--config', 'p/default', '--config', 'p/security-audit', '--metrics', 'off',
    '--no-git-ignore', '--json', '--quiet', '--timeout', '0', '--max-target-bytes', '0'],
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

  // Every tracked file on disk, against what Semgrep read. One deleted from the checkout and not
  // yet from git is not there to read.
  const { missing, ignoredButRead } = tracked
    ? unscanned([...tracked].filter((p) => existsSync(join(REPO, p))), report.paths.scanned, ignored)
    : { missing: null, ignoredButRead: [] }
  if (!missing) console.log('  git could not list the tracked files, so nothing shows Semgrep read them all')
  for (const p of missing ?? []) console.log(`  UNSCANNED ${p}`)
  if (missing?.length) {
    console.log(`        tracked and outside ${IGNORE_FILE}, yet Semgrep read none of these and said nothing:`
      + ` find why, or add them to ${IGNORE_FILE} with the reason`)
  }
  for (const p of ignoredButRead) {
    console.log(`  READ ANYWAY ${p}\n        ${IGNORE_FILE} leaves it out, yet Semgrep read it: this script reads the file differently`)
  }
  const partial = parseFailures(report.errors, tracked, {}).failing.length
  console.log(`\n${scanned} files, ${missing ? missing.length : 'unknown'} tracked not read, `
    + `${partial + untracked.length} not wholly parsed (${partial - failing.length} accepted), `
    + `${findings.length} findings: ${findings.length - fresh.length} reviewed, ${fresh.length} new.`)
  process.exit(fresh.length || failing.length || !missing || missing.length || ignoredButRead.length ? 1 : 0)
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) main()
