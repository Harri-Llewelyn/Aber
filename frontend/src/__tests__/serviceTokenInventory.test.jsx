import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ServiceTokenInventoryModal } from '../components/modals/ServiceTokenInventoryModal'
import { tokenStatus, tokenStatusLabel, tokenStatusDetail, TOKEN_STATES } from '../utils/serviceIdentities'
import { api } from '../api'

vi.mock('../api', () => ({ api: { revokeServiceToken: vi.fn() } }))

const DAY = 86400000
const NOW = Date.parse('2026-09-03T12:00:00Z')

const mint = (jti, daysAhead) => ({
  jti,
  issued_at: new Date(NOW - 5 * DAY).toISOString(),
  expires_at: new Date(NOW + daysAhead * DAY).toISOString(),
})

beforeEach(() => vi.clearAllMocks())

describe('tokenStatus with a denylist', () => {
  /**
   * The count is the point: a badge reading "5 active tokens" when four are revoked overstates
   * exposure, and an operator acting on it revokes things that are already dead.
   */
  it('stops counting a revoked token as active', () => {
    const mints = [mint('a', 10), mint('b', 20), mint('c', 30)]
    expect(tokenStatus(mints, NOW).outstanding).toBe(3)

    const status = tokenStatus(mints, NOW, new Set(['a', 'b']))
    expect(status.outstanding).toBe(1)
    expect(status.revoked).toBe(2)
    expect(tokenStatusLabel(status)).toBe('1 active token')
  })

  /**
   * Marked, not dropped: "there were three and two are revoked" is the useful sentence, and the
   * dialog lists them so an operator can confirm a revocation took.
   */
  it('still returns the revoked rows, flagged', () => {
    const status = tokenStatus([mint('a', 10), mint('b', 20)], NOW, new Set(['a']))
    expect(status.rows).toHaveLength(2)
    expect(status.rows.find(r => r.jti === 'a').revoked).toBe(true)
    expect(status.rows.find(r => r.jti === 'b').revoked).toBe(false)
  })

  it('reads as expired when every unexpired token has been revoked', () => {
    const status = tokenStatus([mint('a', 10)], NOW, new Set(['a']))
    expect(status.state).toBe(TOKEN_STATES.EXPIRED)
    // A FOURTH STATE WOULD NOT CHANGE WHAT ANYBODY DOES NEXT -- nothing here reaches the API
    // either way -- so the distinction lives in the detail line rather than in the badge.
    expect(tokenStatusDetail(status, NOW)).toMatch(/revoked/i)
    // And the scope is still stated, because a revoked token is not a dead one everywhere.
    expect(tokenStatusDetail(status, NOW)).toMatch(/storage, realtime/i)
  })

  it('mentions revocations alongside a live count, so the smaller number is legible', () => {
    const status = tokenStatus([mint('a', 10), mint('b', 20)], NOW, new Set(['a']))
    expect(tokenStatusDetail(status, NOW)).toMatch(/1 further token has been revoked/i)
  })

  /**
   * A Shopfloor_Manager cannot read `revoked_service_tokens`, and RLS returns no rows rather than
   * an error, so with no denylist the default counts everything unexpired.
   */
  it('defaults to counting everything unexpired when no denylist is supplied', () => {
    expect(tokenStatus([mint('a', 10), mint('b', 20)], NOW).outstanding).toBe(2)
  })
})

describe('ServiceTokenInventoryModal', () => {
  // THE SAME CLOCK THE STATUS WAS COMPUTED AT. Without it the fixtures are a time bomb: every
  // expiry here is relative to NOW, so once the real date passed it the dialog read every row as
  // expired and offered no Revoke, and four tests began failing on a date rather than on a change.
  const openWith = (mints, revoked = new Set(), props = {}) => render(
    <ServiceTokenInventoryModal
      principalName="MCP read-only client"
      status={tokenStatus(mints, NOW, revoked)}
      now={NOW}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      showToast={vi.fn()}
      {...props}
    />
  )

  const rowFor = (jti) => screen.getByText(jti).closest('tr')

  it('offers Revoke on a live token and not on one already revoked', () => {
    openWith([mint('live-one', 10), mint('gone-one', 20)], new Set(['gone-one']))

    expect(within(rowFor('live-one')).getByRole('button', { name: /Revoke/i })).toBeTruthy()
    expect(within(rowFor('gone-one')).queryByRole('button', { name: /Revoke/i })).toBeNull()
    expect(within(rowFor('gone-one')).getByText('REVOKED')).toBeTruthy()
  })

  /**
   * `revoke_service_token()` refuses an expired jti outright, so a button would exist only to
   * produce an error. EXPIRED is shown in preference to REVOKED because the signature check
   * refuses the token everywhere.
   */
  it('offers no Revoke on an expired token', () => {
    openWith([mint('old-one', -1)])
    expect(within(rowFor('old-one')).queryByRole('button', { name: /Revoke/i })).toBeNull()
    expect(within(rowFor('old-one')).getByText('EXPIRED')).toBeTruthy()
  })

  it('revokes by jti and marks the row without waiting for a reload', async () => {
    api.revokeServiceToken.mockResolvedValue(1)
    openWith([mint('doomed', 10)])

    within(rowFor('doomed')).getByRole('button', { name: /Revoke/i }).click()

    await waitFor(() => expect(api.revokeServiceToken).toHaveBeenCalledWith('doomed'))
    await waitFor(() => expect(within(rowFor('doomed')).getByText('REVOKED')).toBeTruthy())
    expect(within(rowFor('doomed')).queryByRole('button', { name: /Revoke/i })).toBeNull()
  })

  /** Per-row, not a dialog banner: several tokens can be revoked in one visit. */
  it('reports a failure against the row it belongs to and leaves the button', async () => {
    api.revokeServiceToken.mockRejectedValue(new Error('insufficient privileges'))
    openWith([mint('stubborn', 10)])

    within(rowFor('stubborn')).getByRole('button', { name: /Revoke/i }).click()

    await waitFor(() => expect(within(rowFor('stubborn')).getByText(/insufficient privileges/i)).toBeTruthy())
    expect(within(rowFor('stubborn')).getByText('ACTIVE')).toBeTruthy()
    expect(within(rowFor('stubborn')).getByRole('button', { name: /Revoke/i })).toBeTruthy()
  })

  /** The dialog is opened to look at least as often as to act; a glance must not refetch. */
  it('reloads the page only when something was actually revoked', async () => {
    api.revokeServiceToken.mockResolvedValue(1)
    const onChanged = vi.fn()
    const onClose = vi.fn()
    openWith([mint('one', 10)], new Set(), { onChanged, onClose })

    screen.getByRole('button', { name: /Done/i }).click()
    expect(onChanged).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()

    within(rowFor('one')).getByRole('button', { name: /Revoke/i }).click()
    await waitFor(() => expect(api.revokeServiceToken).toHaveBeenCalled())
    screen.getByRole('button', { name: /Done/i }).click()
    expect(onChanged).toHaveBeenCalled()
  })

  /** A revoked token is not a deleted one; the scope is stated where the control is offered. */
  it('states that revoking reaches the API only, and cannot be undone', () => {
    const { container } = openWith([mint('one', 10)])
    const copy = container.textContent.replace(/\s+/g, ' ')
    expect(copy).toMatch(/Storage, realtime, the edge functions and Studio verify the signature independently/i)
    expect(copy).toMatch(/cannot be undone/i)
  })
})
