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
 * identity at all, which is exactly what roadmap §13 means when it says `Service_Ingestor` "does
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
