import fs from 'node:fs'
import path from 'node:path'
import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TabStrip } from '../components/common/TabStrip'

const TABS = [
  { id: 'a', label: 'Alpha', count: 3, title: 'First' },
  { id: 'b', label: 'Beta', count: 0 },
  { id: 'c', label: 'Gamma' },
]

function Harness({ placement }) {
  const [value, setValue] = useState('a')
  return <TabStrip tabs={TABS} value={value} onChange={setValue} ariaLabel="Letters" placement={placement} />
}

describe('TabStrip', () => {
  it('is a labelled tablist of tabs with one selected', () => {
    render(<Harness />)
    expect(screen.getByRole('tablist', { name: 'Letters' })).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map(t => t.tabIndex)).toEqual([0, -1, -1])
    expect(tabs[0].title).toBe('First')
  })

  it('draws the count pill, zero included, and none when absent', () => {
    render(<Harness />)
    expect(screen.getByRole('tab', { name: 'Alpha 3' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Beta 0' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Gamma' }).querySelector('.section-count')).toBeNull()
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
    key('Alpha 3', 'ArrowRight')
    expect(screen.getByRole('tab', { name: 'Beta 0' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Beta 0' }))
    key('Beta 0', 'ArrowLeft')
    key('Alpha 3', 'ArrowLeft')
    expect(screen.getByRole('tab', { name: 'Gamma' }).getAttribute('aria-selected')).toBe('true')
    key('Gamma', 'ArrowRight')
    expect(screen.getByRole('tab', { name: 'Alpha 3' }).getAttribute('aria-selected')).toBe('true')
  })

  it('jumps with Home and End', () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha 3' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Gamma' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Gamma' }), { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'Alpha 3' }).getAttribute('aria-selected')).toBe('true')
  })

  it('wraps, and takes the page or card placement', () => {
    const { rerender } = render(<Harness />)
    const strip = screen.getByRole('tablist')
    expect(strip.className).toContain('tab-strip')
    expect(strip.className).toContain('tab-strip-page')
    rerender(<Harness placement="card" />)
    expect(screen.getByRole('tablist').className).toContain('tab-strip-card')
  })

  it('declares the wrapping in CSS', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
    expect(css.match(/\n\.tab-strip \{([\s\S]*?)\n\}/)[1]).toMatch(/flex-wrap:\s*wrap/)
  })
})
