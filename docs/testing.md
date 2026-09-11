# Testing

```bash
# Frontend — 1,600+ tests
cd frontend && npm test

# ---------------------------------------------------------------------------------------------
# EVERY Python suite, by LANE. This is what CI runs and what you should reach for.
# ---------------------------------------------------------------------------------------------
# The suites are DISCOVERED from the tree, not listed. scripts/python-suites.mjs says which lane
# each one is in and why, and the runner refuses to start if a test_*.py in the tree has no lane --
# which is what stopped twenty of them running in no job anywhere (issue 147). Each suite is still
# spawned as its own `python <file>`, exactly as the individual commands below do.
npm run test:py          # lane: unit  — needs nothing at all
npm run test:py:db       # lane: db    — needs a migrated Postgres (see `npm run test:db` below,
                         #               which starts a throwaway one and runs this same lane)
npm run test:py:stack    # lane: stack — needs the composed stack up

# The individual commands below still work and are the reference for WHAT each suite covers. They
# are not the list CI runs from; there is no such list any more.

# Python unit suites — no stack required
python ingestion/test_gateway_binding.py
python ingestion/test_gateway_health_metrics.py
# The appliance clock offset, measured from the heartbeat's own timestamp against receipt time,
# and the edge_node label on the rejection counter. Guards the one gateway fault that passes every
# other check: minutes of skew verify every certificate and corrupt every reading.
python ingestion/test_gateway_clock_offset.py
python ingestion/test_archived_gateway.py
python ingestion/test_declared_metrics.py
python ingestion/test_modelled_metrics_contract.py
python ingestion/test_device_location.py
python ingestion/test_health_heartbeat.py
python ingestion/test_rbe_telemetry.py
python ingestion/test_mqtt_tls.py
# The Directory's MQTT half. Mostly assertions about what it does NOT do: the publisher is
# fed from the enrolment record, so one test reads directory_publish.py's own source and
# fails if NBIRTH, DBIRTH or an on_message handler ever appears in it. That is the design
# issue #64 proposed and this refused -- a registry accumulated from what devices claim.
python ingestion/test_directory_publish.py
# The Unified Namespace bridge: the topic is fixed at the level a device honestly occupies, and
# an incomplete path is skipped and counted rather than filled with a placeholder.
python ingestion/test_uns_publish.py
python ingestion/test_dockerfile_copies.py
python ingestion/test_audit_write_dedup.py
python ingestion/test_payload_conformance.py
# The Prometheus endpoint and the Sparkplug seq gap counters -- no stack, no broker
python ingestion/test_metrics_endpoint.py
# The JSON log formatter, and the drop pair. Every drop is a counter AND a warning, and the two
# halves must name the reason with the SAME STRING or a dashboard panel is not a drill-down into
# the logs. Both halves stay internally consistent while meaning different things, so nothing else
# in the stack notices them diverge -- which is why it is asserted here, against ingestion.py's
# own source rather than against a list restated in the test.
python ingestion/test_structured_logging.py
# The log pipeline END TO END, and the only check that a drop is countable and readable at the
# same time. Needs the stack up. It publishes a DDATA for a randomly generated unregistered device
# and then asserts BOTH halves of the instrument: that the Prometheus counter for
# reason="quarantined_or_unregistered" increased, and that a line carrying that same reason AND
# that device id arrived in the log store. Prometheus cannot name the device -- its endpoint is
# unauthenticated and carries no device data by design -- so this is the assertion that the half
# the log store exists to keep is actually being kept.
python test-harness/test_log_pipeline.py
python ingestion/test_entity_cache.py
python ingestion/test_telemetry_batching.py
# The historian writer -- several messages become one transaction; one bad message still loses one
python ingestion/test_telemetry_writer.py
# The directory refresher -- one request per table per pass, keyed as the per-entity path keys
python ingestion/test_directory_refresh.py
# Broker capture and playback -- identity rewriting, timestamp rebasing, wire encodings
python ingestion/test_capture_playback.py
# The daemon-side recording engine -- subject matching, the caps, and the manifest
python ingestion/test_capture_worker.py
# The startup recovery loop. `depends_on` orders `docker compose up` and nothing else, so when the
# Docker daemon brings `restart: always` containers back it can start ingestion before the
# historian -- measured at 453ms on a development stack. The daemon then reached its MQTT loop
# having done none of the startup work that needed a database, and retried none of it: the
# historian gauge read 0 for ever on a quiet stack, and capture reconciliation never ran, which
# leaves every future capture refused with nothing to point at. Both are asserted here, along with
# the race the loop opens by connecting with its lock released.
python ingestion/test_startup_healer.py
# How the playback worker resolves the broker passwords it holds (0078), and the precedence rule
# that matters: a DELIVERED credential beats one in the environment. The broker keeps one password
# per username, so a value in `.env` is not an alternative to the delivered one -- it is an older
# one. If the environment won, "issue a new credential" would be the one repair that could not fix
# a refused playback.
python ingestion/test_playback_credentials.py
# Cold telemetry archival -- the object LAYOUT and the Parquet round trip. Needs pytest and pyarrow.
#
# Deliberately narrow: the export path needs a historian, object storage and a chunk to mean
# anything, and the safety properties are asserted in SQL where they live -- cold_archive.sql's own
# self-check runs on every boot and proves that dropped requires verified, verified requires
# exported, and that a correctly ordered row is still accepted.
#
# What is left for a unit test is the part that is a DECISION rather than a mechanism: the
# `year=YYYY/month=MM/` key is baked into every object the moment one is written, and changing it
# later means rewriting the archive or teaching every reader two schemes.
python -m pytest ingestion/test_cold_archive.py
python i3x/test_i3x_service.py
python supabase/functions/approve-quarantine/test_approve_quarantine.py
python supabase/functions/nodered-userinfo/test_nodered_userinfo.py
python supabase/functions/aas-export/test_aas_export.py
python supabase/functions/aas-api/test_aas_api.py
python supabase/functions/grafana-alert-webhook/test_grafana_alert_webhook.py
# The Factory+ Directory adapter. Six checks run with nothing up -- that its registry entry still
# grants no service-role key, and that the bearer check still precedes routing, which is the whole
# boundary in front of routes the gateway deliberately exempts from key-auth. The rest need the
# stack and centre on the reverse schema lookup: /v1/device and /v1/schema/{uuid} answer the same
# question from opposite ends and nothing else compares them, so a disagreement is a 200 at both.
python supabase/functions/fplus-directory/test_fplus_directory.py

# Physical gateway enrolment — signs in as Administrator to mint tokens (issuing is a USER's act,
# gated on has_role, so the service key cannot do it), then redeems them the way an appliance does:
# the anon key and no user JWT. Stops the credential service to exercise the 503 rollback path.
SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  python supabase/functions/enroll-gateway/test_enroll_gateway.py

# The forge's door, end to end -- the same OAuth flow a browser runs, for each seeded persona --
# and the room behind it: which team the forge put them in, that an Operator completes the flow and
# meets the 403, that a forged identity header from outside is not a login, and that a role removed
# mid-session is refused and unseated on the next request, that a session ended elsewhere is
# sent back through the door, and that Gitea's own sign-out link signs the person out of the
# platform. Needs the forge and one enrolled gateway (which creates the organisation), and skips
# without them.
SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  python supabase/functions/forge-membership/test_forge_membership.py

# The forge's push webhook (0095): signature refusals, what a push to main records on the gateway
# row, what is ignored, and one delivery sent by the forge itself for a freshly enrolled gateway.
# GITEA_WEBHOOK_SECRET is the value in .env (the one the edge runtime holds). Skips without it.
SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... GITEA_WEBHOOK_SECRET=... \
  python supabase/functions/forge-events/test_forge_events.py

# The downloadable bundle — role gating (Operator and Auditor get 403 and no token is minted), ZIP
# integrity, and that the embedded token is the one the database will accept.
SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  python supabase/functions/gateway-bundle/test_gateway_bundle.py

# Broker credential issuance — needs the stack up and the service's own bearer token, which the
# e2e job writes into .env before launch (`setup.mjs --demo` copies .env.example verbatim and
# leaves it empty, which used to make all thirteen checks skip while the run still exited 0).
#
# The exposure tests are the ones that matter and are invisible anywhere else: this service can
# mint a Mosquitto account for ANY edge node, and mosquitto.acl turns an account into the ability
# to publish telemetry as that gateway. "Not published on the host" is a security boundary.
MQTT_CREDENTIAL_SERVICE_TOKEN=... python gateway-credential/test_gateway_credential.py

# Two pieces of the broker-credential machinery whose failure is silent, in isolation and with no
# stack: the merge that must never lose an account, and the filter deciding which accounts the
# orphan sweep may rotate — which is what keeps it from revoking `factoryplus_ingestion` and
# stopping the stack ingesting.
npm run test:lib

# Configuration drift — no services needed, and the ONE check here that reads your own .env.
# Compares docker-compose.yml against .env.example (enforced in CI) and, when a .env exists,
# your working file against the template in BOTH directions: keys the template gained and you
# never copied, keys retired from the template still sitting in your file, and keys Compose
# reads that the template forgot. All three fail silently otherwise -- Compose substitutes its
# own default and the stack comes up looking correct on a value nobody chose.
node scripts/check-env-drift.mjs

# THE MIGRATION MODEL'S CENTRAL INVARIANT — needs the stack up, and replays db-init a second
# time against it. There is no migrations ledger, so "a second run must match no rows" is what
# the whole schema rests on, and it used to be upheld by review alone. Asserts only what a
# migration can move (the schema digest, and digital_thread's `migration` lane) and treats a FALL
# in operator row counts as failure while ignoring a rise, so a live daemon cannot make it flaky.
# DID THE CHAIN FINISH? There is no migrations ledger, and an aborted db-init leaves the stack
# running on a partially-migrated database -- with the telemetry read surface DROPPED rather than
# stale, because 0001 removes it with CASCADE before later files recreate it. Checks the objects
# that abort would leave missing, and names the migration that should have made them.
# Do both deployment targets deploy the same thing? Needs neither a stack nor helm -- it reads
# docker-compose.yml and the chart templates as text. The file-sync guard above asserts the copies
# the chart CARRIES are current; this one asserts the chart carries them at all. Six defects in one
# branch had that shape, three of them found only by installing the chart and watching a pod crash.
# Known gaps are printed on every run rather than exempted silently.
node scripts/check-compose-chart-parity.mjs

node scripts/check-schema-surface.mjs

node scripts/check-migration-idempotency.mjs

# Database suites — ALL SIXTEEN, against a throwaway Postgres. Needs Docker and nothing else.
#
# RUN THEM THIS WAY. Every suite below defaults to port 54322, and that is where
# docker-compose.yml publishes the LIVE database -- so the bare `python ...` form points at
# production data and always has. See the note under this block for what that costs.
#
# Brings up a disposable supabase/postgres, applies the same auth fixture CI uses, replays
# every migration, runs every suite, and destroys the container. `--keep` leaves it up;
# `-k <substring>` runs a subset; `--no-run` migrates and stops.
npm run test:db

# The individual suites, for when one is being worked on. Point them at the throwaway with
# `npm run test:db -- --keep --no-run` and SUPABASE_DB_PORT=54329 rather than running them bare.
python supabase/migrations/test_user_roles_rls.py
# The approvals queue (0086). The one that matters asserts what this item must NOT have done: an
# Operator gained a write to the QUEUE and still cannot update a device, insert one, or write a
# nameplate. The rest cover the two properties a simplification would remove first -- that an
# invalid patch aborts its own approval rather than becoming a record of something that did not
# happen, and that both caps are in the database rather than in a disabled button.
python supabase/migrations/test_change_proposals.py
# The Administrator / Shopfloor_Manager split (0069), in both halves: the grants diverged, AND the
# withdrawal reaches Postgres. The second half is the one worth having -- no RLS policy reads
# `role_permissions`, so a revoked grant on its own only hides a button. Note the asymmetry it
# documents: a blocked INSERT raises 42501, a blocked UPDATE or DELETE reports success over zero
# rows, so those pair the refusal with an Administrator reaching the same row.
python supabase/migrations/test_role_permission_split.py
# The digital thread's two lanes (0070): the classifier, the stamp a caller cannot override, and
# the reads. Every test rolls back -- the rows they provoke are audit rows and 0003 makes the table
# append-only, so a committed fixture is permanent.
python supabase/migrations/test_audit_domain.py
python supabase/migrations/test_schema_versioning.py
python supabase/migrations/test_digital_thread_guard.py
# The keyset cursor (0077). THE CONTROL TEST IS THE ONE THAT MATTERS: it runs the naive
# recorded_at-only cursor against the same fixture and asserts it LOSES rows. Without that,
# every other test in the file would pass just as well against a broken cursor on a fixture
# whose timestamps happen to be distinct -- and they are not, because one transaction's rows
# all carry one now() and a batch relocation is deliberately one transaction (0033).
python supabase/migrations/test_digital_thread_paging.py
# The delivery gate on broker-credential issuance (0078). NOT the happy path: the test that earns
# its place is that a REAL gateway is not a delivery target, because a true there writes a real
# machine's broker password into a file the replay worker reads -- and mosquitto.acl would then let
# it publish as that machine. Also pins is_simulated NOT NULL, which is what makes 0078's coalesce
# dead code rather than the thing deciding deliveries.
python supabase/migrations/test_playback_credential_delivery.py
# The monthly partitioning of digital_thread (0079). THE INTERESTING TESTS ARE THE BORING ONES:
# converting a populated table to partitioned means rebuilding by hand every object PostgreSQL
# does not carry across -- the primary key, the FK, three indexes, two triggers, RLS and its two
# policies, and the ACL -- and a missing ENABLE ROW LEVEL SECURITY would publish the security
# audit lane to every logged-in user with nothing else in the stack saying so. It also pins the
# one hole partitioning opens: a partition does not inherit the parent's ACL, gets the image's
# default grants instead, and TRUNCATE raises no row trigger.
python supabase/migrations/test_digital_thread_partitioning.py
python supabase/migrations/test_ingestion_rejection_rpc.py
python supabase/migrations/test_platform_alerts_retention.py
python supabase/migrations/test_system_settings_rls.py
python supabase/migrations/test_relocate_devices.py
# Floors and places (0098). An area is born with a ground floor; a floor holding cells cannot be
# deleted except through its area, and the guard tells the two apart by asking whether the area
# row still exists; and the spacing between two cells on one plan is refused by the database, not
# only by the picker, because an approved proposal writes the same columns.
python supabase/migrations/test_area_floors.py
# A device cannot be posted onto the replay lane by hand (0083, issue 144). The dashboard used to
# offer the Playback gateway in three device pickers; choosing it produced a shadow device with no
# `shadow_of` -- "an asset with no provenance, which is the thing this design exists to avoid
# creating", in the words of the migration that refuses to mint one. THE TEST THAT EARNS ITS PLACE
# IS NOT THE REFUSAL, it is that deleting a replayed machine still works: shadow_of is ON DELETE SET
# NULL, so the delete UPDATEs the lane into exactly the shape the gate rejects on arrival, and a
# gate written against the STATE rather than the ACT would break every such deletion with an error
# about playback.
python supabase/migrations/test_shadow_lane_is_not_assignable.py
python supabase/migrations/test_metric_catalog_seed.py
python supabase/migrations/test_gateway_enrollment.py
# The machine-path credential recorder (0062), and the grant that decides whether it is a fix.
# Every test rolls back: the rows it writes are audit rows, and that table cannot be pruned.
python supabase/migrations/test_credential_recorder.py
# Revocation reaching a host-run gateway (0063), and still passing over one that holds nothing.
# Rolls back for a second reason: net.http_post queues inside the transaction, so the rotation
# requests these tests provoke are un-queued rather than sent.
python supabase/migrations/test_credential_revocation.py
# Service-token revocation (0074): the denylist, and the PostgREST db-pre-request hook that reads
# it. THE FAIL-OPEN TESTS ARE THE POINT and come first in the file -- auth_pre_request() runs
# before every request in the caller's role, so a false refusal is not a failing feature, it is the
# whole API down. No claims, unparseable claims and a token with no jti must all be served.
python supabase/migrations/test_service_token_revocation.py
# Principal revocation (0076): the subject arm of the same hook. THE FIRST ASSERTIONS ARE THAT THE
# FLAG DOES SOMETHING -- 0043 rejected deleting the auth.users row because the subject is never
# looked up, and a flag nothing reads fails identically. Also covers the arm-ordering trap: the
# subject arm is checked first so its message wins, and its uuid cast must fall THROUGH to the
# token arm rather than return, or a junk `sub` would bypass the token denylist.
python supabase/migrations/test_service_principal_revocation.py
# The anon EXECUTE baseline across the WHOLE schema, not a list somebody remembered to extend.
# PostgreSQL grants EXECUTE on a new function to PUBLIC, and anon is a member of PUBLIC, so a
# migration with a GRANT and no REVOKE has narrowed nothing. A FRESH-BOOT-ONLY FAULT: 0001's sweep
# runs before the migrations that create these functions, so the leak is present on boot one and
# healed on boot two -- which means it is on new installations and on no development stack that has
# ever been restarted. These suites run against a throwaway database, which is a first boot every
# time, and that is exactly why the assertion belongs here as well as in validate.py's check 13a.
python supabase/migrations/test_anon_privilege_baseline.py
# The `deployment` constraints, and the view that has to be rebuilt when a gateways column moves
# (0064, 0066). Its transitional half went when is_virtual did -- see the suite's own header.
python supabase/migrations/test_gateway_deployment.py
# Needs the TimescaleDB historian (port 5433), not Supabase — the rollups live there
python timescaledb/test_bi_reader_grants.py
# The installed extension against the version the image ships, plus the two deployment paths that
# are supposed to close that gap. The second half needs no stack.
python timescaledb/test_extension_version.py
# The worker pool against the workers the server may launch, and both deployment files against
# each other. Also needs no stack for its second half.
python timescaledb/test_worker_pool.py
# The daemon's and the FDW's own roles (item 18). Each skips itself when its password is unset,
# because roles.sql skips creating the role on the same condition.
python timescaledb/test_historian_role_grants.py

# End-to-end — needs the running stack
#
# WAIT FOR THE DAEMON FIRST. `docker compose up --wait` returns on health and the ingestion daemon
# carries no healthcheck deliberately, so "up" and "subscribed" are different states. Publishing
# into that gap makes the suite report a block of conformance failures for a cause none of them
# names -- ten of them, in the run that produced issue #47. This blocks until the daemon has
# actually consumed something, and fails naming the wait if it never does.
WAIT_MODE=compose sh scripts/wait-for-ingestion-consuming.sh

set -a && . ./.env && set +a && unset MQTT_HOST DB_HOST DB_PORT
export MQTT_USER="$MQTT_VALIDATOR_USER" MQTT_PASSWORD="$MQTT_VALIDATOR_PASSWORD"
python ingestion/validate.py
```

## Why the database suites get their own Postgres

**The default was production.** Every suite under `supabase/migrations/` resolves its port as
`os.getenv("SUPABASE_DB_PORT", "54322")`, and `docker-compose.yml` publishes the live Supabase
database on `${SUPABASE_DB_PORT:-54322}`. So the documented invocation — `python
supabase/migrations/test_audit_domain.py`, nothing set — connected to the running stack.

Most of the suites roll back, which helps less than it sounds. `digital_thread` is append-only by
`0003`, so the rows a rolled-back test provokes are exactly the ones a *committed* fixture leaves
behind for good. Measured on a development stack:

| | rows |
| :--- | ---: |
| `digital_thread` total | 525 |
| stamped `actor_source = 'migration'` | 346 (66%) |
| …of those, written by an actual migration | **0** |

`Test_Host_Run_Gateway` and `Test_Remote_Gateway` account for 208 of them, 52 INSERT/DELETE pairs
each, all from `test_gateway_enrollment.py`. That suite commits deliberately — it pins its fixture
ids so a failed run is *reclaimed* rather than accumulated — and deletes the rows on the way out.
The `gateways` table ends clean. The audit of their brief existence is permanent, at roughly 44 rows
per run, for the life of the deployment.

**The `migration` label is why nobody noticed.** `0070`'s classifier stamps that lane whenever a
session carries no JWT, and a `psycopg2` connection as `postgres` carries none — so test churn is
filed under the one `actor_source` an operator reads as *the schema did this, ignore it*.

**A second database on the live cluster does not work**, which is the obvious fix and worth
recording as tried: `0001` creates `pg_cron`, which refuses outside the single database named by the
cluster's `cron.database_name`, and `IF NOT EXISTS` does not save it because the refusal is raised
from inside pg_cron's own install script. The chain aborts on its first file. A throwaway *cluster*
has its own `postgres` database and its own GUC pointing at it, so the same line succeeds untouched.

**This is a paved road, not a fence.** `SUPABASE_DB_PORT` still defaults to `54322`, because `.env`
sets it, `validate.py` derives from it and both backup scripts read it — changing the default would
be overridden by the environment in the common case and would fight four other consumers in the
rest. `npm run test:db` makes the clean path a one-liner; running a suite bare still reaches the
live stack.

### The fixture is shared with CI, in one file

[`test-harness/auth-bootstrap.sql`](../test-harness/auth-bootstrap.sql) stands in for GoTrue —
`auth.uid()`, `auth.jwt()` and `auth.identities`, without which four migrations fail to apply and
the RLS suites silently pass on policies that deny everything. Both
[`ci.yml`](../.github/workflows/ci.yml)'s **edge-function-auth-test** job and `scripts/test-db.mjs`
apply it. It used to live inline in the workflow, which is why no local runner existed.

**The runner passes the psql variables `db-init` passes**, and one of them decides whether a suite
can pass at all. `0002` falls back to empty and warns rather than failing:

```
0038: GATEWAY_REVOKE_SECRET or SUPABASE_ANON_KEY is unset; credential revocation is INERT
      on this stack. Archiving will not revoke, and the sweep will do nothing.
```

A `NOTICE`, so the chain applies and every schema check passes — and
`test_credential_revocation.py` then fails four assertions with `0 != 1`, naming a queue depth
rather than an unset secret three thousand lines upstream. The values the runner supplies are fake
and its functions URL is deliberately unreachable.

**Seven suites run in no CI job.** `edge-function-auth-test` names eight by hand and
`test_gateway_enrollment.py` runs in **e2e-validation**; the directory holds sixteen. The runner
*discovers* them rather than listing them, which is the difference that would have caught it.

**The frontend figure is a lower bound rather than a count**, and deliberately: it moved four times
in one afternoon and each move made both documents wrong until somebody noticed. A bound only ever
becomes conservative, which is the failure worth having — `npm test` prints the exact number, and it
is the only place that can be right on every branch at once.

Three suites have a second half elsewhere, and both halves must move together:
`test_modelled_metrics_contract.py` and `test_rbe_telemetry.py` each pair with a JavaScript suite in
the frontend run, and `test_i3x_service.py` covers the sync-acknowledgement and queue-overflow MUSTs
the CESMII conformance suite skips. See [`ingestion/README.md`](../ingestion/README.md#testing) and
[`i3x/README.md`](../i3x/README.md).

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs six jobs:

| Job | Covers |
| :--- | :--- |
| **changes** | Classifies the diff, so a documentation-only change skips the two end-to-end stacks |
| **frontend-build** | Vitest, the mirrored-logic drift guards, production bundle |
| **helm-chart** | `helm lint`, render, API-schema validation, chart guard rails |
| **edge-function-auth-test** | Auth ladders and RLS against a real Postgres |
| **e2e-validation** | Full Docker Compose stack, `validate.py`, live AAS export |
| **k8s-validation** | k3d cluster, `helm test`, the same suites in-cluster, ingress assertions |

**The last two are the real drift control between deployment targets**, and they are the two
`changes` gates: eighteen of the workflow's twenty-two minutes are spent here, and a change that
touches only documentation cannot alter what either asserts. The gate fails open, so a diff range
it cannot compute runs them anyway. `validate.py` is
topology-agnostic and runs against both; if both pass, the wiring agrees where it matters.

## Keeping the pinned versions current

Three scheduled workflows, and they answer different questions. None runs on a pull request:
version drift, published advisories and the slow rot of a restore path all move on the world's
schedule, not on this repository's.

| Workflow | Job | Asks |
| :--- | :--- | :--- |
| [`renovate.yml`](../.github/workflows/renovate.yml) | **renovate** | *Is there a newer version?* — routine PRs monthly, security PRs immediately |
| [`image-scan.yml`](../.github/workflows/image-scan.yml) | **scan** | *Does what we run have a known, **fixed** vulnerability?* — monthly |
| [`restore-rehearsal.yml`](../.github/workflows/restore-rehearsal.yml) | **rehearse** | *Would a restore actually work today?* — weekly |

### The restore rehearsal is the odd one out

The other two ask about versions. This one asks whether a capability the repository CLAIMS still
exists, and it is scheduled for the same reason: the restore path depends on the shape of two
databases, the Supabase role set, the pgsodium root key and the migration chain, and every one of
those changes. A restore that worked in August fails in November, and nothing else would notice
until it was needed.

It runs a full cycle against a disposable k3d cluster — seed → back up → **destroy the namespace
and its volumes** → reinstall → restore → assert — driven by `scripts/rehearse-restore.sh`, which
an operator can also run by hand against any cluster. Destroying the volumes is what makes it
meaningful; a restore over surviving data proves nothing, so the workflow fails if a
`PersistentVolume` outlives the namespace or if the reinstalled stack is not empty before the
restore.

**The assertions that earn their place are not the row counts.** Counts catch data that did not come
back. What they cannot catch is data that came back without the machinery that gives it meaning — a
missing append-only trigger, RLS switched off, a partition set that did not survive, a Vault secret
that is present and undecryptable, a rollup that exists and returns nothing. The full table is in
[`deploy/k8s/README.md`](../deploy/k8s/README.md#rehearsing-the-restore-weekly-and-by-hand).

A scheduled failure opens an issue labelled `restore-rehearsal`, or comments on the existing one.

**The dependency dashboard is the deliverable**, more than the pull requests are: one issue listing
every available update, including the ones deliberately held back.

**Routine updates open on the first of the month**, because a weekly batch of pull requests is a
standing tax on whoever reads them and the drift being defended against moves over months. **The
`renovate.yml` cron is daily anyway, and that is not a contradiction**: Renovate can only act while
it is running, so a monthly cron would silently make the security carve-out monthly too. Daily
invocation against a monthly window is what keeps `vulnerabilityAlerts` meaning what it says —
routine noise once a month, an advisory picked up within a day.

The CVE scan is monthly with no such carve-out, which is a weaker guarantee and deliberately so: a
CVE published inside a third-party image on the 2nd is not noticed until the 1st. `workflow_dispatch`
is the answer when something specific needs checking sooner.

**[`renovate.json`](../renovate.json) exists mostly to stop good automation doing the wrong thing
here.** The Supabase components are a coordinated set that upstream tests together — measured
against Docker Hub, `gotrue` and `postgres-meta` look outdated when they are in fact the exact
versions upstream pins, so an "upgrade" would move this stack *off* the tested combination. They
are grouped into one pull request held for approval, as are all major bumps. Kong 3.0 is why:
it silently switched off every per-service Prometheus metric while leaving the scrape target green.

**Renovate is self-hosted because this repository is private**, and needs a `RENOVATE_TOKEN` secret
(a PAT with `repo`, or fine-grained with Contents, Pull requests and Issues read/write). Without it
the workflow fails on its first step by design — a scheduled job that silently does nothing leaves
the repository looking as though drift is watched when it is not. `GITHUB_TOKEN` cannot be used:
pull requests it opens trigger no workflow runs, so every bump would arrive with no CI result.

**The scan reports only *fixable* HIGH and CRITICAL findings.** An unfixed CVE in a base image is
not something this repository can act on, and failing on it would train everyone to ignore the job.
Its image list is parsed out of `docker-compose.yml` rather than written in the workflow, and it
refuses to run if it finds fewer than ten — "found nothing to scan" must not look like "found
nothing wrong".

## Releases

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on a **`v*` tag only** —
never on a branch:

| Job | Covers |
| :--- | :--- |
| **prepare-release** | Derives the version from the tag, refuses a non-SemVer one, re-runs the static checks a published artefact must not violate |
| **build-images** | The three independent images, in parallel, pushed to GHCR |
| **build-ingestion-chain** | `ingestion`, then `test-runner` **on the same runner** — the latter is built `FROM` the former, so the base must be in the local image store |
| **publish-chart** | Lint, render, package at the tag's version, push over OCI, pull it back |

The tag is the single place the version is written — it stamps the five image tags, the chart
`version` and `appVersion` in one run. **Images publish before the chart**, because a chart naming
images that do not exist yet does not fail: `helm install` succeeds and six workloads sit in
`ImagePullBackOff` while everything else comes up healthy. Installation, the one-time GHCR
visibility step, and what a release deliberately does *not* do (no `latest`, no arm64, no signing)
are in [`deploy/k8s/README.md`](../deploy/k8s/README.md#publishing-a-release).
