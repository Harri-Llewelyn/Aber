import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    listGatewayCredentials: vi.fn(),
    listServicePrincipals: vi.fn(),
    listServiceTokens: vi.fn(),
    listRevokedServiceTokens: vi.fn(),
    revokeServiceToken: vi.fn(),
    listRevokedServicePrincipals: vi.fn(),
    revokeServicePrincipal: vi.fn(),
    reinstateServicePrincipal: vi.fn(),
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
  api.listServicePrincipals.mockResolvedValue([MCP_PRINCIPAL])
  api.listServiceTokens.mockResolvedValue(new Map())
  // Empty by default, which is both the common case and the reading a caller who cannot see the
  // denylist gets. Tests that care about a withdrawal override it.
  api.listRevokedServiceTokens.mockResolvedValue(new Set())
  api.listRevokedServicePrincipals.mockResolvedValue(new Map())
})

describe('AccessControlTab', () => {
  /**
   * The case the page is designed around: a demonstration stack has working credentials issued by
   * `provision-gateways.mjs` and no record of them. The page must say it has no record, not that
   * the gateway has no credential.
   */
  it('reports a script-provisioned gateway as having no platform record, not no credential', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByText('No platform record').length).toBeGreaterThan(0))
    // The meaning lives on the badge's tooltip now rather than in three lines beside it.
    expect(screen.getAllByTitle(/does not mean the broker holds none/i).length).toBe(1)
    expect(screen.queryByText(/^No credential$/i)).toBeNull()
  })

  /** And the page says so before any row is read, not after somebody acts on one. */
  it('states its own limit in the preamble', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/not an inventory of the broker/i)).toBeTruthy()
    })
  })

  it('offers a mint for a virtual gateway and a bundle for a physical one', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned, enrolled])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/Generate/)).toBeTruthy())
    expect(screen.getByText(/Bundle/)).toBeTruthy()
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
    expect(screen.getAllByTitle(/does not mean the broker holds none/i).length).toBe(4)
    expect(screen.queryByText(/does not mean the broker holds none/i)).toBeNull()
  })

  /** Archived gateways are hidden by default and offer no action when shown — 0041 refuses them. */
  it('hides archived gateways until asked, and offers them no action', async () => {
    api.listGatewayCredentials.mockResolvedValue([{ ...provisioned, is_archived: true }])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/No gateways registered/i)).toBeTruthy())
    // The Devices page's "Needs attention" shape: a toggle button carrying its own count, not a
    // checkbox -- which was the only control of its kind in the app and read as a form field.
    screen.getByRole('button', { name: /Archived \(1\)/i }).click()

    await waitFor(() => expect(screen.getByText(/Restore to issue/i)).toBeTruthy())
    expect(screen.queryByText(/Generate/)).toBeNull()
  })

  /**
   * The two reads have different authority (credentials accept Shopfloor_Manager, principals are
   * Administrator-only), so a refusal on one must not blank the other.
   */
  it('still renders the credential inventory when the principal read is refused', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    api.listServicePrincipals.mockRejectedValue(new Error('insufficient privileges to list service principals'))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/insufficient privileges/i)).toBeTruthy())
    expect(screen.getAllByText('No platform record').length).toBeGreaterThan(0)
  })

  /** An unrecognised machine identity is more interesting than a recognised one, so it is listed. */
  it('lists a principal the dashboard has no description for, rather than hiding it', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      { principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: [], created_at: null, can_sign_in: false }
    ])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/Undocumented principal/i)).toBeTruthy())
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
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Service_Ingestor')).toBeTruthy())
    expect(screen.getByText('Service_Playback')).toBeTruthy()
    expect(screen.queryByText(/Undocumented principal/i)).toBeNull()
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
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('MCP read-only client')).toBeTruthy())

    const rowFor = (name) => screen.getByText(name).closest('tr')
    expect(within(rowFor('MCP read-only client')).queryByRole('button', { name: /Issue Token/i })).toBeTruthy()
    expect(within(rowFor('Service_Ingestor')).queryByRole('button', { name: /Issue Token/i })).toBeNull()
    expect(within(rowFor('Service_Playback')).queryByRole('button', { name: /Issue Token/i })).toBeNull()
  })

  /**
   * A principal `create_service_principal()` made at runtime has no entry in KNOWN_PRINCIPALS and
   * must still be mintable, so the button follows describePrincipal()'s fallback rather than a
   * hardcoded list.
   */
  it('offers Issue Token for an undocumented principal, because the fallback mint command is the MCP one', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      { principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: [], created_at: null, can_sign_in: false }
    ])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/Undocumented principal/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Issue Token/i })).toBeTruthy()
  })

  it('opens the token dialog for the principal whose button was pressed', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('MCP read-only client')).toBeTruthy())
    screen.getByRole('button', { name: /Issue Token/i }).click()

    // The NAME is carried into the modal rather than looked up again there, so asserting it here
    // is asserting that the right row opened the dialog.
    await waitFor(() => expect(screen.getByTestId('token-modal').textContent).toBe('MCP read-only client'))
  })

  /**
   * The badge is the way in: a principal has N tokens and `revoke_service_token()` takes one jti,
   * so a row-level Revoke button would have to guess.
   */
  it('opens the token inventory from the count badge, carrying the rows it counted', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServiceTokens.mockResolvedValue(new Map([[
      MCP_PRINCIPAL.principal_id,
      [
        { jti: 'a', issued_at: '2026-09-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' },
        { jti: 'b', issued_at: '2026-09-02T00:00:00Z', expires_at: '2099-02-01T00:00:00Z' }
      ]
    ]]))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('2 active tokens')).toBeTruthy())
    screen.getByRole('button', { name: /2 active tokens/i }).click()

    // The STATUS is passed rather than recomputed in the dialog, so asserting the row count here
    // asserts that the list and the badge cannot disagree.
    await waitFor(() => expect(screen.getByTestId('inventory-modal').textContent)
      .toBe('MCP read-only client:2'))
  })

  /** The count must not include what has been withdrawn. */
  it('excludes a withdrawn token from the active count', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServiceTokens.mockResolvedValue(new Map([[
      MCP_PRINCIPAL.principal_id,
      [
        { jti: 'a', issued_at: '2026-09-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' },
        { jti: 'b', issued_at: '2026-09-02T00:00:00Z', expires_at: '2099-02-01T00:00:00Z' }
      ]
    ]]))
    api.listRevokedServiceTokens.mockResolvedValue(new Set(['a']))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('1 active token')).toBeTruthy())
    expect(screen.queryByText('2 active tokens')).toBeNull()
  })

  /** Nothing to list means nothing to open -- a button onto an empty dialog is worse than a badge. */
  it('leaves the badge inert when no mint is recorded', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('No token on record')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /No token on record/i })).toBeNull()
  })

  /**
   * Withdraw sits beside Issue, so the page that hands out credentials also has the control that
   * takes the identity back.
   */
  it('offers Withdraw beside Issue Token for a live identity', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

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
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('REVOKED')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Issue Token/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Withdraw$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Reinstate/i })).toBeTruthy()
  })

  it('opens the dialog in the direction the identity needs', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole('button', { name: /^Withdraw$/i })).toBeTruthy())
    screen.getByRole('button', { name: /^Withdraw$/i }).click()
    await waitFor(() => expect(screen.getByTestId('identity-modal').textContent)
      .toBe('withdraw:MCP read-only client'))
  })

  it('shows the broker principals and marks which one can publish', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('factoryplus_ingestion')).toBeTruthy())
    expect(screen.getByText('factoryplus_i3x')).toBeTruthy()
    expect(screen.getByText('factoryplus_monitor')).toBeTruthy()
    // Exactly one of the three writes, and it is the daemon.
    expect(screen.getAllByText('CAN PUBLISH').length).toBe(1)
    expect(screen.getAllByText('READ ONLY').length).toBe(2)
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
    // Exact, because the mint command in the next column also contains this id. CopyableId's
    // accessible name is `Copy <label> <value>`, so naming the label makes this exact.
    expect(screen.getByRole('button', { name: 'Copy principal id b0000000-0000-4000-8000-000000000001' })).toBeTruthy()
  })

  /**
   * Minting stays on the host (Machine Identities, supabase/README.md): these tokens cannot be
   * revoked, so issuing one should cost more than a click. The whole command is copyable with the
   * principal already in it.
   */
  it('offers the mint command rather than a mint button', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

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
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('2 active tokens')).toBeTruthy())
    // The earliest expiry is the one reported: the next date on which something stops working. Read
    // off the tooltip; the badge carries the state and the tooltip the detail.
    expect(screen.getByText('2 active tokens').getAttribute('title')).toMatch(/in 12 days/i)
  })

  it('says a principal has no token on record rather than implying it has none at all', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('No token on record')).toBeTruthy())
    // An empty cell is a fact about the record, not the credential, stated on the badge's tooltip.
    expect(screen.getByText('No token on record').getAttribute('title'))
      .toMatch(/not the same as none existing/i)
  })

  /**
   * The coverage note: the two environment keys are outstanding on every stack, and an unlabelled
   * empty list reads as none. They are 90-day keys, so the exclusion is temporary: `npm run setup`
   * signs the first pair before the database exists, and rotating records them.
   */
  it('states the credentials it cannot see, so an empty list is not read as none', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/MCP read-only client/i)).toBeTruthy())
    // On the row, not in a footer: the badge itself says an empty cell is a statement about the
    // record.
    expect(screen.getByText('No token on record').getAttribute('title'))
      .toMatch(/not the same as none existing/i)
    expect(screen.getByText('No token on record').getAttribute('title'))
      .toMatch(/before this database exists/i)
  })

  it('carries no second copy of that caveat under the table', async () => {
    // The footer was removed deliberately: a page this dense should not state the same thing twice,
    // and the row is where it belongs. Pinned so it does not creep back alongside the tooltip.
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/MCP read-only client/i)).toBeTruthy())
    expect(screen.queryByText(/Why a row can show no token/i)).toBeNull()
  })

  /**
   * The note goes away when it stops being true: after a rotation both principals show a recorded
   * token, and a footer saying they cannot appear would contradict the rows above it.
   */
  it('drops the coverage note once every principal has a recorded token', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServicePrincipals.mockResolvedValue([
      { principal_id: 'b0000000-0000-4000-8000-000000000002', permissions: ['telemetry:read'], created_at: null, can_sign_in: false }
    ])
    api.listServiceTokens.mockResolvedValue(new Map([
      ['b0000000-0000-4000-8000-000000000002',
        [{ jti: 'abc', expires_at: new Date(Date.now() + 60 * 86400000).toISOString() }]]
    ]))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Service_Ingestor')).toBeTruthy())
    expect(screen.getByText(/1 active token/i)).toBeTruthy()
    expect(screen.queryByText(/Why a row can show no token/i)).toBeNull()
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
    render(<AccessControlTab showToast={vi.fn()} />)

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
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('MCP read-only client')).toBeTruthy())

    const copy = screen.getByLabelText(/mint-mcp-token\.mjs --principal/)
    expect(copy.className).toMatch(/btn-ghost/)
    expect(copy.className).not.toMatch(/copyable-id/)
  })

  /**
   * `digital_thread:read` is separate from listing principals; a caller without it must still see
   * the identities.
   */
  it('still lists identities when the token history cannot be read', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listServiceTokens.mockRejectedValue(new Error('permission denied for table digital_thread'))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/MCP read-only client/i)).toBeTruthy())
    expect(screen.getByText('No token on record')).toBeTruthy()
  })

  it('surfaces a failed read rather than rendering an empty inventory', async () => {
    api.listGatewayCredentials.mockRejectedValue(new Error('permission denied for view gateway_status'))
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/permission denied/i)).toBeTruthy())
  })
})
