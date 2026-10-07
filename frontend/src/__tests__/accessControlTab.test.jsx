import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    listGatewayCredentials: vi.fn(),
    listBrokerInventory: vi.fn(),
    listServicePrincipals: vi.fn(),
    listServiceTokens: vi.fn(),
    listRevokedServiceTokens: vi.fn(),
    revokeServiceToken: vi.fn(),
    listRevokedServicePrincipals: vi.fn(),
    revokeServicePrincipal: vi.fn(),
    reinstateServicePrincipal: vi.fn(),
    createServicePrincipal: vi.fn(),
  }
}))

// The two modals reach for browser APIs this suite has no need to stub; the tab's job is to decide
// WHICH action a row offers, and that is asserted through the buttons rather than through a mount.
vi.mock('../components/modals/GatewayCredentialModal', () => ({
  GatewayCredentialModal: () => <div data-testid="credential-modal" />
}))
vi.mock('../components/modals/GatewayBundleModal', () => ({
  GatewayBundleModal: () => <div data-testid="bundle-modal" />
}))
vi.mock('../components/modals/ServiceTokenModal', () => ({
  ServiceTokenModal: ({ principalName }) => <div data-testid="token-modal">{principalName}</div>
}))
vi.mock('../components/modals/ServicePrincipalRevocationModal', () => ({
  ServicePrincipalRevocationModal: ({ principalName, revocation }) => (
    <div data-testid="identity-modal">{revocation ? 'reinstate' : 'withdraw'}:{principalName}</div>
  )
}))
// A stub that can be "submitted": the tab's job on creation is to open the token dialog for the
// row the RPC returned, and that is asserted by pressing the stub's button.
vi.mock('../components/modals/ServicePrincipalCreateModal', () => ({
  ServicePrincipalCreateModal: ({ onCreated, onClose }) => (
    <div data-testid="create-modal">
      <button onClick={() => {
        onCreated({ principal_id: 'c0000000-0000-4000-8000-000000000009', name: 'Line 4 OEE report', permissions: ['telemetry:read'] })
        onClose()
      }}>stub-create</button>
    </div>
  )
}))
vi.mock('../components/modals/ServicePrincipalDescribeModal', () => ({
  ServicePrincipalDescribeModal: ({ principal }) => <div data-testid="describe-modal">{principal.name}</div>
}))
vi.mock('../components/modals/ServiceTokenInventoryModal', () => ({
  ServiceTokenInventoryModal: ({ principalName, status }) => (
    <div data-testid="inventory-modal">{principalName}:{status.rows.length}</div>
  )
}))

const provisioned = {
  id: '12000000-0000-4000-8000-000000000001',
  name: 'Sim_Gateway_Cell1_Machining',
  sparkplug_id: 'gwy120000000000400080000',
  deployment: 'host', is_archived: false, status: 'ONLINE',
  enrolled_at: null, credential_revoked_at: null, issued_at: null
}

const enrolled = {
  id: '2a000000-0000-4000-8000-000000000001',
  name: 'Cell 4 Press Line',
  sparkplug_id: 'gwy2a0000000000400080000',
  deployment: 'remote', is_archived: false, status: 'ONLINE',
  enrolled_at: '2026-08-01T09:00:00Z', credential_revoked_at: null, issued_at: null
}

const MCP_PRINCIPAL = {
  principal_id: 'b0000000-0000-4000-8000-000000000001',
  permissions: ['telemetry:read'],
  created_at: null,
  can_sign_in: false
}

beforeEach(() => {
  vi.clearAllMocks()
  // Defaulted so every credential-inventory test renders the whole page. Individual tests override.
  // An empty-but-read inventory: the Broker column resolves to "No account" rather than "Not read".
  api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [], read_at: '2026-09-12T00:00:00Z' })
  api.listServicePrincipals.mockResolvedValue([MCP_PRINCIPAL])
  api.listServiceTokens.mockResolvedValue(new Map())
  // Empty by default, which is both the common case and the reading a caller who cannot see the
  // denylist gets. Tests that care about a withdrawal override it.
  api.listRevokedServiceTokens.mockResolvedValue(new Set())
  api.listRevokedServicePrincipals.mockResolvedValue(new Map())
})

/** The page's one card. */
const card = () => document.querySelector('.page-main > .card')

/** The page opens on Broker credentials; the other three lists are a tab each. */
async function renderTab(label) {
  const result = render(<AccessControlTab showToast={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: label }))
  return result
}

describe('AccessControlTab', () => {
  /**
   * The case the page is designed around: a demonstration stack has working credentials issued by
   * `scripts/mosquitto-provision-gateway.mjs` and no record of them. The page must say it has no record, not that
   * the gateway has no credential.
   */
  it('reports a script-provisioned gateway as having no platform record, not no credential', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByText('No platform record').length).toBeGreaterThan(0))
    // The meaning lives on the badge's tooltip now rather than in three lines beside it.
    expect(screen.getAllByTitle(/Broker column says whether an account exists/i).length).toBe(1)
    expect(screen.queryByText(/^No credential$/i)).toBeNull()
  })

  /** The card's tip names the two columns, so a reader knows the recorded state and the live one
   *  are different things before reading a row. */
  it('states the two sources in the card tip', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    fireEvent.mouseEnter(await screen.findByRole('button', { name: 'About broker credentials' }))
    const tip = screen.getByRole('tooltip').textContent
    expect(tip).toMatch(/what the platform issued and recorded/i)
    expect(tip).toMatch(/read live from Dynamic Security/i)
    // The tip replaced the paragraph, so the sentence is not also in the body.
    expect(document.querySelector('.card-body p')).toBeNull()
  })

  /** When the broker cannot be read the Broker column reads Not read, and the page says why once. */
  it('reports the broker as Not read when the inventory read fails', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockRejectedValue(new Error('the broker credential service is unreachable'))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('The broker was not read.')).toBeTruthy())
    expect(screen.getAllByText('Not read').length).toBeGreaterThan(0)
  })

  /** The two states are shown side by side: recorded, and live. */
  it('shows a script-provisioned gateway as No platform record and its live broker state', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [{ username: provisioned.sparkplug_id, roles: ['gateway'], disabled: false }],
      roles: [],
    })
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByText('No platform record').length).toBeGreaterThan(0))
    // The broker holds it and it is enabled: Active, from the live read.
    expect(screen.getByText('Active')).toBeTruthy()
  })

  /** A revoked gateway reads Disabled at the broker. */
  it('shows a disabled broker account as Disabled', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [{ username: provisioned.sparkplug_id, roles: ['gateway'], disabled: true }],
      roles: [],
    })
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Disabled')).toBeTruthy())
  })

  /** An account the broker holds that no gateway row claims joins Broker accounts, marked in words. */
  it('lists a broker account with no gateway row among the broker accounts, marked No gateway', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [
        { username: provisioned.sparkplug_id, roles: ['gateway'], disabled: false },
        { username: 'gwy999999999999999999999', roles: ['gateway'], disabled: false },
        { username: 'aber_ingestion', roles: ['ingestion'], disabled: false },
      ],
      roles: [],
    })
    await renderTab('Broker accounts')

    const stray = (await screen.findByRole('button', { name: /gwy999999999999999999999/ })).closest('tr')
    const badge = within(stray).getByText('No gateway')
    expect(badge.className).toContain('badge-neutral')
    expect(badge.title).toMatch(/revoke-orphaned-broker-accounts/)
    expect(within(stray).getByText(/no gateway claims it/)).toBeTruthy()
    // The platform account is listed beside it, first, and unmarked; a known gateway is not listed.
    const names = screen.getAllByRole('button', { name: /Copy MQTT username/ }).map(b => b.textContent)
    expect(names).toEqual(['aber_ingestion', 'gwy999999999999999999999'])
    expect(within(screen.getByRole('button', { name: /aber_ingestion/ }).closest('tr')).queryByText('No gateway')).toBeNull()
    // Its live state and its copy control are what every other account has.
    expect(within(stray).getByText('Active')).toBeTruthy()
  })

  /** The tab is there whether or not a stray exists, and marks none on a healthy stack. */
  it('marks no account No gateway when every broker account is a known gateway', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [{ username: provisioned.sparkplug_id, roles: ['gateway'], disabled: false }],
      roles: [],
    })
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByText('No platform record').length).toBeGreaterThan(0))
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    fireEvent.click(screen.getByRole('tab', { name: 'Broker accounts' }))
    await waitFor(() => expect(screen.getByText(/The broker holds no platform account/)).toBeTruthy())
    expect(screen.queryByText('No gateway')).toBeNull()
  })

  it('offers a mint for a host-run gateway and a bundle for a Remote one', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned, enrolled])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/Generate/)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Bundle/ })).toBeTruthy()
    expect(screen.getAllByText('Issued', { selector: '.badge' }).length).toBe(1)
  })

  /**
   * The explanation is a property of the state, not the row, so it is a tooltip on the badge rather
   * than a paragraph repeated down the column.
   */
  it('carries the explanation as a tooltip rather than repeating it down the column', async () => {
    api.listGatewayCredentials.mockResolvedValue([
      provisioned,
      { ...provisioned, id: '13000000-0000-4000-8000-000000000001', name: 'Sim_Gateway_Cell2_Robotics' },
      { ...provisioned, id: '14000000-0000-4000-8000-000000000001', name: 'Sim_Gateway_Cell3_OEE' },
      { ...provisioned, id: '15000000-0000-4000-8000-000000000001', name: 'Sim_Gateway_Site_BMS' }
    ])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByText('No platform record', { selector: '.badge' }).length).toBe(4))
    // FOUR BADGES, FOUR TOOLTIPS, AND NOT ONE LINE OF REPEATED BODY TEXT. The second assertion is
    // the one that matters: it fails the moment the sentence is put back into the column.
    expect(screen.getAllByTitle(/Broker column says whether an account exists/i).length).toBe(4)
    expect(screen.queryByText(/Broker column says whether an account exists/i)).toBeNull()
  })

  /** Archived gateways are hidden by default and offer no action when shown: archiving rotated the
   *  credential, so it can be issued a new one only after a restore. */
  it('hides archived gateways until asked, and offers them no action', async () => {
    api.listGatewayCredentials.mockResolvedValue([{ ...provisioned, is_archived: true }])
    render(<AccessControlTab showToast={vi.fn()} />)

    // Archived is a filter value, not a toggle. The empty message says the list is filtered, not
    // that nothing is registered.
    await waitFor(() => expect(screen.getByText(/No gateway matches this filter/i)).toBeTruthy())
    const filter = screen.getByLabelText('Filter gateways by credential state')
    expect(within(filter).getByText('Archived (1)')).toBeTruthy()
    expect(within(filter).getByText('Active (0)')).toBeTruthy()
    fireEvent.change(filter, { target: { value: 'archived' } })

    await waitFor(() => expect(screen.getByText(/Restore to issue/i)).toBeTruthy())
    expect(screen.queryByText(/Generate/)).toBeNull()
  })

  /** The filter's values are the Credential column's states, with a count on each. */
  it('filters gateways by credential state', async () => {
    api.listGatewayCredentials.mockResolvedValue([
      provisioned,
      { ...enrolled, id: '2b000000-0000-4000-8000-000000000001', name: 'Cell 5 Press Line', sparkplug_id: 'gwy2b0000000000400080000', enrolled_at: null, status: 'PENDING_ENROLLMENT' },
    ])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Sim_Gateway_Cell1_Machining')).toBeTruthy())
    expect(screen.getByText('Cell 5 Press Line')).toBeTruthy()
    const filter = screen.getByLabelText('Filter gateways by credential state')
    expect(within(filter).getByText('Active (2)')).toBeTruthy()
    expect(within(filter).getByText('Setup outstanding (1)')).toBeTruthy()
    expect(within(filter).getByText('No platform record (1)')).toBeTruthy()

    fireEvent.change(filter, { target: { value: 'awaiting-enrolment' } })
    await waitFor(() => expect(screen.queryByText('Sim_Gateway_Cell1_Machining')).toBeNull())
    expect(screen.getByText('Cell 5 Press Line')).toBeTruthy()
    // No summary pills under the table and no count on the heading: the filter carries the counts.
    expect(screen.queryByText(/no record$/)).toBeNull()
    expect(card().querySelector('.section-count')).toBeNull()
  })

  it('heads the two action columns Actions', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy())
    expect(screen.queryByRole('columnheader', { name: 'Issue' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Machine identities' }))
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy())
    expect(screen.queryByRole('columnheader', { name: 'Mint' })).toBeNull()
  })

  /**
   * The two reads have different authority (credentials accept Shopfloor_Manager, principals are
   * Administrator-only), so a refusal on one must not blank the other.
   */
  it('still renders the credential inventory when the principal read is refused', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listServicePrincipals.mockRejectedValue(new Error('insufficient privileges to list service principals'))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByText('No platform record').length).toBeGreaterThan(0))
    // The refusal is reported where the list would have been, on the Machine identities tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Machine identities' }))
    await waitFor(() => expect(screen.getByText(/insufficient privileges/i)).toBeTruthy())
  })

  it('opens on Broker credentials, with one list per tab in a fixed order', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Sim_Gateway_Cell1_Machining')).toBeTruthy())
    // No counts on the tabs: each accessible name is the label alone.
    expect(screen.getAllByRole('tab').map(t => t.textContent))
      .toEqual(['Broker credentials', 'Machine identities', 'Broker accounts', 'Broker roles'])
    expect(screen.getByRole('tab', { name: 'Broker credentials' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('tab', { name: 'Machine identities' }))
    await waitFor(() => expect(screen.getByText('MCP read-only client')).toBeTruthy())
    expect(screen.queryByText('Sim_Gateway_Cell1_Machining')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Broker roles' }))
    expect(screen.getByText('ingestion', { selector: 'td' })).toBeTruthy()
    expect(screen.queryByText('MCP read-only client')).toBeNull()

    // The arrow keys move between tabs too, through the shared tab bar.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Broker roles' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Broker accounts' }).getAttribute('aria-selected')).toBe('true')
  })

  /** A search-bar card names one list; the page opens on its tab and hands the request back. */
  it('opens the tab a search-bar card names, and drops the request', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    const onClearSection = vi.fn()
    render(<AccessControlTab showToast={vi.fn()} initialSection="roles" onClearSection={onClearSection} />)

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Broker roles' }).getAttribute('aria-selected')).toBe('true'))
    expect(onClearSection).toHaveBeenCalled()
  })

  it('ignores a section it does not have, and still drops the request', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    const onClearSection = vi.fn()
    render(<AccessControlTab showToast={vi.fn()} initialSection="services" onClearSection={onClearSection} />)

    await waitFor(() => expect(onClearSection).toHaveBeenCalled())
    expect(screen.getByRole('tab', { name: 'Broker credentials' }).getAttribute('aria-selected')).toBe('true')
  })

  /** A declared fixture is named rather than marked as a stray; anything undeclared is the stray. */
  it('names a declared fixture among the broker accounts and marks only the stray', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [
        { username: 'gwy110000000000400080000', roles: ['gateway', 'gateway-gwy110000000000400080000'], disabled: false },
        { username: 'gwy999999999999999999999', roles: ['gateway'], disabled: false },
      ],
      roles: [],
    })
    await renderTab('Broker accounts')

    const fixture = (await screen.findByRole('button', { name: /gwy110000000000400080000/ })).closest('tr')
    expect(within(fixture).getByText(/Validator test gateway/)).toBeTruthy()
    expect(within(fixture).queryByText('No gateway')).toBeNull()
    const stray = screen.getByRole('button', { name: /gwy999999999999999999999/ }).closest('tr')
    expect(within(stray).getByText('No gateway')).toBeTruthy()
  })

  /** The broker's own accounts are listed live, each with the purpose of the role it holds. */
  it('lists the platform accounts with the purpose of their role', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [
        { username: provisioned.sparkplug_id, roles: ['gateway'], disabled: false },
        { username: 'aber_monitor', roles: ['monitor'], disabled: false },
        { username: 'dynsec-admin', roles: ['admin'], disabled: false },
        { username: 'aber_ingestion', roles: ['ingestion'], disabled: true },
      ],
      roles: [],
    })
    await renderTab('Broker accounts')

    await waitFor(() => expect(screen.getByRole('button', { name: /aber_monitor/ })).toBeTruthy())
    // Policy order, not alphabetical: ingestion, monitor, admin.
    const names = screen.getAllByRole('button', { name: /Copy MQTT username/ }).map(b => b.textContent)
    expect(names).toEqual(['aber_ingestion', 'aber_monitor', 'dynsec-admin'])
    // Scoped to the row: the same purpose is printed beside the role on Broker roles.
    const monitorRow = screen.getByRole('button', { name: /aber_monitor/ }).closest('tr')
    expect(within(monitorRow).getByText(/The broker health probes and the metrics exporter/)).toBeTruthy()
    expect(screen.getByText('Disabled')).toBeTruthy()
    expect(screen.queryByText('No gateway')).toBeNull()
  })

  /** An unrecognised machine identity is more interesting than a recognised one, so it is listed. */
  it('lists a principal the dashboard has no description for, rather than hiding it', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      { principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: [], created_at: null, can_sign_in: false }
    ])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText(/Undocumented machine identity/i)).toBeTruthy())
    // Both origins, which is the assertion rather than the exact sentence: an unknown principal may
    // come from a migration or from an RLS suite that seeded a fixture and did not clean up.
    expect(screen.getByTitle(/by a migration, or by a test suite/i)).toBeTruthy()
    // No grant of its own, said in a column because it answers "what can this reach". The wording
    // must not claim every policy refuses it: the asset inventory reads are `TO authenticated USING
    // (true)`, so a signed token reaches them with no grant at all.
    expect(screen.getByText(/reaches only what is open to any authenticated caller/i)).toBeTruthy()
  })

  /**
   * The fallback is for principals nobody could have written down, not the ones that ship.
   * `check-docs-drift.mjs` stops a seeded principal going undocumented; this asserts the visible
   * half.
   */
  it('names the two principals npm run setup signs keys for', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      { principal_id: 'b0000000-0000-4000-8000-000000000002', permissions: ['telemetry:read'], created_at: null, can_sign_in: false },
      { principal_id: 'b0000000-0000-4000-8000-000000000003', permissions: ['telemetry:read'], created_at: null, can_sign_in: false }
    ])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('Service_Ingestor')).toBeTruthy())
    expect(screen.getByText('Service_Playback')).toBeTruthy()
    expect(screen.queryByText(/Undocumented machine identity/i)).toBeNull()
  })

  /**
   * Issue Token is offered where a token is read, and nowhere else: the two environment-keyed
   * daemons take their key from the environment, so a minted token for them fixes nothing. Asserted
   * per row rather than by counting buttons.
   */
  it('offers Issue Token for an MCP-style principal and not for the two environment keys', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      MCP_PRINCIPAL,
      { principal_id: 'b0000000-0000-4000-8000-000000000002', permissions: ['telemetry:read'], created_at: null, can_sign_in: false },
      { principal_id: 'b0000000-0000-4000-8000-000000000003', permissions: ['telemetry:read'], created_at: null, can_sign_in: false }
    ])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('MCP read-only client')).toBeTruthy())

    const rowFor = (name) => screen.getByText(name).closest('tr')
    expect(within(rowFor('MCP read-only client')).queryByRole('button', { name: /Issue Token/i })).toBeTruthy()
    expect(within(rowFor('Service_Ingestor')).queryByRole('button', { name: /Issue Token/i })).toBeNull()
    expect(within(rowFor('Service_Playback')).queryByRole('button', { name: /Issue Token/i })).toBeNull()
  })

  /**
   * A principal `create_machine_principal()` made at runtime has no entry in KNOWN_PRINCIPALS and
   * must still be mintable, so the button follows describePrincipal()'s fallback rather than a
   * hardcoded list.
   */
  it('offers Issue Token for an undocumented principal, because the fallback mint command is the MCP one', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      { principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: [], created_at: null, can_sign_in: false }
    ])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText(/Undocumented machine identity/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Issue Token/i })).toBeTruthy()
  })

  /**
   * A principal created from the page carries its name and purpose on the row, and the page
   * lists it by them rather than as undocumented.
   */
  it('names a principal from its machine_principals row', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      {
        principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: ['telemetry:read'],
        created_at: null, can_sign_in: false, name: 'Line 4 OEE report', purpose: 'Reads the hourly rollup.',
      }
    ])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('Line 4 OEE report')).toBeTruthy())
    expect(screen.getByTitle('Reads the hourly rollup.')).toBeTruthy()
    expect(screen.queryByText(/Undocumented machine identity/i)).toBeNull()
    expect(within(screen.getByText('Line 4 OEE report').closest('tr')).queryByRole('button', { name: /Issue Token/i })).toBeTruthy()
  })

  /**
   * Renaming is offered only where there is a row to rename: a pinned identity is named in
   * the registry and the RPC refuses it, so a pencil on its row would open a dialog to fail.
   */
  it('offers Describe for a named principal and not for a pinned one', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      MCP_PRINCIPAL,
      {
        principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: ['telemetry:read'],
        created_at: null, can_sign_in: false, name: 'Line 4 OEE report', purpose: null,
      }
    ])
    await renderTab('Machine identities')
    await waitFor(() => expect(screen.getByText('Line 4 OEE report')).toBeTruthy())

    expect(screen.queryByRole('button', { name: /Describe MCP read-only client/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Describe Line 4 OEE report/ }))
    await waitFor(() => expect(screen.getByTestId('describe-modal').textContent).toBe('Line 4 OEE report'))
  })

  it('offers New Machine Identity on the Machine identities tab', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')
    await waitFor(() => expect(screen.getByRole('button', { name: /New Machine Identity/i })).toBeTruthy())
    // Which plane, on the button itself.
    expect(screen.getByRole('button', { name: /New Machine Identity/i }).title).toMatch(/never the broker/)
  })

  it('withholds New Machine Identity when the principal read was refused', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockRejectedValue(new Error('insufficient privileges to list machine principals'))
    await renderTab('Machine identities')
    await waitFor(() => expect(screen.getByText(/insufficient privileges/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /New Machine Identity/i })).toBeNull()
    // The row held only that button, so it goes too; the tab's tip stays in the bar.
    expect(card().querySelector('.filter-bar')).toBeNull()
    expect(screen.getByRole('button', { name: 'About machine identities' }).parentElement).toHaveClass('tab-strip-help')
  })

  /**
   * Create, then straight into the token dialog for the new row, named from the RPC's own return
   * rather than waited for from the reload: the first token is shown once the way every other is.
   */
  it('opens the token dialog for a principal the moment it is created', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')
    await waitFor(() => expect(screen.getByRole('button', { name: /New Machine Identity/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /New Machine Identity/i }))
    await waitFor(() => expect(screen.getByTestId('create-modal')).toBeTruthy())
    fireEvent.click(screen.getByText('stub-create'))

    await waitFor(() => expect(screen.getByTestId('token-modal').textContent).toBe('Line 4 OEE report'))
    expect(screen.queryByTestId('create-modal')).toBeNull()
    // The list is reloaded so the row appears behind the dialog.
    expect(api.listServicePrincipals).toHaveBeenCalledTimes(2)
  })

  it('opens the token dialog for the principal whose button was pressed', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('MCP read-only client')).toBeTruthy())
    screen.getByRole('button', { name: /Issue Token/i }).click()

    // The NAME is carried into the modal rather than looked up again there, so asserting it here
    // is asserting that the right row opened the dialog.
    await waitFor(() => expect(screen.getByTestId('token-modal').textContent).toBe('MCP read-only client'))
  })

  /**
   * The count is the way in: a principal has N tokens and `revoke_service_token()` takes one jti,
   * so a row-level Revoke button would have to guess.
   */
  it('opens the token inventory from the count, carrying the rows it counted', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServiceTokens.mockResolvedValue(new Map([[
      MCP_PRINCIPAL.principal_id,
      [
        { jti: 'a', issued_at: '2026-09-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' },
        { jti: 'b', issued_at: '2026-09-02T00:00:00Z', expires_at: '2099-02-01T00:00:00Z' }
      ]
    ]]))
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('2 active')).toBeTruthy())
    screen.getByRole('button', { name: '2 active' }).click()

    // The STATUS is passed rather than recomputed in the dialog, so asserting the row count here
    // asserts that the list and the link cannot disagree.
    await waitFor(() => expect(screen.getByTestId('inventory-modal').textContent)
      .toBe('MCP read-only client:2'))
  })

  /** The count must not include what has been revoked. */
  it('excludes a revoked token from the active count', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServiceTokens.mockResolvedValue(new Map([[
      MCP_PRINCIPAL.principal_id,
      [
        { jti: 'a', issued_at: '2026-09-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' },
        { jti: 'b', issued_at: '2026-09-02T00:00:00Z', expires_at: '2099-02-01T00:00:00Z' }
      ]
    ]]))
    api.listRevokedServiceTokens.mockResolvedValue(new Set(['a']))
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('1 active')).toBeTruthy())
    expect(screen.queryByText('2 active')).toBeNull()
  })

  /** Nothing to list means nothing to open -- a link onto an empty dialog is worse than a dash. */
  it('shows a plain dash when no mint is recorded', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('MCP read-only client')).toBeTruthy())
    const cell = screen.getByTitle(/not the same as none existing/i)
    expect(cell.textContent).toBe('—')
    expect(cell.tagName).toBe('SPAN')
    expect(within(cell.closest('tr')).queryByText(/active$/)).toBeNull()
  })

  /** Every token expired or revoked: still a way in to the list, reading 0 active. */
  it('links 0 active when every recorded token has lapsed', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServiceTokens.mockResolvedValue(new Map([[
      MCP_PRINCIPAL.principal_id,
      [{ jti: 'a', issued_at: '2026-01-01T00:00:00Z', expires_at: '2026-02-01T00:00:00Z' }],
    ]]))
    await renderTab('Machine identities')

    const link = await screen.findByRole('button', { name: '0 active' })
    expect(link.title).toMatch(/The last token expired on/)
  })

  /**
   * Withdraw sits beside Issue, so the page that hands out credentials also has the control that
   * takes the identity back.
   */
  it('offers Withdraw beside Issue Token for a live identity', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByRole('button', { name: /Issue Token/i })).toBeTruthy())
    expect(screen.getByRole('button', { name: /^Withdraw$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Reinstate/i })).toBeNull()
  })

  /**
   * Minting is not offered for a withdrawn identity: record_service_token_issued() refuses one
   * outright, so Reinstate is the action available.
   */
  it('replaces Issue Token with Reinstate once the identity is withdrawn', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listRevokedServicePrincipals.mockResolvedValue(new Map([[
      MCP_PRINCIPAL.principal_id,
      { principal_id: MCP_PRINCIPAL.principal_id, revoked_at: '2026-09-03T12:00:00Z', reason: 'leaked' }
    ]]))
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('WITHDRAWN')).toBeTruthy())
    expect(screen.queryByText('REVOKED')).toBeNull()
    expect(screen.queryByRole('button', { name: /Issue Token/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Withdraw$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Reinstate/i })).toBeTruthy()
  })

  it('opens the dialog in the direction the identity needs', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByRole('button', { name: /^Withdraw$/i })).toBeTruthy())
    screen.getByRole('button', { name: /^Withdraw$/i }).click()
    await waitFor(() => expect(screen.getByTestId('identity-modal').textContent)
      .toBe('withdraw:MCP read-only client'))
  })

  it('shows the broker roles and marks which ones can publish', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Broker roles')

    // Role names, not usernames: the page renders the policy's roles.
    await waitFor(() => expect(screen.getByText('ingestion', { selector: 'td' })).toBeTruthy())
    expect(screen.getByText('i3x', { selector: 'td' })).toBeTruthy()
    expect(screen.getByText('monitor', { selector: 'td' })).toBeTruthy()
    expect(screen.getByText('admin', { selector: 'td' })).toBeTruthy()
    expect(screen.getByText('gateway', { selector: 'td' })).toBeTruthy()
    // With no live inventory the writes flag is the declared fallback: ingestion and admin publish.
    expect(screen.getAllByText('CAN PUBLISH').length).toBe(2)
    expect(screen.getAllByText('READ ONLY').length).toBe(3)
  })

  const LIVE_ROLES = {
    clients: [
      { username: 'aber_monitor', roles: ['monitor'], disabled: false },
    ],
    roles: [
      { rolename: 'monitor', acls: [{ acltype: 'subscribePattern', topic: '$SYS/#', allow: true }] },
      {
        rolename: 'ingestion',
        acls: [
          { acltype: 'subscribePattern', topic: 'spBv1.0/#', allow: true },
          { acltype: 'publishClientReceive', topic: 'spBv1.0/#', allow: true },
          { acltype: 'publishClientSend', topic: 'spBv1.0/+/NCMD/+', allow: true },
        ],
      },
    ],
  }
  const roleRow = (name) => screen.getByText(name, { selector: 'td' }).closest('tr')
  const rolePanel = () => document.querySelector('.context-panel')

  /**
   * With a live inventory the rules come from the broker, verb and topic, not from a literal. The
   * table carries a plain count; the rules open in the drawer from anywhere on the row, since one
   * role is nine lines.
   */
  it('counts a role’s live rules in the table and opens them in the drawer from the row', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listBrokerInventory.mockResolvedValue(LIVE_ROLES)
    await renderTab('Broker roles')

    await waitFor(() => expect(roleRow('monitor').className).toContain('row-selectable'))
    // The count is plain text: the row is what opens.
    expect(within(roleRow('monitor')).queryByRole('button')).toBeNull()
    expect(roleRow('monitor').querySelector('.section-count')).toBeNull()
    expect(roleRow('ingestion').children[2].textContent).toBe('3')
    // Not in the table.
    expect(screen.queryByText('$SYS/#')).toBeNull()

    // Any cell opens it, the purpose included.
    fireEvent.click(roleRow('monitor').lastElementChild)
    const panel = await screen.findByRole('complementary', { name: 'monitor role' })
    expect(within(panel).getByText('$SYS/#')).toBeTruthy()
    expect(within(panel).getByText('subscribe')).toBeTruthy()
    expect(within(panel).getByText('1 account')).toBeTruthy()
    expect(roleRow('monitor').className).toContain('row-selected')
    // The title carries the role's icon. A role is read-only here, so the panel offers no action
    // and therefore no primary.
    expect(panel.querySelector('.context-panel-title-row .context-panel-icon svg')).toBeTruthy()
    expect(panel.querySelector('.context-panel-actions')).toBeNull()

    // A second click on the same row closes it.
    fireEvent.click(roleRow('monitor').firstElementChild)
    await waitFor(() => expect(rolePanel().getAttribute('aria-hidden')).toBe('true'))
  })

  it('opens a role from the keyboard: the row is in the Tab order and Enter or Space toggles it', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listBrokerInventory.mockResolvedValue(LIVE_ROLES)
    await renderTab('Broker roles')

    await waitFor(() => expect(roleRow('ingestion').getAttribute('tabindex')).toBe('0'))
    roleRow('ingestion').focus()
    expect(document.activeElement).toBe(roleRow('ingestion'))
    fireEvent.keyDown(roleRow('ingestion'), { key: 'Enter' })
    expect(await screen.findByRole('complementary', { name: 'ingestion role' })).toBeTruthy()
    // Enter again closes it, as a second click does.
    fireEvent.keyDown(roleRow('ingestion'), { key: 'Enter' })
    await waitFor(() => expect(rolePanel().getAttribute('aria-hidden')).toBe('true'))
    // Space opens too, without scrolling the page: fireEvent returns false when the default is
    // prevented.
    expect(fireEvent.keyDown(roleRow('monitor'), { key: ' ' })).toBe(false)
    expect(await screen.findByRole('complementary', { name: 'monitor role' })).toBeTruthy()
    // Another key does nothing.
    fireEvent.keyDown(roleRow('ingestion'), { key: 'a' })
    expect(screen.queryByRole('complementary', { name: 'ingestion role' })).toBeNull()
  })

  it('closes the role drawer when Broker roles is left', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listBrokerInventory.mockResolvedValue(LIVE_ROLES)
    await renderTab('Broker roles')

    await waitFor(() => expect(roleRow('monitor').className).toContain('row-selectable'))
    fireEvent.click(roleRow('monitor'))
    await screen.findByRole('complementary', { name: 'monitor role' })
    fireEvent.click(screen.getByRole('tab', { name: 'Broker accounts' }))
    await waitFor(() => expect(rolePanel().getAttribute('aria-hidden')).toBe('true'))
    fireEvent.click(screen.getByRole('tab', { name: 'Broker roles' }))
    expect(roleRow('monitor').className).not.toContain('row-selected')
  })

  it('reports a role as Not read when the broker was not, and opens none', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listBrokerInventory.mockRejectedValue(new Error('credential service unreachable'))
    await renderTab('Broker roles')

    await waitFor(() => expect(screen.getAllByText('Not read').length).toBe(5))
    expect(document.querySelector('tr.row-selectable')).toBeNull()
    expect(document.querySelector('tr[tabindex]')).toBeNull()
  })

  /**
   * The wire identity and the principal id are the two values an operator retypes elsewhere, into a
   * broker credential pair and a token's `sub` claim.
   */
  it('makes both identifiers copyable rather than selectable text', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    // CopyableId renders a button, which is what makes it keyboard-reachable and announced as an
    // action -- a clickable span would be neither.
    await waitFor(() => expect(screen.getByRole('button', { name: /gwy120000000000400080000/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Machine identities' }))
    // Exact, because the mint command in the next column also contains this id. CopyableId's
    // accessible name is `Copy <label> <value>`, so naming the label makes this exact.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy principal id b0000000-0000-4000-8000-000000000001' })).toBeTruthy())
  })

  /**
   * The break-glass path stays a copyable command with the principal already in it:
   * `mint-mcp-token.mjs` works when nobody can sign in to this page.
   */
  it('offers the mint command as well as the Issue Token button', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')

    await waitFor(() => expect(
      screen.getByRole('button', {
        name: `Copy mint command node scripts/mint-mcp-token.mjs --principal ${MCP_PRINCIPAL.principal_id}`
      })
    ).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Mint token$/i })).toBeNull()
  })

  /**
   * The count is of outstanding tokens, not the latest mint: a re-mint does not invalidate the
   * previous token, so two mints a week apart are two live credentials.
   */
  it('counts every unexpired token, not just the most recent', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString()
    api.listServiceTokens.mockResolvedValue(new Map([
      [MCP_PRINCIPAL.principal_id, [
        { expires_at: inDays(30), jti: 'a' },
        { expires_at: inDays(12), jti: 'b' },
        { expires_at: inDays(-3), jti: 'expired-and-not-counted' }
      ]]
    ]))
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('2 active')).toBeTruthy())
    // The earliest expiry is the one reported: the next date on which something stops working. Read
    // off the tooltip; the link carries the count and the tooltip the detail.
    expect(screen.getByText('2 active').getAttribute('title')).toMatch(/in 12 days/i)
  })

  it('says a principal has no token on record rather than implying it has none at all', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('MCP read-only client')).toBeTruthy())
    // An empty cell is a fact about the record, not the credential, stated on the dash's tooltip.
    const row = screen.getByText('MCP read-only client').closest('tr')
    expect(within(row).getByTitle(/not the same as none existing/i).textContent).toBe('—')
  })

  /**
   * The two environment keys are outstanding on every stack from `npm run setup`, before the
   * database exists, so an unlabelled empty list would read as none.
   */
  it('states the credentials it cannot see, so an empty list is not read as none', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText(/MCP read-only client/i)).toBeTruthy())
    // On the row: the dash itself says an empty cell is a statement about the record.
    const dash = within(screen.getByText('MCP read-only client').closest('tr')).getByText('—')
    expect(dash.getAttribute('title')).toMatch(/not the same as none existing/i)
    expect(dash.getAttribute('title')).toMatch(/before this database exists/i)
  })

  /**
   * The mint column is per principal: the two keys in the release Secret are rotated, never
   * minted, because the daemons read their key from the environment at start.
   */
  it('offers rotation, not a fresh mint, for the two keys in the release Secret', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      { principal_id: 'b0000000-0000-4000-8000-000000000002', permissions: ['telemetry:read'], created_at: null, can_sign_in: false },
      { principal_id: 'b0000000-0000-4000-8000-000000000001', permissions: ['telemetry:read'], created_at: null, can_sign_in: false }
    ])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('Service_Ingestor')).toBeTruthy())
    const rowOf = (name) => screen.getByText(name).closest('tr')

    // Asserted on what would be copied, not what is drawn: both rows render the same "Copy Command"
    // label, and the command survives in the accessible name.
    expect(within(rowOf('Service_Ingestor')).getByLabelText(/npm run keys:rotate/)).toBeTruthy()
    // Said in the chart's terms: the Secret key the Deployment reads, and which Deployment.
    const rotate = within(rowOf('Service_Ingestor')).getByLabelText(/npm run keys:rotate/)
    expect(rotate.getAttribute('title')).toMatch(/SUPABASE_INGESTION_KEY in the release Secret/)
    expect(rotate.getAttribute('title')).toMatch(/ingestion Deployment/)
    expect(rotate.getAttribute('title')).not.toMatch(/\.env|containers/)
    expect(within(rowOf('Service_Ingestor')).queryByLabelText(/mint-mcp-token/)).toBeNull()
    // The MCP client is the one that command IS right for, so it keeps it.
    expect(within(rowOf('MCP read-only client')).getByLabelText(/mint-mcp-token\.mjs --principal/)).toBeTruthy()
  })

  /**
   * The copy control is styled as a ghost button. `.copyable-id` is understated for identifiers in
   * dense cells; with a fixed label the element is the affordance. `.btn-ghost` is the pairing
   * themeContrast.test.js measures in both themes, so asserting the class ties this control to that
   * guarantee.
   */
  it('renders the copy control as a ghost button, not as an understated identifier', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText('MCP read-only client')).toBeTruthy())

    const copy = screen.getByLabelText(/mint-mcp-token\.mjs --principal/)
    expect(copy.className).toMatch(/btn-ghost/)
    expect(copy.className).not.toMatch(/copyable-id/)
  })

  /**
   * The token history is the Audit Trail's security lane, which only an Administrator or Auditor
   * may read; a caller without it must still see the identities.
   */
  it('still lists identities when the token history cannot be read', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServiceTokens.mockRejectedValue(new Error('permission denied for table audit_trail'))
    await renderTab('Machine identities')

    await waitFor(() => expect(screen.getByText(/MCP read-only client/i)).toBeTruthy())
    expect(screen.getByTitle(/No token recorded for this identity/).textContent).toBe('—')
  })

  it('surfaces a failed read rather than rendering an empty inventory', async () => {
    api.listGatewayCredentials.mockRejectedValue(new Error('permission denied for view gateway_status'))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/permission denied/i)).toBeTruthy())
  })
})

/** The house card: one CardHeading, the tab bar under it, each tab's toolbar row, then its list. */
describe('AccessControlTab card composition', () => {
  it('is one card whose list scrolls, with the tab bar directly under the heading', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(card().querySelector('tbody tr')).toBeTruthy())
    expect(document.querySelectorAll('.page-main .card')).toHaveLength(1)
    expect(document.querySelector('.page-heading')).toBeNull()
    expect(document.querySelector('.page-layout').className).toContain('page-fill')
    expect(card().className).toContain('card-fill')
    // The heading carries the page's title and description; the bar follows it inside the card.
    const heading = card().firstElementChild
    expect(heading.className).toContain('card-heading')
    expect(within(heading).getByRole('heading', { name: 'Access Control' })).toBeTruthy()
    expect(heading.querySelector('.card-heading-description')).toBeTruthy()
    expect(heading.nextElementSibling).toHaveClass('tab-strip')
    // The list is the scroller: a table-wrap straight under the card, with no inline margin.
    const wrap = card().querySelector(':scope > .table-wrap')
    expect(wrap).toBeTruthy()
    expect(wrap.getAttribute('style')).toBeNull()
  })

  it('puts the tab’s filter on the left and its actions on the right of the toolbar', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(card().querySelector('tbody tr')).toBeTruthy())
    const bar = card().querySelector(':scope > .tab-strip + .filter-bar')
    expect(bar).toBeTruthy()
    expect(bar.querySelector('.help-tip')).toBeNull()
    expect(bar.firstElementChild.getAttribute('aria-label')).toBe('Filter gateways by credential state')
    expect(within(bar).getByLabelText('Filter gateways by credential state').closest('.filter-bar-actions')).toBeNull()
    expect(within(bar).getByRole('button', { name: /Refresh/ }).closest('.filter-bar-actions')).toBeTruthy()
    // The heading holds the title and description only.
    expect(card().querySelector('.card-header select')).toBeNull()
    expect(card().querySelector('.card-header .help-tip')).toBeNull()
  })

  it('offers Clear filters only while the credential filter is off Active', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(card().querySelector('tbody tr')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter gateways by credential state'), { target: { value: 'issued' } })
    fireEvent.click(screen.getByRole('button', { name: /Clear filters \(1\)/ }))
    expect(screen.getByLabelText('Filter gateways by credential state').value).toBe('active')
  })

  it('puts no count on the heading or the tabs; the filter options keep theirs', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [{ username: 'gwy999999999999999999999', roles: ['gateway'], disabled: false }],
      roles: [],
    })
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(card().querySelector('tbody tr')).toBeTruthy())
    for (const label of ['Broker credentials', 'Machine identities', 'Broker accounts', 'Broker roles']) {
      fireEvent.click(screen.getByRole('tab', { name: label }))
      expect(card().querySelector('.section-count')).toBeNull()
      expect(screen.getByRole('tab', { name: label }).textContent).toBe(label)
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Broker credentials' }))
    expect(within(screen.getByLabelText('Filter gateways by credential state')).getByText('Active (1)')).toBeTruthy()
  })

  it('explains the selected tab with one tip in the tab bar, and none as a paragraph', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(card().querySelector('tbody tr')).toBeTruthy())
    for (const [label, tip] of [
      ['Broker credentials', 'About broker credentials'],
      ['Machine identities', 'About machine identities'],
      ['Broker accounts', 'About broker accounts'],
      ['Broker roles', 'About broker roles'],
    ]) {
      fireEvent.click(screen.getByRole('tab', { name: label }))
      const tips = card().querySelectorAll('.help-tip')
      expect(tips).toHaveLength(1)
      expect(tips[0].parentElement).toHaveClass('tab-strip-help')
      expect(tips[0]).toHaveAccessibleName(tip)
    }
    expect(document.querySelector('.page-main .card p:not(.card-heading-description)')).toBeNull()
  })

  it('draws a toolbar row only on the tabs that have a filter or an action', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(card().querySelector('tbody tr')).toBeTruthy())
    for (const [label, hasRow] of [
      ['Broker credentials', true],
      ['Machine identities', true],
      ['Broker accounts', false],
      ['Broker roles', false],
    ]) {
      fireEvent.click(screen.getByRole('tab', { name: label }))
      await waitFor(() => expect(Boolean(card().querySelector(':scope > .filter-bar'))).toBe(hasRow))
    }
  })
  it('puts New Machine Identity in the toolbar’s actions', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')

    const create = await screen.findByRole('button', { name: /New Machine Identity/i })
    expect(create.closest('.filter-bar-actions')).toBeTruthy()
    expect(create.className).toContain('btn-primary')
  })

  it('draws a token count that opens something as a count-link, with no pill inside', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServiceTokens.mockResolvedValue(new Map([[
      MCP_PRINCIPAL.principal_id,
      [{ jti: 'a', issued_at: '2026-09-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' }],
    ]]))
    await renderTab('Machine identities')

    const tokens = await screen.findByRole('button', { name: '1 active' })
    expect(tokens.className).toBe('count-link')
    expect(tokens.querySelector('.badge, .section-count')).toBeNull()
  })

  it('puts row actions in a right-aligned Actions column at btn-sm, with Withdraw as the danger action', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    await renderTab('Machine identities')

    await screen.findByRole('button', { name: /Issue Token/i })
    expect(within(card()).getByRole('columnheader', { name: 'Actions' }).className).toContain('row-actions')
    const row = screen.getByText('MCP read-only client').closest('tr')
    const cell = row.querySelector('td.row-actions')
    expect(cell).toBeTruthy()
    for (const b of cell.querySelectorAll('button')) expect(b.className).toContain('btn-sm')
    const withdraw = within(row).getByRole('button', { name: /^Withdraw$/ })
    expect(withdraw.className).toContain('btn-danger')
    expect(withdraw.className).toContain('btn-danger-reveal')

    fireEvent.click(screen.getByRole('tab', { name: 'Broker credentials' }))
    expect(within(card()).getByRole('columnheader', { name: 'Actions' }).className).toContain('row-actions')
    expect(within(card()).getByRole('button', { name: /Generate/ }).className).toContain('btn-sm')
  })

  it('says loading inside the card while the first read is out, then says none yet', async () => {
    let resolve
    api.listGatewayCredentials.mockReturnValue(new Promise(r => { resolve = r }))
    render(<AccessControlTab showToast={vi.fn()} />)

    // The heading and the card are there; only the list is loading.
    expect(card().textContent).toMatch(/Loading credentials/)
    resolve([])
    await waitFor(() => expect(screen.getByText(/No gateways registered\./)).toBeTruthy())
    expect(screen.getByText(/Gateways page/)).toBeTruthy()
    expect(screen.queryByText(/Gateways tab/)).toBeNull()
  })

  it('tells none registered from none matching', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(card().querySelector('tbody tr')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Filter gateways by credential state'), { target: { value: 'revoked' } })
    expect(screen.getByText('No gateway matches this filter.')).toBeTruthy()
    expect(screen.queryByText(/No gateways registered/)).toBeNull()
  })

  it('says the broker was not read as a state, and keeps the declared roles', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listBrokerInventory.mockRejectedValue(new Error('unreachable'))
    await renderTab('Broker accounts')

    await waitFor(() => expect(screen.getByText('The broker was not read, so its accounts cannot be listed.')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Broker roles' }))
    expect(card().querySelector('.callout-warning')).toBeTruthy()
    expect(card().querySelectorAll('tbody tr')).toHaveLength(5)
  })

  it('names the machine identity as the noun, never a principal or a service identity', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderTab('Machine identities')
    await screen.findByText('MCP read-only client')
    expect(document.body.textContent).not.toMatch(/Database principals|service principal|Service identit|machine principal/i)
  })
})
