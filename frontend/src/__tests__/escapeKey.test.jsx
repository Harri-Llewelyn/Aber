import React, { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { useEscapeKey, escapeStackDepth } from '../hooks/useEscapeKey'
import { ConfirmModal } from '../components/modals/ConfirmModal'

/**
 * Escape closes the topmost dismissible layer only. Modals stack (ConfirmModal opens over another
 * dialog), and if each bound its own keydown listener one Escape would dismiss the confirmation and
 * the form that asked for it. Unit tests on the hook, because the invariant is about the
 * relationship between layers.
 */

const Layer = ({ onEscape, active = true, label }) => {
  useEscapeKey(onEscape, active)
  return <div>{label}</div>
}

const esc = () => fireEvent.keyDown(document, { key: 'Escape' })

beforeEach(() => {
  // The stack is module scope. A leak between tests would be a real defect, so assert it is
  // empty rather than resetting it.
  expect(escapeStackDepth()).toBe(0)
})

describe('useEscapeKey', () => {
  it('calls the handler on Escape', () => {
    const onEscape = vi.fn()
    render(<Layer onEscape={onEscape} label="one" />)

    esc()
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('ignores every other key', () => {
    const onEscape = vi.fn()
    render(<Layer onEscape={onEscape} label="one" />)

    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'e' })
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('calls ONLY the topmost layer, so a confirmation does not take its parent with it', () => {
    const parent = vi.fn()
    const child = vi.fn()
    render(
      <>
        <Layer onEscape={parent} label="parent" />
        <Layer onEscape={child} label="child" />
      </>
    )

    esc()
    expect(child).toHaveBeenCalledTimes(1)
    expect(parent).not.toHaveBeenCalled()
  })

  it('hands control back to the layer below once the top one unmounts', () => {
    const parent = vi.fn()
    const child = vi.fn()
    const { rerender } = render(
      <>
        <Layer onEscape={parent} label="parent" />
        <Layer onEscape={child} label="child" />
      </>
    )
    rerender(<><Layer onEscape={parent} label="parent" /></>)

    esc()
    expect(parent).toHaveBeenCalledTimes(1)
    expect(child).not.toHaveBeenCalled()
  })

  it('leaves the stack when a layer unmounts', () => {
    const { unmount } = render(<Layer onEscape={vi.fn()} label="one" />)
    expect(escapeStackDepth()).toBe(1)
    unmount()
    expect(escapeStackDepth()).toBe(0)
  })

  // A drawer that is mounted-but-closed must not answer for a dialog that is actually open.
  // ContextPanel is always mounted so its width can animate, so this is not hypothetical.
  it('does not take the top of the stack while inactive', () => {
    const inactive = vi.fn()
    const active = vi.fn()
    render(
      <>
        <Layer onEscape={active} label="dialog" />
        <Layer onEscape={inactive} active={false} label="closed drawer" />
      </>
    )

    expect(escapeStackDepth()).toBe(1)
    esc()
    expect(active).toHaveBeenCalledTimes(1)
    expect(inactive).not.toHaveBeenCalled()
  })

  it('joins the stack when it becomes active, and leaves when it stops', () => {
    const onEscape = vi.fn()
    const { rerender } = render(<Layer onEscape={onEscape} active={false} label="drawer" />)
    expect(escapeStackDepth()).toBe(0)

    rerender(<Layer onEscape={onEscape} active label="drawer" />)
    expect(escapeStackDepth()).toBe(1)

    rerender(<Layer onEscape={onEscape} active={false} label="drawer" />)
    expect(escapeStackDepth()).toBe(0)
    esc()
    expect(onEscape).not.toHaveBeenCalled()
  })

  /**
   * The handler is held in a ref: callers pass inline arrows, so if the effect depended on callback
   * identity every parent render would pop and re-push the layer.
   */
  it('does not re-order the stack when a parent re-renders with a new callback', () => {
    const parent = vi.fn()
    const child = vi.fn()

    const Host = () => {
      const [, setTick] = useState(0)
      return (
        <>
          <Layer onEscape={() => parent()} label="parent" />
          <Layer onEscape={() => child()} label="child" />
          <button onClick={() => setTick(t => t + 1)}>re-render</button>
        </>
      )
    }
    render(<Host />)

    fireEvent.click(screen.getByRole('button', { name: 're-render' }))
    fireEvent.click(screen.getByRole('button', { name: 're-render' }))

    expect(escapeStackDepth()).toBe(2)
    esc()
    expect(child).toHaveBeenCalledTimes(1)
    expect(parent).not.toHaveBeenCalled()
  })

  it('binds one document listener regardless of how many layers are open', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')

    const { unmount } = render(
      <>
        <Layer onEscape={vi.fn()} label="a" />
        <Layer onEscape={vi.fn()} label="b" />
        <Layer onEscape={vi.fn()} label="c" />
      </>
    )

    const added = add.mock.calls.filter(c => c[0] === 'keydown')
    expect(added.length).toBe(1)

    unmount()
    expect(remove.mock.calls.filter(c => c[0] === 'keydown').length).toBe(1)

    add.mockRestore()
    remove.mockRestore()
  })
})

describe('ConfirmModal — Escape is Cancel, never Confirm', () => {
  it('cancels on Escape', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<ConfirmModal message="Delete everything?" onConfirm={onConfirm} onCancel={onCancel} />)

    esc()
    expect(onCancel).toHaveBeenCalledTimes(1)
    // The whole point of the key: it is the safe answer. A destructive dialog that took Escape
    // as agreement would be the worst possible reading of a key people press to back out.
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('is the layer that answers when it opens over another dialog', () => {
    const parentClose = vi.fn()
    const onCancel = vi.fn()

    render(
      <>
        <Layer onEscape={parentClose} label="the form underneath" />
        <ConfirmModal message="Discard?" onConfirm={vi.fn()} onCancel={onCancel} />
      </>
    )

    esc()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(parentClose).not.toHaveBeenCalled()

    // And the form is still there to be answered about.
    expect(screen.getByText('the form underneath')).toBeInTheDocument()
  })
})

/**
 * Coverage, asserted against the source: the failure mode is a new dialog that never gets the hook,
 * which no test of the existing ones can see. This walks every file that paints a `.modal-overlay`.
 */
describe('every modal is dismissible', () => {
  const SRC = path.resolve(__dirname, '..')

  const jsxFiles = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === '__tests__' ? [] : jsxFiles(p)
      return e.name.endsWith('.jsx') ? [p] : []
    })

  const renderers = jsxFiles(SRC)
    .map(p => [p, fs.readFileSync(p, 'utf8')])
    .filter(([, s]) => s.includes('className="modal-overlay"'))

  it('finds the modal renderers to check', () => {
    // A guard on the guard: if the class is ever renamed, the list silently empties and every
    // assertion below passes by having nothing to assert.
    expect(renderers.length).toBeGreaterThanOrEqual(15)
  })

  it.each(renderers.map(([p]) => path.relative(SRC, p)))('%s closes on Escape', (rel) => {
    const source = renderers.find(([p]) => path.relative(SRC, p) === rel)[1]
    expect(source).toMatch(/useEscapeKey\(/)
  })

  // A file reaching for `document.addEventListener('keydown'` directly is opting out of the
  // ordering, and the bug is invisible until two layers are open at once.
  it('binds no keydown listeners of its own', () => {
    const offenders = renderers
      .filter(([, s]) => /addEventListener\(\s*'keydown'/.test(s))
      .map(([p]) => path.relative(SRC, p))

    expect(offenders).toEqual([])
  })
})

/**
 * The modal width scale. The steps are named after the content that earns them, so a new dialog
 * picks a category rather than an inline number.
 */
describe('modal widths come from the scale, not from inline numbers', () => {
  const SRC = path.resolve(__dirname, '..')
  const APP_CSS = fs.readFileSync(path.join(SRC, 'App.css'), 'utf8')

  const jsxFiles = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === '__tests__' ? [] : jsxFiles(p)
      return e.name.endsWith('.jsx') ? [p] : []
    })

  it('leaves no dialog setting its own maxWidth', () => {
    const offenders = jsxFiles(SRC)
      .map(p => [path.relative(SRC, p), fs.readFileSync(p, 'utf8')])
      .filter(([, s]) => /className="modal[^"]*"\s+style=\{\{[^}]*maxWidth/.test(s))
      .map(([rel]) => rel)

    expect(offenders).toEqual([])
  })

  it('defines each step exactly once, in App.css', () => {
    for (const [cls, px] of [
      ['.modal-sm', 400], ['.modal', 480], ['.modal-md', 560],
      ['.modal-lg', 640], ['.modal-xl', 720], ['.modal-wide', 900]
    ]) {
      const block = APP_CSS.match(new RegExp(`\\n\\${cls} \\{([\\s\\S]*?)\\n\\}`))
      expect(block, cls).toBeTruthy()
      expect(block[1], cls).toMatch(new RegExp(`max-width:\\s*${px}px`))
    }
  })

  // Every step inherits the height cap from `.modal`, so widening a dialog can never be what
  // pushes its title off the top of the viewport -- the failure this cap was added to fix.
  it('caps height and scrolls internally on the base rule every step inherits', () => {
    const base = APP_CSS.match(/\n\.modal \{([\s\S]*?)\n\}/)[1]
    expect(base).toMatch(/max-height:\s*calc\(100vh - 48px\)/)
    expect(base).toMatch(/overflow-y:\s*auto/)
  })
})
