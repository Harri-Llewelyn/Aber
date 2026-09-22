# PostgreSQL 17 and TimescaleDB 2.29 — Implementation Plan

> **Historical.** The Compose target this plan verified against was removed in September 2026;
> the pins now live in `values.yaml` alone and the line references below are to the retired file.

**Status (2026-08-10):** Phases **0, 2, 3 and 4 are COMPLETE** and verified on the Compose target.
Both databases run PostgreSQL 17; the historian runs TimescaleDB on the columnstore API — extension
2.29.2 as of 2026-08-29, when `ALTER EXTENSION timescaledb UPDATE` started running on every boot and
closed the gap between the pinned image and the installed extension. See §4 and
[`../docs/upgrades.md`](upgrades.md#the-historian-upgrades-itself-too-and-used-not-to).

**Phase 1 (removing `pgjwt`) is DEFERRED — accepted technical debt, not unfinished work.** Phase 0
demoted it from blocker to hardening when the extension turned out to still ship in
`supabase/postgres:17.6.1.160` and sign correctly. The debt is small and bounded: Supabase has
announced pgjwt's end for Postgres 17 and removed it from the hosted platform, so the self-hosted
image retaining it is a reprieve rather than a reversal. **The trigger to pick this up is a
`supabase/postgres` bump whose image no longer lists `pgjwt` in `pg_available_extensions`** — at
which point `supabase-db-init` fails at `0001`, loudly and on the first boot, because 0001 now
declares the extension explicitly. That is the failure mode you want: it cannot ship silently.
**Date:** plan drafted 2026-08-10; executed the same day.

## Goal

Move both databases from PostgreSQL 15 to PostgreSQL 17, and the historian's TimescaleDB extension
from 2.28.3 to 2.29.1. This buys roughly five years of upstream support in place of fifteen months,
and it resolves a supply problem that has **already happened** rather than one that arrives in 2027.

The upgrade is not primarily about new features. Two optimisations land on hot paths this codebase
already has, and they are taken in Phase 3 — but the reason to do this work now is that
`timescale/timescaledb:latest-pg15` stopped moving on 2026-07-16 and nothing in the repository
noticed.

**The timing is the point.** This stack has one installation, it is a development one, and it holds
no operator data. Every hard part of a PostgreSQL major upgrade — `pg_upgrade`, the pgsodium key,
compressed-chunk dump/restore, a rehearsed restore, a scheduled outage — is a **data** problem, and
there is no data. Doing this after a shopfloor deployment would mean doing all of it. Doing it now
means changing pins and recreating volumes.

### Scope boundaries, already settled

- **The ceiling is PostgreSQL 17, not 18.** Three constraints compound. `supabase/postgres`
  publishes no PG18 image — the only lines are `15.x`, `17.6.x`, and `17.9.x-orioledb`, and orioledb
  is a different storage engine rather than a version bump. The backup CronJob reuses the
  `supabase/postgres` image's `pg_dump` against **both** databases
  ([backup-cronjob.yaml:134](../deploy/helm/aber/templates/jobs/backup-cronjob.yaml#L134)),
  and `pg_dump` refuses a server newer than itself, so the historian's major version is capped by
  Supabase's. And keeping both ends on one major keeps the `postgres_fdw` link uninteresting.
- **Do not split the two databases across majors** to reach PG18 on the historian. It breaks backups
  in exactly the way the comment at `backup-cronjob.yaml:134` was written to prevent, and the
  failure appears at 02:00 in a CronJob log rather than at upgrade time.
- **No data-migration path is built.** There is nothing to migrate, and a runbook written from
  theory against a procedure nobody will run is worse than no runbook — it would be trusted. If a
  future major upgrade has to move real data, that plan gets written then, against that data.
- **Not an orioledb evaluation.** `17.9.0.013-orioledb` is a separate decision with a separate risk
  profile and does not belong inside a version bump.
- **Not a Postgres HA project.** PG17's failover-safe logical replication slots remove one argument
  against the HA work deferred in
  [kubernetes-architecture.md §3.3](kubernetes-architecture.md), because `supabase-realtime`
  holds a logical slot. That is a note for whoever picks HA up, not scope here.

### Decisions settled 2026-08-10

| Decision | Resolution |
|---|---|
| Data-migration runbook | **Not needed.** One installation, development only, no operator data |
| Historian tag | **Pinned** — `2.29.1-pg17`, not `latest-pg17` |
| Signer migration number | **`0011`** — see below |

`0011` is also wanted by [vocabularies.md](vocabularies.md), which is
Phase-0-gated on paid standards documents and has not started. This work is unblocked and lands
first, so it takes `0011` and the vocabulary work starts at `0012`.

## What the reconnaissance found

- **`latest-pg15` is a dead branch.** TimescaleDB 2.29.0 dropped PostgreSQL 15; 2.28.x was the final
  minor to support it. The tag still resolves, still pulls, and will never advance again. The pin at
  `docker-compose.yml:49` reads as "track upstream" and no longer does.
- **The historian's extension is already current.** `latest-pg15` is 2.28.3, so the TimescaleDB
  *extension* is one minor behind. The gap is entirely in the PostgreSQL major underneath it.
- **Supabase is two lines behind, not one.** `docker-compose.yml:130`
  pins `15.6.1.143`; upstream 15.x is now `15.14.1.160`. The stack is behind on the version it is
  already running, independently of any major bump.
- **`pgjwt` was expected to be a hard blocker. It is not** — see Phase 0. The changelog says the
  PG17 bundle drops it; the image still ships it and it works.
  [0006_nodered_oidc_auth.sql:207](../supabase/migrations/archive/0006_nodered_oidc_auth.sql#L207) signs the
  quarantine-webhook token with `extensions.sign()` and
  [0006:263](../supabase/migrations/archive/0006_nodered_oidc_auth.sql#L263) raises if it is absent, so this
  *would* have stopped `supabase-db-init` at archived migration 0006. It does not. Phase 1 survives as
  hardening against a deprecation Supabase has announced and will eventually act on.
- **The PG17 bundle also drops `timescaledb`, which costs nothing here.** The historian is a
  separate container. The split pays off.
- **Compose and Helm must be bumped in the same commit.** `check-image-tag-parity.mjs` compares the
  two targets and exits non-zero on any mismatch — verified by running it. Bumping one first is not
  a smaller step, it is a red CI run. This is why Phase 2 is one phase and not two.
- **Migrations are mirrored automatically.** `scripts/sync-helm-chart-files.mjs` copies
  `supabase/migrations/*.sql` into `deploy/helm/aber/files/migrations/`, and CI runs it with
  `--check`. Migrations are edited once and synced, never edited twice. The same holds for the
  Grafana dashboard JSON and the `timescaledb/` scripts.

  > **No longer true of the migrations, as of 2026-08-20.** They are baked into the `db-init` image
  > instead — the chart could not carry them, because a ConfigMap and Helm's release Secret are both
  > capped at 1 MiB and the release holds those bytes twice. See `supabase/db-init/Dockerfile`. The
  > mirror still works exactly as described for everything else.
- **The backup Job follows the pin on its own.** It renders
  `{{ .Values.supabaseDb.image.repository }}:{{ .Values.supabaseDb.image.tag }}`, so the image
  tracks automatically. Only the *stated constraint* in its comment needs revising.
- **Migration head is `0010_telemetry_aggregates.sql`.**

---

## Phase 0 — Verification gate — ✅ COMPLETE (2026-08-10)

The bump invalidates several **facts asserted in the repository as constants**, and a restated
constant in a checker is not a check — [ci.yml:727](../.github/workflows/ci.yml#L727) already learnt
this the hard way when `fsGroup` read 999 in two places while both were wrong.

Verified against `timescale/timescaledb:2.29.1-pg17` and `supabase/postgres:17.6.1.160` in isolated
probe containers, using the command documented at [ci.yml:715](../.github/workflows/ci.yml#L715).

| Fact | Repository claims | Measured on the new tags | Verdict |
|---|---|---|---|
| `timescale/timescaledb` uid/gid | 70 | **70:70** | ✅ unchanged |
| `timescale/timescaledb` base OS | Alpine | **Alpine 3.23** (was 3.22) | ✅ unchanged |
| `supabase/postgres` uid/gid | 105:106 | **100:101** | ❌ **changed** |
| `supabase/postgres` base OS | Debian / Ubuntu 20.04 | **Alpine 3.23**, Nix-built | ❌ **changed** |
| `pgjwt` available | assumed **dropped** on 17 | **present (0.2.0), installs, signs correctly** — but no longer CREATED by default, which 0001 had relied on | ❌ **assumption wrong** |
| `storage` stub tables | [0001 §6](../supabase/migrations/0001_baseline_schema.sql) relied on `storage.objects` existing at migration time | PG15 shipped `buckets`/`objects`/`migrations`; **17.6 ships the schema EMPTY** | ❌ **changed** |
| Grants on `storage.*` | assumed present | PG15 stub granted ALL to anon/authenticated/service_role; **17.6 grants nothing** | ❌ **changed** |
| `pg_cron`, `pg_net`, `pgcrypto`, `postgres_fdw`, `supabase_vault` | required by [0001:66-69](../supabase/migrations/0001_baseline_schema.sql#L66) | all present; `pg_cron`/`pg_net` in `shared_preload_libraries` | ✅ |
| `vault.create_secret` / `update_secret` / `decrypted_secrets` | used by [0002:2205](../supabase/migrations/0002_seed_data.sql#L2205), [0006:134](../supabase/migrations/archive/0006_nodered_oidc_auth.sql#L134) | signatures unchanged, view present | ✅ |
| `/etc/postgresql/postgresql.conf` ships | [supabase-db-statefulset.yaml:100](../deploy/helm/aber/templates/data/supabase-db-statefulset.yaml#L100) | present, plus a `postgresql.conf.d/` | ✅ |
| No `aws` CLI in the image | [k8s README:665](../deploy/k8s/README.md#L665) | still absent; `pg_dump` is 17.6 | ✅ |
| Locale provider | unstated | PG15 **libc** → PG17 **ICU**, both `en_US.UTF-8` | ⚠ note |
| TimescaleDB 2.29.1 runs this repo's SQL | — | `init/001_schema.sql`, `retention.sql`, `aggregates.sql` all apply, **and are idempotent on a second run** | ✅ |

### Findings that change the plan

1. **`pgjwt` is NOT dropped from the self-hosted image.** Supabase's changelog deprecates it for
   Postgres 17 and the self-hosting guide lists it among removed extensions, but
   `supabase/postgres:17.6.1.160` still ships `pgjwt 0.2.0`; it installs into `extensions` and
   `extensions.sign()` returns a correct HS256 JWT. **Phase 1 is therefore hardening, not a
   blocker** — it does not gate Phase 2. This is precisely what this gate exists to catch: the
   changelog and the image disagree, and only the image is authoritative.
2. **`supabase/postgres` changed base OS, and that is the larger change.** Ubuntu 20.04 → Alpine
   3.23, Nix-built, `postgres` moving from 105:106 to **100:101**. `fsGroup` must become `101` in
   [values.yaml:229](../deploy/helm/aber/values.yaml#L229),
   [ci.yml:734](../.github/workflows/ci.yml#L734) and
   [backup-cronjob.yaml:129](../deploy/helm/aber/templates/jobs/backup-cronjob.yaml#L129),
   and every comment describing this image as Debian is now false —
   [values.yaml:224](../deploy/helm/aber/values.yaml#L224),
   [ci.yml:720](../.github/workflows/ci.yml#L720),
   [backup-cronjob.yaml:126](../deploy/helm/aber/templates/jobs/backup-cronjob.yaml#L126).
   The two databases are now **both** Alpine, which retires the "different lineage" note at
   [values.yaml:224](../deploy/helm/aber/values.yaml#L224).
3. **The locale provider changes from libc to ICU.** Harmless here because volumes are recreated
   empty — collation changes only corrupt *existing* indexes — and `asset_id` is ASCII
   (`dev` + hex). It can reorder `ORDER BY` on free-text device and cell names in edge cases. Worth
   one line in the divergence notes, not a phase.
4. **`retention.sql` and `aggregates.sql` need no changes for 2.29.1.** The legacy compression API
   still works and now answers in columnstore vocabulary — `remove_compression_policy` reports
   "columnstore policy not found", confirming the internal rename. Compression enables, all four
   retention policies and three refresh policies register, and a second run is clean. Phase 4 stays
   optional modernisation.

**Gate result: PASSED** for what it asked. Phase 2 may proceed.

### What this gate MISSED, recorded so the next one asks better

Phase 2 hit three failures this table did not predict, and they share a shape: it checked what the
image **has** (users, distro, extensions, function signatures) and never checked what the image
**pre-configures**. The database image is not only a set of binaries, it is a set of defaults, and
the defaults moved further than the version did.

| Missed | Symptom |
|---|---|
| `pgjwt` shipped but **not created** | 0006 self-check: "pgjwt (extensions.sign) is not installed" — five migrations after the real cause |
| `storage` stub tables gone | 0001 aborts: `relation "storage.objects" does not exist` |
| Grants on `storage.*` gone | storage-init: `400 new row violates row-level security policy`, real cause a 42501 nested in the payload |
| `postgres` not owner of storage tables | `must be owner of table objects` |
| `postgres` not owner of the `auth` schema | CI only, after merge: `permission denied for schema auth` bootstrapping the GoTrue helper functions |

**`postgres` IS NOT A SUPERUSER ON 17.6, and that single fact caused three of the five.** Only
`supabase_admin` is. Anything this stack does that creates or alters objects in a schema owned by
one of the scoped admins — `storage` (supabase_storage_admin), `auth` (supabase_admin) — must
connect as `supabase_admin`. Ordinary DML and the migrations themselves still run as `postgres`,
verified against 17.6.1.160 rather than assumed.

A future image bump should add: **which extensions are CREATED (not merely available), which
schemas arrive populated, and what is granted on them** — `\dx`, `\dt <schema>.*` and
`information_schema.role_table_grants`, diffed old tag against new. All three misses would have
been caught by that diff in about a minute, before any of them cost a boot cycle.

## Phase 1 — Remove the `pgjwt` dependency (`0011`, runs on PG15) — OPTIONAL

**Phase 0 demoted this from blocker to hardening**, and it no longer gates Phase 2. `pgjwt 0.2.0`
ships in `supabase/postgres:17.6.1.160` and signs correctly. What remains true is that Supabase has
*documented* it as deprecated for Postgres 17 and removed it from the hosted platform, so the image
retaining it is a reprieve rather than a reversal — this is a dependency with an announced end.

Do it on its own schedule. The one piece of this work that is **fully testable before any image
moves**, and the argument for doing it sooner is that the acceptance test below gets harder the day
the reprieve ends.

Replace `extensions.sign()` with a local HS256 signer. The idiom already exists in the tree:
[0002:2292](../supabase/migrations/0002_seed_data.sql#L2292) and
[0006:76](../supabase/migrations/archive/0006_nodered_oidc_auth.sql#L76) already build base64url digests via
`extensions.digest`, so `pgcrypto` is present and the encoding dance is already written. The signer
is `extensions.hmac(...)` plus the same `rtrim(translate(encode(...), '+/', '-_'), '=')`.

- `0011` defines the signer and redefines `dispatch_device_quarantine_webhook()` to call it.
- Rewrite the self-check at [0006:263](../supabase/migrations/archive/0006_nodered_oidc_auth.sql#L263) to
  assert the *new* function. The guard's purpose is unchanged: an unsigned webhook fails silently
  hours later, at a quarantined device, which is the worst possible place to discover it.
- Run `node scripts/sync-helm-chart-files.mjs`.

**Acceptance:** the emitted token is **byte-identical** to what `extensions.sign()` produced for the
same claims and key. That is the whole test — `settings.js` in Node-RED verifies it, and if the wire
format matches there is nothing to change at the consumer. Verify by generating both on a PG15
container where `pgjwt` is still present and comparing strings, before `pgjwt` is gone and the
comparison is impossible.

**Why it ships alone:** it is worth doing even if the rest of this plan is abandoned. It removes a
dependency Supabase has walked away from, and the existing `edge-function-auth-test` CI job runs on
PG15 today, so it proves out on the current stack with no new infrastructure.

## Phase 2 — Both targets to PG17 (one commit) — ✅ COMPLETE (2026-08-10)

**Verified on the Compose target from empty volumes.** `supabase-db` reports 17.6, `timescaledb`
reports 17.10 with TimescaleDB 2.29.1, every init service exits 0, and:

- `ingestion/validate.py` — **passes end to end** (telemetry, rename safety, alias resolution,
  node-scoped aliases, rebirth request and rate limit, quarantine gating, directory, i3X live
  values, RLS scoping, anon privilege baseline).
- `test_aas_export.py` — **58/58 pass**, including validation against the official IDTA schema and
  the 3D model upload, which exercises the new storage grants end to end.
- Realtime completes the WebSocket upgrade through Kong (`101 Switching Protocols`); publication
  is scoped to `cells`/`devices`/`gateways`; `wal_level = logical`. The replication slot is created
  lazily on first subscribe, so its absence with no client attached is expected, not a fault.
- **The backup CronJob's constraint tested directly**: `pg_dump` from the `supabase/postgres` image
  (17.6) successfully dumps the historian (17.10) and its own server. Different PATCH levels across
  the two images are fine — `pg_dump` caps at major — but it is worth knowing they differ, because
  it is the same axis that would break at the next major divergence.

Three things had to change beyond the pins; all are Phase 0 misses, tabulated above.

### The four fixes Phase 2 actually required

1. **`CREATE EXTENSION pgjwt`** added to 0001's extension block. It was never declared because
   Supabase created it by default up to PG17; the image still ships it but no longer creates it.
   Declaring it is an improvement independent of version, and it reduces Phase 1 to a two-line
   change.
2. **Storage RLS moved out of 0001** into `supabase/storage-policies.sql` — see that file's header
   and the service/Job that apply it.
3. **Storage grants written explicitly**, because the stub used to bring them. The result is
   *tighter* than PG15 ever was: `anon` previously held DELETE on `storage.buckets` at the grant
   layer with RLS as the only guard.
4. **Applied as `supabase_admin`, not `postgres`** — the storage tables are owned by
   `supabase_storage_admin`, and `postgres` is neither superuser nor a member of it.

### Ordering, which is the part worth remembering

`supabase-storage` (healthy) → **`supabase-storage-policies`** → `supabase-storage-init`. The
policies must precede bucket creation, because storage-api serves that call by assuming
`service_role`, which holds nothing until the grants land. Helm hook weights: db-init 10,
**storage-policies 18**, storage-init 20.

---

### Original scope, for reference

The parity check forces Compose and Helm into a single change. With no data anywhere, this is pins
plus `docker compose down -v` — the entire upgrade, in one step, exactly as intended by doing it now.

**Pins:**

- `docker-compose.yml:49`, `:87` →
  `timescale/timescaledb:2.29.1-pg17`
- `docker-compose.yml:130`, `:151`,
  `:168` → `supabase/postgres:17.6.1.160`
- [values.yaml:147](../deploy/helm/aber/values.yaml#L147) and
  [:217](../deploy/helm/aber/values.yaml#L217) → the same two
- [ci.yml:854](../.github/workflows/ci.yml#L854) service pin

**Facts that move with them:**

- **`fsGroup` for `supabase-db`: 106 → `101`**, per Phase 0, in three places —
  [values.yaml:229](../deploy/helm/aber/values.yaml#L229),
  [ci.yml:734](../.github/workflows/ci.yml#L734) and
  [backup-cronjob.yaml:129](../deploy/helm/aber/templates/jobs/backup-cronjob.yaml#L129).
  TimescaleDB stays at 70. Miss the CronJob one and a restore Job cannot read what the backup wrote.
- **Every comment calling `supabase/postgres` Debian is now false** — it is Alpine 3.23. Correct
  [values.yaml:224](../deploy/helm/aber/values.yaml#L224),
  [ci.yml:720](../.github/workflows/ci.yml#L720) and
  [backup-cronjob.yaml:126](../deploy/helm/aber/templates/jobs/backup-cronjob.yaml#L126). The
  "not the same lineage as TimescaleDB" note at values.yaml:224 is now backwards: both are Alpine.
- The comment at [values.yaml:145](../deploy/helm/aber/values.yaml#L145) currently says the
  tag is "pinned to match docker-compose.yml". Replace it with the reason it is now pinned rather
  than floating: **2.28.x was the end of the PG15 line, `latest-pg15` is frozen, and a floating tag
  hid that for a month.** That is the sentence worth leaving behind.
- [backup-cronjob.yaml:134](../deploy/helm/aber/templates/jobs/backup-cronjob.yaml#L134)
  should state the constraint these pins create: the historian's major version is capped by
  Supabase's, and that is why the historian is on pg17 and not pg18.
- Version prose: [README.md:248-261](../README.md#L248),
  [0001:24](../supabase/migrations/0001_baseline_schema.sql#L24),
  [0001:404](../supabase/migrations/0001_baseline_schema.sql#L404).

**Gate — all of these green from empty volumes, on both targets:**

1. Every migration `0001`–`0010` applies clean on 17.6 (plus `0011` if Phase 1 has landed).
2. The Compose e2e job and the `k8s-validation` job both pass.
3. The quarantine webhook signs and Node-RED accepts the token.
4. AAS export produces a schema-valid shell.
5. `postgres_fdw` reads across the link: the foreign table at
   [0001:1190](../supabase/migrations/0001_baseline_schema.sql#L1190) and the rollup views `0010`
   maps, whose self-check already exercises exactly this.
6. Realtime creates its logical slot and the dashboard receives changes.
7. `timescaledb-maintenance` reconciles compression, retention and all three rollups against a
   2.29.1 hypertable.

## Phase 3 — Take the free wins (no schema change) — ✅ COMPLETE (2026-08-10)

- **The `= ANY` improvement — MEASURED, and the predicted mechanism was wrong.**

  The claim in this plan was that PG17 collapses `= ANY(array)` into a single btree scan instead
  of one per value, and that `telemetry_gapfill()`
  ([aggregates.sql:341](../timescaledb/aggregates.sql#L341)) would benefit because its `obs` CTE is
  built on `asset_id = ANY($3::text[])`. **That is not what the plans show.** Both majors put
  `= ANY` in the same `Index Cond` on `idx_telemetry_asset_metric_time` and touch essentially the
  same buffers (61,303 vs 61,220) — the scan is not the difference.

  The difference is the SORT, and it is structural:

  | | Append node | Sort | Temp blocks |
  |---|---|---|---|
  | PG15.18 + TS2.28.3 | `ChunkAppend` | `Sort` → **external merge, 4808 kB** | read 601 / written 602 |
  | PG17.10 + TS2.28.3 | `ConstraintAwareAppend` + `Merge Append` | `Incremental Sort`, quicksort, 59 kB peak | **none** |
  | PG17.10 + TS2.29.1 | `ConstraintAwareAppend` + `Merge Append` | `Incremental Sort`, quicksort, 59 kB peak | **none** |

  PG17 returns chunk rows already ordered by `(asset_id, metric_name)` through `Merge Append`,
  which lets `Incremental Sort` finish the job in memory. PG15 sorts the whole result and spills
  to disk.

  **Attribution: PostgreSQL 17, not TimescaleDB 2.29.** The middle row isolates it — the same
  TimescaleDB 2.28.3 spills on PG15 and does not on PG17. `work_mem` (7794 kB), `shared_buffers`
  and `enable_incremental_sort` were identical across all three; PG15 has incremental sort
  available and cannot use it, because `ChunkAppend` does not present sorted input.

  Wall clock, best warm run of six, three passes, 960k rows / 300 assets × 8 metrics / 50-asset
  subset: **PG15 116–140 ms, PG17 100–114 ms.** Directionally consistent every pass, but the
  spread between passes is wide enough on a Docker Desktop VM that the honest figure is "roughly
  10–20% here", not a precise number. TS2.28.3 vs 2.29.1 on PG17 is within that noise, as the
  identical plans predict.

  **The structural result is the one that matters, and it scales the wrong way for PG15**: the
  spill grows with window width and series count, so a bigger query makes PG15 worse while PG17
  stays in memory. The 4.8 MB spill here is a floor, not a typical case.
- **`pg_stat_io` (PG16) and `pg_stat_checkpointer` (PG17) — DONE.** A
  *Historian I/O & Checkpoints* row in
  [acs-cymru-overview.json](../grafana/provisioning/dashboards/platform/stack-ingestion-health.json):
  shared buffer hit ratio, blocks read from disk, **requested checkpoints**, average checkpoint
  write time, and a `pg_stat_io` breakdown by backend type and context.

  `Requested Checkpoints` is the one worth watching. Timed checkpoints are the healthy path; a
  requested count climbing beside them means `max_wal_size` is too small for the write rate, so
  the historian checkpoints on ingest bursts instead of on a schedule. PG15 could not report it —
  `pg_stat_bgwriter` conflated the counters that `pg_stat_checkpointer` separates.

  **These are cumulative counters, not rates**, so they are `stat` and `table` panels rather than
  time series: the views carry no time column, and a SQL datasource charting them would plot one
  point per refresh with no history. Reading them as levels since `stats_reset` is the honest
  presentation. A rate would need a scraper this stack does not run.

  Verified against the running historian and through Grafana's own `/api/ds/query` proxy — all
  five queries return data (hit ratio 99.75%). `sync-helm-chart-files.mjs` mirrors the dashboard
  into the chart, so it is edited once.

Explicitly **not** taken, so nobody re-derives it: `JSON_TABLE` has nothing to shred — no migration
uses `jsonb_array_elements`. `MERGE ... RETURNING` must not touch the historian write, which is
deliberately `ON CONFLICT DO NOTHING` with a test asserting that literal SQL
([test_rbe_telemetry.py:348](../ingestion/test_rbe_telemetry.py#L348)) because an upsert would let a
publisher rewrite history. `COPY ... ON_ERROR ignore` needs a bulk backfill path that does not exist.

## Phase 4 — Hypercore / columnstore — ✅ COMPLETE (2026-08-10)

Independent of the PostgreSQL bump — 2.18+ is enough and even 2.28.3 qualifies — but deliberately
last, because it touches the boot-critical destructive path and does not belong inside a version
migration.

### The API migration is not just a rename

`retention.sql` now uses `add_columnstore_policy()` / `remove_columnstore_policy()`. Two differences
mattered more than the names, both found by running it rather than reading about it:

1. **The new entry points are PROCEDURES, not functions.** `add_columnstore_policy`,
   `remove_columnstore_policy`, `convert_to_columnstore` and `convert_to_rowstore` all require
   `CALL`; `PERFORM` fails with *"... is a procedure / HINT: To call a procedure, use CALL."* The
   legacy `add_compression_policy` / `remove_compression_policy` / `compress_chunk` /
   `decompress_chunk` remain functions. Since `retention.sql` drives everything from inside one
   `DO` block, this is a rewrite of the call convention, not a substitution. `CALL` was verified to
   work there, including alongside the inner `EXCEPTION` handler that parses the intervals.
2. **The options lose their prefix and gain an enable flag**: `timescaledb.compress` →
   `timescaledb.enable_columnstore = true`, `compress_segmentby` → `segmentby`, `compress_orderby`
   → `orderby`.

**What did not change, checked rather than assumed:** the job still reports as `policy_compression`
in `timescaledb_information.jobs` with `compress_after` in its config, and hypertable state is still
`compression_enabled` in `timescaledb_information.hypertables`. There is no columnstore-named
equivalent of either, and a rename there would have silently broken the guard in `retention.sql`.

Verified three ways: clean install on a fresh hypertable, a second run for idempotency, and — the
one that matters — **applied over a database already carrying the legacy `timescaledb.compress`
settings and an `add_compression_policy` job**, with a changed interval, which took effect. That is
the upgrade path every existing deployment takes on its next boot.

> **That verification assumed the extension actually updates, and for a long time it did not.**
> Nothing in the repository ran `ALTER EXTENSION timescaledb UPDATE`, so a stack pinned to
> `2.29.2-pg17` was measured running extension `2.29.1` — the binaries upgraded, the definitions
> not. Closed by [`timescaledb/extension.sql`](../timescaledb/extension.sql), which the maintenance
> path applies before anything that touches this API surface, and which fails rather than proceeding
> when the image and the database still disagree.

### The read-only claim was FALSE, and was already false before this upgrade

[values.yaml](../deploy/helm/aber/values.yaml) claimed *"compressed chunks are effectively
read-only, so telemetry timestamped older than this is rejected rather than inserted."* Measured on
2.29.1, against a row placed provably inside a compressed chunk:

| Operation on a compressed chunk | Result |
|---|---|
| plain `INSERT` | **succeeds** |
| `INSERT ... ON CONFLICT (time, asset_id, metric_name) DO NOTHING` (ingestion's exact form) | **succeeds** |
| the same against an existing key | correctly inserts nothing — **the unique constraint is enforced against compressed data** |
| `UPDATE` | **succeeds** |
| `DELETE` | **succeeds** |
| chunk afterwards | **still compressed** |

**This is not a Hypercore change.** The identical test passes on 2.28.3 with the legacy compression
API — the version this stack ran before. The note had simply outlived the behaviour it described.

The operational consequence is what matters: **`compressAfter` does not bound the late-arrival
window and never did on any version this stack has run.** The only bound is
`TELEMETRY_MAX_AGE_SECONDS` (24h) in the ingestion daemon. Widening `compressAfter` does not widen
the accepted window; narrowing it does not close it.

[aggregates.sql:167](../timescaledb/aggregates.sql#L167) is unaffected and needed no change — it
already sizes the 25-hour rollup refresh window against ingestion's 24h limit, not against
compression. The reasoning there was right for the right reason.

*A first attempt at this test proved nothing: a row "10 days old" landed in an UNCOMPRESSED chunk,
because a 7-day `compressAfter` with 7-day chunks leaves the 7–14 day chunk uncompressed. The
target timestamp has to be selected from `timescaledb_information.chunks WHERE is_compressed`, not
assumed from its age.*

---

## Definition of done — applies to every phase

- Both deployment targets moved together. `check-image-tag-parity.mjs` is not a formality: several
  of these pins hold a coupling, and a target bumped second fails looking like its own fault.
- Every version number stated in prose matches the pins.
- `node scripts/sync-helm-chart-files.mjs` run after any migration, dashboard or `timescaledb/`
  change.
- No fact asserted from a changelog. Phase 0's table is the source for image properties.

## Sequencing

| Phase | Depends on | Ships alone | Runs on |
|---|---|---|---|
| 0 — Verification gate | — | ✅ complete | either |
| 1 — Remove `pgjwt` (`0011`) — **deferred** | 0 | **yes** | PG15 or PG17 |
| 2 — Both targets to PG17 | 0 | yes (one commit, both targets) | PG17 |
| 3 — Free wins | 2 | ✅ complete | PG17 |
| 4 — Hypercore | 2 | ✅ complete | either |

**Phase 2 no longer depends on Phase 1** — that edge existed only because `pgjwt` was believed to be
missing. Phase 1 is now independent of everything and can land before, after, or never. Phase 2 is
the gate that decides whether 3 and 4 proceed.

Take Phase 3's baseline measurement **before** Phase 2, while a PG15 volume with seeded telemetry
still exists — and note the running stack is currently that volume.

## Rollback

Every phase is an ordinary `git revert` plus `docker compose down -v`. There is no data format to
migrate back, no `data.bak.pg15` to retain, and no outage window to schedule. **This is the entire
argument for doing the upgrade now rather than after the first shopfloor deployment**, and it is
worth stating plainly because it will not be true a second time.
