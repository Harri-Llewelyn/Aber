// The ESLint rule that keeps the browser's tooltip out of the dashboard (scripts/lint/eslint.config.mjs):
// a `title` on an HTML element is an error, a component's `title` prop is not, and the files it
// lets through are the ones that still carry one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

test('the rule reaches a new file anywhere in frontend/src', async () => {
  for (const dir of ['frontend/src', 'frontend/src/components/modals', 'frontend/src/pages']) {
    assert.equal((await tooltipErrors(dir)).length, 1, dir)
  }
})

test('every file the rule lets through still carries a title, so the list only shrinks', async () => {
  const allowed = config
    .filter(block => block.rules?.['no-restricted-syntax'] === 'off')
    .flatMap(block => block.files)
  const strict = new ESLint({
    cwd: REPO,
    overrideConfigFile: true,
    overrideConfig: config.filter(block => block.rules?.['no-restricted-syntax'] !== 'off'),
  })
  const clean = []
  for (const path of allowed) {
    // A file another change deletes drops out of the list with it.
    if (!existsSync(join(REPO, path))) continue
    const text = readFileSync(join(REPO, path), 'utf8')
    const [result] = await strict.lintText(text, { filePath: join(REPO, path) })
    if (!result.messages.some(m => m.ruleId === 'no-restricted-syntax')) clean.push(path)
  }
  assert.deepEqual(clean, [], 'these carry no title now: take them off the list in scripts/lint/eslint.config.mjs')
})
