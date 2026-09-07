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
numbers are labels for reading order, they run 1-13 with no gaps, and **a renumber costs one grep**
(`§[0-9]`, `roadmap item [0-9]`) across the repository for the prose that still cites them.

**Ordered by subject rather than by age**, in four groups. **1-5 are the platform's own**, led by
the one item somebody else sets the deadline for and then by the credential and operations chain.
**The role split that chain would otherwise have queued behind has already shipped**, as `0069` and
`0070`, which is why 2 is now Entra sign-in alone and 3 no longer waits on it. **So has the
machine-principal split**, as `0080` — it was the entry that arrived from a change being REFUSED
rather than from an audit or a request, and it had to exist before an `Operator` could be granted
anything else, which is exactly what 7 goes on to do. **5 is the only item here whose subject is the
BROKER credential plane** rather than the database one; it sits at the end of the chain because the
database plane's own credential work has now shipped and explicitly scoped that plane out, and
because its strongest argument is a gap (a revoked gateway that is already connected keeps
publishing) rather than a feature. **6-10 arrive from feature requests** — 6, 8 and 10 from GitHub
issues
[#64](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/64),
[#63](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/63) and
[#66](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/66); 7 and 9 were not filed. **9 is
sequenced *after* 8 because it removes what 8 replaces, and 7 is sequenced *before* it because 8
cannot ask an `Operator` for a proposal until 7 has given that role a way to make one** — 7 is the
queue and the authority, 8 is one lane's payload and the edge sync that carries it.
[#58](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/58) is built. **11 and 12 are the
platform's own and sit last anyway**, because each has for its subject something that runs under or
over every other item rather than any one chain: 11 is the transport between the services, 12 the
record of what they did. Neither blocks the other. 11 is written first because reading it before 5
and 8 invites starting it in the wrong order, which is the one thing it asks not to happen; 12 has
no such constraint and is last because it is the newest.

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

## 6 · The Directory's MQTT half, and the trust decision underneath it

**Builds on:** [`supabase/functions/fplus-directory/index.ts`](../supabase/functions/fplus-directory/index.ts) ·
`directory_services` (`0001`) · `gateways.sparkplug_group` (`0008`) · `relocate_devices()` (`0033`) ·
[issue #64](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/64)

**The issue calls `fplus-directory` "a stubbed Edge Function", and it is not.** It serves seven
routes — `/ping`, `/v1/device`, `/v1/device/{uuid}`, `/v1/address/{group}/{node}`, `/v1/schema`,
`/v1/schema/{uuid}` and `/v1/service` — which is every REST route the issue proposes, the last of
them added by this entry. It reads as the **caller**
rather than the service role, deliberately and with no `SUPABASE_SERVICE_ROLE_KEY` in its registry
entry, because a Directory is a live read across the whole address space and the service key would
hand every authenticated user a view their RLS policies do not grant. That property is the thing any
expansion must not quietly drop.

**The reverse lookup shipped on 2026-09-06 and has left this entry**, which is what remains of the
REST half. `GET /v1/schema/{uuid}` — *which devices implement this schema* — was the one route in
the issue that did not exist; its substance is now in
[The Factory+ Directory adapter](../supabase/README.md#the-factory-directory-adapter), and
`test_fplus_directory.py` is the suite. UUID-to-topic resolution already worked, and already
survived relocation, because the address is composed from `(sparkplug_group, sparkplug_id)` at read
time rather than stored: `relocate_devices()` moves a device between cells without touching either,
so continuity is a property of the schema rather than something the Directory has to maintain.

**Three things that route argued came out differently in the building.** It deliberately does NOT
filter on `status` the way the collection does — `/v1/schema` lists what is in use and returns only
`active` versions, but an identifier a caller already holds resolves to whatever it names, and the
most useful case a filter would have hidden is an **archived** schema with devices still attached,
which is a migration that has not finished. It reads `device_schemas` rather than
`device_submodels`, because the view unions the join table with the legacy 1:1 `devices.schema_id`
and the join table alone would silently omit exactly the devices an old schema still holds — the
suite provisions one of each rather than trusting that. And the forward and reverse answers are
composed by **different queries over the same view**, so a disagreement between them is a `200` at
both endpoints; the suite asserts the round trip rather than either half, which is the same
reasoning `TestExportAgreement` follows for the two AAS surfaces.

**What is left of this item is the MQTT interface, which is the real new surface, and the file
already argues with itself about it.** Its
header states what this deliberately is not: *"It does not consume Sparkplug births to build its own
registry, it has no change-notify metrics, and it does not register itself with a Configuration Store,
because there is no ConfigDB here to register with."* The issue's first implementation step — have the
ingestion daemon write dynamic topic bindings on NBIRTH/DBIRTH — is precisely that registry, and it
would move the Directory from *deriving* addresses out of the enrolment record to *accumulating* them
from what devices claim about themselves. Given the rule that a self-declared marker is not evidence
-- see [Schema Conformance](../ingestion/README.md#schema-conformance) -- that is a trust decision, not
a plumbing one.

**And the local-namespace caveats are load bearing.** All three of `/v1/schema`,
`/v1/schema/{uuid}` and `/v1/service` return `namespace: "local"` with a note that these are not
registered Factory+ UUIDs — from one shared constant, since the qualification is the thing a second
route is most likely to be written without. Publishing the same
values to a well-known MQTT topic strips that note off them — a headless subscriber receives bare
UUIDs with no way to know they were locally minted. Whatever the topic payload looks like, it has to
carry the qualification, or the interoperability claim becomes false the moment it leaves HTTP.

---

## 7 · The approvals page, and the lane that is waiting on §8

**Builds on:** [`approve_quarantined_device()`](../supabase/migrations/0001_baseline_schema.sql) and the
role re-check inside it · `has_role()` and the write policies it gates · the `Operator` role as seeded
in [`0002`](../supabase/migrations/0002_seed_data.sql) · `device_nameplate` · `publish_schema_version()` ·
[`EntityLinksModal.jsx`](../frontend/src/components/modals/EntityLinksModal.jsx) ·
[`FlowBackupUploader.jsx`](../frontend/src/components/common/FlowBackupUploader.jsx) ·
`system_settings` and its `min_value` / `max_value` bounds · `digital_thread` and
[`0079`](../supabase/migrations/0079_the_thread_stops_growing_without_end.sql)'s pruning ·
[`0069`](../supabase/migrations/0069_the_two_roles_stop_being_the_same.sql)'s permission split ·
**not filed as an issue, and it is the substrate §8 needs rather than a feature beside it**

One queue for every change a person proposes but may not make: a gateway's flow, an asset's details,
a schema's publication. An `Operator` proposes; a `Shopfloor_Manager` or `Administrator` approves;
the approval is the write.

**The substrate and the asset-details lane shipped on 2026-09-07 as `0086`, and the schema
publication lane followed as `0088`.** What is here now is **the flow lane, which belongs with §8,
and the page**. The schema lane's substance is in
[The schema lane, and the second approval gate](../supabase/README.md#the-schema-lane-and-the-second-approval-gate-0088). The substance of what was built is in
[The approvals queue, and the first write an `Operator` has ever had](../supabase/README.md#the-approvals-queue-and-the-first-write-an-operator-has-ever-had-0086),
and `test_change_proposals.py` is the suite. **Four things it argued came out differently, or
sharper, in the building:**

* **The unknown-entity-type refusal had to be written explicitly.** The `CHECK` constraint admits
  the two lanes that exist, but the validation trigger runs *before* it, so a third entity type
  reaches the trigger first and its allowlist is empty — which reported "proposable columns are:"
  with nothing after the colon. That reads as a broken message rather than as a lane nobody has
  written an allowlist for, which is the state a widened `CHECK` and a forgotten
  `proposable_columns()` entry would actually produce.
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
  `actor_source` CHECK rather than minting a fifth kind, and **§8's reconciling sidecar should give
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

### Schemas already version themselves, and this must not fork that

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
either declares `service` or earns a kind of its own. **§8 asks the identical question for the
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

## 8 · GitOps edge sync, and the review step a bucket cannot give a flow

**Builds on:** the `gateway-backups` bucket in
[`scripts/storage-init.mjs`](../scripts/storage-init.mjs) ·
[`FlowBackupUploader.jsx`](../frontend/src/components/common/FlowBackupUploader.jsx) ·
[`gateway-bundle-template/bootstrap.mjs`](../gateway-bundle-template/bootstrap.mjs) and the flow hash
its heartbeat already reports · `digital_thread` (`0005`, `0026`) ·
[`nodered-userinfo`](../supabase/functions/nodered-userinfo/index.ts), which is now the only place
`gitops:manage` is enforced · **§7, which owns the queue, the page and the proposing role, and is a
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

**`gitops:manage` finally gets a second enforcement point.** It is currently enforced in exactly one
place — `nodered-userinfo`'s `ALLOWED_ROLES`, as `0069` records — and the merge is the control it was
named for. **Authoring a proposal and approving one are different privileges** and should not collapse
into one: approving is `gitops:manage`, and **proposing is the `Operator` write that §7 adds** — not,
as this item originally said, the write `storage-policies.sql` already grants Administrator and
Shopfloor_Manager. That was written before the approvals queue existed and it inverted the point: a
review step whose proposals can only come from the two roles that may already merge them is a
formality, not a gate.

### The flow lane of the approvals page, and the one thing it must not become

**§7 owns the page; this item owns what the flow lane shows on it.** Per gateway: the tracked
repository and branch, the open pull requests against it, the commit history with the deployed
revision marked, and the gateway's own reported flow hash beside the committed head — which is drift,
stated as a fact the appliance sent rather than as something the centre inferred. A revert control,
and an approve control gated on `gitops:manage` rather than on the approver role the records lanes
use.

**A revert must be a new commit and never a force-push.** A force-push rewrites history a gateway may
already have pulled, and the sidecar cannot distinguish that from a legitimate advance — it would
reconcile to the rewritten head and report success, having silently deployed something no pull request
ever showed. A revert commit is visible, reviewable and itself revertible.

**The lane must not become an editor, and that is a constraint this item places on §7's page rather
than a note about a page of its own.** Nothing in it should author or edit flow JSON, and nothing
should accept a blob that reaches an appliance without passing the same merge. That is the refusal
worth keeping from `deploy-nodered`, restated for a UI: **deploy only what is committed**, or it is a
remote-code-execution endpoint with a friendly name and a nicer table. Note that the records lanes
§7 describes are the opposite case — there the approval *is* the write — so the two lanes do not
share a submit path and should not be generalised into one.

### The credential store is the hazard that can invalidate the shape

**Node-RED keys credentials by node id**, and holds them in `flows_cred.json`, encrypted separately
and deliberately not in the flow file. A flow round-tripped through export, repository and pull can
come back with the broker node re-created under a new id; the credential then keys to a node that no
longer exists, the sidecar reconciles successfully, and the gateway drops off the broker immediately
afterwards. **This constrains the design more than the transport does and should be proved before
anything else is built** — if a round trip cannot preserve credential binding, the puller needs a
merge strategy rather than an overwrite, and that is a different piece of work.

### A third credential plane arrives with this item, and it should be named now

**The appliance needs a way to authenticate to the repository**, which is neither the broker plane
(§5) nor the database one. It should be **per gateway and read-only** — a shared key across the
fleet makes one compromised appliance a fleet-wide read, and a writable one lets an appliance author
what it will later be asked to deploy. `enroll-gateway` already mints a per-gateway broker credential
at bundle time and is the natural place to issue this one, which also means revocation has a home
alongside the credential it sits beside.

**Verifying the commit is what makes the transport untrusted-safe.** If the sidecar checks a signature
over the revision it is about to apply, the forge and the network between are no longer things that
have to be trusted — a much stronger position than TLS to the host alone, and the one that makes a
hosted forge an acceptable answer to the question below.

### What this must not touch

The enrolment token's single-use semantics and the once-only guard in `bootstrap.mjs`; the broker
ACL's `%u` confinement, which is what stops one gateway forging another's telemetry and is enforced
independently of anything here; `flows_cred.json`, which must not leave the appliance in a backup, a
commit or a diff; and the `gateway-backups` bucket's privacy setting, which stays exactly as it is
until §9 sequences its removal — a `flows.json` describes the plant's edge topology, and it is not
dead weight until the pull half replaces what it does.

### Worth deciding early

**The forge.** Self-hosted or hosted, and for an on-premises deployment on a private domain that is
the same question `deploy/k8s/internal-ca.yaml` already answers for certificates. Commit signature
verification makes it a smaller question than it looks. **What it is not is an identity store:** §7
puts the queue in Postgres and reaches the forge through one machine account, so no `Operator` needs
a forge login and the forge never has to learn what `gitops:manage` means.

**One repository or one per gateway.** A repository per gateway gives clean per-appliance deploy keys
and independent history; one repository with a branch per gateway gives a fleet-wide diff and one
place to review. The deploy key granularity is the deciding constraint, not the ergonomics.

**Where `target_branch` lives** — deferred to §9, which owns the links-store question, but this item
is what makes it load-bearing rather than cosmetic.

**The actor kind for the audit row.** Logging the revision hash into `digital_thread` needs one: rows
from the daemon and the edge functions are attributed through the `request.headers` GUC, and the
trigger accepts only `ingestion` / `service` / `migration`, never `user`. A sidecar reconciling on its
own timer is a fourth kind of actor and should say so rather than borrow `service`. **§7's proposal
expiry needs the same answer for the same reason** — a timer with no session — so decide it once,
for both.

---

## 9 · Retiring the flow-backup bucket, and pointing at repositories instead

**Builds on:** [`frontend/src/components/common/FlowBackupUploader.jsx`](../frontend/src/components/common/FlowBackupUploader.jsx) ·
the `gateway-backups` bucket in [`scripts/storage-init.mjs`](../scripts/storage-init.mjs) ·
[`supabase/storage-policies.sql`](../supabase/storage-policies.sql) ·
[`EntityLinksModal.jsx`](../frontend/src/components/modals/EntityLinksModal.jsx) and its tag vocabulary ·
`digital_thread` (`0005`) · **not yet filed as an issue**

**The other end of §8, and it should be sequenced against it rather than planned beside it.** §8
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

### Compose publishes eight ports where Kubernetes publishes seven hostnames

The two targets do not disagree about security here so much as about **shape**, and this is the last
place where a Compose stack looks nothing like the chart.

`templates/ingress.yaml` gives Kubernetes one entry point and routes by hostname:
`grafana.<publicBaseDomain>`, `nodered.<…>`, `app.<…>`, `studio.<…>`, `docs.<…>`, `mqtt.<…>` and the
gateway, every host derived from the same helper the service itself is configured from. **No port
numbers anywhere.** Compose reaches the same services on eight published ports, and a URL carrying
`:3002` is a URL that only works if the reader knows which machine to put in front of it.

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

**What it does and does not buy.** It gets one port to firewall instead of eight, one TLS
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

This pays **one** of those three costs. The container, yes. No gateway route — the store is reached
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
- **Whether structured logging comes first.** `logging_config.py` is 33 lines of plain formatting.
  Shipping unstructured lines into a label-based store means parsing them at query time forever, and
  the drop paths are the ones whose fields — reason, device, edge node — would most benefit from being
  fields. That is a smaller change than the store and it is the one that decides how useful the store
  is.
