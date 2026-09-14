# Roadmap

**This file lists only what is not built.** Every entry names the code it builds on, states what
remains, and records the decisions already taken so they are not re-argued. When an entry ships,
it leaves this file and its substance moves into the documentation of the component it changed.
**Known issues** stay in [GitHub issues](https://github.com/Harri-Llewelyn/ACS-Cymru/issues);
**accepted risks** live under [Accepted risks](../README.md#accepted-risks).

**It lists only what 1.0 must or should have.** A thing that is not built and that 1.0 does
not need is a feature request, not an entry here: open one with
[the template](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/new?template=feature_request.yml)
and it competes with every other request rather than sitting in the release's critical path.
An entry that turns out to be a could-have leaves the same way an entry that ships does — it
moves out, and the table below says where it went.

**The numbers are reading order, not identifiers.** Nothing in the code cites an entry by number
(`CONTRIBUTING.md` says why), so retiring an entry and renumbering the rest costs one grep of
`§[0-9]` in this file.

**Ordering.** 1 is the platform's own: the rehearsal that turns the backup into a capability.
2 is the edge chain: the appliance as a managed artefact, on the forge, puller and appliance
branch that have shipped. 3 reviews playback before the chain is folded, because a finding there
may change the schema. 4 audits the documentation, code and comments once the code has stopped
moving. 5 is last by rule: it folds the migration chain, so every entry that changes the schema
must have landed before it.

**Retired entries, and where their substance went.**

| Entry | Where it is now |
| :--- | :--- |
| Revocable service tokens (`0074`–`0076`) | [`supabase/README.md`](../supabase/README.md#the-access-control-page-states-what-is-outstanding) |
| Studio behind a login (`0081`, `0082`) | [`supabase/README.md`](../supabase/README.md#the-second-listener-which-is-studios-login-0081) |
| The approvals queue (`0086`–`0091`) | [`supabase/README.md`](../supabase/README.md#the-approvals-queue-and-the-first-write-an-operator-has-ever-had-0086) |
| The forge's door and membership (`0094`) | [`supabase/README.md`](../supabase/README.md#the-forges-door-and-the-room-behind-it-0094) |
| The appliance puller, deploy keys and host-key distribution | [`docs/physical-gateways.md`](physical-gateways.md) |
| GitOps edge sync (`0094`, `0095`, `0099`, `0104`) | [`supabase/README.md`](../supabase/README.md#the-appliance-reports-on-a-branch-of-its-own-0104) for the appliance branch, the writable key and the three rules that confine it, and the sweep's key reconcile; [`docs/physical-gateways.md`](physical-gateways.md#what-the-appliance-reports-back) for the operator's view. The one bullet not built, a required status check refusing `flows_cred.json` by shape, needs the runner and moved into *The appliance itself*. Two small things stay unbuilt and are recorded in the README section: a failed webhook delivery is visible only on the hook's page in the forge, and a repository from before `0095` gets no incident template from the sweep |
| Contextual help | [`frontend/README.md`](../frontend/README.md#contextual-help) |
| The Directory's MQTT half | [`ingestion/README.md`](../ingestion/README.md#the-directory-on-mqtt) |
| The log store, structured logging and the drop drill-down | [`ingestion/README.md`](../ingestion/README.md#log-fields), `loki/loki.yaml`, `deploy/helm/acs-cymru/templates/obs/alloy.yaml` |
| The appliance clock offset measurement | [`ingestion/README.md`](../ingestion/README.md) (the `acs_ingestion_gateway_clock_offset_seconds` gauge and its rule); the time source itself is in 2 |
| The broker's Dynamic Security plugin (`0102`) | [`mosquitto/README.md`](../mosquitto/README.md) for the policy, the measured facts and the boot reconcile; [`supabase/README.md`](../supabase/README.md#the-access-control-page-states-what-is-outstanding) for the live Broker column, the orphaned-accounts list and a revocation that disconnects |
| Kong → Envoy, and the new API key translation | [`docs/gateway.md`](gateway.md); Kong is deleted from the chart, not kept as a revert path, because a gateway that cannot match the `sb_*` keys cannot serve any caller |
| Moving off Supabase's legacy API keys | Shipped, as a code change rather than the operational switch the entry described: with no deployment before 1.0 there was no unknown caller to watch for, so the gateway admits only the `sb_publishable_*` / `sb_secret_*` pair, every consumer presents it, the switch and its two instruments are gone, and `validate.py` proves a JWT presented as an apikey is refused. [`docs/gateway.md`](gateway.md) |
| The demonstration floor and simulator | Removed; [`tutorial/README.md`](../tutorial/README.md) builds one machine by hand |
| Horizontal ingestion scaling | Answered, not built: [The single-writer ceiling](../ingestion/README.md#the-single-writer-ceiling). The write path since moved to [the historian writer](../ingestion/README.md#the-historian-writer), one thread and one transaction per batch |
| Ingress → Gateway API for CORS | Answered, not built: it would state origin policy a second way on one of two targets |
| A backup an operator can take without a shell (`0101`) | [`supabase/README.md`](../supabase/README.md#backups-from-the-dashboard-0101): the Backups page, the backup service, the forge in every backup, and the retention and no-download decisions; restore stays [the runbook](../supabase/README.md#backup-and-recovery) |
| The ISA-95 Unified Namespace bridge (`0097`) | [`ingestion/README.md`](../ingestion/README.md#the-unified-namespace) for the bridge; [`supabase/README.md`](../supabase/README.md#the-plant-gains-areas-and-a-third-scope-0097) for the areas, the site setting and the `area_wide` scope |
| Microsoft Entra ID sign-in | Not built, and not needed for 1.0: a could-have, reopened as [#183](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/183). Every decision the entry had taken is in the request |
| Multi-factor authentication | Not built, and not needed for 1.0: a could-have, reopened as [#184](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/184). The `0069` role split it waited on has shipped; the rest is in the request |
| Cells become work centers | Answered, not built: a cell is itself one of ISA-95's work center types, so the standard's name is given where the hierarchy is named rather than replacing the word. [`ingestion/README.md`](../ingestion/README.md#the-unified-namespace) records the decision; each page's help Summary names its ISA-95 level |
| The transport between services | Built for the broker and both databases: [`deploy/k8s/README.md`](../deploy/k8s/README.md#mqtts-on-8883) (in-cluster clients on 8883 by default, 1883 withdrawing to loopback) and [`deploy/k8s/README.md`](../deploy/k8s/README.md#tls-to-the-databases) (`postgresTls`: `verify-full` everywhere, `hostssl`-only pg_hba, Realtime's tenant link as the one named exception). HTTP between the gateway and its upstreams stays plaintext: none of them terminates TLS itself, so that hop is a TLS sidecar per pod, which is a service mesh, and a service mesh is the complete answer. Answered, not built. Gateways hold no client certificate: the dynsec password and the pinned root already give identity, confinement and a revocation that disconnects |
| Retiring the flow-backup bucket | Removed: the `gateway-backups` bucket, its policies, its chart values and its policy test are gone, and no install had stored anything in it. A gateway's flow lives in its repository in the forge ([`docs/physical-gateways.md`](physical-gateways.md)); the repository pointer stays derived (`gateway-<sparkplug_id>` in the organisation `constants.js` names), a column is earned only if a gateway ever needs re-pointing. Archiving a gateway does not yet archive its repository: a could-have, reopened as [#197](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/197), which also carries the rule that deleting one is a decision, never a cascade |

---

## 1 · A restore is rehearsed from a backup the service took

**Builds on:** [`restore-rehearsal.yml`](../.github/workflows/restore-rehearsal.yml) ·
[`scripts/restore-databases.sh`](../scripts/restore-databases.sh) ·
[`scripts/backup-service.mjs`](../scripts/backup-service.mjs) and
[Backups from the dashboard](../supabase/README.md#backups-from-the-dashboard-0101) (`0101`) ·
issue [#155](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/155)

The backup an Administrator takes on the Backups page has been taken and its digests checked, and
nothing has yet restored from one. The weekly rehearsal in CI restores the CronJob's flat dumps
into a disposable cluster and compares row counts; it has been failing since the Actions
allowance ran out, and it knows nothing of the service's per-stamp directory or the forge archive. Until one restore has run end to end from a service-made directory, the
README's own line applies: an untested backup is a belief, not a capability.

**What remains.**

- **Make the weekly rehearsal pass again** (#155), then move its backup step onto the service:
  install with `backupService.enabled`, call `request_backup()` as the seeded Administrator,
  wait for the `backups` row, and restore from the directory it names rather than from the
  CronJob's files.
- **Rehearse the forge.** Restore `forge-<stamp>.tar.gz` into an empty forge volume and assert
  that every gateway repository is back, that `main` is still protected, and that the SSH host
  key is byte-identical to the one an enrolled appliance pinned, because a forge restored without
  it is a fleet-wide re-enrolment.

**Decided:** restore stays a runbook and a rehearsal, never a button; the rehearsal is CI's and
weekly, not the service's; and a rehearsal that restores the data layer alone is reported as
that, as the workflow's header already insists.

**Worth deciding early.** Whether the broker's CA and the Dynamic Security plugin's document
(`mosquitto_certs`, `mosquitto_dynsec`; the `mosquitto-data` PVC on Kubernetes) join the tier 1
backup. Neither is in it today; losing the root is a fleet-wide re-enrolment, losing the document
is every gateway re-issued, and only a tier 2 snapshot saves them. Whether the platform's
own Node-RED data joins for the same reason. Whether the rehearsal should also prove the
retention prune removes exactly the directory the row named and nothing beside it.

---

## 2 · The appliance itself, and the code somebody wants to run on it

**Builds on:** [`gateway-bundle`](../supabase/functions/gateway-bundle/index.ts) ·
[`forge/gateway-platform/appliance/`](../forge/gateway-platform/appliance) · `bootstrap.mjs`'s once-only guard ·
[`docs/physical-gateways.md`](physical-gateways.md) · the `apikey` gate and its four exemptions ·
[`check-gateway-surface.mjs`](../scripts/check-gateway-surface.mjs) ·
[`deploy/k8s/internal-ca.yaml`](../deploy/k8s/internal-ca.yaml) and
[`mosquitto-tls-init.mjs`](../scripts/mosquitto-tls-init.mjs) · the clock offset gauge and its
alert · the forge, the puller and the appliance branch
([`docs/physical-gateways.md`](physical-gateways.md), [The appliance reports on a branch of its
own](../supabase/README.md#the-appliance-reports-on-a-branch-of-its-own-0104)), which this
reuses · the platform playbook ([`forge/gateway-platform/`](../forge/gateway-platform),
[published by the sweep](../supabase/README.md#the-platform-playbook-is-published-by-the-sweep)) · the three revocation handles (`disableClient` in the credential service,
`withdraw_gateway_enrollment_tokens()`, and the deploy key reconcile in `forge-sweep`) · arrives
from a request to run custom data-gathering software on gateways, for legacy machinery

Four subjects that are one appliance: commissioning as a pasted command, the operating system as
a managed artefact, the forge as the appliance sees it, and a lane for bespoke adapters. They
should not be started as one piece of work. Ubuntu and Ubuntu Server are the operating system,
amd64 and arm64 alike; another OS is a feature request.

### The one-liner and the CA

**Built** (`0105`, `gateway-install`, `forge/gateway-platform/install.sh`;
[The one-liner](../supabase/README.md#the-one-liner-0105) and
[`docs/physical-gateways.md`](physical-gateways.md#on-the-appliance-the-command)): the dashboard
mints the token and an SPKI pin of the platform's root beside it over the authenticated session;
stage 0 fetches the root as inert bytes over plain HTTP from the dashboard's host, checks the pin,
installs it; stage 1 fetches the installer over verified TLS with the token in a header, never the
query string, and runs it with the token in its environment; the installer, the playbook and the
per-gateway `.env` are token-gated fetches that validate without consuming
(`peek_gateway_enrollment_token()`), never cacheable, with the credential secret generated per
fetch and written once; install first, enrol last, the same command re-runnable until enrolment;
the body a function invoked on the last line. The installer is served from the platform's own copy
of the playbook, which is the content the tag in the forge carries, rather than read from the
forge at the tag: same bytes, no forge dependency on the commissioning path. The route refuses a
plain-HTTP public URL, which decided the *worth deciding early* question; the development values
alone override it. The appliance checks the root it enrols with against the pin and notes a
difference rather than refusing, since that root arrived over TLS the pin verified.

**Still open:** a cloud-init seed that plants the root, the zero-circularity answer for a plant
that images its own appliances (the command works there too, with stage 0 finding the root
already trusted). A deployment that redirects plain HTTP to HTTPS on the dashboard's host breaks
stage 0 closed (curl stops, nothing is sent); the chart adds no such redirect.

### The operating system

**Built**, as [`forge/gateway-platform/`](../forge/gateway-platform) and
[The platform playbook is published by the sweep](../supabase/README.md#the-platform-playbook-is-published-by-the-sweep):
`unattended-upgrades` without automatic reboot, Docker's packages held out of it; **`ansible-pull`**,
not Ansible, on an hourly timer the playbook itself installs; the **platform** playbook in one
repository the whole fleet reads, in its own `platform` organisation with `main` admitting the
machine account alone; `platform.yml` in each gateway's repository as the per-gateway pointer,
seeded at enrolment and changed by pull request; `chrony` in the package set, pointed at what
`platform.yml` names; and the compose project deployed from the tagged copy of the bundle
template. Scheduling and platform convergence are Ansible's; everything below `flow-sync.mjs`'s
`deployFlow()` stays Node-RED knowledge, which is why `--once` exists.

**Not yet:** the optional **custom** playbook in a gateway's own repository beside its flow (every
gateway runs the platform playbook; "custom" is a gateway whose repository also carries a
playbook, not a choice between two), which the converge script does not look for yet; and the CA
bundle, which is under *Revocation and rotation*.

**The time source: decide, with the measurement in hand,** whether an appliance with a bad clock
should publish at all (today it is fail-open inside five minutes and fail-closed outside); whether
the platform is itself a time source for the air-gapped case; whether an RTC module is a hardware
requirement for single-board appliances; and whether `TELEMETRY_MAX_FUTURE_SECONDS` is right. Do not
correct device timestamps at ingest.

### The forge, as the appliance sees it

**Built.** One SSH key per appliance, generated on it, registered twice: read-write on its own
repository, read-only on the platform repository. `main` on both admits no deploy key;
`appliance` on the gateway repository admits them and blocks force-push, and a `**` rule closes
every other branch. That is the whole policy: pull and push its own repository, pull the
platform's, reach nothing else, and the sweep reconciles both links per gateway (an archived one
holds none). A Gitea user per gateway would have expressed the same policy through teams, at the
cost of a third kind of principal the membership sweep would have to exempt, and a user can open
issues and create repositories in the organisation, which a deploy key cannot. Both dashboard
teams read the platform repository through its `readers` team.

**Measured** (gitea/gitea:1.27.3): one public key is accepted as a deploy key on two repositories
with a different mode on each (`key_id` shared, `read_only` per repository), so the appliance
generates one key and no second. A writable deploy key can push to the repository's wiki, which
no rule covers; that is an [accepted risk](../README.md#accepted-risks).

**A required status check refusing `flows_cred.json` by shape.** A file uploaded through the
forge's own UI meets no check until the puller refuses it on the appliance, which is late. It
needs the Gitea Actions runner argued under *Custom code*; until then the puller's refusal is the
only check.

### Custom code

Admissible on one condition: **a container built from a commit, never a payload handed to the
appliance.** The motivating case is legacy machinery (serial, Modbus, OPC-DA) that no Node-RED
node reaches; the adapter is worth nothing to anybody else and has no business in this repository,
and it runs unattended for years, which is the argument for the forge being mandatory.

**Built on the appliance, from the tagged checkout of the gateway's own repository.** The bundle
already builds its image on the appliance, so this costs no new mechanism, no registry, and no
fourth credential plane: the deploy key is the only thing the appliance holds and the registry
could not have accepted it. Pin the base image by digest; an image for the wrong architecture
fails at `docker run` in front of whoever is commissioning it, so the platform playbook declares
the architecture it found. A Gitea Actions runner is still wanted, for CI on the platform
repository and the status check above; a runner executes arbitrary code and should not share a host
with the database. It does not build gateway images.

**The adapter holds no credential.** It publishes locally (HTTP or a local topic) and Node-RED
republishes on the one Sparkplug connection the appliance holds, so per-gateway confinement still
means what it says and schema conformance and quarantine still apply. A workload that needs its own
identity is a second gateway and should enrol as one. Not Portainer; not a k3s agent on gateways.

**Cloning is seeding.** A new gateway's repository is seeded from a template: an example custom
repository the platform ships, or another gateway's repository. No column records the choice; the
repository is the record.

### Revocation and rotation

**A gateway holds three things and loses all three on archive:** the broker client
(`disableClient`, which drops the live session), the deploy key links (the sweep, above), and any
unredeemed enrolment token (`withdraw_gateway_enrollment_tokens()`). Only the second is unbuilt.

**There is no HTTPS credential to revoke, and none is to be added.** After enrolment an appliance
makes no HTTPS call; the publishable key is public by construction. Every design that hands a
gateway an HTTPS credential, a registry token included, is a fourth revocation to build.

**Gateways hold no client certificate.** Identity is the dynsec password and the SSH key, and the
server is verified against a pinned root and a pinned host key. Client certificates would add a
per-gateway leaf lifecycle and a `crlfile` the broker reloads badly, for nothing dynsec does not
already give: identity, confinement, and a revocation that disconnects.

**The root rotates through the platform playbook.** The playbook ships a CA bundle holding the
old and new roots for an overlap window, delivered over SSH whose host key does not depend on the
X.509 chain. Not built with the playbook: the credential service hands the root out only inside
an enrolment, so the publisher has nothing to put in the repository; it needs a `GET` for the
root on that service, and a decision on whether the bundle rides under the version tag (a
rotation is then a release) or on a branch of its own that the playbook reads beside the tag. Rotation becomes a tagged release, not a visit to every cabinet. The heartbeat already
reports the expiry each appliance holds; reporting the `notAfter` of the root the platform is
currently issuing from, beside it, makes a rotation in progress visible. Read it from the
credential service's `ca.crt`, never from the Kubernetes API.

**No VPN for 1.0.** Every link is outbound-only, verified, and confined per gateway; the exposed
surface is three ports, and a firewall allowlisting the plant's subnets is the control. A VPN adds
a key plane per gateway (a fourth thing to issue at enrolment and revoke on archive) and a
concentrator, does not remove TLS inside it, and makes inbound access to gateways easy, which the
design exists to avoid. The case for it is gateways at remote sites over the public internet; if
that arrives, WireGuard with keys issued at enrolment is the shape.

**Worth deciding early.** Whether `unattended-upgrades` holds Docker's packages, which a
convergence run does not expect to change under it. What the heartbeat reports about a failing
custom container, which is the failure this lane is most likely to produce and least likely to
notice. Whether the HTTPS side should refuse to run unencrypted the way the physical-gateway
enrolment leg already does. Whether a rebuilt appliance (a dead SD card) re-enrols with a new
token against the same repository, which the deploy-key reconcile makes routine, and what its
`appliance` branch shows for the gap.

---

## 3 · The playback feature is reviewed end to end

**Builds on:** [`playback_worker.py`](../ingestion/playback_worker.py) · [`capture.py`](../ingestion/capture.py) ·
[`capture_worker.py`](../ingestion/capture_worker.py) · [`playback.yaml`](../deploy/helm/acs-cymru/templates/apps/playback.yaml) ·
the Capture page and [its help](../frontend/src/help/capture.md) ·
[`ingestion/README.md`](../ingestion/README.md#broker-capture-and-playback) ·
[`supabase/README.md`](../supabase/README.md#capture-and-playback-orchestration-0055-0056-0057-0058-0060)

**Built:** recording from the daemon into `broker-captures`; the job queue and `Service_Playback`;
the seeded Playback gateway with shadow devices as lanes; credential delivery rather than minting;
identity rewriting and timestamp rebasing; the Capture page; and three unit suites
(`test_capture_playback.py`, `test_capture_worker.py`, `test_playback_credentials.py`).

**Why a review rather than a fix list.** The feature was built across a dozen migrations and three
incidents (the bucket that was never created, the credential nothing had issued, two publishers on
one edge node), each fixed where it surfaced. Nothing has since walked the whole path from "Start a
recording" to a replayed frame in the historian and asked whether every step is still the design.
Two gaps are already known. The worker is off by default and nothing turns it on: not CI, not the
k3d loop, not the stack lane, so the only exercise it gets is the three unit suites. And it has no
NetworkPolicy edge and sits outside the policy's component map, so with policy on it is neither
allowed nor denied: it can reach everything.

**The review covers:** the end-to-end path on the k3d cluster with the worker on, including
in-cluster broker TLS; the confinement claims (the target's own account, no wildcard write, shadow
devices as lanes) re-checked against the Dynamic Security roles rather than the ACL file they were
written against; quarantine's approval step inside a first playback; what the Capture page shows
when a job fails past CONNECT, since QoS 0 leaves a publisher nothing to observe; the RLS and role
boundaries of `Service_Playback` and the capture bucket; and the worker's own comments and README
sections, which predate the comment rule in `CONTRIBUTING.md`. A finding that is one change is
fixed here; the rest become issues.

**Must not touch:** the worker never mints a credential (delivery is the platform's; minting stays
human and audited); a capture cannot be played back as itself; the Playback gateway stays visible;
a stand-down NCMD stays rejected.

**Done means:** a finding per step of the path, each confirmed, fixed or filed; the worker runs in
the k3d loop and one conformance check replays a fixture through it; playback has a policy edge and
a component entry; and the feature's README sections describe what is built.

---

## 4 · The documentation, code and comments are audited against the codebase

**Builds on:** [`CONTRIBUTING.md`](../CONTRIBUTING.md) (the comment rule, and where argument and
history go) · `scripts/check-docs-drift.mjs` · `scripts/check-mirror-drift.mjs` ·
[`docs/incidents.md`](incidents.md)

**Built:** the comment rule, and the rewrite that applied it to the chart values, the gateway, the
active migrations, the frontend, the edge functions and the check scripts; the drift checker, which
pins the README's component table, every workflow job, every help page and the other claims it
lists; and the retired-entries table above, where an entry's substance lands when it ships.

**The gap** is three kinds of staleness the checker cannot see. Prose that describes a design since
replaced: Compose is gone, and "Compose", "both targets" and "the divergence table" survive across
the tree outside the incident log. Comments that argue history where the rule wants the constraint:
the Python suites, the rest of `ingestion.py`, the i3X server, the capture, playback and cold-archive
modules, the broker and setup scripts, and the Helm templates, whose comment blocks ship in
every release's Secret and have brought it within two percent of Helm's 1 MiB ceiling (a CI step
estimates it; revision 19 on the dev cluster was refused on 2026-09-13). Rules and tests guarding
what nothing renders, which the Site Map work found in the stylesheet. And claims the checker
could verify but does not, which is how the other kinds return.

**Decided.** One sweep per surface, not one pass over everything, and a surface is done when its
non-comment lines are unchanged (AST minus docstrings for Python, data equality for YAML, stripped
text for the rest) and its prose names nothing that is not in the tree. Argument and history move
to the component README or `docs/incidents.md`; they are not deleted. Nothing cites a roadmap
number. Every claim found that the checker could verify gets a check, so the audit leaves a guard
rather than a snapshot. The files under `deploy/helm/acs-cymru/files/` are mirrors: the source is
edited and the sync script run.

**Must not touch:** `supabase/migrations/archive/` (a historical record, not executed) and
`supabase/config.toml` (the Supabase CLI's stock file).

**Done means:** nothing outside `docs/incidents.md` and the README's history names Compose or a
second target; every surface above has had its sweep with the non-comment comparison clean; the
drift checker holds more claims than it does today; and `CONTRIBUTING.md` records the sweep's
method so the next one starts from it.

---

## 5 · The migration chain folds back into the baseline

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

**Done means:** a fresh boot and a second boot pass every self-check; every database suite passes
on the throwaway cluster; the drift check is clean; and the chain is the baseline plus a tail
short enough to read in one sitting.

**Must not touch:** the replay contract. Every file still runs on every boot with no ledger, so
nothing in the fold may depend on a file having run once.
