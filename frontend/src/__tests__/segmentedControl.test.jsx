import React, { useState } from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SegmentedControl } from '../components/common/SegmentedControl'
import { IconSun, IconMoon } from '../components/common/Icons'

/**
 * The shared segmented control. What is pinned: on its own it is a WAI-ARIA radio group, one Tab
 * stop whose arrow keys move and choose, wrapping; inside a menu it is a group of menuitemradio
 * items, each a Tab stop, whose Left and Right move without choosing; an icon-only segment is named
 * by its label, which is also its tooltip; and the choice is marked by more than colour.
 */

const OPTIONS = [
  { id: 'all', label: 'All, 4' },
  { id: 'info', label: 'Info, 2', tone: 'accent' },
  { id: 'warning', label: 'Warnings, 1', tone: 'warning' },
  { id: 'alert', label: 'Alerts, 1', tone: 'danger' }
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
    expect(radios.map(r => r.textContent)).toEqual(['All, 4', 'Info, 2', 'Warnings, 1', 'Alerts, 1'])
    expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
  })

  it('is one Tab stop: the chosen segment', () => {
    render(<Controlled initial="warning" />)
    const stops = screen.getAllByRole('radio').map(r => r.tabIndex)
    expect(stops).toEqual([-1, -1, 0, -1])
  })

  it('moves to the next segment and chooses it with Right or Down, wrapping at the end', () => {
    const onChange = vi.fn()
    render(<Controlled initial="warning" onChange={onChange} />)
    act(() => { radio('Warnings, 1').focus() })

    fireEvent.keyDown(radio('Warnings, 1'), { key: 'ArrowRight' })
    expect(radio('Alerts, 1')).toHaveFocus()
    expect(radio('Alerts, 1')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Alerts, 1').tabIndex).toBe(0)

    fireEvent.keyDown(radio('Alerts, 1'), { key: 'ArrowDown' })
    expect(radio('All, 4')).toHaveFocus()
    expect(radio('All, 4')).toHaveAttribute('aria-checked', 'true')
    expect(onChange.mock.calls).toEqual([['alert'], ['all']])
  })

  it('moves back with Left or Up, wrapping at the start', () => {
    render(<Controlled initial="all" />)
    act(() => { radio('All, 4').focus() })
    fireEvent.keyDown(radio('All, 4'), { key: 'ArrowLeft' })
    expect(radio('Alerts, 1')).toHaveFocus()
    expect(radio('Alerts, 1')).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(radio('Alerts, 1'), { key: 'ArrowUp' })
    expect(radio('Warnings, 1')).toHaveAttribute('aria-checked', 'true')
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

  it('names an icon-only segment by its label, and uses the same text as its tooltip', () => {
    render(<Controlled options={[
      { id: 'light', label: 'Light', icon: <IconSun size={14} /> },
      { id: 'dark', label: 'Dark', icon: <IconMoon size={14} /> }
    ]} initial="dark" />)
    const dark = radio('Dark')
    expect(dark).toHaveAttribute('title', 'Dark')
    expect(dark.textContent).toBe('')
    expect(dark.querySelector('.segmented-icon')).toHaveAttribute('aria-hidden', 'true')
  })

  it('marks the choice with a class that fills and borders it, and gives a segment its tone', () => {
    render(<Controlled initial="alert" />)
    expect(radio('Alerts, 1')).toHaveClass('segmented-option', 'segmented-option-checked', 'signal-tone-danger')
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
