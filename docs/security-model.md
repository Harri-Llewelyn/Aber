# Security model

How Aber protects its data and who may reach what. To report a vulnerability, see
[`SECURITY.md`](../SECURITY.md).

**Aber runs on a site's own network.** It is built for the devices, gateways and people on one
shopfloor network, with every service behind the deployment's internal CA
([`deploy/k8s/internal-ca.yaml`](../deploy/k8s/internal-ca.yaml)). Reaching it from outside that network
is the operator's to arrange, over a VPN they manage. It is not built or supported as an
internet-facing or cloud-hosted service, and public certificates are not a supported configuration.

Fail-closed throughout: edge functions and RLS policies deny by default, and a missing or
unrecognised role produces `403`.

| Layer | Control |
| :--- | :--- |
| **Broker** | `allow_anonymous false`; the Dynamic Security plugin's roles ([`mosquitto/dynsec-roles.json`](../mosquitto/dynsec-roles.json), [`mosquitto/README.md`](../mosquitto/README.md)) confine each gateway to `spBv1.0/+/+/<own-id>/#`, and revocation drops a live session |
| **Ingestion** | Gateway↔device binding; quarantine gating; append-only historian writes — a **grant**, not a promise: the daemon connects as `ingest_writer` (`ingestion.dbUser`, with `secrets.ingestWriterPassword`), which may INSERT and cannot UPDATE, DELETE or TRUNCATE, and it refuses to run as the historian superuser — see [Historian roles](#historian-roles) |
| **Gateway** | Envoy's `apikey` check on `/rest`, `/realtime`, `/storage`, `/functions` — with **four** documented exemptions ([`supabase/README.md`](../supabase/README.md)) |
| **API** | PostgREST JWT verification plus RLS on every table |
| **Database** | `has_role()` reads `user_roles` directly, so revocation is immediate; `audit_trail` is append-only against `service_role` too |
| **Edge functions** | Explicit router allow-list; per-function secret scoping; role resolved from the database, never a stale JWT claim |
| **Edge automation** | Node-RED's editor, admin API and webhook receiver each authenticate separately |
| **Supabase Studio** | Behind the gateway's `studio` listener: an OAuth login against this stack's GoTrue and an `Administrator` check (`0081`). Off the Ingress by default |
| **The forge** | Behind the gateway's `forge` listener: the same login, admitting `Administrator` and `Shopfloor_Manager` (`0094`). Gitea's own HTTP port is reachable only from the gateway and the edge runtime |

**An error tells the caller what to fix, never how the platform is built.** A refusal the caller
can act on says what to change. An edge function that fails unexpectedly answers a fixed sentence
and a request id. The error's own text can name an internal host, a table or a constraint, so it
goes only to the function's log, under that id
([`supabase/functions/README.md`](../supabase/functions/README.md#when-a-function-fails)). PostgREST
is not covered: an RPC's error still carries the database's message.

## Historian roles

The historian is a separate database, and a grant issued in a Supabase migration does not reach it.
Its roles live in [`timescaledb/roles.sql`](../timescaledb/roles.sql), reconciled on **every boot** by
`timescaledb-maintenance` — the same replay-and-reconcile model the migration chain uses, and for
the same reason: `/docker-entrypoint-initdb.d` runs only on an empty data directory.

| Role | May | Used by |
| :--- | :--- | :--- |
| `ingest_writer` | INSERT + SELECT on `telemetry`; upsert `assets` | the ingestion daemon |
| `fdw_reader` | SELECT only, on each object Supabase projects as a foreign table | Supabase's `postgres_fdw` PUBLIC mapping |
| `grafana_reader` | SELECT everything the dashboards query | Grafana |
| `powerbi_reader` | SELECT the three rollups only | external BI |

**`ingest_writer` and `fdw_reader` are required; the two readers are optional.** BI and Grafana are
consumers a stack can simply not have. The daemon and the FDW are not — each must authenticate as
*something* on every query, and the only alternative to these roles is the superuser they replaced.
So `npm run setup` mints both passwords, and the chart fails to render without them. A stack that comes up on the superuser saying nothing is the state this closes.

**The daemon checks its own credential at startup** and refuses to run as a superuser on the
historian, naming `ALLOW_HISTORIAN_SUPERUSER=true` as the deliberate way to say otherwise. Every
other guarantee here is enforced where it can be observed — the broker ACL by delivery, the write
gates by `is_ingestion_caller()`, the audit trail by a trigger. This one used to depend on nobody
having changed a variable, and it was wrong for months without anything noticing.

**An authentication failure is fatal; an unreachable historian is not.** The daemon is built to
survive a database that is down — it warns, drops what it cannot store, and resumes. A refused
credential never resolves by retrying, so it exits instead of running indefinitely discarding every
reading. Those two wore the same clothes until a wrong password was tried on purpose.

**`ingest_writer` needs SELECT, which is not obvious.** Both of the daemon's statements carry an
`ON CONFLICT` clause, and inferring the arbiter index reads the target. So the role is *append-only*
rather than write-only: it can add a row and cannot change or remove one, which is the distinction
the security model above depends on.

**Why `fdw_reader` exists at all.** `0001` maps every local Supabase role onto this database through
`postgres_fdw`. That mapping used the historian's superuser, so an FDW session opened for
`authenticated` ran here with full rights, contained only by the grant on the *other* database. No
application role could abuse it — the point is that nothing stopped the next widened grant or new
foreign table from inheriting that reach silently. The `postgres` mapping is deliberately unchanged:
it is what a human debugging the FDW connects through.

`timescaledb/test_historian_role_grants.py` asserts both halves for both roles — what they can do,
and what they must not.

**Supabase Studio is a database console with no login, roles or session of its own.** Whoever
reaches it holds the SQL editor, the table editor and the Vault UI **as the database owner** — for
whom RLS is not enforced — which is why it sits behind a door rather than a port.

**It has a door, and the gateway is it.** `supabase-envoy` holds a second listener
(`studio.<domain>`, off by default): an OAuth 2.1 authorization-code flow against this stack's own GoTrue,
a session cookie, and an `Administrator` check before anything reaches the console. The Studio
pod publishes nothing of its own.

Three things follow, and none of them is obvious:

- **The role is read from the token, not fetched.** `custom_access_token_hook` mirrors it into the
  access token and the gateway verifies that token itself, so Studio needs no `studio-userinfo`
  function of the kind Grafana and Node-RED have. `openid` is deliberately absent from the requested
  scope: GoTrue refuses to sign an ID token with HS256, which is what this whole stack signs with.
- **It closes the unauthenticated MCP server.** Studio's port also served `/api/mcp` — a Supabase
  MCP server exposing `execute_sql` and `apply_migration` as the owner, completing `initialize` with
  no credential at all. It is covered because it is not exempted, and an MCP client cannot complete
  a browser flow. The model-facing surface this stack intends is the i3X one, where RLS is in the
  path.
- **The credential fails closed.** `STUDIO_OAUTH_CLIENT_SECRET` and `STUDIO_PROXY_HMAC_SECRET` are
  generated by `node scripts/setup.mjs`. Without them the stack runs normally and Studio answers a
  login nobody can complete — including on an existing stack upgraded before the variables exist.

**The same door can be published, and is not by default.** `ingress.routes.studio` stays `false`.
The route points at the gateway's studio listener rather than at Studio itself, so leaving it off is
a decision about *exposure* rather than about authentication — a console on a hostname is reachable
by anyone who can reach the ingress.
Turning it on requires `secrets.studioOAuthClientSecret` and `secrets.studioProxyHmacSecret`, and
the render fails naming them rather than publishing a login nobody can complete. Without the route,
reaching it is a port-forward:

```bash
kubectl -n <ns> port-forward svc/supabase-studio 54323:3000
```

Two consequences worth stating on the front page; both are detailed in
[`supabase/README.md`](../supabase/README.md):

- **Node-RED is not an open port.** A `function` node runs arbitrary JavaScript in a container
  holding the MQTT credential, so anyone who could replace a flow had remote code execution on the
  edge host. The editor and `/flows` use OAuth2 + PKCE; an `http in` node accepts only a 60-second
  per-event signed token, deliberately not the admin credential, because any flow author can read it
  from `msg.req.headers`.
- **The `asset-3d-models` bucket is public-read**, because an exported AAS `File` URL must resolve
  for a viewer holding no session and a signed URL would turn every shell already handed out into a
  time bomb. Anything in it must carry nothing beyond machine geometry. The objects are public; the
  listing is not: keys are `<device_uuid>/<file>`, so listing the bucket, like writing to it, is
  gated on `device:manage`, not merely `authenticated`.

## People

**An Administrator adds people, sets their roles and passwords, and removes their access on the
Access Control page's People tab** (`0166`, `0167`). It is the one dashboard path that changes other
people's accounts in GoTrue, and it is narrow by construction.

- **Who can call it.** Administrators only, checked at every server step. The tab is shown only to
  an Administrator. The `manage-people` edge function resolves the caller's role from `user_roles`
  before it makes any admin call. Every database function behind the tab (`list_people()`,
  `set_person_role()`, `record_person_added()`, `remove_person_access()`,
  `restore_person_access()`, `record_person_password_set()`) checks
  `has_role(ARRAY['Administrator'])` again in its own body.
- **Two rules no Administrator can break.** Nobody changes their own role, access or password here,
  and no act may
  leave the site without an Administrator who can sign in (a banned one does not count). Both are
  checked in SQL under one lock on `user_roles`, so two Administrators cannot demote each other at
  once. The function refuses your own access before calling the database, and calls the database
  before GoTrue, so a refused act never reaches GoTrue.
- **The secret key stays in the edge function.** GoTrue's admin API needs the service-role key.
  `manage-people` holds it, granted in `main/index.ts` beside two settings, and uses it for GoTrue
  alone. Every database act runs in the caller's session, so RLS applies and the Audit Trail names
  the person who acted.
- **Ban, never delete.** Removing access deletes the person's `user_roles` row, then GoTrue bans the
  account (`ban_duration` `876000h`), which refuses sign-in and token refresh. The account stays,
  because `audit_trail.changed_by` references it and the trail names the person through it.
  Restoring gives back the role kept in `access_removals` and lifts the ban.
- **The initial password.** Without a mail relay (`supabaseAuth.smtp.host` empty), `manage-people`
  mints 24 characters from the alphabet `npm run setup` uses (about 119 bits, by
  `crypto.getRandomValues`), creates the account with it and `email_confirm`, and returns it once
  with `Cache-Control: no-store`. Nothing stores or logs it: GoTrue keeps a bcrypt hash, the
  `PERSON_ADDED` row records only the method, and the dialog holds it until it closes. With a relay,
  GoTrue sends an invitation instead, and no password exists until the person chooses one. If the
  new person cannot be recorded, the account is deleted again, so no account exists that the trail
  does not mention.
- **A new password, set by an Administrator.** Set New Password mints the same way, with or without
  a relay, and returns it once. `manage-people` asks `record_person_password_set()` first with
  `p_check_only`, which refuses your own account, a machine identity and a person whose access is
  removed, so a refusal never reaches GoTrue. Then GoTrue sets the password, and the same function
  writes `PASSWORD_SET` (email and method, no password). If that record fails, the answer is a 500
  that withholds the password: it was changed, nobody has seen it, and setting it again records it.
  So no password anyone holds was set without a row in the trail.
- **A person's own password.** Change Password, in the account menu, sends the current password
  with the new one in a single `PUT /auth/v1/user`, and GoTrue checks the current one before it
  sets anything. The chart always sets `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD`,
  so a request without it is refused (400 `current_password_required`, or
  `current_password_mismatch` for a wrong one), and an access token taken from a browser cannot
  change the password by itself. GoTrue exempts the two flows that have no current password: a
  recovery link's session (*Forgot your password?*) and an account with no password yet (an
  invitation's first). Set New Password uses the admin API, which the setting does not reach. The new
  password needs at least 12 characters (the chart's rule for the first administrator; GoTrue's own
  minimum is 6). It works without a relay because the chart leaves
  `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION` off. GoTrue keeps the session that made
  the change and ends the person's others. No Audit Trail row is written: GoTrue records
  `user_updated_password` in its own audit log (`auth.audit_log_entries`).
- **Machine identities are never people.** `list_people()` leaves them out, every function refuses
  them, and `refuse_role_for_machine_principal()` still refuses a role at the table.

What a removal does not reach at once is an [accepted risk](#a-removed-person-keeps-what-a-session-already-holds),
and so is what a new password does not reach ([below it](#a-new-password-does-not-end-a-session-at-once)).

## Machine identities

Five identities here are held by software rather than people, and each is narrow by construction:
`Service_Ingestor`, `Service_Playback` and the MCP reader hold `telemetry:read` **as a grant of their
own** rather than a person's role (`0080`), `aber_i3x` reads the broker namespace and
publishes nothing, and `gateway-credential-service` can issue, re-issue and disable gateway broker
accounts, list them and serve the broker's root, and nothing else.
The three database identities are `auth.users` rows with no email, no password and no identity
provider, so none can sign in — and a trigger on `user_roles` refuses any of them a role, so widening
`Operator` for the people who hold it cannot widen them by accident. An Administrator can create a
further one from the **Access Control** page (`0125`): a name, a purpose and permissions from a
fixed menu, then its first token shown once. Such an identity reaches the database only, never the
broker. **Machines propose, people decide** (`0146`): the menu is four reads and two writes, filing
change proposals and versioning schemas, and `create_machine_principal()` refuses a machine device
writes, quarantine and proposal decisions, and access control, each with its reason. The Audit
Trail files a machine's writes as a service's whatever it declares (`0152`), and the person
deciding its proposal sees it by name (`0154`).

**The ingestion daemon does not hold `SUPABASE_SERVICE_ROLE_KEY`.** It used to, and that was the one
credential whose compromise no policy written anywhere else could contain, sitting in the process
most exposed to the plant network. It authenticates as `Service_Ingestor` — a principal that cannot
write a single row directly — and every write it makes goes through a `SECURITY DEFINER` gate that
checks the caller is that principal. Its `telemetry:read` grant being insufficient is the design, not
an oversight: it makes those gates the only route rather than the tidy one.

**Tokens are revocable at PostgREST** (`0074`–`0076`): `auth_pre_request` runs before every request
and refuses a JWT whose `jti` has been revoked, and a whole machine identity can be withdrawn.
Expiry still bounds everything else — 90 days for any token naming a **principal**, ten years only
for the anon and service-role keys, which name nobody. Storage, Realtime, the edge runtime and Studio
verify the signature for themselves and are not reached by a revocation (see
[Accepted risks](#accepted-risks)). The **Access Control** tab states what is outstanding.

The mechanism and its limits are in
[`supabase/README.md`](../supabase/README.md#the-access-control-page-states-what-is-outstanding).

**Known issues** — things that can be worked on — are tracked as
[GitHub issues](https://github.com/Harri-Llewelyn/Aber/issues). **Accepted risks are not**, and
live below.

## Accepted risks

An accepted risk is a decision, not a task. Kept here rather than in the issue tracker because an
issue is a bulletin of work somebody could pick up, and one that will never be picked up teaches
readers to skim the list. It also decays differently: an open issue nobody acts on starts to look
like neglect, where a documented decision reads as what it is.

**Each says what would change the decision**, which is the part that stops an accepted risk becoming
a forgotten one. Nothing here is accepted permanently; each is accepted *for a stated deployment
model*, and the model is what to re-check.

### Realtime leaks the timing of changes, though not their contents

An unauthenticated subscriber that can reach the Realtime WebSocket receives the change **envelope**
for every published table. Realtime redacts the payload to `{}` and attaches a 401, but the message
arrives — so the **fact and timing** of a change leak, even though its contents do not. `cells`,
`gateways` and `devices` are published because the dashboard needs them live, so an observer can
infer when an asset was created, edited, archived or changed state. In practice that is a timing
side-channel on shift patterns, commissioning activity and the rate of configuration change.

**It cannot be fixed here** — it is upstream `supabase/realtime` behaviour. The gateway's `apikey`
check does not mitigate it either: the publishable key is a registered key that is necessarily
shipped to every browser, so holding it proves nothing about the caller. What *was* done is narrowing the
publication: `audit_trail` was removed from it, being the most operationally sensitive stream and
one nothing subscribed to.

**Accepted because** the target environment is an isolated shopfloor network reached over VPN, with
services behind an internal CA. Reaching the socket at all means already being inside that boundary,
where an observer has considerably more direct means of learning the same facts — and the exposure
does not justify degrading the dashboard's live updates.

**Revisit if** the stack is exposed to a network where reaching the WebSocket is not already
evidence of access: a public or partner-facing deployment, a shared cluster, or any move to
multi-tenancy. At that point the choice is dropping the three tables from the publication and
polling instead, or waiting for upstream to authenticate before delivering the envelope.

### Revocation reaches PostgREST and nothing else

`0074` made a token revocable at the one choke point PostgREST offers (`PGRST_DB_PRE_REQUEST`).
Storage, Realtime, the edge runtime and Studio verify the HS256 signature for themselves and consult
no table, so a revoked token still opens those doors until its own `exp` — at most 90 days for a
token naming a principal.

**Accepted because** every write that matters goes through PostgREST and RLS, including the two a
machine identity may hold, the other surfaces are read-side or gated by a separate login, and the
ceiling bounds the exposure.

**Revisit if** tokens are issued to parties outside the operating organisation, or if a write path
that bypasses PostgREST is ever added.

### A removed person keeps what a session already holds

Removing a person's access (`0166`) deletes their role at once, and everything that reads
`user_roles` on each request refuses them from the next one: the API's RLS, the edge functions and
the forge's door. The GoTrue ban refuses a new sign-in and a token refresh. Four things already
issued are not reached:

- **An access token** stays valid until its `exp`, at most `supabaseAuth.jwtExpiry` (3600 s by
  default). With no role it reaches what RLS grants any signed-in account: the registry tables and
  vocabularies, and nothing a role or permission gates. `auth_pre_request()` refuses tokens by
  subject only for machine identities.
- **Studio** admits on the token's `app_metadata.role` claim, so a removed Administrator's open
  Studio session lasts until that token expires.
- **Node-RED's editor** keeps the permission it granted at sign-in for its session, up to eight
  hours (`sessionExpiryTime`).
- **Grafana** keeps the role it mapped at sign-in for its own session.

**Accepted because** the API, where every write that matters goes, refuses the person at once; the
token window is bounded by the expiry; and Studio is off the Ingress by default.

**Revisit if** `jwtExpiry` is raised, if Studio is put on the Ingress, or if removing an
Administrator ever has to be immediate everywhere. Studio's and Node-RED's checks would then read
`user_roles` per request, as the forge's does, and `auth_pre_request()` would refuse a removed
person's subject.

### A new password does not end a session at once

Set New Password (`0167`) changes a person's password straight away, and GoTrue deletes every
session they have, so none of their refresh tokens works again. As with a removal, what was already
issued is not reached: an access token stays valid until its `exp` (at most
`supabaseAuth.jwtExpiry`), and Node-RED's, Grafana's and Studio's own sessions last until they
expire. Unlike a removal, the person keeps their role meanwhile.

**Accepted because** Set New Password is how a person who lost their password gets back in, not how
one is stopped. Remove Access stops one, and is immediate for every role check.

**Revisit if** a compromised password ever has to be shut out everywhere at once. Today the nearest
is Remove Access before Set New Password, and the removal's own limits are
[above](#a-removed-person-keeps-what-a-session-already-holds).

### The broker's internal CA has no revocation list

There is no CRL and no OCSP for the root `deploy/k8s/internal-ca.yaml` issues. A compromised root private key has no remedy
short of re-minting the root and re-walking the fleet. Broker *credentials* are revocable and
immediate (archiving a gateway disables its account and drops its session); the trust anchor is the one thing that is not.

**Accepted because** the key never leaves its Secret or volume, is never mounted into an application
pod, and never reaches an appliance, which receives `ca.crt` alone; for a fleet of this size a CRL
would add a reload-dependent mechanism nothing here consumes.

**Revisit if** the root is ever exported, or if client certificates replace password authentication
on the broker. The re-walk itself is no longer a visit: the sweep publishes the current root to
`trust/` on the platform repository and every appliance installs it at its next hourly convergence,
which is what the compromised-key case needs (`docs/remote-gateways.md` §8).

### An appliance's deploy key can write its repository's wiki

Since `0104` an appliance's deploy key is writable on its own repository, so that it can report
what it is running on the `appliance` branch. Branch rules confine it there: `main` and every
other branch refuse it. The wiki is a second git repository beside the first, and Gitea has no
rule for it: measured against `gitea/gitea:1.27.3`, a clone of `<repo>.wiki.git` with the key and
a push to it succeed. A compromised appliance, or its key taken from a cabinet, could therefore
rewrite the notes people keep about that gateway. The flow is unaffected.

**Accepted because** the wiki is a git history, so a rewrite is recoverable and visible in it;
the key opens nothing beyond its own gateway's repository; the alternative homes for the notes
(a second repository per gateway, or a fork in a second organisation) double the furniture the
sweep reconciles for a page that holds where a box is and who to call; and `flows_cred.json`,
the only secret on the appliance, is on no list the pusher commits.

**Revisit if** the wiki comes to hold anything a person acts on without checking (a commissioning
sign-off, a safety note), or if Gitea gains a per-unit permission for deploy keys, at which point
the key loses the wiki unit and nothing else changes.

### NetworkPolicy is opt-in

A default-deny NetworkPolicy (`networkPolicy.enabled`) says which pod may reach which. Off, any
pod in the namespace can reach any other pod's port, and Gitea signs in whoever the identity
header names from any peer.

**Accepted because** a single-node k3s box is one machine, every internal port is ClusterIP, and
the policy is one value away; the runbook says to enable it on any cluster where the forge holds
real flows.

**Revisit if** a second service ever relies on "only these pods can reach me" as a control, or if
the cluster is shared with anything else.

### Host gateway passwords are kept, and Administrators can see them

A Host or Simulated gateway's broker password is typed into the Node-RED editor by a person. So that
it is not lost, the platform keeps an encrypted copy in Vault, and an Administrator can show it again
from the gateway's drawer (`0164`). Anyone who holds `Administrator`, or who holds both a database
dump and its Vault key, can therefore read every Host gateway's broker password. Before `0164` the
platform kept no copy at all: the broker stores only a hash.

**Accepted because** the copy is limited to the passwords a person handles anyway. Remote gateways'
credentials never reach a browser, and the Playback gateway's is delivered to its worker, so neither
keeps one. Showing a password is Administrator only, each showing is a `CREDENTIAL_SHOWN` row in the
Audit Trail, and the copy is deleted when the gateway is archived or deleted. An Administrator could
already issue a new password for any gateway, which gives the same access.

**Revisit if** Host gateways come to publish for machines whose data matters more than the
platform's own, or if a role other than `Administrator` needs to see a password. At that point,
issuing a new password instead of keeping a copy is the stricter choice.
