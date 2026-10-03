/**
 * The Audit Trail's second page, and the ways paging loses data silently. A page showing the
 * newest 200 of several thousand events looks exactly like a page showing all of them, so these
 * assert what is on screen and what was asked for, not internal state.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import {
  AuditTrailTab, mergeFirstPage, countRatio, isPartial,
} from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { AUDIT_TRAIL_ENTITY_TYPES } from '../constants'

// Spread from the real module, not replaced: api.js exports constants the tab reads at import time,
// and a bare stub drops them, which renders as an empty timeline.
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

/**
 * One audit row, shaped as `mapAuditTrailRow` leaves it. Its gateway must exist in the lookups
 * below, or the deleted-entity filter hides it and every assertion fails for a reason that is not
 * paging.
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

/**
 * Every schema any fixture here refers to. Seeded for the same reason as GATEWAYS: a schema the
 * lookup cannot name reads as deleted, and these fixtures are about sections and counts.
 */
const SCHEMAS = [
  { id: 'c0000000-0000-4000-8000-000000000003', schema_name: 'Robot pose', version: 1 },
]

/**
 * A page as api.get resolves it: the array IS the resource, with the page facts attached.
 * `totalMatching` defaults to null, which is what a server that gives no total returns and what every
 * fixture here that is not about the total leaves it as.
 */
function page (events, {
  nextCursor = null, truncated = false, purgedAssets = 0, totalMatching = null,
} = {}) {
  const rows = [...events]
  rows.nextCursor = nextCursor
  rows.truncated = truncated
  rows.purgedAssets = purgedAssets
  rows.totalMatching = totalMatching
  return rows
}

/**
 * Everything the tab fetches that is not the trail itself resolves empty. The trail request is
 * matched by path.
 */
function respond (trailHandler) {
  api.get.mockImplementation((url) => {
    const path = String(url)
    if (path.includes('/audit-trail')) return Promise.resolve(trailHandler(path))
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    if (path.startsWith('/api/v1/schemas')) return Promise.resolve(SCHEMAS)
    return Promise.resolve([])
  })
}

const trailCalls = () =>
  api.get.mock.calls.map(c => String(c[0])).filter(u => u.includes('/audit-trail'))

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers() })

// mergeFirstPage, the poll's bookkeeping, tested directly. Its failure mode is a reader losing
// pages they scrolled back to, sixty seconds after loading them.
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

  // The case that must not merge: if more events arrived than a page holds, the polled page and the
  // held list no longer touch, and splicing them would leave a hole.
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

// The control, and what it asks the server for.
describe('AuditTrailTab paging', () => {
  it('offers no Show more when the first page is the whole trail', async () => {
    respond(() => page([event(2), event(1)], { nextCursor: null }))
    render(<AuditTrailTab />)
    await waitFor(() => expect(trailCalls().length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.queryByText(/Loading the Audit Trail/)).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument()
  })

  it('sends BOTH halves of the cursor, because recorded_at alone is not unique', async () => {
    const cursor = { recorded_at: '2026-01-01T00:00:00.000Z', id: 41 }
    respond((url) => url.includes('before_id')
      ? page([event(40)], { nextCursor: null })
      : page([event(42), event(41)], { nextCursor: cursor, truncated: true }))

    render(<AuditTrailTab />)
    const button = await screen.findByRole('button', { name: /Show \d+ more/ })
    fireEvent.click(button)

    await waitFor(() => expect(trailCalls().some(u => u.includes('before_id'))).toBe(true))
    const paged = trailCalls().find(u => u.includes('before_id'))
    // A half-cursor makes the server's row comparison NULL, which filters out every row and reads
    // as "end of trail" on a trail that has plenty. Both or neither.
    expect(paged).toContain('before_id=41')
    expect(paged).toContain(`before_recorded_at=${encodeURIComponent(cursor.recorded_at)}`)
  })

  it('appends the next page instead of replacing the first', async () => {
    respond((url) => url.includes('before_id')
      ? page([event(2), event(1)], { nextCursor: null })
      : page([event(4), event(3)], {
          nextCursor: { recorded_at: '2026-01-01T00:00:00.000Z', id: 3 }, truncated: true
        }))

    render(<AuditTrailTab />)
    fireEvent.click(await screen.findByRole('button', { name: /Show \d+ more/ }))

    // Four events across two pages, and the foot is the page's own claim about itself.
    expect(await screen.findByText('All 4 shown.')).toBeInTheDocument()
    expect(document.querySelectorAll('.trail-node')).toHaveLength(4)
  })

  // The whole point of the change: a cut-off view must say so. This is what was missing.
  it('says the view is cut off when the server reports truncation with no cursor', async () => {
    respond(() => page(
      Array.from({ length: 200 }, (_, i) => event(200 - i)),
      { nextCursor: null, truncated: true }
    ))
    render(<AuditTrailTab />)
    expect(await screen.findByText(/there are older ones this view cannot reach/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument()
  })

  it('says All N shown once every matching event is loaded', async () => {
    respond(() => page(
      Array.from({ length: 200 }, (_, i) => event(200 - i)),
      { nextCursor: null, truncated: false, totalMatching: 200 }
    ))
    render(<AuditTrailTab />)
    expect(await screen.findByText('All 200 shown.')).toBeInTheDocument()
  })

  it('names the step the button takes, then closes with All N shown', async () => {
    const cursor = { recorded_at: '2026-01-01T00:00:00.000Z', id: 41 }
    respond((url) => url.includes('before_id')
      ? page([event(40)], { nextCursor: null, totalMatching: 3 })
      : page([event(42), event(41)], { nextCursor: cursor, truncated: true, totalMatching: 3 }))
    render(<AuditTrailTab />)
    const button = await screen.findByRole('button', { name: 'Show 1 more' })
    fireEvent.click(button)
    expect(await screen.findByText('All 3 shown.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show d+ more/ })).toBeNull()
  })

  it('reads All N shown on a stack smaller than one page', async () => {
    respond(() => page([event(2), event(1)], { nextCursor: null, truncated: false }))
    render(<AuditTrailTab />)
    expect(await screen.findByText('All 2 shown.')).toBeInTheDocument()
    // Everything is loaded, so the foot states no count beside it.
    expect(screen.queryByText(/\d+ of \d+/)).toBeNull()
    expect(document.querySelector('.trail-pagination')).toBeNull()
  })

  it('keeps the key row while loading and when nothing matches, and counts nothing', async () => {
    let release
    const pending = new Promise(resolve => { release = resolve })
    respond(() => pending)
    render(<AuditTrailTab />)
    expect(await screen.findByText('Loading the Audit Trail…')).toBeInTheDocument()
    expect(document.querySelector('.trail-header .trail-legend')).toBeTruthy()
    expect(document.querySelector('.list-foot')).toBeNull()
    release(page([], { nextCursor: null, totalMatching: 0 }))
    await waitFor(() => expect(screen.queryByText('Loading the Audit Trail…')).toBeNull())
    expect(document.querySelector('.trail-header .trail-legend')).toBeTruthy()
    expect(document.querySelector('.list-foot')).toBeNull()
    expect(screen.queryByText(/All \d+ shown/)).toBeNull()
  })
})

/**
 * Every lane the header counts is a lane the timeline draws. A section list is a presentation
 * choice and must never also act as a filter, so these assert the invariant rather than the kinds.
 */
describe('AuditTrailTab section coverage', () => {
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

    render(<AuditTrailTab />)
    // The headings are what say a lane was drawn at all.
    expect(await screen.findByLabelText('Role assignments lanes')).toBeInTheDocument()
    expect(screen.getByLabelText('Machine identities lanes')).toBeInTheDocument()
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

    render(<AuditTrailTab />)
    expect(await screen.findByLabelText('SOMETHING_NEW lanes')).toBeInTheDocument()
  })

  it('offers every kind it can draw, so a drawable lane is never unaskable', async () => {
    // The filter is asserted against the shared table rather than a list of kinds, because the
    // failure was two lists of the same thing disagreeing.
    respond(() => page([laneEvent(1, 'gateways', 'gw-1')], { nextCursor: null }))

    render(<AuditTrailTab />)
    await screen.findByLabelText('Gateways lanes')

    // The kind filter lives in the Filters popover.
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    const select = screen.getByTitle('Show only events against one kind of entity')
    const options = [...select.querySelectorAll('option')]

    for (const { kind, label } of AUDIT_TRAIL_ENTITY_TYPES) {
      const option = options.find(o => o.value === kind)
      expect(option, `no filter option for ${kind}`).toBeTruthy()
      expect(option.textContent).toBe(label)
    }
    // Every entry, plus the unfiltered default and nothing else.
    expect(options).toHaveLength(AUDIT_TRAIL_ENTITY_TYPES.length + 1)
    expect(options[0].value).toBe('')
  })

  it('draws a lane for every entity it holds, and the foot counts the events', async () => {
    // ENTITIES, not assets. Two of these three lanes are a role assignment and a schema, neither
    // of which is a thing on the shopfloor.
    respond(() => page([
      laneEvent(3, 'user_roles', 'a0000000-0000-4000-8000-000000000001'),
      laneEvent(2, 'schemas', 'c0000000-0000-4000-8000-000000000003'),
      laneEvent(1, 'gateways', 'gw-1'),
    ], { nextCursor: null }))

    render(<AuditTrailTab />)
    await screen.findByLabelText('Gateways lanes')
    expect(screen.getAllByRole('separator')).toHaveLength(3)
    expect(document.querySelectorAll('.trail-lane:not(.trail-axis)')).toHaveLength(3)
    expect(screen.getByText('All 3 shown.')).toBeInTheDocument()
  })
})

// =================================================================================================
// HOW MUCH OF THE TRAIL THIS IS
//
// "200 events" above a button offering 200 more is the same sentence whether the next page is the
// last or the third of twelve. The server counts the whole match and the page names it.
// =================================================================================================
describe('the count ratio', () => {
  it('names the whole match when the page is a fraction of it', () => {
    expect(countRatio(200, 467)).toBe('200/467')
  })

  it('degrades to a plain count once everything matching is drawn', () => {
    // The equal case is the end of the trail. "467/467" is a fraction of itself and reads as
    // though something were still missing.
    expect(countRatio(467, 467)).toBe('467')
  })

  it('names the drawn events alone when the server did not say how many match', () => {
    // A response with no total. The alternative is "200/null", which is what a bare-array fixture
    // and an older database would both have produced.
    expect(countRatio(200, undefined)).toBe('200')
    expect(isPartial(200, null)).toBe(false)
  })

  it('does not dress a total below the page up as a fraction', () => {
    // Cannot happen against a server that counts before the cursor, which is the point of counting
    // there. If it ever does, the page says what it is holding rather than a number it cannot be.
    expect(countRatio(200, 3)).toBe('200')
  })
})

/**
 * Searching for something that has been deleted. Sending the search as text stopped the page
 * ASKING for nothing; it did not stop the page SHOWING nothing, because deleted entities are hidden
 * by default and a search naming one matches only hidden rows. The reader saw "no events match"
 * with the answer behind a toggle they had no reason to try.
 */
describe('AuditTrailTab empty state', () => {
  it('offers the deleted entities when the filters match only those', async () => {
    // `purged_assets` is counted over everything the filters select INCLUDING the search, so an
    // empty page with a non-zero count is exactly this case and needs no second request.
    respond(() => page([], { nextCursor: null, purgedAssets: 1, totalMatching: 0 }))
    render(<AuditTrailTab />)

    expect(await screen.findByText(/one deleted entity does/i)).toBeInTheDocument()
    /* SCOPED TO THE EMPTY STATE. The filter bar carries the same control whenever anything is
       hidden, so an unscoped query finds two -- which is the arrangement here: the bar keeps the
       toggle available once there are results, and this restates it where the reader is actually
       looking and says why it would help. */
    const offer = within(document.querySelector('.empty-state'))
      .getByRole('button', { name: /Show deleted entities \(1\)/ })
    fireEvent.click(offer)
    // And the click asks the server for them, rather than only re-filtering what is held.
    await waitFor(() => expect(trailCalls().some(u => u.includes('include_purged=true'))).toBe(true))
  })

  it('counts more than one of them in words that agree', async () => {
    respond(() => page([], { nextCursor: null, purgedAssets: 4, totalMatching: 0 }))
    render(<AuditTrailTab />)
    expect(await screen.findByText(/4 deleted entities do/i)).toBeInTheDocument()
  })

  it('says plainly that nothing matches when nothing does', async () => {
    // No deleted entities behind the filter either: offering the toggle here would send the reader
    // after something that is not there.
    respond(() => page([], { nextCursor: null, purgedAssets: 0, totalMatching: 0 }))
    render(<AuditTrailTab />)

    expect(await screen.findByText(/No audit trail events match the filter criteria/i))
      .toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show deleted entities/ })).toBeNull()
  })

  it('does not offer them again once they are shown', async () => {
    respond(() => page([], { nextCursor: null, purgedAssets: 2, totalMatching: 0 }))
    render(<AuditTrailTab />)

    await screen.findByText(/2 deleted entities do/i)
    fireEvent.click(within(document.querySelector('.empty-state'))
      .getByRole('button', { name: /Show deleted entities \(2\)/ }))
    // Still empty, but the toggle is on: repeating the offer would be a loop with no exit.
    await waitFor(() =>
      expect(screen.getByText(/No audit trail events match the filter criteria/i)).toBeInTheDocument())
  })
})

describe('AuditTrailTab total', () => {
  const cursor = { recorded_at: '2026-01-01T00:00:00.000Z', id: 41 }

  it('says what fraction of the match is loaded, once, beside Show more', async () => {
    respond(() => page([event(42), event(41)], {
      nextCursor: cursor, truncated: true, totalMatching: 467,
    }))
    render(<AuditTrailTab />)

    expect(await screen.findByText('2 of 467')).toBeInTheDocument()
    // Once: not again above the timeline, where it used to sit beside the key.
    expect(screen.getAllByText(/2 of 467/)).toHaveLength(1)
    expect(document.querySelector('.trail-header').textContent).not.toMatch(/\d/)
    expect(screen.getByRole('button', { name: /Show \d+ more/ })).toBeInTheDocument()
  })

  it('draws the count in the foot beside Show more, with only the key above the timeline', async () => {
    /* Asserted by POSITION and not only by text: the count states what is loaded, so it sits with
       the control that loads more. */
    respond(() => page([event(42), event(41)], {
      nextCursor: cursor, truncated: true, totalMatching: 467,
    }))
    render(<AuditTrailTab />)
    const count = await screen.findByText('2 of 467')
    expect(count.parentElement).toHaveClass('list-foot')
    expect(count.nextElementSibling).toHaveTextContent(/Show \d+ more/)
    // The row above the timeline holds the key alone, with the scroller directly under it.
    const header = document.querySelector('.trail-header')
    expect([...header.children].map(c => c.className)).toEqual(['trail-legend'])
    expect(header.nextElementSibling).toHaveClass('trail-scroll')
    // And not in the corner, which is only the spacer that lines the ticks up.
    expect(document.querySelector('.trail-axis-corner').textContent).toBe('')
  })

  it('drops the count when the loaded page is the whole match', async () => {
    respond(() => page([event(2), event(1)], { nextCursor: null, totalMatching: 2 }))
    render(<AuditTrailTab />)
    expect(await screen.findByText('All 2 shown.')).toBeInTheDocument()
    expect(screen.queryByText(/2\/2|2 of 2/)).not.toBeInTheDocument()
  })

  it('states no count against a server that returns no total, whose total is only an estimate', async () => {
    // Every other fixture in this file leaves `totalMatching` null, so this is the state they all
    // assert against; stated once, explicitly, so the fallback is a decision rather than a default.
    respond(() => page([event(2), event(1)], { nextCursor: cursor, truncated: true }))
    render(<AuditTrailTab />)
    expect(await screen.findByRole('button', { name: /Show \d+ more/ })).toBeInTheDocument()
    expect(screen.queryByText(/\d+ of \d+/)).not.toBeInTheDocument()
    expect(screen.queryByText(/of null|of undefined|NaN|\/null|\/undefined/)).not.toBeInTheDocument()
  })

  it('holds the total still while the drawn count climbs towards it', async () => {
    // A total recomputed after the cursor would count DOWN as the reader walked, which reads as
    // rows leaving an append-only table.
    respond((url) => url.includes('before_id')
      ? page([event(40), event(39)], { nextCursor: null, totalMatching: 4 })
      : page([event(42), event(41)], { nextCursor: cursor, truncated: true, totalMatching: 4 }))

    render(<AuditTrailTab />)
    await screen.findByText('2 of 4')
    fireEvent.click(screen.getByRole('button', { name: /Show \d+ more/ }))

    // Four of four is the whole match, so the fraction goes.
    expect(await screen.findByText('All 4 shown.')).toBeInTheDocument()
    expect(screen.queryByText(/4\/4/)).not.toBeInTheDocument()
  })

  it('names the total in the cut-off notice, which had only its own page to name', async () => {
    respond(() => page(
      Array.from({ length: 200 }, (_, i) => event(200 - i)),
      { nextCursor: null, truncated: true, totalMatching: 467 }
    ))
    render(<AuditTrailTab />)
    expect(await screen.findByText(/newest 200 of 467 events/i)).toBeInTheDocument()
  })

  it('Export CSV says it writes the page rather than the match', async () => {
    // The button read "(200)" beside a tooltip promising "the events matching the current
    // filters", and wrote the 200. At 200 of 467 that is two thirds of the answer missing from a
    // file somebody takes away as the record.
    respond(() => page([event(42), event(41)], {
      nextCursor: cursor, truncated: true, totalMatching: 467,
    }))
    render(<AuditTrailTab />)

    const button = await screen.findByRole('button', { name: /Export CSV/ })
    expect(button).toHaveTextContent('Export CSV (2/467)')
    expect(button.getAttribute('title')).toMatch(/loaded here/i)
    expect(button.getAttribute('title')).toMatch(/467 match the current filters/i)
  })

  it('Export CSV promises the filtered set once it really holds it', async () => {
    respond(() => page([event(2), event(1)], { nextCursor: null, totalMatching: 2 }))
    render(<AuditTrailTab />)

    const button = await screen.findByRole('button', { name: /Export CSV/ })
    expect(button).toHaveTextContent('Export CSV (2)')
    expect(button.getAttribute('title')).toBe(
      'Download the events matching the current filters as CSV'
    )
  })
})
