import fs from 'node:fs'
import path from 'node:path'
import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TabStrip } from '../components/common/TabStrip'

const TABS = [
  { id: 'a', label: 'Alpha', description: 'The first letter.', attention: 3 },
  { id: 'b', label: 'Beta', description: 'The second letter.', attention: 0 },
  { id: 'c', label: 'Gamma' },
]

function Harness() {
  const [value, setValue] = useState('a')
  return <TabStrip tabs={TABS} value={value} onChange={setValue} ariaLabel="Letters" />
}

describe('TabStrip', () => {
  it('is a labelled tablist of tabs with one selected', () => {
    render(<Harness />)
    expect(screen.getByRole('tablist', { name: 'Letters' })).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map(t => t.tabIndex)).toEqual([0, -1, -1])
  })

  it('describes each tab with its own tooltip, and no tab has a browser tooltip', () => {
    render(<Harness />)
    const [alpha, beta, gamma] = screen.getAllByRole('tab')
    expect(alpha).toHaveAccessibleDescription('The first letter.')
    expect(beta).toHaveAccessibleDescription('The second letter.')
    // The waiting count stays in the name; the description adds to it.
    expect(alpha).toHaveAccessibleName('Alpha, 3 waiting')
    for (const tab of [alpha, beta, gamma]) expect(tab).not.toHaveAttribute('title')
    // A tab with no description has none, rather than an empty one.
    expect(gamma).not.toHaveAttribute('aria-describedby')
    // A tooltip is closed until the tab is pointed at or reached by keyboard.
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('ignores a `title` handed to it, so no tab shows two tooltips', () => {
    render(<TabStrip ariaLabel="Letters" value="a" onChange={() => {}} tabs={[{ id: 'a', label: 'Alpha', title: 'Old', description: 'New.' }]} />)
    expect(screen.getByRole('tab')).not.toHaveAttribute('title')
  })

  it('shows attention only above 0, with an icon, the number and a name that carries it', () => {
    render(<Harness />)
    const alpha = screen.getByRole('tab', { name: 'Alpha, 3 waiting' })
    expect(alpha.className).toContain('tab-strip-tab-attention')
    expect(alpha.querySelector('svg')).toBeTruthy()
    expect(alpha.querySelector('.tab-strip-attention').textContent).toBe('3')
    for (const name of ['Beta', 'Gamma']) {
      const tab = screen.getByRole('tab', { name })
      expect(tab.className).not.toContain('tab-strip-tab-attention')
      expect(tab.querySelector('svg')).toBeNull()
    }
  })

  it('carries no count pill', () => {
    render(<Harness />)
    expect(document.querySelector('.section-count')).toBeNull()
  })

  it('selects on click', () => {
    const onChange = vi.fn()
    render(<TabStrip tabs={TABS} value="a" onChange={onChange} ariaLabel="Letters" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Gamma' }))
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('moves and selects with the arrow keys, wrapping at the ends', () => {
    render(<Harness />)
    const key = (name, k) => fireEvent.keyDown(screen.getByRole('tab', { name }), { key: k })
    key('Alpha, 3 waiting', 'ArrowRight')
    expect(screen.getByRole('tab', { name: 'Beta' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Beta' }))
    key('Beta', 'ArrowLeft')
    key('Alpha, 3 waiting', 'ArrowLeft')
    expect(screen.getByRole('tab', { name: 'Gamma' }).getAttribute('aria-selected')).toBe('true')
    key('Gamma', 'ArrowRight')
    expect(screen.getByRole('tab', { name: 'Alpha, 3 waiting' }).getAttribute('aria-selected')).toBe('true')
  })

  it('jumps with Home and End', () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha, 3 waiting' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Gamma' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Gamma' }), { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'Alpha, 3 waiting' }).getAttribute('aria-selected')).toBe('true')
  })

  it('marks the selected tab and has one style', () => {
    render(<Harness />)
    expect(screen.getByRole('tablist').className).toBe('tab-strip-tabs')
    expect(screen.getByRole('tablist').parentElement.className).toBe('tab-strip')
    expect(screen.getByRole('tab', { name: 'Alpha, 3 waiting' }).className).toContain('tab-strip-tab-selected')
    expect(screen.getByRole('tab', { name: 'Beta' }).className).not.toContain('tab-strip-tab-selected')
  })

  /* Each tab explains itself, before it is opened, so the bar holds the tablist and nothing else,
     whatever a caller passes. */
  it('draws nothing after the tabs: no trailing "?"', () => {
    render(<TabStrip ariaLabel="Sections" value="a" onChange={() => {}} tabs={TABS} help={<button>About Alpha</button>} />)
    expect(screen.queryByRole('button', { name: 'About Alpha' })).toBeNull()
    const strip = screen.getByRole('tablist').parentElement
    expect([...strip.children]).toEqual([screen.getByRole('tablist')])
    // The tooltips are portalled out of the card, so the tablist holds only tabs.
    expect([...screen.getByRole('tablist').children].every(c => c.getAttribute('role') === 'tab')).toBe(true)
  })

  it('declares the wrapping in CSS', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
    expect(css.match(/\n\.tab-strip \{([\s\S]*?)\n\}/)[1]).toMatch(/flex-wrap:\s*wrap/)
  })
})
