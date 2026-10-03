# The historian's maintenance

The SQL in this directory is applied to the historian on every boot by the chart's maintenance
hook Job (`deploy/helm/aber/templates/jobs/timescaledb-maintenance.yaml`), from a mirror the sync
script keeps byte-identical to these files. [`init/`](init/) holds the one script the postgres
entrypoint runs, on an empty data directory only. The tests beside the SQL (`test_*.py`) assert
the roles' reach and the extension version against a running stack.

Each file states what it does. This document holds the reasoning: why the files run in the order
they do, the conventions they share, and the argument and evidence behind each decision. A line in
one of them that looks wrong should be checked here before it is changed.

## Why on every boot, and in this order

**Every boot, because initdb never reaches an existing database.** The postgres entrypoint runs
`init/` on an empty volume only, so a policy defined there could never change on a running stack.
Reconciling on every boot means the value in `values.yaml` is the policy. TimescaleDB's own job
scheduler is used rather than pg_cron, which runs inside the platform database and reaches this
one only over the read-only FDW link.

**Values arrive as psql variables, not rendered into the SQL.** The Job passes `-v name=value`
so the chart's copies stay byte-identical to these files, with the sync check behind them. Inside
a file, `SELECT set_config('aber.<name>', :'name', false)` hands each variable to PL/pgSQL as a
GUC: psql interpolates `:'var'` while lexing and does not descend into dollar-quoted strings, so a
`DO` block cannot read the variable directly.

**The order, and what each position protects:**

1. **`extension.sql`**, first and in its own psql session. `ALTER EXTENSION timescaledb UPDATE`
   is refused once a connection has loaded the old version's library, so it cannot be appended to
   another file, and everything after it uses the API surface it updates.
2. **`statistics.sql`**, only when `databaseMetrics.enabled` and `databaseMetrics.statementStats`
   are both on. Gated on the same flag as the preload argument because the two halves are one
   decision: with the flag off the StatefulSet drops the library, and creating the extension would
   leave a view that raises on every read.
3. **`retention.sql`**, with the chunk interval, compression and retention values.
4. **`aggregates.sql`**, when `timescaledb.rollups.enabled`, with the three rollup retentions and
   `rollups.compressAfter`.
5. **`storage.sql`**, between `aggregates.sql` and `roles.sql`, and both halves are load-bearing:
   it reports on the rollups, so they must exist, and `roles.sql` grants on the view it creates.
   Run out of order the failure is an empty data-lifecycle panel on a fresh volume only, which is
   why `roles.sql` asserts the view exists rather than leaving it to be noticed.
6. **`cold_archive.sql`**, between `storage.sql` and `roles.sql`, because `roles.sql` guards its
   manifest grants on the table existing, and running the archive file after it would push those
   grants to the second boot. It takes no variables: every threshold cold archival reads lives in
   `system_settings` in the platform database and is re-read on each pass, which is what makes
   `archive.enabled` a control rather than a deploy-time decision. It is not inside the rollups
   conditional, because it touches no rollup, and the platform's archive self-check treats a
   reachable historian with no manifest as a mismatch.
7. **`physical_backup.sql`**, before `roles.sql`, which grants the exporter SELECT on the table
   it creates. It takes no variables and runs whether or not `timescaledb.physicalBackup` is on,
   and with the rollups off as well, because the backup sidecar waits for its table before the
   first backup and would otherwise wait forever.
8. **`roles.sql`**, last, because it grants on what every file above creates. Run first it fails
   with "relation telemetry_1h does not exist", and only on a fresh volume, which is the worst kind
   of ordering bug because every stack that already has the rollups passes. An empty BI password
   makes it skip a role rather than create one with a blank secret, so it needs no `if`.

**First-boot guards.** Several grants in `roles.sql` are wrapped in `IF to_regclass(...) IS NOT
NULL`, because on a fresh volume the object is created by a file that runs later in the same pass
or was once ordered that way; the grant then lands on the second boot. The exceptions are the
things `roles.sql` asserts instead: `storage_footprint` must exist, and the message says which
file did not run or ran late.

## `extension.sql`

**Why it exists.** Bumping the image tag upgrades the binaries and leaves the SQL-level extension
where it was, because nothing runs `ALTER EXTENSION ... UPDATE`. Postgres then loads the versioned
library matching the installed version, so the database goes on running the older release's
definitions inside the newer image, indefinitely and with nothing anywhere saying so. Measured on
a healthy stack before this file existed:

```
     name      | default_version | installed_version
 --------------+-----------------+-------------------
  timescaledb  | 2.29.2          | 2.29.1
```

`default_version` is what the image ships; `installed_version` is what the database is running.
The gap was the defect, and it widened on every bump.

**Why first, and why its own session.** `docs/postgres-17-migration-plan.md` records what the API
surface can do across a version boundary: compression became columnstore, the entry points became
procedures requiring `CALL`, and the options changed shape. Verifying an upgrade path over a
database carrying the legacy settings assumes the extension updates at all, and that is what this
file guarantees before any of the others run.

**Idempotent, and quiet when there is nothing to do.** An extension already at `default_version`
draws a NOTICE and no work. On a fresh volume `init/` creates the extension at the image's own
version, so this is a no-op there by construction.

**And then it asserts the update took**, because the whole defect was that nobody was looking. A
successful `ALTER` that leaves the versions apart is not a state to carry on from, so the Job fails
and the upgrade with it. The message names the remedy for each way of arriving: if the image is
newer, the update did not take and the container needs a restart so no session holds the old
library; if the database is newer, the tag was rolled back below the installed extension, and an
extension cannot be downgraded, so the matching tag has to be restored. `docs/upgrades.md` says
what bumping the tag is expected to do.

## `statistics.sql`

**Why the historian needs it and the platform database does not.** `supabase/postgres` preloads
`pg_stat_statements`; the timescale image preloads `timescaledb` alone. So the historian was the
half with no server-side view of how long a write actually took.

**What it answers.** `aber_ingestion_write_seconds` measures a telemetry write from the client and
was the instrument that retired horizontal ingestion scaling as a roadmap item. It cannot
distinguish a slow disk from lock contention from a saturated pool, and the single-writer ceiling
is argued on exactly that distinction. These are the server-side series that can.

**Two halves.** `shared_preload_libraries` is a postmaster setting only the server's own command
line can set, so the chart appends `pg_stat_statements` beside `timescaledb` under
`databaseMetrics.statementStats`. This file creates the SQL-level extension, which the first half
does not imply. If the library is not loaded, an operator running this by hand against a server
started without it, creating the extension succeeds and every read of the view then raises; the
file checks first and says which half is missing rather than leaving that to a dashboard.

**No grant.** The view is world-readable, and whose statements a caller sees is decided by
`pg_monitor` rather than by a table privilege: without it a role sees only its own.
`metrics_reader` holds `pg_monitor` (`roles.sql`), which is what makes the exporter's view of it
complete.

## `retention.sql`

**The raw window is a table, not a setting.** `telemetry_raw_window` is one row: `raw_window`
(NULL keeps raw telemetry indefinitely), written from `timescaledb.retention.retainFor`, and
`archive_armed`, which the cold archiver reports on every run from the platform's
`archive.enabled`, a value this database cannot read. Until the archiver reports, it is false.
`cold_archive_report_armed()` is the archiver's only write here, `SECURITY DEFINER` so
`ingest_writer` can report without holding UPDATE on the window it must not change.

**Retention is a custom job, not `add_retention_policy()`.** TimescaleDB's policy drops on a timer
with no knowledge of the archive, and whether archiving is on is decided at runtime on the Cold
Storage page. `telemetry_raw_retention()` drops the oldest run of chunks that ended more than
`raw_window` ago and stops at the first one it may not drop: always, a chunk whose export is in
flight (a manifest row not yet verified); while archiving is armed, any chunk with no verified
manifest row. So an archive outage grows the volume, which the *Archive Backlog* alert reports,
instead of the window deleting what was never exported. Verified rows are stamped `dropped_at` in
the same transaction as the drop, as `cold_tier_drop_verified()` does. The manifest is read
dynamically because `cold_archive.sql` creates it after this file on a first boot. The old
TimescaleDB policy is removed on every boot so an upgraded stack converges.

**Parse first, act second.** A typo in either interval must stop the boot with a message naming
the setting, not leave the stack running with one policy applied and the other silently absent.
Several spellings of "no policy" are accepted (`never`, `off`, `disabled`, `none`, `false`, `0`)
because the value is typed into a `.env` file by hand, and a rejected synonym would take the boot
down.

**Chunk interval.** Compression never touches the open chunk, so its span plus `compress_after`
is the raw data held uncompressed whatever the policy says. `set_chunk_time_interval()` applies to
chunks created afterwards; existing chunks keep the span they were made with.

**Columnstore, through the current API.** `segmentby = asset_id, metric_name` compresses one
series together, matching how the dashboard queries; `orderby = time DESC` matches the query order
and the supporting index. The columnstore API (TimescaleDB 2.18+) is used rather than the legacy
compression one: the entry points are procedures reached with `CALL` (`PERFORM` fails), and the
options are `enable_columnstore`, `segmentby`, `orderby`. The job still reports as
`policy_compression` and the hypertable state as `compression_enabled`, which the guard in the
file and the CI assertions read. The `SET` is issued only when compression is not yet enabled,
because re-issuing it with different `segmentby` columns raises once compressed chunks exist.

**Policies are removed and re-added, not `if_not_exists`.** With a policy already present at
different arguments, `add_*` emits a notice and does nothing, so a changed setting would appear to
apply and would not. The same reasoning is applied in `aggregates.sql`.

**Turning compression off leaves compressed chunks compressed.** Decompressing a history that may
be hundreds of gigabytes, unprompted, during a boot, is not something a configuration change
should do; off means "stop compressing new chunks".

**A retention shorter than compression is a warning, not an error.** Chunks would be dropped
before they were ever compressed, which is legal and almost certainly a mistake, but it is the
operator's data and the configuration does exactly what it says.

**`assets` is deliberately not covered.** It is small, holds one row per device, and
`telemetry.asset_id` references it; dropping an asset row would orphan history that has not aged
out.

## `aggregates.sql`

**Why rollups.** `public.telemetry` in Supabase is a postgres_fdw projection, and the wrapper
pushes WHERE down but not LIMIT. The rollups serve trend queries (Grafana reads this database
directly and never crosses the FDW); `telemetry_latest` serves latest-value lookups. The CSV export
reads raw by default, because it is an export of observations, but may be asked for a rollup
instead, which is the only way to export a period the raw retention window has already dropped
(#160); `telemetry_horizons` is how it knows which resolutions still cover a range.

**`telemetry_latest` is a plain view, evaluated here.** A view on this side is evaluated on this
server, so Supabase receives one row per metric instead of a day of rows to discard. `DISTINCT
ON` is served by `idx_telemetry_asset_metric_time`, so the fleet-wide case is bounded by series
count rather than time window. Not a continuous aggregate: "the newest row" is not an aggregate
over a bucket.

**The rollups store SUM and COUNT, not AVG.** The 5m view is built from the 1m view and the 1h from
the 5m, and avg(avg) is wrong when buckets hold different numbers of samples; presentation views
compute `sum_double / NULLIF(n_double, 0)`. MIN and MAX are kept because the excursion is the
signal. `val_string` and `val_bool` are carried as `last()`: they are state metrics the alert
rules read. The views are created `WITH NO DATA` so a boot does not backfill years synchronously;
the refresh policy backfills in bounded increments. Real-time aggregation is on
(`materialized_only = false`) so a query sees the current bucket by unioning the materialised part
with the raw tail; without it a live dashboard trails by up to one schedule interval.

**`telemetry_horizons` reports what is there, not what the policy promises.** `retention.sql`
and the rollup policies say what will eventually be dropped; they say nothing about a stack
installed three weeks ago, which holds three weeks of raw whatever `retain_after` is set to. A
reader deciding "will this range come back empty?" needs the first, and only the database can
answer it. It is created after the rollups because it reads them: on a fresh historian they do not
exist until that section has run, and a view over a missing relation fails the whole Job
(`docs/incidents.md`). It is evaluated here for the reason `telemetry_latest` is: four rows cross
the FDW instead of the scan the Supabase side would need, and `ORDER BY time LIMIT 1` over the
projection is not an alternative because LIMIT is not pushed down. Each `min()` is an index scan
per chunk (MergeAppend over the per-chunk time indexes), so the cost is the chunk count, not the
row count.

**Refresh policies.** `start_offset` is 25 hours because the refresh window must exceed the
late-data window: ingestion accepts telemetry up to `TELEMETRY_MAX_AGE_SECONDS` (24h) old, and a
smaller offset would leave late arrivals in raw and in no rollup. It is cheap despite the width,
because TimescaleDB refreshes only the buckets its invalidation log marks as changed.
`end_offset` is one full bucket, so the policy never materialises a bucket still being written to;
real-time aggregation serves that bucket meanwhile. The 1h view refreshes on a five-minute
schedule, not hourly: its `end_offset` still holds back the incomplete bucket, so this costs
little and means a dashboard on the hourly rollup is never an hour stale. Rollup retention outlives
raw: `retention.sql` drops raw chunks (after 14 days by default, `timescaledb.retention.retainFor`)
while these keep shape, excursions and
state transitions far longer at a fraction of the size.

**The rollups are compressed, and their chunk span is set.** `rollup_compress_after`
(`timescaledb.rollups.compressAfter`, 2 days) must be longer than the 25-hour `start_offset`: a
compressed bucket can still be refreshed, but compressing inside the refresh window would rewrite a
chunk on every refresh, so the file refuses a shorter value. The columnstore is segmented by
`asset_id, metric_name` as the raw hypertable is, so a dashboard's one-series read decompresses one
segment; a continuous aggregate's default segmentby is empty. It is set once, because re-issuing it
raises once compressed chunks exist, and turning the policy off leaves chunks already compressed as
they are. Each rollup's chunk span is set rather than inherited: TimescaleDB gives a continuous
aggregate ten times the raw chunk interval at its creation, which was 70 days on a stack older than
the sized raw chunks, and a chunk is compressed only once all of it is older than `compressAfter`.
The spans (1 day, 7 days, 30 days) put about a day of rows in a one-minute chunk at any fleet size;
a wider chunk already open keeps its span until it closes. The variable is optional, so a caller
that predates it leaves the rollups uncompressed. What compression measured is in
`deploy/k8s/README.md`.

**`telemetry_gapfill()` carries the last observation forward.** Under report-by-exception a metric
that has not changed publishes nothing, so the aggregates emit one bucket in sixty for a steady
machine, and a gap means "unchanged", not "unknown". LOCF cannot live in the continuous aggregate
(TimescaleDB rejects gapfill inside a continuous definition, and filling is relative to a query
window). Nor does the function use `time_bucket_gapfill()`: that expands groups a query already
produced and cannot invent a series that returned no rows, which is exactly the case of a silent
device. The grid is built from the series list first and observations are joined onto it: the
series come from `telemetry_latest` (the ones silent throughout the window, which is the whole
point) unioned with any series whose raw history has been aged out but which still has rollup
buckets in range. The LOCF is the standard gaps-and-islands form in plain SQL. Source resolution
follows the bucket: the widest rollup no coarser than the bucket asked for, and raw only below one
minute. Each series is seeded with one lookup strictly earlier than the window, so a long silence
still fills. Buckets are aligned to the epoch, the grid `time_bucket()` uses, so a window that
opens mid-bucket still lines up with the rollup it reads from. `is_carried` distinguishes a
carried value from an observed one, so an alert rule can refuse to fire on a reading nobody took.

## `storage.sql`

**A view rather than a Grafana query.** `hypertable_detailed_size()` takes one hypertable and a
continuous aggregate must be resolved to its materialisation hypertable first;
`hypertable_compression_stats()` raises on a hypertable with no compression policy, which is a
supported configuration; and postgres_fdw maps relations, not function calls. The view reports
bytes and horizons, never readings, which is what makes it safe to expose to a dashboard role that
may not read the historian's contents.

**The collector is `SECURITY DEFINER` and returns byte counts only**, so neither reader role has
to be widened to the hypertables. It is `STABLE`: it reads catalogs and writes nothing. PostgreSQL
grants EXECUTE to PUBLIC on creation, which let every role that can connect call it,
`powerbi_reader` included; the file revokes that on every boot and `roles.sql` grants it to the
roles that read the footprint.

**Two tiers, two opposite philosophies.** Hypertables are resolved through
`timescaledb_information.continuous_aggregates` rather than by guessing names. Plain tables are
enumerated by catalog rather than named, so a table added later appears without anyone
remembering: a size report that misses a table is wrong, where `roles.sql`'s allow-list is the
opposite choice for the opposite reason. TOAST is split out of the plain tables' figure so the two
tiers add up the same way `hypertable_detailed_size()` does.

**Three details that were each found the hard way.** The compression columns stay NULL where
there is no policy, because "not compressed" and "compressed to zero bytes" must not render the
same. The size call is wrapped, because a hypertable dropped between the catalog read and the call
should cost one absent row rather than an erroring panel. And the compression figures are two
scalars rather than a second `record` variable, because a RECORD cannot be reset with `:= NULL`,
so an exception handler would leave the previous hypertable's figures in place.

**Horizons come from chunk boundaries.** `range_start` and `range_end` are catalog metadata, where
`min(time)` would scan the hypertable. The result is the span the chunks cover, a slight
overstatement of the span the data covers. `collected_at` is stamped on the view so a panel can
tell a stalled maintenance job from a cached foreign scan.

**The self-check selects from the view once.** It resolves lazily, so a broken column reference
is found now rather than in a panel, and the historian always has at least the telemetry
hypertable, so an empty result means the catalog queries match nothing, most likely a TimescaleDB
upgrade renaming an information view.

## `cold_archive.sql`

**The invariant, and what it can and cannot do.** Cold archival is the move: a chunk is written to
Parquet on object storage, read back and verified, recorded in the manifest, and only then dropped.
One CHECK constraint enforces the order, `dropped_at IS NULL OR verified_at IS NOT NULL`, and a
second says verification cannot precede the export it verifies, which is cheap to state and
catches an exporter that stamps its columns in the wrong order. The constraint cannot stop
`drop_chunks()` being called, only stop the lie being recorded, which is why
`cold_tier_droppable()` exists and the exporter is required to select through it. The manifest
lives here because chunks are here; the dashboard reads it over postgres_fdw.

**What each column is for.** The key is the chunk, not a surrogate id: a chunk is the unit that
is exported and dropped, TimescaleDB names them uniquely within a schema, and it makes "have we
already done this one" a primary-key lookup rather than a policy. The time range is copied at claim
time rather than joined, because once the chunk is dropped `timescaledb_information.chunks`
forgets it existed, and a manifest that could no longer say which month an object holds would be
a catalogue of opaque filenames. `row_count` is counted before the export and compared after; the
verification step re-reads the object and checks it, which is what makes `verified_at` mean
something. `object_etag` is whatever the backend returned, recorded rather than interpreted:
evidence for a human comparing two systems. `last_error` is set when an attempt fails and cleared
when one succeeds; a row that has been sitting with an error for a week is the thing an operator
needs to see, and deleting failed rows would hide exactly that. Until `dropped_at` is set the data
is in both places, which is the only safe intermediate state.

**Eligibility and safety are two functions.** `cold_tier_candidates()` returns only fully elapsed
chunks, bounded on `range_end` rather than `range_start`, because Sparkplug data arrives late
routinely; already-claimed chunks are excluded whole, failed ones included, since a retry is an
operator's decision made by clearing `last_error`. `cold_tier_droppable()` is the only supported
source for what `drop_chunks()` may be pointed at, so the rule lives beside the data it protects.

**The drop is `SECURITY DEFINER`, and drops a prefix.** `roles.sql` revokes DELETE and TRUNCATE on
`public.telemetry` from `ingest_writer`, and `cold_tier_drop_verified()` is the one narrow
exception, owned by the superuser, whose body is the rule. It drops a verified prefix, not a set:
`drop_chunks(older_than => X)` is a boundary and drops every chunk older than X, so calling it once
per verified chunk would delete never-exported chunks before it. TimescaleDB offers no "drop
exactly this chunk", so the boundary is computed by walking the chunks oldest-first and stopping at
the first that is not verified. The manifest rows are stamped first, inside the same transaction as
the drop: if the drop fails the stamp rolls back with it, and if the stamp fails nothing is
dropped. The one ordering that cannot happen is rows gone with no record of where they went.

**The self-check exercises the invariant rather than trusting it.** A constraint dropped by a
hand-edited database looks exactly like one never added. It probes that dropped-without-verified
and verified-without-exported are refused, and that the whole ordered sequence is accepted, because
a guard that admits nothing is as broken as one that admits anything and would stop archival dead
rather than loudly. The probe is rolled back, so no fictional chunk names land in the catalogue.

## `physical_backup.sql`

**The database's own copy of what pgBackRest did.** pgBackRest keeps the authoritative record in
the repository, where the exporter cannot reach it. The `pgbackrest` sidecar
(`pgbackrest/historian-backup.sh`) calls `physical_backup_record()` over the pod's socket after
every run, failed runs included, passing `pgbackrest info --output=json`. The function takes the
newest backup's label and sizes from that document, so a row records what pgBackRest actually took:
a differential asked for on an empty repository is recorded as the full it became. `check` rows
are the archive check the sidecar runs at start and are never counted as a backup.

**The exporter reads it, nothing writes to it but the sidecar.** EXECUTE is revoked from PUBLIC
because PostgreSQL grants it on creation; the sidecar connects as the superuser. Rows older than
90 days are deleted on each call, which bounds the table without a policy job. The alert's clock
falls back to the first recorded run, then to the server's start, so a stack that has just
switched backup on is not reported as a day late.

**The schedule is two questions the sidecar asks every minute.** `physical_backup_missed_slot()`
returns the latest daily slot at `hourUtc` when no `full`, `diff` or `incr` run started at or
after it, so a slot missed while the pod was down or the host was suspended is taken late, once.
A failed run is that slot's attempt: retrying on every check would fill the table with failures,
and reporting a failing backup is Historian Backup Stale's job. `physical_backup_type()` names the
type: full on `fullOn`, or whenever the repository's newest full stopped more than seven days ago,
so a missed Sunday does not leave differentials building on a full that `retainFull` can never
expire. Both are SQL rather than shell so `test_physical_backup.py` can ask them about any moment
in a rolled-back transaction; both are revoked from PUBLIC.

## `roles.sql`

**Each block is the authority on its role's reach.** Grants are re-issued and revokes re-issued
on every boot, so the file describes what the role can do now rather than how it was first set
up. Roles are CREATEd then ALTERed rather than dropped and recreated, because dropping fails while
any session is connected as the role, and ALTER also rotates the password on every boot. The
reader passwords default to empty so the file still runs against a caller that has not been taught
to pass them, and each such role then skips itself rather than being created with a blank
password; the writer and FDW passwords are required, because the only alternative credential for
those callers is the superuser.

### `powerbi_reader`

May read the three rollups and nothing else: not raw `telemetry`, not `telemetry_latest`, not
`assets`. A continuous aggregate is a view executed with its owner's privileges, so the reader
needs no privilege on `telemetry` even with real-time aggregation on. The allow-list names each
view rather than using `GRANT SELECT ON ALL TABLES IN SCHEMA public`, which would sweep in
`telemetry`, `assets` and every future table the moment it is created; the excluded objects are
revoked explicitly rather than merely left ungranted, and default privileges are revoked so future
tables do not become readable either. `test_bi_reader_grants.py` asserts both halves.

### `grafana_reader`

A second role rather than a wider `powerbi_reader`: Power BI is an external business tool that
should see aggregated buckets only, and Grafana is an internal console whose job is the raw
signal. Still read-only. It reads the rollups, raw telemetry, `telemetry_latest`, `assets`, the
archive manifest (every FDW session from the platform opens as this role, so without it
`cold_storage_rows()` fails inside a panel), `telemetry_gapfill()` (how a report-by-exception
series must be read), the storage footprint and its function, and `pg_monitor` for the I/O panels.
The footprint is not granted to `powerbi_reader`, because the size of the telemetry is an
operations question.

**`WITH INHERIT TRUE` is load-bearing, and it was missing.** PostgreSQL 16 moved inheritance onto
the grant, fixed from the member's `rolinherit` at grant time, and this role is NOINHERIT, so the
membership was recorded with `inherit_option = false` and did nothing. Measured: the role held the
membership, `pg_has_role(..., 'usage')` was still false, and none of the other backends' query
text was visible. The shipped `pg_stat_io` panel did not notice, because `pg_stat_io` is
world-readable; the next panel that genuinely needed `pg_monitor` would have returned empty.
`ALTER ROLE ... INHERIT` does not revise an existing grant, so the grant itself has to say so.

**EXECUTE on `storage_footprint_rows()` is a separate grant** because SELECT on a view does not
imply it: a function called in a view body is checked against the calling role.

### `metrics_reader`

The postgres_exporter sidecar, and the only role in the file with no password. That is its
security argument rather than an omission: `pg_hba` admits the network with `hostssl ...
scram-sha-256`, so a role with no password cannot authenticate from anywhere but loopback, where
`trust` matches. The exporter is a sidecar in this pod and reaches 127.0.0.1 through the shared
network namespace; nothing off the pod can present this role at all. That is what makes
`pg_monitor`, a role grant rather than the narrow views the Grafana reader gets, the proportionate
answer: broad over statistics and reachable from nowhere. The password is set to NULL on every
boot, not merely at creation, because a password set by hand would open the network path. The
role is INHERIT, unlike the others, and its `pg_monitor` grant carries `WITH INHERIT TRUE` for the
reason above; without it the exporter runs, reports `pg_exporter_last_scrape_error 0`, and
silently serves no WAL series at all, one of the figures the exporter was added to provide.

**The storage footprint is not covered by `pg_monitor`.** That grant reaches the server's own
statistics views and stops there; `public.storage_footprint` is a view in this database and needs
its own SELECT, plus EXECUTE on the function in its body. The exporter's custom queries read it,
and scraping it is what turns a point-in-time table into the growth rate an operator can alert on.
`public.physical_backup_runs` is granted the same way, guarded on the table existing, for the
backup clock the Historian Backup Stale alert measures from.

### `ingest_writer`

The ingestion daemon, the process most exposed to the plant network. The grant list is measured,
not reasoned: every line was determined by running the daemon's two statements as a probe role
and removing privileges until they broke. `assets` needs INSERT, UPDATE and SELECT; `telemetry`
needs INSERT and SELECT. SELECT is required because both statements carry `ON CONFLICT`, and
inferring the arbiter index needs SELECT on the target. So the role is append-only, not
write-only: it can add rows and cannot change or remove one, which the self-check asserts in both
directions. The hypertable grant reaches the chunks (verified by a probe insert failing a foreign
key named on a chunk). DELETE and TRUNCATE are the two revocations that make "append-only" true,
so they are named; the rollups are revoked by name as derived data this writer has no business
reading.

**Cold archival runs as this role.** The exporter writes the manifest, so it holds INSERT and
UPDATE there, and still no DELETE on the manifest and nothing on telemetry beyond INSERT. Dropping
an archived chunk goes through `cold_tier_drop_verified()`, which is `SECURITY DEFINER` so the
daemon can ask for a drop the manifest has verified without holding DELETE. It also reports
whether archiving is on, which decides what the retention job may drop.

### `fdw_reader`

What Supabase's foreign tables connect as. Read-only, and only the projection: `telemetry`,
`telemetry_latest`, the three rollups, `telemetry_horizons` and `storage_footprint`. Nothing on
the Supabase side writes through the FDW, so INSERT would be a grant with no caller. Without this
role the public user mapping runs as the historian superuser, so a widened local grant or a new
foreign table would inherit superuser reach.

**The horizons grant fails silently at the dashboard when absent.** The Supabase-side view is
`security_invoker`, so the remote query runs as this role; the export dialog swallows a failed
horizons lookup and labels every resolution "reach unknown", which is indistinguishable from a
stack that has not answered yet. Found in a browser, not by a test, which is why the self-check
now asserts it.

### The self-checks

Each one guards against a failure that nothing downstream would report. A grant that silently did
not apply is indistinguishable from one that did until a BI tool connects days later.
`grafana_reader` is checked in the other direction, that it can read every object the shipped
dashboard queries, because "Database Connection OK" is a CONNECT test and says nothing about
whether a panel can run, which is how four broken panels once went unnoticed. `ingest_writer` is
checked both ways, because "can insert" passes on a role that is secretly superuser and "cannot
delete" passes on a role that cannot do anything at all. `storage_footprint` must exist, in a
separate check so the message names the cause: `storage.sql` did not run, or ran after this file.
And every `pg_monitor` membership is asserted inherited, because one that is held but not
inherited passes `pg_has_role(..., 'member')`, lets the exporter start and the scrape succeed, and
leaves the series that needed the privilege simply absent. `metrics_reader` is also asserted to
have no password, since it holds `pg_monitor` precisely because it was reachable only from
loopback.
