/**
 * What the PLATFORM knows about a gateway's broker credential.
 *
 * =================================================================================================
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT: THE PLATFORM CANNOT SEE THE BROKER'S PASSWORD FILE.
 *
 * Mosquitto's accounts live in a file on the broker, reachable only by `gateway-credential-service`
 * -- which is add-only by design and cannot list or read anything back. Its own header says why:
 * "it is not a general credential API and must not become one." Adding a LIST verb to answer this
 * page's question would be exactly the drift it warns against, and would hand whoever holds one
 * bearer token an inventory of every account on the broker.
 *
 * So this derives credential state from what the DATABASE recorded, and the distinction between
 * those two things is not pedantic -- it is the difference between the page being useful and the
 * page being wrong:
 *
 *   * `enrolled_at`            an appliance redeemed a bundle (0025 / enroll-gateway)
 *   * `credential_revoked_at`  archive or delete rotated it to an unrecorded password (0038)
 *   * a CREDENTIAL_ISSUED row  someone minted one for a virtual gateway through the UI (0041)
 *
 * AND CREDENTIALS EXIST THAT NONE OF THOSE RECORD. `scripts/provision-gateways.mjs` issues one per
 * demonstration gateway by calling `mosquitto-provision-gateway.mjs` directly, and
 * `record_gateway_credential_issued()` cannot be called on its behalf: `has_role()` resolves
 * through `auth.uid()`, which is NULL for the service-role key. That refusal is correct -- the row
 * records a PERSON's act and a script has no person -- but it means a freshly provisioned demo
 * floor has four working accounts the platform has no record of.
 *
 * THAT CASE THEREFORE GETS ITS OWN STATE RATHER THAN BEING FOLDED INTO "none". `unrecorded` says
 * "the platform did not issue one and cannot tell whether the broker holds one", which is true.
 * Reporting it as "No credential" would be a claim about the broker that this code is in no
 * position to make -- and it is the state a new user's whole shopfloor is in.
 * =================================================================================================
 */

/**
 * The states, in the order a reader should think about them.
 *
 * `revoked` OUTRANKS EVERYTHING, including a later issue record. 0038 rotates the account to a
 * password nobody records, and its sweep can clear an optimistic stamp -- so a gateway carrying
 * both a revocation and an issue is one whose issue came first. Ordering the checks the other way
 * would show a decommissioned gateway as credentialled.
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
 * `issuedAt` is the LATEST CREDENTIAL_ISSUED row for this gateway, or null.
 *
 * Passed in rather than looked up here so this stays a pure function of two plain values -- the
 * same shape as gatewayStatus.js, and the reason both are testable without a database.
 */
export function credentialState(gateway, issuedAt = null) {
  if (!gateway) return CREDENTIAL_STATES.UNRECORDED;

  // Ordered deliberately -- see the note on CREDENTIAL_STATES.
  if (gateway.credential_revoked_at) return CREDENTIAL_STATES.REVOKED;

  // A HOST-RUN GATEWAY'S ONLY RECORD IS THE AUDIT ROW. It has no enrolment: `enrolled_at` is set
  // by enroll-gateway, which refuses a host-run gateway outright, so reading it here would be
  // reading a column that is NULL by construction and calling the result an answer.
  if (issuedAt) return CREDENTIAL_STATES.ISSUED;

  if (gateway.enrolled_at) return CREDENTIAL_STATES.ISSUED;

  // REMOTE AND MID-ENROLMENT. `PENDING_ENROLLMENT` means a bundle was issued and not yet
  // redeemed; `AWAITING_BIRTH` means it WAS redeemed -- a credential exists -- but the appliance
  // has not published. The second is covered by `enrolled_at` above, so only the first lands here.
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
 * The sentence under the badge. Written per state because a legend at the top of a table is read
 * once and then scrolled past, and "No platform record" is the one an operator will misread.
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
        + 'broker holds none — accounts created by `npm run provision:gateways` are issued '
        + 'outside the dashboard and leave no record here.';
  }
}

/**
 * Which action, if any, this gateway offers.
 *
 * MIRRORS GatewaysTab's own conditions rather than inventing a second set, because two predicates
 * deciding one question is how a page ends up offering a button the API then refuses. A REMOTE
 * gateway gets a bundle, because the credential is minted on the appliance; a HOST-RUN one gets a
 * mint, because there is no appliance to mint it on; an archived one gets neither, which is 0041's
 * refusal and 0037's reason.
 *
 * This read `is_virtual` until roadmap 15 retired it. The question was always about where the
 * connector runs -- `authorize_virtual_gateway_credential()` and `issue_gateway_enrollment_token()`
 * are mirror images of each other on exactly that axis -- and `deployment` is that question with
 * one meaning instead of three.
 */
export function credentialAction(gateway) {
  if (!gateway || gateway.is_archived) return null;
  return gateway.deployment === 'host' ? 'mint' : 'bundle';
}
