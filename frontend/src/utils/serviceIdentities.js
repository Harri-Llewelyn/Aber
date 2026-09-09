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
    topics: [
      'read  spBv1.0/#',
      'write spBv1.0/+/NCMD/+',
      'write ACS-Cymru/Directory/#',
      'read  ACS-Cymru/Directory/#',
    ],
    // The one principal here that can WRITE, and both writes are narrow on purpose: NCMD is how a
    // rebirth is requested, which is the only thing the platform tells a device to do, and
    // `ACS-Cymru/Directory/#` is the Directory's MQTT half -- retained documents projected from the
    // enrolment records, off unless DIRECTORY_MQTT_ENABLED says otherwise. Read is granted only to
    // the principals that already hold `spBv1.0/#`, and to no gateway: a gateway is confined to its
    // own edge node precisely so it cannot enumerate the site.
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
    // `{id}` is substituted with the principal's own uuid -- the part an operator would otherwise
    // transcribe by hand, which is the error this column exists to remove.
    mintCommand: 'node scripts/mint-mcp-token.mjs --principal {id}',
  },
  /*
   * THESE TWO WERE MISSING AND RENDERED AS "Undocumented principal", which is the fallback working
   * exactly as designed and telling an operator to go and do archaeology in the migrations. 0046
   * and 0056 each seeded a principal and nothing updated this map -- and nothing COULD notice,
   * because unlike BROKER_PRINCIPALS there was no drift check asserting that the page describes
   * every principal the database returns. There is one now (check-docs-drift.mjs, 11d).
   *
   * They are the two identities `npm run setup` signs keys for, so what this page says about them
   * is what an operator reads when asking "what is this key for" -- see issue #101.
   */
  'b0000000-0000-4000-8000-000000000002': {
    name: 'Service_Ingestor',
    purpose: 'The ingestion daemon\'s database identity (archived migration 0046). Holds Operator, so it '
      + 'writes nothing directly: every write goes through a SECURITY DEFINER gate in 0047 that '
      + 'checks the caller IS this principal. Its key travels as the Authorization bearer, not as '
      + 'the apikey — the daemon still sends the anon key for the gateway\'s own check.',
    mintedBy: 'scripts/setup.mjs, re-signed by scripts/rotate-service-keys.mjs',
    // NOT mint-mcp-token.mjs, AND THAT DISTINCTION IS THE POINT OF THIS FIELD. That script would
    // happily sign a token for this principal -- same subject, same secret, perfectly valid -- and
    // no worker would ever read it. The daemon takes its key from the environment, so the result is
    // a second unrevocable credential for a privileged identity that fixes nothing. Rotation is the
    // only operation that changes what these processes actually present.
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
    // NOT mint-mcp-token.mjs, AND THAT DISTINCTION IS THE POINT OF THIS FIELD. That script would
    // happily sign a token for this principal -- same subject, same secret, perfectly valid -- and
    // no worker would ever read it. The daemon takes its key from the environment, so the result is
    // a second unrevocable credential for a privileged identity that fixes nothing. Rotation is the
    // only operation that changes what these processes actually present.
    mintCommand: 'npm run keys:rotate',
  },
}

/**
 * What a role actually reaches, said in terms of this schema rather than in the abstract.
 *
 * `Operator` vs `Auditor` is the distinction worth spelling out, and 0034 argues it at length: both
 * write nothing, and the difference is that an Auditor can read the Digital Thread. A page that
 * showed only the role name would make the two look interchangeable.
 */
// ROLE_REACH LIVED HERE AND HAS GONE WITH ITS ONLY CALLER. It described what each of the four human
// roles reaches, and this file's single consumer -- the Service Identities table -- stopped asking:
// 0080 gave machine principals permissions of their own, so the column now renders PERMISSION_REACH
// below. The human roles are described where a person meets them, on the Roles card of the same
// page, and a second copy here was a mirror nothing compared.

export function describePrincipal(principalId) {
  return KNOWN_PRINCIPALS[principalId] || {
    name: 'Undocumented principal',
    // HONEST RATHER THAN BLANK. An unrecognised machine identity is more interesting than a
    // recognised one, not less, so the row says what it is missing and where to look.
    //
    // "A MIGRATION" WAS TOO NARROW, AND THE NARROWNESS SENT PEOPLE THE WRONG WAY. It used to say
    // the identity "was created by a migration; check which one seeded this id" -- confident, and
    // wrong for the case that actually turns up. Four principals were found on a running stack
    // that no migration will ever account for: RLS suites self-seed `auth.users` rows so they do
    // not depend on seed.sql, commit them so the fixture is visible to their own connections, and
    // (until this was fixed) never removed them. An operator following the old sentence would
    // grep the migrations, find nothing, and be left with less confidence than before.
    //
    // check-docs-drift.mjs cannot close this the way it closes BROKER_PRINCIPALS: it reads the
    // migrations statically, and a row created at test runtime is not in them. So the wording is
    // the control here, and it names both origins rather than guessing between them.
    purpose: 'No description is recorded in the dashboard for this identity. It was created '
      + 'outside this map — by a migration, or by a test suite that seeded it and did not clean '
      + 'up. Check which one before assuming it is safe: if no migration seeded this id, it is '
      + 'almost certainly a fixture and can be removed.',
    mintedBy: null,
    // THE GENERIC MINT COMMAND IS RIGHT FOR AN UNKNOWN PRINCIPAL and wrong for the two service
    // keys, which is the whole reason this moved out of the component. A principal nobody has
    // documented is most likely one `create_service_principal()` made at runtime, and
    // mint-mcp-token.mjs is exactly how a token for one of those is issued.
    mintCommand: 'node scripts/mint-mcp-token.mjs --principal {id}',
  }
}

/** The mint command that signs a token a client will actually present. */
const MCP_MINT_PREFIX = 'node scripts/mint-mcp-token.mjs'

/**
 * Whether the Access Control page should offer to mint a token for this principal.
 *
 * =================================================================================================
 * NOT EVERY SERVICE PRINCIPAL, AND THE EXCLUSION IS THE WHOLE REASON THIS FUNCTION EXISTS.
 *
 * `Service_Ingestor` and `Service_Playback` take their keys from the ENVIRONMENT -- the daemon and
 * the playback worker read `SUPABASE_INGESTION_KEY` and `SUPABASE_PLAYBACK_KEY` at boot. A token
 * minted for either is a perfectly valid credential that no process will ever read, so the mint
 * changes nothing except that another privileged credential now exists. Their `mintCommand` says
 * `npm run keys:rotate` for exactly that reason, and the note beside it in KNOWN_PRINCIPALS spells
 * out why `mint-mcp-token.mjs` is the wrong tool for them.
 *
 * THIS IS THE SAME MISTAKE THE mintCommand COLUMN WAS BUILT TO PREVENT, arriving through a button
 * instead of a copied line. Every row once rendered the MCP command; an operator following the page
 * would mint for the ingestion identity, nothing would change, and the stack would carry a second
 * unrevocable-in-practice credential for a privileged account. A button offered on every row
 * reintroduces that exactly.
 *
 * The retired revocable-tokens roadmap item reaches the same answer from the other direction, under "Worth deciding early":
 * *"Surfacing them read-only and leaving rotation to `npm run keys:rotate` keeps the one control
 * that has a recovery path attached to it."*
 *
 * =================================================================================================
 * KEYED ON THE MINT COMMAND RATHER THAN ON A LIST OF IDS, so a principal
 * `create_service_principal()` creates at runtime is INCLUDED without anybody adding it here. Such
 * a principal falls through to `describePrincipal()`'s default, whose `mintCommand` is the MCP one
 * -- and that default is right about it for the reason recorded there: a principal nobody has
 * documented is most likely one made at runtime, and this is exactly how a token for one is issued.
 */
export function isMintableFromPage(meta) {
  return !!meta && typeof meta.mintCommand === 'string'
    && meta.mintCommand.startsWith(MCP_MINT_PREFIX)
}

/**
 * What one PERMISSION reaches. Keyed on the permission name rather than on a role, because 0080
 * stopped machine identities holding roles at all: `Operator` is a person's role, and every time
 * somebody widened it three of the stack's own processes were widened with it.
 *
 * The Operator line that used to answer for all three principals is preserved almost word for word
 * under `telemetry:read`, because it was always a description of what they actually do rather than
 * of what the role happened to contain.
 */
export const PERMISSION_REACH = {
  'telemetry:read': 'Read-only across the asset inventory and live telemetry. Cannot read the audit trail.',
  'quarantine:view': 'Can see the onboarding quarantine queue, but cannot approve or reject anything in it.',
  'digital_thread:read': 'Can read the Digital Thread — every attributed change anyone has made to this stack.',
}

export function permissionReach(permissions) {
  if (!permissions || permissions.length === 0) {
    // A principal with NO grant reaches nothing it has to be granted -- but saying "reads nothing"
    // would be false and the falsehood is in the reassuring direction. The asset-inventory read
    // policies are `TO authenticated USING (true)`, so a signed token alone reaches them; what a
    // grant adds is everything gated on has_authority(). 0080's header states the same thing from
    // the database's side.
    return 'Holds no permission of its own. It can authenticate, and reaches only what is open to '
      + 'any authenticated caller.'
  }
  return permissions.map(p => PERMISSION_REACH[p] || `Holds ${p}.`).join(' ')
}

/**
 * What tokens are OUTSTANDING for a principal, which is not the same as what was last minted.
 *
 * =================================================================================================
 * A RE-MINT DOES NOT REPLACE ANYTHING. `scripts/mint-mcp-token.mjs` signs a new JWT and does not
 * invalidate the previous one. So "the latest mint" is the wrong question and would UNDERSTATE the
 * exposure: two mints a week apart are two live credentials, and reading only the newer one reports
 * half of what is out there. What matters is how many are unexpired, and when the first of them
 * lapses.
 *
 * THE SECOND HALF OF THIS NOTE USED TO SAY REVOCATION WAS IMPOSSIBLE, AND 0074 MADE THAT FALSE.
 * It read: *"it could not -- PostgREST validates the signature and consults no table, so the only
 * way to stop a token working is to let it expire or to rotate SUPABASE_JWT_SECRET."* That was
 * exactly right until PostgREST was given a `db-pre-request` hook to consult: `auth_pre_request()`
 * now refuses any request whose JWT carries a revoked `jti`, and `revoke_service_token()` is how a
 * jti gets there.
 *
 * A REVOKED TOKEN IS NOT OUTSTANDING, AND COUNTING IT WOULD BREAK THE ONE PROMISE THIS FUNCTION
 * MAKES. The whole reason it counts every unexpired mint rather than the latest is that reporting
 * fewer credentials than exist understates exposure on the one page whose job is to state it. Once
 * `revoke_service_token()` exists, the same error is available in the other direction: a badge
 * reading "5 active tokens" when four have been withdrawn OVERSTATES it, and an operator acting on
 * that number revokes things that are already dead while believing the page.
 *
 * So `revokedJtis` is a THIRD ARGUMENT rather than a filter the caller applies first: the rows are
 * still returned, marked, because "there were five and four are withdrawn" is the useful sentence
 * and a caller that had filtered them out could not say it.
 *
 * WHAT HAS NOT CHANGED IS THE SCOPE. Revocation reaches PostgREST ONLY -- storage, realtime, the
 * edge runtime and Studio each verify the JWT secret for themselves and consult no denylist -- so a
 * revoked token is not gone, it is refused by the API. The label says "active"; the detail line is
 * where that distinction is drawn, because a badge cannot carry it.
 * =================================================================================================
 */
export const TOKEN_STATES = { ACTIVE: 'active', EXPIRED: 'expired', NONE: 'none' }

/**
 * @param {Array}  mints        TOKEN_MINTED rows for one principal
 * @param {number} [now]
 * @param {Set}    [revokedJtis] jtis in `revoked_service_tokens`. Defaults to empty, so a caller
 *                 that cannot read the denylist -- an Auditor can, a Manager cannot -- degrades to
 *                 the pre-0074 reading rather than silently reporting everything as live.
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
    // "NOTHING RECORDED", NOT "NOTHING OUTSTANDING", and the distinction is the whole point of this
    // string. Two of the three principals this stack ships with hold keys that are in use right
    // now -- SUPABASE_INGESTION_KEY and SUPABASE_PLAYBACK_KEY -- and until a rotation happens
    // neither appears here: `npm run setup` signs them before this database exists, so there is
    // nothing to record into. (They used to be unrecordable for a second reason, a ten-year expiry
    // past the ceiling; #101 removed that one, and `npm run keys:rotate` records each re-signing.)
    // So an empty inventory is a statement about the RECORD, and saying otherwise is the defect
    // this wording was rewritten to close.
    //
    // SELF-CONTAINED NOW, because the coverage note under the table is gone. It used to end "see
    // the coverage note below", which was correct while that note existed and would have become a
    // pointer to nothing -- the kind of stale cross-reference a reader cannot tell is stale. The
    // caveat is short enough to carry here, which is what made removing the note reasonable.
    return 'No token recorded for this identity. That is not the same as none existing: '
      + '`npm run setup` signs the ingestion and playback keys before this database exists, so the '
      + 'first of each is live but unrecorded until `npm run keys:rotate` re-signs it.'
  }
  if (status.state === TOKEN_STATES.EXPIRED) {
    // WITHDRAWN AND LAPSED READ THE SAME ON THE BADGE AND MUST NOT READ THE SAME HERE. Both mean
    // nothing is reaching the API, but only one of them was somebody's decision -- and a token
    // that was revoked rather than expired is still accepted by storage, realtime, the edge
    // runtime and Studio until its own expiry, which is the fact an operator would act on.
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
  // SAID WHEN IT IS TRUE, AND NOT OTHERWISE. The badge counts only what is still live, so a
  // principal with one live and four withdrawn reads "1 active token" -- correct, and it hides
  // that four withdrawals happened. This is the sentence that makes the smaller number legible
  // rather than looking like the page lost track of them.
  const alsoRevoked = status.revoked > 0
    ? ` ${status.revoked} further token${status.revoked === 1 ? ' has' : 's have'} been withdrawn.`
    : ''
  return (status.outstanding === 1
    // "REVOCABLE", NOT "CANNOT BE REVOKED", which is what these two lines said until 0074 gave
    // PostgREST a denylist to consult. The qualifier is not padding: revocation goes through
    // `auth_pre_request()`, which only PostgREST runs, so a withdrawn token still reaches storage,
    // realtime, the edge runtime and Studio. Saying "revoked" flat would overstate it in the one
    // direction an operator would act on.
    ? `Expires ${when} — in ${days} day${days === 1 ? '' : 's'}. Revocable against the API before `
      + 'then; storage, realtime and the edge functions check the signature only.'
    : `Earliest expires ${when} — in ${days} day${days === 1 ? '' : 's'}. Minting again adds a `
      + 'credential rather than replacing one; each is revoked separately, and only against the API.'
  ) + alsoRevoked;
}
