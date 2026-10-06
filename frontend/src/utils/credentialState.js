/**
 * What the platform recorded about a gateway's broker credential, and what the broker says. The
 * platform's record is `enrolled_at` (an appliance enrolled), `credential_revoked_at` (archive or
 * delete disabled the account) or a CREDENTIAL_ISSUED row (issued to a host-run gateway through the
 * UI). The broker's state is read live from its Dynamic Security plugin
 * (api.listBrokerInventory). The two can disagree and both are shown: an account issued by script
 * is `unrecorded` here and Active at the broker.
 */

/** The states, in the order a reader should think about them: `revoked` outranks everything. */
export const CREDENTIAL_STATES = {
  REVOKED: 'revoked',
  ISSUED: 'issued',
  AWAITING_ENROLMENT: 'awaiting-enrolment',
  UNRECORDED: 'unrecorded',
};

const LABELS = {
  [CREDENTIAL_STATES.REVOKED]: 'Revoked',
  [CREDENTIAL_STATES.ISSUED]: 'Issued',
  [CREDENTIAL_STATES.AWAITING_ENROLMENT]: 'Setup outstanding',
  [CREDENTIAL_STATES.UNRECORDED]: 'No platform record',
};

const TONES = {
  [CREDENTIAL_STATES.REVOKED]: 'critical',
  [CREDENTIAL_STATES.ISSUED]: 'ok',
  [CREDENTIAL_STATES.AWAITING_ENROLMENT]: 'pending',
  [CREDENTIAL_STATES.UNRECORDED]: 'unknown',
};

/**
 * `issuedAt` is the latest CREDENTIAL_ISSUED row for this gateway, or null.
 */
export function credentialState(gateway, issuedAt = null) {
  if (!gateway) return CREDENTIAL_STATES.UNRECORDED;

  // Ordered deliberately: a gateway carrying both a revocation and an issue record was issued first.
  if (gateway.credential_revoked_at) return CREDENTIAL_STATES.REVOKED;

  // A host-run gateway's only record is the audit row: enroll-gateway refuses it, so `enrolled_at`
  // is NULL by construction.
  if (issuedAt) return CREDENTIAL_STATES.ISSUED;

  if (gateway.enrolled_at) return CREDENTIAL_STATES.ISSUED;

  // PENDING_ENROLLMENT means setup was issued and not used; AWAITING_BIRTH is covered by `enrolled_at`.
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
        ? 'Issued through the dashboard. An Administrator can show the password again from the '
          + 'gateway’s drawer.'
        : 'Issued to the appliance when it enrolled. The password never passes through a browser.';
    case CREDENTIAL_STATES.AWAITING_ENROLMENT:
      return 'An install command or bundle has been issued and not yet used. The credential is '
        + 'issued to the appliance when it enrols, not here.';
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
 * gets setup, a host-run one gets a credential, an archived one neither.
 */
export function credentialAction(gateway) {
  if (!gateway || gateway.is_archived) return null;
  return gateway.deployment === 'host' ? 'mint' : 'bundle';
}
