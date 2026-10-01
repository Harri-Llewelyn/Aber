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

/** The card whose title starts with `title`. */
const cardOf = (title) => screen.getByRole('heading', { name: (name) => name.startsWith(title) }).closest('.card')

/** The page opens on Gateways; the machine identities are the other section. */
async function renderServices() {
  const result = render(<AccessControlTab showToast={vi.fn()} />)
  fireEvent.click(await screen.findByRole('tab', { name: /Services/ }))
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

  /** An account the broker holds that no gateway row claims gets its own section. */
  it('lists a broker account with no gateway row as an orphan', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [
        { username: provisioned.sparkplug_id, roles: ['gateway'], disabled: false },
        { username: 'gwy999999999999999999999', roles: ['gateway'], disabled: false },
        { username: 'aber_ingestion', roles: ['ingestion'], disabled: false },
      ],
      roles: [],
    })
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/Accounts with no gateway/i)).toBeTruthy())
    // The gateway-shaped stray is listed; the platform principal is not an orphan.
    expect(screen.getByRole('button', { name: /gwy999999999999999999999/ })).toBeTruthy()
  })

  /** No orphan section on a healthy stack whose broker holds only known gateways. */
  it('shows no orphan section when every broker account is a known gateway', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [{ username: provisioned.sparkplug_id, roles: ['gateway'], disabled: false }],
      roles: [],
    })
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByText('No platform record').length).toBeGreaterThan(0))
    expect(screen.queryByText(/Accounts with no gateway/i)).toBeNull()
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
    // No summary pills under the table: the filter carries the counts, and the card's count reads
    // "narrowed / total" while a filter is on.
    expect(screen.queryByText(/no record$/)).toBeNull()
    expect(cardOf('Broker credentials').querySelector('.section-count').textContent).toBe('1 / 2')
  })

  it('heads the two action columns Actions', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy())
    expect(screen.queryByRole('columnheader', { name: 'Issue' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Services/ }))
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
    // The refusal is reported where the list would have been, on the Services section.
    fireEvent.click(screen.getByRole('tab', { name: /Services/ }))
    await waitFor(() => expect(screen.getByText(/insufficient privileges/i)).toBeTruthy())
  })

  it('opens on Gateways and keeps the service identities under Services', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(cardOf('Broker credentials')).toBeTruthy())
    expect(screen.queryByText(/^Machine identities/)).toBeNull()
    expect(screen.queryByText(/^Broker roles/)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /Services/ }))
    await waitFor(() => expect(cardOf('Machine identities')).toBeTruthy())
    expect(cardOf('Broker roles')).toBeTruthy()
    expect(screen.queryByText(/^Broker credentials/)).toBeNull()
  })

  /** A declared fixture is named rather than listed as a stray; anything undeclared is the stray. */
  it('names a declared fixture among the accounts with no gateway', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [
        { username: 'gwy110000000000400080000', roles: ['gateway', 'gateway-gwy110000000000400080000'], disabled: false },
        { username: 'gwy999999999999999999999', roles: ['gateway'], disabled: false },
      ],
      roles: [],
    })
    render(<AccessControlTab showToast={vi.fn()} />)

    // The stray is the orphan; the declared fixture is not listed among them.
    await waitFor(() => expect(screen.getByText(/Accounts with no gateway/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /gwy999999999999999999999/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /gwy110000000000400080000/ })).toBeNull()

    // It is a platform account, listed with the others under Services.
    fireEvent.click(screen.getByRole('tab', { name: /Services/ }))
    await waitFor(() => expect(screen.getByText('Broker accounts')).toBeTruthy())
    expect(screen.getByRole('button', { name: /gwy110000000000400080000/ })).toBeTruthy()
    expect(screen.getByText(/Validator test gateway/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /gwy999999999999999999999/ })).toBeNull()
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
    await renderServices()

    await waitFor(() => expect(screen.getByText('Broker accounts')).toBeTruthy())
    // Policy order, not alphabetical: ingestion, monitor, admin.
    const names = screen.getAllByRole('button', { name: /Copy MQTT username/ }).map(b => b.textContent)
    expect(names).toEqual(['aber_ingestion', 'aber_monitor', 'dynsec-admin'])
    // Scoped to the row: the same purpose is printed beside the role in the table beneath.
    const monitorRow = screen.getByRole('button', { name: /aber_monitor/ }).closest('tr')
    expect(within(monitorRow).getByText(/The broker health probes and the metrics exporter/)).toBeTruthy()
    expect(screen.getByText('Disabled')).toBeTruthy()
    expect(screen.queryByText(/Accounts with no gateway/i)).toBeNull()
  })

  /** An unrecognised machine identity is more interesting than a recognised one, so it is listed. */
  it('lists a principal the dashboard has no description for, rather than hiding it', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      { principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: [], created_at: null, can_sign_in: false }
    ])
    await renderServices()

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
    await renderServices()

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
    await renderServices()

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
    await renderServices()

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
    await renderServices()

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
    await renderServices()
    await waitFor(() => expect(screen.getByText('Line 4 OEE report')).toBeTruthy())

    expect(screen.queryByRole('button', { name: /Describe MCP read-only client/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Describe Line 4 OEE report/ }))
    await waitFor(() => expect(screen.getByTestId('describe-modal').textContent).toBe('Line 4 OEE report'))
  })

  it('offers New Machine Identity on the machine identities card', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderServices()
    await waitFor(() => expect(screen.getByRole('button', { name: /New Machine Identity/i })).toBeTruthy())
    // Which plane, on the button itself.
    expect(screen.getByRole('button', { name: /New Machine Identity/i }).title).toMatch(/never the broker/)
  })

  it('withholds New Machine Identity when the principal read was refused', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockRejectedValue(new Error('insufficient privileges to list machine principals'))
    await renderServices()
    await waitFor(() => expect(screen.getByText(/insufficient privileges/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /New Machine Identity/i })).toBeNull()
  })

  /**
   * Create, then straight into the token dialog for the new row, named from the RPC's own return
   * rather than waited for from the reload: the first token is shown once the way every other is.
   */
  it('opens the token dialog for a principal the moment it is created', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderServices()
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
    await renderServices()

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
    await renderServices()

    await waitFor(() => expect(screen.getByText('2 active tokens')).toBeTruthy())
    screen.getByRole('button', { name: /2 active tokens/i }).click()

    // The STATUS is passed rather than recomputed in the dialog, so asserting the row count here
    // asserts that the list and the badge cannot disagree.
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
    await renderServices()

    await waitFor(() => expect(screen.getByText('1 active token')).toBeTruthy())
    expect(screen.queryByText('2 active tokens')).toBeNull()
  })

  /** Nothing to list means nothing to open -- a button onto an empty dialog is worse than a badge. */
  it('leaves the badge inert when no mint is recorded', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderServices()

    await waitFor(() => expect(screen.getByText('No token on record')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /No token on record/i })).toBeNull()
  })

  /**
   * Withdraw sits beside Issue, so the page that hands out credentials also has the control that
   * takes the identity back.
   */
  it('offers Withdraw beside Issue Token for a live identity', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderServices()

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
    await renderServices()

    await waitFor(() => expect(screen.getByText('WITHDRAWN')).toBeTruthy())
    expect(screen.queryByText('REVOKED')).toBeNull()
    expect(screen.queryByRole('button', { name: /Issue Token/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Withdraw$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Reinstate/i })).toBeTruthy()
  })

  it('opens the dialog in the direction the identity needs', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderServices()

    await waitFor(() => expect(screen.getByRole('button', { name: /^Withdraw$/i })).toBeTruthy())
    screen.getByRole('button', { name: /^Withdraw$/i }).click()
    await waitFor(() => expect(screen.getByTestId('identity-modal').textContent)
      .toBe('withdraw:MCP read-only client'))
  })

  it('shows the broker roles and marks which ones can publish', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderServices()

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

  /**
   * With a live inventory the rules come from the broker, verb and topic, not from a literal. The
   * table carries a count; the rules themselves open in the drawer, since one role is nine lines.
   */
  it('counts a role’s live rules in the table and opens them in the drawer', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listBrokerInventory.mockResolvedValue({
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
    })
    await renderServices()

    const monitor = await screen.findByRole('button', { name: '1 rule' })
    expect(screen.getByRole('button', { name: '3 rules' })).toBeTruthy()
    // Not in the table.
    expect(screen.queryByText('$SYS/#')).toBeNull()

    fireEvent.click(monitor)
    const panel = await screen.findByRole('complementary', { name: 'monitor role' })
    expect(within(panel).getByText('$SYS/#')).toBeTruthy()
    expect(within(panel).getByText('subscribe')).toBeTruthy()
    expect(within(panel).getByText('1 account')).toBeTruthy()
  })

  it('reports a role as Not read when the broker was not', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listBrokerInventory.mockRejectedValue(new Error('credential service unreachable'))
    await renderServices()

    await waitFor(() => expect(screen.getAllByText('Not read').length).toBe(5))
    expect(screen.queryByRole('button', { name: /rules?$/ })).toBeNull()
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
    fireEvent.click(screen.getByRole('tab', { name: /Services/ }))
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
    await renderServices()

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
    await renderServices()

    await waitFor(() => expect(screen.getByText('2 active tokens')).toBeTruthy())
    // The earliest expiry is the one reported: the next date on which something stops working. Read
    // off the tooltip; the badge carries the state and the tooltip the detail.
    expect(screen.getByText('2 active tokens').getAttribute('title')).toMatch(/in 12 days/i)
  })

  it('says a principal has no token on record rather than implying it has none at all', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderServices()

    await waitFor(() => expect(screen.getByText('No token on record')).toBeTruthy())
    // An empty cell is a fact about the record, not the credential, stated on the badge's tooltip.
    expect(screen.getByText('No token on record').getAttribute('title'))
      .toMatch(/not the same as none existing/i)
  })

  /**
   * The two environment keys are outstanding on every stack from `npm run setup`, before the
   * database exists, so an unlabelled empty list would read as none.
   */
  it('states the credentials it cannot see, so an empty list is not read as none', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderServices()

    await waitFor(() => expect(screen.getByText(/MCP read-only client/i)).toBeTruthy())
    // On the row: the badge itself says an empty cell is a statement about the record.
    expect(screen.getByText('No token on record').getAttribute('title'))
      .toMatch(/not the same as none existing/i)
    expect(screen.getByText('No token on record').getAttribute('title'))
      .toMatch(/before this database exists/i)
  })

  /**
   * The mint column is per principal: the two keys that live in .env are rotated, never minted,
   * because the daemons read their key from the environment at boot.
   */
  it('offers rotation, not a fresh mint, for the two keys that live in .env', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      { principal_id: 'b0000000-0000-4000-8000-000000000002', permissions: ['telemetry:read'], created_at: null, can_sign_in: false },
      { principal_id: 'b0000000-0000-4000-8000-000000000001', permissions: ['telemetry:read'], created_at: null, can_sign_in: false }
    ])
    await renderServices()

    await waitFor(() => expect(screen.getByText('Service_Ingestor')).toBeTruthy())
    const rowOf = (name) => screen.getByText(name).closest('tr')

    // Asserted on what would be copied, not what is drawn: both rows render the same "Copy Command"
    // label, and the command survives in the accessible name.
    expect(within(rowOf('Service_Ingestor')).getByLabelText(/npm run keys:rotate/)).toBeTruthy()
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
    await renderServices()

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
    await renderServices()

    await waitFor(() => expect(screen.getByText(/MCP read-only client/i)).toBeTruthy())
    expect(screen.getByText('No token on record')).toBeTruthy()
  })

  it('surfaces a failed read rather than rendering an empty inventory', async () => {
    api.listGatewayCredentials.mockRejectedValue(new Error('permission denied for view gateway_status'))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/permission denied/i)).toBeTruthy())
  })
})

/** The house card: header (title, tip, count), a filter bar in the body, the table on the seam. */
describe('AccessControlTab card composition', () => {
  const countOf = (title) => cardOf(title).querySelector('.card-header .section-count').textContent

  it('keeps the credential filter and Refresh in a filter bar inside the card body', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(cardOf('Broker credentials').querySelector('tbody tr')).toBeTruthy())
    const card = cardOf('Broker credentials')
    const bar = card.querySelector('.card-body > .filter-bar')
    expect(bar).toBeTruthy()
    expect(within(bar).getByLabelText('Filter gateways by credential state')).toBeTruthy()
    expect(within(bar).getByRole('button', { name: /Refresh/ })).toBeTruthy()
    // Nothing but the title, its tip and its count in the header.
    expect(card.querySelector('.card-header select')).toBeNull()
    expect(card.querySelector('.card-header .help-tip')).toBeTruthy()
    // The table sits on the body's seam, with no inline margin.
    const wrap = card.querySelector('.card-body + .table-wrap')
    expect(wrap).toBeTruthy()
    expect(wrap.getAttribute('style')).toBeNull()
  })

  it('offers Clear filters only while the credential filter is off Active', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(cardOf('Broker credentials')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter gateways by credential state'), { target: { value: 'issued' } })
    fireEvent.click(screen.getByRole('button', { name: /Clear filters \(1\)/ }))
    expect(screen.getByLabelText('Filter gateways by credential state').value).toBe('active')
  })

  it('shows a count on every card, 0 included', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(countOf('Broker credentials')).toBe('0'))
    fireEvent.click(screen.getByRole('tab', { name: /Services/ }))
    await waitFor(() => expect(countOf('Machine identities')).toBe('0'))
    expect(countOf('Broker accounts')).toBe('0')
    // The five declared roles, whether or not the broker was read.
    expect(countOf('Broker roles')).toBe('5')
  })

  it('counts the orphan card and the machine identities', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listBrokerInventory.mockResolvedValue({
      clients: [{ username: 'gwy999999999999999999999', roles: ['gateway'], disabled: false }],
      roles: [],
    })
    render(<AccessControlTab showToast={vi.fn()} />)
    await waitFor(() => expect(countOf('Accounts with no gateway')).toBe('1'))
    expect(countOf('Broker credentials')).toBe('1')
    fireEvent.click(screen.getByRole('tab', { name: /Services/ }))
    await waitFor(() => expect(countOf('Machine identities')).toBe('1'))
  })

  it('gives every card its description as a tip and none as a paragraph', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    await renderServices()

    for (const title of ['Machine identities', 'Broker accounts', 'Broker roles']) {
      expect(cardOf(title).querySelector('.card-header .help-tip')).toBeTruthy()
    }
    expect(document.querySelector('.page-main .card p')).toBeNull()
  })

  it('draws a count that opens something as a count-link', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServiceTokens.mockResolvedValue(new Map([[
      MCP_PRINCIPAL.principal_id,
      [{ jti: 'a', issued_at: '2026-09-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' }],
    ]]))
    api.listBrokerInventory.mockResolvedValue({
      clients: [],
      roles: [{ rolename: 'monitor', acls: [{ acltype: 'subscribePattern', topic: '$SYS/#', allow: true }] }],
    })
    await renderServices()

    const tokens = await screen.findByRole('button', { name: /1 active token/ })
    expect(tokens.className).toBe('count-link')
    expect(screen.getByRole('button', { name: '1 rule' }).className).toBe('count-link')
  })

  it('puts row actions in a right-aligned Actions column at btn-sm, with Withdraw as the danger action', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    await renderServices()

    await screen.findByRole('button', { name: /Issue Token/i })
    expect(within(cardOf('Machine identities')).getByRole('columnheader', { name: 'Actions' }).className).toContain('row-actions')
    const row = screen.getByText('MCP read-only client').closest('tr')
    const cell = row.querySelector('td.row-actions')
    expect(cell).toBeTruthy()
    for (const b of cell.querySelectorAll('button')) expect(b.className).toContain('btn-sm')
    const withdraw = within(row).getByRole('button', { name: /^Withdraw$/ })
    expect(withdraw.className).toContain('btn-danger')
    expect(withdraw.className).toContain('btn-danger-reveal')

    fireEvent.click(screen.getByRole('tab', { name: /Gateways/ }))
    const credentials = cardOf('Broker credentials')
    expect(within(credentials).getByRole('columnheader', { name: 'Actions' }).className).toContain('row-actions')
    expect(within(credentials).getByRole('button', { name: /Generate/ }).className).toContain('btn-sm')
  })

  it('says loading inside the card while the first read is out, then says none yet', async () => {
    let resolve
    api.listGatewayCredentials.mockReturnValue(new Promise(r => { resolve = r }))
    render(<AccessControlTab showToast={vi.fn()} />)

    // The heading and the card are there; only the list is loading.
    expect(cardOf('Broker credentials').textContent).toMatch(/Loading credentials/)
    resolve([])
    await waitFor(() => expect(screen.getByText(/No gateways registered\./)).toBeTruthy())
    expect(screen.getByText(/Gateways page/)).toBeTruthy()
    expect(screen.queryByText(/Gateways tab/)).toBeNull()
  })

  it('tells none registered from none matching', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(cardOf('Broker credentials')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Filter gateways by credential state'), { target: { value: 'revoked' } })
    expect(screen.getByText('No gateway matches this filter.')).toBeTruthy()
    expect(screen.queryByText(/No gateways registered/)).toBeNull()
  })

  it('says the broker was not read as a state, and keeps the declared roles', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listBrokerInventory.mockRejectedValue(new Error('unreachable'))
    await renderServices()

    await waitFor(() => expect(screen.getByText('The broker was not read, so its accounts cannot be listed.')).toBeTruthy())
    expect(cardOf('Broker roles').querySelector('.callout-warning')).toBeTruthy()
    expect(cardOf('Broker roles').querySelectorAll('tbody tr')).toHaveLength(5)
  })

  it('names the machine identity as the noun, never a principal or a service identity', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    await renderServices()
    await screen.findByText('MCP read-only client')
    expect(document.body.textContent).not.toMatch(/Database principals|service principal|Service identit|machine principal/i)
  })
})
