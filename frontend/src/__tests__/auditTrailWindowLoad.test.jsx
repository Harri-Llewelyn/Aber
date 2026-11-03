/**
 * Audit Trail: a bounded window loads every event in it. Day, Week, Month, Year, a rolling or a
 * custom range pages on by itself until no page is left or WINDOW_EVENT_CAP events are loaded;
 * the "Older events not loaded" hatch then shows only where loading stopped short, and says when
 * the cap stopped it. All time loads one page and keeps Show more. A page that fails or adds
 * nothing stops the loop, and a page asked for under an older filter is dropped when it lands.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AuditTrailTab, WINDOW_EVENT_CAP } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const PAGE = 200
const DEVICES = ['Press_01', 'Press_02', 'Press_03', 'Press_04']
  .map((asset_name, i) => ({ asset_id: `dev-${i + 1}`, asset_name, last_birth_metrics: [] }))
const DAY_START = new Date(2026, 10, 1).getTime()
const DAY_MS = 24 * 60 * 60 * 1000

/** `total` events spread evenly across 1 November, newest first, as the RPC serves them. */
function dayOf(total) {
  return Array.from({ length: total }, (_, i) => {
    const id = total - i
    return {
      event_id: id, entity_type: 'devices', entity_id: `dev-${(id % 4) + 1}`, event_type: 'UPDATE',
      timestamp: new Date(DAY_START + ((id - 0.5) / total) * DAY_MS).toISOString(),
      changed_by: 'user-1', actor_source: 'user',
      old_data: { status: 'OFFLINE' }, new_data: { status: 'ONLINE' },
    }
  })
}

/** A page as api.get resolves it: the rows, with the cursor and the total attached. */
function page(rows, { nextCursor = null, totalMatching = null, truncated = false } = {}) {
  return Object.assign([...rows], { nextCursor, totalMatching, truncated, purgedAssets: 0 })
}

/** A keyset-paged server over `all`, 200 a page, older than `before_id` when it is given. */
const pagedServer = (all) => (url) => {
  const before = new URL(url, 'http://x').searchParams.get('before_id')
  const from = before ? all.findIndex(e => e.event_id < Number(before)) : 0
  const rows = from < 0 ? [] : all.slice(from, from + PAGE)
  const last = rows[rows.length - 1]
  const more = from >= 0 && from + PAGE < all.length
  return page(rows, {
    nextCursor: more ? { recorded_at: last.timestamp, id: last.event_id } : null,
    totalMatching: all.length,
  })
}

let trail
beforeEach(() => {
  vi.clearAllMocks()
  trail = pagedServer(dayOf(450))
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(trail(path))
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
})

/* Clustering needs a width; jsdom measures none. At 1,000px the thousands of events here are a
   few badges, which keeps the render quick. */
let offsetWidth
beforeEach(() => {
  offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return this.classList?.contains('trail-track') ? 1000 : 0 },
  })
})
afterEach(() => {
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
})

const trailCalls = () => api.get.mock.calls.map(c => String(c[0])).filter(u => u.includes('/audit-trail'))
const pagedCalls = () => trailCalls().filter(u => u.includes('before_id'))
const settle = () => new Promise(r => setTimeout(r, 30))
const show = async (search) => {
  window.history.replaceState(null, '', `/audit-trail${search}`)
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getAllByText('Press_01').length).toBeGreaterThan(0))
}
const unloadedShades = () => [...document.querySelectorAll('.trail-section .trail-shade-unloaded')]
const foot = () => within(document.querySelector('.list-foot'))

describe('a bounded window', () => {
  it('loads every page of the window by itself, and hatches nothing once it is covered', async () => {
    await show('?span=day&at=2026-11-01')
    await waitFor(() => expect(screen.getByText('All 450 shown.')).toBeInTheDocument())
    // One page asked for, then the two older ones, each from the cursor before it.
    expect(trailCalls()).toHaveLength(3)
    expect(pagedCalls()).toHaveLength(2)
    expect(unloadedShades()).toHaveLength(0)
  })

  it('pages on in a rolling and a custom range too', async () => {
    await show('?from=2026-11-01T00%3A00&to=2026-11-02T00%3A00')
    await waitFor(() => expect(screen.getByText('All 450 shown.')).toBeInTheDocument())
    expect(pagedCalls()).toHaveLength(2)
  })

  it('stops at the cap, and the hatch says the cap stopped it', async () => {
    trail = pagedServer(dayOf(2 * WINDOW_EVENT_CAP))
    await show('?span=day&at=2026-11-01')
    await waitFor(() => expect(foot().getByText(`${WINDOW_EVENT_CAP} of ${2 * WINDOW_EVENT_CAP}`)).toBeInTheDocument())
    await settle()
    // The cap in pages, and not one more.
    expect(trailCalls()).toHaveLength(WINDOW_EVENT_CAP / PAGE)

    const [heading] = unloadedShades()
    expect(heading).toHaveTextContent(`Older events not loaded: more than ${WINDOW_EVENT_CAP.toLocaleString('en-GB')} in this window`)
    // The newest half of the day is loaded, so the hatch is its older half.
    expect(Number(/([\d.]+) \*/.exec(heading.style.width)?.[1])).toBeCloseTo(0.5, 3)

    // Show more still goes on, a page at a time, and the window does not take over again.
    fireEvent.click(foot().getByRole('button', { name: `Show ${PAGE} more` }))
    await waitFor(() => expect(foot().getByText(`${WINDOW_EVENT_CAP + PAGE} of ${2 * WINDOW_EVENT_CAP}`)).toBeInTheDocument())
    await settle()
    expect(trailCalls()).toHaveLength(WINDOW_EVENT_CAP / PAGE + 1)
  })

  it('says the cap stopped it in fewer words where the hatch is narrow', async () => {
    // The newest 2,000 of 2,400 reach back to a sixth of the day: 167px of the 1,000.
    trail = pagedServer(dayOf(WINDOW_EVENT_CAP + 2 * PAGE))
    await show('?span=day&at=2026-11-01')
    await waitFor(() => expect(foot().getByText(`${WINDOW_EVENT_CAP} of ${WINDOW_EVENT_CAP + 2 * PAGE}`)).toBeInTheDocument())
    expect(unloadedShades()[0]).toHaveTextContent(/^Not loaded: over 2,000$/)
  })

  it('stops asking when a page adds nothing, rather than asking forever', async () => {
    const first = dayOf(450).slice(0, PAGE)
    const cursor = { recorded_at: first[PAGE - 1].timestamp, id: first[PAGE - 1].event_id }
    trail = () => page(first, { nextCursor: cursor, totalMatching: 450 })
    await show('?span=day&at=2026-11-01')
    await waitFor(() => expect(pagedCalls()).toHaveLength(1))
    await settle()
    expect(pagedCalls()).toHaveLength(1)
    // Loading stopped short of the window's start, so the hatch says so, without blaming the cap.
    expect(unloadedShades()[0]).toHaveTextContent(/^Older events not loaded$/)
  })

  it('stops asking when a page fails, and leaves Show more to try again', async () => {
    const server = pagedServer(dayOf(450))
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/audit-trail')) {
        return path.includes('before_id') ? Promise.reject(new Error('down')) : Promise.resolve(server(path))
      }
      if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
      return Promise.resolve([])
    })
    await show('?span=day&at=2026-11-01')
    await waitFor(() => expect(pagedCalls()).toHaveLength(1))
    await settle()
    expect(pagedCalls()).toHaveLength(1)
    expect(foot().getByRole('button', { name: `Show ${PAGE} more` })).toBeEnabled()
  })

  it('drops a page asked for under the window before, once another is chosen', async () => {
    // The second page of 1 November is held back until 2 November's window has loaded.
    let release
    const late = new Promise(resolve => { release = resolve })
    const november1 = pagedServer(dayOf(450))
    api.get.mockImplementation((path) => {
      if (!path.startsWith('/api/v1/audit-trail')) {
        return Promise.resolve(path.startsWith('/api/v1/devices') ? DEVICES : [])
      }
      if (path.includes(encodeURIComponent(new Date(2026, 10, 2).toISOString()))) {
        return Promise.resolve(page([{ ...dayOf(1)[0], event_id: 9001, timestamp: new Date(2026, 10, 2, 12).toISOString() }]))
      }
      return path.includes('before_id') ? late.then(() => november1(path)) : Promise.resolve(november1(path))
    })
    await show('?span=day&at=2026-11-01')
    await waitFor(() => expect(pagedCalls()).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    await waitFor(() => expect(screen.getByText('All 1 shown.')).toBeInTheDocument())
    release()
    await settle()
    // Still the one event of 2 November: 1 November's page landed and was dropped.
    expect(screen.getByText('All 1 shown.')).toBeInTheDocument()
    expect(document.querySelectorAll('.trail-node')).toHaveLength(1)
  })
})

describe('All time', () => {
  it('loads one page and keeps Show more', async () => {
    await show('')
    await waitFor(() => expect(foot().getByRole('button', { name: `Show ${PAGE} more` })).toBeInTheDocument())
    await settle()
    expect(trailCalls()).toHaveLength(1)
    // Its axis is the loaded events', so there is no part of it to hatch.
    expect(unloadedShades()).toHaveLength(0)
  })
})
