/**
 * The three ids the event drawer hands a reader, and whether any of them can be spent.
 *
 * Entity ID had one consumer in the whole platform (the global search's five-table probe) and the
 * other two had none: no filter, no search, no RPC argument. A copyable identifier that nothing
 * accepts is a dead end dressed as an affordance, so this suite pins the route each one now has --
 * and the words that say so, because an id whose purpose a reader has to guess is the same dead end
 * with a tooltip.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DigitalThreadTab } from '../components/tabs/DigitalThreadTab'
import { api } from '../api'
import { downloadCSV } from '../utils/downloadCSV'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})
vi.mock('../utils/downloadCSV', () => ({ downloadCSV: vi.fn() }))

const DEVICES = [{ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', last_birth_metrics: [] }]
const TXN = 908311

const EVENTS = [{
  event_id: 42, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE',
  timestamp: '2026-09-01T09:00:00Z', causation_id: TXN, transaction_rows: 3,
  description: 'Action UPDATE on devices [dev-1]',
  old_data: { name: 'Simulated_CNC_01', status: 'OFFLINE' },
  new_data: { name: 'Simulated_CNC_01', status: 'ONLINE' }
}]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/digital-thread')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
})

const show = async () => {
  render(<DigitalThreadTab />)
  await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
}

const openDrawer = async () => {
  fireEvent.click(screen.getAllByRole('button', { name: /UPDATE on Simulated_CNC_01/ })[0])
  await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
}

const searchBox = () =>
  screen.getByPlaceholderText(/Search by name, entity, mutation or transaction ID/)


describe('each id in the drawer says what it is for', () => {

  it('explains all three, on the label rather than on the value', async () => {
    /* `title` sits on the <dd>, so hovering the label -- which is what a reader points at to ask
       "what is this field" -- said nothing at all. */
    await show()
    await openDrawer()

    for (const label of ['Entity ID', 'Mutation ID', 'Transaction ID']) {
      expect(screen.getByRole('button', { name: `What ${label} means` })).toBeInTheDocument()
    }
  })

  it('tells a reader where each one can be pasted', async () => {
    // The question the ids provoked was "how am I expected to use this", so each answer ends by
    // naming somewhere it is accepted.
    await show()
    await openDrawer()

    fireEvent.focus(screen.getByRole('button', { name: 'What Mutation ID means' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/search box above accepts it/i)
  })

  it('names the SQL column, so an id carried into a query lands on the right one', async () => {
    /* Neither UI name is the column name: Mutation ID is `digital_thread.id` and Transaction ID is
       `causation_id`. Without the mapping the tooltip renames a column rather than explaining it. */
    await show()
    await openDrawer()

    fireEvent.focus(screen.getByRole('button', { name: 'What Transaction ID means' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/digital_thread\.causation_id/)
  })
})


describe('one name per id, across the drawer and the export', () => {

  it('calls it Transaction ID in the drawer, not Transaction', async () => {
    // Reported as four ids in a drawer that shows three: the label said Transaction and the CSV
    // column said causation_id, so one thing read as two.
    await show()
    await openDrawer()

    expect(screen.getByRole('button', { name: new RegExp(`Copy transaction id ${TXN}`, 'i') }))
      .toBeInTheDocument()
  })

  it('exports the same two words the drawer uses', async () => {
    await show()
    fireEvent.click(screen.getByTitle(/Download the events matching the current filters as CSV/))

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const [rows] = downloadCSV.mock.calls[0]
    expect(Object.keys(rows[0])).toContain('mutation_id')
    expect(Object.keys(rows[0])).toContain('transaction_id')
    // The database's word is in the tooltip, not in a second column heading.
    expect(Object.keys(rows[0])).not.toContain('causation_id')
    expect(rows[0].mutation_id).toBe(42)
    expect(rows[0].transaction_id).toBe(TXN)
  })

  it('exports how many rows the transaction wrote, beside its id', async () => {
    // The count the drawer acts on (0006), so a reader of the export can tell a single-row act
    // from a group the filters cut without re-deriving it from the transaction id column.
    await show()
    fireEvent.click(screen.getByTitle(/Download the events matching the current filters as CSV/))

    await waitFor(() => expect(downloadCSV).toHaveBeenCalled())
    const [rows] = downloadCSV.mock.calls[0]
    const keys = Object.keys(rows[0])
    expect(keys.indexOf('transaction_rows')).toBe(keys.indexOf('transaction_id') + 1)
    expect(rows[0].transaction_rows).toBe(3)
  })
})


describe('the search box takes a numeric id', () => {

  it('sends a bare integer to the database as the search term', async () => {
    /* The page does not decide which id it is -- `digital_thread_page()` matches the row id and the
       causation id in one predicate, so the box stays one box. */
    await show()
    fireEvent.change(searchBox(), { target: { value: String(TXN) } })

    await waitFor(() =>
      expect(api.get.mock.calls.some(([url]) => url.includes(`search=${TXN}`))).toBe(true))
  })

  it('says so on the control, because a box that takes three things must name them', async () => {
    await show()
    expect(searchBox().title).toMatch(/only digits also matches a mutation id and a transaction id/i)
  })
})
