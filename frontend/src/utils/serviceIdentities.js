/**
 * The non-human identities that can reach this stack, on both planes.
 *
 * The database plane is `auth.users` rows that cannot sign in, enumerated at runtime by
 * `list_machine_principals()`. The broker plane is `mosquitto.acl`, a file: Mosquitto has no API
 * that lists its principals and `gateway-credential-service` is add-only by design, so the list
 * is declared here and `scripts/check-docs-drift.mjs` asserts the two agree. Nothing holds an
 * identity on both planes.
 */

/**
 * Named principals in `mosquitto.acl`, in the order they appear there. `topics` mirrors the
 * ACL's own lines rather than paraphrasing them.
 */
export const BROKER_PRINCIPALS = [
  {
    username: 'factoryplus_ingestion',
    purpose: 'The ingestion daemon. Reads every Sparkplug topic and is the only principal that may '
      + 'publish a command.',
    topics: [
      'read  spBv1.0/#',
      'write spBv1.0/+/NCMD/+',
      'write ACS-Cymru/Directory/#',
      'read  ACS-Cymru/Directory/#',
      'write uns/#',
      'read  uns/#',
    ],
    // The one principal here that can write, and every write is narrow: NCMD is how a rebirth is
    // requested, `ACS-Cymru/Directory/#` is the Directory's MQTT half (off unless
    // DIRECTORY_MQTT_ENABLED) and `uns/#` is the Unified Namespace (off unless UNS_MQTT_ENABLED).
    // Neither tree is readable by any gateway: the Directory would enumerate the site, and the
    // UNS would hand one credential every machine's readings.
    writes: true,
  },
  {
    username: 'factoryplus_i3x',
    purpose: 'The i3X server. Reads the whole namespace to assemble its address space and publishes '
      + 'nothing.',
    topics: ['read spBv1.0/#', 'read ACS-Cymru/Directory/#'],
    writes: false,
  },
  {
    username: 'factoryplus_monitor',
    purpose: 'The broker metrics exporter. Reads Mosquitto’s own $SYS statistics and never sees '
      + 'telemetry at all.',
    topics: ['read $SYS/#'],
    writes: false,
  },
]

/**
 * The rule every gateway authenticates under. Not a principal, so it is separate rather than a
 * fourth row. `%u` is the connecting username, which is what lets a gateway be created at
 * runtime with no ACL edit.
 */
export const GATEWAY_ACL_PATTERN = {
  pattern: 'readwrite spBv1.0/+/+/%u/#',
  purpose: 'Every gateway, confined to the edge node named by its own username. No ACL edit is '
    + 'needed to add one — only an account.',
}

/**
 * What the dashboard knows about each database principal, keyed by the id a migration pinned
 * (not by role: two principals could hold the same permission for different reasons). A
 * principal with no entry here is still listed; see `describePrincipal()`.
 */
export const KNOWN_PRINCIPALS = {
  'b0000000-0000-4000-8000-000000000001': {
    name: 'MCP read-only client',
    purpose: 'The identity `i3x-mcp` authenticates as. Its token is signed outside GoTrue by '
      + '`scripts/mint-mcp-token.mjs`, because GOTRUE_JWT_EXP is one hour and this one is pasted '
      + 'into a desktop config file.',
    mintedBy: 'scripts/mint-mcp-token.mjs',
    // `{id}` is substituted with the principal's own uuid -- the part an operator would otherwise
    // transcribe by hand, which is the error this column exists to remove.
    mintCommand: 'node scripts/mint-mcp-token.mjs --principal {id}',
  },
  /*
   * The two identities `npm run setup` signs keys for, so what this page says about them is what
   * an operator reads when asking what a key is for. check-docs-drift.mjs (11d) asserts every
   * pinned principal has an entry here.
   */
  'b0000000-0000-4000-8000-000000000002': {
    name: 'Service_Ingestor',
    purpose: 'The ingestion daemon\'s database identity (archived migration 0046). Holds Operator, so it '
      + 'writes nothing directly: every write goes through a SECURITY DEFINER gate in 0047 that '
      + 'checks the caller IS this principal. Its key travels as the Authorization bearer, not as '
      + 'the apikey — the daemon still sends the anon key for the gateway\'s own check.',
    mintedBy: 'scripts/setup.mjs, re-signed by scripts/rotate-service-keys.mjs',
    // Not mint-mcp-token.mjs: that script would sign a valid token for this principal that no
    // worker would ever read, since the daemon takes its key from the environment. Rotation is the
    // only operation that changes what these processes present.
    mintCommand: 'npm run keys:rotate',
  },
  'b0000000-0000-4000-8000-000000000003': {
    name: 'Service_Playback',
    purpose: 'The playback worker\'s database identity (archived migration 0056). A SECOND identity rather '
      + 'than a second use of the first, deliberately: sharing one token between the two would mean '
      + 'a single leaked credential reached both sets of gates. Its narrowness is what makes the '
      + 'storage policy meaningful — it admits this principal for exactly one object, the capture '
      + 'of the job it is currently running.',
    mintedBy: 'scripts/setup.mjs, re-signed by scripts/rotate-service-keys.mjs',
    // Not mint-mcp-token.mjs, for the same reason as the ingestion identity above.
    mintCommand: 'npm run keys:rotate',
  },
}

export function describePrincipal(principalId) {
  return KNOWN_PRINCIPALS[principalId] || {
    name: 'Undocumented principal',
    // Honest rather than blank: an unrecognised machine identity is more interesting than a
    // recognised one. It names both origins (a migration, or a suite's self-seeded fixture) because
    // check-docs-drift.mjs reads the migrations statically and cannot see a row created at runtime.
    purpose: 'No description is recorded in the dashboard for this identity. It was created '
      + 'outside this map — by a migration, or by a test suite that seeded it and did not clean '
      + 'up. Check which one before assuming it is safe: if no migration seeded this id, it is '
      + 'almost certainly a fixture and can be removed.',
    mintedBy: null,
    // The generic mint command is right for an unknown principal: one nobody has documented is most
    // likely one `create_service_principal()` made at runtime, and this is how a token for it is
    // issued.
    mintCommand: 'node scripts/mint-mcp-token.mjs --principal {id}',
  }
}

/** The mint command that signs a token a client will actually present. */
const MCP_MINT_PREFIX = 'node scripts/mint-mcp-token.mjs'

/**
 * Whether the Access Control page should offer to mint a token for this principal.
 *
 * Not every service principal: `Service_Ingestor` and `Service_Playback` take their keys from the
 * environment, so a token minted for either is a valid credential no process reads, and a mint
 * button on their rows would create a second privileged credential that fixes nothing. Keyed on
 * the mint command rather than on a list of ids, so a principal created at runtime is included.
 */
export function isMintableFromPage(meta) {
  return !!meta && typeof meta.mintCommand === 'string'
    && meta.mintCommand.startsWith(MCP_MINT_PREFIX)
}

/**
 * What one permission reaches, in terms of this schema. Keyed on the permission name rather than
 * on a role, because machine identities hold permissions of their own rather than a person's
 * role.
 */
const PERMISSION_REACH = {
  'telemetry:read': 'Read-only across the asset inventory and live telemetry. Cannot read the audit trail.',
  'quarantine:view': 'Can see the onboarding quarantine queue, but cannot approve or reject anything in it.',
  'digital_thread:read': 'Can read the Digital Thread — every attributed change anyone has made to this stack.',
}

export function permissionReach(permissions) {
  if (!permissions || permissions.length === 0) {
    // A principal with no grant still reaches the asset-inventory read policies, which are
    // `TO authenticated USING (true)`; what a grant adds is everything gated on has_authority().
    return 'Holds no permission of its own. It can authenticate, and reaches only what is open to '
      + 'any authenticated caller.'
  }
  return permissions.map(p => PERMISSION_REACH[p] || `Holds ${p}.`).join(' ')
}

/**
 * What tokens are outstanding for a principal, which is not the same as what was last minted.
 *
 * A re-mint does not replace anything, so "the latest mint" would understate the exposure; what
 * matters is how many are unexpired. A revoked token is not outstanding, and counting it would
 * overstate it, so `revokedJtis` is a third argument rather than a filter the caller applies
 * first: the rows are returned, marked, so the page can say "there were five and four are
 * withdrawn". Revocation reaches PostgREST only: storage, realtime, the edge runtime and Studio
 * verify the JWT secret for themselves. The label says "active"; the detail line draws that
 * distinction.
 */
export const TOKEN_STATES = { ACTIVE: 'active', EXPIRED: 'expired', NONE: 'none' }

/**
 * @param {Array}  mints        TOKEN_MINTED rows for one principal
 * @param {number} [now]
 * @param {Set}    [revokedJtis] jtis in `revoked_service_tokens`. Defaults to empty, so a caller
 *                 that cannot read the denylist (a Manager) degrades to reporting every unexpired
 *                 mint as live rather than silently dropping rows.
 */
export function tokenStatus(mints, now = Date.now(), revokedJtis = new Set()) {
  const rows = (mints || [])
    .map(m => ({
      ...m,
      expiresAtMs: Date.parse(m.expires_at),
      // MARKED, NOT DROPPED. The inventory dialog lists these so an operator can see that a
      // withdrawal happened; only the COUNTS below exclude them.
      revoked: !!(m.jti && revokedJtis.has(m.jti)),
    }))
    // A row whose expiry will not parse is DROPPED rather than treated as live: counting it as
    // outstanding would inflate the number an operator acts on, and counting it as expired would
    // hide a credential that may well still work.
    .filter(m => Number.isFinite(m.expiresAtMs))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)

  if (rows.length === 0) return { state: TOKEN_STATES.NONE, outstanding: 0, revoked: 0, rows: [] }

  const revoked = rows.filter(m => m.revoked && m.expiresAtMs > now).length
  const live = rows.filter(m => m.expiresAtMs > now && !m.revoked)

  if (live.length === 0) {
    return {
      // EXPIRED COVERS "ALL WITHDRAWN" TOO, and the detail line distinguishes them. Both mean the
      // same thing to the person reading the badge -- nothing here is reaching the API -- and a
      // fourth state would multiply the tones without changing what anybody does next.
      state: TOKEN_STATES.EXPIRED,
      outstanding: 0,
      revoked,
      lastExpiry: rows[rows.length - 1].expiresAtMs,
      rows,
    }
  }

  return {
    state: TOKEN_STATES.ACTIVE,
    outstanding: live.length,
    revoked,
    // THE EARLIEST, not the latest. It is the next date on which something an operator depends on
    // stops working, which is the one they need in a calendar.
    earliestExpiry: live[0].expiresAtMs,
    rows,
  }
}

const DAY_MS = 86400000

export function tokenStatusLabel(status) {
  if (!status || status.state === TOKEN_STATES.NONE) return 'No token on record'
  if (status.state === TOKEN_STATES.EXPIRED) return 'Expired'
  return status.outstanding === 1 ? '1 active token' : `${status.outstanding} active tokens`
}

export function tokenStatusTone(status) {
  if (!status || status.state === TOKEN_STATES.NONE) return 'unknown'
  if (status.state === TOKEN_STATES.EXPIRED) return 'neutral'
  return 'ok'
}

/** The line under the badge: the date that matters, and which date it is. */
export function tokenStatusDetail(status, now = Date.now()) {
  if (!status || status.state === TOKEN_STATES.NONE) {
    // "Nothing recorded", not "nothing outstanding": the two shipped principals hold keys that
    // `npm run setup` signs before this database exists, so until a rotation neither appears here.
    return 'No token recorded for this identity. That is not the same as none existing: '
      + '`npm run setup` signs the ingestion and playback keys before this database exists, so the '
      + 'first of each is live but unrecorded until `npm run keys:rotate` re-signs it.'
  }
  if (status.state === TOKEN_STATES.EXPIRED) {
    // Withdrawn and lapsed read the same on the badge and must not read the same here: a revoked
    // token is still accepted by storage, realtime, the edge runtime and Studio until its own
    // expiry, which is the fact an operator would act on.
    if (status.revoked > 0) {
      const when = new Date(status.lastExpiry).toLocaleDateString()
      return status.revoked === 1
        ? `Withdrawn. It is refused by the API, and still accepted by storage, realtime and the `
          + `edge functions until it expires on ${when}.`
        : `All ${status.revoked} are withdrawn. They are refused by the API, and still accepted by `
          + `storage, realtime and the edge functions until the last expires on ${when}.`
    }
    return `The last token expired on ${new Date(status.lastExpiry).toLocaleDateString()}.`
  }
  const days = Math.max(0, Math.ceil((status.earliestExpiry - now) / DAY_MS))
  const when = new Date(status.earliestExpiry).toLocaleDateString()
  // Said when it is true: the badge counts only what is still live, and this is the sentence that
  // makes a smaller number legible rather than looking like the page lost track.
  const alsoRevoked = status.revoked > 0
    ? ` ${status.revoked} further token${status.revoked === 1 ? ' has' : 's have'} been withdrawn.`
    : ''
  return (status.outstanding === 1
    // "Revocable", not "revoked": revocation goes through `auth_pre_request()`, which only PostgREST
    // runs, so a withdrawn token still reaches storage, realtime, the edge runtime and Studio.
    ? `Expires ${when} — in ${days} day${days === 1 ? '' : 's'}. Revocable against the API before `
      + 'then; storage, realtime and the edge functions check the signature only.'
    : `Earliest expires ${when} — in ${days} day${days === 1 ? '' : 's'}. Minting again adds a `
      + 'credential rather than replacing one; each is revoked separately, and only against the API.'
  ) + alsoRevoked;
}
