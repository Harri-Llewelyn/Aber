/**
 * Zooming the Audit Trail: a drag across the axis or an empty part of a track shades a band that
 * says what it covers, and its release sets that stretch as the window (`from` and `to`), as a new
 * history entry, so Back undoes it. A press that moves less than BAND_DRAG_PX is a click, a press on
 * a marker opens it, Escape drops a band, and touch starts none. The toolbar's Zoom in and Zoom out
 * add an entry too; a step still replaces one. In London's zone on Monday 2 November 2026 at 15:20.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { AuditTrailTab, BAND_DRAG_PX } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const DEVICES = [{ asset_id: 'dev-1', asset_name: 'Press_01', last_birth_metrics: [] }]
/** An event on Press_01 at a local time on 2 November. */
const event = (event_id, h, mi = 0) => ({
  event_id, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
  timestamp: new Date(2026, 10, 2, h, mi).toISOString(), changed_by: 'user-1', actor_source: 'user',
  old_data: { status: 'OFFLINE' }, new_data: { status: 'ONLINE' },
})

/*
 * Every track is 1028px wide from x = 100, so with its 14px padding each end a fraction f of the
 * window is at x = 114 + 1000f. Across a day, 1000px is 1440 minutes.
 */
const TRACK_LEFT = 100
const xAt = (h, mi = 0) => TRACK_LEFT + 14 + 1000 * (h * 60 + mi) / 1440
let originalRect
let originalOffsetWidth
let served
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 2, 15, 20))
  served = [event(2, 12), event(1, 9)]
  api.get.mockImplementation((p) => {
    if (p.startsWith('/api/v1/audit-trail')) return Promise.resolve(served)
    if (p.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
  originalRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function rect() {
    return this.classList?.contains('trail-track')
      ? { left: TRACK_LEFT, right: TRACK_LEFT + 1028, width: 1028, top: 0, bottom: 28, height: 28, x: TRACK_LEFT, y: 0 }
      : originalRect.call(this)
  }
  originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Element.prototype.getBoundingClientRect = originalRect
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
})

const show = async (search = '?span=day&at=2026-11-02') => {
  window.history.replaceState(null, '', `/audit-trail${search}`)
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getByText('Press_01')).toBeInTheDocument())
}
const axis = () => document.querySelector('.trail-axis-track')
const laneTrack = () => document.querySelector('.trail-lane:not(.trail-axis) .trail-track')
const bands = () => [...document.querySelectorAll('.trail-band')]
const bandWords = () => document.querySelector('.trail-band-words')
const search = () => window.location.search
/** A mouse with its main button held, as a press and a drag have it; a release holds none. */
const mouse = (clientX, extra = {}) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX, ...extra })
const marker = (h) => screen.getByRole('button', { name: `UPDATE on Press_01 at ${new Date(2026, 10, 2, h).toLocaleString()}` })
const timeControl = () => screen.getByRole('group', { name: 'Time window' })

describe('a drag across the timeline', () => {
  it('shades a band that says what it covers, and its release sets from and to as a new history entry', async () => {
    await show()
    const push = vi.spyOn(window.history, 'pushState')

    fireEvent.pointerDown(axis(), mouse(xAt(10, 5)))
    fireEvent.pointerMove(axis(), mouse(xAt(10, 40)))
    // On the axis, on the section heading and in the layer behind the rows, as the hatched parts are.
    expect(bands()).toHaveLength(3)
    expect(bands().map(b => b.parentElement.className)).toEqual(
      expect.arrayContaining([expect.stringContaining('trail-axis-track'), 'trail-track', 'trail-gridlines']))
    expect(bandWords()).toHaveTextContent('10:05 – 10:40, 35 min')
    expect(search()).toBe('?span=day&at=2026-11-02')

    fireEvent.pointerUp(axis(), mouse(xAt(10, 40)))
    expect(search()).toBe('?from=2026-11-02T10%3A05&to=2026-11-02T10%3A40')
    expect(push).toHaveBeenCalledTimes(1)
    expect(bands()).toHaveLength(0)
    expect(within(timeControl()).getByRole('button', { name: /Mon 2 Nov, 10:05 – 10:40/ })).toBeInTheDocument()

    // Back is the window before it.
    act(() => { window.history.back() })
    await waitFor(() => expect(search()).toBe('?span=day&at=2026-11-02'))
  })

  it('starts from an empty part of a lane\'s track as well, and runs either way', async () => {
    await show()
    fireEvent.pointerDown(laneTrack(), mouse(xAt(14)))
    fireEvent.pointerMove(laneTrack(), mouse(xAt(13)))
    expect(bandWords()).toHaveTextContent('13:00 – 14:00, 1 h')
    fireEvent.pointerUp(laneTrack(), mouse(xAt(13)))
    expect(search()).toBe('?from=2026-11-02T13%3A00&to=2026-11-02T14%3A00')
  })

  it('is a click when the press moves less than 4 px: no band, and the window stays', async () => {
    await show()
    expect(BAND_DRAG_PX).toBe(4)
    fireEvent.pointerDown(laneTrack(), mouse(xAt(10)))
    fireEvent.pointerMove(laneTrack(), mouse(xAt(10) + 3))
    expect(bands()).toHaveLength(0)
    fireEvent.pointerUp(laneTrack(), mouse(xAt(10) + 3))
    expect(search()).toBe('?span=day&at=2026-11-02')

    // A drag out and back to within 4 px of the press is a click as well.
    fireEvent.pointerDown(laneTrack(), mouse(xAt(10)))
    fireEvent.pointerMove(laneTrack(), mouse(xAt(11)))
    expect(bands()).toHaveLength(3)
    fireEvent.pointerUp(laneTrack(), mouse(xAt(10) + 2))
    expect(bands()).toHaveLength(0)
    expect(search()).toBe('?span=day&at=2026-11-02')
  })

  it('leaves a press on a marker to open it, and starts no band from one however far it moves', async () => {
    await show()
    const nine = marker(9)
    fireEvent.pointerDown(nine, mouse(xAt(9)))
    fireEvent.pointerMove(nine, mouse(xAt(9) + 2))
    fireEvent.pointerUp(nine, mouse(xAt(9) + 2))
    fireEvent.click(nine)

    expect(bands()).toHaveLength(0)
    expect(new URLSearchParams(search()).get('event')).toBe('1')
    expect(new URLSearchParams(search()).get('span')).toBe('day')

    fireEvent.pointerDown(marker(12), mouse(xAt(12)))
    fireEvent.pointerMove(axis(), mouse(xAt(13)))
    expect(bands()).toHaveLength(0)
    fireEvent.pointerUp(axis(), mouse(xAt(13)))
    expect(new URLSearchParams(search()).get('span')).toBe('day')
  })

  it('is dropped by Escape, which leaves the open drawer alone', async () => {
    await show()
    fireEvent.click(marker(12))
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
    const opened = search()

    fireEvent.pointerDown(axis(), mouse(xAt(10)))
    fireEvent.pointerMove(axis(), mouse(xAt(11)))
    expect(bands()).toHaveLength(3)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(bands()).toHaveLength(0)
    fireEvent.pointerMove(axis(), mouse(xAt(11, 30)))
    fireEvent.pointerUp(axis(), mouse(xAt(11, 30)))

    expect(bands()).toHaveLength(0)
    expect(search()).toBe(opened)
    expect(document.querySelector('.context-panel-open')).toBeTruthy()
  })

  it('ends when a move holds no button, its release missed outside the window, and sets nothing', async () => {
    await show()
    fireEvent.pointerDown(axis(), mouse(xAt(10)))
    fireEvent.pointerMove(axis(), mouse(xAt(11)))
    expect(bands()).toHaveLength(3)
    fireEvent.pointerMove(axis(), mouse(xAt(11, 30), { buttons: 0 }))
    expect(bands()).toHaveLength(0)
    fireEvent.pointerUp(axis(), mouse(xAt(12)))
    expect(search()).toBe('?span=day&at=2026-11-02')
  })

  it('never starts on a touch screen, where the page scrolls as it did', async () => {
    await show()
    const touch = (clientX) => ({ pointerId: 2, pointerType: 'touch', button: 0, buttons: 1, clientX })
    fireEvent.pointerDown(axis(), touch(xAt(10)))
    fireEvent.pointerMove(axis(), touch(xAt(12)))
    expect(bands()).toHaveLength(0)
    fireEvent.pointerUp(axis(), touch(xAt(12)))
    expect(search()).toBe('?span=day&at=2026-11-02')
  })

  it('splits a badge by itself, since the markers group by pixels', async () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return this.classList?.contains('trail-track') ? 1028 : 0 },
    })
    served = [event(2, 12, 5), event(1, 12)]
    await show()
    await waitFor(() => expect(document.querySelectorAll('.trail-track .trail-cluster')).toHaveLength(1))

    fireEvent.pointerDown(axis(), mouse(xAt(11, 30)))
    fireEvent.pointerMove(axis(), mouse(xAt(12, 30)))
    fireEvent.pointerUp(axis(), mouse(xAt(12, 30)))
    await waitFor(() => expect(document.querySelectorAll('.trail-node')).toHaveLength(2))
    expect(document.querySelectorAll('.trail-track .trail-cluster')).toHaveLength(0)
  })
})

describe('the toolbar\'s zoom on the Audit Trail', () => {
  const zoom = (name) => within(within(timeControl()).getByRole('group', { name: 'Zoom' })).getByRole('button', { name })

  it('halves the axis drawn under All time, its events\' extent, as a new history entry', async () => {
    await show('')
    const push = vi.spyOn(window.history, 'pushState')
    expect(zoom('Zoom out')).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(zoom('Zoom in'))
    // The events run 09:00 to 12:00, so the middle half is 09:45 to 11:15.
    expect(search()).toBe('?from=2026-11-02T09%3A45&to=2026-11-02T11%3A15')
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('leaves a step replacing the entry', async () => {
    await show('?from=2026-11-02T09%3A45&to=2026-11-02T11%3A15')
    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.click(within(timeControl()).getByRole('button', { name: 'Earlier' }))
    expect(search()).toBe('?from=2026-11-02T08%3A15&to=2026-11-02T09%3A45')
    expect(push).not.toHaveBeenCalled()
  })
})
