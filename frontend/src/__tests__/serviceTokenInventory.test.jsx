import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ServiceTokenInventoryModal } from '../components/modals/ServiceTokenInventoryModal'
import { tokenStatus, tokenStatusLabel, tokenStatusDetail, TOKEN_STATES } from '../utils/serviceIdentities'
import { NO_VALUE, formatDate, formatDateTime } from '../utils/format'
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
    expect(tokenStatusDetail(status, NOW)).toMatch(/refused by the API, i3X, the AAS API and the Factory\+ Directory, and still accepted by Storage and realtime/)
    expect(tokenStatusDetail(status, NOW)).not.toMatch(/edge functions|Studio/)
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
      principalName="Read-only API client"
      status={tokenStatus(mints, NOW, revoked)}
      now={NOW}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      showToast={vi.fn()}
      {...props}
    />
  )

  const rowFor = (jti) => screen.getByText(jti, { selector: 'td' }).closest('tr')
  /** Revoke on the row, then Revoke Token in the dialog it opens. */
  const revokeConfirmed = (jti) => {
    fireEvent.click(within(rowFor(jti)).getByRole('button', { name: /Revoke/i }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Revoke Token' })).getByRole('button', { name: 'Revoke Token' }))
  }

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

    revokeConfirmed('doomed')

    await waitFor(() => expect(api.revokeServiceToken).toHaveBeenCalledWith('doomed'))
    expect(api.revokeServiceToken).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(within(rowFor('doomed')).getByText('REVOKED')).toBeTruthy())
    expect(within(rowFor('doomed')).queryByRole('button', { name: /Revoke/i })).toBeNull()
    // The confirmation closes; the list it was opened over stays.
    expect(screen.queryByRole('dialog', { name: 'Revoke Token' })).toBeNull()
    expect(screen.getByRole('dialog', { name: /Tokens for/ })).toBeInTheDocument()
  })

  /** Per-row, not a dialog banner: several tokens can be revoked in one visit. */
  it('reports a failure against the row it belongs to and leaves the button', async () => {
    api.revokeServiceToken.mockRejectedValue(new Error('insufficient privileges'))
    openWith([mint('stubborn', 10)])

    revokeConfirmed('stubborn')

    await waitFor(() => expect(within(rowFor('stubborn')).getByText(/insufficient privileges/i)).toBeTruthy())
    // Closed, so the row's message can be read.
    expect(screen.queryByRole('dialog', { name: 'Revoke Token' })).toBeNull()
    expect(within(rowFor('stubborn')).getByText('ACTIVE')).toBeTruthy()
    expect(within(rowFor('stubborn')).getByRole('button', { name: /Revoke/i })).toBeTruthy()
  })

  /** Revoking cannot be undone, so it asks first, over the list, as Revoke Approval does. */
  describe('Revoke asks first', () => {
    const issued = formatDate(NOW - 5 * DAY)

    it('names the token as its row does, and says it cannot be undone', () => {
      openWith([mint('a1b2c3', 10)])
      fireEvent.click(within(rowFor('a1b2c3')).getByRole('button', { name: /Revoke/i }))

      const dialog = screen.getByRole('dialog', { name: 'Revoke Token' })
      const question = dialog.querySelector('.modal-lead').textContent.replace(/\s+/g, ' ')
      expect(question).toContain(`Revoke the token a1b2c3, issued ${issued}, for “Read-only API client”?`)
      expect(question).toContain(`until it expires on ${formatDate(NOW + 10 * DAY)}`)
      expect(question).toMatch(/This cannot be undone\.$/)
      expect(within(dialog).getByRole('button', { name: 'Revoke Token' })).toHaveClass('btn-danger')
      expect(api.revokeServiceToken).not.toHaveBeenCalled()
    })

    it('leaves out the issue date when none is recorded', () => {
      openWith([{ ...mint('undated', 10), issued_at: null }])
      fireEvent.click(within(rowFor('undated')).getByRole('button', { name: /Revoke/i }))

      const question = screen.getByRole('dialog', { name: 'Revoke Token' }).querySelector('.modal-lead').textContent
      expect(question.replace(/\s+/g, ' ')).toContain('Revoke the token undated for “Read-only API client”?')
    })

    it('revokes nothing on Cancel, and leaves the list open', () => {
      openWith([mint('kept', 10)])
      fireEvent.click(within(rowFor('kept')).getByRole('button', { name: /Revoke/i }))
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Revoke Token' })).getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByRole('dialog', { name: 'Revoke Token' })).toBeNull()
      expect(screen.getByRole('dialog', { name: /Tokens for/ })).toBeInTheDocument()
      expect(api.revokeServiceToken).not.toHaveBeenCalled()
      expect(within(rowFor('kept')).getByText('ACTIVE')).toBeTruthy()
    })

    it('closes only itself on Escape, handing focus back to the row', () => {
      const onClose = vi.fn()
      openWith([mint('kept', 10)], new Set(), { onClose })
      const button = within(rowFor('kept')).getByRole('button', { name: /Revoke/i })
      button.focus()
      fireEvent.click(button)
      expect(screen.getByRole('dialog', { name: 'Revoke Token' })).toHaveFocus()

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(screen.queryByRole('dialog', { name: 'Revoke Token' })).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
      expect(button).toHaveFocus()
      expect(api.revokeServiceToken).not.toHaveBeenCalled()
    })
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

    revokeConfirmed('one')
    await waitFor(() => expect(api.revokeServiceToken).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Revoke Token' })).toBeNull())
    screen.getByRole('button', { name: /Done/i }).click()
    expect(onChanged).toHaveBeenCalled()
  })

  /** A revoked token is not a deleted one; the scope is stated where the control is offered. */
  it('states what revoking reaches, what it does not, and that it cannot be undone', () => {
    const { container } = openWith([mint('one', 10)])
    const copy = container.textContent.replace(/\s+/g, ' ')
    expect(copy).toMatch(/Revoking stops a token at the API, i3X, the AAS API and the Factory\+ Directory\. Storage and realtime verify the signature themselves/)
    expect(copy).not.toMatch(/edge functions|Studio/)
    expect(copy).toMatch(/cannot be undone/i)
  })
})

describe('ServiceTokenInventoryModal: sorting by a column (#801)', () => {
  /** Issued `issuedDaysAgo` days before NOW (null: no record of when), expiring `daysAhead` after. */
  const token = (jti, issuedDaysAgo, daysAhead) => ({
    jti,
    issued_at: issuedDaysAgo === null ? null : new Date(NOW - issuedDaysAgo * DAY).toISOString(),
    expires_at: new Date(NOW + daysAhead * DAY).toISOString(),
  })
  // Newest expiry first by default: undated, pulled (revoked), live, lapsed (expired).
  const TOKENS = [token('live', 2, 10), token('lapsed', 40, -1), token('pulled', 20, 30), token('undated', null, 60)]

  const open = () => render(
    <ServiceTokenInventoryModal
      principalName="Read-only API client"
      status={tokenStatus(TOKENS, NOW, new Set(['pulled']))}
      now={NOW}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      showToast={vi.fn()}
    />
  )
  const jtis = () => screen.getAllByRole('row').slice(1).map(r => r.cells[0].textContent)
  const sortBy = (label) => fireEvent.click(screen.getByRole('button', { name: label }))

  it('sorts by when each token was issued, with one of unknown issue last either way', () => {
    open()
    expect(jtis()).toEqual(['undated', 'pulled', 'live', 'lapsed'])

    sortBy('Issued')
    expect(jtis()).toEqual(['lapsed', 'pulled', 'live', 'undated'])
    expect(screen.getByRole('columnheader', { name: 'Issued' })).toHaveAttribute('aria-sort', 'ascending')
    sortBy('Issued')
    expect(jtis()).toEqual(['live', 'pulled', 'lapsed', 'undated'])
    expect(screen.getByRole('columnheader', { name: 'Issued' })).toHaveAttribute('aria-sort', 'descending')
  })

  /** Revoked, then expired, then active; a token revoked in the dialog moves up at once. */
  it('sorts by state, revoked first, and ranks a token revoked here with the revoked', async () => {
    api.revokeServiceToken.mockResolvedValue(1)
    open()

    sortBy('State')
    expect(jtis()).toEqual(['pulled', 'lapsed', 'undated', 'live'])
    fireEvent.click(within(screen.getByText('live').closest('tr')).getByRole('button', { name: /Revoke/i }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Revoke Token' })).getByRole('button', { name: 'Revoke Token' }))
    await waitFor(() => expect(jtis()).toEqual(['pulled', 'live', 'lapsed', 'undated']))
  })

  it('sorts by expiry, soonest first, and leaves the page address alone', () => {
    window.history.replaceState(null, '', '/access-control/identities?sort=-tokens')
    open()

    sortBy('Expires')
    expect(jtis()).toEqual(['lapsed', 'live', 'pulled', 'undated'])
    sortBy('Expires')
    expect(jtis()).toEqual(['undated', 'pulled', 'live', 'lapsed'])
    expect(window.location.pathname + window.location.search).toBe('/access-control/identities?sort=-tokens')
  })
})

describe('ServiceTokenInventoryModal: Last Used (#1028)', () => {
  const HOUR = 3600000
  const CLIENT = 'b0000000-0000-4000-8000-000000000001'
  const INGESTOR = 'b0000000-0000-4000-8000-000000000002'
  /** A live token for `principal`, last used `hoursAgo` hours before NOW (null: never; undefined: unread). */
  const used = (jti, hoursAgo, principal = CLIENT) => ({
    ...mint(jti, 10),
    principal_id: principal,
    lastUsedAt: hoursAgo === undefined ? undefined
      : hoursAgo === null ? null : new Date(NOW - hoursAgo * HOUR).toISOString(),
  })
  const TOKENS = [used('recent', 1), used('idle', null), used('daemon', null, INGESTOR),
    used('unread', undefined), used('old', 300)]

  const open = (tokens = TOKENS) => render(
    <ServiceTokenInventoryModal
      principalName="Read-only API client"
      status={tokenStatus(tokens, NOW)}
      now={NOW}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      showToast={vi.fn()}
    />
  )
  const lastUsedOf = (jti) => {
    const row = screen.getByText(jti).closest('tr')
    const column = screen.getAllByRole('columnheader').findIndex(h => /Last Used/.test(h.textContent))
    return row.cells[column].textContent
  }
  const jtis = () => screen.getAllByRole('row').slice(1).map(r => r.cells[0].textContent)

  it('shows the hour a token was last used, or Never', () => {
    open()
    expect(lastUsedOf('recent')).toBe(formatDateTime(NOW - HOUR))
    expect(lastUsedOf('old')).toBe(formatDateTime(NOW - 300 * HOUR))
    expect(lastUsedOf('idle')).toBe('Never')
  })

  /** Their daemons call the REST API directly, so Never would invite revoking a live key. */
  it('says Not recorded for an identity whose key the deployment holds', () => {
    open()
    expect(lastUsedOf('daemon')).toBe('Not recorded')
  })

  it('does not say Never when the last use could not be read', () => {
    open()
    expect(lastUsedOf('unread')).toBe(NO_VALUE)
  })

  /** Ascending brings the tokens nobody presents to the top; the cells with no answer go last. */
  it('sorts Never and the oldest use first, and the cells with no answer last either way', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Last Used' }))
    expect(jtis().slice(0, 3)).toEqual(['idle', 'old', 'recent'])
    expect(jtis().slice(3).sort()).toEqual(['daemon', 'unread'])
    fireEvent.click(screen.getByRole('button', { name: 'Last Used' }))
    expect(jtis().slice(0, 3)).toEqual(['recent', 'old', 'idle'])
    expect(jtis().slice(3).sort()).toEqual(['daemon', 'unread'])
  })

  it('says in its heading what is and is not recorded, in a few words', async () => {
    open()
    fireEvent.focus(screen.getByRole('button', { name: 'What Last Used means' }))
    const tip = (await screen.findByRole('tooltip')).textContent
    expect(tip).toMatch(/last presented this token to the i3X server, to the hour/i)
    expect(tip).toMatch(/Calls straight to the REST API are not recorded/i)
    expect(tip.split(/\s+/).length).toBeLessThanOrEqual(35)
  })
})
