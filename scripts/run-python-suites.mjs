#!/usr/bin/env node
/**
 * Run every Python suite in a lane, each in its own process.
 *
 * =================================================================================================
 * WHAT THIS REPLACED
 *
 * Twenty-one `run:` steps in ci.yml, each naming one suite. That list fell twenty behind the tree
 * (#147) and nothing noticed, because a list that is not compared to anything cannot be wrong --
 * it can only be incomplete, silently. The suites are now DISCOVERED from the tree and placed by
 * scripts/python-suites.mjs, which is also where the reasoning that used to sit above each step
 * now lives.
 *
 *   node scripts/run-python-suites.mjs --lane unit
 *   node scripts/run-python-suites.mjs --lane db
 *   node scripts/run-python-suites.mjs --lane stack
 *   node scripts/run-python-suites.mjs --lane unit --list      (print, run nothing)
 *   node scripts/run-python-suites.mjs --lane unit --filter tls
 *
 * =================================================================================================
 * THE AUDIT RUNS FIRST, AND IT IS THE POINT
 *
 * Before a single suite runs, the tree is compared against the manifest IN BOTH DIRECTIONS and a
 * mismatch is fatal. This is deliberate and it is the whole guard: a new `test_*.py` committed
 * without a lane fails the FIRST job that runs Python, naming the file, rather than sitting
 * unexecuted for months. check-docs-drift.mjs makes the same assertion earlier and more cheaply;
 * this one is the backstop that cannot be skipped by a job ordering change, because the runner
 * refuses to run a tree it cannot account for.
 *
 * A suite that genuinely should not run anywhere declares `lanes: ['manual']` with a reason. That
 * is a decision somebody made and wrote down, which is the difference between this and what it
 * replaced.
 *
 * =================================================================================================
 * ONE PROCESS PER SUITE
 *
 * `python <file>`, exactly as the hand-written steps did, for the reasons python-suites.mjs sets
 * out at length: two suites tear down fixtures in `if __name__ == "__main__"`, which no collecting
 * runner executes, and the suites share mutable module state that only happens to be harmless.
 *
 * NO ENVIRONMENT IS INVENTED HERE. The db lane needs `SUPABASE_DB_*`, the stack lane needs the
 * cluster's credentials and its ports forwarded (scripts/dev-cluster.mjs test) -- and both of
 * those are properties of the CALLER, not of the lane. CI
 * sets them at the step; scripts/test-db.mjs sets them around its throwaway container. A runner
 * that guessed would send a suite at the wrong database and fail naming a missing table.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LANES, RUNNERS, SUITES, auditSuites, suitesInLane } from './python-suites.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}

const lane = flag('--lane')
const filter = flag('--filter')
const listOnly = argv.includes('--list')

const c = process.stdout.isTTY
  ? { bold: (s) => `\x1b[1m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` }
  : { bold: (s) => s, red: (s) => s, green: (s) => s, dim: (s) => s }

const die = (msg) => { console.error(`\n${c.red('error:')} ${msg}\n`); process.exit(1) }

if (!lane) die(`--lane is required. One of: ${LANES.join(', ')}`)
if (!LANES.includes(lane)) die(`unknown lane "${lane}". One of: ${LANES.join(', ')}`)

// -------------------------------------------------------------------------------------------
// Walk the tree
// -------------------------------------------------------------------------------------------
// SKIPS THE DIRECTORIES THAT ARE NOT OURS. node_modules holds Python in vendored packages, and
// `archive/` holds retired migrations whose suites went with them. Both would report as orphans.
const IGNORED = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build'])

function walk(dir, out = []) {
  for (const entry of readdirSync(join(REPO, dir))) {
    if (IGNORED.has(entry)) continue
    const rel = dir === '.' ? entry : `${dir}/${entry}`
    if (statSync(join(REPO, rel)).isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

const allFiles = walk('.')

// -------------------------------------------------------------------------------------------
// The audit -- fatal, and before anything runs
// -------------------------------------------------------------------------------------------
const audit = auditSuites(allFiles)

if (audit.orphans.length) {
  console.error(c.red(`\n${audit.orphans.length} Python suite(s) have no lane in scripts/python-suites.mjs:`))
  for (const f of audit.orphans) console.error(c.red(`  ${f}`))
  console.error(
    '\nA suite with no lane runs nowhere. Give it one -- unit (needs nothing), db (needs the\n' +
    'migrated Postgres), stack (needs a running stack) -- or `manual` with a reason saying\n' +
    'why it is deliberately not automated.\n'
  )
}
if (audit.phantoms.length) {
  console.error(c.red(`\n${audit.phantoms.length} manifest entr(ies) name a file that does not exist:`))
  for (const f of audit.phantoms) console.error(c.red(`  ${f}`))
  console.error('\nA stale entry makes the orphan count read low, which is the failure this guard exists to catch.\n')
}
if (audit.badLanes.length) {
  console.error(c.red(`\n${audit.badLanes.length} manifest entr(ies) declare no lane or an unknown one:`))
  for (const f of audit.badLanes) console.error(c.red(`  ${f}`))
}
if (audit.badRunners.length) {
  console.error(c.red(`\n${audit.badRunners.length} manifest entr(ies) declare an unknown runner:`))
  for (const f of audit.badRunners) console.error(c.red(`  ${f}`))
  console.error(`\nOne of: ${RUNNERS.join(', ')}. An unrecognised value would fall back to the`)
  console.error('script form, which for a pytest-style suite means running nothing and passing.\n')
}
if (audit.unexplained.length) {
  console.error(c.red(`\n${audit.unexplained.length} manifest entr(ies) carry no reason:`))
  for (const f of audit.unexplained) console.error(c.red(`  ${f}`))
}
if (
  audit.orphans.length || audit.phantoms.length || audit.badLanes.length ||
  audit.badRunners.length || audit.unexplained.length
) {
  process.exit(1)
}

// -------------------------------------------------------------------------------------------
// Run the lane
// -------------------------------------------------------------------------------------------
let suites = suitesInLane(lane)
if (filter) suites = suites.filter((s) => s.includes(filter))

if (suites.length === 0) {
  // NOT AN ERROR FOR A FILTER, which is a deliberate narrowing by whoever typed it. An empty LANE
  // is different: it means every suite that used to run here has been moved, and a job quietly
  // asserting nothing is exactly what this file exists to prevent.
  if (filter) { console.log(`No suite in lane "${lane}" matches "${filter}".`); process.exit(0) }
  die(`lane "${lane}" contains no suites. A job running an empty lane is a green tick over nothing.`)
}

if (listOnly) {
  for (const s of suites) console.log(s)
  process.exit(0)
}

const python = process.env.PYTHON || 'python'

console.log(
  `\n${c.bold(`Running ${suites.length} Python suite(s) in lane "${lane}"`)}` +
  c.dim(`  (${allFiles.filter((f) => /(^|\/)test_[a-z0-9_]+\.py$/.test(f)).length} suites in the tree, all accounted for)\n`)
)

/**
 * How to spawn one suite.
 *
 * `-q` on the pytest form and nothing on the script form, because the script form's verbosity is
 * the SUITE's own choice -- several pass `verbosity=2` to unittest.main() deliberately, and a
 * runner overriding that would be re-deciding something the suite already decided.
 */
const argvFor = (suite) =>
  SUITES[suite].runner === 'pytest' ? ['-m', 'pytest', suite, '-q'] : [suite]

// -------------------------------------------------------------------------------------------
// pytest is PROBED FOR ONCE, UP FRONT, when this lane holds a suite that needs it.
//
// It is checked here rather than inferred from the run's exit code because the two cases are
// indistinguishable that way: `python -m pytest` on a machine without it prints "No module named
// pytest" and exits 1, which is exactly what a failing test exits. The reader would be sent to
// the assertions of a suite that never ran.
//
// AND THE ABSENCE HAS TO BE FATAL RATHER THAN A SKIP. The one suite that declares this runner has
// no `if __name__ == "__main__"` block, so the obvious fallback -- run it as a script -- executes
// nothing and exits 0. Degrading to that would turn a missing dependency into a passing step,
// which is the failure this whole file exists to make impossible.
// -------------------------------------------------------------------------------------------
if (suites.some((s) => SUITES[s].runner === 'pytest')) {
  const probe = spawnSync(python, ['-c', 'import pytest'], { cwd: REPO, stdio: 'ignore' })
  if (probe.error) die(`could not run ${python}: ${probe.error.message}. Set PYTHON to override.`)
  if (probe.status !== 0) {
    const needs = suites.filter((s) => SUITES[s].runner === 'pytest')
    die(
      `pytest is not installed, and ${needs.length} suite(s) in lane "${lane}" are written for ` +
      `it:\n       ${needs.join('\n       ')}\n\n` +
      '       They assert NOTHING when run as a plain script -- no `__main__` block -- so this\n' +
      '       is fatal rather than a skip: degrading would turn a missing dependency into a\n' +
      '       green step. `pip install pytest`.'
    )
  }
}

const failed = []
for (const suite of suites) {
  const viaPytest = SUITES[suite].runner === 'pytest'
  console.log(c.bold(`── ${suite}`) + (viaPytest ? c.dim('  (pytest)') : ''))
  const result = spawnSync(python, argvFor(suite), { cwd: REPO, env: process.env, stdio: 'inherit' })
  // A MISSING INTERPRETER IS NOT A FAILING SUITE. spawnSync reports ENOENT with a null status,
  // which the `!== 0` test below would file under "test_x.py failed" and send the reader to a
  // perfectly good suite.
  if (result.error) die(`could not run ${python}: ${result.error.message}. Set PYTHON to override.`)
  if (result.status !== 0) failed.push(suite)
}

console.log('')
if (failed.length) {
  console.log(c.red(`${failed.length} of ${suites.length} suite(s) failed in lane "${lane}":`))
  for (const s of failed) console.log(c.red(`  ${s}`))
  process.exit(1)
}
console.log(c.green(`All ${suites.length} suite(s) passed in lane "${lane}".`))
