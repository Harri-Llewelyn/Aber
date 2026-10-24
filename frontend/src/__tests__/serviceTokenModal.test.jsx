import React from 'react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { ServiceTokenModal } from '../components/modals/ServiceTokenModal'
import { copyText } from '../components/common/CopyableId'
import { isMintableFromPage, describePrincipal } from '../utils/serviceIdentities'
import { api } from '../api'

const HERE = dirname(fileURLToPath(import.meta.url))

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
  it('admits the Read-only API client', () => {
    expect(isMintableFromPage(describePrincipal('b0000000-0000-4000-8000-000000000001'))).toBe(true)
  })

  it('refuses the two identities whose keys are in the release Secret', () => {
    // Their mintCommand is `npm run keys:rotate`, because rotating is what changes what those
    // processes actually present. Minting for them produces a valid token no worker will read.
    expect(isMintableFromPage(describePrincipal('b0000000-0000-4000-8000-000000000002'))).toBe(false)
    expect(isMintableFromPage(describePrincipal('b0000000-0000-4000-8000-000000000003'))).toBe(false)
  })

  it('admits an undocumented principal, which is what create_machine_principal() makes', () => {
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
      principalName="Read-only API client"
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
   * storage, realtime, the edge runtime and Studio keep accepting a revoked token until it
   * expires.
   */
  it('states that revoking reaches the API only', async () => {
    api.mintServiceToken.mockResolvedValue(MINTED)
    open()

    screen.getByRole('button', { name: /Issue Token/i }).click()
    await waitFor(() => expect(screen.getByText(/verify the signature independently/i)).toBeTruthy())
  })

  /** Issue Token, then wait for the reveal step. */
  const mint = async (overrides) => {
    api.mintServiceToken.mockResolvedValue(MINTED)
    const view = open(overrides)
    fireEvent.click(screen.getByRole('button', { name: /Issue Token/i }))
    await waitFor(() => expect(screen.getByDisplayValue(MINTED.token)).toBeTruthy())
    return view
  }

  /** The setup on show, after choosing its client. */
  const setupFor = (client) => {
    fireEvent.click(screen.getByRole('radio', { name: client }))
    return document.querySelector('.token-connect pre').textContent
  }

  describe('Connect', () => {
    beforeEach(() => { globalThis.__ABER_CONFIG__ = { VITE_I3X_URL: 'https://i3x.plant.example/' } })
    afterEach(() => {
      delete globalThis.__ABER_CONFIG__
      vi.unstubAllEnvs()
    })

    /** An identity without telemetry:read sees nothing through i3X, so a setup would mislead. */
    it('shows for an identity with telemetry:read and not for one without', async () => {
      const first = await mint()
      expect(screen.getByRole('group', { name: 'Connect' })).toBeTruthy()
      first.unmount()

      await mint({ principal: { principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: ['proposal:create'] }, principalName: 'Schema sync' })
      expect(screen.queryByRole('group', { name: 'Connect' })).toBeNull()
      expect(screen.queryByText(/i3X/)).toBeNull()
    })

    it('gives the i3X server with /v1 on it, and a bearer token as the authentication', async () => {
      await mint()
      expect(screen.getByLabelText('i3X server').value).toBe('https://i3x.plant.example/v1')
      expect(screen.getByLabelText('Authentication').value).toBe('Bearer token')

      fireEvent.click(screen.getByRole('button', { name: 'Copy i3X server address' }))
      await waitFor(() => expect(copyText).toHaveBeenCalledWith('https://i3x.plant.example/v1'))
    })

    it('puts the minted token and the /v1 address in the setup for every client', async () => {
      await mint()
      for (const client of ['i3X Explorer', 'MCP client', 'curl']) {
        const text = setupFor(client)
        expect(text, client).toContain(MINTED.token)
        expect(text, client).toContain('https://i3x.plant.example/v1')
      }
      expect(setupFor('i3X Explorer')).toMatch(/Authentication\s+Bearer Token/)
      expect(document.body.textContent).toContain('global.corsExtraOrigins')
      // /info answers without a token, so only a request that needs one proves it works.
      expect(setupFor('curl')).toBe(
        `curl -H "Authorization: Bearer ${MINTED.token}" https://i3x.plant.example/v1/objecttypes`
      )
    })

    it('copies the setup on show', async () => {
      await mint()
      const text = setupFor('MCP client')
      fireEvent.click(screen.getByRole('button', { name: /Copy Setup/ }))
      await waitFor(() => expect(copyText).toHaveBeenCalledWith(text))
      await waitFor(() => expect(screen.getByRole('button', { name: /Copied/ })).toBeTruthy())
    })

    /** The block the script prints, so the dialog and `--json` cannot hand out different clients. */
    it('gives the MCP block mint-api-token.mjs --json prints', async () => {
      const script = readFileSync(resolve(HERE, '../../../scripts/mint-api-token.mjs'), 'utf8')
      const pinned = script.match(/'(i3x-mcp@[^']+)'/)?.[1]
      const name = script.match(/mcpServers: \{\s*'([^']+)'/)?.[1]
      expect(pinned).toBeTruthy()

      await mint()
      expect(JSON.parse(setupFor('MCP client'))).toEqual({
        mcpServers: {
          [name]: {
            command: 'npx',
            args: ['-y', pinned],
            env: {
              I3X_BASE_URL: 'https://i3x.plant.example/v1',
              I3X_AUTH_SCHEME: 'bearer',
              I3X_TOKEN: MINTED.token,
            },
          },
        },
      })
    })

    it('says to give the token as a bearer token, and names no variable for it', async () => {
      await mint()
      expect(screen.getByText(/Give it to the client that will present it, as its bearer token/)).toBeTruthy()
      expect(screen.queryByText('I3X_TOKEN')).toBeNull()
    })

    /** A built bundle with no VITE_I3X_URL: an address that goes nowhere is worse than none. */
    it('leaves out the address and every setup when no i3X URL is configured', async () => {
      vi.stubEnv('DEV', false)
      globalThis.__ABER_CONFIG__ = { VITE_I3X_URL: '' }
      await mint()
      expect(screen.getByRole('group', { name: 'Connect' })).toBeTruthy()
      expect(screen.queryByLabelText('i3X server')).toBeNull()
      expect(screen.queryByRole('radio')).toBeNull()
      expect(document.body.textContent).not.toContain('/v1')
      expect(screen.getByLabelText('Authentication').value).toBe('Bearer token')
      expect(screen.getByText(/does not know the site’s i3X server address/)).toBeTruthy()
    })
  })

  it('names Studio among the services a revocation does not reach, before and after the mint', async () => {
    api.mintServiceToken.mockResolvedValue(MINTED)
    open()
    expect(document.body.textContent).toMatch(/edge functions and Studio the expiry is the only limit/)
    screen.getByRole('button', { name: /Issue Token/i }).click()
    await waitFor(() => expect(document.body.textContent).toMatch(/the edge functions and Studio verify the signature/))
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
