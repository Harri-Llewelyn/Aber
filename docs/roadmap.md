# Roadmap

**This file lists only what is not built.** Every entry names the code it builds on, states what
remains, and records the decisions already taken so they are not re-argued. When an entry ships,
it leaves this file and its substance moves into the documentation of the component it changed.
**Known issues** stay in [GitHub issues](https://github.com/Harri-Llewelyn/ACS-Cymru/issues);
**accepted risks** live under [Accepted risks](../README.md#accepted-risks).

**The numbers are reading order, not identifiers.** Nothing in the code cites an entry by number
(`CONTRIBUTING.md` says why), so retiring an entry and renumbering the rest costs one grep of
`§[0-9]` in this file.

**Ordering.** 1–4 are the platform's own: the one item somebody else sets the deadline for, then
the identity and operations chain. 5–7 are the edge chain, in dependency order: 5 makes a gateway's
flow reviewable, 6 makes the appliance a managed artefact and shares 5's puller, 7 removes what 5
replaced. 8 runs under every other item. 9 is a rename and sits second to last because nothing
depends on it. 10 is last by rule: it folds the migration chain, so every entry that changes the
schema must have landed before it.

**Retired entries, and where their substance went.**

| Entry | Where it is now |
| :--- | :--- |
| Revocable service tokens (`0074`–`0076`) | [`supabase/README.md`](../supabase/README.md#the-access-control-page-states-what-is-outstanding) |
| Studio behind a login (`0081`, `0082`) | [`supabase/README.md`](../supabase/README.md#the-second-listener-which-is-studios-login-0081) |
| The approvals queue (`0086`–`0091`) | [`supabase/README.md`](../supabase/README.md#the-approvals-queue-and-the-first-write-an-operator-has-ever-had-0086) |
| The forge's door and membership (`0094`) | [`supabase/README.md`](../supabase/README.md#the-forges-door-and-the-room-behind-it-0094) |
| The appliance puller, deploy keys and host-key distribution | [`docs/physical-gateways.md`](physical-gateways.md) |
| Contextual help | [`frontend/README.md`](../frontend/README.md#contextual-help) |
| The Directory's MQTT half | [`ingestion/README.md`](../ingestion/README.md#the-directory-on-mqtt) |
| The log store, structured logging and the drop drill-down | [`ingestion/README.md`](../ingestion/README.md#log-fields), `loki/loki.yaml`, `alloy/config.alloy` |
| The appliance clock offset measurement | [`ingestion/README.md`](../ingestion/README.md) (the `acs_ingestion_gateway_clock_offset_seconds` gauge and its rule); the time source itself is in 6 |
| Kong → Envoy, and the new API key translation | [`docs/gateway-migration.md`](gateway-migration.md) |
| The demonstration floor and simulator | Removed; [`tutorial/README.md`](../tutorial/README.md) builds one machine by hand |
| Horizontal ingestion scaling | Answered, not built: [The single-writer ceiling](../ingestion/README.md#the-single-writer-ceiling). The write path since moved to [the historian writer](../ingestion/README.md#the-historian-writer), one thread and one transaction per batch |
| Ingress → Gateway API for CORS | Answered, not built: it would state origin policy a second way on one of two targets |
| A backup an operator can take without a shell (`0101`) | [`supabase/README.md`](../supabase/README.md#backups-from-the-dashboard-0101): the Backups page, the backup service, the forge in every backup, and the retention and no-download decisions; restore stays [the runbook](../supabase/README.md#backup-and-recovery) |
| The ISA-95 Unified Namespace bridge (`0097`) | [`ingestion/README.md`](../ingestion/README.md#the-unified-namespace) for the bridge; [`supabase/README.md`](../supabase/README.md#the-plant-gains-areas-and-a-third-scope-0097) for the areas, the site setting and the `area_wide` scope |

---

## 1 · Moving off Supabase's legacy API keys

**Builds on:** the gateway's key translation in [`supabase/envoy.yaml`](../supabase/envoy.yaml) ·
`LEGACY_KEYS_ACCEPTED` / `supabaseEnvoy.legacyKeysAccepted` · the `acs-legacy-api-key` access log
and the `rbac.legacy_api_key_.shadow_allowed` counter ·
[Retiring the legacy pair](gateway-migration.md#retiring-the-legacy-pair-and-how-to-know-it-is-safe)

Supabase deprecates the `anon` and `service_role` JWTs by the end of 2026. The gateway accepts the
replacement `sb_publishable_*` / `sb_secret_*` keys alongside them on both targets, every caller in
this repository prefers the new key, and the switch that stops accepting the legacy pair exists and
refuses the one combination that would lock everybody out.

**What remains is operational, not editorial.** The switch defaults to `true` because turning it
off is an outage for anything still presenting a legacy key, and this repository cannot know who
that is. Watch both instruments on a real deployment over a window covering its slowest periodic
job, then set `LEGACY_KEYS_ACCEPTED=false`. This entry stays until a deployment has run
deactivated.

The signing algorithm (HS256 on `SUPABASE_JWT_SECRET`) is a different question and not in this
item; every component verifies with the shared secret, and moving off it would be an item of its
own.

---

## 2 · Microsoft Entra ID sign-in

**Builds on:** `custom_access_token_hook()` and `handle_new_user()` in `0001` · `has_role()` ·
`GOTRUE_DISABLE_SIGNUP` · `acs-cymru.validateSecrets` in `_helpers.tpl` · the role split (`0069`),
which is built and was the prerequisite

Sign in with a Microsoft work account, with the organisation's Entra groups deciding which role the
account lands in, and documentation an IT administrator can follow without reading this repository.
Entra only: it expresses groups and app roles; GitHub org membership is not in the OIDC token and
Google Workspace groups need a separate API, so those could only map by email domain.

**The tenant boundary fails open and must be refused, not ignored.** GoTrue's Azure provider falls
back to `common` (every Microsoft account, personal ones included) when the authority is unset.
`organizations` and `consumers` are equally wrong. So: one variable, `ENTRA_TENANT_ID`, a GUID;
refuse to enable the provider when it is empty or names any of those three; enforce it in the
chart (`acs-cymru.validateEntra`) and in `scripts/setup.mjs`; and, because `.env` is editable after
setup, check the `tid` claim on the provisioning path against a value held in `system_settings`.

**Closed signup collides with first-time federated logins.** Confirm that
`GOTRUE_DISABLE_SIGNUP=true` refuses them (expected). If it does, deny the signup route at the
gateway and leave the OAuth callback open rather than flipping the variable, which reopens
`POST /auth/v1/signup` to every caller.

**The IdP authenticates; `user_roles` still authorises.** Never read a role out of user metadata:
`raw_user_meta_data` is writable by the user through `updateUser`. A group claim is a provisioning
input, consulted at sign-in by an `sso_role_mappings(provider, claim_key, claim_value, role_id)`
table that writes `user_roles`; `has_role()`, every policy and the Access Control tab are unchanged.
Whether Entra group claims survive into `identity_data` on `gotrue:v2.189.0` is unverified; spike it
before designing the table.

**Worth deciding early.** Whether the login screen offers both paths (seeded password accounts as
break-glass) or one. What happens when a user leaves the group: nothing revokes on its own, and
re-evaluating on every login still leaves a session valid until `GOTRUE_JWT_EXP`.

---

## 3 · Multi-factor authentication

**Builds on:** GoTrue's factor API · the `aal` and `amr` claims · `has_role()` ·
[`AccessControlTab.jsx`](../frontend/src/components/tabs/AccessControlTab.jsx) · the role split
(`0069`), so a `Shopfloor_Manager` can no longer dissolve an MFA boundary

TOTP second factors, required of the roles that can change the platform and optional for everyone
else. Any TOTP authenticator works.

**`aal2` is not a switch.** GoTrue mints an `aal1` token for a user with a factor enrolled, and a
challenge screen in the browser is not enforcement. Enforcement is `(auth.jwt()->>'aal') = 'aal2'`
in the policies, beside `has_role()`, and deciding which policy sites are privilege-changing enough
to demand it is a judgement per policy.

**Never prompt a federated user twice.** `amr` says how the session was obtained: federated users
inherit assurance from the IdP; password users enrol a factor here. Password users do not go away
when 2 ships (seeded personas, break-glass, air-gapped installs).

**There are no recovery codes.** The administrative path is the design: a **Reset MFA** control in
the Access Control tab, gated on `authz:manage`, calling `auth.admin.mfa.deleteFactor()` and written
to the digital thread. The residual case (one Administrator, locked out) is the service-role key
from `.env` and a documented one-liner; recommend two Administrators.

**Must not touch:** machine identities. A policy that demands `aal2` on a table a service principal
writes is an outage.

**Worth deciding early.** Whether enrolment can be deferred (the strong position makes the first
login on a fresh stack an enrolment screen). Home-grown recovery codes are buildable and not worth
it: a code can only drop MFA and force re-enrolment.

---

## 4 · The broker's Dynamic Security plugin

**Builds on:** [`mosquitto.acl`](../mosquitto/mosquitto.acl) ·
[`gateway-credential-service.mjs`](../scripts/gateway-credential-service.mjs) ·
`revoke_gateway_credentials()` (`0038`, `0063`) · `BROKER_PRINCIPALS` in
[`serviceIdentities.js`](../frontend/src/utils/serviceIdentities.js) ·
[`check-broker-config.mjs`](../scripts/check-broker-config.mjs) · `mosquitto_dynamic_security.so`,
which ships in `eclipse-mosquitto:2.0.22`

Move broker authentication and authorisation from `password_file` + `acl_file` onto the Dynamic
Security plugin, managed over `$CONTROL/dynamic-security/v1`.

**Two things the files cannot do.** Revocation does not disconnect: Mosquitto checks credentials at
CONNECT only, so an archived gateway that is already connected keeps publishing until it reconnects;
dynsec's `disableClient` kicks the live session. And there is no list: the Access Control page holds
a literal because the ACL is never parsed by anything with an HTTP surface; `listClients` would
make it a live read.

**What it costs.** It inverts the credential service's minimal authority (add one line becomes
create, delete, list and rewrite over every principal). `mosquitto.acl` is the most heavily verified
artefact in the repository, and a dynsec policy subtly wider than it fails silently at QoS 0.
`dynamic-security.json` is mutable state on both targets, and boot must reconcile rather than
rewrite; on Kubernetes it needs a PVC the broker does not have.

**Worth deciding early.** Whether dynsec can coexist with `password_file` for one listener (assume
not). Whether dynsec ACLs substitute `%u`, measured in `check-broker-config.mjs` before anything
else. Whether `listClients` is exposed to the dashboard at all (a LIST verb was refused once for the
inventory it hands a token holder). Whether revocation alone justifies the move: rewriting the
account to an unguessable password and bouncing that one session may be cheaper.

---

## 5 · GitOps edge sync

**Builds on:** the forge (`gitea`, `gitea-init.sh`), one private repository per enrolled gateway
in the `gateways` organisation ([`_shared/forge.ts`](../supabase/functions/_shared/forge.ts)) ·
the per-gateway read-only deploy key and the host key delivered at enrolment
([`enroll-gateway`](../supabase/functions/enroll-gateway/index.ts)) · the puller
[`flow-sync.mjs`](../gateway-bundle-template/flow-sync.mjs) · the forge's door and
[`forge-membership`](../supabase/functions/forge-membership/index.ts) (`0094`) · the push webhook and
[`forge-events`](../supabase/functions/forge-events/index.ts) (`0095`) · the flow hash in the
heartbeat · issue [#63](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/63)

**What is built** is documented in [`docs/physical-gateways.md`](physical-gateways.md) and
[The forge's door](../supabase/README.md#the-forges-door-and-the-room-behind-it-0094): an
appliance clones its own repository over SSH with a read-only key, verifies the forge against the
host key it received at enrolment, deploys `flows.json` and reloads Node-RED when the tracked branch
advances; it refuses a rewritten history, an unverifiable forge, and a commit whose `mqtt-broker`
node id is not a key in `flows_cred.json`. Administrators and managers sign in to the forge with
their dashboard identity; `main` is protected on every repository with one approval required from
`administrators`. The proposal lane through an edge function was built and retired the same day: a
pull request opened in the forge under the author's own name is the better record, and the dashboard
links the repository, its issues and its wiki instead. Each repository comes furnished: a wiki Home
page naming the gateway (the unreviewed half, by design), an *Incident* issue template, and a push
webhook that records the head of `main` on the gateway row so a merge shows in the drawer at once
([What a gateway's repository comes with](../supabase/README.md#what-a-gateways-repository-comes-with-and-how-the-forge-reports-back-0095)).
Both teams may create repositories in the organisation. Gitea's own sign-out is the platform's.
A sweep on a timer (`0099`) reconciles team membership with `user_roles`, re-registers a missing
push webhook, and protects `main` on any repository made by hand in the organisation. The forge's
volume, host keys included, is in every backup the backup service takes (`0101`). A flow the
appliance deploys is a `FLOW_DEPLOYED` row in the digital thread (`0100`), written by the daemon
from the heartbeat as `ingestion`; the puller never touches the database, so no fourth actor kind.

**What remains.**

- **A required status check refusing `flows_cred.json` by shape.** The endpoint that used to refuse
  it is gone, and a file uploaded through the forge's own UI meets no check until the puller
  refuses it on the appliance, which is late. It needs a Gitea Actions runner, which 6 argues on;
  until then the puller's refusal is the only check.
- **A failed webhook delivery does not alert.** It is visible on the hook's page in the forge and
  nowhere else. A repository from before `0095` gets its hook back from the sweep but not its
  incident template, which the machine account cannot commit to a protected `main`; an
  administrator adds it by pull request. Small, and not urgent.

**Constraints.** Deploy only what is committed; a revert is a new commit and never a force-push
(branch protection in the forge, and `flow-sync.mjs` refuses a non-descendant head); `flows_cred.json`
never leaves the appliance in a backup, a commit or a diff; the enrolment token stays single-use and
`bootstrap.mjs` enrols once; `Operator` and `Auditor` hold no forge login and no shopfloor person is
a Gitea user. If 2 lands, federating the forge to Entra directly is an alternative to the Envoy door
and the choice re-opens on the evidence of both.

---

## 6 · The appliance itself, and the code somebody wants to run on it

**Builds on:** [`gateway-bundle`](../supabase/functions/gateway-bundle/index.ts) ·
[`gateway-bundle-template/`](../gateway-bundle-template) · `bootstrap.mjs`'s once-only guard ·
[`docs/physical-gateways.md`](physical-gateways.md) · the `apikey` gate and its four exemptions ·
[`check-gateway-surface.mjs`](../scripts/check-gateway-surface.mjs) ·
[`deploy/k8s/internal-ca.yaml`](../deploy/k8s/internal-ca.yaml) · the clock offset gauge and its
alert · 5, whose forge and puller this reuses · arrives from a request to run custom data-gathering
software on gateways, for legacy machinery

Three subjects that are one appliance: commissioning as a pasted command, the operating system as
a managed artefact, and a lane for bespoke adapters. They should not be started as one piece of
work.

### The one-liner

`curl -fsSL -H "X-Enrolment-Token: <token>" https://api.<domain>/... | bash`, with the dashboard
minting (role-gated) and the appliance fetching (token-gated), which is `enroll-gateway`'s model
rather than `gateway-bundle`'s. The token travels in a header, never the query string. Fetching
validates the token; only enrolling consumes it. The installer is static and tagged in the forge;
the per-gateway secrets (`NODERED_CREDENTIAL_SECRET`) come from a token-gated fetch and are never
cacheable. The script wraps its body in a function invoked on the last line so a truncated download
runs nothing.

**The CA is the gating question.** A fresh appliance does not trust the internal root, and a
one-liner that ends in `curl -k` is worse than the ZIP. Decided direction: **the pin rides in the
token and the script checks it** (RFC 7030 §4.1.1). The dashboard mints an SPKI fingerprint of the
live root beside the token; stage 0 fetches the PEM as inert bytes over plain HTTP from a static
ingress path, hashes it, refuses on mismatch, and everything after is verified TLS. Pin the public
key, not the certificate (`renewBefore: 8760h` re-issues the root a year early; `rotationPolicy:
Never` keeps the key). The appliance must also check the CA it enrols with against the pin, because
the broker root and the ingress root are allowed to differ. A cloud-init seed that plants the root
is the zero-circularity answer for a plant that images its own appliances. Since the `apikey` gate
is on `/functions/v1/`, serving the PEM from the ingress costs no fifth exemption.

### The operating system

Ubuntu Server as a requirement, which closes the Windows-gateway seam the bundle's compose file
still describes. `unattended-upgrades` without automatic reboot. **`ansible-pull`**, not Ansible:
outbound only, no inventory, self-healing on a timer, idempotent by construction. Two playbooks and
the split is the security boundary: a **platform** playbook (Node-RED, `node_exporter`, the CA, the
upgrade configuration, the time source) in one repository the whole fleet reads, tagged, with
appliances tracking a tag rather than `main` so one merge cannot converge every appliance on the
next timer; and a **custom** playbook in the gateway's own repository beside its flow. When it
lands, scheduling and platform convergence become Ansible's; everything below `flow-sync.mjs`'s
`deployFlow()` stays Node-RED knowledge, which is why `--once` exists.

**The time source belongs here.** Nothing in the repository sets an appliance's clock. TLS tolerates
the skew the telemetry path does not: a gateway three minutes fast verifies every certificate and
writes every sample three minutes into the future, silently, forever. The platform now measures the
offset per gateway and alerts on it; the fix is `chrony` in the package set, pointed at something
the plant can reach. Decide, with the measurement in hand: whether an appliance with a bad clock
should publish at all (today it is fail-open inside five minutes and fail-closed outside); whether
the platform is itself a time source for the air-gapped case; whether an RTC module is a hardware
requirement for single-board appliances; and whether `TELEMETRY_MAX_FUTURE_SECONDS` is right. Do not
correct device timestamps at ingest.

### Custom code

Admissible on one condition: **a container built from a commit, pulled by the appliance, never a
payload handed to it.** The motivating case is legacy machinery (serial, Modbus, OPC-DA) that no
Node-RED node reaches; the adapter is worth nothing to anybody else and has no business in this
repository, and it runs unattended for years, which is the argument for the forge being mandatory.

That means a build plane: Gitea Actions and its package registry, both off today. A runner
executes arbitrary code and should not share a host with the database. The registry is a fourth
credential plane unless Gitea's registry accepts the deploy key as the pull credential — measure
that before designing enrolment around it. Pin by digest; sign the image; build multi-arch or
declare an architecture per gateway, because a fleet is arm64 and amd64 in the same plant and an
image for the wrong one fails at `docker run` in front of whoever is commissioning it.

**The adapter holds no credential.** It publishes locally (HTTP or a local topic) and Node-RED
republishes on the one Sparkplug connection the appliance holds, so `%u` confinement still means what
it says and schema conformance and quarantine still apply. A workload that needs its own identity
is a second gateway and should enrol as one. Not Portainer; not a k3s agent on gateways.

**Worth deciding early.** One repository per gateway or per plant for custom code (engineers think
in projects). Whether the platform builds images or only pulls them. What the heartbeat reports
about a failing custom container, which is the failure this lane is most likely to produce and
least likely to notice. Reporting the `notAfter` of the root the platform is currently issuing from,
beside the per-gateway `Cert_Expires_At` the fleet already reports, so a rotation in progress is
visible; read it from the credential service's `ca.crt`, never from the Kubernetes API. Whether the
HTTPS side should refuse to run unencrypted the way the physical-gateway enrolment leg already
does.

---

## 7 · Retiring the flow-backup bucket

**Builds on:** the `gateway-backups` bucket in [`storage-init.mjs`](../scripts/storage-init.mjs) ·
[`storage-policies.sql`](../supabase/storage-policies.sql) · `GATEWAY_BACKUP_BUCKET` in
`.env.example`, `docker-compose.yml` and `values.yaml` · `test_gateway_enrollment.py`'s policy
assertions

The browser half is done: nothing in the dashboard reads or writes the bucket, and a gateway's flow
lives in its repository in the forge. What remains is the bucket itself, deliberately still created
and governed so nothing can quietly start writing to it, and the one change that removes it has to
decide what happens to whatever an earlier install already stored there. Retention is now decided
once, in the backup service (a window for scheduled backups, a pin for requested ones), and the
bucket's contents fall under the same answer: kept in a backup, not in a second store.

The repository pointer is derived (`gateway-<sparkplug_id>` in the organisation named in
`constants.js`), not stored; a column is earned only if a gateway ever needs re-pointing. A tracked
branch other than `main` is the one part that genuinely does not fit and is a small separate
decision. **Archiving a gateway should archive its repository and its wiki** (Gitea archives both
together), and deleting one is the retention question again: the wiki is the one place a plant's
notes about a gateway live, so a delete is a decision and never a cascade. The forge is in every
backup now, so a deleted repository is recoverable from one for as long as the backup is kept.

---

## 8 · The transport between services

**Builds on:** [`networkpolicy.yaml`](../deploy/helm/acs-cymru/templates/networkpolicy.yaml) ·
[`internal-ca.yaml`](../deploy/k8s/internal-ca.yaml) ·
[`mosquitto-tls.conf`](../mosquitto/mosquitto-tls.conf) · `mosquitto.tls.internalClients` and
`MQTT_TLS_ENABLED` · the DSN helper in `_helpers.tpl` ·
[`datasources.template.yml`](../grafana/provisioning/datasources/datasources.template.yml) ·
[`check-compose-chart-parity.mjs`](../scripts/check-compose-chart-parity.mjs)

**Built:** default-deny NetworkPolicy from one edge list (opt-in), an internal CA outside the
chart, TLS on the Ingress and the broker's 8883 listener, `%u` confinement, the `apikey` gate, the
database ports and the metrics endpoints on loopback, and no skip-verification setting anywhere.

**The gap is what is on the wire.** NetworkPolicy answers *who*; every internal hop is plaintext:
`sslmode=disable` on GoTrue's DSN, the PostgREST DSN the chart builds and both Grafana datasources,
and HTTP between the gateway and every upstream. The Postgres links carry scoped credentials and
every row.

**In order of cost.** Turn on `mosquitto.tls.internalClients` / `MQTT_TLS_ENABLED`, which moves
ingestion, i3X and Node-RED to 8883 together and fails closed; the work is making it the supported
posture, not the switch. Then Postgres: `verify-full` needs certificates naming the Service or
container the client dials, and Compose has no cert-manager, which is the point where the two
targets need different mechanisms for one property. Then an end state for plaintext 1883, which is
deliberate today for the fleet migration window.

**The two targets disagree about posture and nothing states it.** The default-deny layer is
Kubernetes-only and opt-in; Compose has a Docker network and no seam for a policy. That is recorded
as an accepted risk now; the statement of what each target enforces belongs in
`check-compose-chart-parity.mjs`, which prints known gaps on every run.

**Port-free URLs on Compose** are a third `Host`-routed listener on `supabase-envoy`, mirroring the
chart's subdomains, not a second proxy. The blocker is a wildcard DNS record this project does not
own; design the `nip.io` escape hatch in from the start. MQTT and git-over-SSH do not ride it.

**Client certificates on the gateway link** (`CN = <sparkplug_id>`, so `%u` still matches) are the
intended direction and wait for 4, because `crlfile` revocation needs a reload.

**Must not touch:** `%u` confinement, the origin policy's single home in `envoy.yaml`, the root's
residence outside the chart, and the absence of a skip-verification switch. A service mesh is the
complete answer and does nothing for Compose.

**Worth deciding early.** Whether Compose is in scope for the posture or only the transport.
`require` or `verify-full` for Postgres. `internalClients` and any remaining loopback bindings flip
in separate changes.

---

## 9 · Cells become work centers

**Builds on:** `public.cells` and everything that names it · `public.areas` (`0097`) ·
[The Unified Namespace](../ingestion/README.md#the-unified-namespace) ·
[`CONTRIBUTING.md`](../CONTRIBUTING.md)

The stack's data model uses plant words where the standards have their own: a `cell` is an ISA-95
work center, and the Areas page and the `uns/` topics were the first surfaces to use the standard's
word deliberately. The remaining inconsistency is the table, its API routes, its permission
(`cell:manage`), its proposal lane, the `CELL` thread kind and the word on every page.

**`devices` stays.** A device is Sparkplug's word and the row is a Sparkplug device; "work unit" is
the ISA-95 view of the same row and appears only where the hierarchy is being named. ISA-95 also
uses "cell" at both levels (a process cell is a work center type, a work cell a work unit type), so
the rename resolves an ambiguity the standard itself carries.

**Decided:** the rename is a migration and a sweep, not a synonym layer. A view named `cells` over
`work_centers` would give the frontend two names for one thing, which is the state this entry
exists to remove. The migration is additive-then-subtractive across two releases so the frontend
and the edge functions can move between them; the `cell:manage` permission UUID is immutable and
only its name changes. `sparkplug_id` and every topic are untouched: a cell is not addressed on the
wire.

**Must not touch:** the `uns/` topic shape, which already uses the cell's name and not the table's.

## 10 · The migration chain folds back into the baseline, and the codebase is audited

**Builds on:** [`supabase/README.md`](../supabase/README.md#why-those-nine-survived-the-squash-and-nothing-else-did) ·
`scripts/test-db.mjs` · `scripts/check-docs-drift.mjs` · [`CONTRIBUTING.md`](../CONTRIBUTING.md)

The first squash folded the beta chain into `0001` and `0002` and left a short corrective tail.
The tail has grown, and later files now correct earlier ones. `0088` drops and re-adds the
proposal entity constraint with three lanes and `0090` widens it to seven two files later; on a
database holding a cells proposal the re-add scans the rows, fails, and aborts db-init with every
file after it. `0097` re-adds the integer `cells.floor` on every boot and `0098` drops it again.
Both are idempotent and both are tested, and both are the shape a squash exists to remove.

**Decided:** the fold rule is the first squash's. An additive migration folds into the baseline,
because a fresh install would do it anyway; a subtractive one stays in the tail until every
database that could receive it has. Two rules found the hard way carry in: a file that creates a
function states its own `REVOKE ... FROM PUBLIC, anon` rather than leaning on `0001`'s sweeper,
which runs earlier and corrects the ACL one boot late; and no file re-asserts an absolute set that
a later file widens. Constraints are added guarded, never dropped and re-added.

**The audit** is scoped to what the Site Map work exposed, one sweep per surface: help pages and
README rows that describe a design since replaced; stylesheet rules and the tests guarding them
that nothing renders; comments that argue history rather than state the present, moved to the
README or `incidents.md` they belong in; and every claim the drift checker could verify but does
not yet, made checkable.

**Done means:** a fresh boot and a second boot pass every self-check; every database suite passes
on the throwaway cluster; the drift check is clean; and the chain is the baseline plus a tail
short enough to read in one sitting.

**Must not touch:** the replay contract. Every file still runs on every boot with no ledger, so
nothing in the fold may depend on a file having run once.
