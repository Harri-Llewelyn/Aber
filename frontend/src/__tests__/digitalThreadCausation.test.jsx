/**
 * Digital Thread: reading one operator action back as one act. `causation_id` is `txid_current()`,
 * so every row a transaction writes shares it. This suite pins two claims about what the page must
 * not say: a NULL causation is not a group (legacy rows carry NULL, and matching NULL to NULL would
 * fabricate a causal link), and absence asserts nothing (the sibling list is drawn from the
 * fetched, filtered set, so it is a lower bound and renders only when siblings exist).
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DigitalThreadTab, causationSiblings } from '../components/tabs/DigitalThreadTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }]
const GATEWAYS = [{ gateway_id: 'gw-1', gateway_name: 'Virtual_Gateway_NodeRED', devices: [] }]
const DEVICES = [
  { asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] },
  { asset_id: 'dev-2', asset_name: 'Press_02', last_birth_metrics: [] }
]

/**
 * A schema rebinding across two devices, plus one unrelated edit a second later. The unrelated
 * event is the point: without it, grouping by entity or by timestamp would still pass.
 */
const TXN = 4471
const EVENTS = [
  {
    event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
    timestamp: '2026-08-21T09:00:00Z', causation_id: TXN,
    description: 'Action UPDATE on devices [dev-1]',
    changed_by: 'user-1', actor_source: 'user',
    old_data: { name: 'Simulated_CNC_01', schema_id: 'schema-old' },
    new_data: { name: 'Simulated_CNC_01', schema_id: 'schema-new' }
  },
  {
    event_id: 2, entity_type: 'devices', entity_id: 'dev-2', event_type: 'UPDATE',
    timestamp: '2026-08-21T09:00:00Z', causation_id: TXN,
    description: 'Action UPDATE on devices [dev-2]',
    changed_by: 'user-1', actor_source: 'user',
    old_data: { name: 'Press_02', schema_id: 'schema-old' },
    new_data: { name: 'Press_02', schema_id: 'schema-new' }
  },
  {
    event_id: 3, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
    timestamp: '2026-08-21T09:00:01Z', causation_id: 4472,
    description: 'Action UPDATE on devices [dev-1]',
    changed_by: null, actor_source: 'ingestion',
    old_data: { name: 'Simulated_CNC_01', status: 'OFFLINE' },
    new_data: { name: 'Simulated_CNC_01', status: 'ONLINE' }
  }
]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
    if (path.startsWith('/api/v1/cells'))    return Promise.resolve(CELLS)
    return Promise.resolve([])
  })
})

const show = async () => {
  render(<DigitalThreadTab />)
  await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
}

const selectEvent = async (pattern) => {
  fireEvent.click(screen.getAllByRole('button', { name: pattern })[0])
  await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
}

const group = () => document.querySelector('.dt-causation')


// The derivation
describe('causationSiblings', () => {
  it('returns the other rows written by the same transaction', () => {
    const siblings = causationSiblings(EVENTS[0], EVENTS)
    expect(siblings.map(s => s.event_id)).toEqual([2])
  })

  it('excludes the event itself', () => {
    expect(causationSiblings(EVENTS[0], EVENTS).map(s => s.event_id)).not.toContain(1)
  })

  it('excludes a different transaction on the SAME entity', () => {
    // Event 3 touches dev-1 one second later under its own transaction. Grouping by entity, or by
    // a coarse timestamp, would sweep it in.
    expect(causationSiblings(EVENTS[0], EVENTS).map(s => s.event_id)).not.toContain(3)
  })

  it('treats a NULL causation as no group at all', () => {
    /* The fabrication guard: rows written before causation existed carry NULL, and if NULL matched
       NULL a year of unrelated history would render as one act. */
    const legacy = [
      { event_id: 10, entity_id: 'dev-1', causation_id: null },
      { event_id: 11, entity_id: 'dev-2', causation_id: null },
      { event_id: 12, entity_id: 'dev-2', causation_id: undefined }
    ]
    expect(causationSiblings(legacy[0], legacy)).toEqual([])
    expect(causationSiblings(legacy[2], legacy)).toEqual([])
  })

  it('orders by write order within the transaction, not by timestamp', () => {
    /* `recorded_at` is NOW(), the transaction start time, so every row in a group carries an
       identical timestamp. `event_id` ascending is the order the act performed them in. */
    const scrambled = [
      { event_id: 9, entity_id: 'c', causation_id: TXN },
      { event_id: 4, entity_id: 'a', causation_id: TXN },
      { event_id: 7, entity_id: 'b', causation_id: TXN }
    ]
    const siblings = causationSiblings(scrambled[0], scrambled)
    expect(siblings.map(s => s.event_id)).toEqual([4, 7])
  })

  it('survives an event with no causation field at all', () => {
    expect(causationSiblings({}, EVENTS)).toEqual([])
    expect(causationSiblings(null, EVENTS)).toEqual([])
  })
})


// The drawer
describe('the Same transaction control', () => {
  it('names the other entity the same act changed', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    await waitFor(() => expect(group()).toBeTruthy())
    expect(within(group()).getByText('Press_02')).toBeInTheDocument()
  })

  it('states that it is limited to what is loaded and filtered', async () => {
    /* The caveat is on screen rather than in a tooltip: the list is a lower bound, and a reader who
       takes it for a count would conclude a transaction did less than it did. */
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    await waitFor(() => expect(group()).toBeTruthy())
    expect(within(group()).getByText(/Limited to the events currently loaded and filtered/))
      .toBeInTheDocument()
  })

  it('steps the drawer across to the sibling, which is a DIFFERENT entity', async () => {
    /* The axis Previous/Next cannot reach: those step through one asset over time, while a
       transaction crosses assets. */
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)
    await waitFor(() => expect(group()).toBeTruthy())

    fireEvent.click(within(group()).getByRole('button', { name: /Open this change to Press_02/ }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Copy entity id dev-2/ })).toBeInTheDocument())
  })

  it('is absent on an event whose transaction wrote nothing else', async () => {
    /* Not "0 related changes": because the set is filtered, the page cannot tell a single-row act
       from one whose siblings are outside the filter, so it asserts neither. */
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    // Event 3 is the ingestion status flip -- its own transaction, no siblings.
    const nav = document.querySelector('.dt-drawer-nav-btns')
    fireEvent.click(within(nav).getByRole('button', { name: /Next/ }))

    await waitFor(() => expect(document.querySelector('.dt-causation')).toBeNull())
  })

  it('shows the transaction id in the drawer metadata', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: new RegExp(`Copy transaction ${TXN}`, 'i') }))
        .toBeInTheDocument())
  })

  it('offers the siblings as real buttons, so the list is keyboard reachable', async () => {
    // A click-handled <div> gets neither Enter/Space nor a focus ring, and would need three
    // attributes to imitate each badly.
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    await waitFor(() => expect(group()).toBeTruthy())
    const items = [...group().querySelectorAll('.dt-causation-item')]
    expect(items.length).toBe(1)
    items.forEach(el => expect(el.tagName).toBe('BUTTON'))
  })
})
