import React, { useState } from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SegmentedControl } from '../components/common/SegmentedControl'
import { IconSun, IconMoon } from '../components/common/Icons'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\r\n/g, '\n')
/** The body of the rule whose selector starts a line and is exactly `selector`. */
const rule = (selector) => {
  const at = APP_CSS.indexOf(`\n${selector} {`)
  if (at < 0) return undefined
  const open = at + selector.length + 3
  return APP_CSS.slice(open, APP_CSS.indexOf('}', open))
}

/**
 * The shared segmented control. What is pinned: on its own it is a WAI-ARIA radio group, one Tab
 * stop whose arrow keys move and choose, wrapping; inside a menu it is a group of menuitemradio
 * items, each a Tab stop, whose Left and Right move without choosing; every segment shows its icon
 * and its name, and its accessible name and tooltip start with that name, with the count after it;
 * and the choice is marked by more than colour.
 */

const OPTIONS = [
  { id: 'all', label: 'All', count: 4 },
  { id: 'info', label: 'Info', count: 2, tone: 'accent' },
  { id: 'warning', label: 'Warnings', count: 1, tone: 'warning' }
]

function Controlled({ initial = 'all', menu = false, options = OPTIONS, onChange }) {
  const [value, setValue] = useState(initial)
  return (
    <SegmentedControl
      label="Show"
      value={value}
      menu={menu}
      options={options}
      onChange={(next) => { onChange?.(next); setValue(next) }}
    />
  )
}

const radio = (name) => screen.getByRole('radio', { name })

describe('SegmentedControl as a radio group', () => {
  it('is a radio group named by its label, with the chosen segment checked', () => {
    render(<Controlled initial="info" />)
    const group = screen.getByRole('radiogroup', { name: 'Show' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map(r => r.textContent)).toEqual(['All', 'Info', 'Warnings'])
    expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  })

  it('is one Tab stop: the chosen segment', () => {
    render(<Controlled initial="warning" />)
    const stops = screen.getAllByRole('radio').map(r => r.tabIndex)
    expect(stops).toEqual([-1, -1, 0])
  })

  it('moves to the next segment and chooses it with Right or Down, wrapping at the end', () => {
    const onChange = vi.fn()
    render(<Controlled initial="info" onChange={onChange} />)
    act(() => { radio('Info, 2').focus() })

    fireEvent.keyDown(radio('Info, 2'), { key: 'ArrowRight' })
    expect(radio('Warnings, 1')).toHaveFocus()
    expect(radio('Warnings, 1')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Warnings, 1').tabIndex).toBe(0)

    fireEvent.keyDown(radio('Warnings, 1'), { key: 'ArrowDown' })
    expect(radio('All, 4')).toHaveFocus()
    expect(radio('All, 4')).toHaveAttribute('aria-checked', 'true')
    expect(onChange.mock.calls).toEqual([['warning'], ['all']])
  })

  it('moves back with Left or Up, wrapping at the start', () => {
    render(<Controlled initial="all" />)
    act(() => { radio('All, 4').focus() })
    fireEvent.keyDown(radio('All, 4'), { key: 'ArrowLeft' })
    expect(radio('Warnings, 1')).toHaveFocus()
    expect(radio('Warnings, 1')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(radio('Warnings, 1'), { key: 'ArrowUp' })
    expect(radio('Info, 2')).toHaveAttribute('aria-checked', 'true')
  })

  it('chooses on a click, and ignores keys that are not arrows', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    fireEvent.keyDown(radio('All, 4'), { key: 'Home' })
    fireEvent.keyDown(radio('All, 4'), { key: 'a' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(radio('Info, 2'))
    expect(onChange).toHaveBeenCalledWith('info')
    expect(radio('Info, 2')).toHaveAttribute('aria-checked', 'true')
  })

  it('shows each segment\'s icon beside its name, and names it starting with that word', () => {
    render(<Controlled options={[
      { id: 'all', label: 'All', count: 4, icon: <IconSun size={14} /> },
      { id: 'info', label: 'Info', count: 2, icon: <IconMoon size={14} /> }
    ]} />)
    const info = radio('Info, 2')
    expect(info.querySelector('.segmented-icon svg')).toBeTruthy()
    expect(info.querySelector('.segmented-icon')).toHaveAttribute('aria-hidden', 'true')
    expect(info.querySelector('.segmented-label')).toHaveTextContent('Info')
    // WCAG 2.5.3: the accessible name starts with the visible word, so "Info" chooses it by voice.
    expect(info.getAttribute('aria-label').startsWith(info.textContent)).toBe(true)
    expect(info).toHaveAttribute('title', 'Info, 2')
  })

  it('names a segment with no count by its visible name alone', () => {
    render(<Controlled options={[
      { id: 'light', label: 'Light', icon: <IconSun size={14} /> },
      { id: 'dark', label: 'Dark', icon: <IconMoon size={14} /> }
    ]} initial="dark" />)
    const dark = radio('Dark')
    expect(dark.textContent).toBe('Dark')
    expect(dark).not.toHaveAttribute('aria-label')
    expect(dark).toHaveAttribute('title', 'Dark')
    expect(dark.querySelector('.segmented-icon')).toHaveAttribute('aria-hidden', 'true')
  })

  it('marks the choice with a class that fills and borders it, and gives a segment its tone', () => {
    render(<Controlled initial="warning" />)
    expect(radio('Warnings, 1')).toHaveClass('segmented-option', 'segmented-option-checked', 'signal-tone-warning')
    expect(radio('All, 4')).not.toHaveClass('segmented-option-checked')
    expect(radio('All, 4').className).not.toMatch(/signal-tone/)
  })
})

describe('SegmentedControl in a menu', () => {
  const item = (name) => screen.getByRole('menuitemradio', { name })
  const renderMenu = (onChange) => render(
    <div role="menu">
      <Controlled menu initial="dark" onChange={onChange} options={[
        { id: 'light', label: 'Light', icon: <IconSun size={14} /> },
        { id: 'dark', label: 'Dark', icon: <IconMoon size={14} /> }
      ]} />
    </div>
  )

  it('is a group of menuitemradio items, every one a Tab stop like the menu\'s other items', () => {
    renderMenu()
    const group = within(screen.getByRole('menu')).getByRole('group', { name: 'Show' })
    const items = within(group).getAllByRole('menuitemradio')
    expect(items.map(i => i.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    expect(items.map(i => i.tabIndex)).toEqual([0, 0])
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('moves between the items with Left and Right without choosing, and leaves Up and Down to the menu', () => {
    const onChange = vi.fn()
    renderMenu(onChange)
    act(() => { item('Dark').focus() })
    fireEvent.keyDown(item('Dark'), { key: 'ArrowRight' })
    expect(item('Light')).toHaveFocus()
    fireEvent.keyDown(item('Light'), { key: 'ArrowLeft' })
    expect(item('Dark')).toHaveFocus()
    fireEvent.keyDown(item('Dark'), { key: 'ArrowDown' })
    expect(item('Dark')).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('chooses with a click, which is what Enter and Space do on a button', () => {
    const onChange = vi.fn()
    renderMenu(onChange)
    fireEvent.click(item('Light'))
    expect(onChange).toHaveBeenCalledWith('light')
    expect(item('Light')).toHaveAttribute('aria-checked', 'true')
    expect(item('Light').tagName).toBe('BUTTON')
  })
})

/** Where it is drawn, asserted against App.css because jsdom does no layout. */
describe('the stylesheet', () => {
  it('spaces a segment\'s name from its icon', () => {
    expect(rule('.segmented-option')).toMatch(/gap:\s*5px/)
  })

  it('stretches the filter and the theme switch across their rows, sharing them equally', () => {
    for (const row of ['.notif-filter', '.user-popover-theme']) {
      expect(rule(`${row} .segmented`)).toMatch(/display:\s*flex/)
      expect(rule(`${row} .segmented-option`)).toMatch(/flex:\s*1/)
    }
  })

  it('gives the theme row no indent for a label it no longer has', () => {
    expect(rule('.user-popover-theme')).toMatch(/padding:\s*5px 12px;/)
  })
})
