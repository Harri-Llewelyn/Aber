import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ActionButton } from '../components/common/ActionButton'
import { ConfirmModal } from '../components/modals/ConfirmModal'
import { ArchiveModal } from '../components/modals/ArchiveModal'
import { OverviewTab } from '../components/tabs/OverviewTab'
import { CellsTab } from '../components/tabs/CellsTab'
import { useApiActivity, ACTIVITY_SHOW_DELAY_MS, ACTIVITY_MIN_VISIBLE_MS } from '../hooks/useApiActivity'
import { usePendingAction } from '../hooks/usePendingAction'
import { beginRequest, endRequest, resetApiActivity } from '../lib/apiActivity'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), relocateDevices: vi.fn() } }
})

/**
 * Feedback for asynchronous mutations.
 *
 * The complaint these answer is precise: a click on Save, Archive or Approve produced NOTHING
 * until the request came back. On a slow link that is indistinguishable from a dead button, and
 * the reliable operator response to a dead button is to click it again -- which is how one save
 * became two writes.
 */

// ---------------------------------------------------------------------------------------------
// The button
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// The double-submit guard
// ---------------------------------------------------------------------------------------------

// `run` propagates whatever the action threw rather than swallowing it -- an error that vanishes
// with no toast and no console entry is the worst outcome available. Every real call site passes a
// handler that catches internally and toasts, so nothing floats a rejection there; this probe
// deliberately passes one that does NOT, so the catch belongs here.
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

// ---------------------------------------------------------------------------------------------
// The top bar's activity line
// ---------------------------------------------------------------------------------------------

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

  // THE POINT OF THE DELAY. Every list tab polls -- every 3s with Realtime off -- and those reads
  // settle in tens of milliseconds. Without this the bar would blink several times a minute on an
  // idle screen, and a light that is always flickering says nothing about whether YOUR click is
  // being worked on.
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

// ---------------------------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------------------------

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

  // Escape mid-flight must not reach the dialog UNDERNEATH -- which is what popping this layer off
  // the shared stack would do, dismissing the form that asked the question while its own mutation
  // was still running.
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

// ---------------------------------------------------------------------------------------------
// The form that is not a modal component of its own
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------------------------

const dropGateway = {
  gateway_id: 'gw-1', gateway_name: 'Virtual_Gateway_NodeRED', cell_id: 'cell-1',
  location_scope: 'cell', status: 'ONLINE', deployment: 'host', is_archived: false,
  last_heartbeat: new Date().toISOString(), device_count: 1, devices: []
}

const dropDevice = {
  asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', status: 'ONLINE',
  active_gateway_id: 'gw-1', cell_id: null, location_scope: 'cell',
  effective_cell_id: null, location_source: 'unassigned'
}

describe('shopfloor drop feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockImplementation(routeGet({
      cells: [{ ...cell, gateways: [dropGateway], gateway_count: 1 }],
      gateways: [dropGateway],
      devices: [dropDevice]
    }))
  })

  const renderMap = (showToast = vi.fn()) => render(
    <OverviewTab
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} onSelectCell={vi.fn()}
      showToast={showToast} hasPermission={() => true} onNavigateTab={vi.fn()}
    />
  )

  const payload = () => ({
    dataTransfer: { getData: () => JSON.stringify(dropDevice) }
  })

  /*
   * WHAT THE PENDING MARK MEANS NOW.
   *
   * It used to mean "an api.put for this tile is in flight", because a drop WAS a write and the
   * map showed nothing at all until it came back -- indistinguishable from a refused drop, and
   * the reliable response to a refused drop is to drag it again, which is how one move became two
   * writes.
   *
   * A drop is no longer a write. Moves are staged and applied as one transaction (migration
   * 0033), so the chip moves the instant it is released and there is no in-flight request to
   * report. The problem inverts: the risk is no longer that a real move looks like it failed, it
   * is that a STAGED move looks like it succeeded. So the mark now says "this tile holds moves
   * that have not been written", which is the question an operator actually has to answer before
   * leaving the page.
   */
  it('marks the destination tile as holding unapplied moves, and writes nothing', async () => {
    renderMap()

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))

    const zone = screen.getByTitle(/Drag device node here to reassign/)
    fireEvent.drop(zone, payload())

    await waitFor(() => expect(zone.className).toMatch(/shopfloor-zone-pending/))
    expect(zone.getAttribute('title')).toMatch(/staged moves that have not been applied/)

    // THE POINT OF THE WHOLE CHANGE. A drop must not write.
    expect(api.put).not.toHaveBeenCalled()
    expect(api.relocateDevices).not.toHaveBeenCalled()
  })

  it('marks only the destination, not every tile', async () => {
    renderMap()

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))

    fireEvent.drop(screen.getByTitle(/Drag device node here to reassign/), payload())

    await waitFor(() => expect(document.querySelectorAll('.shopfloor-zone-pending')).toHaveLength(1))
  })

  it('applies the staged batch in ONE call and clears the marks', async () => {
    const showToast = vi.fn()
    api.relocateDevices.mockResolvedValue({ causation_id: 42, requested: 1, applied: 1, unchanged: 0, devices: [] })
    renderMap(showToast)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))
    fireEvent.drop(screen.getByTitle(/Drag device node here to reassign/), payload())

    const apply = await screen.findByRole('button', { name: /Apply 1 move/ })
    await act(async () => { fireEvent.click(apply) })

    expect(api.relocateDevices).toHaveBeenCalledTimes(1)
    expect(api.relocateDevices).toHaveBeenCalledWith([
      { device_id: 'dev-1', cell_id: 'cell-1', location_scope: 'cell' }
    ])
    // The message names the transaction, because that is the thing the batch bought.
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/one transaction/), 'success'
    )
  })

  it('disables Apply while the batch is in flight', async () => {
    let release
    api.relocateDevices.mockImplementation(() => new Promise(resolve => { release = resolve }))
    renderMap()

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))
    fireEvent.drop(screen.getByTitle(/Drag device node here to reassign/), payload())

    fireEvent.click(await screen.findByRole('button', { name: /Apply 1 move/ }))

    // Same reasoning as every other pending button here: a dead-looking button gets clicked
    // again, and a second click would send the same batch twice.
    expect(await screen.findByRole('button', { name: /Applying…/ })).toBeDisabled()
    expect(api.relocateDevices).toHaveBeenCalledTimes(1)

    await act(async () => { release({ causation_id: 1, requested: 1, applied: 1, unchanged: 0, devices: [] }) })
  })

  it('KEEPS the batch staged when the apply fails', async () => {
    const showToast = vi.fn()
    api.relocateDevices.mockRejectedValue(new Error('Row level security'))
    renderMap(showToast)

    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))

    const zone = screen.getByTitle(/Drag device node here to reassign/)
    fireEvent.drop(zone, payload())

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Apply 1 move/ })) })

    // THE WORK SURVIVES ITS OWN FAILURE. The RPC refuses a batch in full, so the floor is exactly
    // as it was -- discarding the operator's staged moves here would lose work the database never
    // touched, which is the outcome staging exists to prevent.
    expect(await screen.findByRole('button', { name: /Apply 1 move/ })).toBeInTheDocument()
    expect(zone.className).toMatch(/shopfloor-zone-pending/)
    // The exact failure, not a generic one -- an RLS refusal and a dropped connection need
    // different responses from the operator.
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/Row level security.*still staged/), 'error'
    )
  })

  // A lane is a drop target too, and it is keyed by the lane name rather than by a cell_id.
  it('marks a derived lane the same way', async () => {
    renderMap()

    await waitFor(() => expect(screen.getByText('Site-Wide')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Rearrang/i }))

    const lane = screen.getByTitle(/permanent home, not a queue/i)
    fireEvent.drop(lane, payload())

    await waitFor(() => expect(lane.className).toMatch(/shopfloor-zone-pending/))
    expect(api.put).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------
// The styles the markup above depends on
// ---------------------------------------------------------------------------------------------

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

  // The lesson this file has learned three times: `.shopfloor-zone:hover` (0-2-0) repaints
  // border-color on every tile, and the pointer is BY DEFINITION on a tile that was just dropped
  // onto. A single-class rule would never once be seen.
  it('states the pending tile at a specificity hover cannot take away', () => {
    expect(APP_CSS).toMatch(/\.shopfloor-zone\.shopfloor-zone-pending \{/)
    expect(APP_CSS).toMatch(/\.shopfloor-zone\.shopfloor-zone-pending:hover \{/)
    expect(ruleFor('.shopfloor-zone.shopfloor-zone-pending')).toMatch(/pointer-events:\s*none/)
  })
})
