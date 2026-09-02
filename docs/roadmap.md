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
numbers are labels for reading order, they run 1-12 with no gaps, and **a renumber costs one grep**
(`§[0-9]`, `roadmap item [0-9]`) across the repository for the prose that still cites them.

**Ordered by subject rather than by age**, in three groups. **1-7 are the platform's own**, led by
the one item somebody else sets the deadline for and then by the credential and operations chain:
2 is Administrator-only from the start and deliberately does not wait for 4, and 3 adds a sixth
Administrator-only policy in the same direction rather than depending on the role split. **The role
split those three would otherwise have queued behind has already shipped**, as `0069` and `0070`,
which is why 4 is now Entra sign-in alone and 5 no longer waits on it. **7 is the newest and the
only one here that arrived from a change being REFUSED** rather than from an audit or a request —
it is what has to exist before an `Operator` can be granted anything else. **8-11 arrive from
feature requests** — 8, 9 and 11 from GitHub issues
[#64](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/64),
[#63](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/63) and
[#66](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/66); 10 was not filed, and is sequenced
*after* 9 because it removes what 9 replaces. **12 is documentation**, and is the one item whose
remaining work is mostly writing; it arrives from
[#39](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/39).
[#58](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/58) is built.

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
8, which absorbed that.

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

## 1 · Supabase's legacy API keys

**Builds on:** [`scripts/setup.mjs`](../scripts/setup.mjs) · the gateway's `apikey` check in
[`supabase/envoy.yaml`](../supabase/envoy.yaml) · `custom_access_token_hook` (`0001`) ·
the edge-function registry

The `anon` and `service_role` JWTs this stack mints in `setup.mjs` are the key format Supabase has
since superseded with **publishable and secret keys**. This is a real upstream deprecation with a
real end date, and it is the only item on this list whose timing is set by somebody else.

**Scoped against the pinned versions, as this entry used to say it must be — and the answer changed
the plan.** The new keys are **not JWTs**, and no component downstream ever sees one. Given a
non-JWT bearer, `postgrest v14.12` answers
`PGRST301 "Expected 3 parts in JWT; got 1"` — measured here, not read. They work because the
**gateway** matches the key as a string and synthesises the `Authorization: Bearer <JWT>` the
upstreams require. That makes this a gateway feature, not a component-version upgrade, and it is why
this item waited on the gateway migration: upstream ships the translation in Envoy and Kong has
no equivalent. See [`docs/gateway-migration.md`](gateway-migration.md).

**The rehearsal path this entry called "the first thing to build" now exists**, and it did not have
to be built. Upstream's Envoy configuration accepts legacy and new keys **simultaneously**, so
consumers migrate one at a time instead of on a flag day. Translation activates only when all four
of `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ANON_KEY_ASYMMETRIC` and
`SERVICE_ROLE_KEY_ASYMMETRIC` are set; short of that it runs legacy-only, which is what the stack
does today.

**The surface is 67 files, not the twelve this entry used to claim** — but the count matters less
than the split, which decides the work:

- **Most consumers send the key as `apikey` ONLY**, and are format-agnostic. The i3X service and all
  eight edge functions pass the *caller's* token as the bearer and use the anon key purely as the
  gateway credential. Those migrate for free.
- **`service_role` is always both**, and that is the hard half. Its whole purpose is the `role`
  claim PostgREST switches on, so it depends on the gateway's synthesis. `0026`'s premise — that a
  holder of it must not be able to forge an audit row — has to survive whatever mints it.
- **The unauthenticated browser is the other one.** `supabase-js` sends the anon key as the bearer
  when there is no session, so it needs the same translation.
- **`anon` is public by construction**, readable in any built bundle, which is why the chart renders
  it outside a Secret deliberately. Replacing it changes what the gateway accepts as a registered
  key, not a secret rotation.
- **`custom_access_token_hook` shapes the claims** the rest of the stack reads. PostgREST resolves
  RLS from them, and `grafana-userinfo` maps a role out of `public.user_roles` beside them.

**This entry said it was blocked on Kubernetes, and it is not — the blocker cleared and nothing
swept back to say so.** The claim was that the chart still deployed Kong, which cannot translate an
opaque key, so the two targets would accept different key formats until the Envoy templates landed.
Those templates landed: [`values.yaml`](../deploy/helm/acs-cymru/values.yaml) now sets
`supabaseEnvoy.enabled: true` and `supabaseKong.enabled: false`, with Kong retained and off.
**Unblocked on both targets**, which matters because this is the one item on the list whose timing
is set by somebody else. The divergence argument that made it a blocker still applies to anyone
re-enabling Kong: a stack whose authentication differs by deployment target is the class of
divergence the shared gateway template exists to prevent.

**Sources**, since the upstream guidance for the hosted platform and for self-hosting differ and
this entry was written against the wrong one once already:
[migrating to new API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys) ·
[self-hosted auth keys](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys) ·
[Envoy API gateway](https://supabase.com/docs/guides/self-hosting/self-hosted-envoy)

---

## 2 · Studio behind the login everything else already uses

**Builds on:** the `supabase-studio` block in [`docker-compose.yml`](../docker-compose.yml) ·
`routes.studio` in [`values.yaml`](../deploy/helm/acs-cymru/values.yaml) ·
`GOTRUE_OAUTH_SERVER_ENABLED` · [`0002`](../supabase/migrations/0002_seed_data.sql)'s Grafana client and
[`0006`](../supabase/migrations/0006_nodered_oidc_auth.sql)'s Node-RED client ·
[`grafana-userinfo`](../supabase/functions/grafana-userinfo/index.ts) ·
[`nodered-userinfo`](../supabase/functions/nodered-userinfo/index.ts) ·
[`OAuthConsent.jsx`](../frontend/src/pages/OAuthConsent.jsx) ·
[`supabase/envoy.yaml`](../supabase/envoy.yaml) · **not filed as an issue, and arriving from user
feedback rather than from an audit**

Put an authenticating proxy in front of Supabase Studio, so reaching it costs a Supabase login as an
`Administrator` rather than a position on the host. **`values.yaml` already asks for this by name** —
turning the ingress on "belongs with an authenticating proxy in front" — and until one exists, the
chart's answer and Compose's answer are the same answer: do not let anyone reach it.

### The binding is a real control, and it is the only one

Studio has no authentication of its own: no login, no roles, no session. The official stack puts it
behind a basic-auth pair and this one does not run that, so whoever reaches the port gets the SQL
editor, the table editor and the Vault UI **as the database owner, for whom RLS is not enforced**.
Compose binds it to `127.0.0.1` and the chart leaves `routes.studio` off; both comments say why at
length and both are right as far as they go.

What they buy is that reaching Studio needs shell access or a tunnel. What they do not buy is a
second credential once somebody has one — and the same port also serves `/api/mcp`, a Supabase MCP
server (`supabase` v0.7.0, protocol `2025-06-18`) that completes `initialize` with no credential at
all and exposes `execute_sql` and `apply_migration` among its eleven tools. That is not a new
privilege. It is the SQL editor's privilege in a shape a process can drive rather than one a human
has to sit in front of, which is a different risk with the same blast radius.

### The cheapest fix is refused by the people who asked for the feature

Not starting Studio at all — `profiles: [debug]` in Compose, matching what the chart already does —
removes the surface completely and costs one edit. It is the right answer to the security question
and the wrong answer to the request that prompted this entry: **users have asked to be able to reach
Studio**, and an item that answers "you cannot" is not an item. It remains the correct default for
any deployment nobody has asked that of, and nothing here argues for turning it on by default.

### The integration exists twice already, and a third is the same shape

This stack is an OAuth 2.1 authorization server. `GOTRUE_OAUTH_SERVER_ENABLED` is on, GoTrue ships
no consent UI so the React dashboard serves one at `/oauth/consent`, and two clients already
authenticate humans through it: Grafana, seeded by `0002`, and Node-RED, seeded by `0006`. Both
migrations hash a secret out of `.env` into `auth.oauth_clients` and `DO UPDATE` on replay, so a
rotated secret takes effect on the next boot. A third client is that migration again with a
different redirect URI.

What is new is the proxy, because **Studio cannot be an OAuth client — it has no login to extend**.
`oauth2-proxy` is the standard answer: it runs the browser flow, holds the session cookie and
forwards authenticated requests upstream. Studio stops publishing a port and the proxy takes it.

### GoTrue's userinfo does not carry the role, and that is the decision to make first

`grafana-userinfo` exists because of this and says so: GoTrue's OIDC server advertises the standard
claims only, `app_metadata` is not among them, and a client reading a role attribute out of it finds
nothing — with strict mapping every user is denied, without it every user silently becomes a Viewer.
`nodered-userinfo` is the same function for the same reason. Both read `public.user_roles` through
`resolveUserRole()`, which is also why a role change takes effect on the user's next login instead
of whenever their token happens to be reissued.

`oauth2-proxy` needs the same thing and can take it from one of two places, which are not equally
good:

| Where the role comes from | What it costs | What is unresolved |
| :--- | :--- | :--- |
| A claim in the ID token, read with `--oidc-groups-claim` | Nothing, if the claim is there | `custom_access_token_hook` mirrors the role into the **access** token; whether it reaches the ID token GoTrue issues at `/oauth/token` is **unverified**, and settles the design |
| A third `studio-userinfo` function on `--profile-url` | One edge function, on an established pattern | Nothing — it is what the other two clients do, and it reads the live role |

**Check the ID token first and take the free answer if it is there.** If it is not, write the third
userinfo function rather than falling back to an email allowlist: a static list of addresses is the
htpasswd problem with extra steps — no revocation, no role, no audit row, and a further credential
plane in `.env` for a console that can drop a table.

### It closes the MCP endpoint, which should be a decision rather than a discovery

A session cookie in front of Studio covers `/api/mcp` along with everything else, and an MCP client
cannot complete an interactive browser flow to obtain one. So this item **removes** the
unauthenticated MCP server as a working endpoint, not merely as an open one.

That is the right outcome, and the reason is worth recording because the endpoint is tempting. It
runs as the owner, so it reads `digital_thread`, `auth.users` and the Vault, and it sits outside
every control this repository built for that exact question: `0034`'s read-only principal holds
`Operator` and nothing else *precisely* so a model cannot see the audit trail, and §3's revocation
acts at PostgREST, which Studio does not go through. The model-facing surface this stack intends is
the i3X one, where RLS is in the path. A developer-facing MCP is recoverable later by exempting the
route and giving it a credential of its own — on its own argument, not as a side effect of how
Studio happens to be published.

### The door and the privilege are separate decisions, and only one of them is this item

Worth doing whether or not the proxy is built, and it does not block on it. The pinned image builds
its connection string as `readOnly ? POSTGRES_USER_READ_ONLY : POSTGRES_USER_READ_WRITE`, and **this
stack sets only the read-write half** — `POSTGRES_USER_READ_WRITE: postgres`, with no read-only
counterpart — so every path that asks for the restricted user is handed the owner instead. Creating
that role and setting the variable narrows what Studio can *do*, where the proxy narrows who can
open it.

Two caveats before it is treated as free. Both branches take the same `POSTGRES_PASSWORD`, so the
read-only role has to be created holding the owner's password, which is not obviously acceptable and
should be decided rather than absorbed. And which of Studio's own paths request the read-only branch
was not measured — the table editor plainly cannot use it. Measure before promising anything about
what it covers.

### What this must not touch

The proxy fronts **Studio only**. Envoy already fronts Auth, PostgREST, Realtime, Storage and the
edge runtime on `:54321` with API-key auth and four deliberate exemptions, and every machine
principal in the stack authenticates there without a browser. A browser-session proxy anywhere on
that path is an outage, for the same reason `0048` keeps machine identities out of the `aal2`
predicates.

`supabase-envoy` also answers to the network alias `supabase-kong`, which Studio's own
`SUPABASE_URL` points at for server-side calls. That is Studio talking *outward* and it does not
change.

### Worth deciding early

- **Whether the loopback binding survives the proxy.** Publishing both leaves the proxy optional,
  and an optional control is not one. Unpublish `127.0.0.1:54323` in the same commit that publishes
  the proxy, or the old door stays open beside the new one.
- **Whether `routes.studio` flips to `true`.** Not in the same change. The chart's default is
  currently right because no proxy exists; making it right for a different reason is a second
  decision, and it is the one that puts a database console on a public hostname.
- **What the seeded Directory entry says.** `0002` lists Studio at `http://127.0.0.1:54323`, and
  that URL is wrong the moment the proxy takes the port. The Directory is where people look to find
  services, so it moves in the same migration that seeds the OAuth client.
- **Whether this waits for 20 or 21.** It does not. Gating on `Administrator` adds another
  Administrator-only check in the direction §3 already goes, rather than depending on the role
  split — and Studio inherits Entra sign-in and MFA for free if and when those land. That is the
  strongest argument for the OAuth route over any proxy-local credential: it is the only design
  under which a database console ever gets a second factor.

---

## 3 · Revocable service tokens, and the mint that becomes safe once they exist

**Builds on:** `create_service_principal()`
([0044](../supabase/migrations/0044_create_service_principal.sql)) ·
`record_service_token_issued()` and `service_token_max_days()`
([0043](../supabase/migrations/0043_record_service_token_issued.sql)) ·
[`scripts/mint-mcp-token.mjs`](../scripts/mint-mcp-token.mjs) ·
[`scripts/rotate-service-keys.mjs`](../scripts/rotate-service-keys.mjs) ·
[`AccessControlTab.jsx`](../frontend/src/components/tabs/AccessControlTab.jsx) ·
`PGRST_DB_PRE_REQUEST`, which is unset

Mint and revoke a service principal's tokens from the Access Control page, Administrator-only, so
the last credential workflow that requires a shell on the host stops requiring one. **Revocation is
the item and the buttons are its consequence**, in that order, for a reason that is already written
down.

### The CLI step is standing in for a control, not for a missing screen

Half of this is built. [`0044`](../supabase/migrations/0044_create_service_principal.sql) already lets
an Administrator create a machine identity from the page, and
[`supabase/README.md`](../supabase/README.md#the-access-control-page-states-what-is-outstanding)
describes it doing so. What is left on the host is minting a **token** for one.

That button was designed and refused, and the refusal is the whole design constraint here. `pgjwt`
is installed and `extensions.sign()` exists, so a `SECURITY DEFINER` RPC could mint one today with
no new dependency and no secret leaving the database — and the argument against it was not effort:

> *"technically neat, and it would have made an unrevocable credential a button press with a tidy
> audit trail of a thing nobody can undo. **Solving the wrong half well is worse than not solving
> it, because the clean implementation reads as safety.** So minting stays on the host."*

So building the mint first removes the friction and keeps the missing control, and the page then
hands out unrevocable credentials pleasantly. Build revocation first and the same RPC stops being a
hazard: it is then the ordinary shape this stack already uses for `gateway-credential` — the
database decides, the row is written before the secret is returned, and the secret is revealed once.

### A fourth revocation design, and the key it needs has been recorded all along

[`0043`](../supabase/migrations/0043_record_service_token_issued.sql) surveys three ways of adding
revocation and none works: deleting the `auth.users` row does nothing because the signature is
validated and the subject never looked up; removing the role does nothing because the relations the
i3X address space is assembled from are `FOR SELECT TO authenticated USING (true)`; and a
`revoked_at` predicate would have to be added to **every RLS policy in the schema**.

The fourth is not considered there. **PostgREST's `db-pre-request` names a function run before every
request, in the caller's role, which can `RAISE` and abort it** — the single choke point the third
design lacked, and it touches no policy at all. `postgrest/postgrest:v14.12` supports it and
`PGRST_DB_PRE_REQUEST` is unset on both targets, so nothing is being displaced.

**And the identifier is already in the inventory.** `mint-mcp-token.mjs` stamps a `jti` from
`randomUUID()` and hands it to `record_service_token_issued(p_jti)`; `rotate-service-keys.mjs` does
the same for the ingestion and playback keys. Every token this item would revoke has been recording
the exact key a denylist needs, for an inventory that could not act on it.

### What it does not reach belongs on the page, not in a comment

A revocation covering most of the stack is the same failure as the tidy mint: it reads as safety.
The four services holding `SUPABASE_JWT_SECRET` alongside PostgREST each verify independently, and
a pre-request function is invisible to all of them.

| Reached | Not reached |
| :--- | :--- |
| PostgREST — every table RLS guards, which is the whole `public` schema | `supabase-storage` · `supabase-realtime` · the edge runtime, which boots `VERIFY_JWT="false"` so each function authorises itself · Studio |

**That is complete coverage for what this item is actually about, and the entry should say why
rather than leave the gap looking accidental.** The MCP reader and `Service_Ingestor` reach
PostgREST and nothing else, so for a machine principal the choke point is the only door. For a
person's session it is not — and a person's session is already revocable through GoTrue's refresh
tokens, which is a different mechanism for a different problem. The edge functions are reachable
later if wanted: several already call the database, so it is one added check rather than a redesign.

### Fail-closed is the risk, and the negative tests come before the feature

A function that runs before every PostgREST request is a single point of failure by construction. If
it raises when it should not, the entire API is down — which is the correct direction for a security
control and an outage all the same. Three cases have to be tested before anything depends on it: an
empty denylist, a token carrying no `jti` at all, and the function missing entirely.

The cost is one indexed lookup per request. Keeping only **unexpired** revoked jtis bounds the table
and makes it self-pruning: a revoked token past its own `exp` is already refused by the signature
check.

### Two credential planes, and only one of them is in scope

The broker plane is not this item, and the reason is specific rather than a boundary drawn for
tidiness. Gateway accounts are already mintable from the dashboard
([0041](../supabase/migrations/0041_virtual_gateway_credential.sql)) and already revoked on archive or
delete ([0038](../supabase/migrations/0038_revoke_gateway_credentials.sql),
[0063](../supabase/migrations/0063_virtual_gateways_get_revoked.sql)).

**The five platform principals cannot be given the same controls, and a first attempt would look
like it worked.** `factoryplus_ingestion`, `factoryplus_i3x`, `factoryplus_monitor`, the validator
and the legacy simulator account come from `.env`, and `mosquitto-init` says what it does with them:
*"THE PLATFORM PRINCIPALS ARE REWRITTEN ON EVERY RUN — they come from .env and must follow it."* A
revocation performed in the UI would be undone by the next `docker compose up`, silently, on a page
whose entire job is to state what is outstanding.

Worth recording while the subject is open: **a broker password has no expiry at all.** `0062` says
so deliberately — *"it is bounded by revocation (`0038`), not by a countdown"* — which is the right
answer for an account confined by `mosquitto.acl` and the wrong one to discover by assuming the
90-day ceiling covers everything.

### Administrator-only, which anticipates item 4 rather than waiting for it

`system_settings` for read and for write, `list_service_principals()` and
`create_service_principal()` are the **five policies** §4 cites as the database already separating
`Administrator` from `Shopfloor_Manager` by hand, against 58 sites that check the pair. Gating this
on `Administrator` alone adds a sixth in the same direction, so it does not need §4 to land first
and does not contradict it when it does.

It touches the audit domains in one line: a revocation writes `TOKEN_REVOKED` beside
`TOKEN_MINTED`, and `audit_domain_for()` already files everything on `service_principals` under
`security` — so the row lands in the right lane with no change at all, and what is left is one more
entry in `DIGITAL_THREAD_ACTIONS`. See
[Two lanes, and one of them an engineer cannot read](../supabase/README.md#two-lanes-and-one-of-them-an-engineer-cannot-read-0070).

### Worth deciding early

- **Whether revoking a principal deletes its `auth.users` row or flags it.** Flagging it and
  revoking its outstanding tokens is the recommendation: deleting orphans the `digital_thread`
  attribution, and the history of a revoked principal is the part most worth keeping.
- **Whether the ingestion and playback keys are revocable from the page.** They carry jtis, so
  mechanically they are — and revoking one stops ingestion until somebody rotates the key and
  recreates the container. Surfacing them read-only and leaving rotation to `npm run keys:rotate`
  keeps the one control that has a recovery path attached to it.
- **Whether `mint-mcp-token.mjs` survives.** It should, as break-glass, for the same reason §5
  documents the service-role factor delete: a stack whose only Administrator cannot sign in still
  needs a way to mint. What changes is that it stops being the only way.

---

## 4 · Microsoft Entra ID sign-in, and a role model worth mapping onto

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

Everything below is unbuilt. The role split was sequenced first because §5 and the audit-domain
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

## 5 · Multi-factor authentication, and what happens when the phone is lost

**Builds on:** GoTrue v2.189.0's factor API · `has_role()` and the `aal` claim ·
[`AccessControlTab.jsx`](../frontend/src/components/tabs/AccessControlTab.jsx) · the immutable audit in
[`0003_audit_immutability_and_quarantine_rpc.sql`](../supabase/migrations/0003_audit_immutability_and_quarantine_rpc.sql)

TOTP second factors, required of the roles that can change the platform and optional for everyone
else. Any authenticator that implements TOTP works — Microsoft Authenticator, Google Authenticator,
Bitwarden, 1Password — which is a documentation fact, not an integration.

**This item depended on item 4's role divergence, and that dependency is now satisfied.** The
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
away when item 4 ships — the seeded personas, break-glass accounts, and any air-gapped shopfloor
install with no Entra to reach are all password paths, which is why this cannot simply be delegated
upward and forgotten.

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
[`0048_machine_principals_are_not_users.sql`](../supabase/migrations/0048_machine_principals_are_not_users.sql)
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

## 6 · A backup an operator can take without a shell

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
[`0055`](../supabase/migrations/0055_capture_orchestration.sql). This is the same problem with a
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

---

## 7 · Machine principals with their own authority, instead of borrowing a person's role

**Builds on:** `is_machine_principal()` ([`0048`](../supabase/migrations/0048_machine_principals_are_not_users.sql),
the predicate is [`0042`](../supabase/migrations/0042_list_service_principals.sql)'s) ·
the MCP reader ([`0034`](../supabase/migrations/0034_mcp_read_only_principal.sql)) ·
`Service_Ingestor` ([`0046`](../supabase/migrations/0046_service_ingestor_principal.sql)) ·
`Service_Playback` ([`0060`](../supabase/migrations/0060_playback_gateway_and_shadow_devices.sql)) ·
`has_role()` and its 58 call sites · the audit lanes ([`0070`](../supabase/migrations/0070_audit_domain_and_the_acts_nothing_recorded.sql)) ·
**not filed as an issue, and arriving from a change that was refused rather than from an audit**

Give a machine principal an authority of its own — a set of permissions it was granted — instead of
handing it `Operator` and inheriting whatever `Operator` happens to mean that month.

### Three principals hold one human role, and the Access Control page says so

`MCP read-only client`, `Service_Ingestor` and `Service_Playback` all hold **`Operator` and nothing
else**. That was a good decision when it was made and it is written down as one: `0034`'s header
says Operator was chosen **over `Auditor`** *precisely* so a model could not read the audit trail.
The role was picked for the shape it had.

**The problem is that the shape is not theirs.** `Operator` is a *person's* role — the read-only
shopfloor user — and it is the role that changes whenever somebody asks for an operator to be able
to see one more thing. Every one of those requests silently re-grants three machine identities.

### This has already happened once, and it is why this entry exists

A request to let an `Operator` read the asset lane of `digital_thread` — reasonable, and no wider
than what an Operator can already see, since they read `cells`, `gateways` and `devices` themselves
— **was refused by `0034`'s own self-check**:

> *0034 self-check: the MCP principal read 2 digital_thread row(s). Operator was chosen over Auditor
> precisely so it could not.*

The check did its job. But note what it cost: a change about **people** was blocked by a property of
a **machine**, and the only reason it was caught is that somebody had written that assertion down
years' worth of migrations earlier. The next such request will collide the same way, and the one
after that will be tempted to relax the assertion rather than the design.

### The obvious fix does not work, and knowing why saves the attempt

Excluding machine principals inside the policy — `AND NOT is_machine_principal(auth.uid())` — is the
natural repair and it **cannot work here**. [`0001`](../supabase/migrations/0001_baseline_schema.sql)
runs `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated` on every boot,
and `0048` re-grants `is_machine_principal` **after** `0034` has already run. So at the moment
`0034` evaluates that policy as `authenticated`, the function is not executable and the rule fails
with `permission denied for function is_machine_principal` — surfacing 40 migrations away as a row
count. Granting it again later does not help: the revoke is upstream of the check, on every boot.

**Nor is a second predicate acceptable.** `auth.jwt()->>'email' IS NOT NULL` would sidestep the grant
entirely, and `0048` forbids it in as many words: *"a second definition of 'is this a service
account' would be worse than none."*

So the exclusion cannot live in the policy, which leaves the design.

### What to build

**A machine principal gets permissions, not a role.** `role_permissions` already models the join;
what is missing is a principal-scoped grant — `principal_permissions(principal_id, permission_id)` —
and a `has_authority()` that resolves a *person* through `user_roles` and a *machine* through its
own grants. `has_role()` stays what it is for people, which matters because 58 policy sites call it.

**Each of the three then declares what it actually needs**, which is narrower than `Operator` in
every case and is already written in prose on the Access Control page: *"Read-only across the asset
inventory and live telemetry. Cannot read the audit trail."* That sentence is the specification.

### Worth deciding early

- **Whether `0034`'s self-check moves or stays.** It is the best test in this area and it should end
  up asserting the same property against the new mechanism, not be deleted with the old one.
- **Whether a machine principal may ever hold a role.** Allowing both is how the ambiguity comes
  back. If a principal resolves through grants only, that has to be enforced rather than assumed —
  `0048` already has the predicate to enforce it with.
- **What happens to a permission nobody granted.** Fail-closed, on `0070`'s argument: the safe
  failure is a machine that cannot read something, not one that can.
- **Whether this unblocks the Operator change that prompted it.** It does, and that is the point —
  but the audit-lane grant should land *after* this, not alongside it, or the same self-check fires
  during the migration that is meant to make it safe.

---

## 8 · The Directory's MQTT half, and the one lookup it still lacks

**Builds on:** [`supabase/functions/fplus-directory/index.ts`](../supabase/functions/fplus-directory/index.ts) ·
`directory_services` (`0001`) · `gateways.sparkplug_group` (`0008`) · `relocate_devices()` (`0033`) ·
[issue #64](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/64)

**The issue calls `fplus-directory` "a stubbed Edge Function", and it is not.** It serves six routes
— `/ping`, `/v1/device`, `/v1/device/{uuid}`, `/v1/address/{group}/{node}`, `/v1/schema` and
`/v1/service` — including two of the three the issue proposes to add. It reads as the **caller**
rather than the service role, deliberately and with no `SUPABASE_SERVICE_ROLE_KEY` in its registry
entry, because a Directory is a live read across the whole address space and the service key would
hand every authenticated user a view their RLS policies do not grant. That property is the thing any
expansion must not quietly drop.

**What is genuinely missing is smaller, and worth naming exactly.** `GET /v1/schema` lists the schema
UUIDs in use, but there is **no `/v1/schema/{uuid}`** — the reverse lookup, *which devices implement
this schema*, is the one route in the issue that does not exist. UUID-to-topic resolution already
works, and already survives relocation, because the address is composed from
`(sparkplug_group, sparkplug_id)` at read time rather than stored: `relocate_devices()` moves a device
between cells without touching either, so continuity is a property of the schema rather than something
the Directory has to maintain.

**The MQTT interface is the real new surface, and the file already argues with itself about it.** Its
header states what this deliberately is not: *"It does not consume Sparkplug births to build its own
registry, it has no change-notify metrics, and it does not register itself with a Configuration Store,
because there is no ConfigDB here to register with."* The issue's first implementation step — have the
ingestion daemon write dynamic topic bindings on NBIRTH/DBIRTH — is precisely that registry, and it
would move the Directory from *deriving* addresses out of the enrolment record to *accumulating* them
from what devices claim about themselves. Given the rule that a self-declared marker is not evidence
-- see [Schema Conformance](../ingestion/README.md#schema-conformance) -- that is a trust decision, not
a plumbing one.

**And the local-namespace caveats are load bearing.** Both `/v1/schema` and `/v1/service` return
`namespace: "local"` with a note that these are not registered Factory+ UUIDs. Publishing the same
values to a well-known MQTT topic strips that note off them — a headless subscriber receives bare
UUIDs with no way to know they were locally minted. Whatever the topic payload looks like, it has to
carry the qualification, or the interoperability claim becomes false the moment it leaves HTTP.

---

## 9 · GitOps edge sync

**Builds on:** the `gateway-backups` bucket in
[`scripts/storage-init.mjs`](../scripts/storage-init.mjs) · `digital_thread` (`0005`, `0026`) ·
[`nodered-userinfo`](../supabase/functions/nodered-userinfo/index.ts), which is now the only place
`gitops:manage` is enforced · [issue #63](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/63)

**The push half existed and has been retired, which makes this item larger than it was.** A
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

**The storage claim needs correcting before anything is planned against it.** The issue describes
"manual zip backups inside Supabase Storage". The `gateway-backups` bucket holds `flows.json` — JSON,
5 MiB cap, private, keyed `<sparkplug_id>/` — and it is a backup taken **from** an appliance, not the
channel a deployment travels down. Nothing about it sits on the deploy path, so replacing it is not
where this item starts. Its privacy setting is the one thing to preserve if it is touched at all: a
`flows.json` describes the plant's edge topology, broker addresses and device ids, and a public bucket
bypasses `storage-policies.sql` entirely.

**The pull half is still the half carrying the security argument, and is the better place to start.**
The retired design pushed inbound to `:1880`, which means something must be able to reach the edge
node's admin API, and reconciliation happened only when a human pressed deploy. A sidecar that polls
`git pull` and calls Node-RED's local reload API inverts both: outbound-only from the edge, and
self-healing on a timer rather than on attention. Drift detection is the same mechanism read backwards
— compare the running flow against the committed revision.

**Two details the issue does not settle.** Node-RED holds MQTT credentials in its *credential store*,
encrypted separately and deliberately not in the flow file; a puller that overwrites flows
without accounting for that disconnects the gateway it has just reconciled. And logging the revision
hash into `digital_thread` needs an actor — rows from the daemon and the edge functions are attributed
through the `request.headers` GUC, and the trigger accepts only `ingestion` / `service` / `migration`,
never `user`. A sidecar reconciling on its own timer is a fourth kind of actor and should say so
rather than borrow `service`.

---

## 10 · Retiring the flow-backup bucket, and pointing at repositories instead

**Builds on:** [`frontend/src/components/common/FlowBackupUploader.jsx`](../frontend/src/components/common/FlowBackupUploader.jsx) ·
the `gateway-backups` bucket in [`scripts/storage-init.mjs`](../scripts/storage-init.mjs) ·
[`supabase/storage-policies.sql`](../supabase/storage-policies.sql) ·
[`EntityLinksModal.jsx`](../frontend/src/components/modals/EntityLinksModal.jsx) and its tag vocabulary ·
`digital_thread` (`0005`) · **not yet filed as an issue**

**The other end of §9, and it should be sequenced against it rather than planned beside it.** §9
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

## 11 · An ISA-95 Unified Namespace bridge

**Builds on:** the DDATA path in [`ingestion/ingestion.py`](../ingestion/ingestion.py) ·
`public.device_locations` (`0001`) · `cells` (`0001`, `0021`) · `devices.location_scope` ·
[`mosquitto.acl`](../mosquitto.acl) ·
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

## 12 · Contextual help, and where the documentation actually lives

**Builds on:** [`frontend/src/App.jsx`](../frontend/src/App.jsx)'s top bar and `navDensity()` ·
[`README.md`](../README.md) and the six subsystem READMEs ·
[issue #39](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/39)

**The request, and it is a fair one:** *"There's a lot to unpack with this application and going to
the GitHub to read the documentation takes a lot of time."* A help control in the top bar that opens
a panel for the page you are on — Gateways explains gateways — rather than a link that drops you at
the top of a long file.

### The hard part is not the button

It is that **the documentation this would surface does not exist in a form a panel can use.** What
exists is excellent and is written for a different reader: `README.md` and the subsystem READMEs
argue *why* the stack is built as it is, at length, for somebody changing it. A help panel needs the
other half — what this page is for, what the controls do, what the states mean — in a few hundred
words per page.

So the work is mostly writing, and the button is the small end of it. An item that shipped the
control first would produce a help system whose honest content is a link to the README, which is
what the request already finds too slow.

### A GitHub wiki is the wrong store, and this is the decision to make first

The issue proposes one. Against it: **a wiki is not in the repository**, so it cannot be reviewed in
a pull request, cannot be checked by `scripts/check-docs-drift.mjs`, and drifts from the code with
nothing to catch it. This repository has spent real effort making documentation checkable — the
service directory, the migration mentions, the roadmap numbering, the Prometheus job map — and a
wiki opts out of all of it.

**Markdown in `docs/help/<page>.md`, bundled into the frontend**, keeps every one of those
properties: reviewed with the change that motivated it, greppable, and checkable by a guard that
asserts every navigable page has a help file and every help file names a real page. That is the
same bidirectional shape the service-directory check already uses.

The cost is that help ships with the image rather than being editable in a browser. For a stack
whose dashboard is versioned and deployed as one artefact, that is the right side of the trade.

### What the top bar can absorb

`navDensity()` already bands the header at 10 and 12 tabs, and the bar currently carries eleven. A
help control is a **button beside the session controls, not a twelfth tab** — it belongs with the
things that act rather than the things that navigate, and putting it there costs the brand no width
at any band.

**Not a page.** A page called Help that lists everything is the README again with more clicks; the
request is specifically for *contextual* help, which means the panel opens knowing which tab is
active.

### Worth deciding early

- **Whether it is also the empty state.** A page with nothing on it and a page whose help explains
  what to put there are the same moment, and "no gateways yet" is where a reader is most receptive.
- **Whether it survives translation.** Nothing here is localised today, and a help corpus is the
  first thing that would make that expensive.

---
