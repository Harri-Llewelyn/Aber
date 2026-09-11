/**
 * What the platform knows about a gateway's broker credential.
 *
 * The platform cannot see the broker's password file: `gateway-credential-service` is add-only and
 * cannot list. State is derived from what the database recorded: `enrolled_at` (an appliance
 * redeemed a bundle), `credential_revoked_at` (archive or delete rotated it), or a
 * CREDENTIAL_ISSUED row (minted for a host-run gateway through the UI).
 *
 * Credentials exist that none of those record: an account minted on the host by script works while
 * the platform holds no record. That case gets its own state, `unrecorded`, rather than being
 * reported as No credential, which would be a claim about the broker.
 */

/**
 * The states, in the order a reader should think about them. `revoked` outranks everything,
 * including a later issue record: the revocation sweep can clear an optimistic stamp, so a gateway
 * carrying both is one whose issue came first.
 */
export const CREDENTIAL_STATES = {
  REVOKED: 'revoked',
  ISSUED: 'issued',
  AWAITING_ENROLMENT: 'awaiting-enrolment',
  UNRECORDED: 'unrecorded',
};

const LABELS = {
  [CREDENTIAL_STATES.REVOKED]: 'Revoked',
  [CREDENTIAL_STATES.ISSUED]: 'Issued',
  [CREDENTIAL_STATES.AWAITING_ENROLMENT]: 'Bundle outstanding',
  [CREDENTIAL_STATES.UNRECORDED]: 'No platform record',
};

const TONES = {
  [CREDENTIAL_STATES.REVOKED]: 'critical',
  [CREDENTIAL_STATES.ISSUED]: 'ok',
  [CREDENTIAL_STATES.AWAITING_ENROLMENT]: 'pending',
  [CREDENTIAL_STATES.UNRECORDED]: 'unknown',
};

/**
 * `issuedAt` is the latest CREDENTIAL_ISSUED row for this gateway, or null. Passed in so this stays
 * a pure function of two plain values.
 */
export function credentialState(gateway, issuedAt = null) {
  if (!gateway) return CREDENTIAL_STATES.UNRECORDED;

  // Ordered deliberately -- see the note on CREDENTIAL_STATES.
  if (gateway.credential_revoked_at) return CREDENTIAL_STATES.REVOKED;

  // A host-run gateway's only record is the audit row: enroll-gateway refuses it, so `enrolled_at`
  // is NULL by construction.
  if (issuedAt) return CREDENTIAL_STATES.ISSUED;

  if (gateway.enrolled_at) return CREDENTIAL_STATES.ISSUED;

  // Remote and mid-enrolment. PENDING_ENROLLMENT means a bundle was issued and not redeemed;
  // AWAITING_BIRTH means it was redeemed, which `enrolled_at` above already covers.
  if (gateway.deployment === 'remote' && gateway.status === 'PENDING_ENROLLMENT') {
    return CREDENTIAL_STATES.AWAITING_ENROLMENT;
  }

  return CREDENTIAL_STATES.UNRECORDED;
}

export function credentialStateLabel(state) {
  return LABELS[state] || LABELS[CREDENTIAL_STATES.UNRECORDED];
}

export function credentialStateTone(state) {
  return TONES[state] || TONES[CREDENTIAL_STATES.UNRECORDED];
}

/**
 * The sentence under the badge, per state; No platform record is the one an operator will misread.
 */
export function credentialStateExplanation(state, gateway) {
  switch (state) {
    case CREDENTIAL_STATES.REVOKED:
      return 'Rotated to a password nobody holds when this gateway was archived or deleted. '
        + 'It cannot connect until a new credential is issued.';
    case CREDENTIAL_STATES.ISSUED:
      return gateway?.deployment === 'host'
        ? 'Minted through the dashboard and shown once. The password is not recoverable.'
        : 'Minted on the appliance when it redeemed its enrolment bundle. The password never '
          + 'left the device.';
    case CREDENTIAL_STATES.AWAITING_ENROLMENT:
      return 'A bundle has been issued and not yet redeemed. The credential is minted on the '
        + 'appliance at first boot, not here.';
    default:
      return 'The platform has not issued a credential for this gateway. That does not mean the '
        + 'broker holds none — an account minted on the host with '
        + '`scripts/mosquitto-provision-gateway.mjs` is issued outside the dashboard and leaves '
        + 'no record here.';
  }
}

/**
 * Which action, if any, this gateway offers, mirroring GatewaysTab's own conditions: a remote
 * gateway gets a bundle, a host-run one gets a mint, an archived one neither. `deployment` is the
 * axis.
 */
export function credentialAction(gateway) {
  if (!gateway || gateway.is_archived) return null;
  return gateway.deployment === 'host' ? 'mint' : 'bundle';
}
