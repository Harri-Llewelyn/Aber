/**
 * The order the check runners run their modules in, and the names they refuse.
 *
 *     node --test scripts/lib/numbered-modules.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { numberedModules } from './numbered-modules.mjs'

function directory (...names) {
  const dir = mkdtempSync(join(tmpdir(), 'numbered-modules-'))
  for (const name of names) writeFileSync(join(dir, name), 'export default () => {}\n')
  return dir
}

test('modules run in number order, and a lettered number follows its own', () => {
  const dir = directory(
    'lib.mjs', '010e-e.mjs', '011cter-t.mjs', '004b-b.mjs', '010d2-d2.mjs', '005-five.mjs', '011c-c.mjs',
    '004-four.mjs', '010d-d.mjs', '011cbis-b.mjs', '102-high.mjs', '009-nine.mjs',
  )
  try {
    assert.deepEqual(numberedModules(dir).map((m) => m.id), [
      '004', '004b', '005', '009', '010d', '010d2', '010e', '011c', '011cbis', '011cter', '102',
    ])
  } finally { rmSync(dir, { recursive: true }) }
})

test('lib.mjs is shared code and runs no check', () => {
  const dir = directory('lib.mjs', '001-one.mjs')
  try {
    assert.deepEqual(numberedModules(dir).map((m) => m.file), ['001-one.mjs'])
  } finally { rmSync(dir, { recursive: true }) }
})

test('a file that is not named for a check is refused, so no check sits unrun', () => {
  const dir = directory('001-one.mjs', 'notes.mjs')
  try {
    assert.throws(() => numberedModules(dir), /notes\.mjs is not a check module/)
  } finally { rmSync(dir, { recursive: true }) }
})

test('two files with one number are refused', () => {
  const dir = directory('363-first.mjs', '363-second.mjs')
  try {
    assert.throws(() => numberedModules(dir), /both hold number 363/)
  } finally { rmSync(dir, { recursive: true }) }
})
