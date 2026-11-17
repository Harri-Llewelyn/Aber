import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApplyResults } from '../components/common/ApplyResults'
import { parseAutomationsYaml } from '../utils/automationYaml'
import { resultChanges } from '../utils/automations'

/**
 * The list an apply dialog draws for each item of a file. It draws a change's old and new value only when
 * the dialog hands it `changesOf`, so the Schemas and Automations dialogs, which do not, are as they were.
 */

const parsed = parseAutomationsYaml('- name: A/RATE\n  kind: counter_rate\n')
const changed = {
  index: 0, name: 'A/RATE', status: 'changed', reasons: [],
  changes: ['description'], before: { description: 'Parts an hour' }, after: { description: null },
}
const unchanged = { index: 1, name: 'A/OTHER', status: 'unchanged', reasons: [], changes: [], before: {}, after: {} }

const draw = (props = {}) => render(
  <ApplyResults results={[unchanged, changed]} parsed={parsed} label="What each would become" nameOf={r => r.name} noteOf={() => null} {...props} />
)

describe('ApplyResults', () => {
  it('draws no before and after without changesOf, and a changed result is its head alone', () => {
    draw()
    const list = screen.getByRole('list', { name: 'What each would become' })
    expect(within(list).getAllByRole('listitem').filter(li => li.classList.contains('apply-result'))).toHaveLength(2)
    expect(screen.queryByText('Before')).toBeNull()
    expect(screen.queryByText('After')).toBeNull()
    expect(document.querySelector('.apply-diffs')).toBeNull()
  })

  it('draws each changed key under the head of its result, with Before and After in words', () => {
    draw({ changesOf: resultChanges })
    const diffs = screen.getByRole('list', { name: 'What changes in A/RATE' })
    const block = within(diffs)
    expect(block.getByText('Description')).toBeInTheDocument()
    expect(block.getByText('Before').nextElementSibling).toHaveTextContent('Parts an hour')
    expect(block.getByText('After').nextElementSibling).toHaveTextContent('None')
    // The head comes first, then the change: the status is a word, not a colour.
    const item = diffs.closest('.apply-result')
    expect(item.firstElementChild).toHaveClass('apply-result-head')
    expect(item.firstElementChild).toHaveTextContent('Changed')
    expect(item.children[1]).toBe(diffs)
  })

  it('draws a result that changesOf gives nothing for as its head alone', () => {
    draw({ changesOf: resultChanges })
    expect(screen.getAllByRole('list', { name: /^What changes in / })).toHaveLength(1)
    expect(screen.queryByRole('list', { name: 'What changes in A/OTHER' })).toBeNull()
  })

  it('says None for a missing or empty side, and keeps the lines of a text that has several', () => {
    const lines = { ...changed, before: { description: null }, after: { description: 'One.\nTwo.' } }
    render(<ApplyResults results={[lines]} parsed={parsed} label="Lines" nameOf={r => r.name} changesOf={resultChanges} />)
    const diffs = within(screen.getByRole('list', { name: 'What changes in A/RATE' }))
    expect(diffs.getByText('Before').nextElementSibling).toHaveTextContent('None')
    expect(diffs.getByText('After').nextElementSibling.textContent).toBe('One.\nTwo.')
  })

  it('takes any key a change names, and shows a value that is not text as JSON', () => {
    const result = { ...changed, changes: ['enabled'], before: { enabled: false }, after: { enabled: true } }
    render(<ApplyResults results={[result]} parsed={parsed} label="Any" nameOf={r => r.name} changesOf={resultChanges} />)
    const diffs = within(screen.getByRole('list', { name: 'What changes in A/RATE' }))
    expect(diffs.getByText('Enabled')).toBeInTheDocument()
    expect(diffs.getByText('Before').nextElementSibling).toHaveTextContent('false')
    expect(diffs.getByText('After').nextElementSibling).toHaveTextContent('true')
  })
})

describe('resultChanges', () => {
  it('lists one entry for each key a result changes, with its old and new value', () => {
    expect(resultChanges(changed)).toEqual([{ key: 'description', label: 'Description', before: 'Parts an hour', after: null }])
  })

  it('words a key with an underscore, and gives null for a value the result does not hold', () => {
    expect(resultChanges({ changes: ['semantic_id'], before: {}, after: { semantic_id: 'x' } }))
      .toEqual([{ key: 'semantic_id', label: 'Semantic id', before: null, after: 'x' }])
  })

  it('lists nothing for a result with no changes, or none given', () => {
    expect(resultChanges(unchanged)).toEqual([])
    expect(resultChanges({ status: 'new' })).toEqual([])
    expect(resultChanges(undefined)).toEqual([])
  })
})
