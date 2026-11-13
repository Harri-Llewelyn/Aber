# Testing

```bash
# Frontend — 3,600+ tests
cd frontend && npm test

# ---------------------------------------------------------------------------------------------
# EVERY Python suite, by LANE. This is what CI runs and what you should reach for.
# ---------------------------------------------------------------------------------------------
# The suites are DISCOVERED from the tree, not listed. The header at the top of each suite file says
# which lane it is in and why, and the runner refuses to start if a test_*.py in the tree has none --
# which is what stopped twenty of them running in no job anywhere (issue 147). Each suite is still
# spawned as its own `python <file>`.
npm run test:py          # lane: unit  — needs nothing at all
npm run test:py:db       # lane: db    — needs a migrated Postgres (see `npm run test:db` below,
                         #               which starts a throwaway one and runs this same lane)
npm run test:py:stack    # lane: stack — needs a running stack (npm run dev:test forwards to k3d and runs it)

# Every Python suite, with its lanes and what it is for, from the header at the top of its file.
# Each is spawned as its own `python <file>`, as the lane commands above do; run one that way.
node scripts/run-python-suites.mjs --list

# The broker-credential machinery whose failure is silent, in isolation and with no stack: the
# boot reconcile that must never lose a client, the control-API protocol, and the filter deciding
# which accounts the orphan sweep may disable — which is what keeps it from revoking
# `aber_ingestion` and stopping the stack ingesting. Also node-red-init against a seeded volume:
# one tls-config node shared by every broker, and a broker node with no credential pair stopping
# the boot. And the backup and restore scripts, with the PostgreSQL clients stubbed: a setting the
# backup cannot use stops it before the first dump, a run leaves a manifest naming every file or
# leaves nothing, and the restore replays each file that manifest names into its own database.
# And the half of `npm run try` that needs no cluster: the tools it checks for, what holds a port,
# and the published chart and values it installs. And a port-forward that does not open saying why
# (kubectl's exit and stderr, or no "Forwarding from" in time), against stand-ins for kubectl, and
# the second attempt the rehearsals' Traefik forward makes only on a port another socket took. And
# the ESLint rule that fails on a `title` on an HTML element in the dashboard, the browser's
# tooltip, against a fixture and its allow-list. And
# `scripts/mint-api-token.mjs` against a stand-in for its recording call: it records before it
# prints, its `--json` block parses, and a refused recording prints no token.
# And the credential service as it ships, over HTTP, against a stand-in `mosquitto_rr`: a read-only
# account is made holding the subscriber role alone under a username it generates, the caller
# names only its purpose, and a delete naming a gateway or a platform principal reaches no broker
# command. And the half of `scripts/scan-secrets.mjs` that needs no Docker: the history scope it
# takes, an unknown one refused, and the accepted list `--ignore-union` reads from a throwaway
# repository's branches, never from its pull request head, tag or stash. And the half of
# `scripts/scan-source.mjs` that needs no Docker: which of Semgrep's errors fail the scan, a tracked
# file it could not parse, whole or in part, beyond its named exceptions, and a tracked file outside
# `.semgrepignore` that its report does not list as read. And the signing set
# (`scripts/lib/signing-set.mjs`) completing values set up before 1.8.0, HS256 or ES256 with the
# `oct` key, as `npm run setup` and `keys:rotate -- --signing-keys` apply it: what each gains, what
# it keeps, and that a second run changes nothing. And the order the drift and mirror runners run
# their checks in, and the names they refuse (`scripts/lib/numbered-modules.mjs`). And the release's
# fold of `unreleased/` into the upgrade guide and the migrations' README (`scripts/fold-unreleased.mjs`):
# the order, the links rewritten, and that a second run changes nothing.
npm run test:lib

# NOTICE.md names every third-party image values.yaml pins, a chart template names or a Dockerfile is
# built FROM. Each licence text in licenses/ is the file licenses/SHA256SUMS pins, and every build
# of an image that copies them through the `licenses` named context passes it. Static; its parsing
# is tested in test:lib (scripts/check-image-licences.test.mjs).
node scripts/check-image-licences.mjs

# THE MIGRATION MODEL'S CENTRAL INVARIANT — needs the stack up, and replays db-init a second
# time against it. There is no migrations ledger, so "a second run must match no rows" is what
# the whole schema rests on, and it used to be upheld by review alone. Asserts only what a
# migration can move (the schema digest, and audit_trail's `migration` lane) and treats a FALL
# in operator row counts as failure while ignoring a rise, so a live daemon cannot make it flaky.
# DID THE CHAIN FINISH? There is no migrations ledger, and an aborted db-init leaves the stack
# running on a partially-migrated database. Checks the stamp db-init writes at the end of the chain,
# then selects every object 0001 builds over the historian's foreign server, and names the migration
# that should have made any that is missing.
node scripts/check-schema-surface.mjs

node scripts/check-migration-idempotency.mjs

# Database suites — the whole db lane, against a throwaway Postgres. Needs Docker and nothing else.
#
# RUN THEM THIS WAY. Every database suite defaults to port 54322, and that is where
# `npm run dev:forward` publishes the LIVE database -- so the bare `python ...` form points at
# production data and always has. See the note under this block for what that costs.
#
# Brings up a disposable supabase/postgres, applies the same auth fixture CI uses, replays
# every migration, runs every suite, and destroys the container. `--keep` leaves it up;
# `--reuse` replays the chain onto the one `--keep` left and runs again (the second boot, below);
# `-k <substring>` runs a subset; `--no-run` migrates and stops.
npm run test:db

# The individual suites are listed the same way. Point a database suite at the throwaway with
# `npm run test:db -- --keep --no-run` and SUPABASE_DB_PORT=54329 rather than running it bare.
node scripts/run-python-suites.mjs --list
# The evaluator's suite, test_a_threshold_automation_raises_its_alert_from_the_database.py, reads a
# real historian too when ABER_TEST_HISTORIAN is host:port:password of one built as
# lint-historian.mjs builds it.

# End-to-end — needs the running stack
#
# WAIT FOR THE DAEMON FIRST. `rollout status` returns when the process starts and the ingestion daemon
# carries no readiness probe deliberately, so "up" and "subscribed" are different states. Publishing
# into that gap makes the suite report a block of conformance failures for a cause none of them
# names -- ten of them, in the run that produced issue #47. This blocks until the daemon has
# actually consumed something, and fails naming the wait if it never does.
sh scripts/wait-for-ingestion-consuming.sh

# validate.py and the whole stack lane, through port-forwards, with the credentials read out of
# the release Secret. What CI runs.
npm run dev:test
# validate.py alone: the filter matches no stack suite. Its checks 12 and 17 are the live i3X
# checks: what the server says about a seeded plant against the Directory, then its quality and
# subscriptions against what the run publishes (i3x/README.md -> Testing).
npm run dev:test -- --filter=i3x
# The dashboard under its Content-Security-Policy, in a headless Chrome: the pages before sign-in,
# every page navigation.jsx declares, an area plan and two 3D models it makes and then deletes,
# and sign-out. Fails listing each refusal a page or one of its workers reports. Chrome is
# --chrome=PATH, or CHROME. CI runs it after the stack lane. Chrome signs in as the walk's own
# Administrator, csp-walk@aber.local, never as the seeded one, so the walk ends no session of a
# person's. The seeded Administrator (ABER_ADMIN_EMAIL) adds or restores that account
# and sets its password through the API first, and removes its access after; that API session
# ends alone.
node test-harness/csp-walk.mjs --base=http://app.localhost
```

**`validate.py` runs in-cluster as a Job (`e2e.enabled`) and from the host through the dev loop's
port-forwards**, and the two agreeing is the wiring check.

**CI runs the lane with the NetworkPolicy layer on** (`dev-cluster up --e2e --network-policy`), as
`values-prod.yaml.example` has it. A flow the chart's edge list does not name is dropped at its
destination, and nothing logs a policy decision, so this is where a missing edge shows. `npm run
dev:up -- --network-policy` does the same on a laptop. Without the flag the layer stays off, which
is the chart's default.

### What validate.py leaves behind

Nothing, when its check 16 passes. The run deletes what it created: the Directory rows its `SEEDED`
map names, plus any an interrupted run left under a VALIDATE name; their audit rows, through the owner
connection because `audit_trail` is append-only for every API role; their birth parameters in
`asset_config`; and in the historian, the telemetry and `assets` rows of exactly those devices. A
step that fails fails check 16, and the steps after it still run.

The historian half is **one DELETE per device, with its `sparkplug_id` as a literal**. TimescaleDB
decompresses only the compressed batches whose `segmentby` columns (`asset_id, metric_name`, set in
`timescaledb/retention.sql`) match a constant, and it caps what one transaction may decompress
(`timescaledb.max_tuples_decompressed_per_dml_transaction`, 100,000). The cleanup this replaced chose
its rows with a subquery, `asset_id IN (SELECT asset_id FROM assets WHERE asset_name LIKE
'VALIDATE_%')`, which matches no segment. Measured on the dev cluster on 2026-09-28: 72 rows matched,
and the DELETE had to decompress all 4,437,012 in the table. It failed at the cap, took the `assets`
DELETE in the same `try` with it, and printed a warning after the verdict.

**Rows earlier runs left** stay in the historian until they leave the raw window
(`telemetry_raw_window`). To remove them sooner, run this as the historian's owner while no
validate.py run is in progress (`kubectl -n aber exec -it timescaledb-0 -c timescaledb -- psql -U
postgres`). `\gexec` runs each generated DELETE as its own statement, and psql's autocommit makes
each its own transaction:

```sql
SELECT format('DELETE FROM telemetry WHERE asset_id = %L', asset_id)
  FROM assets WHERE asset_name LIKE 'VALIDATE%' \gexec
DELETE FROM assets a WHERE a.asset_name LIKE 'VALIDATE%'
   AND NOT EXISTS (SELECT 1 FROM telemetry t WHERE t.asset_id = a.asset_id);
```

### An empty database cannot exercise an assertion about history

Every path above replays the migration chain onto **nothing** — CI, `npm run test:db`, and the
self-check each migration runs at the end of itself. A migration that asserts over *accumulated
rows* is invisible to all three, and the first thing it meets is a deployment.

`0120` is the worked example. It moved `schemas` into the audit-domain asset lane, backfilled the
rows already recorded, and then asserted that **no row in `audit_trail`** disagreed with the
classifier. True of an empty database. False of any stack with history: a retired entity type's
rows keep the lane they were stamped with, nothing backfills them, and the classifier's answer
about them is its fail-closed default rather than a judgement. The dev cluster carried ten
`area_floors` rows from before `0113` retired that table. `0120` passed 29 database suites twice,
then failed `db-init` four times and took the Helm upgrade down with it.

```bash
# Capture the dev cluster's rows, load them over the migrated schema, replay the chain against
# them. That second pass is what db-init does on every boot of a deployed stack.
npm run test:db:history

# Keep the capture, so the next run needs no cluster at all.
node scripts/test-db.mjs --with-history --history-out=history.sql
node scripts/test-db.mjs --history-file=history.sql
```

**Run it for any migration that touches rows that already exist** — anything carrying an `UPDATE`,
a `DELETE`, a new `CHECK` constraint, or a self-check that counts. A migration that only creates
objects cannot fail this way and does not need it.

The capture is **read-only** against the live stack: a `pg_dump --data-only` of `public` and one
`COPY … TO STDOUT` for `auth.users`. Nothing is written anywhere but the throwaway container.

**What it copies, and what it does not.** `public` in full, which is what a migration asserts over.
From `auth`, only `users`, and only the columns the harness's GoTrue-shaped fixture also has — the
live schema carries 35 and the fixture 21, so the whole table cannot land, and `changed_by` is the
column that makes an audit row attributable. The rest of `auth` is GoTrue's own bookkeeping, which
no migration reads.

**The stack's partitions come too.** `pg_dump` copies a partitioned table's rows into each
partition by name, and a stack set up in an earlier month holds `audit_trail` partitions that a
database migrated today never made. The load creates each one the throwaway database lacks, with
the stack's bounds, before the rows arrive, so the default partition stays empty as it is on the
stack.

**What the suites do against history.** Every database suite passes against a real stack's rows as
it does against an empty database, because each scopes what it asserts to what it set up. A suite
written against an empty database breaks here in one of three ways, and each has met this lane:

- **It counts from zero.** A count of audit rows for a seeded gateway meets the rows a site already
  holds. Take the count before the call (`before = …`) and assert the difference
  (`test_a_shadow_gateway_holds_no_health.py`).
- **It reads a whole table.** A list of every row meets other people's. Scope the read to the ids
  the fixture made (`rows()` in `test_user_settings.py`; `p_entity_ids` in
  `test_audit_trail_paging.py`, whose newest-first walk once spent its page budget on a real
  stack's events before it reached its own).
- **It assumes a worker has never run.** `start_playback_job()` refuses a target whose credential
  was issued after the playback worker last reported one, and a used stack's worker has reported.
  Clear the state the function reads, inside the test's rolled-back transaction
  (`DELETE FROM public.playback_worker_status` in `test_capture_audit.py` and
  `test_only_the_seed_makes_a_playback_gateway.py`, as `test_playback_credential_delivery.py`
  does).

A red suite here and green on the plain lane is one of these, or a migration that cannot meet real
rows. The second is what the lane exists to find, so read the failure before deciding which.

Two things make the load possible and are worth knowing before changing it. Triggers and foreign
keys are off for the duration (`session_replication_role = replica`) — the audit stamp trigger
would otherwise re-stamp every row from *today's* classifier, destroying the very history being
reproduced, and the dump's table order cannot satisfy the circular foreign keys `pg_dump` warns
about on `devices`, `schemas` and `metric_catalog`. `postgres` is not a superuser on this image,
but Supabase grants it that setting. And the tables emptied first are chosen **by privilege, not by
ownership**: `auth.users` is owned by `supabase_auth_admin` and `postgres` may still truncate it,
while `auth.schema_migrations` it may not.

### The second boot, without a cluster

`db-init` replays the chain on every upgrade, onto a database that the chain and everything since
have already written to. `--reuse` reproduces that without a cluster: it keeps the container a
`--keep` run left, with every row that run committed, replays the chain onto it, lints the schema
and runs the lane again.

```bash
npm run test:db -- --keep     # first boot: the chain onto an empty database, then the lane
npm run test:db -- --reuse    # second boot: the chain onto what the first left, then the lane
```

Run both for a new migration. A statement that is not idempotent, or a self-check that counts a
total rather than what its own migration did, passes the first boot and fails the second: archived
migration 0069 counted Administrator's permissions, and failed every boot after the one on which
archived migration 0086 added one. `--reuse` skips the auth fixture, which the container
already holds, and uses the port the kept container was published on. Without `--keep` it removes
the container at the end, as every other run does; add `--keep` to go round again or to look at a
failure. The rows it replays onto are the suites' own; a deployed stack's rows are
`--with-history`'s, above.

### The URLs that are names, not forwards

Most of the lane reaches the cluster through a port-forward on `127.0.0.1`. Two variables do not:
`GITEA_TEST_URL` and `NODERED_BASE_URL` name an **Ingress host**, because the flows behind them are
OAuth flows whose registered callback is that host — `test_forge_membership.py` asserts the callback
it is redirected to, and `validate.py` check 7 signs in to the editor.

A name is not an address. Browsers resolve `*.localhost` themselves, and so does systemd-resolved;
**Python's `getaddrinfo` and Node's do not**, which is why these work when a person opens them and
fail when a suite does.

`dev-cluster test` resolves **every host the cluster's Ingress objects declare** before it opens a
single forward, and refuses to run when any of them fails. Not just those two variables: the door's
flow leaves them. The gateway redirects to the authorize endpoint it is *registered* with, which is
`api.<domain>` — a host no variable mentions, so checking only the variables would clear a machine
`test_forge_membership.py` still cannot run on. It is all-or-nothing in practice anyway: a resolver
either answers the wildcard or it does not.

| | |
| :--- | :--- |
| `dev-cluster up --domain=127.0.0.1.nip.io` | resolves everywhere, no privileges needed; the login pages then need TLS |
| a `hosts` entry per Ingress host against `127.0.0.1` | what CI does, from the cluster's own Ingress objects |
| `--no-dns-check` with `GITEA_TEST_URL=http://127.0.0.1:3003` | run a subset anyway; the forward covers every forge suite **except** the door, which follows the registered callback and fails whatever that is set to. Pair it with `--filter` |

The refusal prints the `hosts` line to paste, filled in from the cluster. `--no-dns-check` only lets
the failures through — it does not make them quiet, because the flag below still stands.

**A forge that cannot be reached is a failure here, not a skip.** The integration is optional, so
skipping is right for a person running one suite by hand — but `dev-cluster test` installed the
forge itself, so it sets `REQUIRE_FORGE=1` and the suites fail instead. The flag exists because the
skip is taken in `setUpClass`, which removes the whole class, and a run of nothing but skips reports
`OK (skipped=N)` and exits 0. That cost seven silently-absent tests per green Windows run (#222) and
hid a stale assertion that was red on `main` for days (#207). `REQUIRE_SEEDED_ACCOUNTS`,
`REQUIRE_LOG_PIPELINE` and `REQUIRE_PLAYBACK_REPLAY` are the same flag on the suites they cover.

**Every suite signs in from one address.** Through a port-forward each request reaches the gateway
from loopback, so the lane shares one sign-in budget: GoTrue's burst of 30 per address, refilled
about once every two seconds, behind the gateway's total of 120 a minute. Whether a suite meets a
429 depends on how quickly the suites before it signed in. So every suite that signs in with a
password goes through `test-harness/stack_sign_in.py`, which waits a 429 out for up to 30 seconds
and then fails naming the status and the body. A 429 is never a skip. Each suite keeps its own rule
for a stack without the seed personas, which GoTrue answers with a 400.

## Why the database suites get their own Postgres

**The default was production.** Every suite under `supabase/migrations/` resolves its port as
`os.getenv("SUPABASE_DB_PORT", "54322")`, and `npm run dev:forward` publishes the live Supabase
database on 54322. So the documented invocation — `python
supabase/migrations/test_audit_domain.py`, nothing set — connected to the running stack.

Most of the suites roll back, which helps less than it sounds. `audit_trail` is append-only by
`0003`, so the rows a rolled-back test provokes are exactly the ones a *committed* fixture leaves
behind for good. Measured on a development stack:

| | rows |
| :--- | ---: |
| `audit_trail` total | 525 |
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

**This is a paved road, not a fence.** `SUPABASE_DB_PORT` still defaults to `54322`, because the
dev loop forwards it there, `validate.py` derives from it and both backup scripts read it — changing
the default would be overridden by the environment in the common case and would fight four other
consumers in the rest. `npm run test:db` makes the clean path a one-liner; running a suite bare still reaches the
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
0038: GATEWAY_REVOKE_SECRET or SUPABASE_PUBLISHABLE_KEY is unset; credential revocation is INERT
      on this stack. Archiving will not revoke, and the sweep will do nothing.
```

A `NOTICE`, so the chain applies and every schema check passes — and
`test_credential_revocation.py` then fails four assertions with `0 != 1`, naming a queue depth
rather than an unset secret three thousand lines upstream. The values the runner supplies are fake
and its functions URL is deliberately unreachable.

**The runner *discovers* the suites rather than listing them**, so a new suite cannot be left out
of CI. When `edge-function-auth-test` named its suites by hand, seven of the sixteen in the
directory ran in no CI job.

**The frontend figure is a lower bound rather than a count**, and deliberately: it moved four times
in one afternoon and each move made both documents wrong until somebody noticed. A bound only ever
becomes conservative, which is the failure worth having — `npm test` prints the exact number, and it
is the only place that can be right on every branch at once.

Five suites have a second half elsewhere, and both halves must move together:
`test_modelled_metrics_contract.py`, `test_payload_conformance.py`, `test_schema_builder_contract.py`
and `test_rbe_telemetry.py` each
pair with a JavaScript suite in the frontend run, and `test_i3x_service.py` covers the sync-acknowledgement and queue-overflow MUSTs
the CESMII conformance suite skips. See [`ingestion/README.md`](../ingestion/README.md#testing) and
[`i3x/README.md`](../i3x/README.md). The i3X server has a third check besides those two: `validate.py`'s
checks 12 and 17 compare its answers about a seeded plant with the Directory's, and its quality and
subscriptions with what the run publishes, the meaning neither the conformance suite nor the unit
suite can see.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs nine jobs:

| Job | Covers |
| :--- | :--- |
| **changes** | Classifies the diff, so a documentation-only change skips the end-to-end stack |
| **frontend-build** | Vitest, the mirrored-logic drift guards, production bundle |
| **helm-chart** | `helm lint`, render, API-schema validation, chart guard rails |
| **edge-function-auth-test** | Auth ladders and RLS against a real Postgres |
| **k8s-validation** | k3d cluster through `dev-cluster up --e2e --network-policy`: `helm test`, `validate.py` in-cluster, the stack lane through port-forwards, the i3X conformance suite, ingress assertions, the dashboard walked in Chrome under its Content-Security-Policy, all with NetworkPolicies on |
| **site-install-rehearsal** | `site-rehearsal install` on k3d: the checkout installed as a new site, with values from `setup.mjs`, never `values-dev.yaml`, then the i3X conformance suite through Traefik over HTTPS (*The install and upgrade rehearsals*, below) |
| **upgrade-rehearsal** | `site-rehearsal upgrade` on k3d, twice (`es256`, `hs256`): the last release installed as published, its values completed by the checkout's `setup.mjs`, then `helm upgrade` to the checkout |
| **secret-scan** | gitleaks over the history of the commit under test and the working tree, on every push (*The secret scans*, below) |
| **static-analysis** | The other eight checks of [`docs/static-analysis.md`](static-analysis.md), in pinned containers; skipped with the end-to-end stack on a documentation-only push |

**k8s-validation and static-analysis sit behind the `changes` gate**: most of the workflow's minutes are
spent there, and a change that touches only documentation cannot alter what they assert. The gate fails
open, so a diff range it cannot compute runs them anyway. secret-scan runs on every push. **The two
rehearsals have a gate of their own**: they run when what a site installs changed (the chart, the
migrations, an image or the sources it is built from, `setup.mjs`, or the rehearsal itself), and on
every push to main.

The three k3d jobs share their failure dump, [`.github/actions/cluster-diagnostics`](../.github/actions/cluster-diagnostics/action.yml):
each pod's current log, and for every container that restarted, how its previous run ended (reason,
exit code, signal) and that run's last 80 lines. A restarted container's current log is its fresh
start, which says nothing about the crash. `dev-cluster.mjs` prints the same when an e2e Job fails.

**k8s-validation reserves the dev loop's forward ports before it creates its cluster.** 54321 to
54323 sit inside Linux's ephemeral range (32768 to 60999), so any outgoing connection on the runner
can be handed one before `dev-cluster test` listens there, and the forward fails with `EADDRINUSE`.
The job's step after the checkout adds them to `net.ipv4.ip_local_reserved_ports`, and the restore rehearsal does
the same for its tunnels' 54398 and 54399 (check 140 holds both lists to the scripts). On a Linux
machine that meets the same error, `sudo sysctl -w net.ipv4.ip_local_reserved_ports=54321-54323`
reserves them until the next reboot; add them to the list if `sysctl net.ipv4.ip_local_reserved_ports`
already names other ports.

**k8s-validation's kubelet syncs its pods every 10 seconds, faster than a site's.** The job sets
`ABER_KUBELET_SYNC_FREQUENCY=10s`, and `dev-cluster up` passes it to the kubelet of the cluster it
creates. A site's kubelet keeps its default of a minute, and so do the dev loop and both rehearsals.
The kubelet refreshes a running pod's projected Secrets on that period. So a credential delivered
to the playback worker reaches it in about 15 seconds rather than about a minute, and the playback
replay and the two capture suites wait that much less for each one. Their timeouts stay sized for a
site's minute. Check 154 holds the job, the script and this paragraph to one period.

### The secret scans

Two jobs run `scripts/scan-secrets.mjs`, over different history:

| Job | When | What it scans | What it accepts |
| :--- | :--- | :--- | :--- |
| **secret-scan** in `ci.yml` | Every pull request and push | `--history=head`: the history of the commit under test, and the working tree | That commit's own `.gitleaksignore` |
| **scan-every-ref** in [`secret-scan.yml`](../.github/workflows/secret-scan.yml) | Every push to main, daily, and by hand | `--ignore-union`: every branch, tag and pull request head | main's `.gitleaksignore` together with every branch's own, never a pull request head's |

**A pull request fails only on what it would add to main.** On a pull request, the commit under
test is the merge commit: main's history plus the branch's commits. Each branch reviews its own
findings in its own `.gitleaksignore`. Scanning every ref there would fail every open pull request
on another branch's reviewed finding, until that branch merged.

**Every ref is still watched, because the repository is public.** A secret pushed on any branch
can be fetched by anyone, even after the branch is deleted. scan-every-ref fails on a finding that
no list accepts, wherever it was pushed, and names the refs that reach it. Rotate a real secret
first. Then add the finding's fingerprint, with its reason, to the branch's `.gitleaksignore`, or
to main's when the branch is gone. A failure files no issue, because a public issue would announce
the leak.

**A pull request head's own list is not read.** Its commits are scanned, but only the lists of main
and the repository's branches (`refs/heads/*` and `refs/remotes/origin/*`) are trusted. A pull
request that is never merged, or one from a fork, could otherwise accept its own finding. Tags and
the stash are not read either. A pull request from a branch here passes through that branch's list.

Run by hand, `npm run scan:secrets` scans every ref against the checkout's own list, which is the
strictest of the three. Add `--ignore-union` when another local branch's reviewed finding fails it.

## The install and upgrade rehearsals

k8s-validation installs the checkout with `values-dev.yaml`, which sets every password and every
development switch. A site installs with the values `npm run setup` writes, from the published
chart, and later upgrades from one release to the next. A fault in that path passes k8s-validation:
1.0.0 and 1.0.1's `setup.mjs` wrote no `secrets.mqttI3xPassword`, so every site set up with it had
its broker stuck in `Init:Error` while CI stayed green. Two rehearsals cover that path, both run by
[`scripts/site-rehearsal.mjs`](../scripts/site-rehearsal.mjs):

```bash
npm run rehearse:install   # the checkout, installed as a new site
npm run rehearse:upgrade   # the last release as published, then `helm upgrade` to the checkout
```

Each creates a k3d cluster for the run (`aber-rehearsal`, or `--cluster=<name>`) and writes its
kubeconfig to a file of its own (`--kubeconfig=<file>`), so the dev loop's cluster and the default
kubeconfig are left alone. It publishes no host port. A pass deletes the cluster (`--keep` keeps it);
a failure leaves it, and prints where its kubeconfig and values are.

- **install** writes the values with the checkout's `scripts/setup.mjs --domain=rehearsal.aber.test
  --admin-email=…` and a `site.yaml` like the one in
  [Running the server](../help/site/running-the-server.md#a-from-the-published-chart-no-image-builds)
  (*Install → A*): ingress and broker TLS from the internal CA. Before the install it applies the
  Traefik setting, cert-manager and the internal CA, as that page does.
- **Both run with NetworkPolicies on**, as `values-prod.yaml.example` has them, because that is
  what a site starts from. The `site.yaml` adds `networkPolicy.enabled`, `kube-system` for DNS and
  the ingress controller, and the node's own address as `apiServerCidr`.
- **upgrade** starts from the last release: the highest `v*` tag that is not this commit
  (`--from=<tag>` names another). That tag's own `setup.mjs` writes the values, run from a `git
  worktree` that is removed straight after. The script installs
  `oci://ghcr.io/harri-llewelyn/aber/aber` at that version, with its published images, and waits for
  it to be healthy. Then the checkout's `setup.mjs` completes the values, as the server installer
  and [`upgrades.md`](upgrades.md) do, and it runs `helm upgrade` to the checkout with the same two
  values files. From a release before 1.1.0 (`--from=v1.0.2`) both the install and the upgrade run
  with NetworkPolicies off: those charts lack the edges their own hooks need under the layer (#755).
- **upgrade --from-signing=hs256** starts from a site still signing HS256: the last release's values
  with no key pair, `supabaseAuth.es256Signing` false and every JWT signed with `jwtSecret`. It
  asserts that release takes a token signed with `jwtSecret` before the upgrade, so the site is the
  HS256 one it rehearses. CI runs the upgrade twice, `es256` (the values as that release's
  `setup.mjs` wrote them) and `hs256`. From a release that signs ES256 alone (1.8.0 on) the two
  are the same.

**The checkout's images carry a tag no release has**, `<Chart.yaml version>-ci.g<commit>`. The
checkout's chart is packaged with that as its version and `appVersion`, as `release.yml` packages a
release. Between releases `Chart.yaml` names the last release, so without this the node would hold a
built and a published image under one name. Only the built images the site's render names are built:
the backup service and the test runner are off in a site's values.

Both end with the same checks:

- every StatefulSet, Deployment and DaemonSet rolls out, one `kubectl rollout status` at a time
  (`helm --wait` deadlocks a first install, see [`help/site/running-the-server.md`](../help/site/running-the-server.md#a-from-the-published-chart-no-image-builds));
- the historian's TimescaleDB extension is installed at the version its image ships, the one
  `timescaledb/Dockerfile` is built `FROM`. On `upgrade` from a release with an older TimescaleDB,
  this shows the maintenance hook waited for the new historian pod before it updated the extension
  ([`timescaledb/README.md`](../timescaledb/README.md#why-on-every-boot-and-in-this-order));
- `helm test` passes;
- every running pod's built image carries the checkout's tag;
- the first administrator signs in through Traefik, over HTTPS to `api.rehearsal.aber.test` with a
  certificate from the internal CA, using the password in the values file;
- `admin@aber.local` with `aber123` is refused;
- the API serves the session's ES256 token, and answers 401 to the same claims signed HS256 with
  `jwtSecret`.

**With `--i3x-suite=<dir>`, CESMII's i3X conformance suite runs last**, against
`https://i3x.rehearsal.aber.test/v1` through Traefik. `<dir>` is the `conformance-tests` folder of a
`cesmii/i3X` checkout at the commit `ci.yml` pins (`I3X_SUITE_REF`); CI's site-install job passes
it. The suite trusts only the internal CA (`NODE_EXTRA_CA_CERTS`, never its `--insecure` flag), and
`scripts/lib/resolve-hosts.cjs` points the name at the port-forward, since the domain resolves
nowhere. The verdict must be *Full 1.0 Compliance* or *1.0 Compatible*, as in k8s-validation, and
CORE-05 (served over HTTPS) must pass. The two runs cover different things. k8s-validation's has
`validate.py`'s data in the stack, so it exercises tests a fresh site skips, and it warns CORE-05
because it reaches the service over a port-forward. This one is the path a site's clients take:
Traefik's route, TLS from the internal CA, the HSTS header and the NetworkPolicy layer.

```bash
git clone https://github.com/cesmii/i3X.git ../i3x-spec && git -C ../i3x-spec checkout <I3X_SUITE_REF>
npm run rehearse:install -- --i3x-suite=../i3x-spec/conformance-tests
```

`upgrade` also signs in before the upgrade, and asserts that the upgrade's own `aber-db-init` Job ran
the checkout's image and completed: it replays the migration chain onto the last release's database.
It asserts that every volume claim kept its uid, so no data volume was replaced. A StatefulSet whose
claim templates changed must have been created again, by the `claim-templates` pre-upgrade hook
([`help/site/upgrading.md`](../help/site/upgrading.md#from-102-or-earlier-the-two-databases-statefulsets-are-replaced-once)),
and own its running pod; one whose claim templates did not change must be the same object. The
hook's log is printed with the result. That pre-upgrade hook runs under the last release's
NetworkPolicies and its own. The post-upgrade hook Jobs (`db-init`, `timescaledb-maintenance`,
`storage-policies` and the rest) run under the candidate's. So an edge the candidate adds or drops
shows up here.

Both also assert the policy layer is enforced, not only rendered; `upgrade` does so after the
upgrade. Two probe pods ask `pg_isready` about `supabase-db:5432`: one labelled as `db-init`, which
an edge admits, is answered, and one no rule admits is not. Together with the rest passing,
this shows that every flow the install or upgrade, its hook Jobs, `helm test` and the sign-in
through Traefik need is admitted on k3s, and that nothing else is. **It cannot show** whether the API-server rules
are right: k3s does not filter a pod's traffic to the node it runs on, which is where the API server
is. Nor can it show flows the install never exercises, such as the cold archive at 03:15 or
gateways from outside the cluster. And it shows k3s's policy controller only, not Calico's or
Cilium's. k8s-validation covers more of those flows: it runs `validate.py`, the AAS export suite,
the stack lane (backups and the playback replay among it) and the i3X conformance suite with the
layer on.

**No CI job installs with the layer off**, though that is the chart's default and what most sites
run. The helm-chart job's render checks hold that default: with the layer off, the forge's policy
is the only one a default install renders. With Studio on, Studio's and postgres-meta's join it,
each admitting its one caller, and still admit only that caller with the layer on. Every developer's `npm run dev:up` installs without the layer. A second,
smaller k3d job with the layer off would cost another cluster's minutes on every push, for a
configuration that differs from the one CI runs only in its NetworkPolicy objects.

Measured on a 16 GB laptop with the image builds cached, `install` took 8 minutes with
NetworkPolicies on and `upgrade` 7½ to 12½, most of the spread in pulling the published images. CI builds every image
from nothing, so it takes longer.

**What they do not rehearse** is the rest of
[#691](https://github.com/Harri-Llewelyn/Aber/issues/691): real hardware, weeks of running, the
rest of the hardening that is off by default (both backup tiers, database TLS), real appliances and
the failure drills.

### AppArmor on the runner

Every job that starts a k3d cluster first unloads the runner's `mosquitto` AppArmor profile
(`.github/actions/install-k3d`). Ubuntu 26.04 loads that profile, and Ubuntu 24.04 did not.

k3s runs inside a container in k3d, where it cannot load AppArmor profiles, so its pods run
unconfined as far as the host kernel is concerned. An unconfined process that executes
`/usr/sbin/mosquitto` is attached to the host's profile by path. That profile allows the Debian
package's paths, not `/mosquitto/config`, so the broker exits with "Unable to open config file", and
ingestion and i3X fail behind it. Measured on the 26.04 runner on 2026-10-11:

- In a k3d pod, `open("/mosquitto/config/mosquitto.conf")` returned `EACCES` to the broker with
  `DAC_OVERRIDE` held and with seccomp `Unconfined`. `cat` read the same file. The kernel log said
  `apparmor="DENIED" operation="open" profile="mosquitto" name="/mosquitto/config/mosquitto.conf"`.
- The same pod on the 24.04 runner started the broker.
- On the 26.04 host itself, `docker run` started the broker: Docker confines its containers with
  `docker-default`, and an exec inside that profile does not change profile.

A site should not be affected, though no 26.04 host has measured it yet (the installer supports
22.04 and 24.04): k3s on the host confines every pod with containerd's own profile, which does not
change profile on exec either. A developer running k3d on an Ubuntu 26.04 host meets the
same refusal; removing the profile (`echo -n mosquitto | sudo tee
/sys/kernel/security/apparmor/.remove`) lasts until the next reboot. The cluster diagnostics print
the runner's AppArmor denials, so another profile that attaches the same way shows up by name.

## Keeping the pinned versions current

Three scheduled workflows watch what the stack runs, and they answer different questions. None runs
on a pull request: version drift, published advisories and the slow rot of a restore path all move
on the world's schedule, not on this repository's. A fourth, `secret-scan.yml`, watches every ref
for secrets (*The secret scans*, above).

| Workflow | Job | Asks |
| :--- | :--- | :--- |
| [`renovate.yml`](../.github/workflows/renovate.yml) | **renovate** | *Is there a newer version?* — routine PRs monthly, security PRs immediately |
| [`image-scan.yml`](../.github/workflows/image-scan.yml) | **scan** | *Does what we run have a known, **fixed** vulnerability?* — monthly, third-party images only, by `npm run scan:images`; every image built here is gated at release |
| [`restore-rehearsal.yml`](../.github/workflows/restore-rehearsal.yml) | **rehearse** | *Would a restore actually work today?* — weekly |

### The restore rehearsal is the odd one out

The other two ask about versions. This one asks whether a capability the repository CLAIMS still
exists, and it is scheduled for the same reason: the restore path depends on the shape of two
databases, the Supabase role set, the pgsodium root key and the migration chain, and every one of
those changes. A restore that worked in August fails in November, and nothing else would notice
until it was needed.

It runs a full cycle against a disposable k3d cluster — seed → back up through the backup service
→ **destroy the namespace and its volumes** → reinstall → restore → assert → back up again — driven
by `scripts/rehearse-restore.sh`, which an operator can also run by hand against any cluster. The
backup is the service's, asked for the way the Backups page asks, and it carries the two dumps,
the storage objects, the forge's volume, the broker's document and Grafana's volume. Destroying the volumes is what makes it
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
against Docker Hub, a member of the set can look outdated when it is exactly the version upstream
pins, so an "upgrade" would move this stack *off* the tested combination. They
are grouped into one pull request held for approval, as are all major bumps. Kong 3.0 is why:
it silently switched off every per-service Prometheus metric while leaving the scrape target green.

**Renovate is self-hosted**, so no third-party app holds write access to the repository, and it
needs a `RENOVATE_TOKEN` secret (a PAT with `repo`, or fine-grained with Contents, Pull requests and
Issues read/write and Dependabot alerts read). A token that cannot read Dependabot alerts leaves
`vulnerabilityAlerts` with nothing to act on, and the run says so only as a warning in its log
("Cannot access vulnerability alerts"); `osvVulnerabilityAlerts` still works. Without the secret the
workflow fails on its first step by design — a scheduled job that
silently does nothing leaves the repository looking as though drift is watched when it is not.
`GITHUB_TOKEN` cannot be used: pull requests it opens trigger no workflow runs, so every bump would
arrive with no CI result.

**The scan reports only *fixable* HIGH and CRITICAL findings.** An unfixed CVE in a base image is
not something this repository can act on, and failing on it would train everyone to ignore the job.
Its image list is rendered out of the chart (`helm template`) rather than written in the workflow, and it
refuses to run if it finds fewer than ten — "found nothing to scan" must not look like "found
nothing wrong". The optional workloads are rendered on, except Studio and postgres-meta, which stay
off as in a default install: a site that runs them takes on two images the scan does not cover.

**The workflow runs [`scripts/scan-images.mjs`](../scripts/scan-images.mjs), which is `npm run
scan:images` on a laptop**: the same images, Trivy in the pinned container `scan:config` uses
(CI installs the same release), and the cache in the `trivy-cache` volume. A fixable finding the
stack cannot take yet, because the newest release still carries it or the vulnerable package is
never run, is accepted in [`scripts/lint/image-allowlist.json`](../scripts/lint/image-allowlist.json):
one group per image repository, with a reason a reviewer can check, an `expires` date and the
`<vulnerability id> <package>` keys it accepts. The scan fails on any other finding, on a group on
or after its expiry date, and on a key that matches nothing, so each acceptance is read again at
the first scan after it expires and goes once the bump that clears it lands.

## Releases

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on a **`v*` tag only** —
never on a branch:

| Job | Covers |
| :--- | :--- |
| **prepare-release** | Derives the version from the tag, refuses a non-SemVer one or one `Chart.yaml` does not name, re-runs the static checks a published artefact must not violate |
| **build-images** | The ten independent images, in parallel, each built to an OCI archive and **scanned** before it is pushed to GHCR with an SPDX SBOM and SLSA provenance in its index, then signed keyless with cosign and verified back |
| **build-ingestion-chain** | `ingestion`, then `test-runner` `FROM` it, as one `docker buildx bake` of `docker-bake.hcl`; built to OCI archives first so the attestations are asserted and both images **scanned** before (and without) a push, then pushed, signed and verified |
| **scan-third-party-images** | Every third-party image the chart runs, by `scripts/scan-images.mjs --reports`, the monthly scan's script; a finding is recorded rather than stopping the release, an image that cannot be scanned stops it |
| **publish-chart** | Summarise every scan report into the chart's `files/image-scans.json`, lint, render, package at the tag's version, check the package has a dated scan of every image it runs, push over OCI, pull it back, sign the pushed digest and verify it |
| **attach-sboms** | Reads every image's SBOM and provenance back out of the registry and attaches them to the GitHub Release, opening it as a draft from the template if nothing has |

Every scan's Trivy JSON report is kept as a workflow artifact. The packaged chart carries their
summary, which db-init records and the System page shows beside each version
([`supabase/README.md`](../supabase/README.md)).

The tag stamps the eleven image tags, the chart `version` and `appVersion` in one run, and the
commit it points at already names that version in `Chart.yaml`. **Images publish before the chart**, because a chart naming
images that do not exist yet does not fail: `helm install` succeeds and the workloads sit in
`ImagePullBackOff` while everything else comes up healthy. **Nothing publishes unsigned or
unattested**: [`sign-and-verify.sh`](../.github/scripts/sign-and-verify.sh) runs the consumer's
verification inside the release and refuses an image whose SBOM or provenance did not arrive.
Installation, the one-time GHCR visibility step, what is signed and how, and what a release
deliberately does *not* do (no `latest`, no arm64) are in
[`deploy/k8s/README.md`](../deploy/k8s/README.md#publishing-a-release).

**What the release promises a site** — the supported window, what makes a version major, the
deprecation path and the release-note headings — is [`releases.md`](releases.md). This section is
what the workflow builds; that one is what a site is signing up for.

### The GPL sources release

[`.github/workflows/gpl-sources.yml`](../.github/workflows/gpl-sources.yml) has one job,
**mirror-sources**, run by hand once per `supabase/postgres` base tag. It publishes the release
`gpl-sources-supabase-postgres-<tag>-postgis`, which holds the complete corresponding source of the GPL and
LGPL components the database images carry, one archive each, every one pinned in
[`licenses/supabase-postgres/sources.json`](../licenses/supabase-postgres/sources.json)
([`licenses/README.md`](../licenses/README.md), *The mirror*). **prepare-release** refuses to publish
images until that release holds every archive the lock pins; a dry run only warns.
`node scripts/mirror-gpl-sources.mjs --check` downloads every archive from upstream and checks it
against the lock, and writes nothing to GitHub.
