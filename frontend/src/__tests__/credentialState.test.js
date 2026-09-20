import { describe, it, expect } from 'vitest'

import {
  CREDENTIAL_STATES,
  credentialAction,
  credentialState,
  credentialStateExplanation,
  credentialStateLabel,
} from '../utils/credentialState'

const remote = (over = {}) => ({ deployment: 'remote', is_archived: false, status: 'OFFLINE', ...over })
const hostRun = (over = {}) => ({ deployment: 'host', is_archived: false, status: 'OFFLINE', ...over })

describe('credentialState', () => {
  /**
   * The state the whole page turns on: a demonstration stack has working credentials issued by
   * `provision-gateways.mjs` with no record of them, because `record_gateway_credential_issued()`
   * cannot be called for a script. Reporting that as "no credential" would be a claim about the
   * broker the frontend cannot make.
   */
  it('reports an unrecorded credential as unrecorded, not as absent', () => {
    const state = credentialState(hostRun(), null)
    expect(state).toBe(CREDENTIAL_STATES.UNRECORDED)
    expect(credentialStateLabel(state)).toBe('No platform record')
    expect(credentialStateExplanation(state, hostRun())).toMatch(/Broker column says whether an account exists/i)
  })

  /**
   * Revoked outranks issued: archiving rotates the account to a password nobody records, so a
   * gateway carrying both is one whose issue came first.
   */
  it('ranks revocation above an earlier issue record', () => {
    const g = remote({
      enrolled_at: '2026-08-01T00:00:00Z',
      credential_revoked_at: '2026-08-20T00:00:00Z'
    })
    expect(credentialState(g, '2026-08-01T00:00:00Z')).toBe(CREDENTIAL_STATES.REVOKED)
  })

  it('reads a Remote gateway from enrolled_at', () => {
    expect(credentialState(remote({ enrolled_at: '2026-08-01T00:00:00Z' }), null))
      .toBe(CREDENTIAL_STATES.ISSUED)
  })

  /**
   * A host-run gateway has no enrolment by construction, so its only record is the audit row;
   * enrolled_at is NULL by design.
   */
  it('reads a host-run gateway from its audit row', () => {
    expect(credentialState(hostRun(), '2026-08-26T00:00:00Z')).toBe(CREDENTIAL_STATES.ISSUED)
    expect(credentialState(hostRun(), null)).toBe(CREDENTIAL_STATES.UNRECORDED)
  })

  /**
   * PENDING_ENROLLMENT means a bundle is out and unredeemed. AWAITING_BIRTH means it was redeemed,
   * so a credential exists on the appliance.
   */
  it('separates a bundle that is outstanding from one already redeemed', () => {
    expect(credentialState(remote({ status: 'PENDING_ENROLLMENT' }), null))
      .toBe(CREDENTIAL_STATES.AWAITING_ENROLMENT)
    expect(credentialState(remote({ status: 'AWAITING_BIRTH', enrolled_at: '2026-08-01T00:00:00Z' }), null))
      .toBe(CREDENTIAL_STATES.ISSUED)
  })

  it('never reports a host-run gateway as awaiting enrolment', () => {
    // It cannot be: issue_gateway_enrollment_token() raises on a host-run gateway, so no bundle
    // for a host-run gateway to be waiting on.
    expect(credentialState(hostRun({ status: 'PENDING_ENROLLMENT' }), null))
      .toBe(CREDENTIAL_STATES.UNRECORDED)
  })
})

describe('credentialAction', () => {
  it('offers a mint for a host-run gateway and a bundle for a Remote one', () => {
    expect(credentialAction(hostRun())).toBe('mint')
    expect(credentialAction(remote())).toBe('bundle')
  })

  /**
   * Nothing is offered on an archived gateway: a bundle downloaded before archiving must not stay
   * redeemable, and the API refuses a direct mint.
   */
  it('offers nothing on an archived gateway, of either kind', () => {
    expect(credentialAction(hostRun({ is_archived: true }))).toBeNull()
    expect(credentialAction(remote({ is_archived: true }))).toBeNull()
  })
})
