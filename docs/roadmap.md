# Roadmap & Future Extensions

**None of these are speculative:** every one names the code it would build on, because the value of
writing them down is that a reader can tell how far away each is — and several turned out to be much
closer than the request for them assumed, which is stated here rather than left to be discovered
later.

**This file lists only what is NOT built.** An item that ships is removed from here and its substance
moves into the documentation, so the presence of an entry is the answer to "is this done?" — no entry
says `Built`, because a checklist that contains finished work is not a checklist.

**The numbers were renumbered on 2026-09-02, and that is now a safe thing to do.** They used to be
addresses: source comments cited them, so deleting an entry and closing the gap silently redirected
every citation without erroring, and the list was therefore left gapped as the record of what
shipped. Moving the roadmap out of `README.md` ended that — the comments state what the code does
instead — and `scripts/check-docs-drift.mjs` dropped the four invariants that enforced it. The
numbers are labels for reading order, they run 1-14 with no gaps, and **a renumber costs one grep**
(`§[0-9]`, `roadmap item [0-9]`) across the repository for the prose that still cites them.

**Ordered by subject rather than by age**, in four groups. **1-5 are the platform's own**, led by
the one item somebody else sets the deadline for and then by the credential and operations chain.
**The role split that chain would otherwise have queued behind has already shipped**, as `0069` and
`0070`, which is why 2 is now Entra sign-in alone and 3 no longer waits on it. **So has the
machine-principal split**, as `0080` — it was the entry that arrived from a change being REFUSED
rather than from an audit or a request, and it had to exist before an `Operator` could be granted
anything else, which is exactly what 6 goes on to do. **5 is the only item here whose subject is the
BROKER credential plane** rather than the database one; it sits at the end of the chain because the
database plane's own credential work has now shipped and explicitly scoped that plane out, and
because its strongest argument is a gap (a revoked gateway that is already connected keeps
publishing) rather than a feature. **6-10 arrive from feature requests** — 7 and 10 from GitHub
issues [#63](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/63) and
[#66](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/66); 6, 8 and 9 were not filed. **9 is
sequenced *after* 7 because it removes what 7 replaces, and 6 is sequenced *before* it because 7
cannot ask an `Operator` for a proposal until 6 has given that role a way to make one** — 6 is the
queue and the authority, 7 is one lane's payload and the edge sync that carries it.
[#58](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/58) is built. **8 sits between them because
it is the same appliance seen from underneath**: 7 makes a gateway's flow reviewable, 8 makes the
machine the flow runs on a managed artefact, and the two share one puller — which is why 7 now names
`ansible-pull` and 8 argues it. **11 and 12 are the
platform's own and sit last anyway**, because each has for its subject something that runs under or
over every other item rather than any one chain: 11 is the transport between the services, 12 the
record of what they did. Neither blocks the other. 11 is written first because reading it before 5
and 7 invites starting it in the wrong order, which is the one thing it asks not to happen; 12 has
no such constraint. **13 joins that group and is last because it is the newest**: its subject is the
clock every other item's timestamps are read against, it is reachable from 8 (the OS baseline that
would set it) and from 12 (the log that would name the appliance whose clock is wrong), and it
belongs to neither.

**The Directory's MQTT half shipped and left this list on 2026-09-08.** It was 6; 7-14 moved down
by one, and the grep found citations in eighteen files to move with it. Its substance is in
[The Factory+ Directory adapter](../supabase/README.md#the-factory-directory-adapter) and
[The Directory on MQTT](../ingestion/README.md#the-directory-on-mqtt): four retained documents under
`ACS-Cymru/Directory/v1`, published by the ingestion daemon on an interval, off by default.
**Three things it argued came out differently in the building.** The entry refused
[#64](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/64)'s design — a registry ACCUMULATED from
what devices claim in their births — and that refusal held: the publisher reads the enrolment record
and never reads a birth, which `ingestion/test_directory_publish.py` asserts against the module's own
source rather than against its behaviour, because the failure being guarded is somebody adding the
birth handler later. What the entry did NOT foresee is that the REST half's best property does not
survive the move: `fplus-directory` reads as the caller, so RLS bounds what each caller sees, and a
retained topic has one copy for every subscriber. That is why the feature is **off by default** and
why the broker ACL is the whole of its access control — a gateway may not read the tree at all, since
a gateway is otherwise confined to its own edge node and could not enumerate the site. And the
publication is whole documents per collection rather than a topic per entity, because a retained
per-entity topic outlives the thing it describes and nothing sweeps it.

**Contextual help shipped and left this list on 2026-09-06.** It was 11; 12 and 13 moved down by
one, and the grep found two prose citations to move with it — `0085`'s header and
`supabase/README.md`. Its substance is in
[Contextual help](../frontend/README.md#contextual-help): a control in the top bar, a drawer per
page, thirteen markdown files, and a bidirectional guard in `check-docs-drift.mjs`. **Three things
it argued came out differently in the building, and each one is worth carrying forward.** The corpus
could NOT live in `docs/help/` as the entry proposed — `frontend/Dockerfile`'s build context is
`./frontend` on every target, so `docs/` is not present at image build time at all, and bundling
from there works on a developer's machine and fails in every container build. The `docs/` placement
was never what made the writing cheap either: `ci.yml` classifies a diff with `*.md|docs/*`, and a
`case` glob's `*` spans directory separators, so a markdown file anywhere in the repository already
skips the two end-to-end stacks. And the drawer had to mount its CONTENTS only while open, which no
per-page drawer needs to do — a page of prose whose first line is the page name put a second
"Devices" into the document on every page, which `aria-hidden` hides from assistive technology and
from nothing else.

**Studio behind a login shipped and left this list on 2026-09-05.** It was 2 until `0081` and
`0082`; everything above 2 moved down by one, and the grep above found three prose citations to
move with it. Its substance is in
[The second listener, which is Studio's login](../supabase/README.md#the-second-listener-which-is-studios-login-0081)
and the two sections after it, in [`deploy/k8s/README.md`](../deploy/k8s/README.md), and on the
front page. **Three things it argued are worth carrying forward, because each one contradicted the
entry that asked for them.** The role does not need a third `studio-userinfo` function — GoTrue
refuses to sign an ID token with HS256, so there is no ID token to read a claim from, and the role
arrives in the *access* token the gateway already verifies. The read-only database branch was not
running as the owner as the entry assumed; it was failing to authenticate, because the image's role
ships with no password, and the only caller that takes it is `/api/mcp?read_only=true`. And the
`ingress.routes.studio` default stayed `false` — not because the console is unauthenticated any
more, but because publishing one is an exposure decision that belongs to a deployment.

**Revocable service tokens shipped and left this list**, which is what an item shipping looks like.
It was 3 until `0074`–`0076`; everything above 3 moved down by one. Its substance is in
[The Access Control page states what is outstanding](../supabase/README.md#the-access-control-page-states-what-is-outstanding),
which now carries the four things the entry argued: the `db-pre-request` choke point that made
revocation possible at all, why the mint signs in an edge function rather than in the database
(`SUPABASE_JWT_SECRET` is not there, and putting it there would make every path to SQL a path to an
unrevocable `service_role` token), why revoking a principal reaches further than revoking its
tokens, and what none of it reaches — storage, realtime, the edge runtime and Studio verify the
signature for themselves. **The one measurement worth carrying forward** is that a missing
`PGRST_DB_PRE_REQUEST` function is a total outage which `/live` and `/ready` both report as
healthy, answering 404 rather than 5xx; `check-docs-drift.mjs` is the guard.

**When an item ships, check what cited it as a blocker.** This list has already aged in the one
direction nobody watches for: an entry correctly marked blocked, whose blocker then cleared as a
side effect of unrelated work, with nothing sweeping back to say so. Item 1 sat marked *"blocked on
Kubernetes"* after the chart had moved to Envoy — the analysis was right when written and wrong when
read, which is worse than an entry that was never checked at all.

**Where earlier entries went.** These numbers are *historical* — they were retired under the old
gapped scheme and do not correspond to anything above. Machine identities (6, 13, 16) to
[Machine identities](../README.md#machine-identities) and
[`supabase/README.md`](../supabase/README.md#machine-identities); schema conformance (7) to
[Schema Conformance](../ingestion/README.md#schema-conformance); capture and playback (11, 17) to
[Broker Capture and Playback](../ingestion/README.md#broker-capture-and-playback),
[Recording from the dashboard](../ingestion/README.md#recording-from-the-dashboard),
[Playback from the dashboard](../ingestion/README.md#playback-from-the-dashboard) and
[The Playback gateway, and its shadow devices](../ingestion/README.md#the-playback-gateway-and-its-shadow-devices);
deployment nomenclature (15) to
[`deployment`, and the word it is replacing](../supabase/README.md#deployment-and-the-word-it-is-replacing-0064);
historian roles (18) to [Historian roles](../README.md#historian-roles); the audit domains (22) to
[Two lanes, and one of them an engineer cannot read](../supabase/README.md#two-lanes-and-one-of-them-an-engineer-cannot-read-0070);
cold archival (3) to [Cold telemetry archival](../supabase/README.md#cold-telemetry-archival-0068),
including [what Grafana can and cannot see](../supabase/README.md#what-grafana-can-and-cannot-see) —
the one part of that item deliberately **not** built, because rendering archived ranges in a
dashboard would recover a resolution nothing charts while adding a container, a gateway route and an
auth surface over raw plant history. The gateway migration (4) was retired when Envoy became the
gateway on Kubernetes as well as on Compose, and is documented in
[`docs/gateway-migration.md`](gateway-migration.md); 9's subject was retired the same way when
`aas-api` shipped.

**The opt-in simulator was retired on 2026-09-02 as built.** What remained of it was a walkthrough
for building one machine by hand, and that is now
[`tutorial/README.md`](../tutorial/README.md) — which arrived alongside the removal of the
demonstration floor itself. The four cell gateways, the six devices, the simulator flow, the
Shopfloor Operations dashboard, the three machine alert rules, `provision-gateways.mjs` and the five
seeded schemas are all gone; `0073` retires the last of them from databases that already have them.
A fresh install now has no cells, no gateways, no devices and no schemas, and Node-RED opens empty.
**`deploy-nodered` went with it**, because the only flow it could deploy was the demonstrator's — see
9, which absorbed that.

**Two further entries were retired the same day as answered rather than built**, which is a third
outcome this file did not previously have a place for. **Horizontal ingestion scaling** was retired because
its own instrument closed it: `acs_ingestion_write_seconds` measured two orders of magnitude of
headroom, and the cheap path it proposed was disproven against the live broker. Both findings are in
[The single-writer ceiling](../ingestion/README.md#the-single-writer-ceiling). **Ingress → Gateway
API** was retired because both arguments for it were removed by other work — the Kong 3.9.3 bump and
then Envoy — leaving a change that would express origin policy a second way on one of two targets;
the reason origin policy is worth guarding is recorded in
[`supabase/envoy.yaml`](../supabase/envoy.yaml). Neither was wrong. Both were overtaken, and an item
nobody will action is not a bulletin item.

**None of these are open defects.** Feature requests live here once they have been checked against
the code; **known issues** stay in
[GitHub issues](https://github.com/Harri-Llewelyn/ACS-Cymru/issues), and **accepted risks** live
under [Accepted risks](../README.md#accepted-risks) — a decision nobody will action is not a bulletin
item, and leaving it in the tracker teaches people to skim it.

---

## 1 · Moving off Supabase's legacy API keys

**Builds on:** the gateway's translation in [`supabase/envoy.yaml`](../supabase/envoy.yaml), which
is BUILT — see
[The two key formats, accepted at once](gateway-migration.md#3-the-two-key-formats-accepted-at-once) ·
`scripts/setup.mjs` · the i3X service · the edge functions · [`frontend/src/lib/supabaseClient.js`](../frontend/src/lib/supabaseClient.js) ·
`custom_access_token_hook` (`0001`)

Supabase deprecates the `anon` and `service_role` JWTs **by the end of 2026**, replacing them with
publishable and secret keys. It is the only item on this list whose timing is set by somebody else,
and the deadline is now inside a year.

**The gateway half shipped and left this entry.** The stack accepts `sb_publishable_*` and
`sb_secret_*` alongside the legacy pair, on both targets: `setup.mjs` mints a pair, the chart takes
`secrets.publishableKey` / `secrets.secretKey` as `optional: true` refs so an existing cluster
upgrades without minting anything, and the Lua filter matches the new key as a string and hands the
upstream the legacy JWT it has always required. Empty means legacy-only, which is what every
existing install is. The reasoning, the translation table and what it deliberately refuses to
rewrite are in the gateway document; the one thing worth repeating here is **why** it could be
built at all — the new keys are not JWTs, no component downstream ever sees one, so this was a
gateway feature rather than a component-version upgrade.

**The consumer sweep has now shipped too, and it left this entry.** Every gateway caller in the
repository prefers the publishable key and falls back to the anon key: the five Python daemons
through a `SUPABASE_GATEWAY_KEY` constant, the nine edge functions that hold one through a shared
[`_shared/gatewayKey.ts`](../supabase/functions/_shared/gatewayKey.ts), the browser bundle through
`config.js`, and the two shell substituters through `${SUPABASE_PUBLISHABLE_KEY:-$SUPABASE_ANON_KEY}`.
The chart gained an `optionalSecretEnv` helper so a cluster on an `existingSecret` upgrades without
minting anything. The table of what moved, what deliberately did not, and why the fallback tests
for an empty string rather than for an absent one is in
[What the consumers do with it](gateway-migration.md#what-the-consumers-do-with-it).

**The switch and its measurement have now shipped too.** `LEGACY_KEYS_ACCEPTED=false` (Compose) or
`supabaseEnvoy.legacyKeysAccepted: false` (Helm) stops the gateway accepting the anon and
service-role JWTs at all, and both substituters refuse the one combination that locks everybody
out -- legacy off with no publishable key registered, which accepts nothing and answers 401 to
every request while every container reports healthy.

**What was actually blocking this was a measurement, and the gateway now takes it.** Two
instruments, deliberately both: an access log line per legacy-key request naming the route, the
user agent and the caller -- silence is the pass condition -- and
`rbac.legacy_api_key_.shadow_allowed` on the `/stats/prometheus` endpoint the ServiceMonitor already
scrapes, which must be flat at zero. The log answers "who do I go and talk to"; the counter answers
"is it trending to zero" on a dashboard. Neither logs the key: the apikey travels in the query
string on the Realtime route, so the format records `%ROUTE_NAME%` rather than the path.

**WHAT IS LEFT IS AN OBSERVATION, NOT A CHANGE, and it is deliberately not automated.** The flag
still defaults to `true`, because turning it off is an outage for anything still presenting a legacy
key and this repository cannot know who that is -- a Grafana somebody wired up, a script on an
engineer's laptop, an integration written against the published quickstart. The remaining work is to
watch both instruments on a real deployment over a window covering its slowest periodic job -- a
backup cycle, a month end -- and then set one value. The order, and what to do when a `status=401`
line appears afterwards, is in
[Retiring the legacy pair](gateway-migration.md#retiring-the-legacy-pair-and-how-to-know-it-is-safe).

**This entry stays until a deployment has actually run deactivated**, which is the only thing that
would prove the chain works end to end. It is the one item on this list whose remaining work is
operational rather than editorial, and shortening it to "done" while every install still accepts the
deprecated format would be exactly the kind of entry the header of this file warns about.

**THE SIGNING ALGORITHM IS A DIFFERENT QUESTION AND IS NOT IN THIS ITEM.** This is the key FORMAT,
and it could be built as a gateway feature precisely because the new keys are not JWTs. HS256 on
`SUPABASE_JWT_SECRET` is untouched by everything above, and it is load-bearing in a way that only
shows up when something asks GoTrue for an ID token — which is where §7 ran into it trying to sign
in to the forge, and where the measurements are.

**The divergence argument still applies to anyone re-enabling Kong.** Kong cannot translate an
opaque key, so a stack that turns it back on accepts only the legacy format — a stack whose
authentication differs by deployment target is the class of divergence the shared gateway template
exists to prevent.

**Sources**, since the upstream guidance for the hosted platform and for self-hosting differ and
this entry was written against the wrong one once already:
[migrating to new API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys) ·
[self-hosted auth keys](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys) ·
[Envoy API gateway](https://supabase.com/docs/guides/self-hosting/self-hosted-envoy)

---

## 2 · Microsoft Entra ID sign-in, and a role model worth mapping onto

**Builds on:** `custom_access_token_hook()` and `handle_new_user()` in
[`supabase/migrations/0001_baseline_schema.sql`](../supabase/migrations/0001_baseline_schema.sql) ·
`has_role()` and its 58 call sites · `GOTRUE_DISABLE_SIGNUP` in [`.env.example`](../.env.example) ·
`acs-cymru.validateSecrets` in
[`_helpers.tpl`](../deploy/helm/acs-cymru/templates/_helpers.tpl)

Sign in with a Microsoft work account, with an organisation's Entra groups deciding which role the
account lands in, and documentation an IT administrator can follow without reading this repository.
**Entra only.** Google and GitHub are deliberately out of scope, for a reason given below that is
not "we ran out of time".

### The role split has landed, and it was the prerequisite rather than a footnote

**This half is built.** `0069` withdrew `authz:manage`, `schema:manage` and `gitops:manage` from
`Shopfloor_Manager` — who has access, what contract ingestion validates against, and what gets
deployed to the edge — and it is documented under
[The two privileged roles, and what separates them](../supabase/README.md#the-two-privileged-roles-and-what-separates-them-0069).
Mapping an Entra group onto `Shopfloor_Manager` was not worth doing until that name meant
something, and it now does: **Manager operates the shopfloor, Administrator operates the
platform.**

**One thing this entry used to claim was not true, and the correction is the more useful fact.** It
said a Shopfloor_Manager *"can promote themselves to Administrator through the Access Control
tab"*. There is no such control and no write path for one to use: `user_roles` and
`role_permissions` carry a SELECT policy each and nothing else, so no authenticated caller —
Administrator included — can write either through PostgREST. Role assignment is a migration, the
seed, or `handle_new_user()`. **The escalation was latent, not live.** That makes the split a
prerequisite for building the role-assignment control rather than a patch on an open hole, which is
a better argument for doing it first, not a worse one — `authz:manage` starts meaning something at
the moment that surface exists, and it should arrive into a schema where the two roles already
differ.

**The withdrawal had to reach PostgreSQL, and finding out why is the part worth recording.** *No
RLS policy in this schema reads `role_permissions`.* Every database control resolves through
`has_role()`; the permission table is read by `usePermissions.js` and by nothing else. So the
obvious version of this change — delete three rows from the seed — would have hidden three buttons
and left every endpoint behind them exactly as open as before. This repository has already written
down what that costs, retiring `VITE_ALLOW_SIGNUP`: *"a frontend flag and therefore never an access
control."* The write policies on `schemas`, `metric_catalog` and `metric_groups` narrowed in the
same migration, and `deploy-nodered`'s `ALLOWED_ROLES` narrowed with them, because an edge function
is where `gitops:manage` is enforced — there is no deployments table to put a policy on.

**And that permission had two doors, which is the trap worth naming.** The Directory page's Sync
button goes through `deploy-nodered`; the Node-RED editor deploys directly, on a permission tier
`nodered-userinfo` hands out. Closing the first alone would have produced a manager who cannot
press the button and can still deploy — worse than leaving both open, because it reads as a
control. A manager keeps `read` in the editor: inspecting a running flow is not deploying one.

**The mirror this entry said nothing covered is now covered.** `DEFAULT_ROLE_PERMISSIONS_MAP` in
[`frontend/src/hooks/usePermissions.js`](../frontend/src/hooks/usePermissions.js) is the static
fallback the dashboard renders from when no `role_permissions` rows resolve — a real path, not a
theoretical one — and it hard-coded both roles as `Object.values(PERMISSION_UUIDS)`.
[`check-mirror-drift.mjs`](../scripts/check-mirror-drift.mjs) now replays the grants across the whole
migration chain and compares them to that map per role. It refuses to guess: a withdrawal written
in a shape its parser does not understand fails the check rather than being silently skipped, since
an unparsed DELETE would make the SQL side look more generous than the database is.

It is a **breaking change** for any deployment that has a Shopfloor_Manager doing schema or GitOps
work. The repair is to make that person an Administrator.

### What is left of this item is Entra itself

Everything below is unbuilt. The role split was sequenced first because §3 and the audit-domain
work both depended on it and neither depended on Entra. The second of those has since shipped as
`0070`.

### The tenant URL is the boundary, and it fails open

GoTrue's Azure provider takes an authority URL. Point it at a tenant —
`https://login.microsoftonline.com/<tenant-id>/v2.0` — and only that organisation's directory can
produce a session. Leave it unset **with the provider enabled** and GoTrue falls back to its own
default, which is `common`: every Microsoft account in existence, including personal ones.

So the guard cannot be "ignore a bad value", because the fallback from ignoring it is the worst
value. It has to refuse to enable the provider at all. Three details that a first attempt gets
wrong:

- **`common` is not the only bad value.** `organizations` and `consumers` are equally multi-tenant,
  and `consumers` is personal accounts exclusively. The reject-list is those three plus empty.
- **The operator should type a tenant GUID, not a URL.** One variable, `ENTRA_TENANT_ID`, empty by
  default, with compose building the authority around it. A URL field invites a hand-edited
  authority; a GUID field does not.
- **A flag cannot be the only check.** `.env` is editable after `npm run setup` has run. The
  enforcement that holds is a `tid` claim check on the provisioning path, refusing to create a user
  whose identity does not carry the expected tenant — held in `system_settings`, which is already
  Administrator-only. That is the same argument as everywhere else here: the control belongs in
  Postgres, not in a flag.

On the Kubernetes path the flag half is a `acs-cymru.validateEntra` alongside `validateSecrets` and
`validateRealtime`, failing at template time. On Compose there is no equivalent hook, so it goes in
[`scripts/setup.mjs`](../scripts/setup.mjs), which already hard-fails on a missing assignment.

**The tenant boundary answers "which company", not "which person".** Every employee of that
directory can obtain a session. `handle_new_user()` handing them `Operator` — read-only, already —
is the other half of that control and not a separate decision.

### Closed signup is the collision, and the fix is not to open it

`.env.example` already lists "an upstream identity provider" as one of the three ways an account may
arrive. That sentence is aspirational: `GOTRUE_DISABLE_SIGNUP=true` is expected to refuse
first-time external-provider logins too, in which case Entra creates nobody. **Confirming that is
the cheapest thing in this item and it decides the shape of the rest**, so it happens first.

If it holds, do not flip the variable. Flipping it reopens `POST /auth/v1/signup` for every caller
who can reach Kong — precisely the regression the block comment in `.env.example` exists to prevent,
and precisely how `VITE_ALLOW_SIGNUP` failed before it. **Deny the signup route at the edge and
leave the OAuth callback open.** Route-level deny is a control this stack already uses.

### The IdP authenticates; `user_roles` still authorises

The obvious design — an administrator stamps a role onto the user in Entra, the application reads it
— is weaker than what already exists, and one version of it is an escalation path. GoTrue lands
external-provider profile data in `raw_user_meta_data`, and **that column is writable by the user**
through `supabase.auth.updateUser({ data })`. Any hook reading a role out of user metadata hands out
self-service promotion.

`has_role()` reads `public.user_roles` keyed on `auth.uid()`. The JWT claim that
`custom_access_token_hook()` stamps is decoration; the table is the authority, and every RLS policy
re-reads it per query. Keep that. A group claim becomes a **provisioning input** — a
`sso_role_mappings(provider, claim_key, claim_value, role_id)` consulted at sign-in, which *writes*
`user_roles` — and nothing downstream changes: `has_role()`, all 58 policies, `usePermissions`, the
Access Control tab.

Whether Entra group or app-role claims survive into `identity_data` at all in `gotrue:v2.189.0` is
unverified, and the fallbacks differ enough to matter: SAML has attribute mapping, and
domain-verified auto-provisioning with in-app promotion needs no claims at all. Spike it before
designing the table.

### Why Entra alone, and what the documentation has to say

The three providers are not equivalent, and a document implying they are would be wrong. Entra
expresses groups and app roles. **GitHub org and team membership is not in the OIDC token at all.**
Google Workspace groups need the Cloud Identity API. So Entra and SAML can map by group; Google and
GitHub can realistically only map by verified email domain. Supporting one provider properly beats
three with a footnote.

The document is for an IT administrator who has never seen this repository: the app registration,
the redirect URI through Kong, the tenant-scoped authority and why `common` is refused, the optional
claims to enable, and the group-object-ID to role table. It lives in `docs/`, where
[`scripts/check-docs-drift.mjs`](../scripts/check-docs-drift.mjs) can be taught to reach it.

### Worth deciding early

- **Whether the login screen offers both paths or one.** A stack with Entra configured may still
  want the seeded password accounts for break-glass, and a login screen with two buttons is a
  different design from one with a form and a divider.
- **What happens when a user leaves the group.** Nothing revokes on its own: a mapping consulted
  only at sign-in leaves the role in `user_roles` until someone removes it. Re-evaluating on every
  login is the cheap answer and it still leaves a live session valid until `GOTRUE_JWT_EXP`.

---

## 3 · Multi-factor authentication, and what happens when the phone is lost

**Builds on:** GoTrue v2.189.0's factor API · `has_role()` and the `aal` claim ·
[`AccessControlTab.jsx`](../frontend/src/components/tabs/AccessControlTab.jsx) · the immutable audit in
[`0003_audit_immutability_and_quarantine_rpc.sql`](../supabase/migrations/archive/0003_audit_immutability_and_quarantine_rpc.sql)

TOTP second factors, required of the roles that can change the platform and optional for everyone
else. Any authenticator that implements TOTP works — Microsoft Authenticator, Google Authenticator,
Bitwarden, 1Password — which is a documentation fact, not an integration.

**This item depended on the role split, and that dependency is now satisfied.** The
reset control below is gated on `authz:manage`, which is Administrator-only *only once Manager has
given it up* — `0069` did that, so this no longer builds an MFA boundary that a Shopfloor_Manager
could dissolve. Nothing else here waits on Entra.

### `aal2` is not a switch, and the enforcement belongs in the policies

GoTrue will happily mint an `aal1` token for a user who has a factor enrolled. There is no
server-side "require MFA" setting to turn on. Sending the browser to a challenge screen when
`getAuthenticatorAssuranceLevel()` reports `currentLevel: 'aal1', nextLevel: 'aal2'` is necessary
and it is **not** enforcement — the same JWT still reaches PostgREST directly, and the browser is
the one component an attacker does not have to use.

Enforcement is `(auth.jwt()->>'aal') = 'aal2'` in the policies, beside `has_role()`. For a platform
that already puts every real control in RLS, that is the only placement consistent with the rest of
it. It is also the expensive part: 58 policy sites exist, and deciding which of them are
privilege-changing enough to demand `aal2` is a judgement per policy, not a find-and-replace.

### Never prompt a federated user twice

If a user arrived through Entra, Conditional Access has already applied whatever second factor the
organisation mandates. Prompting them for an application TOTP code afterwards is the clearest single
tell of enterprise authentication bolted on from outside, and it teaches people to resent the
control.

So the requirement is conditional on how the session was obtained, which `amr` carries: **federated
users inherit assurance from the IdP; password users enrol a factor here.** Password users do not go
away when Entra sign-in (§2) ships — the seeded personas, break-glass accounts, and any air-gapped
shopfloor install with no Entra to reach are all password paths, which is why this cannot simply be
delegated upward and forgotten.

### There are no recovery codes, and that is survivable

**GoTrue ships no user-facing recovery codes.** This is worth stating plainly because every
consumer-grade MFA flow has them and their absence is discovered at the worst moment.

What exists instead is the administrative path, which is how enterprise identity actually works: the
service role can delete a user's enrolled factor — `supabase.auth.admin.mfa.deleteFactor()` — and
the user re-enrols at next sign-in. Somebody's phone is lost, an administrator clears the factor,
they set it up again. That is not a workaround; it is the same flow every corporate helpdesk runs.

So the deliverable is a **Reset MFA control in the Access Control tab, gated on `authz:manage`**,
written through the digital thread so that clearing a second factor lands in an audit log that
cannot be edited afterwards. An MFA reset nobody can quietly perform is a property an enterprise
buyer asks for by name, which turns the missing feature into a present one.

The residual case is a deployment with exactly one Administrator, locked out, and nobody left to
press the button. Then it is the service-role key from `.env` and a documented one-liner. **For
self-hosted software that is a legitimate answer** in a way it never would be for a hosted service:
whoever runs this stack owns the database by definition. Document it as break-glass rather than
pretending it cannot happen, and recommend two Administrators in the same breath.

Two smaller mitigations belong in the documentation rather than the code. GoTrue permits **more than
one TOTP factor per user**, so an admin can enrol twice. And a synced vault — Bitwarden, 1Password —
makes a lost handset an inconvenience, where a single-device authenticator makes it an incident.

### What this must not touch

Machine identities have no phone.
[`0048_machine_principals_are_not_users.sql`](../supabase/migrations/archive/0048_machine_principals_are_not_users.sql)
already draws that line, and every `aal2` predicate has to respect it: the ingestion writer, the MCP
read-only principal, gateway credentials and the Grafana and Node-RED userinfo paths authenticate
without a browser and cannot answer a challenge. A policy that demands `aal2` on a table a service
principal writes is an outage, not a hardening.

### Worth deciding early

- **Whether enrolment can be deferred.** Requiring a factor before an Administrator can act at all
  is the strong position and it means the first login on a fresh stack is an enrolment screen, which
  the seeded demo personas would also hit.
- **Whether home-grown recovery codes are ever worth it.** They are buildable in
  `supabase/functions/` — hashed single-use codes, redemption triggering a service-role factor
  delete — but a code can only ever *drop* MFA and force re-enrolment, because nothing but GoTrue
  can mint an `aal2` session. That is a smaller prize than it first looks.

---

## 4 · A backup an operator can take without a shell

**Builds on:** [`scripts/backup-databases.sh`](../scripts/backup-databases.sh) ·
[`scripts/restore-databases.sh`](../scripts/restore-databases.sh) ·
[Backup and Recovery](../supabase/README.md#backup-and-recovery) · the chart's backup CronJob ·
`0055` and [Recording from the dashboard](../ingestion/README.md#recording-from-the-dashboard) ·
[`gateway-credential-service.mjs`](../scripts/gateway-credential-service.mjs) ·
[`ColdStorageTab.jsx`](../frontend/src/components/tabs/ColdStorageTab.jsx) ·
**not yet filed as an issue**

Take a backup from the dashboard. Today tier 1 is `scripts/backup-databases.sh` on the host, or the
chart's CronJob on Kubernetes; there is no way to ask for one from the product, and an operator
without shell access on the appliance cannot take a copy of the plant's data at all.

**The backup itself is not the missing piece.** The script writes both databases plus the storage
objects and a manifest, it is idempotent, it prunes on a retention window, and it works against
Compose and any reachable PostgreSQL. What is missing is a caller. Everything below is about who
runs it and what the artefact is allowed to do next.

### The Cold Storage page is the wrong home, and renaming it is the wrong fix

`ColdStorageTab.jsx` opens by settling a name collision that has already cost this repository an
argument: **Archives** means archived cells, gateways and devices, with a Restore button and a purge
timer; **Cold Storage** means Parquet chunk tiering, with neither. Calling this page Backups makes
that a three-way collision and puts two unrelated subjects on one screen — *where is my history* and
*give me a copy of everything*.

**Its read-only rule does not apply here, and it is worth saying why rather than citing it wrongly.**
That rule is about *irreversible* acts: *"a button here would put an irreversible act one click from
a table"*, about dropping a chunk. Taking a backup is not one. The argument against this page is the
name and the single question it answers, not the absence of buttons. **A separate Backups page.**

### Nothing in this stack can currently take that backup, and that is the whole item

The script does three things a browser and an edge function cannot:

- `docker compose exec` into two containers — the edge runtime has no Docker socket and no `pg_dump`
  binary;
- connects as **`supabase_admin`**, because `postgres` is not a superuser in the `supabase/postgres`
  image and a restore as it dies on the first event trigger;
- reaches **the historian**, a second database the Supabase stack never connects to.

`cold-archiver` is the closest existing thing and is not close: it reaches TimescaleDB as
`ingest_writer` — deliberately holding neither DELETE nor TRUNCATE — and has no access to the
Supabase database at all.

So this needs a **new privileged service**, on the `gateway-credential-service.mjs` model: one verb,
no read-back, not published outside the container network, authorised by an RPC that checks
`has_role()`. That service would hold the largest single privilege in the stack — a full dump of
both databases — and that is the cost to weigh, not the button.

### The shape already exists, and it is the Capture page

`capture.py record` opens an MQTT subscription and a browser cannot, so the Capture page is *"a page
in front of new behaviour in the ingestion daemon"* with the tables and every gate in
[`0055`](../supabase/migrations/archive/0055_capture_orchestration.sql). This is the same problem with a
different capability, and it should be the same answer: `backup_jobs` for the act and `backups` for
the artefact — 0055's own split, because *"a job and an artefact are different things"* — an
Administrator-only RPC, a worker in a service that can do the work, and a page that states what
exists.

### What leaves the building is the decision to make first

A ZIP handed to a browser is the natural request and it is the part to decide deliberately. The
runbook already records what these dumps contain, which is why `./backups/` is **gitignored**:
`auth.users`, hashed OAuth client secrets and the whole `digital_thread`. Add to that the storage
tar, which carries the `flows.json` backups the stack keeps in a private bucket because a flow
describes the plant's edge topology, broker addresses and device ids — and **the historian's
password, which travels inside the Supabase dump** in `public.telemetry`'s user mapping.

Obtaining that today requires shell access on the host. That is a real control rather than an
accident of packaging, and a download button lowers it to any Administrator session on any
workstation. Not a reason to refuse — a reason to choose. **The narrower first version is a button
that produces a backup server-side and a page that lists what exists**, which is the whole request
minus the one part that changes who can walk out with the database.

**Size points the same way.** Measured on the demonstration stack: 19 MB Supabase and 24 MB
historian at 37,007 telemetry rows, compressing to roughly 120 KB and 65 KB. That scales with
history, and a plant retaining a year of it produces a dump in gigabytes — which a browser download
synthesised on demand is the wrong mechanism for, whatever the access decision.

### Restore is deliberately not in scope

The same runbook is the argument. A restore needs **nine roles that a dump contains no `CREATE ROLE`
for**, two of which are traps — `supabase_realtime_admin` is created by the realtime container on
first start and by nothing in this repository, and `supabase_functions_admin` only *appears* to be
created, inside an event-trigger function body a restore defines and never runs. A restore cannot be
replayed over a previous one, because the inherited constraint on Realtime's daily partitions cannot
be dropped. And a restore is exactly the irreversible act the Cold Storage page refuses to put one
click from a table. **`restore-databases.sh` stays a runbook**, and the page should link to it rather
than offer it.

### Worth deciding early

- **Where the artefact lives.** `./backups/` is a host path the CronJob does not share; a storage
  bucket is reachable from both targets and puts the dump under `storage-policies.sql`, which is
  the only thing that would make a later download gateable at all.
- **Whether a scheduled backup and a requested one are the same row.** The chart's CronJob already
  produces artefacts nothing records. If the page is going to state what exists, it should state
  those too — which is the same argument `0070` makes about recording an act rather than only its
  consequences.
- **What the retention window means once a human can ask.** `BACKUP_RETENTION_DAYS=14` prunes on the
  next run. A backup somebody took deliberately before a risky migration is the one most worth
  keeping and the one a timer is most likely to delete.
- **Whether the new service should drive `pg_dump` at all.** This entry is deliberately scoped to the
  caller rather than the mechanism, and that scoping is right — but the moment a privileged service is
  being designed is the cheapest moment to ask what it should hold. `pg_dump` gives a consistent
  snapshot and nothing else: no incrementals, and **no point-in-time recovery**, so the real RPO is
  the CronJob interval however good the page in front of it is. `pgBackRest` (or CloudNativePG on
  k3s, which subsumes this item's service entirely) changes what the privilege *is* — a WAL archiver
  holding a continuous stream rather than a verb producing a file — and that is a different object to
  put behind `has_role()`. Cheaper to price now than after the service exists.

---

## 5 · The broker's Dynamic Security plugin, and the two things a file cannot do

**Builds on:** [`mosquitto/mosquitto.acl`](../mosquitto/mosquitto.acl) ·
[`mosquitto/mosquitto.conf`](../mosquitto/mosquitto.conf) ·
[`scripts/gateway-credential-service.mjs`](../scripts/gateway-credential-service.mjs) ·
`revoke_gateway_credentials()`
([0038](../supabase/migrations/archive/0038_revoke_gateway_credentials.sql),
[0063](../supabase/migrations/archive/0063_virtual_gateways_get_revoked.sql)) ·
`BROKER_PRINCIPALS` in
[`serviceIdentities.js`](../frontend/src/utils/serviceIdentities.js) ·
[`scripts/check-broker-config.mjs`](../scripts/check-broker-config.mjs) ·
`mosquitto_dynamic_security.so`, which **already ships in the pinned image**

Move broker authentication and authorisation from `password_file` + `acl_file` onto Mosquitto's
Dynamic Security plugin, managed at runtime over `$CONTROL/dynamic-security/v1`. The plugin is at
`/usr/lib/mosquitto_dynamic_security.so` in `eclipse-mosquitto:2.0.22` — the tag both targets
already run — so this adds no dependency and no image change.

**This is not the answer to the playback credential question, and the entry says so first because
that is the request it will most often arrive attached to.** Getting a broker password to the
playback worker without recreating its container is blocked in
[`ingestion/playback_worker.py`](../ingestion/playback_worker.py) — `_credentials()` is read once in
`main()`, from the environment — and no broker-side change reaches that. The broker half is already
solved besides: the credential service SIGHUPs Mosquitto, which *"re-reads the password and ACL
files in place and keeps every connection."* Dynsec would add nothing to the no-restart property,
because there is nothing left to add.

### Two things the files cannot do, and one of them is a security gap

**REVOCATION DOES NOT DISCONNECT, AND THAT IS THE ITEM.** `0038` and `0063` revoke a gateway by
removing its line from the password file — but Mosquitto checks credentials at CONNECT and never
again. An archived or deleted gateway that is **already connected keeps publishing** until something
makes it reconnect, and nothing in the stack does. The dashboard reports the credential revoked, the
audit row says revoked, and telemetry keeps arriving. Dynsec's `disableClient`/`deleteClient` kick
the live session, which is the only form of revocation the word actually promises.

**THERE IS NO LIST, WHICH IS WHY THE PAGE HOLDS A LITERAL.**
[`serviceIdentities.js`](../frontend/src/utils/serviceIdentities.js) argues the current arrangement
at length and its premise is a fact about the file: *"There is nowhere to fetch it from. The ACL is
mounted read-only into the broker container and is never parsed by anything that has an HTTP
surface."* Dynsec has `listClients`, so that premise stops being true and the broker half of the
Access Control page could become a live read instead of three hand-maintained objects kept honest by
`check-docs-drift`.

### What it costs, in descending order of seriousness

**1. It inverts the credential service's minimal authority, which is that service's whole design.**
Its header states what it deliberately cannot do: *"it cannot issue a Mosquitto account... cannot
read a password back... cannot delete accounts"*, because *"issuing a Mosquitto account is a far
larger authority than 'add one line to a password file'."* Dynsec management is admin-or-not, so an
HTTP service that today can only append a hashed line would hold create, delete, list and
ACL-rewrite over every principal on the broker. **That is the trade this item is, and it should be
argued rather than absorbed.**

**2. `mosquitto.acl` is the most heavily verified artifact in the repository**, and its guarantees
are measured rather than assumed — `check-broker-config.mjs` re-runs them against whatever tag
`docker-compose.yml` pins. Porting means re-deriving all of it in dynsec's JSON, in particular
`pattern readwrite spBv1.0/+/+/%u/#`, which the file calls *"the rule doing the actual work"*, and
the delivery-time semantics recorded beside it: a wildcard subscription is **granted** at QoS 0 and
enforced per message at delivery, and the refusal is invisible to the publisher because Sparkplug
mandates QoS 0 and there is no PUBACK to carry a reason code. **A dynsec policy that is subtly wider
than the file would therefore fail silently, in the one direction this repository has already paid
to close.**

**3. Mutable state fights the `.env` model on both targets.** `dynamic-security.json` is runtime
state; `mosquitto-init` regenerates the platform principals from `.env` on every run
(*"THE PLATFORM PRINCIPALS ARE REWRITTEN ON EVERY RUN — they come from .env and must follow it"*).
Boot would have to **reconcile idempotently rather than rewrite**, and the failure mode inverts:
instead of the database plane's *"a revocation performed in the UI would be undone by the next
`docker compose up`"*,
the risk becomes broker state that drifts from `.env` and is never corrected. On Kubernetes it is
worse — the ACL and config arrive as read-only ConfigMaps, and mutable state needs a PVC the broker
does not currently have.

### Worth deciding early

- **Whether dynsec can coexist with `password_file` for one listener.** If it cannot — which is what
  should be assumed until measured — every principal moves in one flag day, and there is no
  incremental path to test on a live stack.
- **Whether dynsec ACLs substitute `%u`.** The entire per-gateway confinement rests on it, and
  adding a gateway costs an ACL edit rather than nothing if they do not. Measure it on 2.0.22
  before anything else in this item is planned; `check-broker-config.mjs` is where the measurement
  belongs, for the reason `mosquitto.acl` already gives: *"A config that starts is not a config that
  is safe."*
- **Whether `listClients` is exposed to the dashboard at all.** A LIST verb on the credential
  service was already refused once, partly because *"it would hand whoever holds one bearer token an
  inventory of every account on the broker."* Dynsec's list has exactly that property, so the
  objection transfers intact and needs a fresh answer rather than being assumed away by the new
  mechanism.
- **Whether revocation alone justifies the move.** It is the strongest argument here and it may have
  a cheaper answer: disconnecting a revoked client could also be reached by having the credential
  service rewrite the account to an unguessable password and then bounce that one session, without
  moving the authorisation model at all. That should be priced before the plugin is.

---

---

## 6 · The approvals queue, and the flow lane that is waiting on §7

**Builds on:** [`approve_quarantined_device()`](../supabase/migrations/0001_baseline_schema.sql) and the
role re-check inside it · `has_role()` and the write policies it gates · the `Operator` role as seeded
in [`0002`](../supabase/migrations/0002_seed_data.sql) · `device_nameplate` · `publish_schema_version()` ·
[`EntityLinksModal.jsx`](../frontend/src/components/modals/EntityLinksModal.jsx) ·
[`FlowBackupUploader.jsx`](../frontend/src/components/common/FlowBackupUploader.jsx) ·
`system_settings` and its `min_value` / `max_value` bounds · `digital_thread` and
[`0079`](../supabase/migrations/0079_the_thread_stops_growing_without_end.sql)'s pruning ·
[`0069`](../supabase/migrations/0069_the_two_roles_stop_being_the_same.sql)'s permission split ·
**not filed as an issue, and it is the substrate §7 needs rather than a feature beside it**

One queue for every change a person proposes but may not make: a gateway's flow, an asset's details,
a schema's publication. An `Operator` proposes; a `Shopfloor_Manager` or `Administrator` approves;
the approval is the write.

**Everything but the flow lane shipped on 2026-09-07.** The substrate and the asset-details lane
as [`0086`](../supabase/migrations/0086_a_change_can_be_proposed_before_it_is_made.sql), the
proposer's name as [`0089`](../supabase/migrations/0089_a_proposal_says_who_asked_in_words.sql), and
cells, gateways and document links as
[`0090`](../supabase/migrations/0090_the_queue_moves_to_the_assets_operators_can_see.sql).
**What remains is the flow lane alone, and it belongs with §7** — nothing else here is outstanding.

**The schema lane shipped as `0088` and was withdrawn by `0090`.** It was built correctly and had
no ingress: a draft is created by `fork_schema()`, which needs `schema:manage` — Administrator-only
since `0069` and enforced at the RPC by `0087` — so the only person who could create the draft was
the only person who could publish it. An `Operator` "proposing" a publication was endorsing
somebody else's work rather than asking for a change they could not make, which is a different
feature. Cells and gateways took its place: assets an `Operator` looks at all day and cannot edit,
which is the condition this queue was built for and the one the schema lane never met.

The substance is in
[The approvals queue, and the first write an `Operator` has ever had](../supabase/README.md#the-approvals-queue-and-the-first-write-an-operator-has-ever-had-0086)
and [The queue moves to the assets an Operator can see](../supabase/README.md#the-queue-moves-to-the-assets-an-operator-can-see-0090);
`test_change_proposals.py` is the suite. **Four things the entry argued came out differently, or
sharper, in the building:**

* **The unknown-entity-type refusal had to be written explicitly.** The `CHECK` constraint admits
  the lanes that exist, but the validation trigger runs *before* it, so an unlisted entity type
  reaches the trigger first and its allowlist is empty — which reported "proposable columns are:"
  with nothing after the colon. That reads as a broken message rather than as a lane nobody has
  written an allowlist for, which is the state a widened `CHECK` and a forgotten
  `proposable_columns()` entry would actually produce. **`0090` then made that branch load-bearing
  for a second reason**: it is how the withdrawn schema lane is closed, since the constraint still
  admits the string for the rows already in the table.
* **`status` cannot be withheld by a policy, only by a trigger.** An RLS `UPDATE` policy says who
  may write a row and cannot say *which columns*; a proposer able to set `applied` would hold the
  asset write the design exists to withhold. So the transition functions declare themselves with a
  session flag — the mechanism `acs_cymru.actor_id` already uses — and a trigger refuses every
  other path.
* **`REVOKE` has to precede every `GRANT`, and the repository's own suite caught this file getting
  it wrong.** PostgreSQL grants `EXECUTE` on a new function to `PUBLIC`, so
  `GRANT EXECUTE … TO authenticated` alone narrows nothing. The leak heals on the second boot and
  is therefore present on exactly one kind of installation: a new one.
  `test_anon_privilege_baseline.py` refused the first draft.
* **The expiry timer declares `service`**, with `changed_by` NULL. It reuses the existing
  `actor_source` CHECK rather than minting a fifth kind, and **§7's reconciling sidecar should give
  the same answer** — the question was always whether the two agree, not what the value is called.

### The role this is built for currently holds nothing to build on

`Operator` is role 3, seeded as *"Operational dashboard view, live telemetry streaming, and document
viewing"*, and it holds **no write permission at all**. So this is not a loosening of an existing
grant — it is the first write an `Operator` has ever been given, and it is worth being exact about
what it is a write **to**: a queue, not an asset. **The asset write policies do not move.** `devices`,
`cells` and `gateways` stay gated on `has_role(ARRAY['Administrator', 'Shopfloor_Manager'])` exactly
as they are; what is new is one table an `Operator` may insert into, and an apply path that runs as
the approver.

That distinction is the whole security argument, and it should survive review: **if this item ever
adds a second write path to an asset table, it has failed**, however convenient that path looks.

### The proposal row is the record in every lane, including the Git one

**Even for flows, whose payload lives in a forge.** The row holds the proposer, the target, the
status and the discussion; for the flow lane it holds a pointer to the pull request rather than the
diff itself. The cap, the ordering, the audit attribution and the page then read one table, and the
forge is storage for one lane's payload instead of a second queue with its own permission model.

**The consequence is that an `Operator` never holds a forge account.** They insert a proposal row;
an edge function holding one machine account opens the pull request on their behalf after checking
`user_roles`. Any other arrangement duplicates the role model into a system that has never heard of
`gitops:manage`, and then has to keep the two in step.

### Approving is applying, and that is what a forge cannot give the records lane

[`approve_quarantined_device()`](../supabase/migrations/0001_baseline_schema.sql) is the precedent and
it already has the three properties that matter: it re-checks the actor's role **server-side** rather
than trusting the caller, it applies in one transaction, and it attributes the resulting
`digital_thread` rows to the approver.

**So the constraints run at approval time, and an invalid change cannot be approved** — because the
approval *is* the write, and a patch that violates a CHECK or an FK aborts the approval rather than
being merged and then rejected. That is the failure this shape avoids and the forge cannot: an
approved-but-unapplied change is an audit record of something that did not happen.

**The proposal body is operator-controlled input.** The apply path re-validates rather than trusts
it, and it must never build SQL from the patch's keys — each entity gets an allowlist of proposable
columns, because the fields ingestion writes (`status`, `first_dbirth_at`, `reported_identity`,
`identity_source`, `is_quarantined`) must not be reachable through a proposal at all.

### Quarantine is a lane to read, not a lane to propose into

It belongs in the inbox, because an approver should not have two places to look. **Its approve
control does not move.** A quarantine entry is a discovery the *system* made rather than a change a
person authored, and approving it mints identity and binds a device to a gateway —
`quarantine:approve` and `quarantine:reject` stay where `0002` put them, and no `Operator` gains an
approval here or anywhere.

### Schemas already version themselves, and this must not fork that — *lane withdrawn by `0090`*

> **The lane described below no longer exists.** The reasoning is kept because it is what `0087`
> came out of and because the "one function naming who decides each lane" shape is what every lane
> since is built on. What `0088` could not supply was a reason for an `Operator` to be in it — see
> the status note at the top of this item.

`publish_schema_version()` archives the parent, atomically repoints every `device_submodels` row and
the legacy `devices.schema_id` pointer, and drops the duplicate links that would otherwise collide —
all in one transaction. **That is fork, review and merge with the side effects included, and no Git
lane can be transactional with the rebinding.** So the schema lane proposes *the publish* and the
approval calls that function; it does not model versions beside the ones `schemas` already carries.

**Its approver is narrower than the other lanes', and that should be stated rather than smoothed
over:** `schema:manage` became Administrator-only in `0069`, so a `Shopfloor_Manager` who can approve
a nameplate edit cannot approve a schema publication. One inbox, two approval gates.

**This shipped as `0088`, and building it found that the narrower gate did not exist yet.**
`0069` narrowed *policies*; `fork_schema()` and `publish_schema_version()` are `SECURITY DEFINER`,
so they never consulted one, and both went on admitting the pair — measured on the shipped stack, a
`Shopfloor_Manager` was refused the direct `UPDATE` and published through the RPC anyway. `0087`
closed that first, because the lane's whole premise is a narrower approver and a manager refused at
the queue could otherwise call the RPC. **Two things the entry did not anticipate:** rejecting had
to be gated exactly as approving is, since a role able to refuse an act it cannot authorise can
block it indefinitely; and the patch had to name the ACT (`{"publish": true}`) rather than a column,
because `{"status": "active"}` describes one write while the apply path performs six.

### One form per asset, because two forms drift

**The page's own composer was built and then removed.** It listed the columns
`proposable_columns()` returns, one text input each — which meant proposing a relocation asked for
a `cell_id` **as a typed uuid**, where the asset's own Edit Details dialog has a dropdown. Two
forms describing one device is a drift generator and the drift is silent: the day a field, a hint
or a validation rule is added to one, the two quietly start disagreeing about what a device is.

So there is one form per asset — the one that was already there — and the footer button is the only
thing that differs: `Save` for somebody who may make the change, `Propose a change` for somebody
who may not. [`proposeFromForm.js`](../frontend/src/utils/proposeFromForm.js) is the translation
layer, and it is deliberately **not** derived from `proposable_columns()`: that function answers
*which columns may be named*, and this answers *which box on this form is that column*. Only the
form knows the second, and `asset_name → name`, `cell_name → name` and `access_url → grafana_url`
are three pairs a string-matching mapping gets silently wrong.

**A field that is not proposable is disabled with its reason printed, not hidden.** Hiding it would
make two dialogs out of one — the drift again — and would conceal that a device's gateway
assignment exists at all.

### A proposal can be overtaken, and approving it then records a lie

Nothing stops a `Shopfloor_Manager` editing an asset while a proposal sits open against it, and
nothing should — the queue is a way to **ask**, not a lock. But approving a request whose values are
already in place writes a `PROPOSAL_APPLIED` row naming an approver and a patch for a change that
did not happen in that transaction: an act with no effect, attributed to somebody who did not
perform it, while the real change sits in an earlier row by somebody else.

`0090` refuses it. The test is `to_jsonb(current_row) @> patch` — **containment, not equality** — so
a partly-overtaken proposal is still approvable, and a type mismatch between a form's string and a
typed column fails toward *"approval proceeds"* rather than refusing a real change. The repair is to
**reject** it with that as the reason, which records what actually happened.

### A self-check that counts totals is a landmine under every later migration

**`0069`'s self-check asserted that `Administrator` holds exactly 13 permissions.** `0086` granted
`proposal:create` to three roles, taking it to 14 — and because migrations replay on every boot in
filename order with no ledger, and `0069` runs long before `0086`, the chain **aborted at `0069` on
every boot after the one where `0086` first ran**. The stack silently lost the ability to apply any
new migration while continuing to run perfectly on the schema it already had. It surfaced as
`0090` and `0091` appearing not to exist.

**The test lane cannot catch this.** `npm run test:db` builds a database from nothing, so `0069`
always runs before `0086` grants and always counts 13. Only a *second* boot reproduces it, which is
why it shipped green.

**A self-check must assert what its own migration did, not the state of the world.** `0069`'s
subject is a withdrawal, so it now asserts that `Administrator` holds all three withdrawn
permissions and that `Shopfloor_Manager` holds nothing `Administrator` does not — both stable under
any later grant, and the second is a stronger claim than the count ever was.
[`0049`](../supabase/migrations/0049_documents_become_links.sql) had the right shape all along: it
asserts `>= 2`, a floor rather than an equality.

### Two caps, doing two different jobs, and both in the database

**A partial unique index on `(entity_type, entity_id, proposed_by) WHERE status = 'open'`.** One open
proposal per asset per person, which forces three nameplate edits into one coherent diff instead of
three. **Scoped to the proposer deliberately:** a cap on the asset alone lets one operator's forgotten
proposal block everyone else from proposing against that machine, which is a denial of service by
accident rather than by intent.

**A cap on total open proposals per proposer**, held in `system_settings`. This is the one that
actually bounds reviewer load — the per-asset rule still permits one proposal against each of five
hundred devices — and it belongs in the settings table rather than in a constant because the right
number differs per plant.

**Both are enforced in the database, and the reason is written down.** `0069`'s header makes the
argument against the alternative: a revoked permission whose policy still admits the role is *"a
frontend flag and therefore never an access control."* A cap enforced by disabling a button is the
same object.

**The cap is only usable if editing an open proposal is one click from the refusal.** An operator
told *"you already have an open proposal on this device"* has to be able to open it and add to it
immediately; otherwise the constraint reads as a wall, and people route around it by proposing
against a neighbouring asset or stop proposing at all. This is the part most likely to be deferred
and it is the part that decides whether the cap is structure or friction.

### Expiry needs a floor, and it needs an actor

An open proposal nobody acts on holds a slot indefinitely, so it closes on a timer — **a week is the
default**, set by an Administrator on the Settings page. `system_settings` already carries
`min_value` and `max_value`, and this setting needs the floor: a value of zero auto-closes every
proposal at the moment it is created, which is a working configuration that silently disables the
feature.

**The auto-close needs an actor kind.** `digital_thread.actor_source` admits `user`, `ingestion`,
`migration` and `service`, but only the last three can be *declared* — `user` is derived from
`auth.uid()`, not claimed. A timer closing a proposal has no session and is not a person, so it
either declares `service` or earns a kind of its own. **§7 asks the identical question for the
reconciling sidecar, and the two should be answered together rather than separately.**

### What this must not touch

The write policies on `devices`, `cells`, `gateways` and `schemas`, which stay exactly as `has_role()`
gates them today; `quarantine:approve` and `quarantine:reject`, which are not proposable and not
delegable; the schema lineage invariants in `schemas_version_lineage_coherent`, which
`publish_schema_version()` maintains and a proposal must go through rather than around; and `0079`'s
pruning, which proposals and their comments fall **inside** rather than beside — they are
operator-authored free text attached to assets, and a queue that grows without end is the thing
`0079` has just finished fixing elsewhere.

### Worth deciding early

**The blocking dependency has been removed, and knowing that it existed is what stops it coming
back.** `MCP read-only client`, `Service_Ingestor` and `Service_Playback` all held **`Operator` and
nothing else**, so an INSERT policy naming `Operator` would have admitted three machine identities
along with the shopfloor, and the per-proposer cap would have given each of them its own allowance.
`0080` ended that: a machine principal now holds permissions of its own on `principal_permissions`,
a trigger on `user_roles` refuses it a role at all, and `has_authority()` is the predicate to reach
for wherever a policy would otherwise name a role machines happen to share. See **They hold
permissions, not a person's role** in [`supabase/README.md`](../supabase/README.md).

**So the proposing grant is `Operator`'s alone to receive** — which is the property this item needs
and could not have assumed a migration ago.

**A patch or a whole row.** A patch conflicts cleanly: two proposals touching different fields of the
same asset can both apply. A whole row silently reverts whatever changed underneath it between
proposal and approval. Patch, unless something specific argues otherwise.

**Who `updated_by` names once an approval writes a nameplate.** The column's comment says a nameplate
is *an assertion about an asset, so who made it is part of the record* — that is the proposer. The
approver is who authorised it. Both belong in the record, which probably means the pair lands in
`digital_thread` rather than the table growing a second column.

**Whether a withdrawn proposal is closed or deleted.** An operator withdrawing their own proposal
should free the slot; whether the row survives is a retention question that `0079` has already made
the repository think about once.

**Rejection carries a reason, and there is no cooldown.** A rejected proposal frees the slot at once
and the same change can be proposed again immediately — that is correct, and the control that makes
it work is the required reason, not a timer. It is also the only thing the operator gets in the
thread other than *no*.

---

## 7 · GitOps edge sync, and the review step a bucket cannot give a flow

**Builds on:** the `gateway-backups` bucket in
[`scripts/storage-init.mjs`](../scripts/storage-init.mjs) ·
[`FlowBackupUploader.jsx`](../frontend/src/components/common/FlowBackupUploader.jsx) ·
[`gateway-bundle-template/bootstrap.mjs`](../gateway-bundle-template/bootstrap.mjs) and the flow hash
its heartbeat already reports · `digital_thread` (`0005`, `0026`) ·
[`nodered-userinfo`](../supabase/functions/nodered-userinfo/index.ts), which is now the only place
`gitops:manage` is enforced · **§6, which owns the queue, the page and the proposing role, and is a
prerequisite rather than a neighbour** · [issue #63](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/63)

### The push half existed and has been retired, which makes this item larger than it was

A
`deploy-nodered` edge function deployed **only** `node_red_flow.json` as committed to the repository,
refusing an inline flow array in the request body with a 400 and a stated reason — a Node-RED
`function` node is arbitrary JavaScript inside a container that holds the MQTT credential. Its
comment stated the contract: *"git is the source of truth and this endpoint syncs Node-RED to it."*

**That went with the demonstrator, because the flow it deployed was the demonstrator's.** A blank
install commits no flow, so the endpoint's canonical source was an empty file and pressing Sync
would have erased whatever a user had built in the editor while reporting success. Retiring it was
the honest option; rebuilding it is now part of this item rather than a thing to extend. **What is
worth keeping from it** is the refusal: whatever replaces it must deploy only what is committed, or
it becomes a remote-code-execution endpoint with a friendly name.

### The storage claim needs correcting before anything is planned against it

The issue describes
"manual zip backups inside Supabase Storage". The `gateway-backups` bucket holds `flows.json` — JSON,
5 MiB cap, private, keyed `<sparkplug_id>/` — and it is a backup taken **from** an appliance, not the
channel a deployment travels down. Nothing about it sits on the deploy path, so replacing it is not
where this item starts. Its privacy setting is the one thing to preserve if it is touched at all: a
`flows.json` describes the plant's edge topology, broker addresses and device ids, and a public bucket
bypasses `storage-policies.sql` entirely.

### Pull, and the reason that is a decision rather than a preference

**The retired design pushed inbound to `:1880`, and an inbound path per gateway is the thing this
architecture exists to avoid.** The bundle README states the rule for a different subject and it
generalises exactly: `node_exporter` runs on the appliance and is *never* scraped from the centre,
because gateways enrol dynamically so no static inventory can address them, and the centre reaching
into plants is the property being refused. A deploy channel that dials the edge asks for that path
back, permanently, for every appliance. It also asks for the editor credential to be re-centralised —
`bootstrap.mjs` generates that password on the appliance, prints it once and keeps only its bcrypt
hash, and anything pushing to the admin API needs it back in a fleet-wide store.

**So a sidecar on the appliance polls `git pull` and calls Node-RED's local reload API.** Outbound-only
from the edge, and self-healing on a timer rather than on attention. This is also the answer to any
proposal to place a general-purpose orchestrator or job runner in the plant: a component that executes
whatever the centre queues for it is a strictly larger surface than the `deploy-nodered` endpoint that
was refused for exactly that reason, and it earns nothing the puller does not already have.

**That refusal is about PROVENANCE, not about capability, and §8 turns on the distinction.** What is
refused is an appliance taking instructions from a live queue — no artefact, nothing to diff, nothing
to review. An appliance that converges to a commit somebody approved is the opposite object, however
much it ends up running. `deploy-nodered`'s contract said it in one line, and it generalises past
flows: **deploy only what is committed.**

**The puller should be `ansible-pull`**, which is that sidecar with its reconciliation already
written. §8 argues the choice and owns the appliance half; what matters here is that the flow lane
gets a converger it does not have to build, and one that is idempotent by construction rather than by
care — the property §5 identifies as the hard part of any boot-time reconcile.

**Drift detection is the same mechanism read backwards, and half of it is already built.** The
heartbeat already reports a **flow hash** — recorded by `bootstrap` at enrolment and carried in the
same 30-second message as uptime and load. Comparing that against the committed head of the gateway's
tracked branch is the whole of drift detection, and it needs no new telemetry from the edge and no
connection into it.

### The approval gate is the missing thing, and Git already is one

**The gap §9 names is that a stored flow is *unreviewed*** — no pull request, no revision history,
no diff. That is the real complaint, and it is worth stating that Git answers it directly rather than
being merely the transport: *pending approval* is an open pull request, *approved* is a merge, and
*undo* is a revert commit. Anything that models those three states in the database beside a stored
blob rebuilds a worse version of what the forge already does, and splits the audit record across two
systems that will disagree.

**So the upload becomes a commit.** `FlowBackupUploader` already takes `flows.json` from an operator
and already refuses `flows_cred.json` **by shape rather than by filename**; what changes is its
destination — a branch and a pull request in the gateway's source repository instead of an object in
a private bucket. The upload is then the backup and the proposed deployment in one artefact, which
also removes the awkward sequencing between this item and §9: the bucket stops being load-bearing at
the moment the first flow lands in a repository, not before.

**THE PROPOSAL HALF HAS LANDED, and it is a branch and a pull request rather than a write.**
`propose-gateway-flow` takes the same `flows.json` an operator exports from Node-RED, commits it to a
new `proposal/<timestamp>` branch in that gateway's repository, and opens a pull request against
`main` — so the three states above are the forge's own rather than a workflow modelled beside a
stored blob. **Nothing in it can merge**: approving is `gitops:manage`'s act and is not reachable from
the endpoint, which is what keeps proposing and approving two privileges instead of one.

**`Operator` may propose, which is the whole point of the gate.** This item says a review step whose
proposals can only come from the two roles that may already merge them is a formality; the function
therefore admits Administrator, Shopfloor_Manager and Operator, and refuses Auditor. **The proposer is
named in the commit and in the pull request body** — the forge is reached through one machine account
and shopfloor people hold no login there, so without the name the trail would say only that the
platform committed something. `0089` made the same call for the approvals queue.

**`main` NOT MOVING is the assertion the suite is built around.** Every other property could hold
against a function that committed straight to `main`, and that function would deploy an unreviewed
flow while reporting success — the `deploy-nodered` endpoint this item retired, rebuilt with a
friendlier name. `test_propose_gateway_flow.py` enrols a gateway (which is what creates its
repository), proposes, and asserts the head of `main` is unchanged; it also asserts that
`flows_cred.json` is refused **by shape** with no branch left behind, and that a gateway with no
repository answers 409 rather than failing obscurely.

**THE DASHBOARD OFFERS BOTH LANES, SEPARATELY, and the separation is the part worth keeping.** A
backup is a copy of what an appliance already runs; a proposal is a request to CHANGE what it runs.
One dropzone with a mode would make "which of those am I doing" a matter of remembering, so
`FlowBackupUploader` has two, gated independently. **The comment that said "OPERATOR SEES NOTHING AT
ALL" is now false and says so**: the storage policy still grants that role no backup authority, and
roadmap 7 gives it the proposal, so an Operator sees the proposal lane and no part of the bucket.
The pull request comes back as a link in the drawer rather than only a toast -- the useful fact is
that it is *not deployed yet*, and that is what somebody returns to check.

**The bucket has not moved and must not yet.** §9 sequences its removal, and until something PULLS
these repositories a commit is not yet a backup an appliance can be rebuilt from.

**`gitops:manage` finally gets a second enforcement point.** It is currently enforced in exactly one
place — `nodered-userinfo`'s `ALLOWED_ROLES`, as `0069` records — and the merge is the control it was
named for. **Authoring a proposal and approving one are different privileges** and should not collapse
into one: approving is `gitops:manage`, and **proposing is the `Operator` write that §6 adds** — not,
as this item originally said, the write `storage-policies.sql` already grants Administrator and
Shopfloor_Manager. That was written before the approvals queue existed and it inverted the point: a
review step whose proposals can only come from the two roles that may already merge them is a
formality, not a gate.

### The flow lane of the approvals page, and the one thing it must not become

**§6 owns the page; this item owns what the flow lane shows on it.** Per gateway: the tracked
repository and branch, the open pull requests against it, the commit history with the deployed
revision marked, and the gateway's own reported flow hash beside the committed head — which is drift,
stated as a fact the appliance sent rather than as something the centre inferred. A revert control,
and an approve control gated on `gitops:manage` rather than on the approver role the records lanes
use.

**A revert must be a new commit and never a force-push.** A force-push rewrites history a gateway may
already have pulled, and the sidecar cannot distinguish that from a legitimate advance — it would
reconcile to the rewritten head and report success, having silently deployed something no pull request
ever showed. A revert commit is visible, reviewable and itself revertible.

**The lane must not become an editor, and that is a constraint this item places on §6's page rather
than a note about a page of its own.** Nothing in it should author or edit flow JSON, and nothing
should accept a blob that reaches an appliance without passing the same merge. That is the refusal
worth keeping from `deploy-nodered`, restated for a UI: **deploy only what is committed**, or it is a
remote-code-execution endpoint with a friendly name and a nicer table. Note that the records lanes
§6 describes are the opposite case — there the approval *is* the write — so the two lanes do not
share a submit path and should not be generalised into one.

### The credential store is the hazard that can invalidate the shape

**Node-RED keys credentials by node id**, and holds them in `flows_cred.json`, encrypted separately
and deliberately not in the flow file. This section asked for that to be proved before anything else
was built. **IT HAS BEEN, against `nodered/node-red:5.0.2` — the tag both Dockerfiles pin — and the
result NARROWS this item rather than widening it.**

**THE PULL PATH IS SAFE, SO THE PULLER IS AN OVERWRITE AND NOT A MERGE.** A byte-identical
`flows.json` written back over `/data` and restarted leaves `flows_cred.json` *untouched* — not
rewritten and not re-encrypted — and the broker node keeps its credential. The branch this section
held open, where a round trip cannot preserve binding and the sidecar needs a merge strategy, does
not arrive.

**THE HAZARD IS REAL, AND IT IS THE HUMAN PATH RATHER THAN THE TRANSPORT.** With the broker node's id
changed and the old `flows_cred.json` kept, Node-RED logs `Started flows` and the runtime answers
`{}` for that node's credential — no warning, no failed check. The gateway then authenticates with an
empty username, which Mosquitto refuses with CONNACK 5 and Node-RED reports as *"Connection failed to
broker"* with no cause, the ambiguity `node-red-init.mjs` already exists to remove.

**AND IT IS DESTRUCTIVE ON THE FIRST DEPLOY, WHICH IS THE PART THAT WAS NOT ANTICIPATED HERE.** The
orphaned credential survives a restart, so the appliance looks recoverable; the next deploy prunes it
and rewrites the file to an encrypted `{}`. The ciphertext is then gone, `bootstrap.mjs` will not
re-mint behind its once-only `/data/.enrolled.json` guard, and the enrolment token is already spent —
so the recovery is a new bundle, which is the loss `FlowBackupUploader` exists to prevent.

**WHAT RE-IDS A NODE IS ONE BUTTON, AND IT IS THE ONE AN OPERATOR REACHES FOR.** The editor imports
with `generateIds: false`, so ids survive a paste into an empty workspace. They change only on an
import *conflict* — pasted nodes whose ids are already present — where the offered choices are
per-node replace/copy and a one-click **Import copy** that re-ids everything. Restoring a backup into
the appliance that still holds `acs-broker` is exactly that conflict, and the destructive option is
the convenient one.

**Three things this obliges, and none of them is a merge strategy.** What is committed must be the
appliance's OWN `/data/flows.json`, never an editor export that has passed through an import dialog.
The bundle should carry the `acsCredentialsEnv` convention `node-red-init.mjs` already uses on the
platform side — the credential re-derived from a prefix DECLARED ON THE NODE, and rewritten whenever a
broker node holds none — because `bootstrap.mjs` hardcodes `acs-broker` and runs once, so an appliance
today cannot heal itself. And the sidecar should refuse a commit whose `mqtt-broker` node ids do not
match the keys in `flows_cred.json`, which turns a silent drop off the broker into a visible refusal
to converge.

### A third credential plane arrives with this item — BUILT

**The appliance needs a way to authenticate to the repository**, which is neither the broker plane
(§5) nor the database one. It is **per gateway and read-only** — a shared key across the fleet makes
one compromised appliance a fleet-wide read, and a writable one lets an appliance author what it
will later be asked to deploy. `enroll-gateway` already minted a per-gateway broker credential, and
issuing this one beside it means revocation has a home alongside the credential it sits next to.

**What has landed, and it is the whole plane rather than a piece of it.** Enrolment gained a fourth
step: `bootstrap.mjs` generates an **ed25519 keypair on the appliance** and sends the public half up
with its enrolment request; the platform creates that gateway's repository in the forge and registers
the key against it, read-only; the response carries the clone URL, which `bootstrap` records in
`/data/gitops/repository.json`. **The private half never leaves the plant** — the same decision as the
editor password, one plane along — and revoking a gateway is deleting one key from one repository.

**The refusal was measured, not assumed.** A key issued this way clones the repository and, on
`git push`, is refused by the forge in as many words:

```
Deploy Key: 2:gateway gwy… is not authorized to write to acs_platform/gateway-gwy…
```

`test_enroll_gateway.py`'s forge lane asserts the three properties that would otherwise fail
silently: the repository is **private** (a public one leaks the plant's edge topology and reads
identically from the appliance), the key is **read-only**, and a gateway whose bundle sends no key
still enrols and still receives its broker credential.

**FAILURE HERE IS NON-FATAL, AND THAT IS THE OPPOSITE DECISION FROM THE CREDENTIAL SERVICE'S.** By
step 4 the token is spent and the broker credential exists; refusing over a forge outage would leave
a working broker account no bundle can claim, punishing an appliance for something it did not cause.
Telemetry — which is what a gateway is *for* — needs nothing from the forge. So the response carries
`repository: null`, the log names the gateway, and the appliance publishes as it always did.

**The machine account is not an administrator, and that is load-bearing rather than tidy.** It owns
the per-gateway repositories, which is exactly the authority needed to create one and attach a key to
it, and it can do nothing to the platform playbook the whole fleet converges to. An admin credential
in an edge function reachable through the gateway would put that playbook one compromise away.

**Three things this deliberately does NOT do yet.** The repository name is **derived** from the
`sparkplug_id` rather than stored, so this needed no migration and no column — §9 still owns where a
repository pointer lives, and deriving it means the name cannot disagree with the gateway it belongs
to. Nothing yet **writes a flow** into that repository; the repositories are created empty with an
initial commit, and `FlowBackupUploader`'s move from bucket to branch is the next piece. And **the
forge's SSH host key is not distributed**, which the puller needs: an appliance with no `known_hosts`
entry cannot verify the forge, and the answer must not be to skip verification — §11 and this item
both refuse that switch, and §8 owns where it lands.

**Verifying the commit is what makes the transport untrusted-safe.** If the sidecar checks a signature
over the revision it is about to apply, the forge and the network between are no longer things that
have to be trusted — a much stronger position than TLS to the host alone, and the one that makes a
hosted forge an acceptable answer to the question below.

### Signing in to the forge does not work the way Grafana and Node-RED do, and HS256 is one of three reasons

**MEASURED AGAINST THE RUNNING FORGE rather than reasoned about, because the shape of the answer is
counter-intuitive: this stack already federates two other services and neither mechanism transfers.**
Gitea's only general-purpose authentication source is `openidConnect`, configured entirely from an
auto-discovery URL — its custom authorize and token URL flags are, in its own help text, an "option
for GitLab/GitHub". There is no hand-configured generic OAuth2 source, and a hand-configured generic
OAuth2 client is precisely what `grafana.ini`'s `[auth.generic_oauth]` and `node-red-init.mjs`'s
`passport-oauth2` are. **Those two work BECAUSE they never perform discovery and never ask for an ID
token**, which is a property of how they were configured rather than a property of GoTrue.

**Wall one is the discovery document, and it fails silently in the worst direction.** GoTrue answers
`/auth/v1/.well-known/openid-configuration` with an empty `issuer` and RELATIVE endpoint paths:

```json
{ "issuer": "", "authorization_endpoint": "/oauth/authorize", "token_endpoint": "/oauth/token" }
```

An auth source added against it is accepted without complaint — nothing is validated at
configuration time — and the first login answers `307` to
`http://<forge>/oauth/authorize?...&scope=openid`. **Gitea resolved the relative path against its
own base and sent the browser to itself**, where it is a 404 on the forge. This is the failure
[`node-red/Dockerfile`](../node-red/Dockerfile) predicted in prose when it chose `passport-oauth2`
over `passport-openidconnect`; it is now demonstrated.

**Wall two is the ID token, and it is the HS256 half of the question.** Gitea's request above carries
`scope=openid`, which is not optional for an OIDC source — and requesting it is the exact thing
`node-red-init.mjs` records GoTrue refusing, with `HS256 is not supported for ID token signing`, under
a comment that says not to "fix" a login problem by adding it back. The whole stack is HS256 on
`SUPABASE_JWT_SECRET`: the gateway, PostgREST, Realtime and the pre-minted key pair all depend on it.

**Wall three is unmeasured and should not be assumed away.** GoTrue's OAuth server REQUIRES PKCE —
`node-red-init.mjs` sets `pkce: true` for that reason — and whether Gitea's provider sends a
`code_challenge` is only reachable after the first two walls are cleared. It is a question to answer
before anything is built on the assumption that they are the only two.

**SO MOVING OFF HS256 IS NECESSARY AND NOT SUFFICIENT, which is the thing to be exact about.**
Asymmetric signing does not repair a relative URL, and the discovery document is a separate defect
with a separate fix. The document already advertises `RS256` and `ES256`, so the algorithm is a
configuration question rather than a Supabase limitation — but it is not a small change, because
every component in this stack verifies with the shared secret and the pre-minted `anon` and
`service_role` JWTs are signed with it. **§1 owns the key FORMAT migration and explicitly not this
one**: opaque publishable and secret keys are not JWTs and no component downstream ever sees one,
which is why that item could be built as a gateway feature. Signing is the opposite shape. If it is
ever taken on it earns an item of its own rather than a paragraph in either.

**§2 IS THE CHEAPER PATH AND IT SIDESTEPS ALL THREE WALLS.** Entra ID is a real OIDC provider with a
valid discovery document and genuine ID tokens, so the forge can federate to it DIRECTLY rather than
through GoTrue — no shim, no signing change, and nothing owed by this repository. What it costs is a
second client registration and a forge login that depends on the tenant being reachable, which is
exactly the property §2's own *"the tenant URL is the boundary, and it fails open"* is about; a forge
that cannot be signed into during an outage is a milder failure than a dashboard that cannot, but it
is the same failure.

**NONE OF THIS RELAXES THE RULE ABOVE.** Whichever provider authenticates, **authorisation stays in
Postgres**: `user_roles` and `has_role()` decide, the forge is still reached through one machine
account, and a group claim arriving from an IdP must never become the thing that grants
`gitops:manage`. SSO would change who holds a *login*, not who holds a *permission*.

**AND THE HONEST ANSWER MAY BE THAT ALMOST NOBODY NEEDS ONE.** §6 puts the queue, the review and the
approve control on the dashboard, which people already sign into; the forge UI is for the engineer
reading a diff that the lane did not render, which is a smaller audience than "everyone who touches a
flow". One local administrator plus the machine account is the position to hold until somebody is
actually blocked by it.

### What this must not touch

The enrolment token's single-use semantics and the once-only guard in `bootstrap.mjs`; the broker
ACL's `%u` confinement, which is what stops one gateway forging another's telemetry and is enforced
independently of anything here; `flows_cred.json`, which must not leave the appliance in a backup, a
commit or a diff; and the `gateway-backups` bucket's privacy setting, which stays exactly as it is
until §9 sequences its removal — a `flows.json` describes the plant's edge topology, and it is not
dead weight until the pull half replaces what it does.

### Worth deciding early

**The forge is decided: self-hosted Gitea**, on the private domain, with TLS from the internal CA —
which is the same answer `deploy/k8s/internal-ca.yaml` already gives for every other on-premises
certificate, arrived at for the same reason. A hosted forge would put the plant's edge topology on
somebody else's infrastructure and make the deploy path depend on the site's internet link, which an
appliance in a machine shop cannot assume. Commit signature verification makes the *transport* a
smaller question than it looks, and it does not make that one smaller.

**What it is not is an identity store**, and choosing a forge with a full user model makes that
easier to violate rather than harder. §6 puts the queue in Postgres and reaches the forge through
**one machine account**; Gitea's own users, organisations and teams stay empty of shopfloor people,
no `Operator` holds a login, and the forge never learns what `gitops:manage` means. Per-gateway
**read-only** deploy keys are the only other principal it needs.

**Two costs that arrive with it and are not otherwise recorded.** Gitea is a durable store with
state, so it lands inside §4's backup scope before §4 is built — and it would be the second store in
the repository with no retention answer, which is §12's complaint arriving a second time. Neither is
a reason to choose differently. **Both are DEFERRED until the services §§7–9 plan are all present**,
so that retention is decided once across them rather than per service; what is recorded here is that
they are owed, and that a Gitea holding every gateway's only flow copy is the opposite of
`loki_data`, which `docker-compose.yml` deliberately excludes from backup.

**DECIDED: ONE REPOSITORY PER GATEWAY for flows.** Gitea's deploy keys are per-repository, so this is
what makes a per-appliance read-only key mean anything: a single flows repository would let every
appliance's key read every other gateway's `flows.json`, and a `flows.json` is the plant's edge
topology, broker addresses and device ids. The fleet-wide diff a shared repository would have given is
the thing given up, and the approvals page is where that view belongs anyway.

**DECIDED: THE PLATFORM PLAYBOOK IS ONE REPOSITORY THE WHOLE FLEET READS, AND GATEWAYS TRACK A TAG
RATHER THAN `main`.** `main` is protected, a Gitea Actions run validates a commit before it may
merge, and **naming a new tag off `main` is a separate manual act** — which is what keeps one merge
from converging every appliance on the next timer. Without it the shared repository has no staged
rollout at all, and the appliance is the one component whose downtime a machine operator sees rather
than an engineer. It is the same review gate this item argues for the flow lane, applied to the
appliance instead.

**Where `target_branch` lives** — deferred to §9, which owns the links-store question, but this item
is what makes it load-bearing rather than cosmetic.

**The actor kind for the audit row.** Logging the revision hash into `digital_thread` needs one: rows
from the daemon and the edge functions are attributed through the `request.headers` GUC, and the
trigger accepts only `ingestion` / `service` / `migration`, never `user`. A sidecar reconciling on its
own timer is a fourth kind of actor and should say so rather than borrow `service`. **§6's proposal
expiry needs the same answer for the same reason** — a timer with no session — so decide it once,
for both.

---

## 8 · The appliance itself, and the code somebody wants to run on it

**Builds on:** [`supabase/functions/gateway-bundle/index.ts`](../supabase/functions/gateway-bundle/index.ts),
which is BUILT · [`gateway-bundle-template/docker-compose.yml`](../gateway-bundle-template/docker-compose.yml)
and its `node-exporter` block · [`bootstrap.mjs`](../gateway-bundle-template/bootstrap.mjs)'s once-only
guard · [`docs/physical-gateways.md`](physical-gateways.md) · the `apikey` gate and its four
deliberate exemptions in [`supabase/envoy.yaml`](../supabase/envoy.yaml) ·
[`scripts/check-gateway-surface.mjs`](../scripts/check-gateway-surface.mjs) ·
[`deploy/k8s/internal-ca.yaml`](../deploy/k8s/internal-ca.yaml) · **§7, which owns the forge and the
puller this reuses, and is a prerequisite for the second half rather than a neighbour** ·
**arrives from a request to run custom data-gathering software on gateways, for legacy machinery,
and is not filed as an issue**

**Two subjects that are one appliance.** Commissioning a gateway should be a command somebody pastes,
and the machine it lands on should be a managed artefact afterwards rather than a box nobody touches
again until it fails. §7 makes a gateway's *flow* reviewable; nothing makes the *appliance* anything.

**The second subject grows a third thing that is not on the appliance at all** — a build plane and a
registry at the centre, because the custom lane's premise is that an engineer pushes a repository and
an appliance ends up running a container. That is new infrastructure with its own trust properties
and it is argued below rather than assumed into the puller.

**THE FIRST HALF WAS BLOCKED AND NO LONGER IS, which is why they are still written as two.** The
one-liner could not be designed until somebody decided how a fresh appliance comes to trust this
platform's certificate; the first entry under *Worth deciding early* now recommends an answer that
needs nothing from a deployment's network, so the transport is a design question again rather than a
waiting one. The OS baseline, the puller and the custom lane depended on none of that in the first
place. **Nothing here should be started as one piece of work.**

### What is already built, so that it is not re-argued

`gateway-bundle` mints a single-use enrolment token through a `SECURITY DEFINER` RPC and streams a
ZIP, holding no service-role key and refusing every role but Administrator and Shopfloor_Manager.
The bundle already carries Node-RED **and** `node_exporter`, with the argument for collecting
locally and never scraping from the centre written out beside it. `bootstrap.mjs` enrols once,
guarded by `/data/.enrolled.json`, retries only a 503 that says the claim was released, and prints
an editor password that exists nowhere else in plaintext.

So the new content here is the **transport** of that bundle, the **operating system** underneath it,
and a **second workload** beside Node-RED. Not the enrolment model, which works.

### The install is a download; the request is a command

Today's path is: generate a bundle in the dashboard, move a ZIP to the appliance, unzip,
`docker compose up -d`, then read the editor password out of the bootstrap logs. Every step is
defensible and the sequence is still a file transfer onto a machine in a machine shop.

The asked-for shape is one line:

```
curl -sSL -H "X-Enrolment-Token: <token>" https://api.<domain>/functions/v1/gateway-bundle | bash
```

**That is the same authorisation model as `enroll-gateway`, not the one `gateway-bundle` has
today.** `gateway-bundle` is a `POST` authorised by a *role*, resolved from a caller's JWT. An
appliance has no user, which is the reason `enroll-gateway` is the one function in the registry that
does not call `resolveUserRole()`. The split to build is therefore: **the dashboard mints
(role-gated), the appliance fetches (token-gated)** — which is a cleaner separation than the current
function's, where minting and packaging are one act.

### Three things the one-liner has to answer, and none of them is the shell script

**THE TOKEN MUST NOT TRAVEL IN THE QUERY STRING.** This repository has already paid for that lesson
once: the Realtime route carries its `apikey` as a query parameter, and `envoy.yaml`'s access log
format records `%ROUTE_NAME%` rather than the path *specifically so the key is not written to disk*.
A `?token=` in a pasted command lands in the operator's shell history, in every proxy between, and in
the gateway's own log unless that trick is repeated. A header costs nothing and is the same decision
already made next door.

**`/functions/v1/` IS GATED ON `apikey`, so the command as written answers 401 before the function
runs.** Opening it is a **fifth** deliberate exemption beside the four `check-gateway-surface.mjs`
already enumerates, and it should arrive as a row in that inventory in the same change — the whole
value of that script is that a route opened and argued for is distinguishable from a route opened by
accident. The alternative is to carry the publishable key in the pasted command too, which makes the
line longer, leaks nothing, and is the cheaper first version.

**THE CA IS A CHICKEN AND AN EGG, AND IT IS THE PART TO DESIGN FIRST.** `internal-ca.yaml` exists
because the target is an on-premises private domain that ACME cannot serve. A fresh Ubuntu install
does not trust that root, so `curl -sSL https://api.<domain>/...` fails verification — and the honest
next line in the documentation becomes `curl -k`, which is the one setting §11 and `envoy.yaml` both
state does not exist anywhere in this stack. **A one-liner that teaches operators to skip
verification is worse than the ZIP it replaces.** The current path evades this by downloading through
a browser session that already trusts the root and installing the CA at step 2 of bootstrap; a pipe
runs before there is a CA. **The four candidate answers and what each costs are the first entry
under Worth deciding early below**, and the recommended one resolves the circularity the way
[RFC 7030](https://www.rfc-editor.org/rfc/rfc7030#section-4.1.1) does rather than by inventing
anything: a fingerprint minted beside the token, checked by the script and never by the operator.

### The fetch must not spend the token

The token is single-use and short-lived, and `bootstrap.mjs` is built around the fact that a failed
first boot cannot be retried. If **downloading** consumes it, a dropped connection on a shopfloor
Wi-Fi link burns a gateway's enrolment before anything has been installed. Fetching validates;
enrolling consumes. The bundle also generates `NODERED_CREDENTIAL_SECRET` per bundle, so the script
is a secret-bearing artefact: not cacheable, not re-fetchable, and not left in `/tmp` after it runs.

### Ubuntu Server as a requirement, and the seam it closes

Naming one distribution is what makes everything below this line possible: `unattended-upgrades`, a
package set, and a playbook that can assume `apt` and `systemd`. It is worth it. What it costs should
be recorded rather than discovered: the bundle's compose file currently argues that a Windows gateway
*"differs only in which collector is installed and this flow does not change at all"*, because
`windows_exporter` serves the same exposition format. **That seam closes.** Nothing in the repository
depends on it today, but it was a deliberate property and its removal is a decision.

**`unattended-upgrades` must not reboot.** A gateway that restarts mid-shift is an outage on the plant
floor, and the appliance is the one component whose downtime is visible to a machine operator rather
than to an engineer. Security updates without `Unattended-Upgrade::Automatic-Reboot`, and reboots on
somebody's schedule — which is a `system_settings` question if the dashboard is ever to state it.

### `ansible-pull`, not Ansible

**Push is the shape §7 already refuses**, and the refusal transfers exactly: playbooks driven over
SSH from the centre need an inbound path per appliance and a static inventory, and gateways enrol
dynamically so no static inventory can address them. That is the same pair of reasons `node_exporter`
is polled locally instead of scraped.

**`ansible-pull` is §7's sidecar, better specified.** The appliance clones its own repository on a
timer and converges itself: outbound only, no inventory, no inbound SSH, self-healing on a timer
rather than on attention. It also supplies for free the property §5 identifies as the hard part of any
boot-time convergence — **reconcile idempotently rather than rewrite** — which a hand-rolled
`git pull` and reload would have to earn.

**Two playbooks, and the split is the security boundary.** A *platform* playbook owns Node-RED,
`node_exporter`, the CA and the upgrade configuration, and comes from a repository the platform
writes. A *custom* playbook comes from a repository the plant's own engineers write. They are not the
same trust level and must not be the same repository.

### Custom code is a provenance question, not a capability one

**§7's refusal of "a general-purpose orchestrator or job runner in the plant" is about where the code
comes from, and it is easy to misread as being about what the appliance may run.** The thing refused
is *"a component that executes whatever the centre queues for it"* — an appliance taking instructions
from a live queue, with no artefact to review and nothing to diff. Running an engineer's container
from a commit somebody approved is a different object with a different failure mode, and this
platform already states the rule that separates them. `deploy-nodered`'s contract was **deploy only
what is committed**, and it refused an inline flow in a request body for exactly this reason.

So the requirement is admissible on those terms and on no others: **a container built from a commit
in a repository, pulled by the appliance, never a payload handed to it.** The forge is then doing the
work it is good at, the review step is §7's, and there is no second execution path to secure.

**THE REQUIREMENT IS LEGACY MACHINERY, and stating it that way changes what the lane is for.** The
motivating case is not an engineer who wants a scratch container — it is a machine tool from 1994
that speaks a serial protocol, a proprietary file drop, Modbus, or OPC-DA, and that no amount of
Node-RED contrib nodes will reach. Every plant has a different one, the adapter for it is worth
nothing to anybody else, and it is exactly the kind of code that has no business being merged into
this repository. **A lane for bespoke adapters is what makes the platform reach the machines a plant
actually has**, rather than the ones that were bought recently — and it is the strongest argument in
this item, stronger than the onboarding half.

It also sets the bar: an adapter for a legacy machine is long-lived, it is written once by somebody
who then leaves, and it runs unattended for years. That is an argument for the forge and the build
being mandatory rather than convenient — an adapter whose source nobody can find is a machine that
silently stops being observable.

### Nobody builds these images by hand, and that is a third plane

**"Push a repository and get a container" means a BUILD, and a build means a runner and a
REGISTRY.** Gitea supplies both — Actions, and its own package registry — which is a real argument
for it over a bare Git server and should be recorded as one rather than discovered halfway through.
Three consequences, none cosmetic:

**A build runner executes arbitrary code out of a repository.** That is the general-purpose job
runner this item refuses in the plant, sited at the centre instead — where it is a defensible thing
to own and not a free one. It should not share a host with the database: a runner is compromised by
whatever it builds, and the blast radius belongs to a build machine rather than to the platform.

**The registry is a fourth credential plane**, after the broker (§5), the database, and the forge
(§7). The thing that stops it being genuinely new is that Gitea's registry takes the same tokens as
its Git side, so §7's per-gateway **read-only deploy key** can be the pull credential too, revoked in
one place. **That should be measured rather than assumed** — if the two are separate, the appliance
holds two secrets and revocation acquires a second home, which is the shape §5 exists to complain
about.

**"Deploy only what is committed" weakens to "deploy only what was BUILT from a commit"** unless
something carries the claim across the runner. The appliance pulls an image, not a source tree.
Pinning by **digest rather than by tag** is the cheap half — a tag is a mutable pointer, and this
repository already refuses `:latest` everywhere for that reason. Signing the image is the other half,
and it does for the registry exactly what §7 argues commit signature verification does for the forge:
makes the transport and the host untrusted-safe rather than something else to secure.

**ARCHITECTURE IS WHERE THIS FAILS FIRST AND MOST CONFUSINGLY.** Gateways are whatever hardware a
plant already had — arm64 single-board computers and amd64 industrial PCs both, often in the same
plant. An image built for one and pulled by the other fails at `docker run`, on the appliance, after
enrolment, in front of whoever is commissioning it. Multi-arch builds or a declared architecture per
gateway; either is fine, neither is free, and finding out on a shopfloor is the expensive way.

### An adapter exists to produce telemetry, so the boundary has to say how it leaves

**The container is the boundary and it must be a narrow one.** The custom workload gets no broker
credential, no access to `flows_cred.json` or the Node-RED data volume, no Docker socket, and no root
on the host.

**Left there, that boundary contradicts the purpose.** An adapter for a legacy machine exists
precisely to emit data, and a rule that it cannot reach the broker is a rule that it cannot work. The
resolution is not to relax it.

**It publishes locally, and Node-RED forwards.** The custom container speaks to Node-RED over the
appliance's own network — an HTTP endpoint, or a local topic — and Node-RED republishes on the
Sparkplug connection it already holds. Three properties come free. The gateway keeps **exactly one**
broker credential, so `mosquitto.acl`'s `%u` confinement still means what it says, and a compromised
adapter cannot forge another appliance's telemetry. The adapter holds **no platform credential at
all**, so a custom repository can never leak one. And the data arrives having passed through the
flow, which is where schema conformance and the quarantine queue already apply — **an adapter
publishing straight to the broker would bypass all three**, and that it is more convenient is not an
argument.

**The case where that is the wrong answer is worth naming, because it is real.** If a machine's
adapter has its own identity, its own lifecycle and its own address space, it is not a workload on a
gateway — it is a gateway, and it should enrol as one. **One appliance, one identity; a workload that
needs a second identity is a second gateway.**

### Two things this is deliberately not

**Not Portainer.** It is an agent that executes what a central console tells it to, which is the
refused shape above with a good UI on it — and the community edition's limits are the smaller
objection, not the reason.

**Not a k3s agent on gateways.** The connection is outbound, which is the half people check, but the
effect is that the centre schedules arbitrary workloads on plant hardware and the API server dials
back through that tunnel for logs, exec and port-forward. Three further costs, in descending order:
it puts shopfloor machines inside the cluster's flat pod network, which is the trust domain the broker
ACL deliberately does not rely on; it is a **second** reconciler beside the puller, and the two will
disagree; and it makes the edge Kubernetes-only, widening the Compose/chart divergence §11 spends its
length complaining about. A k3s *server* per site is the defensible version of this if fleet-wide
orchestration is ever genuinely wanted, and it earns little over Compose on one appliance.

### What this must not touch

The enrolment token's single-use semantics and the once-only guard in `bootstrap.mjs`. The editor
password's generation *on the appliance* — anything that needs it centrally has re-created the
fleet-wide credential store the current design refuses. `flows_cred.json`, which must not leave the
appliance in a backup, a commit, a diff or a custom container's bind mount. The broker ACL's `%u`
confinement. `node_exporter` staying unscraped from the centre. And the absence of a
skip-verification setting anywhere, which the CA question above puts under more pressure than any
other change in this file.

### Worth deciding early

- **HOW THE APPLIANCE COMES TO TRUST THE PLATFORM BEFORE IT HAS FETCHED ANYTHING. This is the
  gating question, and there is now a fourth candidate worth building.** Nothing else in this item
  can be designed around it, because every version of the one-liner either verifies a certificate or
  teaches an operator not to.

  **FIRST, THE PREMISE THAT THERE IS "THE" CA IS WRONG, AND THE DESIGN FAILS QUIETLY IF IT IS
  ASSUMED.** This deployment has up to four roots and two of them are on an appliance's path:

  | Root | Where it comes from | Who receives it |
  | :--- | :--- | :--- |
  | **Broker (MQTTS)** | `mosquitto.tls.clusterIssuer`, default `acs-cymru-ca` · in Compose an **independent** root minted by [`mosquitto-tls-init.mjs`](../scripts/mosquitto-tls-init.mjs), unrelated to cert-manager | every appliance, from `enroll-gateway`; plus ingestion, i3x and playback via `MQTT_TLS_CA_FILE` |
  | **Ingress (HTTPS)** | `ingress.tls.certManager.clusterIssuer`, default `""` — the values comment offers `letsencrypt-prod` | browsers, and the appliance's own enrolment call |
  | Kubernetes cluster | `kube-root-ca.crt`, projected beside the credential service's SA token | in-cluster only, never distributed |
  | The forge | whatever fronts Gitea, once §7 lands | appliances, for the puller |

  `internal-ca.yaml`'s header points the first two at the same `acs-cymru-ca`, and in that
  arrangement they collapse to one root. **The chart does not enforce it and should not** — a public
  ACME certificate on the ingress with an internal root on the broker is a sensible deployment and
  the values file already suggests it. So an enrolment design that pins "the CA" is correct in the
  documented arrangement and silently wrong in the supported one. **Two pins, or one pin that is
  explicitly the broker's.**

  Note also that `deploy/k8s/README.md`'s *"nothing server-side needs the root … the TLS edge is
  browser-only"* is true of the HTTP hops and not of the MQTTS one: the broker root already has
  three in-cluster consumers before any appliance is counted.

  **1. The root travels ahead of the command, and is pasted rather than fetched.** The dashboard
  prints two blocks: a heredoc writing the PEM to `/usr/local/share/ca-certificates/`, then the
  installer line. It costs the *one*-line property this item is named for, and it has no
  circularity — a root that is fetched has to be verified by something, and a root that is pasted is
  verified by the operator's already-authenticated dashboard session. Two commands that are both
  honest beat one that is not.

  **2. Enrolment alone is served on a publicly-trusted name.** One real DNS record and one real
  certificate, for the enrolment endpoint only; everything after it uses the internal CA the bundle
  installs. It preserves the single line exactly, and it is what makes the `curl … | sh` installers
  people cite as precedent honest — `https://ollama.com/install.sh` verifies because `ollama.com`
  has a real certificate, and copying the shape without the publicly-trusted name is the whole trap.
  It costs the same conversation with whoever runs the network that §11 names as *its* blocker — so
  if it is taken, take it once for both — and it assumes the appliance can reach a public CA's
  issuance and revocation infrastructure at commissioning time, which an air-gapped plant cannot.

  **3. A checksum the operator verifies. WITHDRAWN, superseded by 4.** Recorded so the distinction
  is not lost rather than because it is still a candidate: it moved the trust problem to the channel
  the checksum arrived on, and an operator who is pasting a command will not compare a hash by eye.
  **The eye is the part that was wrong, not the hash.**

  **4. The pin rides in the token and the SCRIPT checks it. RECOMMENDED, and it is a standard rather
  than an invention.** The dashboard already mints a token against an authenticated session; it
  mints a fingerprint beside it, and the pasted line carries both as one opaque blob. Stage 0 fetches
  the root as inert bytes, hashes it, and refuses if it does not match; every stage after that is
  ordinary verified TLS. The operator copies and does not compare. **This is
  [RFC 7030](https://www.rfc-editor.org/rfc/rfc7030#section-4.1.1) §4.1.1 — EST's own answer to its
  own bootstrap problem — and adopting a shape a standard already specifies is half of why it is
  recommended.** Five details decide whether it is sound:

  - **PIN THE PUBLIC KEY, NOT THE CERTIFICATE.** `internal-ca.yaml` sets `renewBefore: 8760h`, so
    cert-manager re-issues the root a year before it expires and every certificate fingerprint ever
    minted into a token becomes wrong on that day. It also sets `rotationPolicy: Never`, so the
    private key survives the re-issue — **an SPKI hash is stable across exactly the event that breaks
    a DER hash.** The cost is three pipes instead of one `sha256sum`:
    `openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | sha256sum`.
  - **SERVE THE PEM OVER PLAIN HTTP, NOT `https` WITH `-k`.** They are equally secure, because the
    pin is doing all of the work in both, and only one of them puts a skip-verification flag in a
    runbook — which *What this must not touch* forbids for reasons that do not stop applying because
    this instance is defensible. The rule to hold instead: **nothing unverified is ever executed or
    trusted.** One inert certificate, hash-checked before use; everything secret-bearing over TLS
    afterwards.
  - **SERVE IT FROM THE INGRESS AS A STATIC FILE, NOT FROM A FUNCTION.** The `apikey` gate is on
    `/functions/v1/`, so a static path costs no fifth exemption in `check-gateway-surface.mjs` and
    nothing has to be argued into that inventory for a file that is public by construction.
  - **THE APPLIANCE MUST CHECK THE CA IT ENROLS WITH AGAINST THE PIN IT WAS GIVEN.**
    [`bootstrap.mjs`](../gateway-bundle-template/bootstrap.mjs) writes `enrolment.ca_cert` blind. In
    the one-root arrangement that check is free and always passes; in the two-root one it is the only
    thing standing between an appliance and a broker root substituted in the enrolment response.
  - **THE PIN HAS A LIFECYCLE AND SOMETHING HAS TO OWN IT.** A root re-issue invalidates every
    unspent token, so the dashboard mints the fingerprint by reading the live root at mint time and
    never from a stored constant. Getting that wrong produces appliances that refuse to install with
    a hash mismatch, which is the correct failure and still one somebody has to diagnose.

  **What decides it is no longer whether this item can start.** Candidate 4 works air-gapped, needs
  no DNS conversation and keeps the single line, so the two deployment facts — public internet at
  commissioning, and whether the root can travel with the hardware — now decide only whether 2 is
  *also* available and whether 1 is preferable for a plant that images its own appliances. **A
  cloud-init or Ubuntu autoinstall seed that plants the root is the zero-circularity answer for
  anyone doing that**, and since this item makes Ubuntu Server a requirement anyway it is nearly
  free. What has not changed: a one-liner that ends in `curl -k` would be a regression dressed as an
  improvement.

- **The script the one-liner pipes into a shell, and the two things that are not design decisions.**
  Recorded here so they are not discovered in review. **`curl -sSL` as written above is missing
  `-f`**: without it curl prints a 4xx or 5xx response *body* to stdout and the shell executes it,
  which is why every installer worth copying — Ollama, rustup, Homebrew — uses `-fsSL`. And **a pipe
  to a shell executes a truncated download**, so the installer wraps its whole body in a function
  invoked on the last line: a short read then defines something and runs nothing. Neither costs
  anything; both are invisible until the day they are not.

- **What the one-liner fetches, and from where — the installer is static and the secrets are not.**
  This item states the fetched artefact is secret-bearing, because the bundle generates
  `NODERED_CREDENTIAL_SECRET` per gateway. That rules out serving one file from the forge, and the
  split it forces is a better shape than the ZIP had: a **static installer**, tagged in Gitea, public
  to read and freely cacheable; and a **per-gateway secret fetch** from `enroll-gateway`, token-gated
  and single-use. The installer then gets §7's own property — *deploy only what is committed* — which
  the ZIP never had, and the token never appears on the cacheable path. **Pin the installer to a tag
  the dashboard renders, not to a branch**: this item's own worry about `ansible-pull` converging the
  fleet to a bad head applies to the installer first and with no timer to wait for.

- **THE PLATFORM SIDE OF THE CERTIFICATE FACT THE FLEET ALREADY REPORTS, which is one value and
  closes the only way this ends badly.** Every appliance reports the expiry of the root *it holds*,
  and the `Gateway CA Expiring` rule alerts on it per gateway — a good design, and half a picture.
  Nothing anywhere reports the root the platform is currently **issuing from**, so the one state that
  matters during a rotation — the fleet trusts a root the broker no longer chains to — is invisible
  until the fleet goes quiet. The credential service already reads `/mosquitto/certs/ca.crt` to
  return it at enrolment; reporting its `notAfter` alongside is a field, not a subsystem. **It must
  not be read from the Kubernetes API.** Asking cert-manager directly would hand the dashboard a
  credential plane it does not have, for a read, and would answer nothing on Compose — where there is
  no cert-manager and the root is a file. The appliance-reports-what-it-holds pattern already spans
  both targets; extend it rather than building beside it.
- **cert-manager belongs nowhere in the dashboard, and the reason is worth writing down before
  somebody proposes it.** Viewing `Certificate` resources needs Kubernetes API access from the
  frontend and is Compose-blind. *Managing* them is worse: a button that mints a root is the most
  destructive control this platform could offer — it succeeds silently and takes the whole fleet
  down, which is precisely the failure the CA-expiry alert exists to catch. The root is a
  cluster-scoped, ten-year, GitOps-managed artefact and `internal-ca.yaml`'s header already argues
  that it must outlive the chart. **What an administrator needs is not a control but a comparison**,
  and that is the bullet above.
- **`trust-manager` is worth adopting for one job and not for the one it is usually adopted for.**
  In-cluster distribution is already solved and solved narrowly:
  `acs-cymru.brokerClientCaVolume` projects **only** `ca.crt` out of the broker's `kubernetes.io/tls`
  Secret, so ingestion, i3x and playback never receive `tls.key`. `trust-manager` would not improve
  on that. Where it earns its place is the static-file half of candidate 4 above: something has to
  publish the root PEM where the ingress can serve it, and a `Bundle` writing a ConfigMap does that
  off-the-shelf without giving the serving pod access to a Secret holding the broker's private key.
  **Adopt it for that, and record that it is for that** — a trust-distribution component adopted for
  general reasons will accumulate general uses.
- **THE APPLIANCE'S CLOCK IS PART OF CERTIFICATE VERIFICATION AND NOTHING IN THIS REPOSITORY MENTIONS
  IT.** A certificate is valid between two dates, so a fresh Ubuntu install whose NTP is blocked by
  the plant firewall — which is the ordinary condition of the networks this platform targets — cannot
  verify a perfectly good certificate. It presents as a TLS failure during commissioning or as MQTTS
  that worked in the workshop and does not on the line, and neither reads as a clock. **This belongs
  in the OS baseline**, which is the unblocked half of this item: a time source in the package set,
  pointed at something the plant can actually reach. It also puts a floor under the enrolment token's
  30-minute TTL, which is compared server-side and therefore survives a wrong appliance clock — the
  certificate check does not.
- **There is no CRL and no OCSP anywhere in this stack, and the absence should be a recorded decision
  rather than an omission.** For a fleet of this size it is the right trade; the consequence is that
  **a compromised root private key has no remedy short of re-minting the root and re-walking the
  fleet**, on a ten-year artefact. What keeps that acceptable is containment that already holds — the
  key never leaves its Secret, is never mounted into an application pod, and never reaches an
  appliance, which receives `ca.crt` alone. Worth stating in the same breath: **broker credentials
  are revocable and immediate** (archiving rotates the account), so the thing with no revocation path
  is the trust anchor and nothing else. `docs/physical-gateways.md` §8 now carries the operator half
  of this; what is missing here is whether the containment is ever *verified* rather than asserted.
- **TLS IS OPT-IN EVERYWHERE IN THIS STACK, AND ONE LEG REFUSES TO RUN WITHOUT IT.** Any review of
  the network posture starts here rather than at the appliance: `ingress.tls.enabled` and
  `mosquitto.tls.enabled` both default `false`, `ingress.tls.certManager.clusterIssuer` defaults to
  `""`, and Compose's `SUPABASE_URL` defaults to plain `http`. The exception is the physical-gateway
  path — `enroll-gateway` **refuses to enrol** an appliance when the credential service returns no
  CA, so that one leg cannot silently come up unencrypted. **There is no equivalent refusal on the
  HTTPS side**, and the one-liner would be fetched over whatever the ingress happens to be serving.
  Whether that asymmetry is deliberate is worth answering before a transport is built on it.

- **Whether the one-liner and the OS baseline ship together.** They should not. The install transport
  is blocked on the trust question above; the baseline is a playbook and is blocked on nothing.
  Bundling them means the blocked half gates the free half — the same argument §11 makes about
  `internalClients` and the loopback bindings.
- **Whether the custom lane is one repository per gateway or one per plant.** §7 asks the same
  question for flows and answers it on deploy-key granularity. Custom code has a different answer
  available — engineers think in projects, not in appliances — and a project deployed to four
  gateways should not be four repositories.
- **Whether the platform builds custom images at all, or only pulls them.** A plant that already has
  a registry and a pipeline may want to point a gateway at an image it builds itself. Supporting only
  "Gitea builds it" is simpler and forecloses that; supporting both makes the provenance claim
  conditional on somebody else's pipeline, which is a claim worth being honest about rather than
  quietly weakening. **Digest pinning is what makes either version defensible**, so decide that
  first and the rest is policy.
- **Whether the deploy key is also the pull credential.** Gitea's registry accepting its Git tokens
  is the assumption holding the credential count at three planes rather than four, and it is one
  command to verify. Measure it before the enrolment path is designed around it, for the reason §5
  gives about a revocation with two homes.
- **What happens to a gateway whose custom container is failing.** Nothing in the heartbeat reports it
  today, and a converging puller will restart it forever. The flow hash is already carried; a
  workload's state and its image digest are two more fields, and the dashboard has nowhere to show
  either. **A legacy-machine adapter that has silently stopped is a machine that has silently stopped
  being observable**, which is the failure this lane is most likely to produce and least likely to
  notice.
- **Whether the platform playbook can roll back.** `ansible-pull` converges to a head. A bad platform
  commit converges the whole fleet to it, on a timer, with no operator involved — which is the one way
  this design is more dangerous than the ZIP. Pinning appliances to a tag rather than to a branch is
  the cheap answer and it should be the default, not the advanced option.

---

## 9 · Retiring the flow-backup bucket, and pointing at repositories instead

**Builds on:** [`frontend/src/components/common/FlowBackupUploader.jsx`](../frontend/src/components/common/FlowBackupUploader.jsx) ·
the `gateway-backups` bucket in [`scripts/storage-init.mjs`](../scripts/storage-init.mjs) ·
[`supabase/storage-policies.sql`](../supabase/storage-policies.sql) ·
[`EntityLinksModal.jsx`](../frontend/src/components/modals/EntityLinksModal.jsx) and its tag vocabulary ·
`digital_thread` (`0005`) · **not yet filed as an issue**

**The other end of §7, and it should be sequenced against it rather than planned beside it.** §7
adds the pull; this removes what the push made necessary. Doing the removal first would leave a
physical gateway with no copy of its flow anywhere, which is the exact loss `FlowBackupUploader`
exists to prevent — its header states the case plainly: the appliance is the only copy, and a failed
SD card takes the plant's edge logic with it, after the enrolment token is already spent. **The bucket
is not dead weight until the pull half replaces what it does.**

**Two premises need correcting before the security argument is scoped.** The bucket takes
**`flows.json`, not zips**: JSON only, 5 MiB, private, MIME-restricted, keyed `<sparkplug_id>/`, and
the uploader already **refuses `flows_cred.json`** — the credential file is the thing that must not
be stored, and it already is not. So "arbitrary zip/script uploads into Supabase Storage" overstates
today's surface. What is true and worth keeping as the argument: a stored flow is *unreviewed* — no
pull request, no revision history, no diff — and that is a governance gap rather than an execution
vector, because nothing in this stack ever executes an object out of that bucket.

**The repository pointer should almost certainly be a tag, not two columns**, and the reason is
already written down. Issue #62 asked for exactly this shape — a URL column on gateways and devices —
and it was deliberately built as a tag on the generic links store instead, because *"a column means a
migration per link type and a second place asset URLs live."* `document_tag` carries no CHECK
constraint, so **adding a `source_repository` tag costs nothing and needs no migration at all**;
`EntityLinksModal` already renders per-entity links with role gating and already writes through
`/api/v1/documents`, whose writes are already audited. A "Manage Source & Docs" modal is largely that
modal with one more tag in `TAG_LABELS`.

**`target_branch` is the part that genuinely does not fit**, and it is worth separating rather than
bundling. A branch is not a URL and has no home in a labelled-link table — so either it rides inside
the URL as a `/tree/<branch>` path, which is lossy but free, or it earns a column of its own. That is
one small decision, not the four-step migration the proposal implies. **Note that the rename this used to collide with has already
landed:** `documents` → `links` shipped in `0049`, so adding a tag to that vocabulary is now a
change to one column on a table that already carries the right name, rather than two migrations
against the same column.

*Cited by the proposal as further reading:*
[Managing Distributed Node-RED Deployments on the Edge](https://www.youtube.com/watch?v=FWeHG6_wTIo).

---

## 10 · An ISA-95 Unified Namespace bridge

**Builds on:** the DDATA path in [`ingestion/ingestion.py`](../ingestion/ingestion.py) ·
`public.device_locations` (`0001`) · `cells` (`0001`, `0021`) · `devices.location_scope` ·
[`mosquitto.acl`](../mosquitto/mosquitto.acl) ·
[issue #66](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/66)

**None of this exists yet — no `uns/` topic appears anywhere in the repository** — and the argument
for it is sound: a BI tool or SCADA client that wants one spindle speed should not have to link a
protobuf decoder and learn Sparkplug's alias rules to get one number.

**The obstacle is that the hierarchy the issue names is not in the schema.** ISA-95 has six levels —
Enterprise / Site / Area / Line / Cell / Asset. This stack has **two**: `cells`, which carries a `name`
and nothing above it, and `devices`. The example path in the issue,
`ACS-Cymru/Factory2050/Cell01/Sim_CNC_Mill_01/SpindleSpeed`, therefore has two segments with no source
— `ACS-Cymru` is the default Sparkplug group id, and `Factory2050` does not exist as data at all. So
the first question is whether the missing levels become configuration (`system_settings`, which is
where [Cold telemetry archival](../supabase/README.md#cold-telemetry-archival-0068) already settled
that this class of value lives) or columns on `cells`. Configuration is right for
a single-site deployment and wrong the moment there are two.

**`device_locations` is the view to build on, and reading `devices.cell_id` directly is the mistake to
avoid** — that column is an override, and `NULL` means *inherit from the gateway*, which is why its
comment says to resolve through the view. The other case the view already answers is the one a strict
tree cannot: `location_scope = 'site_wide'` marks a device asserted to have **no** single cell — a BMS
sensor, an AGV — and it is a legitimate state, not missing data. A UNS path builder has to give those
somewhere real to live rather than file them under a cell they are not in.

**Two smaller things follow from where the translation would sit.** Doing it inside the ingestion
daemon puts a second publish on the same callback thread whose single-writer ceiling is measured in
[The single-writer ceiling](../ingestion/README.md#the-single-writer-ceiling) — worth instrumenting
the same way rather than assuming the headroom absorbs it. And `mosquitto.acl`
grants topic access per role: a `uns/#` tree any gateway credential could subscribe to would let one
machine's credential read the whole plant's telemetry, which the Sparkplug tree's per-node ACLs
currently prevent.

---

## 11 · The transport between services, and the two targets that disagree about it

**Builds on:** [`networkpolicy.yaml`](../deploy/helm/acs-cymru/templates/networkpolicy.yaml) ·
[`deploy/k8s/internal-ca.yaml`](../deploy/k8s/internal-ca.yaml) ·
[`mosquitto/mosquitto-tls.conf`](../mosquitto/mosquitto-tls.conf) ·
`mosquitto.tls.internalClients` in [`values.yaml`](../deploy/helm/acs-cymru/values.yaml) and the
client-TLS block in [`.env.example`](../.env.example) ·
[`_helpers.tpl`](../deploy/helm/acs-cymru/templates/_helpers.tpl)'s DSN helper ·
[`datasources.template.yml`](../grafana/provisioning/datasources/datasources.template.yml) ·
[`check-compose-chart-parity.mjs`](../scripts/check-compose-chart-parity.mjs) ·
**not yet filed as an issue**

### What is already built, so that it is not re-argued

Default-deny NetworkPolicy on Kubernetes, with **both directions generated from one edge list** and a
CI check asserting the pairs are symmetric. An internal CA whose root deliberately lives outside the
chart. TLS on the Ingress and on the broker's 8883 listener with a TLS 1.2 floor. The broker ACL's
`%u` confinement. The `apikey` gate and the single statement of origin policy in `envoy.yaml`. And a
principle worth quoting because the rest of this item leans on it: **there is deliberately no "skip
verification" setting anywhere in this stack**, on the grounds that TLS which does not verify is
indistinguishable from an interception. None of that is in question here.

### The gap is that NetworkPolicy answers *who*, and nothing answers *what is on the wire*

**Every internal hop is plaintext, and four files say so by name.** `sslmode=disable` is written into
GoTrue's DSN on Compose, into the PostgREST authenticator DSN the chart's `dsn` helper builds, and
into **both** Grafana datasources on both targets. PostgREST on 3000, GoTrue on 9999, storage on 5000,
functions on 9000 and `pg_net`'s quarantine call to `node-red:1880` are all HTTP.

**That is a different question from the one the policy layer answers, and it is easy to mistake one
for the other.** A NetworkPolicy makes a path reachable only from the right pod label; it says nothing
about what is legible to something that has already landed on a pod at either end of an allowed edge,
or on the CNI between them. On the Postgres links what is legible is scoped role credentials and every
row in the platform. **The most valuable link in the stack is the one with the weakest transport**, and
the reason is historical rather than considered: these DSNs were written before there was a CA to
issue against, and nothing has revisited them since `internal-ca.yaml` landed.

### The cheapest real move is a switch that already exists and defaults off

`mosquitto.tls.internalClients` moves the ingestion daemon, i3X and Node-RED to 8883 **together** —
one switch for all three deliberately, because they share a trust domain and a partial migration
would only create a configuration nobody tests. All three **fail closed** if the CA is unreadable.
The NetworkPolicy edge list already derives `$brokerPort` from the same flag, so the policy follows
it without editing. Compose has the equivalent in `MQTT_TLS_ENABLED` / `MQTT_TLS_CA_FILE`.

**It is off by default on both targets, and the default is the whole of the work.** Turning it on is
not a feature; deciding it is the supported posture, and moving the documentation and CI to match, is.

### Postgres is the link worth taking next, and it is the one with real cost

The internal CA already issues leaves, so the certificates are not the problem — the DSNs and the
naming are. `require` gets encryption without solving verification; `verify-full` is the target and
needs the certificate to name the service the client dials, which on Compose is a container name and
on Kubernetes a Service DNS name. **Compose has no cert-manager**, so this is the point where the two
targets need separate mechanisms for the same property, which is exactly the divergence the rest of
this repository spends its effort preventing.

### The two targets disagree about security posture, and nothing compares them

`check-compose-chart-parity.mjs` exists because work landed on Compose and the chart did not follow,
six times in one branch — and it now compares the two targets **as sets of services**. It does not
compare their posture, and on posture they are not close: **the whole default-deny layer is
Kubernetes-only**, and Compose has no equivalent and no seam for one. That is a defensible position —
a single-host Compose stack has a Docker network rather than a cluster — but it is currently an
undocumented one, and "Compose is a supported target" is stated elsewhere in the repository as a
constraint on other decisions. **What is missing is the statement of what Compose is and is not
expected to enforce**, so that a control present on one target and absent on the other is a recorded
decision rather than a discovery.

### The published-port surface has been narrowed, and this records what is left of it

**The two database ports have landed on `127.0.0.1` and left this list on 2026-09-06.** Compose bound
`5433:5432` and `${SUPABASE_DB_PORT:-54322}:5432` on all interfaces. The reason they were published is
recorded in `deploy/k8s/README.md` and in CI, and it is **collision avoidance with a local Postgres**
— the *number* is what mattered, and `127.0.0.1:5433:5432` avoids the collision identically while
taking two databases off the host's network. `scripts/test-db.mjs` published its throwaway container
the same way and now does not: short-lived changes how long the exposure lasts, not what it is.

**The ingestion metrics endpoint went with them, and its own premise had expired.** `9108` carries no
credential — [`ingestion/metrics.py`](../ingestion/metrics.py) draws a careful line around what may
appear there precisely because of that — and the block publishing it argued that the port had to be
open because "this stack ships no Prometheus" to scrape it. One was added (issues #22 and #24), and
[`prometheus/prometheus.yml`](../prometheus/prometheus.yml) targets `ingestion:9108` over the compose
network exactly as it targets node-exporter. The host mapping was never what made the endpoint
scrapeable, and once the scraper arrived it stopped being what made it reachable either.
`curl localhost:9108/metrics` is unaffected.

**The rule all three were measured against** is stated beside prometheus in `docker-compose.yml`: a
port is published broadly because it either **authenticates** (Grafana, the frontend, Node-RED) or is
**a protocol endpoint that has to be reachable** (the broker). None of the three satisfied either
clause. Note that the precedent this item used to cite — Studio's `127.0.0.1` binding — no longer
exists: `0081` replaced it with a login on the gateway's studio listener (§ the note at the head of
this document), so Prometheus is now the standing example rather than one of two.

### What is still published, and has not been argued either way

`swagger-ui:8088` serves static documentation with no credential. `i3x-service:8090` requires a caller
JWT and passes it to PostgREST, so RLS decides what it returns. Neither is in the class of a raw
Postgres port, and neither is claimed here to be wrong — what is missing is that the file now records
a decision beside every port that was narrowed and beside none of the ports that were not, which is
the same asymmetry this item complains about between the two targets.

### Compose publishes ten ports where Kubernetes publishes nine hostnames

The two targets do not disagree about security here so much as about **shape**, and this is the last
place where a Compose stack looks nothing like the chart.

`templates/ingress.yaml` gives Kubernetes one entry point and routes by hostname:
`grafana.<publicBaseDomain>`, `nodered.<…>`, `app.<…>`, `studio.<…>`, `docs.<…>`, `i3x.<…>`,
`git.<…>`, `mqtt.<…>` and the gateway, every host derived from the same helper the service itself is
configured from. **No port numbers anywhere.** Compose reaches the same services on ten published
ports, and a URL carrying `:3002` is a URL that only works if the reader knows which machine to put
in front of it.

**The forge adds the one route that cannot be solved this way, and it should be said here rather
than discovered.** Git over SSH is TCP, so `git.<domain>` covers the web UI and nothing an appliance
actually clones with — the chart publishes a second LoadBalancer for it exactly as raw MQTT has one.
A Compose proxy would inherit the same split.

**This extends `supabase-envoy`; it does not add a proxy.** The instinct is to reach for Caddy or
Traefik, and it is the wrong one — the stack already runs Envoy, with a gateway listener on 8000 and
Studio's OAuth listener on 8001, and a third listener on :80 routing by `Host` to grafana, node-red,
swagger and the gateway is ordinary virtual-host configuration in a file that already exists. A
second proxy would be a second control plane and a second place for origin policy to be stated,
which is the thing `envoy.yaml` is deliberately the single home for.

**Subdomains, not paths, and that argument is settled** — `ingress.yaml`'s header records it:
Grafana needs `serve_from_sub_path` plus a matching root_url, Node-RED needs both `httpAdminRoot` and
`httpNodeRoot` moved (which changes the quarantine webhook path, and that path is registered in the
database in `webhook_endpoints`), and Studio is a Next.js app with its own basePath assumptions.
Whatever lands on Compose should mirror the chart rather than re-open that.

**The blocker is DNS, and it is not in this repository.** `grafana.acs.plant.local` has to resolve,
which means a wildcard record on a DNS server this project does not own. That is the whole reason
this is a roadmap item and not a branch: the proxy is a day's work and the record is a conversation
with whoever runs the network, and shipping the first without the second produces a stack whose
documentation says "now ask IT", which nobody does. The chart's own dev path shows the escape hatch —
`e2e.ingressIp` and the `127.0.0.1.nip.io` domain exist precisely because a real record was not
available — and a Compose equivalent should be designed in from the start rather than discovered.

**What it does and does not buy.** It gets one port to firewall instead of ten, one TLS
certificate instead of none, and URLs that survive being pasted into a message. It does **not** fix
what the Directory displays: `directory_services.endpoint_url` is a stored string, and a proxy in
front of Node-RED does not change it. That is `0085`'s job and it is sequenced first for this reason —
until the rows are derived from `NODERED_PUBLIC_URL` and its neighbours, a proxy would serve
`nodered.<domain>` while the Directory kept advertising `localhost:1880`.

**MQTT does not ride it.** Raw 1883/8883 is TCP and cannot be routed by `Host`; only the WebSocket
listener on 9001 can. The chart already splits these — the Ingress carries 9001 and the
`mosquitto-external` LoadBalancer carries the rest — and Compose would keep publishing the broker's
ports directly for the same reason.

### Plaintext 1883 is deliberate today and should have an end state

The listener stays open because in-network services speak to the broker over the Docker network, and
the NetworkPolicy comment correctly explains that a fleet migrates gateway by gateway, so a window
where both ports are in use is the normal state rather than an edge case. **What is missing is that
the window has an end.** `mosquitto.external.plaintext` already gates the external half; once
`internalClients` is on, nothing on either target needs 1883, and the default should say so.

### A service mesh is the complete answer and is the wrong size

Automatic mTLS on every HTTP hop, with identity-based authorisation that pod-label selectors only
approximate, is genuinely what the first section asks for. It is also a second control plane, a proxy
in every pod, and a second identity system beside the CA this deployment already runs — **and it does
nothing for Compose**, so it would widen the divergence above rather than close it. Per-service TLS
issued by the CA that already exists reaches most of the same place on both targets. **Revisit if
Compose stops being a supported target**, which is the same condition `envoy.yaml` attaches to
HTTPRoute, and for the same reason.

### The gateway link's upgrade is client certificates, and it is sequenced behind §5

`mosquitto-tls.conf` states the current position and its cost explicitly: password authentication over
TLS, `require_certificate false`, because turning it on means `use_identity_as_username` replaces the
password file "at which point the ACL's `%u` no longer matches the sparkplug_id the provisioning
script writes."

**That objection has an answer: issue the client certificate with `CN = <sparkplug_id>`, and `%u`
matches again** — `mosquitto.acl` needs no change at all. `enroll-gateway` already mints a per-gateway
credential and already writes the CA into the bundle, so returning a signed client certificate fits
the enrolment model that exists rather than replacing it. The gain is that a gateway's identity stops
being a bearer secret that can be replayed by anything that reads it.

**The cost is revocation, and it is why this waits.** Mosquitto's `crlfile` is awkward and needs a
reload to take effect — which is precisely the gap §5 exists to close, and §5's own strongest argument
is already that *a revoked gateway which is already connected keeps publishing*. Client certificates
make that sharper, not softer. **This is the intended direction; it should not start before §5.**

### What this must not touch

The `%u` confinement in `mosquitto.acl`, which is enforced independently of transport and is not
improved by any of this. The origin policy's single home in `envoy.yaml` — encrypting a hop is not a
reason to state CORS a second way. The internal CA root's residence outside the chart. The
fail-closed behaviour of every TLS client here, and the absence of a skip-verification setting: a
switch added "temporarily" to get past a naming problem during this work is the one change that would
leave the stack worse than it started.

### Worth deciding early

- **Whether Compose is in scope for the posture, or only for the transport.** Encrypting hops is
  achievable on both targets; a policy layer is not. Saying so plainly is better than a chart that is
  hardened and a Compose stack that is assumed to be.
- **`require` or `verify-full` for Postgres.** `require` is a week's less work and stops a passive
  reader; only `verify-full` stops an active one, and the difference is entirely in the certificate
  naming, not in the client configuration.
- **Whether `internalClients` and the loopback bindings flip in the same change.** They should not.
  One is a transport migration with a fail-closed mode; the other is two lines and no runtime risk,
  and bundling them means the risky half gates the free half.
- **Where the posture statement lives.** `check-compose-chart-parity.mjs` compares the targets and
  prints known gaps on every run precisely so a gap nobody is looking at cannot hide — which makes it
  the natural home for "Compose does not have a policy layer, and here is what stands in for it",
  rather than a paragraph in a README that nothing checks.

---

## 12 · The other half of every drop counter, which is a log nothing keeps

**Builds on:** the drop counters and their paired `logger.warning` in
[`ingestion.py`](../ingestion/ingestion.py) · [`ingestion/metrics.py`](../ingestion/metrics.py) ·
[`grafana/provisioning/datasources/datasources.template.yml`](../grafana/provisioning/datasources/datasources.template.yml)
· [`deploy/helm/acs-cymru/templates/obs/`](../deploy/helm/acs-cymru/templates/obs) ·
[`docs/incidents.md`](incidents.md) · `alerts.retention_days` in `system_settings` (`0032`) ·
[`0079`](../supabase/migrations/0079_the_thread_stops_growing_without_end.sql) ·
**arrives from the 2026-09-05 ethos audit, and is not filed as an issue**

Ship a log store, and query it from the Grafana that is already provisioned. There is none today — no
Loki, no Alloy, no fluent-bit, no OpenTelemetry — on either target. Metrics are well covered and logs
are `docker logs` and `kubectl logs`.

### The instrument was designed in two halves and one of them was never deployed

This is the argument, and it is stronger here than the general case for log aggregation, because the
daemon's diagnostics were **deliberately** built as a pair. From `ingestion.py`, beside the counter
registry:

> Every `drop` reason below corresponds one-to-one with an existing `logger.warning`, so the counters
> and the log cannot disagree about what happened.

That is a good design and Prometheus holds exactly half of it. `acs_ingestion_dropped_*` says a drop
happened and how many; the half naming **which device, under which edge node, and why** exists only
in a line nothing retains. On Compose it survives until the container is recreated. On Kubernetes it
is gone when the pod is rescheduled — which is the moment an operator is most likely to be looking.

`0026`'s `record_ingestion_rejection()` is the counter-example that proves the shape is wanted: a
payload judged non-conforming gets a durable, queryable row rather than a log line. That path was
built because a warning was not enough. It covers one class of event, and every other drop reason is
still only a warning.

### The second argument is that `docs/incidents.md` exists

Its first entry is the broker password file truncated by a re-entered one-shot. Two properties, both
recorded there:

> **It is invisible when it happens.** Mosquitto keeps authenticated accounts in memory, so the
> running stack carries on working perfectly. The loss only appears at the broker's next reload or
> restart, by which point nothing connects the two events.

Connecting two events hours apart, across two containers, from evidence written at the time, is the
one thing log aggregation does and nothing else in this stack does at all. That file is a record of
faults diagnosed the hard way; several of its entries were reconstructed from logs that happened to
still be there.

### Why the argument that refused Grafana over cold storage does not transfer

Rendering archived ranges in a dashboard was declined on the grounds that it would add *"a container,
a gateway route and an auth surface over raw plant history"*, for a resolution nothing charts. That
reasoning was right and it should not be quietly reused here in either direction.

This pays **one** of those three costs — though it turned out to be **three containers, not
one**, and the correction is recorded here rather than left to be found in the compose file. The
store needs a collector (the daemon pushing its own logs would miss Mosquitto's, which is exactly
what the incident above turns on), and the collector needs a socket proxy because it is not being
handed the Docker socket. The rest of the sentence held. No gateway route — the store is reached
by Grafana over the container network, not published. No auth surface — it is a datasource beside the
three `datasources.template.yml` already provisions, behind the Grafana login that already exists,
with no new principal and no second place to manage access. And unlike archived telemetry, there is
something to chart: the drop reasons already have counters, so the log is the drill-down from a panel
that exists rather than a new question nobody asks.

### What it must not become, and this is the part to argue before building

**Every other store in this stack has a retention answer, and a log store would arrive without one.**
Telemetry has a retention window and rollups; the cold archive has tiering; `platform_alerts` prunes
on `alerts.retention_days` with a bound in `system_settings`; `digital_thread` stopped growing without
end in `0079`. Logs would be the only durable store in the repository with no policy, and log volume
does not scale with plant size the way any of those do — it scales with fault rate, which is highest
exactly when nobody has time to look at disk.

**And logs are not the audit trail.** `digital_thread` is append-only, immutable by trigger, attributed
to an actor, and split into two lanes one of which an engineer cannot read. A log store has none of
those properties and must never be presented as though it does. The risk is not technical, it is that
"we have the logs" starts being offered as an answer to a question `digital_thread` is the answer to.
Anything in a log line that matters for audit belongs in a row.

**What the lines contain is a disclosure decision.** The daemon's warnings carry `sparkplug_id`s and
edge-node names; the broker's carry client ids and source addresses; a flow describes the plant's edge
topology, which is why `flows.json` backups sit in a private bucket. Aggregating all of it into one
searchable place is a real concentration, and the Realtime timing side-channel under
[Accepted risks](../README.md#accepted-risks) is the precedent for how that gets argued rather than
assumed.

### Worth deciding early

- **Whether it is enabled by default, and on which target.** The chart gates observability behind
  flags and Compose largely does not. Defaulting on for local development and off for the chart is
  defensible; the two defaults differing silently is not — and by the README's own rule that would need
  a divergence row.
- **Retention and a size ceiling, chosen in the same change as the store.** Both belong in
  `system_settings` if an Administrator is expected to own them, and the `min_value` / `max_value`
  bounds are already there for exactly this. A retention setting added later never gets added.
- **Whether it collects from the edge.** A physical gateway's Node-RED logs are where an enrolment
  failure is legible, and they are also on hardware outside the cluster, on a link that is not
  assumed to be up. Almost certainly out of scope for a first version, and worth saying so rather than
  leaving the boundary to be discovered.
- **Whether structured logging comes first.** ~~`logging_config.py` is 33 lines of plain
  formatting.~~ **DECIDED, AND DONE — see *What has landed* below.** It was the smaller change and
  the one that decided how useful the store will be, so it went first and the store now has fields
  to land on rather than prose to parse forever.

### What has landed: the store itself, on Compose

**Grafana Loki, single binary, filesystem backend**, with Grafana Alloy collecting and a read-only
socket proxy in front of the Docker API. Configuration and the reasoning are in
[`loki/loki.yaml`](../loki/loki.yaml) and [`alloy/config.alloy`](../alloy/config.alloy); the three
services and the argument for each are in `docker-compose.yml`.

**The store choice came down to one property.** Loki's Grafana datasource is a **core** type, so it
joins the three already in `datasources.template.yml` with no plugin, no boot-time fetch and no new
failure mode. VictoriaLogs is lighter and worth revisiting if the footprint hurts on the shopfloor
host, but its datasource is a plugin. OpenSearch is JVM heap on a machine `node-exporter`'s own
comment says can be taken down by filling one disk.

**A Postgres table was the tempting zero-container answer, and it cannot work.**
`dropped_db_unavailable` is one of the ten drop reasons. A log store inside the database cannot
record the database being unreachable, so the line most worth keeping is the one guaranteed to be
lost — and it collects nothing from Mosquitto, Envoy or Node-RED without a shipper anyway, so it
does not even save the collector.

**The four decisions, answered:**

* **Retention and the ceiling shipped in the same change**, as the item required, and as
  DEPLOYMENT CONFIG rather than `system_settings` — which is what `prometheus` already does one
  service up, with the reasoning spelled out beside both of its flags. A `system_settings` row
  with no consumer able to honour it would be the setting the schema's own comment forbids: *"a
  value the table accepts and the consumer then ignores is a setting that lies."*
* **The window is 30 days, matching Prometheus deliberately.** A log window shorter than the metric
  window is the worse of the two errors — the drill-down from a 30-day panel would dead-end.
* **The ceiling is three settings here and was one flag on Prometheus.** Loki has no byte bound on
  the store; `ingestion_rate_mb` bounds the rate at which bytes can arrive, which reaches the same
  place from the other end. That asymmetry is why it had to ship in this change: it is more
  fiddly than Prometheus's and therefore more likely to be the thing left for later.
* **Enabled by default on Compose, absent from the chart**, with the divergence row written in the
  same commit — and the honest reason recorded, because the naive version is backwards. The
  KUBERNETES case is the stronger one, since `kubectl logs` dies at reschedule. The chart declines
  anyway for the reason it declines to deploy a Prometheus: a cluster is assumed to have one, and a
  second store would duplicate every line and give an operator two places to configure retention.
  The **datasource** is provisioned on both targets, pointed at `grafana.lokiUrl`.
* **Edge collection stays out of scope**, and the boundary is now stated rather than left to be
  discovered. The structural reason is worth keeping: a gateway that never enrolled holds no
  credential, so it has no channel to ship logs over — the most valuable gateway log is the least
  reachable one, and enrolment-time logging is a different problem from steady-state logging.

**THE DOCKER SOCKET IS THE DECISION MOST WORTH REVIEWING.** Alloy discovers containers through the
Docker API, and the usual way to grant that is a socket mount. Nothing in this repository mounts
that socket, and `:ro` on a socket mount is theatre — it makes the socket FILE read-only and grants
the full API behind it, including creating a container that bind mounts the host's root filesystem.
A stack that removed `--web.enable-lifecycle` from Prometheus because it exposed a remote shutdown
does not then hand out the socket to label log lines. So the mount lives in
`docker-socket-proxy`, which allowlists by API path group: `CONTAINERS: 1`, `POST: 0`, and every
other group named and refused. The socketless alternative — reading the container log files
directly — needs no proxy at all, and was rejected because the only identity in those paths is the
container ID, which changes on every recreate and names nothing a human recognises.

**What is NOT done: Kubernetes.** The chart deploys no log workload by decision, but the DaemonSet
side of that decision — what a cluster operator is expected to run, and what the divergence row
promises the datasource will find — is documented rather than exercised. Nothing in CI stands up a
Loki behind the chart's datasource.

**The pins and both configs were verified against the images themselves**, not against
documentation — which is the lesson `servicemonitors.yaml` records at length, having had a metric
name *"wrong in both directions"* by reading changelogs. All three tags resolve
(`docker manifest inspect`), `loki -verify-config` accepts `loki/loki.yaml` on `3.5.7`, and both
`alloy fmt` and `alloy validate` accept `alloy/config.alloy` on `v1.11.2` — the latter resolving
every component reference in the pipeline, so a misspelled block or a dangling `forward_to` would
have failed there. The file is stored in `alloy fmt`'s canonical form so a future format check
finds nothing to change.

**It has since been run against the live stack**, which is where the two real defects were, and
neither was visible to any static check.

* **The socket proxy's allowlist was too narrow, and the failure was total rather than partial.**
  `discovery.docker` computes network labels for every target it finds, so it calls `GET /networks`
  immediately after `GET /containers/json`. With `NETWORKS: 0` the proxy answered 403, Alloy logged
  *"Unable to refresh target groups"*, and **discovery failed wholesale — nothing was collected at
  all**. `alloy validate`, `docker compose config` and `loki -verify-config` all pass on that
  configuration, because none of them can know what an allowlist will refuse at run time. Now
  `NETWORKS: 1`, which with `POST: 0` is still read-only and discloses this stack's own network
  name to a container already attached to it.
* **Loki added a label the design did not ask for.** Loki 3 derives its own `service_name`, so the
  first run produced four labels where `alloy/config.alloy` documents two. It costs nothing in
  cardinality, being 1:1 with `service`, and it was turned off anyway (`discover_service_name: []`):
  a label set that does not match the file documenting it is how the next reader learns to
  distrust the documentation. Confirmed against the live index, where the same container splits
  into two streams either side of the restart.

**What the live run confirmed, rather than assumed:** 25 compose services discovered and labelled
correctly through the proxy; `detected_level` attached as STRUCTURED METADATA and not as a label,
so it multiplies no streams; twelve streams total against a 5000 ceiling; and the drill-down query
itself —

    {service="ingestion"} | json | reason = "gateway_binding"

— resolving against a line produced by the real `JSONFormatter`, with a negative control on a
reason that did not occur returning nothing. The delete API was exercised in passing to remove the
test stream.

**One first-start behaviour that alarms and should not.** Attaching a collector to containers that
have been running for days ships days of history at once, and Loki refuses the parts older than
what it has already accepted for that stream — *"entry too far behind"*, HTTP 400. Those refusals
are correct, they stop by themselves once each stream catches up, and a stack started cold never
sees them. Recorded in `loki/loki.yaml` beside the setting rather than left for someone to
diagnose at the worst moment.

### What has landed: the pipeline is connected, and monitored

**`LOG_FORMAT=json` is now set on `ingestion` and `playback` on BOTH targets**, in
`docker-compose.yml` and in the chart. The code default stays `text`, which is a different claim
and a deliberate one: someone running the daemon by hand is reading with their eyes, and a daemon
writing into a store is being read by a query. Setting it on both targets rather than only on the
one with a store means the daemon behaves identically on each, so no divergence row is owed — the
store is the divergence, the log format is not.

Verified end to end on the live stack: the daemon emits JSON, Alloy ships it, and
`{service="ingestion"} | json | level = "INFO"` parses real lines back out with `level`, `logger`
and `msg` extracted as fields. Grafana's Loki datasource reports *"Data source successfully
connected"*.

**A rebuild is required, not a recreate.** `docker compose up --force-recreate ingestion` picks up
the new environment variable and the OLD code, because `logging_config.py` lives in the image — the
container came up with `LOG_FORMAT=json` set and went on writing text. `docker compose build
ingestion playback` first.

**The drop panel exists now, and §12's claim about it was ahead of the repository.** The item said
the log is *"the drill-down from a panel that exists"*. It was not: `acs_ingestion_messages_dropped_total`
appeared in `alert-rules.yaml` and in no dashboard at all. **Messages Dropped by Reason** is now on
*Stack & Ingestion Health*, in the Ingestion row, stacked so the first question it answers is "are
we losing anything", with a data link that opens the log store filtered to whichever reason was
clicked. That link is the drill-down the whole item is arguing for, and it works because the label
and the field carry the same string.

**Four alert rules, because there are four distinct failures and two are invisible.**
`up{job="alloy"}` catches a dead collector. A rate on `loki_write_sent_entries_total` catches the
collector that is UP and shipping nothing — the failure that looks exactly like a quiet plant, and
the one the first live run actually had. `loki_write_dropped_entries_total{reason=~"rate_limited|stream_limited"}`
catches a configured ceiling biting, which is what stops the rate bound silently eating evidence
during the fault it was sized for. `ingester_error` is excluded on purpose: it is the benign
first-attach backfill, and alerting on it would train people to ignore the group. **The fourth was
added after the other three and is the reason the count changed**: a rate on
`loki_source_docker_target_parsing_errors_total` catches the collector that is reading a container
and failing to decode it — see *What remains* below, where this was item 2.

Prometheus scrapes both `loki` and `alloy` — the pair whose own failure would otherwise destroy the
record of itself. Both targets confirmed `up`.

### What has landed: the fault path, under test

**`test-harness/test_log_pipeline.py` drives a real drop and asserts both halves of it**, in the
`stack` lane against a running stack. It publishes a DDATA for a randomly generated unregistered
device, then requires BOTH that
`acs_ingestion_messages_dropped_total{reason="quarantined_or_unregistered"}` increased AND that a
line carrying that same reason **and that device id** arrived in Loki. Prometheus cannot name the
device — its endpoint is unauthenticated and carries no device data by design — so this is the
assertion that the half this item exists to keep is actually being kept. Verified live: 8 passing,
1 skipped.

**The random id is load bearing.** The daemon caches negative resolutions, so a fixed id is
answered from cache on the second run of the day and drops nothing — the suite would pass while
testing nothing at all.

**Two couplings are now guarded statically, because both fail silently.**

* **The multiline regex is a restatement of the formatters**, in another language and another
  directory. `alloy/config.alloy` rejoins Docker's one-entry-per-line output by matching what
  starts a record — a `{` or this repository's ISO 8601 timestamp. Change `UTCFormatter`'s format
  and the collector goes on matching the old shape: every line becomes a continuation of the one
  before, records merge, and nothing fails. The test reads the regex out of the collector config
  and applies it to what the formatters actually emit.
* **The drill-down link crosses three files in three languages.** The collector must label
  `service`, the daemon must log `reason`, and the panel must select and filter on both. Any one
  can change alone, reviewed by people with no cause to open the other two, and the failure is
  silent — Explore opens, the query is valid, and it returns nothing. "No logs" and "wrong label"
  are indistinguishable from the browser.

**AND THAT SECOND GUARD FOUND A REAL DEFECT IN WHAT HAD ALREADY SHIPPED.** The panel's link
selects `{service="ingestion"}`. Compose's collector sets that label; **a stock Kubernetes log
stack does not** — it labels streams `namespace`/`pod`/`container` and sets no `service` at all.
The dashboard is mirrored into the chart, so it was shipping to clusters with a drill-down that
connects, validates, and resolves to nothing. That is now a stated **label contract**: a cluster
feeding `grafana.lokiUrl` must relabel `service` to the workload name. It is one rule in whatever
collector the cluster runs, and it is written in the divergence table, in `values.yaml` beside
`lokiUrl`, and in the panel's own description — so the person who clicks a dead link finds out why
from the thing they clicked.

### What remains, and where to pick each one up

Two things, neither blocking the store being useful, each written with its entry point so it can be
started cold. **They are listed smallest first, which is also roughly least valuable first.**

**There were four, and all four are now accounted for.** The collector's own parsing errors were
item 2 and are the fourth rule in the `Log Pipeline` group. The backup question was item 4 and has
been ANSWERED rather than built. The multiline stage was item 1 and is now under test — the
paragraph after next says how, because the entry said it could not be done cheaply and it was
wrong. **One of the two below is new**, arriving from that work. The remainder are renumbered to
close the gap, which is safe here for the same reason it is safe for the items themselves: nothing
cites them.

**The backup answer, because a decision recorded only as a deletion is a decision nobody can find
later.** It is the one this entry guessed at — logs are not backed up, deliberately — and the
reasoning is what makes it more than a shrug. This store exists to answer a question somebody is
asking during or shortly after a fault; a restored copy of last month's logs answers a question
nobody is still asking. Everything from those lines that matters beyond the incident is already
kept as a ROW and already in the tier 1 dump: `digital_thread` is the audit trail and carries the
conformance record as `SCHEMA_REJECTION`, and `platform_alerts` is the alert history. Backing the
logs up as well would be a second, weaker copy of records captured properly, plus the noise the
thirty-day window exists to expire. **So the omission that item flagged was the write-up and not
the policy**, and it is now written in the three places someone meets the question: the `loki_data`
volume comment in `docker-compose.yml`, the *WHAT THIS DOES NOT DO* header of
`scripts/backup-databases.sh`, and
[Backup and Recovery](../supabase/README.md#backup-and-recovery). The contrast with
`mosquitto_certs` is stated at the volume, because the two sit in the same list and `docker volume
rm` means something very different to each. And a tier 2 snapshot captures `loki_data` anyway, as a
side effect of capturing the machine — recorded as a side effect and not a promise, so no retention
story gets built on it.

**1 · A container discovered after the collector starts has its first lines stored TWICE. (Small,
and new.)**
Found by building the multiline test below, and it is the one thing that work turned up which is
not yet explained. A probe container started while Alloy was already running produced four lines in
`docker logs` and **seven** in Loki: the traceback arrived once correctly rejoined onto the JSON
record before it, and once again as an orphaned three-line entry carrying the same timestamp.
Reproduced twice, and it is not the stdout/stderr split -- merging the two with `2>&1` inside the
container changes nothing. **The blast radius is small and was measured rather than assumed**: the
real `ingestion` container holds 38 entries over thirty minutes with ZERO duplicates, so a
long-running service is unaffected. What is affected is a container in its first seconds, which is
a service that has just been restarted or has just crash-looped -- when its log is worth most. The
15s `refresh_interval` on both `discovery.docker` and `loki.source.docker` is the first place to
look: the duplicate window lines up with a target being re-synced mid-stream. **Entry point:** the
probe in `test_log_pipeline.py` reproduces it on demand, which is the hard part already done.

**2 · The Kubernetes side is contract-checked but not EXERCISED. (Medium.)**
The chart ships the datasource pointed at `grafana.lokiUrl` and deploys no log workload, which is
the decision. What follows from it is untested: nothing stands a Loki up behind that datasource,
and the `service` label contract -- which a stock cluster log stack does NOT satisfy -- is asserted
in prose and in the divergence table rather than by anything that runs. The k3d job in CI is the
place this would live. **Note the failure it would catch is the one already found once by hand: a
datasource that connects, a health check that passes, and every query returning nothing.**

### What has landed: the multiline stage, proven rather than waited for

**The entry said this could not be closed cheaply and that was wrong, which is worth recording
because the reasoning was sound and the premise was incomplete.** It argued that provoking a
traceback meant either a fault-injection path in the daemon or restarting a service mid-suite. It
needs neither. Alloy derives `service` from the compose LABEL, so a THROWAWAY CONTAINER carrying
`com.docker.compose.service=ingestion` is collected by the same pipeline, matches the same
`stage.match` selector and passes through the same `stage.multiline`. Nothing in the daemon changes
and no running service is touched. The probe runs the DAEMON'S OWN IMAGE and calls
`logging_config.get_logger`, so the first line comes out of `JSONFormatter` rather than being typed
into the test — a test that wrote that line by hand would assert the collector against a
restatement of the format instead of the format.

**And the shape being tested is not the one the entry assumed.** Under `LOG_FORMAT=json`, which
both targets set, a HANDLED exception is not multi-line at all: `JSONFormatter` puts it in the `exc`
field and `json.dumps` escapes the newlines. So `exc_info=True` never reaches the stage. The stage
earns its place on the UNHANDLED case, where Python writes a raw traceback straight to stderr with
no formatter in the path — a daemon dying, which is when the log matters most and is the only shape
that gets there. An item written around `exc_info` would have tested a path that no longer exists.

**The counter-intuitive half is now asserted rather than assumed.** `Traceback (most recent call
last):` matches neither `{` nor an ISO timestamp, so it does not OPEN a block — it is appended to
the record above it. A crash therefore arrives glued to the last line the service logged before it
died, under that line's timestamp. That is correct for this configuration and it is what the test
requires, rather than the tidier thing a reader might expect.

**The test was verified by BREAKING the thing it watches**, which is the only way to know an
assertion can fail. Narrowing the `stage.match` selector to `playback` alone and restarting the
collector makes it fail with the damage visible in the output: the `RuntimeError` line arriving as
its own entry, severed from the `Traceback` header. Restored, it passes. Ten of ten in the suite.

**It also exposed a race in a sibling test, which is now fixed.** The drill-down-contract assertion
queried the store ONCE, and it runs before the polling test alphabetically — so on a stack where
the drop had happened but the line had not yet travelled daemon → Docker → Alloy → Loki, it failed
with *"no logged drop reasons"*. That reads as a broken drill-down rather than as a race, which is
the worst way for a flake to present. It polls now, like its sibling.

### What has landed: the fields, so the store has something to index

**The pair was enforced by habit, and is now enforced by structure.** Every drop was two adjacent
statements — `count("dropped_<reason>")` and a `logger.warning` — at ten sites, each of which had to
remember to name the same reason. They are now one `drop("<reason>", …)` call that derives both from
a single string, so the counter and the line cannot disagree about what happened: the property
`metrics.py`'s header always claimed, now held by the code rather than by care.

* **`logging_config.py` gained a `JSONFormatter`**, selected by `LOG_FORMAT=json`, promoting
  `extra=` fields to top level. `reason` is the key every drop query starts from, so it is not
  nested under a `fields` object.
* **The text formatter carries the same fields**, appended as `[reason=… device=…]` before any
  traceback. If it did not, a developer reading `docker logs` would be looking at a different
  record from the one the store kept.
* **`LOG_FORMAT` defaults to `text` on both targets, deliberately.** Nothing reads the JSON yet, and
  flipping the default now would change what every operator sees to buy a property nothing consumes.
  **The flip belongs in the change that ships the store** — one visible change with a reason on it.
* **The fields are on the log and not on the counter**, and that boundary is the disclosure argument
  this item asked for, answered rather than assumed. `metrics.py` is served without a credential and
  carries no device data of any kind; `edge_node` appears there only because it is already public on
  the broker. `device` goes on the authenticated half — behind the Grafana login, never published —
  and must not migrate onto the other one.
* **`emit_log=False` suppresses the line and never the counter.** Two sites throttle their warning
  because the traffic arrives every 30s; the counter must still fire per message, or the metric
  reports one drop per throttle window. That asymmetry now lives in the helper's signature instead of
  being re-derived at each site, and a test refuses a constant `emit_log`.

**The assertion that earns its place in CI** is that the logged `reason` field and the Prometheus
`reason` label are the same string, for every reason a site can emit — read out of `ingestion.py`'s
source rather than restated. That is the drill-down contract: a spike on a panel is a link into the
logs only if both halves spell the reason identically, and nothing else in the stack would notice
them diverging, because each half stays internally consistent while meaning different things.

**What this does NOT do is ship a store**, and the four decisions above are still the gate. Two are
now answered by what landed (the disclosure question, and structured-logging-first); retention, the
size ceiling and the default-per-target remain open, and the store choice is bound up with them.

---

## 13 · The appliance clock, and the two failures it causes that look nothing alike

**Builds on:** `TELEMETRY_MAX_AGE_SECONDS` / `TELEMETRY_MAX_FUTURE_SECONDS` and
`_timestamp_is_sane()` in [`ingestion/ingestion.py`](../ingestion/ingestion.py) ·
`metrics_rejected_timestamp` → `acs_ingestion_timestamps_rejected_total` in
[`ingestion/metrics.py`](../ingestion/metrics.py) · the heartbeat's deliberate use of receipt time ·
[`docs/physical-gateways.md`](physical-gateways.md) §8 · **item 8 above, whose OS baseline is where
the fix for half of this lives** · **item 12, which already owns the half of the counter that would
name the appliance** · **arrives from the 2026-09-08 review of the enrolment transport, and is not filed as an
issue**

**Nothing in this repository SETS an appliance's clock.** No `chrony`, no `systemd-timesyncd`,
no NTP configuration, and nothing in the enrolment path that would put a time source on a machine
that has none. That is an omission rather than a decision, and it produces two failures that share
a cause and nothing else.

**The platform now MEASURES one, which is the half that was cheapest and is done.** The offset per
gateway, the alert, the dashboard panel and the edge node on the rejection counter all shipped
together — see *What has landed* below. What remains is everything on the appliance side, which is
why this item stays open: a fault that is now visible is not a fault that is fixed.

### The loud failure is the safe one, which is why this item exists

**A badly wrong clock breaks TLS, and that is fine.** Certificate validity is a date comparison, so
an appliance whose clock is out by months cannot verify the broker and cannot connect. It fails at
commissioning, in front of whoever is holding it, and `docs/physical-gateways.md` §8 now tells them
where to look.

**A slightly wrong clock breaks the historian, silently, forever.** The broker's leaf is valid for
ninety days and the root for ten years, so **TLS tolerates precisely the skew the telemetry path does
not.** A gateway three minutes fast verifies every certificate perfectly, connects, authenticates,
and writes every sample three minutes into the future for as long as it runs. Nothing refuses it,
nothing counts it, and nothing anywhere says so.

**That inversion is the whole item.** The failure that announces itself needs no work; the failure
that does not is the one carrying the plant's data.

### The sanity window already encodes the assumption, and the assumption is the thing that is missing

`ingestion.py` is explicit that device timestamps are trusted for ordering and bounded for safety:
−24 hours to +5 minutes, asymmetric because *"late data is normal … data from the future is never
legitimate; it is always a clock fault, so the forward tolerance covers ordinary NTP skew and nothing
more."*

**That is correct, and it assumes NTP is working** — on the class of network this platform is built
for, which is the class that blocks it. Read the two together and the window is not a guard against a
broken clock at all: it is a guard against a *catastrophically* broken one, sized to the residual of
a mechanism nobody has installed.

Two consequences, in the order they will be met:

- **Inside the window, a wrong timestamp is accepted in silence.** Up to five minutes of forward
  error is written as observation. Two gateways on one line cannot then be correlated, and no
  dashboard, alert or export can tell that anything is wrong — the numbers are all plausible.
- **Outside it, data is dropped and the drop is anonymous.**
  `acs_ingestion_timestamps_rejected_total` carries **no labels**, so it says the fleet lost samples
  and not which appliance lost them. The line that names the gateway — *"Check the gateway's
  clock"* — goes to a log nothing keeps, which is **§12 exactly**, arrived at from the other end.

### The hardware makes this likely rather than theoretical

§8 records that gateways are *"whatever hardware a plant already had — arm64 single-board computers
and amd64 industrial PCs."* **A Raspberry Pi has no battery-backed real-time clock.** Powered off and
back on with no reachable time source, it comes up at whatever the filesystem last recorded or at the
epoch — so the most likely appliance in this fleet is also the one that cannot keep time across a
power cut, and a plant power cut restarts every appliance at once.

### What has landed: the measurement, which was already in the payload

**The daemon held both halves of the answer on every heartbeat and compared neither.** It has the
payload's own timestamp and it has receipt time — it already chose receipt time deliberately,
*"because edge node clocks drift (or, for a replayed payload, are plain wrong)."* The difference
between those two numbers **is** the appliance's clock offset, per gateway, on a 30-second cadence,
with no change to a single appliance and no new field on the wire. Network latency is milliseconds
and the error that matters is minutes, so the subtraction needs no round-trip correction to be
worth acting on.

It is now taken, and it follows the move `Cert_Expires_At` already made for the trust anchor — the
fleet reports the condition, the dashboard shows it, one rule alerts on it:

* `acs_ingestion_gateway_clock_offset_seconds{edge_node}`, **positive meaning the appliance is
  ahead**, beside `acs_ingestion_gateway_clock_measured_timestamp_seconds` — which is not
  decoration: a gauge holds its last value forever, so without it an appliance powered down
  mid-fault reports the clock it had on the day it left, indefinitely.
* A **Gateway Clock Skew** rule at 60s for 15m, gated on the measurement being under 300s old.
  Sixty seconds is deliberately well inside the sanity window: past +5 minutes the telemetry is
  discarded rather than misfiled, and this is meant to fire long before that.
* A **Clock offset** panel on the fleet-health dashboard.
* **`acs_ingestion_timestamps_rejected_total` now carries `edge_node`** — which is §12 discharged
  for this one counter, arrived at from the other end. The rejection is almost always a clock
  rather than a device, so the two belong on the same page.

**NDEATH is excluded from the measurement and that is not a detail.** It is the broker's Last Will,
built by the appliance at connect time and held until the connection drops, so its timestamp is the
clock reading of an arbitrarily earlier moment. Measuring it would report every perfectly
synchronised gateway in the fleet as hours slow, once, at the instant it went offline — the same
exclusion `check_message_sequence()` already makes, for the same reason.

**What this does not do is fix anything**, and the remaining bullets are where that lives. It also
answers the question those bullets cannot be decided without: *how bad is this already, on the
fleet that exists*. That was the argument for doing it first, and it is the reason it is done
first.

### What this must not touch

The sanity window's **asymmetry**, which is right: a gateway buffering through an outage and flushing
on reconnect is legitimate late data, and data from the future never is. The heartbeat's use of
**receipt time** for staleness. And above all, **do not "correct" device timestamps at ingest.** A
device supplying its own timestamps is Sparkplug's model and the ordering guarantee rests on it;
rewriting them at the centre would replace a visible clock fault with an invisible one and destroy
the only evidence that the appliance is wrong.

### Worth deciding early

- **Whether an appliance with a bad clock should publish at all.** Fail-closed protects the historian
  and takes a line's telemetry off for a clock; fail-open keeps the data flowing and files bad rows.
  The current behaviour is neither — it is fail-open inside five minutes and fail-closed outside,
  chosen for storage safety rather than as a data-quality policy. **Whichever is picked, it should be
  picked deliberately**, and the offset measurement above is what makes either defensible.
- **Whether the platform is itself a time source.** A plant that blocks public NTP still has this
  stack reachable, and a cluster that already serves the broker, the API and the forge could serve
  time. It is a real answer to the air-gapped case and it is another service to run — and unlike the
  others it has no fallback, because an appliance cannot ask what time it is over a connection whose
  certificate it cannot yet check.
- **Whether an RTC module becomes a hardware requirement for single-board appliances.** A few pounds
  per gateway removes the power-cut case entirely, and it is the kind of requirement that is free to
  state before a fleet is bought and impossible afterwards.
- **~~Whether this ships with §8's OS baseline or before it.~~ ANSWERED: before, and it has.** The
  measurement was independent of every appliance and is the only one of these that could be
  evaluated against a fleet that exists, so it went first. **The time source itself still belongs
  in §8's OS baseline**, which is the natural home for it and is blocked on nothing.
- **What the offset actually reads across the fleet, before any of the decisions above are made.**
  This is now answerable and was not. A fleet that is uniformly within a second needs a time source
  for robustness; a fleet with one appliance an hour out needs it before anything else in §8. The
  same numbers say whether `TELEMETRY_MAX_FUTURE_SECONDS` at five minutes is generous or tight —
  that value has never been checked against a real appliance, only reasoned about.
