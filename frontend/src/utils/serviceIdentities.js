/**
 * The non-human identities that can reach this stack, on both planes.
 *
 * =================================================================================================
 * TWO PLANES, AND THEY ARE NOT THE SAME LIST. That is the fact the Access Control page exists to
 * make visible, and the one most likely to be assumed away:
 *
 *   * THE DATABASE plane is `auth.users` rows that cannot sign in, holding a role. They are
 *     enumerated at runtime by `list_service_principals()` (0042) -- the database is the source of
 *     truth, because a migration can add one.
 *   * THE BROKER plane is `mosquitto.acl`, which is a FILE. Mosquitto has no API that lists its
 *     principals, and `gateway-credential-service` is add-only by design and cannot be given one.
 *     So these are declared here and `scripts/check-docs-drift.mjs` asserts the two agree.
 *
 * Nothing holds an identity on both planes. The ingestion daemon connects to the broker as
 * `factoryplus_ingestion` and reaches the database with the service-role key -- which is not an
 * identity at all, which is exactly what Machine Identities in supabase/README.md means when it says `Service_Ingestor` "does
 * not describe the current daemon".
 *
 * =================================================================================================
 * WHY THE BROKER LIST IS DECLARED IN THE FRONTEND RATHER THAN FETCHED
 *
 * There is nowhere to fetch it from. The ACL is mounted read-only into the broker container and is
 * never parsed by anything that has an HTTP surface. The alternatives were considered:
 *
 *   * A LIST verb on the credential service -- refused by its own header: "it is not a general
 *     credential API and must not become one." It would also hand whoever holds one bearer token
 *     an inventory of every account on the broker.
 *   * Seeding the list into a table -- a second source of truth for a file, and the failure is a
 *     page describing an ACL the broker is not enforcing.
 *
 * So it is a literal, and the drift check is what keeps it honest. Same arrangement the repository
 * already uses where a fact has to exist in two places it cannot be derived between.
 */

/**
 * Named principals in `mosquitto.acl`, in the order they appear there.
 *
 * `topics` mirrors the ACL's own lines rather than paraphrasing them: an operator comparing this
 * page against the file should be reading the same strings.
 */
export const BROKER_PRINCIPALS = [
  {
    username: 'factoryplus_ingestion',
    purpose: 'The ingestion daemon. Reads every Sparkplug topic and is the only principal that may '
      + 'publish a command.',
    topics: ['read  spBv1.0/#', 'write spBv1.0/+/NCMD/+'],
    // The one principal here that can WRITE, and the write is narrow on purpose: NCMD is how a
    // rebirth is requested, which is the only thing the platform tells a device to do.
    writes: true,
  },
  {
    username: 'factoryplus_i3x',
    purpose: 'The i3X server. Reads the whole namespace to assemble its address space and publishes '
      + 'nothing.',
    topics: ['read spBv1.0/#'],
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
 * The rule every GATEWAY authenticates under. Not a principal -- there is no account called this --
 * which is why it is separate rather than a fourth row.
 *
 * `%u` is substituted with the connecting username, so the rule confines each gateway to its own
 * edge-node subtree without the ACL naming any of them. That is the property that lets a gateway be
 * created at runtime: adding one needs a broker ACCOUNT and no ACL edit at all.
 */
export const GATEWAY_ACL_PATTERN = {
  pattern: 'readwrite spBv1.0/+/+/%u/#',
  purpose: 'Every gateway, confined to the edge node named by its own username. No ACL edit is '
    + 'needed to add one — only an account.',
}

/**
 * What the dashboard knows about each DATABASE principal, keyed by the id a migration pinned.
 *
 * KEYED BY ID AND NOT BY ROLE, because the role is what it HOLDS and not what it IS. Two principals
 * could hold Operator for entirely different reasons, and the page would then describe both as the
 * MCP client.
 *
 * A principal with no entry here is still LISTED -- see `describePrincipal()`. Failing to render a
 * row because the dashboard has no blurb for it would hide a credential that can reach the stack,
 * which is the one thing this page must never do.
 */
export const KNOWN_PRINCIPALS = {
  'b0000000-0000-4000-8000-000000000001': {
    name: 'MCP read-only client',
    purpose: 'The identity `i3x-mcp` authenticates as. Its token is signed outside GoTrue by '
      + '`scripts/mint-mcp-token.mjs`, because GOTRUE_JWT_EXP is one hour and this one is pasted '
      + 'into a desktop config file.',
    mintedBy: 'scripts/mint-mcp-token.mjs',
  },
}

/**
 * What a role actually reaches, said in terms of this schema rather than in the abstract.
 *
 * `Operator` vs `Auditor` is the distinction worth spelling out, and 0034 argues it at length: both
 * write nothing, and the difference is that an Auditor can read the Digital Thread. A page that
 * showed only the role name would make the two look interchangeable.
 */
export const ROLE_REACH = {
  Administrator: 'Everything, including onboarding approval and archive retention.',
  Shopfloor_Manager: 'Cells, gateways, devices and schemas. No access-control changes.',
  Operator: 'Read-only across the asset inventory and live telemetry. Cannot read the audit trail.',
  Auditor: 'Read-only, and the only non-privileged role that can read the Digital Thread.',
}

export function describePrincipal(principalId) {
  return KNOWN_PRINCIPALS[principalId] || {
    name: 'Undocumented principal',
    // HONEST RATHER THAN BLANK. An unrecognised machine identity is more interesting than a
    // recognised one, not less, so the row says what it is missing and where to look.
    purpose: 'No description is recorded in the dashboard for this identity. It was created by a '
      + 'migration; check which one seeded this id before assuming it is safe.',
    mintedBy: null,
  }
}

export function roleReach(roles) {
  if (!roles || roles.length === 0) {
    // A principal with NO role reaches nothing through RLS -- every policy names a role -- but it
    // is still a subject a signed JWT can name, so it is worth saying so rather than showing a gap.
    return 'Holds no role, so every RLS policy refuses it. It can authenticate and read nothing.'
  }
  return roles.map(r => ROLE_REACH[r] || `Holds ${r}.`).join(' ')
}

/**
 * What tokens are OUTSTANDING for a principal, which is not the same as what was last minted.
 *
 * =================================================================================================
 * A RE-MINT DOES NOT REPLACE ANYTHING. `scripts/mint-mcp-token.mjs` signs a new JWT; it does not
 * invalidate the previous one, and it could not -- PostgREST validates the signature and consults
 * no table, so the only way to stop a token working is to let it expire or to rotate
 * SUPABASE_JWT_SECRET, which invalidates every token in the stack including the anon key.
 *
 * So "the latest mint" is the wrong question and would UNDERSTATE the exposure: two mints a week
 * apart are two live credentials, and reading only the newer one reports half of what is out
 * there. What matters is how many are unexpired, and when the first of them lapses.
 * =================================================================================================
 */
export const TOKEN_STATES = { ACTIVE: 'active', EXPIRED: 'expired', NONE: 'none' }

export function tokenStatus(mints, now = Date.now()) {
  const rows = (mints || [])
    .map(m => ({ ...m, expiresAtMs: Date.parse(m.expires_at) }))
    // A row whose expiry will not parse is DROPPED rather than treated as live: counting it as
    // outstanding would inflate the number an operator acts on, and counting it as expired would
    // hide a credential that may well still work.
    .filter(m => Number.isFinite(m.expiresAtMs))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)

  if (rows.length === 0) return { state: TOKEN_STATES.NONE, outstanding: 0, rows: [] }

  const live = rows.filter(m => m.expiresAtMs > now)
  if (live.length === 0) {
    return {
      state: TOKEN_STATES.EXPIRED,
      outstanding: 0,
      lastExpiry: rows[rows.length - 1].expiresAtMs,
      rows,
    }
  }

  return {
    state: TOKEN_STATES.ACTIVE,
    outstanding: live.length,
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
    return 'Nothing has been minted for this identity through scripts/mint-mcp-token.mjs. A token '
      + 'issued before that script recorded its issues would not appear here.'
  }
  if (status.state === TOKEN_STATES.EXPIRED) {
    return `The last token expired on ${new Date(status.lastExpiry).toLocaleDateString()}.`
  }
  const days = Math.max(0, Math.ceil((status.earliestExpiry - now) / DAY_MS))
  const when = new Date(status.earliestExpiry).toLocaleDateString()
  return status.outstanding === 1
    ? `Expires ${when} — in ${days} day${days === 1 ? '' : 's'}. It cannot be revoked before then.`
    : `Earliest expires ${when} — in ${days} day${days === 1 ? '' : 's'}. Minting again adds a `
      + 'credential rather than replacing one; none can be revoked before it lapses.';
}
