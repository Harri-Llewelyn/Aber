/**
 * useOpenGroups, which the Metric Catalog, the Vocabulary page and the Entities page keep their groups by,
 * and what a GroupHeading says beside its name on them: its count and its words together, a tooltip of its
 * own, and the secondary colour for a remainder.
 */
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { GroupHeading } from '../components/common/GroupHeading'
import { useOpenGroups } from '../hooks/useOpenGroups'
import { tooltipOf } from '../test/tooltips'

describe('useOpenGroups', () => {
  const start = (narrowed = false, startsOpen) =>
    renderHook(({ narrowed: n, startsOpen: s }) => useOpenGroups(n, s), { initialProps: { narrowed, startsOpen } })
  const open = (hook) => ['a', 'b'].filter(key => hook.result.current.isOpen(key))

  it('starts every group closed, and toggles one without another', () => {
    const hook = start()
    expect(open(hook)).toEqual([])
    act(() => hook.result.current.toggle('a'))
    expect(open(hook)).toEqual(['a'])
    act(() => hook.result.current.toggle('a'))
    expect(open(hook)).toEqual([])
  })

  it('opens every group while something narrows the list, but one closed then', () => {
    const hook = start(true)
    expect(open(hook)).toEqual(['a', 'b'])
    act(() => hook.result.current.toggle('a'))
    expect(open(hook)).toEqual(['b'])
  })

  it('opens a group for a search though it was closed before one, and puts it back after', () => {
    const hook = start()
    act(() => hook.result.current.setOpen(['a', 'b'], true))
    act(() => hook.result.current.toggle('b'))
    hook.rerender({ narrowed: true })
    expect(open(hook)).toEqual(['a', 'b'])
    act(() => hook.result.current.setOpen(['a', 'b'], false))
    expect(open(hook)).toEqual([])
    hook.rerender({ narrowed: false })
    expect(open(hook)).toEqual(['a'])
    // What was closed in that search is open in the next.
    hook.rerender({ narrowed: true })
    expect(open(hook)).toEqual(['a', 'b'])
  })

  it('takes a group that starts open on its own, until it is closed', () => {
    const hook = start(false, key => key === 'b')
    expect(open(hook)).toEqual(['b'])
    act(() => hook.result.current.toggle('b'))
    expect(open(hook)).toEqual([])
  })

  it('lets a list say which start open while it is narrowed too', () => {
    const hook = start(true, key => key === 'b')
    expect(open(hook)).toEqual(['b'])
  })
})

describe('a GroupHeading', () => {
  const button = () => screen.getByRole('button')

  it('says its count and then its words, each in its own place, to a reader and to a screen reader', () => {
    render(<GroupHeading open label="Gateways" count={81} countLabel="81 gateways" detail="last deleted 25 Nov" onToggle={() => {}} />)
    expect(button()).toHaveAccessibleName('Gateways, 81 gateways, last deleted 25 Nov')
    const [count, words] = [...document.querySelectorAll('.group-heading-count')]
    expect(count.querySelector('[aria-hidden]')).toHaveTextContent('· 81')
    expect(words.querySelector('[aria-hidden] .overflow-text')).toHaveTextContent('· last deleted 25 Nov')
  })

  it('has a tooltip of its own, which describes it', () => {
    render(<GroupHeading open={false} label="Axes" count={3} title={'Metrics named "Axes/…"'} onToggle={() => {}} />)
    expect(tooltipOf(button())).toBe('Metrics named "Axes/…"')
    expect(button()).toHaveAccessibleDescription('Metrics named "Axes/…"')
  })

  it('shows words that are cut in place of that tooltip', () => {
    render(<GroupHeading open={false} label="Axes" detail="a line too long for it" title="Metrics" onToggle={() => {}} />)
    const line = document.querySelector('.group-heading-detail .overflow-text')
    Object.defineProperty(line, 'scrollWidth', { configurable: true, value: 400 })
    Object.defineProperty(line, 'clientWidth', { configurable: true, value: 120 })
    fireEvent.focusIn(button())
    expect(screen.getByRole('tooltip')).toHaveTextContent('a line too long for it')
  })

  it('is drawn in the secondary colour where its group is a remainder', () => {
    const { rerender } = render(<GroupHeading open={false} label="Ungrouped" muted onToggle={() => {}} />)
    expect(screen.getByText('Ungrouped')).toHaveClass('table-group-label', 'table-group-label-muted')
    rerender(<GroupHeading open={false} label="Axes" onToggle={() => {}} />)
    expect(screen.getByText('Axes')).not.toHaveClass('table-group-label-muted')
  })
})

/** jsdom lays nothing out, so what a stylesheet rule does is read from it. */
describe('the rules the groups are laid out by', () => {
  const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
  /** The body of the first rule whose selector is exactly `selector`. */
  const ruleOf = (selector) => {
    const at = APP_CSS.indexOf(`\n${selector} {`)
    return at < 0 ? '' : APP_CSS.slice(APP_CSS.indexOf('{', at) + 1, APP_CSS.indexOf('}', at))
  }

  it('wrap a long name on a row of its own, which a lane\'s label column cuts', () => {
    expect(ruleOf('.group-heading-label')).toContain('white-space: nowrap')
    expect(ruleOf('.vocab-section-head .group-heading-label')).toContain('white-space: normal')
    expect(APP_CSS).toContain('\n.table-group-row .group-heading-label,\n.vocab-section-head .group-heading-label {')
    expect(ruleOf('.vocab-section-head > .table-group-button')).toContain('min-width: 0')
  })

  it('give the Entities page\'s tabs the same widths for the columns they share, scrollbar or none', () => {
    expect(ruleOf('.table-entities')).toContain('table-layout: fixed')
    expect(ruleOf('.table-entities th:nth-child(-n + 2)')).toMatch(/width: [0-9]+%/)
    // The scroller also holds the rows' screen-reader words, or they lengthen the page.
    const scroller = ruleOf('.table-wrap:has(> .table-entities)')
    expect(scroller).toContain('scrollbar-gutter: stable')
    expect(scroller).toContain('position: relative')
  })
})
