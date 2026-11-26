/**
 * The foot of a long list says what it counts: "200 events of 18,431 events for 57 entities" beside
 * **Show 200 More Events**, and "All 57 runs shown." at the end. The noun is the caller's, the button
 * is in Title Case, and the words are the text a screen reader reads. The Audit Trail's count of
 * entities is the server's, over every matching event.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ListFoot, countWords } from '../components/common/ListFoot'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

describe('ListFoot names what it counts', () => {
  it('says the noun after each number, with thousands marked, and what the total is about', () => {
    render(<ListFoot shown={200} total={18431} step={200} noun="event" about="for 57 entities" counted onMore={() => {}} />)
    expect(screen.getByText('200 events of 18,431 events for 57 entities')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show 200 More Events' })).toBeInTheDocument()
  })

  it('says one in the singular, on the button and in the count', () => {
    render(<ListFoot shown={1} total={2} step={30} noun="run" counted onMore={() => {}} />)
    expect(screen.getByText('1 run of 2 runs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show 1 More Run' })).toBeInTheDocument()
  })

  it('takes a plural that is not the noun with an s, and puts each word of it in Title Case on the button', () => {
    render(<ListFoot shown={200} total={1543} step={200} noun="machine identity" plural="machine identities" counted onMore={() => {}} />)
    expect(screen.getByText('200 machine identities of 1,543 machine identities')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show 200 More Machine Identities' })).toBeInTheDocument()
  })

  it('ends with all of them, and what they are about', () => {
    const { rerender } = render(<ListFoot shown={57} total={57} noun="event" about="for 12 entities" onMore={() => {}} />)
    expect(screen.getByText('All 57 events for 12 entities shown.')).toBeInTheDocument()
    rerender(<ListFoot shown={1} total={1} noun="event" about="for 1 entity" onMore={() => {}} />)
    expect(screen.getByText('1 event for 1 entity shown.')).toBeInTheDocument()
  })

  it('is read as it is shown: the button is named by its words, and nothing in the foot is hidden from a screen reader', () => {
    const onMore = vi.fn()
    const { container } = render(<ListFoot shown={30} total={57} step={30} noun="run" counted onMore={onMore} />)
    const button = screen.getByRole('button', { name: 'Show 27 More Runs' })
    expect(button).toHaveTextContent('Show 27 More Runs')
    expect(button).not.toHaveAttribute('aria-label')
    expect(container.querySelector('[aria-hidden="true"], [aria-label]')).toBeNull()
    expect(container.querySelector('.list-foot')).toHaveTextContent('30 runs of 57 runs')
    fireEvent.click(button)
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('counts a word as plural() does', () => {
    expect(countWords(0, 'event')).toBe('0 events')
    expect(countWords(1, 'entity', 'entities')).toBe('1 entity')
    expect(countWords(18431, 'entity', 'entities')).toBe('18,431 entities')
  })
})

/** One gateway's audit row, as `mapAuditTrailRow` leaves it; the gateway is in the lookups below, so it is not deleted. */
const event = (id) => ({
  id, event_id: id, entity_type: 'gateways', entity_id: `gw-${id}`, action: 'UPDATE',
  recorded_at: '2026-01-01T00:00:00.000Z', timestamp: '2026-01-01T00:00:00.000Z', event_type: 'UPDATE',
  description: `Action UPDATE on gateways [gw-${id}]`, old_data: {}, new_data: {}, metadata: {},
})
const GATEWAYS = Array.from({ length: 300 }, (_, i) => ({ gateway_id: `gw-${i + 1}`, gateway_name: `Gateway ${i + 1}`, devices: [] }))

/** A page as api.get resolves it, with the page facts attached. */
const page = (events, facts) => Object.assign([...events], { purgedAssets: 0, truncated: false, nextCursor: null, totalMatching: null, ...facts })

const respond = (trail) => api.get.mockImplementation((url) => {
  const path = String(url)
  if (path.includes('/audit-trail')) return Promise.resolve(trail(path))
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
  return Promise.resolve([])
})

const cursor = { recorded_at: '2026-01-01T00:00:00.000Z', id: 41 }

describe("the Audit Trail's foot", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('says the events loaded, the events matching, and the entities they are about', async () => {
    respond(() => page([event(42), event(41)], { nextCursor: cursor, truncated: true, totalMatching: 18431, matchingEntities: 57 }))
    render(<AuditTrailTab />)
    expect(await screen.findByText('2 events of 18,431 events for 57 entities')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show 200 More Events' })).toBeInTheDocument()
  })

  it('says how many entities once every event is loaded', async () => {
    respond(() => page([event(2), event(1)], { totalMatching: 2, matchingEntities: 2 }))
    render(<AuditTrailTab />)
    expect(await screen.findByText('All 2 events for 2 entities shown.')).toBeInTheDocument()
  })

  it('names no entities against a server that gives no count of them', async () => {
    respond(() => page([event(42), event(41)], { nextCursor: cursor, truncated: true, totalMatching: 467 }))
    render(<AuditTrailTab />)
    expect(await screen.findByText('2 events of 467 events')).toBeInTheDocument()
    expect(screen.queryByText(/entit/, { selector: '.list-foot *' })).toBeNull()
  })

  it('says the same in the notice of a view that cannot reach older events', async () => {
    respond(() => page(Array.from({ length: 200 }, (_, i) => event(200 - i)), { truncated: true, totalMatching: 467, matchingEntities: 12 }))
    render(<AuditTrailTab />)
    expect(await screen.findByText(/^Showing the newest 200 events of 467 events for 12 entities — there are older ones this view cannot reach\.$/))
      .toBeInTheDocument()
  })
})
