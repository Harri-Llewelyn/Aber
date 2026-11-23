#!/usr/bin/env node
/**
 * Run every lib test in one `node --test`: the `*.test.mjs` files scripts/lib-tests.mjs finds.
 *
 *   node scripts/run-lib-tests.mjs                          (what `npm run test:lib` runs)
 *   node scripts/run-lib-tests.mjs --test-reporter=dot      (any other argument goes to node --test)
 *   node scripts/run-lib-tests.mjs --list                   (the paths alone; runs nothing)
 *
 * Each file is named by its path: `node --test <folder>` discovers differently on Windows and
 * reports the folder itself as one failing test. A test file no folder covers stops the run.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FOLDERS, auditLibTests, libTests, testFilesInTree } from './lib-tests.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const listOnly = argv.includes('--list')
const forNode = argv.filter((a) => a !== '--list')

const die = (msg) => { console.error(`\nerror: ${msg}\n`); process.exit(1) }

const inTree = testFilesInTree(REPO)
const problems = auditLibTests(inTree)
if (problems.length) die(problems.join('\n\n       '))

const files = libTests(inTree)
// No files would be a passing run that tested nothing.
if (files.length === 0) die(`no *.test.mjs file in ${FOLDERS.join(', ')}`)

if (listOnly) {
  for (const f of files) console.log(f)
  process.exit(0)
}

console.log(`Running ${files.length} lib test file(s) from ${FOLDERS.map((f) => `${f}/`).join(', ')}\n`)
const result = spawnSync(process.execPath, ['--test', ...forNode, ...files], { cwd: REPO, stdio: 'inherit' })
if (result.error) die(`could not run node --test: ${result.error.message}`)
process.exit(result.status ?? 1)
