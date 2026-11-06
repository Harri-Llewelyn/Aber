/**
 * Audit Trail: the event drawer. The step buttons and the position line sit in ContextPanel's nav
 * slot, at the drawer's full width under its header; User ID and Machine identity link to Access
 * Control for a viewer who may open it, with the id still copying beside the name; and one action
 * opens the entity on its own page ("View in Devices"), which a deleted entity does not get.
 */
import React from 'react'
import { render, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { entityUrl, identityUrl, personUrl } from '../routes'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      listUserAccounts: vi.fn(), listMachinePrincipalNames: vi.fn(),
      get: vi.fn(), post: vi.fn(), put: vi.fn(),
    },
  }
})

const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001'
const ROBOT = 'b2b2b2b2-0000-4000-8000-000000000002'
const DEVICES = [{ asset_id: 'dev-1', asset_name: 'Press_01', last_birth_metrics: [] }]

const at = (hhmm) => `2026-08-21T${hhmm}:00Z`
const row = (event_id, entity_type, entity_id, time, extra = {}) => ({
  event_id, entity_type, entity_id, event_type: 'UPDATE', timestamp: at(time),
  description: `Action UPDATE on ${entity_type} [${entity_id}]`, changed_by: ALICE, actor_source: 'user',
  old_data: { status: 'OFFLINE' }, new_data: { status: 'ONLINE' }, ...extra,
})
const EVENTS = [
  row(1, 'devices', 'dev-1', '09:00'),
  row(2, 'devices', 'dev-1', '10:00', { changed_by: ROBOT, actor_source: 'service' }),
  row(3, 'system_settings', 'set-1', '11:00', {
    old_data: { key: 'ui.x', label: 'Poll interval' }, new_data: { key: 'ui.x', label: 'Poll interval' },
  }),
  row(4, 'devices', 'dev-gone', '08:00', { event_type: 'DELETE', old_data: { name: 'Old_Press' }, new_data: null }),
]

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState({}, '', '/audit-trail')
  api.listUserAccounts.mockResolvedValue([{ user_id: ALICE, email: 'alice@aber.local', display_name: 'Alice' }])
  api.listMachinePrincipalNames.mockResolvedValue(new Map([[ROBOT, { principal_id: ROBOT, name: 'Line robot' }]]))
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/audit-trail')) return Promise.resolve(EVENTS)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve(DEVICES)
    return Promise.resolve([])
  })
})

/** The trail as `role` sees it, opened on event `id`, once the lookups have named everyone. */
const openAs = async (role, id, search = '') => {
  window.history.replaceState({}, '', `/audit-trail?event=${id}${search}`)
  render(<AuditTrailTab userRole={role} showToast={vi.fn()} />)
  await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
  await waitFor(() => expect(api.listMachinePrincipalNames).toHaveBeenCalled())
}
const field = (label) => within(document.querySelector('.context-panel-fields'))
  .getByText(label, { selector: 'dt' }).closest('.context-field')
const drawer = () => within(document.querySelector('.context-panel-open'))

describe('the step buttons', () => {
  it('sit in the drawer\'s nav slot at its full width, in two rows, with the position line', async () => {
    await openAs('Administrator', 1)
    const nav = document.querySelector('.context-panel-nav')
    expect(nav.previousElementSibling).toHaveClass('context-panel-header')
    expect(nav.querySelector('.trail-drawer-nav-pos')).toHaveTextContent('Event 1 of 2')
    const names = [...nav.querySelectorAll('.trail-drawer-nav-btns button')].map(b => b.textContent.replace(/[◀▶▲▼]/g, ''))
    // A two-column grid: Previous and Next, then Previous Entity and Next Entity.
    expect(names).toEqual(['Previous', 'Next', 'Previous Entity', 'Next Entity'])
    // Not in the header beside the close button any more.
    expect(document.querySelector('.context-panel-header .trail-drawer-nav')).toBeNull()
    // The event's badges stay under its title.
    expect(document.querySelector('.context-panel-subtitle .trail-drawer-nav-badges')).toHaveTextContent('UPDATE')
  })

  it('still step from there', async () => {
    await openAs('Administrator', 1)
    fireEvent.click(within(document.querySelector('.context-panel-nav')).getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('event')).toBe('2'))
  })
})

describe('User ID', () => {
  it('links a person to their row on Access Control › People for an Administrator', async () => {
    await openAs('Administrator', 1)
    const value = within(field('User ID'))
    await waitFor(() => expect(value.getByRole('link', { name: 'Alice (alice@aber.local)' })).toBeInTheDocument())
    expect(value.getByRole('link')).toHaveAttribute('href', personUrl(ALICE))
    // The id still copies, from a button of its own beside the link.
    expect(value.getByRole('button', { name: `Copy user id ${ALICE}` })).toBeInTheDocument()
  })

  it('is text for an Auditor, who cannot open Access Control, and the id still copies', async () => {
    await openAs('Auditor', 1)
    const value = within(field('User ID'))
    await waitFor(() => expect(value.getByText('Alice (alice@aber.local)')).toBeInTheDocument())
    expect(value.queryByRole('link')).toBeNull()
    expect(value.getByRole('button', { name: `Copy user id ${ALICE}` })).toBeInTheDocument()
  })

  it('copies a principal nothing here names, with nothing to link', async () => {
    api.listUserAccounts.mockResolvedValue([])
    await openAs('Administrator', 1)
    const value = within(field('User ID'))
    expect(value.queryByRole('link')).toBeNull()
    expect(value.getByRole('button', { name: `Copy user id ${ALICE}` })).toBeInTheDocument()
  })
})

describe('Machine identity', () => {
  it('links to Access Control › Machine identities for an Administrator', async () => {
    await openAs('Administrator', 2)
    const value = within(field('Machine identity'))
    await waitFor(() => expect(value.getByRole('link', { name: 'Line robot' })).toBeInTheDocument())
    expect(value.getByRole('link')).toHaveAttribute('href', identityUrl(ROBOT))
    expect(value.getByRole('button', { name: `Copy machine identity ${ROBOT}` })).toBeInTheDocument()
  })

  it('is text for an Auditor', async () => {
    await openAs('Auditor', 2)
    const value = within(field('Machine identity'))
    await waitFor(() => expect(value.getByText('Line robot')).toBeInTheDocument())
    expect(value.queryByRole('link')).toBeNull()
  })
})

describe('the drawer\'s action', () => {
  it('opens the entity on its own page, named for the page', async () => {
    await openAs('Auditor', 1)
    const link = await drawer().findByRole('link', { name: /View in Devices/ })
    expect(link).toHaveAttribute('href', entityUrl('device', 'dev-1'))
    expect(document.querySelectorAll('.context-action')).toHaveLength(1)
  })

  it('is not offered for a kind with no page of its own', async () => {
    await openAs('Administrator', 3)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/v1/devices'))
    expect(document.querySelector('.context-panel-actions')).toBeNull()
  })

  it('is not offered for a deleted entity, which has no page', async () => {
    await openAs('Administrator', 4, '&deleted=1')
    await waitFor(() => expect(drawer().getByText('Final properties')).toBeInTheDocument())
    expect(drawer().queryByRole('link', { name: /View in/ })).toBeNull()
  })
})
