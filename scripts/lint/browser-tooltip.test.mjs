// The ESLint rule that keeps the browser's tooltip out of the dashboard (scripts/lint/eslint.config.mjs):
// a `title` on an HTML element or an icon is an error, a component's `title` prop is not, and
// nothing in the dashboard is let off it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEslint, REPO } from './load-eslint.mjs'

const { ESLint, config } = await loadEslint()
const eslint = new ESLint({ cwd: REPO, overrideConfigFile: true, overrideConfig: config })

const FIXTURE = `import React from 'react'
import { Modal } from './Modal'

export function Fixture () {
  return (
    <Modal title="Edit Metric" onClose={() => {}}>
      <abbr title="Overall Equipment Effectiveness">OEE</abbr>
      <button type="button" title="Save the metric">Save</button>
    </Modal>
  )
}
`

/** Every .jsx file under `dir`. */
const listJsx = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
  ? listJsx(join(dir, e.name))
  : e.name.endsWith('.jsx') ? [join(dir, e.name)] : [])

/** The rule's errors on the fixture, linted as a new file in `dir`. */
const tooltipErrors = async (dir, text = FIXTURE) => {
  const [result] = await eslint.lintText(text, { filePath: join(REPO, dir, 'Fixture.jsx') })
  return result.messages.filter(m => m.ruleId === 'no-restricted-syntax')
}

test("a title on a button is an error, and neither a component's title prop nor an abbr's is", async () => {
  const errors = await tooltipErrors('frontend/src/components/common')
  assert.equal(errors.length, 1, JSON.stringify(errors))
  assert.equal(errors[0].line, 8)
  assert.equal(errors[0].severity, 2)
  assert.match(errors[0].message, /<Tooltip>/)
})

test('a title on an icon is an error too, since every Icon* passes it to its <svg>', async () => {
  const icon = `import React from 'react'
import { IconArchive } from './Icons'

export const Fixture = () => <IconArchive size={12} title="Archived" />
`
  const errors = await tooltipErrors('frontend/src/components/common', icon)
  assert.equal(errors.length, 1, JSON.stringify(errors))
  assert.equal(errors[0].line, 4)
})

test('the rule reaches a new file anywhere in frontend/src', async () => {
  for (const dir of ['frontend/src', 'frontend/src/components/modals', 'frontend/src/pages']) {
    assert.equal((await tooltipErrors(dir)).length, 1, dir)
  }
})

test('no file is let off the rule, and an exception on a line says why', async () => {
  // The allow-list is the selector's: <abbr> and <iframe>. A block turning the rule off for some
  // files would hide every browser tooltip in them.
  const offBlocks = config.filter(block => block.rules?.['no-restricted-syntax'] === 'off')
  assert.deepEqual(offBlocks.map(block => block.files), [])
  // A line may be let off with a reason, as a link whose text is its address is.
  const unexplained = []
  for (const file of listJsx(join(REPO, 'frontend', 'src'))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/eslint-disable(-next)?-line no-restricted-syntax/.test(line) && !/ -- \S/.test(line)) unexplained.push(`${file}:${i + 1}`)
    })
  }
  assert.deepEqual(unexplained, [])
})

test('the whole dashboard carries no browser tooltip', async () => {
  const results = await eslint.lintFiles(['frontend/src'])
  const found = results.flatMap(r => r.messages
    .filter(m => m.ruleId === 'no-restricted-syntax')
    .map(m => `${r.filePath}:${m.line}`))
  assert.deepEqual(found, [])
})
