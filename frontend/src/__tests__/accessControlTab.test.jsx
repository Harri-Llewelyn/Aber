import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { listGatewayCredentials: vi.fn(), listServicePrincipals: vi.fn(), listServiceTokens: vi.fn() }
}))

// The two modals reach for browser APIs this suite has no need to stub; the tab's job is to decide
// WHICH action a row offers, and that is asserted through the buttons rather than through a mount.
vi.mock('../components/modals/GatewayCredentialModal', () => ({
  GatewayCredentialModal: () => <div data-testid="credential-modal" />
}))
vi.mock('../components/modals/GatewayBundleModal', () => ({
  GatewayBundleModal: () => <div data-testid="bundle-modal" />
}))

const provisioned = {
  id: '12000000-0000-4000-8000-000000000001',
  name: 'Sim_Gateway_Cell1_Machining',
  sparkplug_id: 'gwy120000000000400080000',
  is_virtual: true, is_archived: false, status: 'ONLINE',
  enrolled_at: null, credential_revoked_at: null, issued_at: null
}

const enrolled = {
  id: '2a000000-0000-4000-8000-000000000001',
  name: 'Cell 4 Press Line',
  sparkplug_id: 'gwy2a0000000000400080000',
  is_virtual: false, is_archived: false, status: 'ONLINE',
  enrolled_at: '2026-08-01T09:00:00Z', credential_revoked_at: null, issued_at: null
}

const MCP_PRINCIPAL = {
  principal_id: 'b0000000-0000-4000-8000-000000000001',
  roles: ['Operator'],
  created_at: null,
  can_sign_in: false
}

beforeEach(() => {
  vi.clearAllMocks()
  // Defaulted so every credential-inventory test renders the whole page. Individual tests override.
  api.listServicePrincipals.mockResolvedValue([MCP_PRINCIPAL])
  api.listServiceTokens.mockResolvedValue(new Map())
})

describe('AccessControlTab', () => {
  /**
   * THE CASE THE WHOLE PAGE IS DESIGNED AROUND. A demonstration stack has four working credentials
   * issued by `provision-gateways.mjs` and no record of any of them, because
   * record_gateway_credential_issued() cannot be called for a script. The page must say what it
   * actually knows -- that IT has no record -- and must not claim the gateway has no credential.
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
   * THE EXPLANATION IS A PROPERTY OF THE STATE, NOT OF THE ROW, and it must not be rendered as
   * visible text once per row. Four gateways in one state used to produce the same four-line
   * paragraph four times, crowding out the badge and the date -- the only things that vary -- and
   * repeating verbatim a caveat the preamble already makes in red directly above.
   *
   * It briefly became a legend under the table, which was a third copy of the same sentence. It is
   * a tooltip on the badge: reachable from the row, and taking no vertical space at all.
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
   * The two reads have DIFFERENT authority -- credentials accept Shopfloor_Manager, principals are
   * Administrator-only (0042) -- so a refusal on one must not blank the other. Folding them into
   * one error state would blame the whole page for a refusal that applies to one section.
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
      { principal_id: 'c0000000-0000-4000-8000-000000000009', roles: [], created_at: null, can_sign_in: false }
    ])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/Undocumented principal/i)).toBeTruthy())
    expect(screen.getByTitle(/check which one seeded this id/i)).toBeTruthy()
    // No role means every RLS policy refuses it -- said in a COLUMN, not a tooltip, because it is
    // the answer to "what can this reach" rather than background on what it is.
    expect(screen.getByText(/every RLS policy refuses it/i)).toBeTruthy()
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
   * The wire identity and the principal id are the two values on this page an operator retypes
   * somewhere else -- into a broker node's credential pair, and into a token's `sub` claim. A
   * 24-character string transcribed by eye is a client that authenticates and is then refused by
   * something that never says why.
   */
  it('makes both identifiers copyable rather than selectable text', async () => {
    api.listGatewayCredentials.mockResolvedValue([provisioned])
    render(<AccessControlTab showToast={vi.fn()} />)

    // CopyableId renders a button, which is what makes it keyboard-reachable and announced as an
    // action -- a clickable span would be neither.
    await waitFor(() => expect(screen.getByRole('button', { name: /gwy120000000000400080000/ })).toBeTruthy())
    // EXACT, because the mint command in the next column also contains this id -- and a loose
    // matcher that happens to find two buttons is one that would keep passing if the id column
    // were deleted outright.
    // CopyableId's accessible name is `Copy <label> <value>`, so naming the label is what makes
    // this exact rather than a substring that also matches the mint command in the next column.
    expect(screen.getByRole('button', { name: 'Copy principal id b0000000-0000-4000-8000-000000000001' })).toBeTruthy()
  })

  /**
   * MINTING STAYS ON THE HOST (roadmap §13): these tokens cannot be revoked, so issuing one should
   * cost more than a click. What the page removes is the error-prone part -- transcribing a UUID --
   * so the whole command is copyable and carries the principal already in it.
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
   * THE COUNT IS OF OUTSTANDING TOKENS, NOT OF THE LATEST MINT. A re-mint does not invalidate the
   * previous token -- PostgREST validates the signature and consults no table -- so two mints a
   * week apart are two live credentials. Reporting only the newer one would state half the
   * exposure, on the one page whose job is to state all of it.
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
    // The EARLIEST expiry is the one shown: it is the next date on which something stops working.
    expect(screen.getByText(/in 12 days/i)).toBeTruthy()
  })

  it('says a principal has no token on record rather than implying it has none at all', async () => {
    api.listGatewayCredentials.mockResolvedValue([])
    render(<AccessControlTab showToast={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('No token on record')).toBeTruthy())
    // The same distinction the credential column makes: the page reports what it recorded, and a
    // token minted before the script recorded its issues would not appear here.
    expect(screen.getByText(/would not appear here/i)).toBeTruthy()
  })

  /**
   * `digital_thread:read` is a separate permission from listing principals. A caller without it
   * must still see the identities -- blanking the section over a missing history would hide the
   * very thing the page exists to show.
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
