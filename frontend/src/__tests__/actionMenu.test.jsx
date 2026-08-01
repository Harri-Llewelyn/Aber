import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ActionMenu } from '../components/common/ActionMenu'

const items = (overrides = {}) => [
  { key: 'a', label: 'First', onClick: overrides.onFirst || vi.fn() },
  { key: 'b', label: 'Second', onClick: overrides.onSecond || vi.fn() },
  { separator: true },
  {
    key: 'c',
    label: 'Restricted',
    disabled: true,
    title: 'Requires Admin permissions',
    onClick: overrides.onRestricted || vi.fn()
  }
]

const open = () => fireEvent.click(screen.getByRole('button', { name: /More actions/i }))

describe('ActionMenu', () => {
  it('stays closed until the trigger is clicked', () => {
    render(<ActionMenu items={items()} />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    open()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('renders into document.body, escaping the scroll container that would clip it', () => {
    // .table-wrap is overflow-x:auto, so a menu rendered inside the row is clipped to a sliver.
    // Asserting the portal directly, because the visual symptom is invisible to jsdom.
    const { container } = render(
      <div style={{ overflowX: 'auto' }}><ActionMenu items={items()} /></div>
    )
    open()
    const menu = screen.getByRole('menu')
    expect(container.contains(menu)).toBe(false)
    expect(document.body.contains(menu)).toBe(true)
    expect(menu.style.position).toBe('fixed')
  })

  it('fires an item and closes', () => {
    const onFirst = vi.fn()
    render(<ActionMenu items={items({ onFirst })} />)
    open()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'First' }))

    expect(onFirst).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not fire a disabled item, but keeps its explanation', () => {
    const onRestricted = vi.fn()
    render(<ActionMenu items={items({ onRestricted })} />)
    open()

    const item = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Restricted' })
    expect(item.disabled).toBe(true)
    // The reason is the useful part -- it reads better here than on a greyed-out row button.
    expect(item.title).toBe('Requires Admin permissions')
    fireEvent.click(item)
    expect(onRestricted).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    render(<ActionMenu items={items()} />)
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on an outside click but not on a click inside itself', () => {
    render(<div><span data-testid="outside">elsewhere</span><ActionMenu items={items()} /></div>)
    open()

    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on scroll, since a fixed menu would otherwise drift from its row', () => {
    render(<ActionMenu items={items()} />)
    open()
    fireEvent.scroll(document, {})
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('drops a separator left leading, trailing or doubled by a filtered-out item', () => {
    // Callers build lists with `condition && {...}`, so neighbours disappear and a bare rule is
    // left behind -- which reads as a missing item rather than as a divider.
    render(
      <ActionMenu items={[
        { separator: true },
        { key: 'only', label: 'Only' },
        { separator: true },
        false,
        { separator: true }
      ]} />
    )
    open()
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    expect(within(menu).queryAllByRole('separator')).toHaveLength(0)
  })

  it('disables the trigger when nothing actionable remains', () => {
    render(<ActionMenu items={[{ separator: true }, false]} />)
    expect(screen.getByRole('button', { name: /More actions/i }).disabled).toBe(true)
  })

  it('is disabled while the caller reports work in progress', () => {
    render(<ActionMenu items={items()} label="Exporting…" disabled />)
    const trigger = screen.getByRole('button', { name: /Exporting…/i })
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('marks the trigger as a menu button for assistive technology', () => {
    render(<ActionMenu items={items()} />)
    const trigger = screen.getByRole('button', { name: /More actions/i })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    open()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })
})
