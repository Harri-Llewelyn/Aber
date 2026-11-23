/**
 * Which `*.test.mjs` files `npm run test:lib` runs: every one directly inside a folder of FOLDERS.
 * scripts/run-lib-tests.mjs runs them, and it and check-docs-drift 519 refuse any other in the tree
 * that ELSEWHERE does not name. A new lib test is a new file in one of these folders, nothing more.
 *
 * node: built-ins only: CI runs this before any `npm install`.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'

/** The folders test:lib covers, each on its own: a subfolder is not covered until it is listed. */
export const FOLDERS = ['node-red', 'scripts', 'scripts/lib', 'scripts/lint']

/** A `*.test.mjs` outside FOLDERS that something else runs, and what runs it. None today. */
export const ELSEWHERE = {}

/** Never read: installs, build output and git's own folder. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build'])

function walk (repo, dir, out) {
  for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const rel = dir === '.' ? e.name : `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (!existsSync(join(repo, rel, '.git'))) walk(repo, rel, out)
    } else if (e.isFile() && e.name.endsWith('.test.mjs')) {
      out.push(rel)
    }
  }
  return out
}

/**
 * Every `*.test.mjs` in the tree, as repository paths with `/`, sorted. A folder holding a `.git`
 * of its own is another checkout, such as a worktree, and is not read; a link is not followed.
 */
export const testFilesInTree = (repo) => walk(repo, '.', []).sort()

const covered = (file) => FOLDERS.includes(posix.dirname(file))

/** The files test:lib runs, out of `files`. */
export const libTests = (files) => files.filter(covered)

/**
 * What the runner and the drift check refuse, one sentence each, naming the files: a test file no
 * folder covers and ELSEWHERE does not name, and an ELSEWHERE entry that is gone or covered.
 */
export function auditLibTests (files) {
  const unreached = files.filter((f) => !covered(f) && !Object.hasOwn(ELSEWHERE, f))
  const stale = Object.keys(ELSEWHERE).filter((f) => !files.includes(f) || covered(f)).sort()
  const problems = []
  if (unreached.length) {
    problems.push(
      `${unreached.length} *.test.mjs file(s) run nowhere: ${unreached.join(', ')}. Move each into a ` +
      `folder test:lib covers (${FOLDERS.map((f) => `${f}/`).join(', ')}), add its folder to FOLDERS ` +
      'in scripts/lib-tests.mjs, or name what runs it in ELSEWHERE there.'
    )
  }
  if (stale.length) {
    problems.push(
      `ELSEWHERE in scripts/lib-tests.mjs names ${stale.join(', ')}: each is gone from the tree, ` +
      'or test:lib runs it already. Remove its entry.'
    )
  }
  return problems
}
