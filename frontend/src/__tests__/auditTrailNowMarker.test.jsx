/**
 * The Audit Trail under a time window: the axis is the window, a window that runs on past now
 * draws "Now 15:20" and hatches what follows ("Nothing recorded yet"), the part before the oldest
 * loaded event says it is not loaded while older events are, and clustering still answers to the
 * width on screen. In London's zone on Monday 2 November 2026 at 15:20.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
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
})
afterEach(() => { vi.useRealTimers() })

const show = async (search) => {
  window.history.replaceState(null, '', `/audit-trail${search}`)
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getByText('Press_01')).toBeInTheDocument())
}
/** The fraction out of `calc(14px + (100% - 28px) * f)`, however jsdom reorders it. */
const fractionOf = (left) => Number(/([\d.e-]+)\s*\*|\*\s*([\d.e-]+)/.exec(left)?.slice(1).find(Boolean) ?? NaN)
const nowMarker = () => document.querySelector('.trail-axis-track .trail-now')
const shades = (kind) => [...document.querySelectorAll(`.trail-shade-${kind}`)]

describe('a window that runs on past now', () => {
  it('spans the whole day on the axis, ticked at its hours', async () => {
    await show('?span=day&at=2026-11-02')
    expect([...document.querySelectorAll('.trail-tick')].map(t => t.textContent))
      .toEqual(['00:00', '06:00', '12:00', '18:00', '00:00'])
    // The noon event sits half way along, where the day's own noon tick is.
    const [nine, noon] = [...document.querySelectorAll('.trail-node')]
      .map(n => fractionOf(n.style.left)).sort((a, b) => a - b)
    expect(noon).toBeCloseTo(0.5, 6)
    expect(nine).toBeCloseTo(9 / 24, 6)
  })

  it('draws "Now 15:20" on the axis at that moment', async () => {
    await show('?span=day&at=2026-11-02')
    expect(nowMarker()).toHaveTextContent('Now 15:20')
    expect(fractionOf(nowMarker().style.left)).toBeCloseTo((15 + 20 / 60) / 24, 6)
    // A div among the ticks' spans, so the end ticks are still the first and last of their type.
    expect(nowMarker().tagName).toBe('DIV')
  })

  it('hatches the part after now behind every lane, and says so on each section heading', async () => {
    await show('?span=day&at=2026-11-02')
    const [heading, layer] = [
      shades('future').find(s => s.closest('.trail-section')),
      shades('future').find(s => s.closest('.trail-gridlines')),
    ]
    expect(heading).toHaveTextContent('Nothing recorded yet')
    expect(layer).toBeTruthy()
    expect(heading.style.left).toBe(nowMarker().style.left)
    expect(layer.style.left).toBe(nowMarker().style.left)
    // Words for sight; the layer and the heading's track are hidden from a screen reader, as the
    // gridlines are.
    expect(heading.closest('[aria-hidden="true"]')).toBeTruthy()
  })

  it('draws neither once the day is over', async () => {
    await show('?span=day&at=2026-11-01')
    expect(nowMarker()).toBeNull()
    expect(shades('future')).toHaveLength(0)
  })

  it('draws neither under All time, whose axis is the events\'', async () => {
    await show('')
    expect(nowMarker()).toBeNull()
    expect(shades('future')).toHaveLength(0)
    const fractions = [...document.querySelectorAll('.trail-node')].map(n => fractionOf(n.style.left)).sort()
    expect(fractions).toEqual([0, 1])
  })
})

describe('a window with older events not loaded', () => {
  it('says the part before the oldest loaded event is not loaded, rather than leaving it empty', async () => {
    served = Object.assign([event(2, 12), event(1, 9)], { nextCursor: { recorded_at: 'x', id: 1 } })
    await show('?span=day&at=2026-11-02')

    const heading = shades('unloaded').find(s => s.closest('.trail-section'))
    expect(heading).toHaveTextContent('Older events not loaded')
    expect(fractionOf(heading.style.width)).toBeCloseTo(9 / 24, 6)
    expect(shades('unloaded').some(s => s.closest('.trail-gridlines'))).toBe(true)
  })

  it('says nothing of the sort once everything in the window is loaded', async () => {
    await show('?span=day&at=2026-11-02')
    expect(shades('unloaded')).toHaveLength(0)
  })
})

describe('clustering at any window', () => {
  let originalOffsetWidth
  beforeEach(() => {
    originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return this.classList?.contains('trail-track') ? 1000 : 0 }
    })
    served = [event(2, 12, 5), event(1, 12)]
  })
  afterEach(() => {
    if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
  })

  it('draws two events five minutes apart as one badge across a day', async () => {
    await show('?span=day&at=2026-11-02')
    await waitFor(() => expect(document.querySelectorAll('.trail-track .trail-cluster')).toHaveLength(1))
  })

  it('draws them as two markers across an hour', async () => {
    await show('?from=2026-11-02T11%3A30&to=2026-11-02T12%3A30')
    await waitFor(() => expect(document.querySelectorAll('.trail-node')).toHaveLength(2))
    expect(document.querySelectorAll('.trail-track .trail-cluster')).toHaveLength(0)
  })
})
