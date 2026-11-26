/**
 * A link to one Audit Trail event opens its drawer, whatever the page has loaded. Under All time the
 * page holds the newest 200 events, and a link from an old toast or a bookmark can name an older one;
 * the filters in the address can leave it out too. Such an event is read on its own with its entity's
 * events around it, a filter that leaves it out is cleared as the page is arrived at, and an event
 * nobody may read is said where the drawer would be.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn(), auditTrailEvent: vi.fn() },
  }
})

const GATEWAYS = [41, 42].map(n => ({ gateway_id: `gw-${n}`, gateway_name: `Gateway ${n}`, devices: [] }))
const DEVICES = [{ asset_id: 'dev-1', asset_name: 'Press 1', last_birth_metrics: [] }]

const row = (event_id, entity_type, entity_id, timestamp, extra = {}) => ({
  event_id, entity_type, entity_id, event_type: 'UPDATE', timestamp, class: 'operational',
  description: `Action UPDATE on ${entity_type} [${entity_id}]`, changed_by: 'user-1', actor_source: 'user',
  old_data: { status: 'OFFLINE' }, new_data: { status: 'ONLINE' }, ...extra,
})

/** The first page: two gateways' events, newest first. */
const LOADED = [row(42, 'gateways', 'gw-42', '2026-11-20T10:00:00Z'), row(41, 'gateways', 'gw-41', '2026-11-20T09:00:00Z')]
/** A device's history from long before the first page: the link names the middle one. */
const PRESS = [
  row(9, 'devices', 'dev-1', '2025-03-03T09:00:00Z'),
  row(7, 'devices', 'dev-1', '2025-03-02T09:00:00Z', { old_data: { name: 'Press A' }, new_data: { name: 'Press 1' } }),
  row(5, 'devices', 'dev-1', '2025-03-01T09:00:00Z'),
]
const page = (events, facts = {}) => Object.assign([...events], { purgedAssets: 0, truncated: false, nextCursor: null, totalMatching: null, ...facts })

/** The trail's reads: the page, and a read for one entity under the filters, which the search is asked by. */
let underFilters
beforeEach(() => {
  vi.clearAllMocks()
  underFilters = []
  api.get.mockImplementation((url) => {
    const path = String(url)
    if (path.includes('/audit-trail')) return Promise.resolve(page(path.includes('entity_ids=') ? underFilters : LOADED))
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
  api.auditTrailEvent.mockResolvedValue({ event: PRESS[1], events: PRESS, olderUnread: false, newerUnread: false })
})

const arrive = (query) => {
  window.history.replaceState(null, '', `/audit-trail?${query}`)
  render(<AuditTrailTab />)
}
const drawer = () => document.querySelector('.context-panel-open')
const params = () => new URLSearchParams(window.location.search)
const title = () => drawer()?.querySelector('.context-panel-title')?.textContent ?? ''
const position = () => document.querySelector('.trail-drawer-nav-pos')?.textContent ?? ''

describe('a link to an event the page has not loaded', () => {
  it('reads it on its own and opens its drawer, placed among its entity\'s events', async () => {
    arrive('event=7')
    await waitFor(() => expect(drawer()).toBeTruthy())
    expect(api.auditTrailEvent).toHaveBeenCalledWith('7')
    expect(title()).toBe('Press 1')
    expect(drawer()).toHaveTextContent('Mutation ID')
    expect(drawer()).toHaveTextContent('7')
    expect(position()).toBe('Event 2 of 3')
  })

  it('steps along the events read with it, without reading again', async () => {
    arrive('event=7')
    await waitFor(() => expect(position()).toBe('Event 2 of 3'))
    fireEvent.click(within(document.querySelector('.trail-drawer-nav-btns')).getByRole('button', { name: /Previous$/ }))
    await waitFor(() => expect(params().get('event')).toBe('5'))
    expect(position()).toBe('Event 1 of 3')
    expect(api.auditTrailEvent).toHaveBeenCalledTimes(1)
  })

  it('reads nothing on its own for an event the page holds', async () => {
    arrive('event=42')
    await waitFor(() => expect(drawer()).toBeTruthy())
    expect(title()).toBe('Gateway 42')
    expect(api.auditTrailEvent).not.toHaveBeenCalled()
  })
})

describe('a filter in the address that leaves the event out', () => {
  it('is cleared on arrival: the kinds, the actions and the classes', async () => {
    arrive('type=GATEWAY&action=DELETE&class=lifecycle&event=7')
    await waitFor(() => expect(drawer()).toBeTruthy())
    await waitFor(() => expect(params().get('type')).toBeNull())
    expect(params().get('action')).toBeNull()
    expect(params().get('class')).toBeNull()
    expect(params().get('event')).toBe('7')
  })

  it('is cleared on arrival: a window the event is outside', async () => {
    arrive('span=day&at=2026-11-20&event=7')
    await waitFor(() => expect(drawer()).toBeTruthy())
    await waitFor(() => expect(params().get('span')).toBeNull())
    expect(params().get('event')).toBe('7')
  })

  it('is cleared on arrival: a search the page\'s own read says leaves it out', async () => {
    arrive('search=Gateway&event=7')
    await waitFor(() => expect(drawer()).toBeTruthy())
    await waitFor(() => expect(params().get('search')).toBeNull())
    const asked = api.get.mock.calls.map(c => String(c[0])).find(u => u.includes('entity_ids='))
    expect(asked).toContain('entity_ids=dev-1')
    expect(asked).toContain('search=Gateway')
    expect(asked).toContain('before_id=8')
  })

  it('is kept when it holds the event, which only the paging left out', async () => {
    underFilters = [PRESS[1]]
    arrive('search=Press&event=7')
    await waitFor(() => expect(drawer()).toBeTruthy())
    await waitFor(() => expect(api.get.mock.calls.some(c => String(c[0]).includes('entity_ids='))).toBe(true))
    expect(params().get('search')).toBe('Press')
  })

  it('is cleared once for the arrival: a filter chosen with the drawer open stays', async () => {
    arrive('event=7')
    await waitFor(() => expect(drawer()).toBeTruthy())
    const legend = within(screen.getByRole('group', { name: 'Classes' }))
    fireEvent.click(legend.getAllByRole('button').find(b => b.textContent.startsWith('Lifecycle')))
    await waitFor(() => expect(params().get('class')).toBe('lifecycle'))
    // The event stays open, read on its own, though the class it is in is not chosen.
    expect(title()).toBe('Press 1')
    expect(params().get('class')).toBe('lifecycle')
  })

  it('is not asked about, nor cleared, when the page holds the event', async () => {
    arrive('type=GATEWAY&event=42')
    await waitFor(() => expect(drawer()).toBeTruthy())
    expect(params().get('type')).toBe('GATEWAY')
    expect(api.get.mock.calls.some(c => String(c[0]).includes('entity_ids='))).toBe(false)
  })
})

describe('a link to no event', () => {
  it('opens the drawer to say there is none, or none this reader may read', async () => {
    api.auditTrailEvent.mockResolvedValue(null)
    arrive('event=12345')
    await waitFor(() => expect(drawer()).toBeTruthy())
    expect(title()).toBe('No such event')
    expect(drawer()).toHaveTextContent('No audit event has this id, or you may not read it.')
    expect(document.querySelector('.trail-drawer-nav')).toBeNull()
  })

  it('says it could not read the event when the read fails', async () => {
    api.auditTrailEvent.mockRejectedValue(new Error('connection reset'))
    arrive('event=12345')
    await waitFor(() => expect(drawer()).toBeTruthy())
    expect(drawer()).toHaveTextContent('Could not read this event: connection reset')
  })

  it('closes, and the address lets go of the event', async () => {
    api.auditTrailEvent.mockResolvedValue(null)
    arrive('event=12345')
    await waitFor(() => expect(drawer()).toBeTruthy())
    fireEvent.click(within(drawer()).getByRole('button', { name: /Close/ }))
    await waitFor(() => expect(params().get('event')).toBeNull())
    expect(drawer()).toBeNull()
  })
})
