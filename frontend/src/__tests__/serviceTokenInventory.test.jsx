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
   * THE COUNT IS THE POINT OF THIS WHOLE CHANGE, not the button.
   *
   * tokenStatus() exists because reporting fewer credentials than exist UNDERSTATES exposure on
   * the one page whose job is to state it. Once revocation exists the same error is available in
   * the other direction: a badge reading "5 active tokens" when four are withdrawn OVERSTATES it,
   * and an operator acting on that number withdraws things that are already dead.
   */
  it('stops counting a withdrawn token as active', () => {
    const mints = [mint('a', 10), mint('b', 20), mint('c', 30)]
    expect(tokenStatus(mints, NOW).outstanding).toBe(3)

    const status = tokenStatus(mints, NOW, new Set(['a', 'b']))
    expect(status.outstanding).toBe(1)
    expect(status.revoked).toBe(2)
    expect(tokenStatusLabel(status)).toBe('1 active token')
  })

  /**
   * MARKED, NOT DROPPED. "There were three and two are withdrawn" is the useful sentence, and a
   * caller that had filtered them out before calling could not say it -- nor could the dialog list
   * them, which is how an operator confirms a withdrawal actually took.
   */
  it('still returns the withdrawn rows, flagged', () => {
    const status = tokenStatus([mint('a', 10), mint('b', 20)], NOW, new Set(['a']))
    expect(status.rows).toHaveLength(2)
    expect(status.rows.find(r => r.jti === 'a').revoked).toBe(true)
    expect(status.rows.find(r => r.jti === 'b').revoked).toBe(false)
  })

  it('reads as expired when every unexpired token has been withdrawn', () => {
    const status = tokenStatus([mint('a', 10)], NOW, new Set(['a']))
    expect(status.state).toBe(TOKEN_STATES.EXPIRED)
    // A FOURTH STATE WOULD NOT CHANGE WHAT ANYBODY DOES NEXT -- nothing here reaches the API
    // either way -- so the distinction lives in the detail line rather than in the badge.
    expect(tokenStatusDetail(status, NOW)).toMatch(/withdrawn/i)
    // And the scope is still stated, because a withdrawn token is not a dead one everywhere.
    expect(tokenStatusDetail(status, NOW)).toMatch(/storage, realtime/i)
  })

  it('mentions withdrawals alongside a live count, so the smaller number is legible', () => {
    const status = tokenStatus([mint('a', 10), mint('b', 20)], NOW, new Set(['a']))
    expect(tokenStatusDetail(status, NOW)).toMatch(/1 further token has been withdrawn/i)
  })

  /**
   * A Shopfloor_Manager cannot read `revoked_service_tokens`, and RLS returns no rows rather than
   * an error -- so the default must be the pre-0074 reading rather than a page that quietly claims
   * every token is live because it could not see the denylist.
   */
  it('defaults to counting everything unexpired when no denylist is supplied', () => {
    expect(tokenStatus([mint('a', 10), mint('b', 20)], NOW).outstanding).toBe(2)
  })
})

describe('ServiceTokenInventoryModal', () => {
  const openWith = (mints, revoked = new Set(), props = {}) => render(
    <ServiceTokenInventoryModal
      principalName="MCP read-only client"
      status={tokenStatus(mints, NOW, revoked)}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      showToast={vi.fn()}
      {...props}
    />
  )

  const rowFor = (jti) => screen.getByText(jti).closest('tr')

  it('offers Revoke on a live token and not on one already withdrawn', () => {
    openWith([mint('live-one', 10), mint('gone-one', 20)], new Set(['gone-one']))

    expect(within(rowFor('live-one')).getByRole('button', { name: /Revoke/i })).toBeTruthy()
    expect(within(rowFor('gone-one')).queryByRole('button', { name: /Revoke/i })).toBeNull()
    expect(within(rowFor('gone-one')).getByText('WITHDRAWN')).toBeTruthy()
  })

  /**
   * `revoke_service_token()` refuses an expired jti outright rather than recording a withdrawal
   * that changed nothing, so a button here would exist only to produce an error. The signature
   * check already refuses the token everywhere -- including the four services a revocation never
   * reaches -- which is why EXPIRED is shown in preference to WITHDRAWN.
   */
  it('offers no Revoke on an expired token', () => {
    openWith([mint('old-one', -1)])
    expect(within(rowFor('old-one')).queryByRole('button', { name: /Revoke/i })).toBeNull()
    expect(within(rowFor('old-one')).getByText('EXPIRED')).toBeTruthy()
  })

  it('withdraws by jti and marks the row without waiting for a reload', async () => {
    api.revokeServiceToken.mockResolvedValue(1)
    openWith([mint('doomed', 10)])

    within(rowFor('doomed')).getByRole('button', { name: /Revoke/i }).click()

    await waitFor(() => expect(api.revokeServiceToken).toHaveBeenCalledWith('doomed'))
    await waitFor(() => expect(within(rowFor('doomed')).getByText('WITHDRAWN')).toBeTruthy())
    expect(within(rowFor('doomed')).queryByRole('button', { name: /Revoke/i })).toBeNull()
  })

  /**
   * PER-ROW, NOT A DIALOG BANNER. Several tokens can be withdrawn in one visit, and a single error
   * slot would attribute the third failure to whichever row the reader happened to be looking at.
   */
  it('reports a failure against the row it belongs to and leaves the button', async () => {
    api.revokeServiceToken.mockRejectedValue(new Error('insufficient privileges'))
    openWith([mint('stubborn', 10)])

    within(rowFor('stubborn')).getByRole('button', { name: /Revoke/i }).click()

    await waitFor(() => expect(within(rowFor('stubborn')).getByText(/insufficient privileges/i)).toBeTruthy())
    expect(within(rowFor('stubborn')).getByText('ACTIVE')).toBeTruthy()
    expect(within(rowFor('stubborn')).getByRole('button', { name: /Revoke/i })).toBeTruthy()
  })

  /** The dialog is opened to look at least as often as to act; a glance must not refetch. */
  it('reloads the page only when something was actually withdrawn', async () => {
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

  /**
   * A withdrawn token is not a deleted one, and an operator who reads "Revoked" as "gone" stops
   * looking for it. The scope is stated where the control is offered, not only in the row tooltip.
   */
  it('states that withdrawing reaches the API only, and cannot be undone', () => {
    const { container } = openWith([mint('one', 10)])
    const copy = container.textContent.replace(/\s+/g, ' ')
    expect(copy).toMatch(/Storage, realtime, the edge functions and Studio verify the signature independently/i)
    expect(copy).toMatch(/cannot be undone/i)
  })
})
