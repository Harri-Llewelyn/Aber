import React, { useRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../components/common/Modal'
import { copyText } from '../components/common/CopyableId'
import { SearchInput, focusPageSearch } from '../components/common/SearchInput'
import { ConfirmModal } from '../components/modals/ConfirmModal'

/**
 * Focus in the shared dialog frame: where it starts, that it stays in the dialog, and where it goes
 * back to. jsdom has no showModal(), so the browser's own parts (the inert page, the top layer) are
 * not tested here; the parts `Modal` does itself are.
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const esc = () => fireEvent.keyDown(document, { key: 'Escape' })

/** A page whose button opens `dialog(close)`. */
function Page({ dialog, label = 'Open' }) {
  const [open, setOpen] = useState(false)
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>{label}</button>
      {open && dialog(() => setOpen(false))}
    </main>
  )
}

/** Focuses a button and presses it, as a keyboard user would. */
const activate = (button) => {
  button.focus()
  fireEvent.click(button)
}

describe('opening a dialog', () => {
  it('moves focus to the dialog itself, named by its title and described by its lead', () => {
    render(<Page dialog={close => <Modal title="Rename area" lead="Shown on the Site Map." onClose={close}><input aria-label="Name" /></Modal>} />)
    activate(screen.getByRole('button', { name: 'Open' }))

    const dialog = screen.getByRole('dialog', { name: 'Rename area' })
    expect(dialog).toHaveFocus()
    expect(dialog).toHaveAttribute('tabindex', '-1')
    expect(document.getElementById(dialog.getAttribute('aria-describedby'))).toHaveTextContent('Shown on the Site Map.')
  })

  it('has no description when there is no lead', () => {
    render(<Modal title="T" onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby')
  })

  it('starts on the control initialFocus names', () => {
    function Named({ onClose }) {
      const nameRef = useRef(null)
      return (
        <Modal title="Rename area" onClose={onClose} initialFocus={nameRef}>
          <button type="button">Help</button>
          <input aria-label="Name" ref={nameRef} />
        </Modal>
      )
    }
    render(<Page dialog={close => <Named onClose={close} />} />)
    activate(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByLabelText('Name')).toHaveFocus()
  })

  it('starts on the dialog when the named control cannot take focus', () => {
    function Disabled() {
      const nameRef = useRef(null)
      return (
        <Modal title="T" onClose={vi.fn()} initialFocus={nameRef}>
          <input aria-label="Name" ref={nameRef} disabled />
        </Modal>
      )
    }
    render(<Disabled />)
    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('opens the <dialog> with showModal(), not the open attribute', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    render(<Modal title="T" onClose={vi.fn()} />)
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog').open).toBe(true)
  })
})

describe('while a dialog is open', () => {
  it('moves focus back to the dialog when the control holding it is removed', () => {
    function Steps() {
      const [step, setStep] = useState(1)
      return (
        <Modal title="Set up" onClose={vi.fn()}>
          {step === 1 ? <button type="button" onClick={() => setStep(2)}>Next</button> : <p>Done</p>}
        </Modal>
      )
    }
    render(<Steps />)
    activate(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('cancels the Escape keypress it answers, so the browser does not also close the <dialog>', () => {
    const onClose = vi.fn()
    render(<Modal title="T" onClose={onClose} />)
    expect(esc()).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes through onClose on a close request the Escape stack did not take', () => {
    const onClose = vi.fn()
    render(<Modal title="T" onClose={onClose} />)
    const request = new Event('cancel', { cancelable: true })
    screen.getByRole('dialog').dispatchEvent(request)

    expect(request.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open on a close request while its onClose is a no-op', () => {
    render(<Modal title="T" onClose={() => {}} />)
    const request = new Event('cancel', { cancelable: true })
    screen.getByRole('dialog').dispatchEvent(request)

    expect(request.defaultPrevented).toBe(true)
    expect(screen.getByRole('dialog').open).toBe(true)
  })

  it('opens again if the browser closes it while it is still rendered', () => {
    render(<Modal title="T" onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    dialog.close()
    dialog.dispatchEvent(new Event('close'))

    expect(dialog.open).toBe(true)
    expect(dialog).toHaveFocus()
  })

  it("stops `/` reaching the page's search box behind a native <dialog>", () => {
    const { rerender } = render(
      <main>
        <div className="filter-bar"><SearchInput value="" onChange={() => {}} ariaLabel="Search devices" /></div>
        <dialog open><p>Opened elsewhere</p></dialog>
      </main>
    )
    expect(focusPageSearch()).toBe(false)

    rerender(
      <main>
        <div className="filter-bar"><SearchInput value="" onChange={() => {}} ariaLabel="Search devices" /></div>
      </main>
    )
    expect(focusPageSearch()).toBe(true)
  })

  it("puts the clipboard's scratch field in the dialog, where it can be selected", async () => {
    render(<Modal title="T" onClose={vi.fn()} />)
    vi.stubGlobal('navigator', {})
    let parent = null
    const original = document.execCommand
    document.execCommand = vi.fn(() => {
      parent = document.querySelector('textarea')?.parentElement ?? null
      return true
    })
    try {
      expect(await copyText('secret-value')).toBe(true)
    } finally {
      document.execCommand = original
    }
    expect(parent).toBe(screen.getByRole('dialog'))
    expect(document.querySelector('textarea')).toBeNull()
  })
})

describe('closing a dialog', () => {
  it('hands focus back to the button that opened it, by Escape or by the close button', () => {
    render(<Page dialog={close => <Modal title="T" onClose={close} />} />)
    const opener = screen.getByRole('button', { name: 'Open' })

    activate(opener)
    esc()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()

    activate(opener)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('moves focus to the main region when the opener was removed in the same update', async () => {
    function Rows() {
      const [rows, setRows] = useState(['press_1', 'press_2'])
      const [deleting, setDeleting] = useState(null)
      return (
        <main>
          {rows.map(r => <button type="button" key={r} onClick={() => setDeleting(r)}>Delete {r}</button>)}
          {deleting && (
            <ConfirmModal
              title={`Delete ${deleting}`} message="Gone for good." confirmLabel="Delete"
              onCancel={() => setDeleting(null)}
              onConfirm={() => { setRows(rs => rs.filter(x => x !== deleting)); setDeleting(null) }}
            />
          )}
        </main>
      )
    }
    render(<Rows />)
    activate(screen.getByRole('button', { name: 'Delete press_1' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete press_1' })).toBeNull()
    const main = document.querySelector('main')
    expect(main).toHaveFocus()

    // Focusable only for the hand-over: once focus moves on, main leaves the Tab order's reach.
    screen.getByRole('button', { name: 'Delete press_2' }).focus()
    expect(main).not.toHaveAttribute('tabindex')
  })

  it('moves focus to the main region when the opener went while the dialog was open', () => {
    function Gone() {
      const [shown, setShown] = useState(true)
      const [open, setOpen] = useState(false)
      return (
        <main>
          {shown && <button type="button" onClick={() => setOpen(true)}>Open</button>}
          {open && (
            <Modal title="T" onClose={() => setOpen(false)}>
              <button type="button" onClick={() => setShown(false)}>Remove the opener</button>
            </Modal>
          )}
        </main>
      )
    }
    render(<Gone />)
    activate(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the opener' }))
    esc()
    expect(document.querySelector('main')).toHaveFocus()
  })

  it('leaves focus alone when nothing had it as the dialog opened', () => {
    const { rerender } = render(<main><p>page</p></main>)
    rerender(<main><p>page</p><Modal title="T" onClose={vi.fn()} /></main>)
    expect(screen.getByRole('dialog')).toHaveFocus()
    rerender(<main><p>page</p></main>)
    expect(document.body).toHaveFocus()
  })
})

describe('a dialog over a dialog', () => {
  function Form() {
    const [form, setForm] = useState(false)
    const [confirming, setConfirming] = useState(false)
    return (
      <main>
        <button type="button" onClick={() => setForm(true)}>Edit</button>
        {form && (
          <Modal title="Edit area" onClose={() => setForm(false)}>
            <button type="button" onClick={() => setConfirming(true)}>Discard Changes</button>
            {confirming && (
              <ConfirmModal
                title="Discard changes" message="What you typed is lost." confirmLabel="Discard"
                onCancel={() => setConfirming(false)}
                onConfirm={() => { setConfirming(false); setForm(false) }}
              />
            )}
          </Modal>
        )}
      </main>
    )
  }

  it('takes focus, and gives it back to the dialog beneath on Escape', () => {
    render(<Form />)
    activate(screen.getByRole('button', { name: 'Edit' }))
    activate(screen.getByRole('button', { name: 'Discard Changes' }))

    const top = screen.getByRole('dialog', { name: 'Discard changes' })
    expect(top).toHaveFocus()

    esc()
    expect(screen.queryByRole('dialog', { name: 'Discard changes' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Edit area' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard Changes' })).toHaveFocus()

    esc()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus()
  })

  it('gives focus to what opened the first when both close in one update', async () => {
    render(<Form />)
    activate(screen.getByRole('button', { name: 'Edit' }))
    activate(screen.getByRole('button', { name: 'Discard Changes' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })) })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus()
  })
})
