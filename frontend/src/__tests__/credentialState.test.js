import { describe, it, expect } from 'vitest'

import {
  CREDENTIAL_STATES,
  credentialAction,
  credentialState,
  credentialStateExplanation,
  credentialStateLabel,
} from '../utils/credentialState'

const physical = (over = {}) => ({ deployment: 'remote', is_archived: false, status: 'OFFLINE', ...over })
const virtual = (over = {}) => ({ deployment: 'host', is_archived: false, status: 'OFFLINE', ...over })

describe('credentialState', () => {
  /**
   * The state the whole page turns on: a demonstration stack has working credentials issued by
   * `provision-gateways.mjs` with no record of them, because `record_gateway_credential_issued()`
   * cannot be called for a script. Reporting that as "no credential" would be a claim about the
   * broker the frontend cannot make.
   */
  it('reports an unrecorded credential as unrecorded, not as absent', () => {
    const state = credentialState(virtual(), null)
    expect(state).toBe(CREDENTIAL_STATES.UNRECORDED)
    expect(credentialStateLabel(state)).toBe('No platform record')
    expect(credentialStateExplanation(state, virtual())).toMatch(/does not mean the broker holds none/i)
  })

  /**
   * Revoked outranks issued: archiving rotates the account to a password nobody records, so a
   * gateway carrying both is one whose issue came first.
   */
  it('ranks revocation above an earlier issue record', () => {
    const g = physical({
      enrolled_at: '2026-08-01T00:00:00Z',
      credential_revoked_at: '2026-08-20T00:00:00Z'
    })
    expect(credentialState(g, '2026-08-01T00:00:00Z')).toBe(CREDENTIAL_STATES.REVOKED)
  })

  it('reads a physical gateway from enrolled_at', () => {
    expect(credentialState(physical({ enrolled_at: '2026-08-01T00:00:00Z' }), null))
      .toBe(CREDENTIAL_STATES.ISSUED)
  })

  /**
   * A virtual gateway has no enrolment by construction, so its only record is the audit row;
   * enrolled_at is NULL by design.
   */
  it('reads a virtual gateway from its audit row', () => {
    expect(credentialState(virtual(), '2026-08-26T00:00:00Z')).toBe(CREDENTIAL_STATES.ISSUED)
    expect(credentialState(virtual(), null)).toBe(CREDENTIAL_STATES.UNRECORDED)
  })

  /**
   * PENDING_ENROLLMENT means a bundle is out and unredeemed. AWAITING_BIRTH means it was redeemed,
   * so a credential exists on the appliance.
   */
  it('separates a bundle that is outstanding from one already redeemed', () => {
    expect(credentialState(physical({ status: 'PENDING_ENROLLMENT' }), null))
      .toBe(CREDENTIAL_STATES.AWAITING_ENROLMENT)
    expect(credentialState(physical({ status: 'AWAITING_BIRTH', enrolled_at: '2026-08-01T00:00:00Z' }), null))
      .toBe(CREDENTIAL_STATES.ISSUED)
  })

  it('never reports a virtual gateway as awaiting enrolment', () => {
    // It cannot be: issue_gateway_enrollment_token() raises on a host-run gateway, so no bundle
    // for a virtual gateway to be waiting on.
    expect(credentialState(virtual({ status: 'PENDING_ENROLLMENT' }), null))
      .toBe(CREDENTIAL_STATES.UNRECORDED)
  })
})

describe('credentialAction', () => {
  it('offers a mint for a virtual gateway and a bundle for a physical one', () => {
    expect(credentialAction(virtual())).toBe('mint')
    expect(credentialAction(physical())).toBe('bundle')
  })

  /**
   * Nothing is offered on an archived gateway: a bundle downloaded before archiving must not stay
   * redeemable, and the API refuses a direct mint.
   */
  it('offers nothing on an archived gateway, of either kind', () => {
    expect(credentialAction(virtual({ is_archived: true }))).toBeNull()
    expect(credentialAction(physical({ is_archived: true }))).toBeNull()
  })
})
