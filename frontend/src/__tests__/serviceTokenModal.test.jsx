import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ServiceTokenModal } from '../components/modals/ServiceTokenModal'
import { isMintableFromPage, describePrincipal } from '../utils/serviceIdentities'
import { api } from '../api'

vi.mock('../api', () => ({ api: { mintServiceToken: vi.fn() } }))

// The clipboard helper reaches for navigator.clipboard, which jsdom does not provide. What this
// suite is about is the mint flow and what the reveal step says, not whether a copy succeeded.
vi.mock('../components/common/CopyableId', () => ({
  __esModule: true,
  default: () => null,
  copyText: vi.fn().mockResolvedValue(true),
}))

const PRINCIPAL = {
  principal_id: 'b0000000-0000-4000-8000-000000000001',
  permissions: ['telemetry:read'],
  can_sign_in: false,
}

const MINTED = {
  token: 'eyJhbGciOiJIUzI1NiJ9.payload.signature',
  jti: '9be21b85-3df3-407f-9e2d-02ba82ab2d92',
  principal_id: PRINCIPAL.principal_id,
  expires_at: '2026-10-03T12:00:00.000Z',
  audit_row_id: 3512,
  revocation_scope: 'postgrest',
}

beforeEach(() => vi.clearAllMocks())

describe('isMintableFromPage', () => {
  /**
   * The rule that keeps a button off two rows, keyed on the mint command rather than a list of ids:
   * a principal created at runtime must be mintable without editing the frontend, and the two
   * environment-key identities must not be.
   */
  it('admits the MCP principal', () => {
    expect(isMintableFromPage(describePrincipal('b0000000-0000-4000-8000-000000000001'))).toBe(true)
  })

  it('refuses the two identities whose keys live in .env', () => {
    // Their mintCommand is `npm run keys:rotate`, because rotating is what changes what those
    // processes actually present. Minting for them produces a valid token no worker will read.
    expect(isMintableFromPage(describePrincipal('b0000000-0000-4000-8000-000000000002'))).toBe(false)
    expect(isMintableFromPage(describePrincipal('b0000000-0000-4000-8000-000000000003'))).toBe(false)
  })

  it('admits an undocumented principal, which is what create_service_principal() makes', () => {
    expect(isMintableFromPage(describePrincipal('c0000000-0000-4000-8000-000000000009'))).toBe(true)
  })

  it('refuses a principal with no mint command at all rather than throwing', () => {
    expect(isMintableFromPage(null)).toBe(false)
    expect(isMintableFromPage({})).toBe(false)
    expect(isMintableFromPage({ mintCommand: null })).toBe(false)
  })
})

describe('ServiceTokenModal', () => {
  const open = (overrides = {}) => render(
    <ServiceTokenModal
      principal={PRINCIPAL}
      principalName="MCP read-only client"
      onClose={vi.fn()}
      showToast={vi.fn()}
      {...overrides}
    />
  )

  /**
   * The one fact that differs from the broker credential dialog: that modal always replaces, this
   * one adds, so "rotating" here leaves two live credentials.
   */
  it('says a mint adds a credential rather than replacing one', () => {
    const { container } = open()
    // Asserted on the flattened text, because `adds` and `not` are each wrapped in <strong>.
    const copy = container.textContent.replace(/\s+/g, ' ')
    expect(copy).toContain('This adds a credential')
    expect(copy).toContain('does not replace any token this identity already holds')
  })

  it('reveals the token and its jti after minting', async () => {
    api.mintServiceToken.mockResolvedValue(MINTED)
    open()

    screen.getByRole('button', { name: /Issue Token/i }).click()

    await waitFor(() => expect(screen.getByDisplayValue(MINTED.token)).toBeTruthy())
    // THE jti IS SHOWN BECAUSE IT IS THE HANDLE FOR REVOKING THIS TOKEN. Without it, an operator
    // who has closed the dialog has to find the TOKEN_MINTED row in the Audit Trail.
    expect(screen.getByDisplayValue(MINTED.jti)).toBeTruthy()
  })

  it('passes the chosen TTL through, defaulting to 30 days', async () => {
    api.mintServiceToken.mockResolvedValue(MINTED)
    open()

    screen.getByRole('button', { name: /Issue Token/i }).click()
    await waitFor(() => expect(api.mintServiceToken).toHaveBeenCalledWith(PRINCIPAL.principal_id, 30))
  })

  /**
   * The scope is read from the response, not hardcoded: revocation is a PostgREST hook, and
   * storage, realtime, the edge runtime and Studio keep accepting a withdrawn token until it
   * expires.
   */
  it('states that revoking reaches the API only', async () => {
    api.mintServiceToken.mockResolvedValue(MINTED)
    open()

    screen.getByRole('button', { name: /Issue Token/i }).click()
    await waitFor(() => expect(screen.getByText(/verify the signature independently/i)).toBeTruthy())
  })

  /**
   * The step must not advance on failure: the edge function discards a token it could not record,
   * so a failure means no credential exists.
   */
  it('stays on the confirm step when the mint is refused', async () => {
    api.mintServiceToken.mockRejectedValue(new Error('that principal can sign in'))
    open()

    screen.getByRole('button', { name: /Issue Token/i }).click()

    await waitFor(() => expect(screen.getByText(/that principal can sign in/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Issue Token/i })).toBeTruthy()
    expect(screen.queryByDisplayValue(MINTED.token)).toBeNull()
  })
})
