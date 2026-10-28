/**
 * Profile > Security: Apps you have allowed. It lists each app the person let sign them in, in the
 * Sessions table's shape: the app by the name the Sessions list uses, when it was allowed and what
 * it may read. Revoke asks first, then takes the approval back through the sign-in service's own
 * endpoint, says that the app's sessions ended and that it will ask again, and reads the list again.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProfileTab } from '../components/tabs/ProfileTab'
import { revokeQuestion } from '../utils/apps'

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'https://api.site.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: { auth: { getSession: vi.fn(() => new Promise(() => {})) } },
}))

vi.mock('../api', () => ({
  api: {
    listMySessions: vi.fn(), endMySession: vi.fn(), signOutOtherSessions: vi.fn(),
    listMyAppApprovals: vi.fn(), revokeMyAppApproval: vi.fn(),
  },
}))

import { api } from '../api'

const NOW = new Date('2026-10-28T12:00:00Z')
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()
const DAY = 24 * 3600 * 1000

const GRAFANA = 'c0ffee00-0000-4000-8000-000000000001'
const REPORTS = 'a0d17070-0000-4000-8000-0000000217e1'
const APPROVALS = [
  { client_id: REPORTS, client_name: 'Shift Reports', client_uri: 'https://reports.test', part_of_stack: false, scopes: ['openid'], granted_at: ago(DAY) },
  { client_id: GRAFANA, client_name: 'Aber Grafana', client_uri: 'http://grafana.test', part_of_stack: true, scopes: ['openid', 'email', 'profile'], granted_at: ago(3 * DAY) },
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.history.replaceState({}, '', '/profile/security')
  api.listMySessions.mockReset().mockResolvedValue([])
  api.listMyAppApprovals.mockReset().mockResolvedValue(APPROVALS)
  api.revokeMyAppApproval.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  window.history.replaceState({}, '', '/')
})

const renderSecurity = (props = {}) => {
  const showToast = vi.fn()
  render(<ProfileTab email="operator@site.test" userRole="Operator" theme="dark" sidebarMode="hover" showToast={showToast} {...props} />)
  return { showToast }
}

const loaded = () => screen.findByText('Shift Reports')
const rows = () => screen.getAllByRole('row').slice(1)
const rowOf = (name) => rows().find(r => r.querySelector('.session-where')?.textContent === name)

describe('Apps you have allowed', () => {
  it('comes after Sessions, with its own heading, About tip and line', async () => {
    renderSecurity()
    const headings = screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent)
    expect(headings).toEqual(['Sessions', 'Second factor', 'Apps you have allowed'])
    expect(screen.getByRole('button', { name: 'About apps you have allowed' })).toBeInTheDocument()
    expect(document.querySelectorAll('.profile-section-note')[2]).toHaveTextContent(/what it can read about you/)
    await loaded()
  })

  it('has the Sessions table\'s header row', async () => {
    renderSecurity()
    await loaded()
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['App', 'Allowed', 'Can read', 'Actions'])
  })

  it('lists each app as the Sessions list names it, Aber\'s own marked, with what it may read', async () => {
    renderSecurity()
    await loaded()
    expect(rows().map(r => r.querySelector('.session-where').textContent)).toEqual(['Shift Reports', 'Grafana'])
    const grafana = rowOf('Grafana')
    expect(within(grafana).getByText('Aber')).toBeInTheDocument()
    expect(within(grafana).getByText('openid email profile')).toBeInTheDocument()
    expect(within(grafana).getByText('3d ago')).toBeInTheDocument()
    expect(within(rowOf('Shift Reports')).queryByText('Aber')).toBeNull()
  })

  it('says so when no app is allowed', async () => {
    api.listMyAppApprovals.mockResolvedValue([])
    renderSecurity()
    expect(await screen.findByText('You have not allowed any app.')).toBeInTheDocument()
  })

  it('shows why the list could not be read', async () => {
    api.listMyAppApprovals.mockRejectedValue(new Error('insufficient privileges to list your apps: sign in as a person with a role'))
    renderSecurity()
    expect(await screen.findByText(/sign in as a person with a role/)).toBeInTheDocument()
  })

  it('asks nothing for a machine identity, which allows no apps', async () => {
    renderSecurity({ email: null })
    expect(await screen.findByText('A machine identity allows no apps. It holds a token of its own.')).toBeInTheDocument()
    expect(api.listMyAppApprovals).not.toHaveBeenCalled()
  })
})

describe('Revoke', () => {
  it('asks first, naming the app and what ends, and the confirming button says Revoke Approval', async () => {
    renderSecurity()
    await loaded()
    fireEvent.click(within(rowOf('Grafana')).getByRole('button', { name: 'Revoke: Grafana' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Revoke Grafana')).toBeInTheDocument()
    expect(within(dialog).getByText(revokeQuestion('Aber Grafana'))).toBeInTheDocument()
    expect(revokeQuestion('Aber Grafana')).toMatch(/^Grafana can no longer sign in as you\. Your sessions in Grafana end now/)
    expect(within(dialog).getByRole('button', { name: 'Revoke Approval' })).toBeInTheDocument()
    expect(api.revokeMyAppApproval).not.toHaveBeenCalled()
  })

  it('revokes through the sign-in service, says what ended, links here and reads the list again', async () => {
    const { showToast } = renderSecurity()
    await loaded()
    api.listMyAppApprovals.mockResolvedValue([APPROVALS[0]])
    fireEvent.click(within(rowOf('Grafana')).getByRole('button', { name: 'Revoke: Grafana' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke Approval' }))
    await waitFor(() => expect(api.revokeMyAppApproval).toHaveBeenCalledWith(GRAFANA))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Grafana is revoked. Its sessions for you have ended, and it asks you to allow it again next time.',
      'success', { to: '/profile/security' },
    ))
    await waitFor(() => expect(rowOf('Grafana')).toBeUndefined())
    expect(api.listMyAppApprovals).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the refusal and keeps the list', async () => {
    const { showToast } = renderSecurity()
    await loaded()
    api.revokeMyAppApproval.mockRejectedValue(new Error('No active grant found for this client'))
    fireEvent.click(within(rowOf('Shift Reports')).getByRole('button', { name: 'Revoke: Shift Reports' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke Approval' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('No active grant found for this client', 'error'))
    expect(rowOf('Shift Reports')).toBeTruthy()
  })

  it('does nothing when the dialog is cancelled', async () => {
    renderSecurity()
    await loaded()
    fireEvent.click(within(rowOf('Grafana')).getByRole('button', { name: 'Revoke: Grafana' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.revokeMyAppApproval).not.toHaveBeenCalled()
  })
})
