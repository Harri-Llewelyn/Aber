import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ActionButton } from '../components/common/ActionButton'
import { ConfirmModal } from '../components/modals/ConfirmModal'
import { ArchiveModal } from '../components/modals/ArchiveModal'
import { CellsTab } from '../components/tabs/CellsTab'
import { useApiActivity, ACTIVITY_SHOW_DELAY_MS, ACTIVITY_MIN_VISIBLE_MS } from '../hooks/useApiActivity'
import { usePendingAction } from '../hooks/usePendingAction'
import { beginRequest, endRequest, resetApiActivity } from '../lib/apiActivity'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

/**
 * Feedback for asynchronous mutations: a click on Save, Archive or Approve must show something
 * before the request returns, because a dead-looking button gets clicked again and one save becomes
 * two writes.
 */

// The button

describe('ActionButton pending state', () => {
  it('is an ordinary button at rest', () => {
    render(<ActionButton pendingLabel="Saving…" onClick={vi.fn()}>Save</ActionButton>)

    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).not.toBeDisabled()
    expect(btn.className).not.toMatch(/btn-loading/)
    expect(btn.querySelector('.spinner')).toBeNull()
    expect(btn).not.toHaveAttribute('aria-busy')
  })

  it('swaps the label, shows a spinner and refuses further clicks while pending', () => {
    const onClick = vi.fn()
    render(<ActionButton pending pendingLabel="Saving…" onClick={onClick}>Save</ActionButton>)

    // The label IS the message -- a spinner beside an unchanged "Save" reads as decoration, and a
    // screen reader gets nothing from it at all.
    const btn = screen.getByRole('button', { name: /Saving…/ })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-busy', 'true')
    expect(btn.className).toMatch(/btn-loading/)
    expect(screen.queryByText('Save')).not.toBeInTheDocument()

    const spinner = btn.querySelector('.spinner')
    expect(spinner).toBeTruthy()
    expect(spinner.className).toMatch(/spinner-sm/)

    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  // btn-disabled means "you may not do this" and greys the control out. A running action is not
  // a refused one, and saying so would be a lie told at the worst moment.
  it('does not reach for the not-permitted styling', () => {
    render(<ActionButton pending pendingLabel="Saving…">Save</ActionButton>)
    expect(screen.getByRole('button').className).not.toMatch(/btn-disabled/)
  })

  it('keeps the caller\'s own classes', () => {
    render(<ActionButton pending pendingLabel="Deleting…" className="btn btn-danger btn-sm">Delete</ActionButton>)
    const btn = screen.getByRole('button')
    expect(btn.className).toMatch(/btn-danger/)
    expect(btn.className).toMatch(/btn-sm/)
    expect(btn.className).toMatch(/btn-loading/)
  })

  it('is still disabled by a plain disabled prop when nothing is pending', () => {
    render(<ActionButton disabled pendingLabel="Saving…">Save</ActionButton>)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})

// The double-submit guard

// `run` propagates whatever the action threw. Every real call site catches and toasts; this probe
// deliberately passes one that does not, so the catch belongs here.
function DoubleClickProbe({ action }) {
  const [pending, run] = usePendingAction()
  return (
    <ActionButton pending={pending} pendingLabel="Saving…" onClick={() => run(action).catch(() => {})}>Save</ActionButton>
  )
}

describe('usePendingAction', () => {
  // The window a double click lands in is between the click and React committing the disabled
  // attribute, which the `disabled` attribute alone does not close.
  it('runs the action once however many times the button is clicked', async () => {
    let release
    const action = vi.fn(() => new Promise(resolve => { release = resolve }))
    render(<DoubleClickProbe action={action} />)

    const btn = screen.getByRole('button')
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)

    expect(action).toHaveBeenCalledTimes(1)

    await act(async () => { release() })
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
  })

  it('lets a second attempt through once the first has settled', async () => {
    const action = vi.fn().mockResolvedValue(undefined)
    render(<DoubleClickProbe action={action} />)

    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    await act(async () => { fireEvent.click(screen.getByRole('button')) })

    expect(action).toHaveBeenCalledTimes(2)
  })

  // A failed save has to leave the button usable, or one network blip strands the form.
  it('clears the pending state when the action throws', async () => {
    const action = vi.fn().mockRejectedValue(new Error('boom'))
    render(<DoubleClickProbe action={action} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled())
  })
})

// The top bar's activity line

function ActivityProbe() {
  const busy = useApiActivity()
  return <div data-testid="activity">{busy ? 'busy' : 'idle'}</div>
}

describe('topbar activity indicator', () => {
  beforeEach(() => {
    resetApiActivity()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => { vi.useRealTimers() })

  const state = () => screen.getByTestId('activity').textContent

  // The point of the delay: every list tab polls and those reads settle in tens of milliseconds, so
  // without it the bar would blink on an idle screen.
  it('stays dark for a request that settles inside the delay', () => {
    render(<ActivityProbe />)

    act(() => { beginRequest() })
    act(() => { vi.advanceTimersByTime(ACTIVITY_SHOW_DELAY_MS - 50) })
    expect(state()).toBe('idle')

    act(() => { endRequest() })
    act(() => { vi.advanceTimersByTime(2000) })
    expect(state()).toBe('idle')
  })

  it('lights once a request outlives the delay', () => {
    render(<ActivityProbe />)

    act(() => { beginRequest() })
    expect(state()).toBe('idle')

    act(() => { vi.advanceTimersByTime(ACTIVITY_SHOW_DELAY_MS + 10) })
    expect(state()).toBe('busy')
  })

  // Crossing the threshold by a millisecond would otherwise paint and clear inside one frame,
  // which reads as a glitch rather than as progress.
  it('holds the line up for the minimum visible window', () => {
    render(<ActivityProbe />)

    act(() => { beginRequest() })
    act(() => { vi.advanceTimersByTime(ACTIVITY_SHOW_DELAY_MS + 10) })
    expect(state()).toBe('busy')

    act(() => { endRequest() })
    act(() => { vi.advanceTimersByTime(100) })
    expect(state()).toBe('busy')

    act(() => { vi.advanceTimersByTime(ACTIVITY_MIN_VISIBLE_MS) })
    expect(state()).toBe('idle')
  })

  // Two overlapping requests are, to the person watching, one continuous wait.
  it('does not blink between two overlapping requests', () => {
    render(<ActivityProbe />)

    act(() => { beginRequest() })
    act(() => { vi.advanceTimersByTime(ACTIVITY_SHOW_DELAY_MS + 10) })
    act(() => { beginRequest() })
    act(() => { endRequest() })
    act(() => { vi.advanceTimersByTime(ACTIVITY_MIN_VISIBLE_MS + 100) })

    // The second is still outstanding.
    expect(state()).toBe('busy')

    act(() => { endRequest() })
    act(() => { vi.advanceTimersByTime(ACTIVITY_MIN_VISIBLE_MS + 100) })
    expect(state()).toBe('idle')
  })

  it('picks up work that was already in flight when it mounted', () => {
    act(() => { beginRequest() })
    render(<ActivityProbe />)

    act(() => { vi.advanceTimersByTime(ACTIVITY_SHOW_DELAY_MS + 10) })
    expect(state()).toBe('busy')
  })

  it('leaves no timer running after unmount', () => {
    const { unmount } = render(<ActivityProbe />)
    act(() => { beginRequest() })
    unmount()
    // Would throw a React "update on unmounted component" warning if the timer survived.
    act(() => { vi.advanceTimersByTime(5000) })
    act(() => { endRequest() })
  })
})

// Modals

describe('ConfirmModal while its action runs', () => {
  it('reports the wait on the confirming button and locks Cancel', async () => {
    let release
    const onConfirm = vi.fn(() => new Promise(resolve => { release = resolve }))
    render(
      <ConfirmModal message="Delete it?" pendingLabel="Deleting…" onConfirm={onConfirm} onCancel={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Confirm$/ }))

    const busy = await screen.findByRole('button', { name: /Deleting…/ })
    expect(busy).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeDisabled()

    await act(async () => { release() })
  })

  // Escape mid-flight must not reach the dialog underneath, which is what popping this layer off
  // the shared stack would do.
  it('ignores Escape while the action is in flight, without handing it to the layer below', async () => {
    const onCancel = vi.fn()
    const belowCancel = vi.fn()
    let release

    render(
      <>
        <ConfirmModal message="outer" onConfirm={vi.fn()} onCancel={belowCancel} />
        <ConfirmModal
          message="inner"
          onConfirm={() => new Promise(resolve => { release = resolve })}
          onCancel={onCancel}
        />
      </>
    )

    const confirms = screen.getAllByRole('button', { name: /^Confirm$/ })
    fireEvent.click(confirms[confirms.length - 1])
    await screen.findByRole('button', { name: /Working…/ })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(belowCancel).not.toHaveBeenCalled()

    await act(async () => { release() })
  })

  it('runs the confirmed action once for a double click', async () => {
    let release
    const onConfirm = vi.fn(() => new Promise(resolve => { release = resolve }))
    render(<ConfirmModal message="Delete it?" onConfirm={onConfirm} onCancel={vi.fn()} />)

    const btn = screen.getByRole('button', { name: /^Confirm$/ })
    fireEvent.click(btn)
    fireEvent.click(btn)

    expect(onConfirm).toHaveBeenCalledTimes(1)
    await act(async () => { release() })
  })
})

describe('ArchiveModal while the archive runs', () => {
  it('says Archiving… and stops a second submission', async () => {
    let release
    const onArchive = vi.fn(() => new Promise(resolve => { release = resolve }))
    render(
      <ArchiveModal
        entityType="cells" entityId="cell-1" displayName="Assembly Line 1"
        onArchive={onArchive} onCancel={vi.fn()}
      />
    )

    const btn = screen.getByRole('button', { name: /Archive & Set Timer/i })
    fireEvent.click(btn)
    fireEvent.click(btn)

    expect(onArchive).toHaveBeenCalledTimes(1)
    // Still carries the retention answer the form collected.
    expect(onArchive).toHaveBeenCalledWith(30)

    const busy = await screen.findByRole('button', { name: /Archiving…/ })
    expect(busy).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeDisabled()

    await act(async () => { release() })
  })
})

// The form that is not a modal component of its own

const cell = { cell_id: 'cell-1', cell_name: 'Assembly Line 1', is_archived: false, gateways: [], gateway_count: 0 }

const routeGet = (overrides = {}) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(overrides.cells ?? [cell])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(overrides.gateways ?? [])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(overrides.devices ?? [])
  if (path.startsWith('/api/v1/telemetry')) return Promise.resolve(overrides.telemetry ?? [])
  return Promise.resolve([])
}

describe('CellsTab save button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation(routeGet())
  })

  it('reports Creating… on a new cell and writes once for a double click', async () => {
    let release
    api.post.mockImplementation(() => new Promise(resolve => { release = resolve }))
    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /New Cell|Add Cell|Create/i }))

    const save = screen.getByRole('button', { name: /^Save$/ })
    fireEvent.click(save)
    fireEvent.click(save)

    // The label names the act: creating a cell and editing one are different waits.
    expect(await screen.findByRole('button', { name: /Creating…/ })).toBeDisabled()
    expect(api.post).toHaveBeenCalledTimes(1)

    await act(async () => { release({}) })
  })
})

// The styles the markup above depends on

describe('App.css carries the states the components ask for', () => {
  const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
  const ruleFor = (selector) => {
    const i = APP_CSS.indexOf(selector + ' {')
    if (i < 0) throw new Error(`rule not found: ${selector}`)
    return APP_CSS.slice(i, APP_CSS.indexOf('}', i))
  }

  it('defines the in-button spinner size', () => {
    expect(ruleFor('.spinner-sm')).toMatch(/width:\s*12px/)
  })

  it('waits rather than forbids on a loading button', () => {
    expect(ruleFor('.btn-loading')).toMatch(/cursor:\s*wait/)
  })

  it('pins the activity line to the bar\'s bottom edge at 2px', () => {
    const rule = ruleFor('.topbar-progress')
    expect(rule).toMatch(/position:\s*absolute/)
    expect(rule).toMatch(/height:\s*2px/)
    expect(rule).toMatch(/bottom:\s*-1px/)
    // Must never eat a click aimed at the bar beneath it.
    expect(rule).toMatch(/pointer-events:\s*none/)
  })

  it('anchors that line by giving the bar a positioning context', () => {
    expect(ruleFor('.topbar')).toMatch(/position:\s*relative/)
  })

  it('paints the line in the accent colour and animates it', () => {
    const bar = APP_CSS.slice(APP_CSS.indexOf('.topbar-progress::before {'))
    expect(bar.slice(0, bar.indexOf('}'))).toMatch(/var\(--accent\)/)
    expect(APP_CSS).toMatch(/@keyframes topbar-progress-slide/)
  })

  // Motion IS the mechanism here, so a reduced-motion preference has to leave a steady line
  // rather than nothing at all -- the information still has to arrive.
  it('degrades the line to a static one under prefers-reduced-motion', () => {
    const block = APP_CSS.slice(APP_CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toMatch(/\.topbar-progress::before/)
    expect(block.slice(0, 400)).toMatch(/animation:\s*none/)
  })
})
