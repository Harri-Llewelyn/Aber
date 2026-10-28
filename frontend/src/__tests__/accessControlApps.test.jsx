/**
 * Access Control > Apps: every app that signs people in with Aber, for an Administrator. A row is
 * the app, how and when it was registered, where it sends people back to, its type and how many
 * people allow it. Its drawer lists the people who allowed it, each with Revoke, and offers Remove
 * App, which Aber's own four refuse. Each act asks first, says what ended in a toast that links to
 * the app, and reads the lists again.
 */
import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'
import { appUrl } from '../routes'
import { removeQuestion, revokeQuestion } from '../utils/apps'
import { tabLink, tabLinks } from '../test/tabBar'

vi.mock('../api', () => ({
  api: {
    listApps: vi.fn(),
    appApprovals: vi.fn(),
    revokeAppApproval: vi.fn(),
    removeApp: vi.fn(),
    // The rest of the page's reads, answered empty: this suite is about the Apps tab.
    listPeople: vi.fn(),
    personSessionSummary: vi.fn(),
    listGatewayCredentials: vi.fn(),
    listBrokerInventory: vi.fn(),
    listServicePrincipals: vi.fn(),
    listServiceTokens: vi.fn(),
    listRevokedServiceTokens: vi.fn(),
    listRevokedServicePrincipals: vi.fn(),
  }
}))

// jsdom has no clipboard; copying is not what this suite is about.
vi.mock('../components/common/CopyableId', () => ({
  __esModule: true,
  default: () => null,
  copyText: vi.fn().mockResolvedValue(true),
}))

const ME = 'a0000000-0000-4000-8000-000000000001'
const OPERATOR = 'a0000000-0000-4000-8000-000000000003'
const OTHER = 'a0000000-0000-4000-8000-000000000004'
const GRAFANA = 'c0ffee00-0000-4000-8000-000000000001'
const NODE_RED = 'c0ffee00-0000-4000-8000-000000000002'
const REPORTS = 'a0d17070-0000-4000-8000-0000000217e1'

const app = (id, client_name, extra = {}) => ({
  id, client_name, registration_type: 'manual', part_of_stack: false, client_type: 'confidential',
  redirect_uris: [`https://${id.slice(0, 4)}.test/cb`], client_uri: null,
  created_at: '2026-09-01T09:00:00Z', people_allowing: 0, ...extra,
})

const APPS = [
  app(GRAFANA, 'Aber Grafana', { part_of_stack: true, people_allowing: 2, redirect_uris: ['http://grafana.test/login/generic_oauth'] }),
  app(NODE_RED, 'Aber Node-RED', { part_of_stack: true, people_allowing: 1 }),
  app(REPORTS, 'Shift Reports', { people_allowing: 2, created_at: '2026-10-20T08:00:00Z', redirect_uris: ['https://reports.test/cb', 'https://reports.test/cb2'] }),
]

const APPROVALS = [
  { user_id: OTHER, email: 'other@site.test', display_name: null, scopes: ['openid'], granted_at: '2026-10-27T09:00:00Z' },
  { user_id: OPERATOR, email: 'operator@site.test', display_name: 'Owain Operator', scopes: ['openid', 'email', 'profile'], granted_at: '2026-10-25T09:00:00Z' },
]

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/access-control/apps')
  api.listApps.mockResolvedValue(APPS)
  api.appApprovals.mockResolvedValue(APPROVALS)
  api.revokeAppApproval.mockResolvedValue(2)
  api.removeApp.mockResolvedValue({ name: 'Shift Reports', approvals_ended: 2, sessions_ended: 3 })
  api.listPeople.mockResolvedValue([])
  api.listGatewayCredentials.mockResolvedValue([])
  api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [] })
  api.listServicePrincipals.mockResolvedValue([])
  api.listServiceTokens.mockResolvedValue(new Map())
  api.listRevokedServiceTokens.mockResolvedValue(new Set())
  api.listRevokedServicePrincipals.mockResolvedValue(new Map())
})

function renderApps(showToast = vi.fn()) {
  render(<AccessControlTab showToast={showToast} userRole="Administrator" currentUserId={ME} />)
  return showToast
}

/** The Apps table, not a table in the drawer. */
const appsTable = async () => (await screen.findAllByRole('table')).find(t => !t.closest('.context-panel'))

async function row(name) {
  return (await within(await appsTable()).findByText(name)).closest('tr')
}

/** Opens an app's drawer by clicking its row, and returns queries bound to it. */
async function openDrawer(name) {
  fireEvent.click(await row(name))
  return within(await screen.findByRole('complementary', { name: / app$/ }))
}

describe('the Apps tab', () => {
  it('comes after People for an Administrator, and opens from its address', async () => {
    renderApps()
    expect(tabLinks().map(t => t.textContent)).toEqual(expect.arrayContaining(['People', 'Apps']))
    expect(tabLinks()[1]).toHaveTextContent('Apps')
    expect(tabLink('Apps')).toHaveAttribute('aria-current', 'page')
    await row('Grafana')
    expect(api.listPeople).not.toHaveBeenCalled()
  })

  it('is not offered to any other role, and the apps are not read', async () => {
    for (const role of ['Shopfloor_Manager', 'Operator', 'Auditor']) {
      const { unmount } = render(<AccessControlTab showToast={vi.fn()} userRole={role} currentUserId={ME} />)
      expect(tabLinks().map(t => t.textContent)).not.toContain('Apps')
      unmount()
    }
    expect(api.listApps).not.toHaveBeenCalled()
  })

  it('has a header row and an About tip', async () => {
    renderApps()
    const table = await appsTable()
    expect(within(table).getAllByRole('columnheader').map(h => h.textContent.trim()))
      .toEqual(['App', 'Registered', 'Sends people back to', 'Type', 'People'])
    expect(screen.getByRole('button', { name: 'About apps' })).toBeInTheDocument()
  })

  it('lists every app, Aber\'s own marked, with its addresses, type and how many allow it', async () => {
    renderApps()
    const grafana = await row('Grafana')
    expect(within(grafana).getByText('Aber Grafana')).toBeInTheDocument()
    expect(within(grafana).getByText('Part of Aber')).toBeInTheDocument()
    expect(within(grafana).getByText('http://grafana.test/login/generic_oauth')).toBeInTheDocument()
    expect(within(grafana).getByText('Confidential')).toBeInTheDocument()
    expect(within(grafana).getByText('2')).toBeInTheDocument()
    const reports = await row('Shift Reports')
    expect(within(reports).getByText('Added by hand')).toBeInTheDocument()
    expect(within(reports).getByText('https://reports.test/cb2')).toBeInTheDocument()
  })

  it('finds an app by name or by an address it sends people back to', async () => {
    renderApps()
    await row('Grafana')
    fireEvent.change(screen.getByRole('searchbox', { name: /Search apps/ }), { target: { value: 'reports.test' } })
    const table = await appsTable()
    await waitFor(() => expect(within(table).queryByText('Grafana')).toBeNull())
    expect(within(table).getByText('Shift Reports')).toBeInTheDocument()
  })

  it('says why the list could not be read', async () => {
    api.listApps.mockRejectedValue(new Error('insufficient privileges to list the apps that sign people in'))
    renderApps()
    expect(await screen.findByText(/insufficient privileges to list the apps/)).toBeInTheDocument()
  })
})

describe("an app's drawer", () => {
  it('opens on a row and lists who allows it, with their names and what they allowed', async () => {
    renderApps()
    const drawer = await openDrawer('Grafana')
    expect(window.location.search).toContain(`app=${GRAFANA}`)
    expect(api.appApprovals).toHaveBeenCalledWith(GRAFANA)
    expect(await drawer.findByText('Owain Operator')).toBeInTheDocument()
    expect(drawer.getByText('other@site.test')).toBeInTheDocument()
    expect(drawer.getByText('openid email profile')).toBeInTheDocument()
    expect(drawer.getByText('PART OF ABER')).toBeInTheDocument()
  })

  it("refuses to remove Aber's own, and says why", async () => {
    renderApps()
    const drawer = await openDrawer('Grafana')
    expect(drawer.getByRole('button', { name: /Remove App/ })).toBeDisabled()
  })

  it("revokes one person's approval after asking, then reads the lists again", async () => {
    const showToast = renderApps()
    const drawer = await openDrawer('Grafana')
    fireEvent.click(await drawer.findByRole('button', { name: 'Revoke: Owain Operator' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(revokeQuestion('Aber Grafana', 'Owain Operator'))).toBeInTheDocument()
    expect(api.revokeAppApproval).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke Approval' }))
    await waitFor(() => expect(api.revokeAppApproval).toHaveBeenCalledWith(OPERATOR, GRAFANA))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Owain Operator no longer allows Grafana: 2 sessions ended.', 'success', { to: appUrl(GRAFANA) },
    ))
    await waitFor(() => expect(api.appApprovals).toHaveBeenCalledTimes(2))
    expect(api.listApps).toHaveBeenCalledTimes(2)
  })

  it('removes an app that is not Aber\'s own after asking, and closes its drawer', async () => {
    const showToast = renderApps()
    const drawer = await openDrawer('Shift Reports')
    fireEvent.click(drawer.getByRole('button', { name: /Remove App/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(removeQuestion(APPS[2]))).toBeInTheDocument()
    expect(removeQuestion(APPS[2])).toMatch(/The approvals of 2 people end, and so does every session it holds\./)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove App' }))
    await waitFor(() => expect(api.removeApp).toHaveBeenCalledWith(REPORTS))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Shift Reports is removed: 2 approvals and 3 sessions ended.', 'success', { to: '/access-control/apps' },
    ))
    await waitFor(() => expect(window.location.search).not.toContain('app='))
  })

  it('shows a refusal in a toast', async () => {
    api.removeApp.mockRejectedValue(new Error('this app is part of Aber'))
    const showToast = renderApps()
    const drawer = await openDrawer('Shift Reports')
    fireEvent.click(drawer.getByRole('button', { name: /Remove App/ }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove App' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('this app is part of Aber', 'error'))
  })
})
