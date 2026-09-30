/**
 * What the platform recorded about a gateway's broker credential, and what the broker says.
 *
 * Two columns, two sources. The platform's record is what the database wrote: `enrolled_at` (an
 * appliance redeemed a bundle), `credential_revoked_at` (archive or delete disabled it), or a
 * CREDENTIAL_ISSUED row (minted for a host-run gateway through the UI). The broker's state is read
 * live from its Dynamic Security plugin (api.listBrokerInventory): whether an account exists and
 * whether it is disabled.
 *
 * The two can disagree, and the page shows both rather than merging them: an account issued on the
 * host by script is `unrecorded` here and Active at the broker, which is exactly the fact an
 * operator wants to see.
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
      return 'Disabled at the broker when this gateway was archived or deleted: its session was '
        + 'dropped and its next connection is refused. Issuing a new credential re-enables it.';
    case CREDENTIAL_STATES.ISSUED:
      return gateway?.deployment === 'host'
        ? 'Minted through the dashboard and shown once. The password is not recoverable.'
        : 'Minted on the appliance when it redeemed its enrolment bundle. The password never '
          + 'left the device.';
    case CREDENTIAL_STATES.AWAITING_ENROLMENT:
      return 'A bundle has been issued and not yet redeemed. The credential is minted on the '
        + 'appliance at first boot, not here.';
    default:
      return 'The platform has not issued a credential for this gateway. The Broker column says '
        + 'whether an account exists anyway — one issued on the host with '
        + '`scripts/mosquitto-provision-gateway.mjs` works and leaves no record here.';
  }
}

/**
 * What the broker says about the account, from the live inventory. `unknown` is the inventory not
 * having been read, which is a fact about this page load and not about the account.
 */
export const BROKER_STATES = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
};

/**
 * @param {object|undefined} client  the inventory's entry for this username, if any
 * @param {boolean} inventoryRead    whether the inventory was read at all
 */
export function brokerState(client, inventoryRead) {
  if (!inventoryRead) return BROKER_STATES.UNKNOWN;
  if (!client) return BROKER_STATES.ABSENT;
  return client.disabled ? BROKER_STATES.DISABLED : BROKER_STATES.ACTIVE;
}

const BROKER_LABELS = {
  [BROKER_STATES.ACTIVE]: 'Active',
  [BROKER_STATES.DISABLED]: 'Disabled',
  [BROKER_STATES.ABSENT]: 'No account',
  [BROKER_STATES.UNKNOWN]: 'Not read',
};

const BROKER_TONES = {
  [BROKER_STATES.ACTIVE]: 'ok',
  [BROKER_STATES.DISABLED]: 'critical',
  [BROKER_STATES.ABSENT]: 'neutral',
  [BROKER_STATES.UNKNOWN]: 'unknown',
};

export function brokerStateLabel(state) {
  return BROKER_LABELS[state] || BROKER_LABELS[BROKER_STATES.UNKNOWN];
}

export function brokerStateTone(state) {
  return BROKER_TONES[state] || BROKER_TONES[BROKER_STATES.UNKNOWN];
}

export function brokerStateExplanation(state) {
  switch (state) {
    case BROKER_STATES.ACTIVE:
      return 'The broker holds an enabled account by this name. Whoever has its password can '
        + 'connect and publish under this edge node.';
    case BROKER_STATES.DISABLED:
      return 'The broker holds this account and refuses it. Any session it had was dropped when '
        + 'it was disabled. Issuing a new credential re-enables it.';
    case BROKER_STATES.ABSENT:
      return 'The broker holds no account by this name. Nothing can connect as this gateway '
        + 'until one is issued.';
    default:
      return 'The broker was not read on this page load, so nothing here is known about the '
        + 'account. Refresh, or read the error above.';
  }
}

/**
 * Which credential action, if any, the Access Control page offers this gateway: a remote gateway
 * gets a bundle, a host-run one gets a mint, an archived one neither. `deployment` is the axis.
 */
export function credentialAction(gateway) {
  if (!gateway || gateway.is_archived) return null;
  return gateway.deployment === 'host' ? 'mint' : 'bundle';
}
