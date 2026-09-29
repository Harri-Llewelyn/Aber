import React from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  Toast, ToastStack, toastDuration,
  TOAST_MIN_MS, TOAST_MAX_MS, TOAST_NOTICE_MS, TOAST_MS_PER_CHAR, TOAST_RESUME_MIN_MS
} from '../components/common/Toast'
import { useToast, MAX_VISIBLE_TOASTS } from '../hooks/useToast'

/**
 * The toast. What is pinned: each toast owns its timer, so a second one never inherits what was
 * left of the first; how long a toast stays depends on its type and length, and an error stays
 * until dismissed; hover and focus hold it; and both live regions exist before any message arrives.
 */

let hook
function Harness() {
  hook = useToast()
  return <ToastStack toasts={hook.toasts} onDismiss={hook.dismissToast} onExpire={hook.expireToast} />
}

const renderStack = () => render(<Harness />)
const show = (msg, type) => act(() => { hook.showToast(msg, type) })
const advance = (ms) => act(() => { vi.advanceTimersByTime(ms) })
const toastFor = (text) => screen.getByText(text).closest('.toast')

beforeEach(() => {
  window.sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

describe('toastDuration', () => {
  it('gives a short success or info message the type floor', () => {
    expect(toastDuration('Saved', 'success')).toBe(TOAST_MIN_MS.success)
    expect(toastDuration('Saved', 'info')).toBe(TOAST_MIN_MS.info)
    expect(TOAST_MIN_MS.success).toBe(4000)
  })

  it('gives a warning twice as long as a success', () => {
    expect(toastDuration('Cap reached', 'warning')).toBe(8000)
  })

  it('never times an error out', () => {
    expect(toastDuration('Save failed', 'error')).toBeNull()
  })

  it('grows with the length of the message past the floor, up to the ceiling', () => {
    const long = 'x'.repeat(150)
    expect(toastDuration(long, 'success')).toBe(TOAST_NOTICE_MS + 150 * TOAST_MS_PER_CHAR)
    expect(toastDuration(long, 'success')).toBeGreaterThan(TOAST_MIN_MS.success)
    expect(toastDuration('x'.repeat(2000), 'warning')).toBe(TOAST_MAX_MS)
  })

  it('treats an unknown type as info', () => {
    expect(toastDuration('Saved', 'notice')).toBe(TOAST_MIN_MS.info)
  })
})

describe('toast timing', () => {
  it('gives a second toast its own timer rather than what was left of the first', () => {
    renderStack()
    show('First save', 'success')
    advance(3000)
    show('Second save', 'success')

    // The first goes at 4 s, its own time; the second is only a second old.
    advance(1000)
    expect(screen.queryByText('First save')).toBeNull()
    expect(screen.getByText('Second save')).toBeInTheDocument()

    // And the second gets its full 4 s from when it arrived, not the 0.2 s the single slot left it.
    advance(2999)
    expect(screen.getByText('Second save')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByText('Second save')).toBeNull()
  })

  it('keeps a warning up for 8 s', () => {
    renderStack()
    show('Cap reached', 'warning')
    advance(7999)
    expect(screen.getByText('Cap reached')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByText('Cap reached')).toBeNull()
  })

  it('keeps an error until it is dismissed', () => {
    renderStack()
    show('Save failed: permission denied', 'error')
    advance(10 * 60 * 1000)
    const toast = toastFor('Save failed: permission denied')
    expect(toast).toBeInTheDocument()

    fireEvent.click(within(toast).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Save failed: permission denied')).toBeNull()
  })

  it('pauses while the pointer is over it, and resumes with at least the resume floor left', () => {
    renderStack()
    show('Saved', 'success')
    advance(3000)
    fireEvent.mouseEnter(toastFor('Saved'))
    advance(60000)
    expect(screen.getByText('Saved')).toBeInTheDocument()

    // One second was left; leaving gives it the floor instead.
    fireEvent.mouseLeave(toastFor('Saved'))
    advance(TOAST_RESUME_MIN_MS - 1)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('pauses while focus is inside it', () => {
    render(
      <>
        <button>elsewhere</button>
        <Harness />
      </>
    )
    show('Saved', 'success')
    advance(1000)
    act(() => { within(toastFor('Saved')).getByRole('button', { name: 'Dismiss' }).focus() })
    advance(60000)
    expect(screen.getByText('Saved')).toBeInTheDocument()

    // 3 s were left when focus arrived, and they run again once it leaves.
    act(() => { screen.getByRole('button', { name: 'elsewhere' }).focus() })
    advance(2999)
    expect(screen.getByText('Saved')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('stays paused while either the pointer or focus still holds it', () => {
    render(
      <>
        <button>elsewhere</button>
        <Harness />
      </>
    )
    show('Saved', 'success')
    const toast = toastFor('Saved')
    fireEvent.mouseEnter(toast)
    act(() => { within(toast).getByRole('button', { name: 'Dismiss' }).focus() })
    fireEvent.mouseLeave(toast)
    advance(60000)
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })
})

describe('the stack', () => {
  it(`shows at most ${MAX_VISIBLE_TOASTS}, and the oldest leaves when another arrives`, () => {
    renderStack()
    show('one', 'success')
    show('two', 'success')
    show('three', 'success')
    show('four', 'success')

    expect(screen.queryByText('one')).toBeNull()
    for (const msg of ['two', 'three', 'four']) expect(screen.getByText(msg)).toBeInTheDocument()
    expect(document.querySelectorAll('.toast')).toHaveLength(MAX_VISIBLE_TOASTS)
  })

  it('replaces a message already on screen rather than stacking a copy, and restarts its timer', () => {
    renderStack()
    show('Refresh failed', 'warning')
    advance(6000)
    show('Refresh failed', 'warning')

    expect(screen.getAllByText('Refresh failed')).toHaveLength(1)
    advance(7999)
    expect(screen.getByText('Refresh failed')).toBeInTheDocument()
  })

  it('keeps the showToast(msg, type) signature, with success as the default type', () => {
    renderStack()
    act(() => { hook.showToast('Saved') })
    expect(toastFor('Saved')).toHaveClass('toast-success')
  })

  it.each(['success', 'info', 'warning', 'error'])('styles a %s toast by its own class', (type) => {
    renderStack()
    show(`A ${type} message`, type)
    expect(toastFor(`A ${type} message`)).toHaveClass(`toast-${type}`)
  })

  it('draws a different glyph for each type, and the cross only on the close button', () => {
    const types = ['success', 'info', 'warning', 'error']
    render(<ToastStack toasts={types.map((type, id) => ({ id, msg: `${type} glyph`, type }))} />)
    const glyphs = [...document.querySelectorAll('.toast .toast-icon svg')].map(svg => svg.innerHTML)
    expect(glyphs).toHaveLength(4)
    expect(new Set(glyphs).size).toBe(4)
    const cross = document.querySelector('.toast-dismiss svg').innerHTML
    expect(glyphs).not.toContain(cross)
  })
})

describe('announcement', () => {
  it('renders both live regions before any message, empty', () => {
    render(<ToastStack toasts={[]} />)
    const status = screen.getByRole('status')
    const alert = screen.getByRole('alert')
    expect(status).toBeEmptyDOMElement()
    expect(alert).toBeEmptyDOMElement()
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(alert).toHaveAttribute('aria-live', 'assertive')
  })

  it('announces an error assertively and everything else politely', () => {
    renderStack()
    show('Saved', 'success')
    show('Device discovered', 'info')
    show('Cap reached', 'warning')
    show('Save failed', 'error')

    const status = screen.getByRole('status')
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Save failed')).toBeInTheDocument()
    expect(within(alert).queryByText('Cap reached')).toBeNull()
    expect(within(status).getByText('Cap reached')).toBeInTheDocument()
    expect(within(status).getByText('Device discovered')).toBeInTheDocument()
    expect(within(status).queryByText('Save failed')).toBeNull()
  })

  it('says the type of a warning or an error in words, not only by icon and colour', () => {
    renderStack()
    show('Keep the file', 'warning')
    show('Save failed', 'error')
    expect(toastFor('Keep the file')).toHaveTextContent(/^Warning: Keep the file$/)
    expect(toastFor('Save failed')).toHaveTextContent(/^Error: Save failed$/)
    expect(toastFor('Keep the file').querySelector('.sr-only')).toHaveTextContent('Warning:')
  })

  it('gives every toast a close button named Dismiss', () => {
    renderStack()
    show('Saved', 'success')
    show('Save failed', 'error')
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2)
  })

  it('renders a bare Toast with an expiry callback carrying its id', () => {
    const onExpire = vi.fn()
    render(<Toast id={7} msg="Saved" type="success" onExpire={onExpire} />)
    advance(TOAST_MIN_MS.success)
    expect(onExpire).toHaveBeenCalledWith(7)
  })
})
