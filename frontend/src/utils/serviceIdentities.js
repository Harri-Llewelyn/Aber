/**
 * The non-human identities that can reach this stack, on both planes.
 *
 * The database plane is `auth.users` rows that cannot sign in, enumerated at runtime by
 * `list_machine_principals()`. The broker plane is read live from the broker's Dynamic Security
 * plugin (api.listBrokerInventory): the accounts, their roles and each role's rules come from the
 * broker at the moment of the read. What the broker cannot say is what a role is FOR, so that is
 * declared here, keyed by role name, and `scripts/check-docs-drift.mjs` asserts the set matches
 * the roles `mosquitto/dynsec-roles.json` declares. Nothing holds an identity on both planes.
 */

/**
 * The platform roles in `mosquitto/dynsec-roles.json`, with the purpose the page shows beside the
 * live rules. `writes` is the fallback for a page rendered without an inventory; with one, it is
 * read off the role's rules.
 */
export const BROKER_PRINCIPALS = [
  {
    role: 'ingestion',
    purpose: 'The ingestion daemon. Reads every Sparkplug topic, is the only principal that may '
      + 'publish a command, and is the only writer of the Directory and the Unified Namespace.',
    // Every write is narrow: NCMD is how a rebirth is requested, `Aber/Directory/#` is the
    // Directory's MQTT half (off unless DIRECTORY_MQTT_ENABLED) and `uns/#` is the Unified
    // Namespace (off unless UNS_MQTT_ENABLED). Neither tree is readable by any gateway: the
    // Directory would enumerate the site, and the UNS would hand one credential every machine's
    // readings.
    writes: true,
  },
  {
    role: 'i3x',
    purpose: 'The i3X server. Reads the whole namespace to assemble its address space and publishes '
      + 'nothing.',
    writes: false,
  },
  {
    role: 'monitor',
    purpose: 'The broker health probes and the metrics exporter. Reads Mosquitto’s own $SYS '
      + 'statistics and never sees telemetry at all.',
    writes: false,
  },
  {
    role: 'admin',
    purpose: 'The credential service. Speaks to the broker’s Dynamic Security plugin to issue, '
      + 'disable and list accounts, and reaches no telemetry topic.',
    writes: true,
  },
]

/**
 * The two roles every gateway account holds. Not a principal, so it is separate rather than a
 * fifth row: the shared role is one account-independent grant, and the per-gateway role is
 * generated from the username when the credential is issued, which is what lets a gateway be
 * created at runtime with no policy edit.
 */
export const GATEWAY_ROLES = {
  shared: 'gateway',
  perGateway: 'gateway-<sparkplug_id>',
  perGatewayTopic: 'spBv1.0/+/+/<sparkplug_id>/#',
  purpose: 'Every gateway. The shared role lets it subscribe across spBv1.0/ and receive the '
    + 'primary host’s STATE topics; its own role confines what it publishes and receives to the '
    + 'edge node named by its username. Both are created when the credential is issued.',
}

/**
 * Gateway-shaped broker accounts that are platform accounts, keyed by username. The validator's
 * fixture holds an ordinary gateway account at a pinned id, created by the boot reconcile from
 * MQTT_VALIDATOR_* rather than issued against a row, so between runs the broker holds it and no
 * gateway claims it. Declared so the Access Control page lists it with the other platform accounts
 * rather than as a stray; a gateway-shaped username not here and not a gateway's is an orphan.
 */
export const FIXTURE_ACCOUNTS = {
  gwy110000000000400080000: {
    name: 'Validator test gateway',
    purpose: 'ingestion/validate.py publishes as this gateway (UUID 11000000-0000-4000-8000-000000000001). '
      + 'The validator seeds the row at the start of a run and deletes it at the end; the account '
      + 'is created at boot from MQTT_VALIDATOR_* so the run can connect. Leave that pair unset '
      + 'on a stack that never runs the validator and no account is created.',
  },
}

export function describeBrokerAccount(username) {
  return FIXTURE_ACCOUNTS[username] || null
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

/** The mint command that signs a token a client will actually present. */
const MCP_MINT_PREFIX = 'node scripts/mint-mcp-token.mjs'

/**
 * What the page knows about one principal: the registry entry for an id a migration pinned, the
 * `machine_principals` row (0125) for one an Administrator created from the page, and an honest
 * fallback for anything else.
 *
 * @param {string} principalId
 * @param {{ name?: string, purpose?: string|null }} [row] the `machine_principals` columns
 *        api.listServicePrincipals() merges onto the RPC row, when there are any
 */
export function describePrincipal(principalId, row) {
  if (KNOWN_PRINCIPALS[principalId]) return KNOWN_PRINCIPALS[principalId]
  if (row?.name) {
    return {
      name: row.name,
      // The Administrator's own words, or a sentence saying none were given: a blank tooltip on a
      // row that exists to explain itself would read as a page that lost the description.
      purpose: row.purpose
        || 'No purpose was recorded when this identity was created from the Access Control page.',
      mintedBy: 'the Access Control page',
      mintCommand: `${MCP_MINT_PREFIX} --principal {id}`,
    }
  }
  return {
    name: 'Undocumented principal',
    // Honest rather than blank: an unrecognised machine identity is more interesting than a
    // recognised one. It names both origins (a migration, or a suite's self-seeded fixture) because
    // check-docs-drift.mjs reads the migrations statically and cannot see a row created at runtime,
    // and since 0125 a principal created from the page always carries a name.
    purpose: 'No description is recorded in the dashboard for this identity. It was created '
      + 'outside this map — by a migration, or by a test suite that seeded it and did not clean '
      + 'up. Check which one before assuming it is safe: if no migration seeded this id, it is '
      + 'almost certainly a fixture and can be removed.',
    mintedBy: null,
    // The generic mint command is right for an unknown principal: one nobody has documented is most
    // likely one `create_machine_principal()` made at runtime, and this is how a token for it is
    // issued.
    mintCommand: `${MCP_MINT_PREFIX} --principal {id}`,
  }
}

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
 * What one permission reaches for a machine, which passes `has_authority()` and never
 * `has_role()`. A line that grants a write says so first. `scripts/check-docs-drift.mjs` (11f)
 * holds each line to the policies and functions that decide it.
 */
const PERMISSION_REACH = {
  'telemetry:read': 'Reads the asset inventory and telemetry. Any identity with a valid token can '
    + 'read both, so this grant records what the identity is for rather than opening anything.',
  'quarantine:view': 'Sees the onboarding quarantine queue, which any identity with a valid token '
    + 'can read. It cannot approve or reject a device: quarantine decisions are made by people.',
  'digital_thread:read': 'Reads the Digital Thread’s asset lane (every attributed change to the '
    + 'shopfloor’s assets, schemas, metrics and proposals) and the record of deleted assets. Not '
    + 'the security lane: credentials, tokens and role changes.',
  'archive:manage': 'Reads the record of assets that were archived and then deleted. Archiving '
    + 'and restoring check a person’s role, so this grants a machine no write.',
  'proposal:create': 'A write. Files change proposals to devices, nameplates, areas, cells and '
    + 'gateways. A person approves or rejects each: machines propose, people decide.',
  'schema:manage': 'A write. Forks a schema into a draft, publishes a draft, which moves every '
    + 'device on the version it replaces onto it, and discards a draft. It cannot edit a schema or '
    + 'the metric catalog directly.',
}

/**
 * The permissions the page offers when creating a principal, in the order the menu lists them:
 * exactly what `create_machine_principal()` allows. `scripts/check-docs-drift.mjs` (11e) asserts
 * the two agree, so a permission added to one side alone fails the build rather than the click.
 */
export const GRANTABLE_PERMISSIONS = Object.keys(PERMISSION_REACH)

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
