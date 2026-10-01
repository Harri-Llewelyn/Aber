import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { Modal } from '../components/common/Modal'
import { ConfirmModal } from '../components/modals/ConfirmModal'
import { RestoreMetricModal } from '../components/modals/RestoreMetricModal'

const esc = () => fireEvent.keyDown(document, { key: 'Escape' })

describe('Modal', () => {
  it('is a labelled, modal dialog whose name is its title', () => {
    render(<Modal title="Rename area" onClose={vi.fn()}>body</Modal>)

    const dialog = screen.getByRole('dialog', { name: 'Rename area' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(document.getElementById(labelledBy)).toHaveTextContent('Rename area')
  })

  it('gives two open dialogs different label ids', () => {
    render(<><Modal title="One" onClose={vi.fn()} /><Modal title="Two" onClose={vi.fn()} /></>)
    const [a, b] = screen.getAllByRole('dialog')
    expect(a.getAttribute('aria-labelledby')).not.toBe(b.getAttribute('aria-labelledby'))
  })

  it('renders the lead, the body, the error and the footer in that order', () => {
    render(
      <Modal title="T" onClose={vi.fn()} lead="Lead text" error="It broke" footer={<button>Go</button>}>
        <p>Body text</p>
      </Modal>
    )
    const text = screen.getByRole('dialog').textContent
    expect(text.indexOf('Lead text')).toBeLessThan(text.indexOf('Body text'))
    expect(text.indexOf('Body text')).toBeLessThan(text.indexOf('It broke'))
    expect(text.indexOf('It broke')).toBeLessThan(text.indexOf('Go'))
    expect(screen.getByRole('button', { name: 'Go' }).closest('.modal-actions')).toBeTruthy()
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    render(<Modal title="T" onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    esc()
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('answers Escape in the topmost dialog only', () => {
    const below = vi.fn()
    const top = vi.fn()
    render(<><Modal title="Below" onClose={below} /><Modal title="Top" onClose={top} /></>)

    esc()
    expect(top).toHaveBeenCalledTimes(1)
    expect(below).not.toHaveBeenCalled()
  })

  describe('a click on the overlay', () => {
    it('does nothing by default, so a form keeps its edits', () => {
      const onClose = vi.fn()
      render(<Modal title="T" onClose={onClose} />)
      fireEvent.click(document.querySelector('.modal-overlay'))
      expect(onClose).not.toHaveBeenCalled()
    })

    it('closes a dialog that opts in, and not a click inside it', () => {
      const onClose = vi.fn()
      render(<Modal title="T" onClose={onClose} closeOnOverlay>body</Modal>)

      fireEvent.click(screen.getByRole('dialog'))
      expect(onClose).not.toHaveBeenCalled()
      fireEvent.click(document.querySelector('.modal-overlay'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('shows an error as an alert, and nothing when there is none', () => {
    const { rerender } = render(<Modal title="T" onClose={vi.fn()} />)
    expect(screen.queryByRole('alert')).toBeNull()

    rerender(<Modal title="T" onClose={vi.fn()} error="Could not save" />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not save')
    expect(alert).toHaveClass('modal-error')
  })

  it.each([
    ['sm', 'modal-sm'], ['md', 'modal-md'], ['lg', 'modal-lg'], ['xl', 'modal-xl'], ['wide', 'modal-wide']
  ])('maps size %s onto the width scale', (size, cls) => {
    render(<Modal title="T" size={size} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveClass('modal', cls)
  })

  it('is the default 480px step when no size is given', () => {
    render(<Modal title="T" onClose={vi.fn()} />)
    expect(screen.getByRole('dialog').className.trim()).toBe('modal')
  })

  it('raises the overlay above the ordinary layer for the confirm layer, in CSS not inline', () => {
    render(<Modal title="T" layer="confirm" onClose={vi.fn()} />)
    const overlay = document.querySelector('.modal-overlay')
    expect(overlay).toHaveClass('modal-overlay-confirm')
    expect(overlay.getAttribute('style')).toBeNull()

    const css = fs.readFileSync(path.resolve(__dirname, '..', 'App.css'), 'utf8')
    expect(css).toMatch(/\.modal-overlay-confirm \{ z-index: 1100; \}/)
  })

  describe('keeps the header and the footer in view', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '..', 'App.css'), 'utf8')
    const rule = selector => {
      const at = css.indexOf(`\n${selector} {`)
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
    }

    it('lays out header row, a body holding the lead and children, then error and footer', () => {
      render(
        <Modal title="T" onClose={vi.fn()} lead="Lead text" error="It broke" footer={<button>Go</button>}>
          <p>Body text</p>
        </Modal>
      )
      const dialog = screen.getByRole('dialog')
      expect([...dialog.children].map(c => c.className)).toEqual([
        'modal-header-row', 'modal-body', 'modal-error', 'modal-actions'
      ])
      const body = dialog.querySelector('.modal-body')
      expect(body).toHaveTextContent('Lead text')
      expect(body).toHaveTextContent('Body text')
      expect(body).not.toHaveTextContent('It broke')
      expect(body.querySelector('.modal-actions')).toBeNull()
    })

    it('marks a filling body only when asked', () => {
      const { rerender } = render(<Modal title="T" onClose={vi.fn()}>x</Modal>)
      expect(document.querySelector('.modal-body')).not.toHaveClass('modal-body-fill')
      rerender(<Modal title="T" fill onClose={vi.fn()}>x</Modal>)
      expect(document.querySelector('.modal-body')).toHaveClass('modal-body-fill')
    })

    it('makes the body the scroller, and not the dialog', () => {
      expect(rule('.modal-body')).toMatch(/overflow-y:\s*auto/)
      expect(rule('.modal-body')).toMatch(/min-height:\s*0/)
      expect(rule('.modal')).toMatch(/display:\s*flex/)
      expect(rule('.modal')).toMatch(/flex-direction:\s*column/)
      expect(rule('.modal')).toMatch(/max-height:/)
      expect(rule('.modal')).not.toMatch(/overflow/)
      for (const sel of ['.modal-header-row', '.modal-error', '.modal-actions']) {
        expect(rule(sel)).toMatch(/flex:\s*none/)
      }
    })
  })

  it('puts header actions beside the close button', () => {
    render(<Modal title="T" onClose={vi.fn()} headerActions={<button>Export</button>} />)
    const row = document.querySelector('.modal-header-row')
    expect(within(row).getByRole('button', { name: 'Export' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Close' })).toBeTruthy()
  })
})

describe('ConfirmModal on the shell', () => {
  it('names the act in its title, and falls back to a plain one', () => {
    const { rerender } = render(
      <ConfirmModal title="Delete backup" message="Sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />
    )
    expect(screen.getByRole('dialog', { name: 'Delete backup' })).toBeTruthy()

    rerender(<ConfirmModal message="Sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Confirm action' })).toBeTruthy()
  })

  it('sits on the confirm layer, with the dismiss button on the left of the act', () => {
    render(<ConfirmModal message="Sure?" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(document.querySelector('.modal-overlay')).toHaveClass('modal-overlay-confirm')

    const [dismiss, act] = [...document.querySelectorAll('.modal-actions button')]
    expect(dismiss).toHaveTextContent('Cancel')
    expect(act).toHaveTextContent('Delete')
    expect(act).toHaveClass('btn-danger')
  })

  it('cancels from the close button too', () => {
    const onCancel = vi.fn()
    render(<ConfirmModal message="Sure?" onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('does not close from the close button while the action runs', async () => {
    let release
    const onCancel = vi.fn()
    render(
      <ConfirmModal
        message="Sure?" confirmLabel="Go" pendingLabel="Going…"
        onConfirm={() => new Promise(r => { release = r })} onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    await screen.findByRole('button', { name: /Going…/ })

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => { release() })
  })

  describe('the typed gate', () => {
    const open = (onConfirm = vi.fn()) => {
      render(
        <ConfirmModal
          title="Delete schema" message="Gone for good." confirmLabel="Delete"
          requireTyped="press_line_1" requireTypedLabel="schema name"
          onConfirm={onConfirm} onCancel={vi.fn()}
        />
      )
      return onConfirm
    }

    it('keeps the act disabled until the text matches, trimmed but otherwise exact', () => {
      const onConfirm = open()
      const act = screen.getByRole('button', { name: 'Delete' })
      const field = screen.getByLabelText(/Type the schema name to confirm/)

      expect(act).toBeDisabled()
      fireEvent.change(field, { target: { value: 'PRESS_LINE_1' } })
      expect(act).toBeDisabled()
      fireEvent.change(field, { target: { value: '  press_line_1 ' } })
      expect(act).toBeEnabled()

      fireEvent.click(act)
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })
  })

  it('shows extra content between the message and the footer', () => {
    render(
      <ConfirmModal message="Sure?" onConfirm={vi.fn()} onCancel={vi.fn()}>
        <label>Reason<input /></label>
      </ConfirmModal>
    )
    expect(within(screen.getByRole('dialog')).getByLabelText('Reason')).toBeTruthy()
  })
})

describe('a confirm-shaped modal keeps its exported props', () => {
  it('RestoreMetricModal names the metric in its title and confirms with its own label', () => {
    const onConfirm = vi.fn()
    render(
      <RestoreMetricModal
        metric={{ name: 'spindle_temp', superseded_by: null }}
        replacement={null} onConfirm={onConfirm} onCancel={vi.fn()}
      />
    )
    expect(screen.getByRole('dialog', { name: /Restore metric spindle_temp/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore Metric' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
