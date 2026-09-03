/**
 * The Digital Thread's second page, and the two ways paging loses data silently.
 *
 * =================================================================================================
 * WHY THIS SUITE EXISTS AT ALL
 *
 * `truncated` was returned by the server, stored in this component, and never rendered -- for long
 * enough that nobody could say when it broke, because a page showing the newest 200 of several
 * thousand events looks exactly like a page showing all of them. Every failure paging can have is
 * that shape: nothing throws, nothing is empty, the reader simply sees less than they believe they
 * are seeing. So these assert what is ON SCREEN and what was ASKED FOR, not internal state.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { DigitalThreadTab, mergeFirstPage } from '../components/tabs/DigitalThreadTab'
import { api } from '../api'

// SPREAD FROM THE REAL MODULE, not replaced. api.js exports constants the tab reads at import time
// as well as the client, and a bare stub silently drops them -- which renders as an empty timeline
// rather than as a missing-export error, so every assertion here fails for a reason that has
// nothing to do with paging.
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

/**
 * One audit row, shaped as `mapDigitalThreadRow` leaves it.
 *
 * ITS GATEWAY MUST EXIST IN THE LOOKUPS BELOW. The tab hides events whose asset is absent from
 * /api/v1/{cells,gateways,devices} -- that is the purged-asset filter -- so a fixture with an
 * entity nothing can name renders as an empty timeline and every assertion here fails for a reason
 * that is not paging.
 */
function event (id, recordedAt = '2026-01-01T00:00:00.000Z') {
  return {
    id,
    event_id: id,
    entity_type: 'gateways',
    entity_id: `gw-${id}`,
    action: 'UPDATE',
    recorded_at: recordedAt,
    timestamp: recordedAt,
    event_type: 'UPDATE',
    description: `Action UPDATE on gateways [gw-${id}]`,
    old_data: {},
    new_data: {},
    metadata: {},
  }
}

/** Every gateway any fixture in this file refers to, so none of them reads as deleted. */
const GATEWAYS = Array.from({ length: 300 }, (_, i) => ({
  gateway_id: `gw-${i + 1}`, gateway_name: `Gateway ${i + 1}`, devices: []
}))

/** A page as api.get resolves it: the array IS the resource, with the page facts attached. */
function page (events, { nextCursor = null, truncated = false, purgedAssets = 0 } = {}) {
  const rows = [...events]
  rows.nextCursor = nextCursor
  rows.truncated = truncated
  rows.purgedAssets = purgedAssets
  return rows
}

/**
 * Everything the tab fetches that is not the thread itself resolves empty, so the component
 * mounts. The thread request is the one under test and is matched by path.
 */
function respond (threadHandler) {
  api.get.mockImplementation((url) => {
    const path = String(url)
    if (path.includes('/digital-thread')) return Promise.resolve(threadHandler(path))
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    return Promise.resolve([])
  })
}

const threadCalls = () =>
  api.get.mock.calls.map(c => String(c[0])).filter(u => u.includes('/digital-thread'))

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers() })

// -------------------------------------------------------------------------------------------------
// mergeFirstPage -- the poll's bookkeeping, tested directly.
//
// Its failure mode is a reader losing pages they scrolled back to, sixty seconds after loading
// them, with nothing on screen to say so.
// -------------------------------------------------------------------------------------------------
describe('mergeFirstPage', () => {
  it('keeps deeper pages when a poll returns what is already held', () => {
    const held = [event(10), event(9), event(8), event(7)]
    const polled = [event(10), event(9)]
    const { events, reset } = mergeFirstPage(held, polled)
    expect(events.map(e => e.event_id)).toEqual([10, 9, 8, 7])
    expect(reset).toBe(false)
  })

  it('prepends genuinely new rows without disturbing the tail', () => {
    const held = [event(10), event(9), event(8)]
    const polled = [event(12), event(11), event(10), event(9)]
    const { events, reset } = mergeFirstPage(held, polled)
    expect(events.map(e => e.event_id)).toEqual([12, 11, 10, 9, 8])
    expect(reset).toBe(false)
  })

  // THE CASE THAT MUST NOT MERGE. If more events arrived than a page holds, the polled page and
  // the held list no longer touch -- splicing them would produce one list with a hole in the
  // middle and no indication there was one.
  it('starts again when the polled page and the held list do not overlap', () => {
    const held = [event(3), event(2), event(1)]
    const polled = [event(99), event(98)]
    const { events, reset } = mergeFirstPage(held, polled)
    expect(events.map(e => e.event_id)).toEqual([99, 98])
    expect(reset).toBe(true)
  })

  it('treats an empty held list as a first load rather than as a gap', () => {
    const { events, reset } = mergeFirstPage([], [event(2), event(1)])
    expect(events.map(e => e.event_id)).toEqual([2, 1])
    expect(reset).toBe(true)
  })

  // An empty poll is not a gap: it is a filter matching nothing, and it must not wipe the list.
  it('does not treat an empty polled page as a gap', () => {
    const held = [event(2), event(1)]
    const { events, reset } = mergeFirstPage(held, [])
    expect(events.map(e => e.event_id)).toEqual([2, 1])
    expect(reset).toBe(false)
  })
})

// -------------------------------------------------------------------------------------------------
// The control, and what it asks the server for.
// -------------------------------------------------------------------------------------------------
describe('DigitalThreadTab paging', () => {
  it('offers no Load more when the first page is the whole thread', async () => {
    respond(() => page([event(2), event(1)], { nextCursor: null }))
    render(<DigitalThreadTab />)
    await waitFor(() => expect(threadCalls().length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.queryByText(/Loading digital thread/)).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Load \d+ more/ })).not.toBeInTheDocument()
  })

  it('sends BOTH halves of the cursor, because recorded_at alone is not unique', async () => {
    const cursor = { recorded_at: '2026-01-01T00:00:00.000Z', id: 41 }
    respond((url) => url.includes('before_id')
      ? page([event(40)], { nextCursor: null })
      : page([event(42), event(41)], { nextCursor: cursor, truncated: true }))

    render(<DigitalThreadTab />)
    const button = await screen.findByRole('button', { name: /Load \d+ more/ })
    fireEvent.click(button)

    await waitFor(() => expect(threadCalls().some(u => u.includes('before_id'))).toBe(true))
    const paged = threadCalls().find(u => u.includes('before_id'))
    // A half-cursor makes the server's row comparison NULL, which filters out every row and reads
    // as "end of thread" on a thread that has plenty. Both or neither.
    expect(paged).toContain('before_id=41')
    expect(paged).toContain(`before_recorded_at=${encodeURIComponent(cursor.recorded_at)}`)
  })

  it('appends the next page instead of replacing the first', async () => {
    respond((url) => url.includes('before_id')
      ? page([event(2), event(1)], { nextCursor: null })
      : page([event(4), event(3)], {
          nextCursor: { recorded_at: '2026-01-01T00:00:00.000Z', id: 3 }, truncated: true
        }))

    render(<DigitalThreadTab />)
    fireEvent.click(await screen.findByRole('button', { name: /Load \d+ more/ }))

    // Four events across two pages, and the count is the page's own claim about itself.
    await waitFor(() => expect(screen.getByText(/^4 events$/)).toBeInTheDocument())
  })

  // The whole point of the change: a cut-off view must say so. This is what was missing.
  it('says the view is cut off when the server reports truncation with no cursor', async () => {
    respond(() => page(
      Array.from({ length: 200 }, (_, i) => event(200 - i)),
      { nextCursor: null, truncated: true }
    ))
    render(<DigitalThreadTab />)
    expect(await screen.findByText(/there are older ones this view cannot reach/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Load \d+ more/ })).not.toBeInTheDocument()
  })

  it('announces the end only once a page boundary was actually met', async () => {
    respond(() => page(
      Array.from({ length: 200 }, (_, i) => event(200 - i)),
      { nextCursor: null, truncated: false }
    ))
    render(<DigitalThreadTab />)
    expect(await screen.findByText(/every event matching these filters is loaded/i)).toBeInTheDocument()
  })

  it('stays quiet about the end on a stack smaller than one page', async () => {
    respond(() => page([event(2), event(1)], { nextCursor: null, truncated: false }))
    render(<DigitalThreadTab />)
    await waitFor(() => expect(screen.getByText(/^2 events$/)).toBeInTheDocument())
    expect(screen.queryByText(/every event matching these filters is loaded/i)).not.toBeInTheDocument()
  })

  // A page can filter to nothing in the browser -- the description search runs after the fetch --
  // and the footer must not then claim the reader is seeing everything that was loaded.
  it('reports the loaded total and the drawn total separately when they differ', async () => {
    respond(() => page([event(3), event(2), event(1)], { nextCursor: null, purgedAssets: 0 }))
    render(<DigitalThreadTab />)
    await waitFor(() => expect(screen.getByText(/^3 events$/)).toBeInTheDocument())
  })
})

/**
 * Every lane the header counts is a lane the timeline draws.
 *
 * THE BUG THIS PINS was a header reading "28 assets · 167 events" above a single drawn row.
 * `sections` kept only the kinds a hardcoded list named, and the list had three entries while
 * `ENTITY_KIND` had seven -- so role assignments (20 lanes, 136 events), service identities and
 * schemas were counted and silently discarded. The whole security lane of the audit, which is the
 * half an Auditor comes for, could not be rendered at all.
 *
 * These assert the INVARIANT rather than the four kinds that were missing: a section list is a
 * presentation choice and must never also act as a filter.
 */
describe('DigitalThreadTab section coverage', () => {
  const laneEvent = (id, entityType, entityId) => ({
    ...event(id), entity_type: entityType, entity_id: entityId,
    description: `Action UPDATE on ${entityType} [${entityId}]`,
  })

  it('draws the security lane the audit records, not only the three asset types', async () => {
    respond(() => page([
      laneEvent(4, 'user_roles', 'a0000000-0000-4000-8000-000000000001'),
      laneEvent(3, 'service_principals', 'b0000000-0000-4000-8000-000000000002'),
      laneEvent(2, 'schemas', 'c0000000-0000-4000-8000-000000000003'),
      laneEvent(1, 'gateways', 'gw-1'),
    ], { nextCursor: null }))

    render(<DigitalThreadTab />)
    // The headings are what say a lane was drawn at all.
    expect(await screen.findByLabelText('Role assignments lanes')).toBeInTheDocument()
    expect(screen.getByLabelText('Service identities lanes')).toBeInTheDocument()
    expect(screen.getByLabelText('Schemas lanes')).toBeInTheDocument()
    expect(screen.getByLabelText('Gateways lanes')).toBeInTheDocument()
  })

  it('draws a kind nothing has a section for, rather than dropping it', async () => {
    // The failure was not the missing kinds, it was that a missing kind vanished. A new entity type
    // reaching the audit trigger must degrade to "plain icon", never to "absent".
    respond(() => page([
      laneEvent(2, 'something_new', 'd0000000-0000-4000-8000-000000000004'),
      laneEvent(1, 'gateways', 'gw-1'),
    ], { nextCursor: null }))

    render(<DigitalThreadTab />)
    expect(await screen.findByLabelText('SOMETHING_NEW lanes')).toBeInTheDocument()
  })

  it('the asset count in the header equals the lanes actually drawn', async () => {
    // The reconcilable-number property, stated directly: this is what a reader checks the page
    // against, and it was wrong by 27 on the stack that found it.
    respond(() => page([
      laneEvent(3, 'user_roles', 'a0000000-0000-4000-8000-000000000001'),
      laneEvent(2, 'schemas', 'c0000000-0000-4000-8000-000000000003'),
      laneEvent(1, 'gateways', 'gw-1'),
    ], { nextCursor: null }))

    render(<DigitalThreadTab />)
    await screen.findByLabelText('Gateways lanes')
    const drawn = screen.getAllByRole('separator').length
    expect(drawn).toBe(3)
    expect(screen.getByText(/3 assets · 3 events/)).toBeInTheDocument()
  })
})
