/**
 * WHICH PYTHON SUITE RUNS WHERE, AND WHY.
 *
 * =================================================================================================
 * WHY THIS FILE EXISTS
 *
 * `ci.yml` used to name every Python suite in its own `run:` step. A hand-maintained list is a list
 * that falls behind, and this one had: 47 suites in the three directories anybody looked at, 21
 * named in the workflows, and TWENTY with no runner anywhere once `timescaledb/` and
 * `gateway-credential/` were counted too -- thousands of lines of assertions executed by nothing
 * (#147).
 *
 * The suites that fell off were disproportionately the ones guarding faults that were SILENT when
 * they happened, which is exactly why somebody sat down and wrote a suite for them.
 * `test_startup_healer.py` opens by explaining that its fault had two consequences and "both of its
 * consequences were silent in opposite directions". The suite written to stop that recurring did
 * not run.
 *
 * The frontend already had the answer: `npm test` hands vitest a DIRECTORY and vitest discovers.
 * So discovery is the fix here too -- but discovery alone cannot answer "and where should it run",
 * which is the question the 21 hand-written steps were really answering. This file is that answer,
 * stated once, in a place both the runner and the drift guard read: a header at the top of each
 * suite file, which this file reads (WHERE A SUITE SAYS WHICH LANE IT IS IN, below).
 *
 * =================================================================================================
 * A SUITE IS STILL ONE PROCESS. `python <file>`, EXACTLY AS BEFORE.
 *
 * The obvious move is `pytest ingestion/`, and it was tried. It works today -- all 424 ingestion
 * tests pass in one interpreter. It is still not what this does, for reasons that are not taste:
 *
 *   * THREE SUITES DO REAL WORK IN `if __name__ == "__main__"`. test_aas_api.py,
 *     test_aas_export.py and test_fplus_directory.py tear down the AAS fixture they provisioned
 *     there, AFTER the report, so a failing run still leaves its console output intact. pytest and
 *     `unittest discover` both skip that block outright. Against a live stack either one would
 *     leave provisioned rows behind on every run, and nothing would say so.
 *
 *   * THE SUITES SHARE MUTABLE MODULE STATE. They stub protobuf/paho/psycopg2 with
 *     `sys.modules.setdefault` and then rebind attributes on the imported module -- so the SECOND
 *     suite to load `ingestion` in a process gets the first one's stubs and whatever it left set.
 *     That happens to be harmless right now. It is harmless by luck, not by construction, and the
 *     failure it would eventually produce is a suite passing against a module some other file
 *     configured.
 *
 *   * pytest is not a dependency of this repository. It is installed in CI for exactly ONE suite
 *     -- ingestion/test_cold_archive.py, which is written in its style and declares
 *     `runner: pytest` in its header -- and making it the runner for everything would mean the two
 *     problems above, for the other fifty-two, to buy nothing they need.
 *
 * One process per suite keeps today's semantics precisely and buys discovery anyway. The startup
 * cost is about 300ms a suite, against a CI job measured in minutes.
 *
 * =================================================================================================
 * WHERE A SUITE SAYS WHICH LANE IT IS IN
 *
 * At the top of the suite file, after any `#!` or coding line and before the module docstring:
 *
 *     # suite:
 *     #   lanes: db, stack
 *     #   runner: pytest
 *     #   why: The reason, which may wrap onto lines that start with five spaces after the
 *     #     hash, and is read as one line.
 *     #
 *     # Anything after a bare `#` line is a note for the reader and is not read.
 *
 * `lanes` and `why` are required. `runner` is optional (RUNNERS, below). Another field, or a
 * line of the block this reader cannot place, is an error that names the file. A suite is one
 * file, so a new suite is a new header and no shared list changes: two branches that each add
 * a suite never edit the same lines.
 *
 * =================================================================================================
 * THE LANES
 *
 *   unit   Needs nothing. No database, no broker, no stack. Runs in `edge-function-auth-test`.
 *   db     Needs the migrated Supabase Postgres and no seed. Runs in `edge-function-auth-test`
 *          against its `services.postgres`, and locally against `npm run test:db`'s throwaway
 *          container -- the SAME image and the SAME bootstrap, which is why one lane covers both.
 *   stack  Needs a running stack (scripts/dev-cluster.mjs test). Runs
 *          in `e2e-validation`.
 *   manual Deliberately has no automated runner. Must say why.
 *
 * A SUITE MAY DECLARE MORE THAN ONE LANE, and four do. test_aas_export.py, test_aas_api.py and
 * test_fplus_directory.py each hold an offline layer that always runs and a live layer that skips
 * itself for want of a stack; test_gateway_enrollment.py asserts against seeded accounts that only
 * e2e has. Running them in both places is not duplication -- the two runs check different things.
 *
 * =================================================================================================
 * THE VACUOUS-GREEN RULE, WHICH DECIDED SEVEN OF THESE PLACEMENTS
 *
 * ci.yml already states this trap where `REQUIRE_SEEDED_ACCOUNTS` is set: "A fully-skipped unittest
 * run reports `OK (skipped=6)` and exits 0, so without the flag a stack that had lost its seed
 * would give this step a green tick while checking nothing."
 *
 * The same trap decides where a suite is allowed to live. Measured with no stack up:
 *
 *     test_enroll_gateway.py            Ran 14 tests   skipped=14
 *     test_gateway_bundle.py            Ran 15 tests   skipped=15
 *     test_gateway_credential.py        Ran 13 tests   skipped=13
 *     test_historian_role_grants.py     Ran  0 tests   skipped=2
 *     test_bi_reader_grants.py          Ran  1 test    skipped=4
 *
 * Every one of those is `stack`, NOT `unit`. Putting them in the unit lane would have added five
 * green steps asserting nothing -- which is a worse outcome than the orphaning this file fixes,
 * because an orphaned suite at least does not claim to have run.
 *
 * Related: scripts/run-python-suites.mjs (the runner; `--list` prints every suite with its lanes
 *          and reason), scripts/check-docs-drift.mjs check 4b (the static guard),
 *          docs/testing.md (how to run them).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every lane a suite may declare. `manual` is the escape hatch and must carry a reason. */
export const LANES = ['unit', 'db', 'stack', 'manual']

/**
 * How a suite is spawned. Default is `script` -- `python <file>` -- which is what every suite here
 * is written for: a unittest module with an `if __name__ == "__main__"` block.
 *
 * `pytest` exists for the single file that is not (ingestion/test_cold_archive.py). It is a
 * per-suite override rather than a global runner switch on purpose: collecting the whole tree with
 * pytest would skip the `__main__` blocks that two other suites use to tear down provisioned
 * fixtures. See this file's header.
 */
export const RUNNERS = ['script', 'pytest']

/** The fields of a suite header, and what each may hold. */
const FIELDS = ['lanes', 'runner', 'why']

/**
 * The suite header at the top of a Python file's text (the format is described in this file's
 * header). `null` where the file has none, `{ error }` where it has one this cannot read, else
 * `{ suite: { lanes, why, runner? } }`: the lanes in the order written, the reason as one line.
 */
export function parseSuiteHeader(text) {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && (/^#!/.test(lines[i]) || /^#.*coding[:=]/.test(lines[i]))) i += 1
  if (lines[i] !== '# suite:') return null
  const fields = {}
  let current = null
  for (i += 1; i < lines.length && lines[i].startsWith('#'); i += 1) {
    const field = lines[i].match(/^# {3}(\S+): ?(.*)$/)
    const more = lines[i].match(/^# {5}(\S.*)$/)
    if (field) {
      if (!FIELDS.includes(field[1])) return { error: `the header has a field "${field[1]}"; the fields are ${FIELDS.join(', ')}` }
      if (field[1] in fields) return { error: `the header has "${field[1]}" twice` }
      fields[field[1]] = field[2].trim()
      current = field[1]
    } else if (more && current === 'why') {
      fields.why += ` ${more[1].trim()}`
    } else if (more) {
      return { error: `the header continues "${current}" onto a line; only "why" wraps` }
    } else {
      break
    }
  }
  const suite = { lanes: (fields.lanes ?? '').split(',').map((l) => l.trim()).filter(Boolean), why: fields.why ?? '' }
  if (fields.runner !== undefined) suite.runner = fields.runner
  return { suite }
}

// Not ours: node_modules holds Python in vendored packages, and the rest are builds and caches.
const SKIPPED = new Set(['node_modules', '.git', '.cache', '.venv', 'venv', '__pycache__', 'dist', 'build'])

function pythonFiles(dir = '', out = []) {
  for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) pythonFiles(rel, out)
    else if (entry.name.endsWith('.py')) out.push(rel)
  }
  return out
}

/**
 * path -> { lanes, why, runner? }, read from the header of each Python file that has one, in path
 * order. `why` is the prose that used to sit above the suite's `run:` step in ci.yml. It is kept
 * because it is the part a reader cannot reconstruct: not what the suite tests -- the suite's own
 * docstring says that -- but why it is worth a CI job's time, and what a regression in it would look
 * like from outside. Most of these were written by whoever fixed the thing the suite now guards.
 *
 * HEADER_ERRORS: path -> why the header of that file could not be read.
 */
export const HEADER_ERRORS = {}
export const SUITES = {}
for (const path of pythonFiles().sort()) {
  const read = parseSuiteHeader(readFileSync(join(REPO, path), 'utf8'))
  if (!read) continue
  if (read.error) HEADER_ERRORS[path] = read.error
  else SUITES[path] = read.suite
}

/**
 * Compare the suites' headers against the tree, IN BOTH DIRECTIONS.
 *
 * One-directional is what failed before. A check that only asks "does every header name a suite"
 * certifies the half somebody remembered to write down -- it is blind to the new suite nobody
 * added, which is the entire failure in #147. The service directory check in
 * check-docs-drift.mjs learned this the same way and says so.
 *
 * @param {string[]} allFiles repo-relative paths, forward slashes
 * @returns {{orphans: string[], phantoms: string[], badLanes: string[], badRunners: string[],
 *            unexplained: string[], badHeaders: string[]}}
 */
export function auditSuites(allFiles) {
  const inTree = allFiles.filter((f) => /(^|\/)test_[a-z0-9_]+\.py$/.test(f))
  const declared = Object.keys(SUITES)

  return {
    // In the tree, with no header. These are the suites that run nowhere.
    orphans: inTree.filter((f) => !SUITES[f] && !HEADER_ERRORS[f]).sort(),
    // A header in a file that is not a suite in the tree. A stale header makes the orphan count read low.
    phantoms: declared.filter((f) => !inTree.includes(f)).sort(),
    // A typo in a lane name would silently exclude a suite from every runner.
    badLanes: declared
      .filter((f) => !SUITES[f].lanes?.length || SUITES[f].lanes.some((l) => !LANES.includes(l)))
      .sort(),
    // A misspelt runner would fall back to `python <file>`, which for a pytest-style suite means
    // running nothing at all and reporting success.
    badRunners: declared
      .filter((f) => SUITES[f].runner && !RUNNERS.includes(SUITES[f].runner))
      .sort(),
    // `manual` is allowed, but only out loud.
    unexplained: declared.filter((f) => !SUITES[f].why?.trim()).sort(),
    // A header this file cannot read, with what is wrong: the file would otherwise look like an orphan.
    badHeaders: Object.entries(HEADER_ERRORS).map(([f, e]) => `${f}: ${e}`).sort(),
  }
}

/** The suites to run for a lane, in a stable order. */
export function suitesInLane(lane) {
  return Object.entries(SUITES)
    .filter(([, s]) => s.lanes.includes(lane))
    .map(([path]) => path)
    .sort()
}
