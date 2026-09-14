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
2 audits the documentation, code and comments once the code has stopped moving. 3 is last by
rule: it folds the migration chain, so every entry that changes the schema must have landed
before it.

**Retired entries, and where their substance went.**

| Entry | Where it is now |
| :--- | :--- |
| Revocable service tokens (`0074`–`0076`) | [`supabase/README.md`](../supabase/README.md#the-access-control-page-states-what-is-outstanding) |
| Studio behind a login (`0081`, `0082`) | [`supabase/README.md`](../supabase/README.md#the-second-listener-which-is-studios-login-0081) |
| The approvals queue (`0086`–`0091`) | [`supabase/README.md`](../supabase/README.md#the-approvals-queue-and-the-first-write-an-operator-has-ever-had-0086) |
| The forge's door and membership (`0094`) | [`supabase/README.md`](../supabase/README.md#the-forges-door-and-the-room-behind-it-0094) |
| The appliance puller, deploy keys and host-key distribution | [`docs/physical-gateways.md`](physical-gateways.md) |
| GitOps edge sync (`0094`, `0095`, `0099`, `0104`) | [`supabase/README.md`](../supabase/README.md#the-appliance-reports-on-a-branch-of-its-own-0104) for the appliance branch, the writable key and the three rules that confine it, and the sweep's key reconcile; [`docs/physical-gateways.md`](physical-gateways.md#what-the-appliance-reports-back) for the operator's view. The one bullet not built, a required status check refusing `flows_cred.json` by shape, is built and needed no runner: [`supabase/README.md`](../supabase/README.md#the-forge-checks-a-flow-before-it-is-merged). Two small things stay unbuilt and are recorded in the README section: a failed webhook delivery is visible only on the hook's page in the forge, and a repository from before `0095` gets no incident template from the sweep |
| Contextual help | [`frontend/README.md`](../frontend/README.md#contextual-help) |
| The Directory's MQTT half | [`ingestion/README.md`](../ingestion/README.md#the-directory-on-mqtt) |
| The log store, structured logging and the drop drill-down | [`ingestion/README.md`](../ingestion/README.md#log-fields), `loki/loki.yaml`, `deploy/helm/acs-cymru/templates/obs/alloy.yaml` |
| The appliance clock offset measurement | [`ingestion/README.md`](../ingestion/README.md) (the `acs_ingestion_gateway_clock_offset_seconds` gauge and its rule); the time source is chrony on the appliance, pointed at what `platform.yml` names ([`forge/gateway-platform/README.md`](../forge/gateway-platform/README.md)), with the four questions the measurement was taken for answered in [`docs/physical-gateways.md` §8](physical-gateways.md#four-questions-about-the-clock-answered) |
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
| The appliance itself, and the code somebody wants to run on it | Built across five pull requests, and its four subjects went four ways. **The one-liner and the CA:** [`supabase/README.md`](../supabase/README.md#the-one-liner-0105) and [`docs/physical-gateways.md`](physical-gateways.md#on-the-appliance-the-command), which now also carries the cloud-init seed for a plant that images its own appliances. **The operating system and the gateway's own playbook:** [`forge/gateway-platform/README.md`](../forge/gateway-platform/README.md), with the time source answered in four parts there and in [§8](physical-gateways.md#the-clock-is-part-of-certificate-verification); CI runs the playbook twice in a container and the converge script has a suite of its own. **The forge as the appliance sees it, and the required status check:** [`supabase/README.md`](../supabase/README.md#the-forge-checks-a-flow-before-it-is-merged) — built without the Actions runner the entry assumed it needed, because branch protection takes a commit status the platform posts on a webhook it was already receiving. **Custom code:** [`forge/gateway-custom-example/README.md`](../forge/gateway-custom-example/README.md) and [`supabase/README.md`](../supabase/README.md#a-gateway-that-needs-code-of-its-own-0106) for the template repository, the vars a gateway's playbook is handed, and the two drawer rows. **Revocation and rotation:** [`docs/physical-gateways.md` §8](physical-gateways.md#8-certificates-and-the-two-clocks-they-run-on) — the root now rides on `main` of the platform repository rather than under a tag, the appliance refuses a bundle that would cut it off, and the page says which gateways are still holding an older root. The rebuilt-appliance answer is in [§6](physical-gateways.md#a-rebuilt-appliance-is-a-re-issue-and-keeps-its-repository). Three could-haves left as feature requests: a Gitea Actions runner for CI on the platform repository ([#211](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/211)), a time source on the platform for a plant with no route to NTP ([#212](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/212)), and minting the `#cloud-config` seed beside the command ([#213](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/213)) |
| The playback feature is reviewed end to end | Reviewed against a live stack rather than read. The worker now runs in the k3d loop (`playback.enabled`, `values-dev.yaml`), so the feature is exercised by something other than three unit suites, and [`ingestion/test_playback_replay.py`](../ingestion/test_playback_replay.py) mints the credential, waits out the kubelet's Secret refresh, replays a fixture and asserts the rows arrived **under the replay lane and under no other asset** — the observation QoS 0 will not give, since a publish the broker refuses is dropped with no PUBACK. Playback also gained its NetworkPolicy edges and an entry in the policy's component map, so it is confined rather than merely unmentioned. **Three defects fixed.** A blank delivery file was read as malformed, logging an `ERROR` every three seconds *forever* on any stack with no playback target — the chart creates that Secret key empty, so on Kubernetes "absent" is always blank, which is the one form the code did not handle. A playback the operator stopped was recorded `COMPLETED`, indistinguishable from one published in full (`0107`; [`supabase/README.md`](../supabase/README.md#capture-and-playback-orchestration-0055-0056-0057-0058-0060)). And the confinement claims still described the pre-Dynamic-Security ACL file, where `%u` was substituted and one pattern confined every gateway. **The measured facts** are in [`ingestion/README.md`](../ingestion/README.md#broker-capture-and-playback): a delivered credential takes about a kubelet sync period to reach the worker, a `DBIRTH` announces a device and writes no telemetry of its own, the per-gateway role confines *delivery* rather than subscription, and the page path meets no quarantine because the lanes are minted registered. Two findings left as issues: a capture whose timestamps fall outside the daemon's sanity window replays "successfully" and writes nothing ([#216](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/216)), and nothing can tell an operator when a *re-issued* credential has reached the worker, because the status row carries ids and a rotation does not change them ([#217](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/217)) |
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

## 2 · The documentation, code and comments are audited against the codebase

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
what nothing renders, which the Site Map work found in the stylesheet. Comments that are
internally coherent and false, which the playback review found in the worker: a docstring
reasoning at length about a credential file the chart never leaves absent, while the state it
does leave — present and empty — went unhandled and logged an error every three seconds forever.
And claims the checker could verify but does not, which is how the other kinds return.

**Decided.** One sweep per surface, not one pass over everything, and a surface is done when its
non-comment lines are unchanged (AST minus docstrings for Python, data equality for YAML, stripped
text for the rest) and its prose names nothing that is not in the tree. **That comparison proves a
sweep changed no behaviour and says nothing about whether the surviving comment is true**, so a
comment asserting a runtime state is read against whatever produces that state — the chart, the
migration, the deployment target — rather than left shorter and still wrong. Argument and history
move to the component README or `docs/incidents.md`; they are not deleted. Nothing cites a roadmap
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

## 3 · The migration chain folds back into the baseline

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
