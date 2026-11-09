/**
 * Register App, on Access Control's Apps tab: the dialog that adds an app which signs people in with
 * Aber and reaches nothing else (`register_app()`, 0260).
 *
 * The addresses it takes are held to test-harness/fixtures/app-redirect-addresses.json, the file the
 * database's own rule answers too. The dialog says what is wrong before it asks, with its confirm
 * greyed, from the first edit. A confidential app's secret is shown once, in the dialog, and nowhere
 * else; a public app has none. A refusal shows in the dialog, which stays open with what was typed.
 */
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'
import { appUrl } from '../routes'
import {
  APP_NAME_MAX, APP_REDIRECT_MAX, appNameProblem, appRegistration, redirectAddressProblem, redirectAddressesProblem,
  siteDomainOf,
} from '../utils/apps'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal()),
  api: {
    listApps: vi.fn(),
    appApprovals: vi.fn(),
    registerApp: vi.fn(),
    listPeople: vi.fn(),
    personSessionSummary: vi.fn(),
    listGatewayCredentials: vi.fn(),
    listBrokerInventory: vi.fn(),
    listServicePrincipals: vi.fn(),
    listServiceTokens: vi.fn(),
    listRevokedServiceTokens: vi.fn(),
    listRevokedServicePrincipals: vi.fn(),
  },
}))

// jsdom has no clipboard.
vi.mock('../components/common/CopyableId', () => ({
  __esModule: true,
  default: () => null,
  copyText: vi.fn().mockResolvedValue(true),
}))

const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../test-harness/fixtures/app-redirect-addresses.json'), 'utf8'))

const ME = 'a0000000-0000-4000-8000-000000000001'
const NEW_ID = 'a0d17070-0000-4000-8000-0000000260e1'
const SECRET = 'not-a-real-secret-just-forty-three-characters-0'
const GRAFANA = { id: 'c0ffee00-0000-4000-8000-000000000001', client_name: 'Aber Grafana', registration_type: 'manual', part_of_stack: true, client_type: 'confidential', redirect_uris: ['http://grafana.test/cb'], client_uri: null, created_at: '2026-09-01T09:00:00Z', people_allowing: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/access-control/apps')
  api.listApps.mockResolvedValue([GRAFANA])
  api.appApprovals.mockResolvedValue([])
  api.registerApp.mockImplementation(async (name, uris, type) => ({
    id: NEW_ID, name, client_type: type, redirect_uris: uris, client_secret: type === 'confidential' ? SECRET : null,
  }))
  api.listPeople.mockResolvedValue([])
  api.listGatewayCredentials.mockResolvedValue([])
  api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [] })
  api.listServicePrincipals.mockResolvedValue([])
  api.listServiceTokens.mockResolvedValue(new Map())
  api.listRevokedServiceTokens.mockResolvedValue(new Set())
  api.listRevokedServicePrincipals.mockResolvedValue(new Map())
})

describe('the address rule', () => {
  it('answers every case in the fixture the database answers', () => {
    expect(FIXTURE.cases.length).toBeGreaterThan(40)
    for (const { uri, domain, ok, rule } of FIXTURE.cases) {
      expect(redirectAddressProblem(uri, domain) === null, `${rule}: ${JSON.stringify(uri)} with ${domain}`).toBe(ok)
    }
  })

  it('says what is wrong in words that follow the address', () => {
    expect(redirectAddressProblem('https://a.example.org/cb#x')).toMatch(/fragment/)
    expect(redirectAddressProblem('https://*.example.org/cb')).toMatch(/wildcard/)
    expect(redirectAddressProblem('http://a.example.org/cb')).toMatch(/plain http/)
    expect(redirectAddressProblem('myapp://cb')).toMatch(/https:\/\//)
  })

  it('names the site\'s domain in the http refusal when it has one', () => {
    expect(redirectAddressProblem('http://a.example.org/cb', 'plant.example')).toMatch(/under plant\.example/)
    expect(redirectAddressProblem('http://a.example.org/cb')).not.toMatch(/under/)
  })

  it('takes one address to a line, drops empty lines and faults the first bad one by name', () => {
    expect(redirectAddressesProblem('')).toBeNull()
    expect(redirectAddressesProblem('\n  https://a.example.org/cb  \r\n\nhttp://localhost:3000/cb\n')).toBeNull()
    expect(redirectAddressesProblem('https://a.example.org/cb\nhttp://b.example.org/cb\nhttps://c.example.org/#x'))
      .toBe(`http://b.example.org/cb ${redirectAddressProblem('http://b.example.org/cb')}.`)
    expect(redirectAddressesProblem('https://a.example.org/cb\nhttps://a.example.org/cb')).toBe('https://a.example.org/cb is given twice.')
    const eleven = Array.from({ length: APP_REDIRECT_MAX + 1 }, (_, n) => `https://a${n}.example.org/cb`).join('\n')
    expect(redirectAddressesProblem(eleven)).toBe(`Give ${APP_REDIRECT_MAX} addresses at most.`)
  })

  it('reads the site\'s domain from the API address as the database does', () => {
    expect(siteDomainOf('https://api.plant.example')).toBe('plant.example')
    expect(siteDomainOf('https://api.plant.example:8443/')).toBe('plant.example')
    expect(siteDomainOf('https://aber.example')).toBe('aber.example')
    expect(siteDomainOf('https://api.example.co.uk')).toBe('example.co.uk')
    for (const none of ['http://127.0.0.1:54321', 'http://localhost:54321', 'http://[::1]:54321', '', undefined]) {
      expect(siteDomainOf(none)).toBeNull()
    }
  })
})

describe('an app\'s name', () => {
  it('is not a problem until it is too long or holds a control character', () => {
    expect(appNameProblem('')).toBeNull()
    expect(appNameProblem('  Shift Reports ')).toBeNull()
    expect(appNameProblem('x'.repeat(APP_NAME_MAX))).toBeNull()
    expect(appNameProblem('x'.repeat(APP_NAME_MAX + 1))).toMatch(/80 characters at most/)
    expect(appNameProblem('two\nlines')).toMatch(/control character/)
  })

  it('is registered as added by an Administrator, and not as part of Aber', () => {
    expect(appRegistration({ registration_type: 'manual', part_of_stack: false }).label).toBe('Added by an Administrator')
    expect(appRegistration({ registration_type: 'manual', part_of_stack: true }).label).toBe('Part of Aber')
  })
})

async function openDialog(showToast = vi.fn()) {
  render(<AccessControlTab showToast={showToast} userRole="Administrator" currentUserId={ME} />)
  fireEvent.click(await screen.findByRole('button', { name: /Register App/ }))
  return { showToast, dialog: await screen.findByRole('dialog', { name: 'Register an app' }) }
}

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const reasons = (dialog) => [...dialog.querySelectorAll('.hint-danger')].map(el => el.textContent.trim()).join(' ').trim()

describe('the Register App dialog', () => {
  it('opens from the Apps tab, saying nothing is wrong, with the confirm greyed', async () => {
    const { dialog } = await openDialog()
    const confirm = within(dialog).getByRole('button', { name: /Register App/ })
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveClass('btn-disabled')
    expect(reasons(dialog)).toBe('')
    expect(within(dialog).getByLabelText(/^Name/)).toHaveFocus()
  })

  it('says what is missing from the first edit, above the buttons', async () => {
    const { dialog } = await openDialog()
    type(/^Addresses/, 'https://reports.example.org/cb')
    expect(reasons(dialog)).toBe('Give the app a name')
    type(/^Name/, 'Shift Reports')
    type(/^Addresses/, '')
    expect(reasons(dialog)).toBe('Give at least one address it may send people back to')
  })

  it('says under the field why an address is refused, and keeps the confirm greyed', async () => {
    const { dialog } = await openDialog()
    type(/^Name/, 'Shift Reports')
    type(/^Addresses/, 'https://reports.example.org/cb\nhttp://reports.example.org/cb')
    expect(within(dialog).getByText(/^http:\/\/reports\.example\.org\/cb is plain http/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Register App/ })).toHaveClass('btn-disabled')
    expect(within(dialog).getByLabelText(/^Addresses/)).toHaveAttribute('aria-invalid', 'true')
    type(/^Addresses/, 'https://reports.example.org/cb\nhttp://localhost:3000/cb')
    expect(within(dialog).getByRole('button', { name: /Register App/ })).not.toHaveClass('btn-disabled')
    expect(within(dialog).getByRole('button', { name: /Register App/ })).toBeEnabled()
  })

  it('says under the name why a name is refused', async () => {
    const { dialog } = await openDialog()
    type(/^Name/, 'x'.repeat(APP_NAME_MAX + 1))
    type(/^Addresses/, 'https://reports.example.org/cb')
    expect(within(dialog).getByText(`An app's name is ${APP_NAME_MAX} characters at most.`)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Register App/ })).toHaveClass('btn-disabled')
  })

  it('registers a confidential app with the name trimmed and one address a line, and shows its secret once', async () => {
    const { dialog, showToast } = await openDialog()
    type(/^Name/, '  Shift Reports ')
    type(/^Addresses/, ' https://reports.example.org/cb \n\nhttp://10.1.2.3:3000/cb')
    fireEvent.click(within(dialog).getByRole('button', { name: /Register App/ }))

    const done = await screen.findByRole('dialog', { name: 'Shift Reports is registered' })
    expect(api.registerApp).toHaveBeenCalledWith('Shift Reports', ['https://reports.example.org/cb', 'http://10.1.2.3:3000/cb'], 'confidential')
    expect(within(done).getByText(/Copy the client secret now/)).toBeInTheDocument()
    expect(within(done).getByLabelText('Client secret')).toHaveValue(SECRET)
    expect(within(done).getByLabelText('Client ID')).toHaveValue(NEW_ID)
    expect(within(done).getByLabelText('Discovery address')).toHaveValue('http://127.0.0.1:54321/auth/v1/.well-known/openid-configuration')
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Shift Reports is registered'), 'success', { to: appUrl(NEW_ID) })
    // The list behind it is read again.
    await waitFor(() => expect(api.listApps).toHaveBeenCalledTimes(2))

    // Closing discards it: a new dialog is a blank form, and the secret is in no toast.
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }))
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument()
    expect(JSON.stringify(showToast.mock.calls)).not.toContain(SECRET)
    fireEvent.click(await screen.findByRole('button', { name: /Register App/ }))
    const again = await screen.findByRole('dialog', { name: 'Register an app' })
    expect(within(again).getByLabelText(/^Name/)).toHaveValue('')
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument()
  })

  it('registers a public app, which has no secret to show', async () => {
    const { dialog } = await openDialog()
    type(/^Name/, 'Plant Viewer')
    type('Type', 'public')
    expect(within(dialog).getByText(/signs people in with PKCE alone/)).toBeInTheDocument()
    type(/^Addresses/, 'http://localhost:5173/cb')
    fireEvent.click(within(dialog).getByRole('button', { name: /Register App/ }))

    const done = await screen.findByRole('dialog', { name: 'Plant Viewer is registered' })
    expect(api.registerApp).toHaveBeenCalledWith('Plant Viewer', ['http://localhost:5173/cb'], 'public')
    expect(within(done).getByText(/It is a public app, so it has no secret/)).toBeInTheDocument()
    expect(within(done).queryByLabelText('Client secret')).not.toBeInTheDocument()
    expect(within(done).getByLabelText('Client ID')).toHaveValue(NEW_ID)
  })

  it('shows a refusal in the dialog, which stays open with what was typed', async () => {
    api.registerApp.mockRejectedValueOnce(new Error('an app named Shift Reports is already registered: give this one another name'))
    const { dialog, showToast } = await openDialog()
    type(/^Name/, 'Shift Reports')
    type(/^Addresses/, 'https://reports.example.org/cb')
    fireEvent.click(within(dialog).getByRole('button', { name: /Register App/ }))

    expect(await within(dialog).findByText(/already registered: give this one another name/)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Register an app' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('Shift Reports')
    expect(within(dialog).getByLabelText(/^Addresses/)).toHaveValue('https://reports.example.org/cb')
    expect(showToast).not.toHaveBeenCalled()
    expect(api.listApps).toHaveBeenCalledTimes(1)
  })

  it('names the site\'s domain in the hint when the API address has one', async () => {
    // The test environment's API address is a loopback one, so it has none.
    const { dialog } = await openDialog()
    expect(within(dialog).getByText(/plain http only on this site's own network: localhost, a private address\./)).toBeInTheDocument()
  })
})
