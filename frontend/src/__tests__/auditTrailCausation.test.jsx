/**
 * Audit Trail: reading one operator action back as one act. `causation_id` is `txid_current()`,
 * so every row a transaction writes shares it. This suite pins two claims about what the page must
 * not say: a NULL causation is not a group (legacy rows carry NULL, and matching NULL to NULL would
 * fabricate a causal link), and the sibling list is drawn from the fetched, filtered set, so on its
 * own it is a lower bound.
 *
 * `transaction_rows` (0006) is what turns the bound into an answer: the server counts the
 * transaction over the whole table, so the drawer can say a single-row act wrote nothing else, that
 * every row is loaded, or how many are missing and offer "Show whole transaction" for exactly
 * those. Without the count the section hedges, as it did before 0006.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab, causationSiblings } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CELLS = [{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }]
const GATEWAYS = [{ gateway_id: 'gw-1', gateway_name: 'Host_Gateway_NodeRED', devices: [] }]
const DEVICES = [
  { asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] },
  { asset_id: 'dev-2', asset_name: 'Press_02', last_birth_metrics: [] }
]

/**
 * A schema rebinding across three devices, plus one unrelated edit a second later. The unrelated
 * event is the point: without it, grouping by entity or by timestamp would still pass. The third
 * device has since been deleted -- it is in no lookup -- so its row is hidden until deleted
 * entities are shown. That is the shape a filter or a page boundary leaves: two of the act's three
 * rows on the page, and the count saying three.
 */
const TXN = 4471
const rebind = (event_id, entity_id, name) => ({
  event_id, entity_type: 'devices', entity_id, event_type: 'UPDATE',
  timestamp: '2026-08-21T09:00:00Z', causation_id: TXN, transaction_rows: 3,
  description: `Action UPDATE on devices [${entity_id}]`,
  changed_by: 'user-1', actor_source: 'user',
  old_data: { name, schema_id: 'schema-old' },
  new_data: { name, schema_id: 'schema-new' }
})
const EVENTS = [
  rebind(1, 'dev-1', 'Simulated_CNC_01'),
  rebind(2, 'dev-2', 'Press_02'),
  {
    event_id: 3, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
    timestamp: '2026-08-21T09:00:01Z', causation_id: 4472, transaction_rows: 1,
    description: 'Action UPDATE on devices [dev-1]',
    changed_by: 'ingestion-principal-1', actor_source: 'ingestion',
    old_data: { name: 'Simulated_CNC_01', status: 'OFFLINE' },
    new_data: { name: 'Simulated_CNC_01', status: 'ONLINE' }
  },
  rebind(4, 'dev-3', 'Robot_03')
]
/** The same rows with no count, as a server without 0006 returns them. */
const UNCOUNTED = EVENTS.map(e => { const c = { ...e }; delete c.transaction_rows; return c })

const serve = (events) => (path) => {
  if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(events)
  if (path.startsWith('/api/v1/devices'))  return Promise.resolve(DEVICES)
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(GATEWAYS)
  if (path.startsWith('/api/v1/cells'))    return Promise.resolve(CELLS)
  return Promise.resolve([])
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(serve(EVENTS))
})

const show = async () => {
  render(<AuditTrailTab />)
  await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
}

const selectEvent = async (pattern) => {
  fireEvent.click(screen.getAllByRole('button', { name: pattern })[0])
  await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
}

/** Steps the drawer to the ingestion status flip: its own transaction, one row. */
const stepToSingleRowAct = () => {
  const nav = document.querySelector('.dt-drawer-nav-btns')
  fireEvent.click(within(nav).getByRole('button', { name: /Next/ }))
}

const group = () => document.querySelector('.dt-causation')
const control = () => within(group()).queryByRole('button', { name: /Show whole transaction/ })
const chip = () => group().querySelector('.section-count')


// The derivation
describe('causationSiblings', () => {
  it('returns the other rows written by the same transaction', () => {
    const siblings = causationSiblings(EVENTS[0], EVENTS)
    expect(siblings.map(s => s.event_id)).toEqual([2, 4])
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

  it('says how many of the rows the act wrote are not loaded, and offers the control', async () => {
    /* Two of the act's three rows are on the page. Before 0006 the page could only say "one other
       change, limited to what is loaded"; the count is what lets it say a row is missing. */
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    await waitFor(() => expect(group()).toBeTruthy())
    expect(within(group()).getByText(
      /2 other changes were written by this act\. One of them is not loaded: outside the current filters/
    )).toBeInTheDocument()
    expect(control()).toBeInTheDocument()
    expect(chip()).toHaveTextContent('2')
  })

  it('says a single-row act wrote nothing else, and offers no control', async () => {
    /* The case a user asked to go away: the button put the id in the search box and loaded the
       same single row again. Only the count can tell this act from one whose siblings a filter
       hides, which is why the button could not simply be hidden when the list was empty. */
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)
    stepToSingleRowAct()

    await waitFor(() =>
      expect(within(group()).getByText('Nothing else was written by this act.')).toBeInTheDocument())
    expect(control()).toBeNull()
    expect(chip()).toHaveTextContent('0')
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

  it('shows the transaction id in the drawer metadata', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: new RegExp(`Copy transaction id ${TXN}`, 'i') }))
        .toBeInTheDocument())
  })

  it('searches the transaction id, so the loaded set becomes the act', async () => {
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)
    await waitFor(() => expect(group()).toBeTruthy())

    fireEvent.click(control())

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Search by name, entity, mutation or transaction ID/).value)
        .toBe(String(TXN)))
    await waitFor(() =>
      expect(api.get.mock.calls.some(([url]) => url.includes(`search=${TXN}`))).toBe(true))
  })

  it('clears the entity and action filters, which each hide half of one act', async () => {
    /* A transaction crosses entity kinds and actions by definition -- an approval writes an UPDATE
       on one table and a PROPOSAL_APPLIED row on another. Leaving either filter set would show
       part of the act under a count that reads as the whole of it. */
    await show()
    fireEvent.change(screen.getByTitle(/Show only events against one kind of asset/),
      { target: { value: 'DEVICE' } })
    // The filter is a query parameter, so the page refetches; selecting before that lands picks
    // an event out of the list that is about to be replaced.
    await waitFor(() =>
      expect(api.get.mock.calls.some(([url]) => url.includes('entity_type=DEVICE'))).toBe(true))
    await selectEvent(/UPDATE on Simulated_CNC_01/)
    await waitFor(() => expect(group()).toBeTruthy())

    fireEvent.click(control())

    await waitFor(() =>
      expect(screen.getByTitle(/Show only events against one kind of asset/).value).toBe(''))
  })

  it('shows deleted entities, whose rows the count includes', async () => {
    /* A delete's own row is about an entity no live table holds, so the default view hides it. The
       count includes it, and a control that loaded "everything" and left it hidden would report a
       row missing and offer nothing that reaches it. */
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)
    await waitFor(() => expect(group()).toBeTruthy())
    const toggle = () => screen.getByRole('button', { name: /Show deleted entities \(1\)/ })
    expect(toggle()).not.toHaveClass('btn-primary')

    fireEvent.click(control())

    await waitFor(() => expect(toggle()).toHaveClass('btn-primary'))
  })

  it('says the list is complete once every row the act wrote is loaded', async () => {
    /* The hedge is true while the page holds part of the act and false once it holds all of it.
       Repeating it there would teach a reader to discount a number that is exact. */
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)
    await waitFor(() => expect(group()).toBeTruthy())

    fireEvent.click(control())

    await waitFor(() =>
      expect(within(group()).getByText(/2 other changes written by this act, and this is all of them/))
        .toBeInTheDocument())
    expect(control()).toBeNull()
    expect(within(group()).getByText('Robot_03')).toBeInTheDocument()
    expect(group().querySelectorAll('.dt-causation-item')).toHaveLength(2)
    expect(chip()).toHaveTextContent('2')
  })

  it('points at the next page when the search is the transaction and rows are still missing', async () => {
    /* A transaction longer than a page. The search is already this transaction, so the control
       would do what has been done; what is missing is further down the trail. */
    api.get.mockImplementation(serve(EVENTS.filter(e => e.event_id !== 4)))
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)
    await waitFor(() => expect(group()).toBeTruthy())

    fireEvent.click(control())

    await waitFor(() =>
      expect(within(group()).getByText(/One of them is not loaded: on a page not yet fetched\./))
        .toBeInTheDocument())
    expect(control()).toBeNull()
  })

  it('hedges when the server did not say how many rows the act wrote', async () => {
    /* A database without 0006. The list is a lower bound again, and the section says so rather
       than reporting a count it does not have; the control is offered because nothing else can
       tell a single-row act from a filtered group. */
    api.get.mockImplementation(serve(UNCOUNTED))
    await show()
    await selectEvent(/UPDATE on Simulated_CNC_01/)

    await waitFor(() => expect(group()).toBeTruthy())
    expect(within(group()).getByText(/Limited to the events currently loaded and filtered/))
      .toBeInTheDocument()
    expect(control()).toBeInTheDocument()
    expect(chip()).toHaveTextContent('1')

    stepToSingleRowAct()
    await waitFor(() =>
      expect(within(group()).getByText(/not the same as there being nothing else/)).toBeInTheDocument())
    expect(control()).toBeInTheDocument()
    // And no chip: zero LOADED siblings is an unknown, not a total, and a "0" beside a hint that
    // says so would assert the thing the hint is refusing to.
    expect(chip()).toBeNull()
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
