# Supabase Backend

Schema, row-level security, triggers, and the seven edge functions. Supabase is the authoritative
store for **asset metadata**; time-series telemetry lives in TimescaleDB and is reached through a
foreign-data-wrapper view.

| Path | Purpose |
| :--- | :--- |
| [`migrations/`](migrations) | `0001` schema, `0002` seed data, then additive migrations `0003`–`0007` |
| [`migrations/archive/`](migrations/archive) | The 38 pre-beta migrations, preserved for their reasoning. **Never executed** |
| [`functions/`](functions) | Deno edge functions and the worker router |
| [`envoy.yaml`](envoy.yaml) | API gateway routes, CORS, and the `apikey` check. **A template** |
| [`seed.sql`](seed.sql) | Demo user accounts |

---

## Migration Baseline

Squashed to a **two-file baseline** for the public beta, plus additive remediation migrations:

| File | Contents |
| :--- | :--- |
| `0001_baseline_schema.sql` | Pure DDL. Tables, views, functions, triggers, policies, grants |
| `0002_seed_data.sql` | Pure DML. RBAC, vocabularies, metric catalog, demo assets, cron, Vault |
| `0003_audit_immutability_and_quarantine_rpc.sql` | Append-only enforcement and the atomic approval RPC |
| `0004_drop_gateway_ip_address.sql` | Removes a column nothing read |
| `0005_digital_thread_signal_and_attribution.sql` | Stops the audit trigger recording machine non-events |
| `0006_nodered_oidc_auth.sql` | Node-RED's OAuth client and the webhook signing key |
| `0007_metric_catalog_name_check.sql` | Constrains `metric_catalog.name` to the Factory+ format |
| `0008_gateway_sparkplug_group.sql` | Adds `gateways.sparkplug_group`, making the edge node address `(group, node)` |

Add schema changes as a **new numbered file** (`0008_…`). The baseline files describe the state a
fresh database is built into; a live database has already run them.

### Prefixes must be unique, and the order is the filename

`supabase-db-init` applies `/migrations/*.sql` in **glob order** with no applied-migrations
ledger, so the filename *is* the execution order. Two files sharing a prefix still both run —
lexically, by whatever follows the number — which means the order is decided by an accident of
naming and can change under a rename that looks purely cosmetic. Nothing fails, nothing logs; the
ordering is simply not the one anybody chose.

`scripts/check-docs-drift.mjs` asserts unique prefixes across `supabase/migrations/`.
`0006_nodered_oidc_auth.sql` was renumbered from `0003` for exactly this reason.

### How the chain reaches each target

**Compose bind-mounts this directory** at `/migrations` and applies the plain files, so a migration
is editable without a rebuild.

**Kubernetes gets them baked into an image.** `supabase/db-init/Dockerfile` is `supabase/postgres`
with `COPY migrations/*.sql /migrations/`, and the db-init Job reads them from its own filesystem.
The chart carries none of them.

That is not the original design. They were mirrored into the chart, gzipped, to fit the **1 MiB
ConfigMap limit** — an etcd object limit that fails at *apply* time with "Request entity too large",
naming the ConfigMap rather than the file that grew. The chain is 878 KiB, 57% of it generated
reference vocabulary, so compression was the obvious answer and it worked: 149 KiB.

It broke the **other** 1 MiB limit. Helm stores a release as `base64(gzip(json(release)))` in a
Secret with the same cap, and that release carries the migrations **twice** — once as chart files,
once base64-encoded into the rendered ConfigMap. Gzipped bytes compress no further, so neither copy
shrinks and base64 adds a third on top of each: 464 KB of a 1,213,920-byte release against a
1,048,576 limit, and `helm install` failing with

```
Secret "sh.helm.release.v1.acs-cymru.v1" is invalid: data: Too long
```

which names the Secret and nothing about migrations. Un-gzipping is worse in both directions at
once — 1,386,004 bytes in the release, and the ConfigMap back over its own limit at 1,255,337.

**No size of file satisfies both limits as the chain grows**, because the same bytes are counted by
each. Hence the image. Two consequences worth knowing:

- **The db-init image tag is the schema version.** Pinning an older one replays an older chain,
  which is a database rollback rather than a runtime downgrade.
- **There is no mirrored copy left to drift**, so nothing needs a sync check to prove the two
  targets agree: both read `supabase/migrations/`, one by mount and one by `COPY`.

Squashing the chain was considered and rejected before either of these: 81% of the bytes are
generated vocabulary and SQL statements that must survive verbatim, so the floor is ~703 KiB. The
only thing a squash removes at scale is the migration headers, and in this repository those are the
reasoning for every schema guard.

### Idempotency is not optional

`supabase-db-init` replays **every** `/migrations/*.sql` on every boot — there is no
applied-migrations ledger. A raw `pg_dump` baseline installs on the first boot and takes the stack
down on the second. Every statement uses `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`, or
`DROP … IF EXISTS` ahead of every constraint, policy and trigger.

The glob does **not** recurse, which is why `archive/` is mounted but never applied.

### Three defects the squash verification caught

The old chain and the baseline were built into separate databases and diffed — statement sets,
per-table content hashes, and the `anon`/`authenticated` privilege set. Inspection alone would not
have caught:

- **`SET check_function_bodies = false` is required.** PL/pgSQL resolves `%ROWTYPE` at `CREATE`
  time, so `fork_schema()` cannot precede `public.schemas`. No single ordering satisfies every such
  dependency in both directions.
- **`pg_dump` records only positive grants**, so the chain's `REVOKE`s vanished and `anon` silently
  regained `GRANT ALL` on every table. Hence the explicit privilege reset in `0001`.
- **Constraints must be guarded, not dropped and re-added** — `DROP CONSTRAINT IF EXISTS
  cells_pkey` fails on any populated database with foreign keys pointing at it.

See [`migrations/archive/README.md`](migrations/archive/README.md).

### Dropping a `gateways` column (0004)

`ip_address` was captured on the gateway form and on quarantine approval, and shown as a column,
but nothing ever acted on it: not in the search haystack, no view or function derived anything
from it, ingestion resolves edge nodes by `sparkplug_id`, and the AAS exporter does not read it.
Operators were being asked to keep a field accurate for no consumer.

**The view must be dropped and rebuilt, never CASCADEd.** `public.gateway_status` selects from
`public.gateways`, so PostgreSQL refuses:

```
ERROR:  cannot drop column ip_address of table gateways because other objects depend on it
DETAIL: view gateway_status depends on column ip_address of table gateways
```

`DROP COLUMN … CASCADE` would "work" by dropping the view with it — and the gateways page would
404 on `gateway_status` until someone noticed. Rebuilding from `ensure_gateway_status_view()` is
the honest form of the same operation, and is exactly what that function exists for: its body
selects `g.*`, so it picks up the new column set on its own.

`gateway_status` was confirmed to be the only dependent object:

```sql
SELECT DISTINCT dependent.relname
FROM pg_depend d
JOIN pg_rewrite r       ON r.oid = d.objid
JOIN pg_class dependent ON dependent.oid = r.ev_class
JOIN pg_class src       ON src.oid = d.refobjid
JOIN pg_attribute a     ON a.attrelid = src.oid AND a.attnum = d.refobjsubid
WHERE src.relname = 'gateways' AND a.attname = 'ip_address';
```

**Fresh and existing databases converge**, which is the property that matters when one file set
serves installs *and* upgrades. `0001` no longer creates the column in either of the two places it
appeared — the `CREATE TABLE` and the expanded column list of its inline `gateway_status`
definition, which `pg_dump` wrote out as explicit columns rather than `g.*`. Removing only the
first would leave `0001` failing on a fresh database with `column g.ip_address does not exist`
while every existing database kept working, because `CREATE TABLE IF NOT EXISTS` is a no-op there.

- **fresh** — `0001` builds the table without the column; `0004`'s DROP is a no-op.
- **existing** — `0001`'s CREATE is a no-op; `0004`'s DROP removes the column.

> **Adding a column to `gateways` carries the same obligation in reverse:** call
> `ensure_gateway_status_view()`, because `CREATE OR REPLACE VIEW` cannot widen a `g.*` view in
> place.

### Audit signal and attribution (0005)

On a stack running **one** simulated gateway and **one** device, `digital_thread` was taking
**175 rows/hour**, of which 123 in the first hour had `changed_by IS NULL`:

| entity | action | what actually differed | rows |
| :--- | :--- | :--- | ---: |
| `gateways` | UPDATE | `last_heartbeat` only | 84 |
| `gateways` | UPDATE | `last_heartbeat`, `status` | 1 |
| `devices` | UPDATE | **nothing at all** (`old = new`) | 33 |

**Attribution alone would not have helped.** `changed_by` was NULL because these were not things a
person did — a gateway sending a heartbeat has no author. Labelling them "the ingestion daemon"
would have faithfully described 175 rows an hour and left the log exactly as unreadable. At 50
gateways that is ~210k rows/day into an append-only table, burying the handful of rows that record
an operator changing something.

Two of the three sources are not events at all:

- The 33 device rows had `old_data = new_data`. Ingestion re-sends `status='ONLINE'` on every
  rebirth (60s), and an `AFTER UPDATE` trigger fires whether or not any value changed. **A write
  that changed nothing is not a change.**
- `last_heartbeat` is liveness telemetry, not metadata. Nothing reads it from the audit log —
  `public.gateway_status` derives staleness from the live column at read time, which is precisely
  why it is a view and not a stored status.

This discipline was already applied to the quarantine webhook (a blanket hook would emit ~2 HTTP
calls/min/gateway of noise) and to `record_declared_metrics`, which writes only on change. The
audit trigger was the one place it had not been.

`actor_source` is a **closed set** (`user` / `ingestion` / `migration` / `service`) because one of
its sources is a request header a client supplies, and an audit column must not become free text
an arbitrary caller can write into. The trigger never accepts `user` from that header — a client
asserting a human author for its own writes is exactly the claim it must not be able to make.

Once machine writes say so explicitly, `actor_source IS NULL` stops meaning "probably a heartbeat"
and starts meaning **"we lost track of this"** — a reportable defect rather than the normal case.

#### Verified after the fact

Re-measured on the same topology (one simulated gateway, one device) against the shipped stack:

| Window | `digital_thread` rows added | Traffic in the window |
| :--- | ---: | :--- |
| 7 min 6 s steady state | **0** | 14 heartbeats, 8 rebirths, 60 telemetry samples |

175 rows/hour → **0**. The suppression is not sensitive to fleet size — it is evaluated per row, so
the same measurement holds at 50 gateways.

**The guard now has a test, which it did not before.**
[`test_digital_thread_guard.py`](migrations/test_digital_thread_guard.py) pins both directions: the
two non-events stay unlogged, and — the case a careless per-column implementation drops — a
heartbeat that *also* carries a status change is still logged. `log_digital_thread_event()` is
re-declared by three migrations (`0001`, `0003`, `0005`), all replayed on every boot with no ledger,
so a fourth one omitting the suppression block would silently revert it and the only symptom would
be the table quietly growing again.

**One write the trigger cannot suppress, and the daemon now does.** Suppressing the *audit row* for
an unchanged UPDATE does not suppress the *UPDATE*: it still costs a PostgREST round trip, a WAL
record, and — because `devices` is `REPLICA IDENTITY FULL` and published to `supabase_realtime` — a
full-row change event broadcast to every connected dashboard, once per device per rebirth.
`process_dbirth()` therefore compares before writing, the same shape `record_declared_metrics()`
already used. `gateways.last_heartbeat` is deliberately **not** deduplicated for the reason above:
`public.gateway_status` derives staleness from it, so a suppressed heartbeat would report a live
gateway as `STALE`.

### Metric catalog standards seed (0018)

`metric_catalog` is **curated, not accreted**: `ingestion.py` contains no reference to it at all,
and the only insert path is the operator-facing form behind `POST /api/v1/metric-catalog`. Good
property — but it means a mixed-standard fleet is registered by hand, one form at a time, and
`name` is UNIQUE and IMMUTABLE, so the first row to claim a name owns it permanently along with
whichever `standard` and `semantic_id` it was created with. Both flow into the AAS export and the
i3X `sourceTypeId`.

`0018` front-runs that for the demonstrator's metric set. Three properties worth knowing:

- **Semantic ids are `SELECT`ed from the vocabulary tables, never typed.** Every row joins the
  vocabulary for its standard, so a metric whose concept is not in the vocabulary is **not
  inserted at all** rather than inserted with a guessed id — the inner join is the check. Retyping
  would create a second, unverified copy of an identity `docs/vocabularies.md` confirmed against
  machine-readable sources, and a typo would assert an interoperability that does not exist while
  looking exactly like one that does.
- **The taxonomy extends what `0002` seeded; it does not replace it.** One top-level segment per
  standard, so a name cannot collide across standards by construction:

  | Segment | Standard |
  | :--- | :--- |
  | `Axes/` `Controller/` `Systems/` | MTConnect 2.x |
  | `MotionDevice/` `Machine/` | OPC 40010 Robotics |
  | `Energy/` | OPC 40001-4 Machinery Energy |
  | `BMS/` | ASHRAE 223P |
  | `OEE/` | ISO 22400 |

  The plan behind this migration proposed `KPI/` and `Robotics/`. Both were rejected on contact
  with the existing catalog, which already uses `OEE/` and `MotionDevice/` — a parallel prefix
  would mean two permanent names for one concept, which is the collision the naming plan exists to
  prevent, arriving from the direction of the plan itself.
- **Transliteration happens at authoring time, because it cannot happen later.** `0007` forbids
  dots and hyphens, so the ASHRAE concept `Constituent-CO2` is registered as
  `BMS/CO2_CONCENTRATION`. The join still uses the vocabulary's own unmodified key.

**One inconsistency this surfaced and deliberately did not fix.** `0002`'s rows mint semantic ids
*path-shaped* (`…/mtconnect/v2.0/Axes/C/ANGLE`) where `mtconnect_vocabulary` mints them
*type-shaped* (`…/mtconnect/v2.0/DataItemType/ANGLE`). Both are under the locally-minted
`acs-cymru.local` namespace, so neither asserts a false interoperability and neither is wrong —
they are two conventions for the same thing, and `0002`'s predates the vocabulary tables.
Reconciling them is deprecate-and-supersede with its own reasoning to write.
`test_metric_catalog_seed.py` scopes its provenance assertions to the rows `0018` owns for exactly
this reason.

### Metric name format (0007)

Factory+ requires a metric name to be `/`-delimited folders whose segments use only alphanumerics
and the underscore: `^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$`. `.` is not a legal character.

**`metric_catalog.name` is immutable**, so a non-conforming name is *permanent* — the row can only
be deprecated and superseded, never corrected. The constraint is cheap now and impossible later.

**It is added `NOT VALID`, and that is the whole design.** `supabase-db-init` runs
`psql -v ON_ERROR_STOP=1` over every migration on every boot with no ledger, so a plain
`ADD CONSTRAINT` that failed on one legacy row would not fail once — it would fail on **every
boot, forever**, and the stack would never come up again. `NOT VALID` still enforces on `INSERT`
and `UPDATE`, so new rows are constrained immediately; only the back-scan is deferred.

The migration then attempts `VALIDATE CONSTRAINT` inside an exception handler. On failure it
raises a **`WARNING`** naming the offending rows and leaves the constraint `NOT VALID`, so it
re-checks and re-warns on the next boot. A warning that stopped appearing because the migration
gave up would be worse than no warning.

To clear one: deprecate the offending metric, add a conforming replacement, set `superseded_by`,
then

```sql
ALTER TABLE public.metric_catalog VALIDATE CONSTRAINT metric_catalog_name_format;
```

`METRIC_NAME_PATTERN` in [`frontend/src/utils/metricGroup.js`](../frontend/src/utils/metricGroup.js)
mirrors this expression so the operator is told at the form rather than by a `400` — the same
keep-in-step obligation `deriveMetricGroup()` and `utils/sparkplugId.js` carry.

All 15 seeded catalog names conform, so the constraint validates cleanly on a fresh database.

### The Sparkplug group is part of the address (0008)

Ingestion parsed `spBv1.0/<group>/<type>/<node>/<device>` and **never read the group**, so two
groups publishing the same edge node id resolved to one row — silently, each group's telemetry
attributed to the other's asset. `gateways.sparkplug_group` closes that, and is what makes
`/v1/address/{group_id}/{node_id}` mean anything.

Resolution order in `resolve_gateway()`, with the middle arm as the migration path:

1. `(sparkplug_group, sparkplug_id)` — the current scheme.
2. `sparkplug_id` alone — warns `DEPRECATED IDENTITY`, throttled, naming both the group on the
   wire and the one on the row. **Not a refusal**: a fleet is reconfigured one gateway at a time,
   and refusing here would strand every device behind a node not yet corrected.
3. `name` — legacy, pre-`sparkplug_id`.

The resolution cache is keyed by the **pair**. A cache keyed on the node alone would hand a hit
from one group to a request from another — precisely the collision this closes.

> **Adding a column to `gateways` requires `ensure_gateway_status_view()`.** `0008` calls it, and
> `0001` no longer carries a second, explicit-column copy of the view — see below.

### The Directory reports liveness it observed (`0054`)

`directory_services.status` and `.last_heartbeat` were **never written by anything**. The only
writes were `0002`'s seed INSERTs, which contain the literal `'ACTIVE'` — so every stack reported
fifteen healthy services at every age, and `last_heartbeat` held the moment the row was seeded.

**The green pill was the more harmful half**, which is the opposite of how it looks. A stale date
reads as stale and makes a reader suspicious on their own; a green badge is *believed*, and it
would have said ACTIVE for a service that had been down a week. The Directory page had already
corrected this exact class of fabrication once — it used to render a hardcoded `SYNCED / a8f3e4b`
for Node-RED, removed because nothing can observe what Node-RED is running.

`refresh_directory_liveness()` writes both every minute from Prometheus's `up` series.

| | |
| :--- | :--- |
| `ACTIVE` | Prometheus scraped the target and it answered |
| `DOWN` | Prometheus scraped it and it did not |
| `UNKNOWN` | **nothing observes this service** |

**Six of the fifteen are scraped; nine are not, and `UNKNOWN` is the point rather than a shortfall.**
Replacing a fabricated `ACTIVE` with a fabricated probe result would be the same defect in better
clothes. `endpoint_url` holds *browser* addresses — `http://localhost:8088`,
`postgres://localhost:54322` — which from inside any container name the container itself, so a
probe against them would answer a question about the wrong host and report it as service health.

**No edge function, because none was needed.** `supabase-db` reaches `prometheus:9090` directly and
`pg_net` is already in this schema. Measured before choosing: `net.http_get()` against the Prometheus
query API returns 200 with the whole `up` vector in one call. So this is a migration and a cron
entry — no new deployable, no thirteenth entry in the router allow-list.

`pg_net` is asynchronous, so each run **collects the previous probe and fires the next**. Status is
one tick old, which at a one-minute schedule is well inside the staleness it describes.

**Everything unmapped is set `UNKNOWN` on every run, not only the first.** If a job is renamed in
`prometheus.yml`, or a service renamed so the map stops matching, the row falls back to `UNKNOWN`
rather than keeping the last `ACTIVE` it was given — which would be a fabricated status with a real
timestamp, the most convincing kind. `scripts/check-docs-drift.mjs` asserts every mapped job still
exists in `prometheus.yml`; the issue that requested this named `kong`, which had already become
`envoy` by the time it was built.

### Migrations that must run once, and the ledger that decides (`0040`, `0053`)

Every migration replays on every boot. A handful cannot: `0040` retires the demonstration seed by
**deleting** rows, and a second run would delete whatever an operator provisioned afterwards.

`public.one_shot_migrations` is how such a migration knows. It claims its own filename with
`INSERT … ON CONFLICT DO NOTHING` **inside the same transaction as the work it guards**, so the
claim and the effect commit together or not at all. The claim is what branches — not a flag, not a
version number, not the presence of the rows themselves.

**Which makes the claim row load-bearing, and it was writable.** The table has RLS with no policy,
which correctly denies `anon` and `authenticated` — but `service_role` bypasses RLS and `0040`
granted it `ALL`. One `DELETE` from any holder of the service key re-arms the purge, and the next
boot runs it against the current floor, reporting success exactly as it did the first time.

`0053` revokes `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE`. **`SELECT` is deliberately kept**:
reading the ledger is how an operator answers *"why did the purge not run"*, it discloses a filename
and a timestamp, and the finding was about the writes. Migrations are unaffected — db-init connects
as `postgres`, which owns the table.

This is the same narrowing `0026` applied to `digital_thread`, on the argument that *"a convention
is not what an audit trail rests on"*. The table guarding a destructive replay had been left out of
it.

### Capture and playback orchestration (`0055`, `0056`, `0057`, `0058`, `0060`)

The schema behind the **Capture** page. What the workers do with it is in
[`ingestion/README.md`](../ingestion/README.md#recording-from-the-dashboard); what is here is the
part that has to be true whoever calls it.

**A job and an artefact are separate tables, and that split is load-bearing.** `capture_jobs`
records an act that happened once; `captures` holds the artefact — subject, storage path, size, note
and manifest — and `playback_jobs.capture_id` references *that*. A capture uploaded through the
browser never had a job, so pointing playback at `capture_jobs` would leave two ways to name a
capture.

**The RPCs are the only write path, which is what makes their checks gates.** `capture_jobs` and
`playback_jobs` take no direct `INSERT` or `UPDATE` from any application role;
`start_capture_job()`, `register_uploaded_capture()` and `start_playback_job()` are `SECURITY
DEFINER` and hold the checks. Same shape as `0047`: a validation that lives in the client, or beside
a policy that also admits a direct write, is advice rather than a control — and the direct write is
the door an API caller uses rather than the one the UI happens to.

**Single-flight is an index, not application logic.** A partial unique index on
`status = 'RECORDING'` permits one capture at a time across the whole stack, where two browser tabs
cannot race it. Widening it to the subject is how concurrency would arrive, and would turn the
page's single running card into a list — a deliberate change rather than a default.

**Neither job table gets a digital-thread trigger.** That trigger is opt-in per table, and both
tables carry a progress column the workers update roughly once a second. Adding it would look like
consistency while writing a row per tick into an append-only table no application role can prune,
which is `0005`'s heartbeat problem. Both tables *are* added to the `supabase_realtime` publication
explicitly, which is how the page follows a running job at all, and `0055` self-checks that the
publication membership survived.

**`Service_Playback` (`0056`) is a machine principal in `0048`'s sense** — no user row, reached
through `is_playback_caller()` — and it holds four gates and one storage object, not `service_role`.
Its MQTT identity is a separate matter entirely: the worker authenticates to the broker **as the
target gateway**, so the database says what it may do and the broker ACL says what it may publish.
See [Machine identities](#machine-identities) for why the two never collapse into one credential.

**`gateway_has_broker_credential()` exists because `gateway_holds_a_credential()` (`0038`) answers
the opposite question.** The older predicate is `NOT g.is_virtual AND g.enrolled_at IS NOT NULL` —
"a physical appliance that completed enrolment" — which refuses every virtual gateway and admits
only real hardware. For a playback target that is inverted twice over: the target is normally
virtual, and real hardware is exactly what a playback must never publish as. `0041` had already
recorded that a virtual gateway is outside the older predicate's scope by definition. The new one
asks both routes — physical enrolment, or the `CREDENTIAL_ISSUED` audit row that is the only trace a
virtual mint leaves — and subtracts revocation.

**`0057` exists because the database cannot know what a process holds.** It records what the
playback worker reports on a heartbeat: the gateways it has an MQTT password for, and when it last
said so. The timestamp is the part that earns its place — an empty list with a recent report means
the worker is up and holds nothing, while no recent report means the worker is down, and an empty
list alone cannot tell those apart. Nothing secret is stored; a `sparkplug_id` is the MQTT username
and is on the Gateways page already.

**`0058` is `rebirth_requests`, and it is named for the one thing it carries.** A capture opens by
asking its subject's edge node to rebirth, because birth certificates cannot be queried, and a
person can now ask for one too. Sparkplug's NCMD channel could equally write metric *values* — a
setpoint, a mode, a relay — and that is actuation. A rebirth asks a node to restate what it already
is: idempotent, carrying no intent about the process, and a node that ignores it is in exactly the
state it was. So the table is not called `commands`, and `0058` carries a self-check that fails if
it ever grows a column able to hold a payload.

**`0060` seeds one `Playback` gateway and refuses every other target**, through a BEFORE INSERT
trigger on `playback_jobs`. Two publishers on one edge node is not a race but a corrupted stream:
`seq` is scoped to the edge node, so a simulator and a playback under one identity increment private
counters into one shared sequence and the daemon correctly concludes messages were dropped.
`ensure_shadow_devices()` mints one device per captured device against that gateway, carrying
`devices.shadow_of` and reused between runs. It copies the **metric contract** — `schema_id` and
`device_submodels` — because a replay judged against no schema is either unjudged or, under
`conformance_policy = enforce`, wholly rejected while the job reports success. It does **not** copy
the nameplate, and a self-check fails if a shadow ever gains one: `device_nameplate` (`0011`) is
IDTA Nameplate and holds a serial number, so a copy would make the AAS Part 5 export emit two shells
asserting the same asset identity.

### What is stale, and what is merely quiet (`0029`, `0061`)

`platform_health` is the one view Grafana's platform rules read, and its `gateway_stale` arm is the
only thing standing between an appliance going quiet and somebody being told. It is therefore also
the arm most easily ruined, and it was: `0029` excluded archived gateways and nothing else, which
was correct until `0060` seeded a gateway that is *never* expected to heartbeat.

**Nothing publishes as the `Playback` gateway until a playback runs**, which is deliberate — it is
why `start_playback_job()` gates on credential possession rather than on `status = 'ONLINE'`. So it
was permanently stale, permanently in the view, and `acs-gateway-stale` fired five minutes after
every boot and never cleared. `0061` adds `AND NOT g.is_shadow`, for exactly the reason `0029`
already gives for archived appliances: *"alerting on it would train an operator to ignore the
rule."*

**`is_shadow`, and not one of the other three flags.** `is_simulated` is carried by every simulator
gateway, and those do heartbeat — their silence is a real fault. `is_virtual` answers whether an
appliance physically exists, not whether anything publishes as it. `is_archived` would mean
archiving the gateway, which `0060`'s trigger forbids: it requires exactly one live shadow gateway
to exist.

**The panel is a separate question from the alert, and is deliberately left open.** `gateway_health`
(`0036`) carries the same archived-only exclusion, so the Playback lane still appears there with a
stale heartbeat. A panel is an inventory and an alert is a demand for action; answering both with
one predicate would be fixing the second by reflex.

### `0001` builds `gateway_status` by calling the function, not inline

`pg_dump` expanded the view into an **explicit column list** when the baseline was squashed, while
`ensure_gateway_status_view()` selects `g.*`. Those drift apart the moment a later migration adds
a gateways column: `0008` widened the view, and `0001`'s replay on the next boot tried to recreate
it from the older, narrower list:

```
ERROR:  cannot drop columns from view
```

`db-init` runs with `ON_ERROR_STOP=1`, so that is not a warning — **the stack never comes up
again**, and it surfaces on the *second* boot rather than the first. `0004` hit the same wall from
the opposite direction when a column was removed.

`0001` now calls the function, leaving one definition of the view in the repository. The function
drops and recreates rather than replacing, which is also what re-applies the `COMMENT` and the
grants — `DROP VIEW` discards both, which is why they live inside it.

---

## Core Tables

| Table | Notes |
| :--- | :--- |
| `cells` | Factory groupings. `name` is still `UNIQUE` — cells are not addressed on the wire |
| `gateways` | Edge gateways. `sparkplug_id` generated column, `location_scope`, `last_heartbeat` |
| `devices` | `sparkplug_id`, `is_quarantined`, quarantine diagnostics, `last_birth_metrics`, `model_3d_path`, `cell_id`, `conformance_policy` (`0050`: `'audit'` records a schema violation and writes the sample anyway, `'enforce'` drops the offending metric) |
| `links` | Arbitrary labelled URLs against any entity: `(entity_type, entity_id, display_name, url, link_tag)`. Renamed from `documents` / `document_tag` by `0049` — nothing about the model was ever document-specific |
| `digital_thread` | **Append-only** audit log, written only by trigger |
| `metric_catalog` | What devices publish. `name` is **immutable** |
| `metric_groups` | Registry of approved group *spellings* — membership is always derived from the name |
| `schemas` | Versioned. `version` / `parent_schema_id` / `status` / `change_description` |
| `device_submodels` | Many schemas per device, one AAS Submodel each |
| `mtconnect_vocabulary`, `iso22400_vocabulary`, `opcua_vocabulary` | Reference data. `SELECT` to `authenticated`, everything else revoked |
| `roles`, `permissions`, `role_permissions`, `user_roles` | RBAC |
| `webhook_endpoints` | Outbound targets. **No write RLS policy by design** — a writable endpoint table is an SSRF primitive |

### Views

| View | Resolves |
| :--- | :--- |
| `gateway_status` | `gateways` plus read-time `live_status` / `is_stale` (90 s threshold) |
| `device_locations` | A device's effective cell: `COALESCE(device.cell_id, gateway.cell_id)` |
| `device_schemas` | Union of `device_submodels` join rows, falling back to `devices.schema_id` |
| `telemetry` | `security_invoker` view over `timescale.telemetry`, a `postgres_fdw` foreign table |

> The raw foreign table lives in its own `timescale` schema, deliberately kept out of
> `PGRST_DB_SCHEMAS` so it is never routable. Only the view is exposed, and `anon` reaches neither.

---

## RLS Privilege Matrix

Every table has `ENABLE ROW LEVEL SECURITY`. The pattern is uniform and fail-closed.

| Table group | SELECT | INSERT / UPDATE / DELETE |
| :--- | :--- | :--- |
| `cells`, `gateways`, `devices`, `documents`, `asset_config`, `schemas`, `device_submodels`, `directory_services`, `metric_catalog`, `metric_groups` | `authenticated` | `Administrator`, `Shopfloor_Manager` |
| `digital_thread` | `Administrator`, `Shopfloor_Manager`, `Auditor` | **nobody** — see below |
| `*_vocabulary` | `authenticated` | **no write policy at all** |
| `roles`, `permissions`, `role_permissions` | `authenticated` | none |
| `user_roles` | own row, or `Administrator` / `Shopfloor_Manager` | none |
| `webhook_endpoints` | `Administrator` | **no write policy** |

### `has_role()`

```sql
public.has_role(allowed_roles text[]) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
```

Reads `public.user_roles` **directly rather than trusting a JWT claim**. This is deliberate: a role
revocation takes effect on the next query, not on the next token refresh.

`custom_access_token_hook()` also mirrors the role into `app_metadata.role` for clients that want
it — but **nothing authorises on that claim**. The edge functions were corrected during pre-beta
remediation to read the table too, because falling back to the claim when no row was found inverted
the meaning of a revocation.

---

## Audit Trail (`digital_thread`)

Written exclusively by `log_digital_thread_event()`, an `AFTER INSERT OR UPDATE OR DELETE` trigger
on `cells`, `gateways` and `devices`.

### Append-only, enforced three ways

1. **No INSERT/UPDATE/DELETE grant** to `authenticated`.
2. **`TRUNCATE`, `REFERENCES` and `TRIGGER` revoked.** These were left behind by an original
   `REVOKE INSERT, UPDATE, DELETE` issued against a prior `GRANT ALL` — and **`TRUNCATE` bypasses
   RLS entirely**, so the SELECT policy did not constrain it.
3. **`enforce_digital_thread_append_only()`** — a `BEFORE UPDATE OR DELETE` trigger that raises for
   every application role, `service_role` included. The service key ships in `.env` and is held by
   ingestion and all four edge functions, so an audit trail that key could rewrite was not much of
   an audit trail.

> **Scope, stated honestly.** The trigger exempts `postgres` and `supabase_admin` because a role
> that can issue DDL can drop the trigger anyway. What it *does* close is every path reachable over
> PostgREST — and PostgREST cannot execute DDL, so for `authenticated` and `service_role` it is a
> real boundary rather than a speed bump.

### Attribution

`changed_by` records `auth.uid()`. Edge functions mutate with the service-role client, whose JWT
carries no `sub` — so **every privileged write used to be logged anonymously** (58 of 65 rows on
the audited database had `changed_by IS NULL`).

`log_digital_thread_event()` now falls back to a session-local GUC, `acs_cymru.actor_id`, which
`approve_quarantined_device()` sets with `SET LOCAL`. `auth.uid()` still wins when present — a
direct PostgREST write by a signed-in user is already correctly attributed, and the GUC must not be
able to override it.

**A `sub` is no longer sufficient evidence of a person** (`0048`). The trigger used to conclude
`actor_source = 'user'` from `auth.uid()` being non-NULL, which held for exactly as long as the only
accounts carrying a `sub` were people's. `Service_Ingestor` is the counter-example and there will be
more, because the Access Control page mints them — so pointing the ingestion daemon at a real
principal would have relabelled every automated device registration and status flip as a human
action, silently, with no sign but a `changed_by` uuid belonging to nobody who works here.

`is_machine_principal()` decides it, reusing `0042`'s predicate unchanged — no email, no password,
no `auth.identities` row — because a second definition of "is this a service account" would be worse
than the bug. A machine falls through to the `X-ACS-Cymru-Actor` header path and is recorded as what
it is, while `changed_by` still receives the principal. The row improved as well as being corrected:
an ingestion write records `'ingestion'` **and** names the identity, where it used to record
`'ingestion'` and `NULL`.

---

## Machine Identities

Four identities on this stack are held by software rather than people, and each is narrow by
construction. They were built as roadmap items 13 and 16; that work is finished, so it is documented
here rather than left on a checklist.

| Identity | Holds | May do |
| :--- | :--- | :--- |
| `Service_Ingestor` (`0046`) | `Operator` | Nothing directly. Eight `SECURITY DEFINER` functions -- seven gates in `0047` plus `record_ingestion_rejection()` from `0026`, brought under the same rule by `0051` -- each checking the caller **is** this principal |
| MCP reader (`0034`) | `Operator` | Reads the five relations the i3X address space is assembled from. Writes nothing; cannot read `digital_thread` |
| `factoryplus_i3x` | broker account | Reads the namespace, publishes nothing |
| `gateway-credential-service` | broker admin, scoped | Adds one broker account and nothing else |

All four are `auth.users` rows with **no email, no password and no identity provider**, so none can
sign in. That is also `0042`'s predicate for listing them, and `0048`'s for keeping their writes out
of the audit trail's `'user'` bucket.

### The ingestion daemon does not hold `service_role`

It used to, and that was the one credential on this stack whose compromise no policy written
anywhere else could contain — sitting in the process most exposed to the plant network. It now
authenticates as `Service_Ingestor`, an `Operator` principal that cannot write a single row
directly, and every write it makes goes through a gate in `0047`.

`Operator` is not "enough" and that is the design. Every write policy in this schema names
`Administrator` or `Shopfloor_Manager`, so the gates are the **only** route rather than the tidy
one. A credential that could perform those writes by holding a role that permits them would be a
smaller `service_role`, not a narrower one: it could still write anything that role can write, to
any row, in any shape. This one can do exactly eight things.

#### The eighth function, and the five weeks it spent unreachable

`record_ingestion_rejection()` is the daemon's ninth RPC by call count and was not one of `0047`'s
seven, because it already existed: `0026` built it as the narrow gate replacing `service_role`'s
direct INSERT on `digital_thread`. Its access control was its **grant**, which was correct while
`service_role` was the only thing that could call it.

`0046` took that key away from the daemon and nobody re-granted this one. Every payload conformance
violation since has been detected, logged, and then not written down:

```
permission denied for function record_ingestion_rejection (42501)
```

**The daemon catches it and carries on**, which is why nothing went red and no dashboard moved.
Under `conformance_policy = 'enforce'` (`0050`) that is worse than an absent audit row: the metric
is dropped AND the record of dropping it fails, so both halves of the evidence go.

`0051` corrects it the way `0047` would have, had it been written then — the grant widens to
`authenticated` and `require_ingestion_caller()` moves inside the body, because a bare widening
would let any signed-in user forge a `SCHEMA_REJECTION` row into a table no application role can
prune.

**Why it went unnoticed is the part worth keeping.** The seeded fleet does not violate its own
schemas, so on an ordinary stack the call site is never reached — the failure needed a device to
publish something its schema forbade, and nothing here does. It surfaced while exercising broker
capture and playback: replaying one machine class's metrics under another's identity produced this
deployment's first real violations, and the error appeared within two seconds. A feature nobody had
written yet was the only thing standing between this and a much later discovery, which is the
argument for `test_ingestion_rejection_rpc.py` asserting the grant directly rather than only
exercising the function as its owner.

Three rules moved from Python into SQL with the gates, each previously enforced by the caller:

- **Reserved gateway statuses.** A gateway may not assert `PENDING_ENROLLMENT`, `AWAITING_BIRTH` or
  `STALE` about itself — all three short-circuit ahead of the staleness arm in `gateway_status` and
  would leave a silent gateway looking healthy, which is the one thing that derived status exists to
  prevent. The rule was a frozenset in the daemon, applied to a string arriving from the plant
  network.
- **The watchdog's already-OFFLINE predicate**, which keeps a per-tick sweep out of an append-only
  table.
- **`first_dbirth_at` being write-once**, previously enforced against a cache that can go stale.

The daemon presents the **anon key as the gateway `apikey` and its own token as the bearer**. That
is not redundancy: the gateway's filter admits exactly two literal keys, so the ingestion token is
refused at the edge if sent as the apikey.

### Two recorders, because a host script cannot satisfy `has_role()` (`0041`, `0062`)

`record_gateway_credential_issued()` (`0041`) is the **operator** path: it gates on `has_role()`,
which resolves through `auth.uid()`, and it writes the caller's own id into `changed_by`. That is
right for the Access Control page and unreachable for anything else, because a host script
authenticates with the service-role key, for which `auth.uid()` is NULL.

**So provisioning issued credentials that nothing recorded.** Measured on a provisioned stack before
`0062`: five gateways holding live broker accounts, two `CREDENTIAL_ISSUED` rows, and an Access
Control page reporting `No platform record` for three gateways that were publishing at the time.

`record_gateway_credential_issued_by_service()` (`0062`) is the **machine** path — the shape
`record_ingestion_rejection()` (`0026`) and `record_service_token_issued()` (`0043`) already use:
revoked from `PUBLIC`, `anon` and `authenticated`, reachable by `service_role` alone, `actor_source`
pinned to `service` and `changed_by` NULL. The host and OS user it claims to run as are stored under
a `claimed` key, because the database can verify neither.

**Widening `0041` instead was the other option and is worse.** One function whose authorisation
depends on which caller reached it, and whose row means a different thing in each case, is harder to
read than two functions that each mean one thing. Both write the same `CREDENTIAL_ISSUED` action on
purpose: an inventory asking *"does this gateway hold a credential"* must not have to know which
route minted it, and the route is in `actor_source` for anyone who does.

**It refuses an archived gateway.** `0037` withdraws enrolment on archive so a decommissioned
appliance cannot return through a credential; recording one as routine would document, in the table
an auditor reads to check that did not happen, exactly the thing it was written to prevent.

**No expiry, and that is the difference from a token rather than an omission.** A broker password has
none: it is bounded by revocation (`0038`), not by a countdown. Inventing an `expires_at` would put a
reassuring date against a credential that has no such date.

### Three kinds of gateway, and two lanes for what is not real (`0052`, `0059`)

**`is_simulated` (`0052`) records provenance and each consumer decides what to do with it.** It sits
on the gateway and devices inherit it through `gateway_id` rather than carrying a copy: a stored
device-level flag would need two triggers to maintain an invariant the join gives for nothing, and
`verify_gateway_binding()` already guarantees a device's data reaches storage only from the gateway
it is bound to.

**`is_shadow` (`0059`) is a second lane, because provenance is not one axis.** A shadow gateway is
necessarily simulated — `start_playback_job()` refuses a target that is not — so one lane could have
covered both, and the second had to earn itself. It does: a **simulated** spindle reporting 4000 RPM
never turned, and a **shadow** spindle reporting 4000 RPM *did* turn, on a real machine, on the day
the capture was recorded. Both are "not a machine running right now", and they give opposite answers
to *is this number true* — which is the question being asked at the moment anyone consults a lane.

Precedence is `shadow > simulated > site_wide > explicit > inherited > unassigned`, most specific
first: both flags are true of a shadow device, so without an explicit order it lands in Simulated and
the more informative lane is silently unreachable. `device_locations` computes it and
`utils/cellResolution.js` mirrors it, with `check-mirror-drift.mjs` pinning the label list literally
— adding a lane is a deliberate two-file change with a check that fails until both sides agree.

**Neither lane is a row in `cells`.** A magic cell would put semantics in a free-text `name` — the
trap `devices.asset_type` was retired for — and `gateways.cell_id ON DELETE CASCADE` would delete
every host-run gateway with it. `unassigned` is already never stored; it is the `ELSE` arm, and these
join it as labels rather than as data.

**Simulated telemetry is treated exactly like real telemetry**, and that is a decision rather than an
omission. Broker playback depends on it: synthetic devices must roll up exactly like real ones,
because that is the behaviour under test. Shorter retention for simulated data would break the one
feature that needs synthetic data to behave normally, and could not be built cheaply anyway —
retention is one policy on one hypertable dropping whole chunks rather than rows.

### The playback gateway is visible and almost inert (`0067`)

It stays on the Gateways and Access Control pages deliberately: it holds a broker credential an
operator has to mint — `0060`'s own `NOTICE` says so, with the `sparkplug_id` filled in — and its
shadow devices hang off it. Hiding it would make the one gateway that needs setting up the one
nobody can see.

What it does not offer is the two acts that are wrong for it, for different reasons:

- **Archiving it** removes the only edge node broker playback can publish as. `ensure_shadow_devices()`
  looks the gateway up by flag (`WHERE is_shadow AND NOT is_archived`), so the failure lands at the
  moment somebody starts a job — possibly weeks later, on a page that says nothing about gateways —
  while the archive itself reports success and reads as housekeeping. `0067` refuses it in the
  database and the button is hidden; the UI is not the rule.
- **Requesting a rebirth** is addressed to a node nobody is listening as. The playback worker only
  publishes and holds no subscription at all, so the NCMD reaches nothing and `rebirth_requests`
  would record something that can never be answered.

**The rule is "not the last one", not "never".** `ensure_shadow_devices()` finds the gateway by flag
precisely so a stack can have more than one — two playbacks at once need two edge nodes — so
`0067` refuses only the archive that would leave none, and its message names the way through: mark
another gateway `is_shadow` first. Deletion is not guarded, because `0060` re-seeds the row on the
next boot; archiving is the act that survives one.

**It is also not a capture subject.** Recording from a shadow gateway means capturing a capture, and
its shadow devices exist to receive a replay rather than to report a machine, so both are filtered
out of the Capture page's subject tables. Starting a playback is unaffected — that query selects on
`is_shadow` because that is exactly the lane a playback publishes into.

### Cold telemetry archival (`0068`)

Raw telemetry used to leave one way: `timescaledb/retention.sql` adds a TimescaleDB retention
policy that **drops** chunks past `TIMESCALE_RETAIN_FOR`, on a timer, recording nothing. Cold
archival turns that delete into a move.

**The ordering is the whole feature**, and it is enforced in three independent places rather than
by a careful sequence in one file:

```
claim → export → upload → VERIFY → record → drop
```

| Enforced by | What it refuses |
| :--- | :--- |
| `telemetry_archive_manifest` CHECK constraints | *recording* a drop that was never verified, or a verification that was never exported |
| `cold_tier_drop_verified()` | dropping anything the manifest has not cleared — it computes the boundary itself |
| `--drop` being opt-in | the destructive half happening as a side effect of an export |

**The manifest lives on the historian, not here.** It describes chunks, and the chunks are there; a
copy in this database could drift from the hypertable it claims to describe with nothing able to
notice. `0068` maps it over the same `postgres_fdw` bridge that already carries `telemetry` and
`storage_footprint` — the arrangement `0027` established. One writer there, one reader here,
through `cold_storage_rows()`.

**`drop_chunks()` is a boundary, not a selection**, and that is the subtlety worth knowing. It
drops *every* chunk older than the timestamp given, so dropping the verified chunks one at a time
would delete everything older than each — including chunks never exported.
`cold_tier_drop_verified()` therefore computes the longest **oldest-first run** of verified chunks
and drops once, at its end. In practice archival runs oldest-first and the verified set is already
a prefix; the guard matters on the run where it is not.

**The exporter cannot delete telemetry**, which is not a detail. `roles.sql` revokes `DELETE` and
`TRUNCATE` on `telemetry` from `ingest_writer` deliberately — *"the two that make append-only
true"* — and the exporter runs as that role. `cold_tier_drop_verified()` is `SECURITY DEFINER`, so
the daemon may *ask* for a drop the manifest has already cleared while holding no privilege to
remove a row of its own choosing.

**Its settings arrive with their reader**, which is `0031`'s rule and the reason there are three
keys rather than six: `archive.enabled` (off by default), `archive.tier_after_days` and
`archive.bucket`, all read by `ingestion/cold_archive.py`. There is no S3 endpoint key because this
implementation writes to the platform's own object storage through the client
`capture_worker.py` already uses; those keys belong to the migration that teaches it to use an
external endpoint. **No credential key will ever be added** — every authenticated user can read
`system_settings`, so secrets go to Vault through Studio.

**Enabling it means standing retention down.** Both mechanisms drop chunks, and the timer wins the
race for anything the archiver has not reached: set `TIMESCALE_RETAIN_FOR=never` and let
`python -m cold_archive --drop` remove chunks once their export is verified. `retention.sql` warns
when it sees a manifest with rows and a drop policy being added, because that combination silently
deletes what the archiver has not got to yet.

```bash
python -m cold_archive --dry-run   # what would be exported
python -m cold_archive             # export, upload, verify; drop nothing
python -m cold_archive --drop      # ... and drop what verification cleared
```

### `deployment`, and the word it is replacing (`0064`)

`is_virtual` carries three incompatible definitions — *"no physical edge appliance behind this
row"* (`0025`, provisioning), *"this connector runs on the app host"* (`GatewaysTab.jsx`), and
*"(Cloud / Server-Simulated)"* (the checkbox, which contradicts the second) — while **every**
behaviour branching on it is about a fourth thing: whether there is a machine out on the plant
network. Roadmap §15 makes that argument; the bill arrived separately, as
`gateway_holds_a_credential()` being the wrong predicate three times in `0056`, `0062` and `0063`.

`0064` adds **`deployment`** (`'host'` | `'remote'`), the axis the code actually uses, plus the
cross-column `CHECK (NOT is_simulated OR deployment = 'host')` — a simulator is a process this stack
runs, and a remote one is not something it can provision or reason about. Two columns rather than a
three-way enum, so the fourth combination stays *sayable*: folding them together would make a
simulator on a separate load-generation box inexpressible.

**The rename is not in that migration**, deliberately — 126 references across 47 files, and §15's
own rule is that a rename beside a feature is a rename nobody reviews. Until it completes,
`sync_gateway_deployment()` keeps the two columns in agreement in both directions, so every writer
that still names `is_virtual` keeps working and gets the new column filled correctly.

**`0066` finishes it**: `gateway_health_rows()` moves last, because `is_virtual` was in its
`RETURNS TABLE` signature and a return type cannot be replaced in place — the function and the view
built on it are dropped and recreated together. Then the transitional trigger goes, and the column
with it. `gateway_status` has to be dropped first and rebuilt after: it is `SELECT g.*`, which
PostgreSQL freezes into an explicit column list, and that frozen list is a hard dependency. The same
fact that makes `ensure_gateway_status_view()` necessary when a column is *added* is what blocks a
drop.

Three things deliberately keep the old word: migration filenames (the chain is immutable),
`authorize_virtual_gateway_credential()` (an RPC name is client-visible, and renaming it is its own
change), and every `CREDENTIAL_ISSUED` row written before `0065`.

**`0065` moves the SQL half**, and it went first because that is where the ambiguity has actually
cost something: `gateway_holds_a_credential()`, `gateway_has_broker_credential()`,
`authorize_virtual_gateway_credential()`, `issue_gateway_enrollment_token()` and both credential
recorders. Three defects — `0056`, `0062`, `0063` — were the same predicate misread three ways, and
all three lived in a `WHERE` clause. The translation is mechanical (`NOT is_virtual` →
`deployment = 'remote'`) and `0064`'s trigger means every one of them answers exactly as it did.

Two things `0065` records that are easy to miss:

- **The audit rows now carry `deployment`**, and rows already written keep `is_virtual`. That is
  correct rather than untidy: an audit row records what was true in the vocabulary of its time, and
  rewriting history to use a word coined later would be a lie about a table whose whole value is
  that it cannot be edited.
- **Its self-check strips comments before looking for stragglers.** `prosrc` is the whole body,
  prose included, and the first version failed on a function whose new comment *explains* that it
  used to read `is_virtual`. A check that cannot tell a mention from a use forces documentation to
  be thinned to keep it quiet.

**On UPDATE there is no conflict to resolve, and that is arithmetic rather than policy.** Both
columns are two-valued and every row starts in agreement, so an update changing both necessarily
flips both, which agrees again; a caller restating one column at its current value is
indistinguishable from one that never mentioned it. The first version of the trigger guarded
against a disagreement that cannot occur. On INSERT the rule is real, because `is_virtual` has a
default: a row naming only `deployment` arrives with both set, and the one the caller chose wins.

### Revocation reads that record, which is why it never worked (`0063`)

`0038` rotates a decommissioned gateway's broker credential to a password nobody records. **It never
fired for a virtual gateway, which is every gateway a provisioned stack has**, because it gated on
`gateway_holds_a_credential()`. Demonstrated end to end: create a virtual gateway, give it a broker
account, publish, `DELETE` the row, and it went on publishing — with nothing queued in
`net.http_request_queue`, so the revocation was never attempted rather than failing.

**The exclusion was deliberate and its purpose was right.** `0040`'s header says so: *"The guard is
there so revocation cannot CREATE an account by rotating one that never existed, and by that
definition a simulator gateway holds nothing."* Revocation goes through an **add-only** credential
service, so asking it to rotate an account that does not exist provisions one. What was wrong is the
second half — a simulator gateway holds exactly what `provision-gateways.mjs` issued it.

So `0063` swaps both the trigger and the pg_cron sweep onto `gateway_has_broker_credential()`, which
admits a virtual gateway **only when a `CREDENTIAL_ISSUED` row exists**. That closes the leak and
keeps `0040`'s guarantee: a gateway that never held an account still cannot have one created for it
by being deleted. Revoking unconditionally was the obvious alternative and would have traded the
leak for one junk account per gateway ever deleted.

**Two things SQL cannot reach, and both are on the host:**

- **Credentials issued before `0062`** have no record, so the predicate skips them. A re-run of
  `npm run provision:gateways` backfills one for any gateway whose broker account exists — recorded
  as a claim by `scripts/provision-gateways.mjs (backfill)`, because nobody witnessed that mint.
- **Accounts whose gateway row is gone** cannot fire a trigger at all.
  `scripts/revoke-orphaned-broker-accounts.mjs` reads the password file, subtracts every gateway row
  (archived included — those belong to the trigger and the sweep), and rotates what is left through
  `revoke_gateway_credential()`. Dry run by default. It considers only `gwy` + 21 hex characters, so
  it can never select `factoryplus_ingestion` and stop the stack ingesting.

### What the inventory still cannot see

`npm run setup` mints `SUPABASE_INGESTION_KEY` and `SUPABASE_PLAYBACK_KEY` — the keys the ingestion
daemon and the playback worker authenticate with — **before this database exists**. There is
nothing to record into at that moment, and no arrangement of the code changes that.

So on a stack that has never rotated, those two principals show *"No token recorded"*. That is a
statement about **that stack**, not about the platform, and one command closes it:

```bash
npm run keys:rotate          # re-signs both, recording each before it writes
```

**This gap used to be permanent, for a second reason that is now gone.** Those keys were signed for
**ten years** — measured at 3650 and ~2440 days, with no `jti` — and `record_service_token_issued()`
refuses anything past `service_token_max_days()`, so they could never have appeared here however
hard anything tried. They are bounded at 90 days now; see
[Rotating the two service keys](#rotating-the-two-service-keys).

The Access Control page **states its coverage on its face** rather than rendering an empty list that
reads as "nothing outstanding". An inventory whose coverage is unstated is one an operator will
over-trust, and this inventory is the compensating control
[Accepted risks](../README.md#accepted-risks) names by name.

### There is no revocation, so expiry is the whole safety story

`mint-mcp-token.mjs` records the constraint the rest of the design follows from: PostgREST checks
the **signature**, not a session table. Revoking means rotating `SUPABASE_JWT_SECRET`, which
invalidates every token in the stack including the anon and service-role keys.

Three ways of adding revocation were checked and none works. Deleting the `auth.users` row does not
help — the signature is validated and the subject is never looked up. Removing the role does not
either: the relations the i3X address space is assembled from are `FOR SELECT TO authenticated
USING (true)`, so a role-less principal still reads them. A `revoked_at` predicate would have to be
added to **every RLS policy in the schema**.

`pgjwt` is installed and `extensions.sign()` exists, so a `SECURITY DEFINER` RPC could sign a token
without the secret ever leaving the database — technically neat, and it would have made an
unrevocable credential a button press with a tidy audit trail of a thing nobody can undo. **Solving
the wrong half well is worse than not solving it, because the clean implementation reads as safety.**
So minting stays on the host.

Two expiry regimes, and the split is deliberate — but the line falls between **keys that name a
principal** and **keys that name nobody**, not between scripts:

| Key | Expiry | Why |
| :--- | :--- | :--- |
| `mint-mcp-token.mjs` tokens | 30 days default, **90 ceiling** | Pasted into a config file on somebody's laptop. It walks out of the building with the machine, and cannot be revoked, so the expiry is the only bound that exists |
| `SUPABASE_INGESTION_KEY`, `SUPABASE_PLAYBACK_KEY` | **90 days**, rotatable | They carry a `sub`, so they are the same kind of credential as the row above and are bounded by the same ceiling. `npm run keys:rotate` re-signs them |
| `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | 10 years | Not anybody: `role` and no `sub`, so RLS never asks who is calling. They are also the stack's **API keys** — Kong's `key-auth` admits exactly these two literal strings — so shortening them needs a story for re-issuing them to every client at once |

The ceiling is enforced in both the script and the database, deliberately duplicated: what it bounds
cannot be revoked, so it should not be removable by editing one file. `mint-mcp-token.mjs` also
**records before it prints** — the token exists nowhere until stdout, so a failed audit write costs
a row describing a credential nobody holds, where the other order costs an unrevocable credential in
the wild with no record of it.

### Rotating the two service keys

The middle row used to read *10 years*, alongside a note that a short expiry would take the stack
off the air "on a date nobody wrote down, and there is no refresh path". Half of that was right and
the other half was the defect ([#101](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/101)):

* **There is a refresh path**, and building it was cheap because these keys are signed with
  `SUPABASE_JWT_SECRET` and **re-signing them does not rotate that secret**. A new token with a
  later `exp` is valid the instant it is signed, so nothing else is re-issued — not the anon key,
  not the service-role key, not a gateway credential.
* **Length never fixed "a date nobody wrote down"**, it deferred it to 2036 and removed every
  chance to notice on the way. Visibility fixes it, which is what `--check` is for.

```bash
npm run keys:check    # days remaining per key, exits non-zero within 14 days of expiry
npm run keys:rotate   # re-sign both, in place in .env, recording each issuance first
docker compose up -d --force-recreate ingestion playback
```

The restart is **not optional and not automatic**. Both workers read their key once at import
(`os.getenv` in `ingestion.py` and `playback_worker.py`), so until they are recreated they are still
presenting the previous token — which still works, and is exactly what makes it easy to believe a
rotation is finished when it is not. `keys:rotate` ends by saying so.

On Kubernetes `.env` is not the source of truth, so `--print` emits the two assignments without
touching it; update the Secret and `kubectl rollout restart deploy/ingestion deploy/playback`.

**Rotation shortens exposure going forward; it cannot withdraw a key already issued.** PostgREST
validates a signature and consults no table, so the previous key stays valid until its own `exp` —
which is the entire argument for the ceiling. Rotating a 90-day key leaves at most 90 days of
overlap. Rotating a ten-year one left ten years.

### The Access Control page states what is outstanding

Since nothing can be revoked, knowing how many unexpired tokens exist and when the first lapses
*is* the safety story — an inventory question, which is what the page is for. It lists every gateway
with what the platform knows about its broker credential, lists the machine identities on both
planes, lets an Administrator create one, and shows what tokens stand against it.

`tokenStatus()` counts **every** unexpired mint rather than reading the latest, because a re-mint
adds a live credential rather than replacing one — reporting the newer of two would state half the
exposure on the one page whose job is to state all of it.

Built by `0041`–`0044`, `supabase/functions/gateway-credential`,
[`AccessControlTab.jsx`](../frontend/src/components/tabs/AccessControlTab.jsx),
[`credentialState.js`](../frontend/src/utils/credentialState.js) and
[`serviceIdentities.js`](../frontend/src/utils/serviceIdentities.js).

---

## Key Triggers

| Trigger | Table | Purpose |
| :--- | :--- | :--- |
| `trg_*_digital_thread` | `cells`, `gateways`, `devices` | Audit logging |
| `trg_digital_thread_append_only` | `digital_thread` | Rejects UPDATE/DELETE |
| `trg_metric_catalog_immutability` | `metric_catalog` | `name` and `datatype` are wire contracts |
| `trg_metric_group_spelling` | `metric_catalog` | Rejects a group differing only in case |
| `trg_enforce_schema_version_provenance` | `schemas` | A version may only be created by `fork_schema()` |
| `trg_prevent_active_schema_mutation` | `schemas` | A published version is frozen |
| `trg_device_quarantine_webhook_{insert,update}` | `devices` | pg_net notification on transition to quarantined |

> The quarantine webhook is **two triggers sharing one function**, split across INSERT and UPDATE,
> because `TG_OP` cannot appear in a `WHEN` clause and `OLD` is unbound on INSERT. It is a
> *transition* trigger, not a hook on every write — ingestion stamps `last_heartbeat` constantly,
> so a blanket hook would emit ~2 HTTP calls/min/gateway of noise.

---

## Edge Functions

All fail closed: missing or unrecognised role ⇒ `403`.

| Function | Roles | Notes |
| :--- | :--- | :--- |
| [`approve-quarantine`](functions/approve-quarantine) | `Administrator`, `Shopfloor_Manager` | Calls the atomic approval RPC |
| [`deploy-nodered`](functions/deploy-nodered) | `Administrator`, `Shopfloor_Manager` | Deploys **only** the committed flow |
| [`aas-export`](functions/aas-export) | + `Operator`, `Auditor` | Export is a read |
| [`grafana-userinfo`](functions/grafana-userinfo) | any mapped role | OIDC userinfo for Grafana SSO |
| [`nodered-userinfo`](functions/nodered-userinfo) | any mapped role | The same lookup in Node-RED's permission vocabulary |
| [`fplus-directory`](functions/fplus-directory) | any authenticated user | Factory+ Directory adapter — see below |
| [`grafana-alert-webhook`](functions/grafana-alert-webhook) | **no Supabase role at all** | Records a Grafana alert in `platform_alerts` — see below |

### `grafana-alert-webhook` — the one that authorises on a shared secret

Every other function above authenticates a *user* and resolves their role. This one has no user:
Grafana is notifying, not somebody clicking. It authorises on `GRAFANA_ALERT_WEBHOOK_SECRET` and then
writes with its own service-role client.

**Grafana is deliberately not given the service-role key.** That key bypasses RLS entirely and can
rewrite `digital_thread`, and this stack has already corrected the same shape once — Grafana used to
reach the historian as the `postgres` superuser, and the fix was the read-only `grafana_reader` role.
A service fronted by browser SSO gets the narrowest credential that does its job, which here is
"record an alert". Same arrangement as `nodered_webhook_jwt_secret` for the quarantine webhook, in the
opposite direction.

**The check fails closed.** An unset secret answers `503`, never `200` — otherwise a missing
environment variable would turn `Bearer ` into a match and the endpoint into an unauthenticated write
path. The edge runtime boots with `VERIFY_JWT="false"` because each function authorises itself, so
this is the only thing standing in front of the table.

**Alerts with no `sparkplug_id` label are counted and skipped.** A `DatasourceError` notification
carries no device label; inventing one would attribute a broken query to a machine.

### Alert retention (0030)

**Alert occurrences are kept for 7 days and then deleted.** Not archived — nothing reads a historical
alert. The dashboard reads `platform_alerts_active`, which is `DISTINCT ON (fingerprint)` filtered to
`status = 'firing'`; no Grafana dashboard queries the table; and the Realtime subscription wants
change *events*, not persistence. The telemetry that breached the threshold is retained
independently in the historian, so the alert row is derived data whose evidence outlives it.

That is the opposite answer to `digital_thread`, deliberately — one is an audit trail the platform
sells as permanent, the other is a derived record of something already kept elsewhere.

**The predicate is not a flat age cutoff, and this is the part worth reading before changing it.**
`recorded_at` is stamped on the *first* write and never refreshed: the webhook upserts on
`(fingerprint, starts_at)` and its payload omits the column, so Grafana's 12-hourly re-notification
updates status and summary but not age. An alert firing continuously for longer than the window
therefore has one row, older than the cutoff — and

```sql
DELETE FROM public.platform_alerts WHERE recorded_at < now() - interval '7 days';  -- WRONG
```

deletes the current state of a live alert. The pill disappears, the device stops being painted red,
and Grafana still has it firing. `public.prune_platform_alerts()` instead ages out only **closed**
occurrences (from `ends_at`) and **superseded** ones, so the newest row of a firing fingerprint
survives at any age. `test_platform_alerts_retention.py` asserts that, and asserts the naive
predicate would have destroyed the same fixture — so the suite cannot pass vacuously.

Scheduled as `prune_platform_alerts` at 03:15 daily through `ensure_cron_job()`. A fingerprint stuck
`firing` forever is kept forever, by design: growth is bounded by the number of distinct
fingerprints, and a stuck row is a data-quality problem to surface rather than one to delete.

### The Factory+ Directory adapter

`fplus-directory` serves the read half of the Factory+ Directory component's REST contract by
**projecting** tables that already exist. Nothing upstream of it knows the Directory exists — no
column, trigger or ingestion path changed to support it, exactly as `aas-export` is an adapter
rather than an adopted format.

| Endpoint | Returns |
| :--- | :--- |
| `GET /ping` | Service identity and version. **Unauthenticated by specification** |
| `GET /v1/device` | A JSON array of `Instance_UUID`s |
| `GET /v1/device/{uuid}` | One device's Sparkplug address, status and schemas |
| `GET /v1/address/{group}/{node}` | The edge node at that address and the devices behind it |
| `GET /v1/schema` · `GET /v1/service` | Locally minted schema / service identifiers |

**It is served at the unprefixed paths**, not under `/functions/v1/`, because a Factory+ client has
no Supabase `apikey` and no way to acquire one. Those Kong routes are therefore exempt from
`key-auth` — which makes the function itself the **only** thing in front of the fleet's address
space. Every `/v1/` path refuses a request with no bearer token *before it routes*, and
`validate.py` check 11b asserts that 401 rather than trusting it.

It **queries as the caller**, not as the service role: a Directory is a live read over the whole
address space, so running it privileged would hand every authenticated user a view their RLS
policies do not grant them. Its entry in `FUNCTION_REGISTRY` grants no `SUPABASE_SERVICE_ROLE_KEY`,
which makes that structural rather than a discipline.

**What it does not claim.** Schema and service identifiers are this deployment's own UUIDs, and the
response says so (`"namespace": "local"`). Factory+ `Schema_UUID`s are registered against the AMRC
schema repository; returning local ids unqualified would assert an interoperability that does not
exist — the same rule the semantic-id namespace follows.

Two identity mappings need no new columns, which is why this is an adapter and not a migration:
`Instance_UUID` is `devices.id` (already RFC4122), and the Sparkplug address is
`(gateways.sparkplug_group, gateways.sparkplug_id)`.

### Getting a shell into a third-party AAS server

Two routes to the same destination, and it is worth having both before you need either.

**The package.** `?format=aasx` downloads a self-contained OPC container with the 3D model bundled
in as a supplementary part. This is the handover artefact — it needs nothing from this stack once
it has been produced.

**The REST push.** `npm run aas:push-basyx -- --device=Sim_CNC_Mill_01` exports the JSON
environment and POSTs it into a running server's `/submodels` and `/shells`.

The second exists because the AASX carries its Environment as JSON at `aasx/aasenv-root.json` —
valid AAS Part 5, but some BaSyx builds' upload path expects an XML environment part and will
reject or half-load a JSON one. That is a property of the consumer, not of the package, and not
something to discover on the morning of a demonstration.

Three things the script gets right that a hand-rolled client usually does not, verified against
`eclipsebasyx/aas-environment:2.0.0-milestone-15`:

- **Identifiers are base64url-encoded in the path, without padding.** AAS ids are IRIs; AAS Part 2
  specifies base64url for an id appearing in a URL. Sending the raw IRI yields a 404 naming a
  resource that plainly exists, or a 400 from a proxy that split the path on the IRI's own slashes.
- **Submodels are posted before shells.** A shell carries its submodels as references and BaSyx
  accepts one whose references dangle — so shell-first appears to work and leaves an AAS whose
  submodels 404 when a viewer follows them.
- **Re-running skips rather than duplicating**, and `--replace` is the explicit opt-in to `PUT`
  over what is there.

**`AAS_MODEL_PUBLIC_BASE` matters more here than anywhere else.** If BaSyx is in a container,
`localhost` in an exported model URL is BaSyx, not this stack. The exporter now refuses to package
an `.aasx` whose model could not be bundled *and* whose fallback URL is loopback; the JSON export
warns instead, via `model_url_resolves_only_on_this_host` in `stats`, and the push script relays
that warning.

### The worker router

`supabase/functions/main/index.ts` spawns each function as an isolated Deno worker. Two controls:

- **An explicit function allow-list.** `serviceName` comes from the request path, and the edge
  runtime boots with `VERIFY_JWT="false"` because each function checks its own role — so without
  the list, any directory under the mount was bootable by name. An unknown name is a `404` decided
  by the router, not by a worker that starts and then decides.
- **Per-function environment.** The router previously forwarded `Deno.env.toObject()` — the
  *complete* environment — to every worker, handing `SUPABASE_SERVICE_ROLE_KEY`,
  `NODERED_ADMIN_TOKEN` and `GRAFANA_OAUTH_CLIENT_SECRET` to functions with no use for them. Each
  registry entry now lists only what that function reads.

Because each worker is isolated, shared code **cannot** be imported from a sibling directory — a
worker only reads files beneath its own service path. That is why `resolveUserRole` and
`sparkplugToXsd` are duplicated rather than extracted ([issue #9](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/9)).

### `approve_quarantined_device()`

The merge path used to be four sequential PostgREST calls with no transaction and no compensating
rollback: re-key `asset_config`, update the surviving device, delete the duplicate. A failure
partway left `asset_config` pointing at a device that was never merged, or two un-quarantined rows
claiming one physical asset.

It is now one `SECURITY DEFINER` RPC — atomic, granted to `service_role` only, taking the
authenticated `p_actor_id` explicitly and **re-checking that actor's role against
`public.user_roles`** so authorisation does not rest solely on the caller's check.

### `relocate_devices()` — one rearrangement, one causation

`0033`. Takes the WHOLE batch of staged moves as a `jsonb` array and applies it in one
transaction, which is the only reason it exists.

**The audit trail is the point, not the request count.** Device writes go through PostgREST per
row, so reassigning six machines on the Overview page used to be six `UPDATE`s: six transactions,
six `causation_id`s, and six rows in `digital_thread` describing one decision an operator took
once. Nothing in `0033` stamps an audit row — `log_digital_thread_event()` already writes
`txid_current()` on every row, and the shared causation is a *consequence* of the updates sharing
a transaction. That is deliberate: a causation a caller could supply would be an assertion rather
than a fact.

Four properties that are easy to lose and hard to notice losing:

- **Authority is re-derived, not inherited.** `SECURITY DEFINER` means RLS does not apply inside
  the function, so `devices_update_privileged` is never consulted. Its own
  `has_role(ARRAY['Administrator','Shopfloor_Manager'])` check is the *only* thing standing
  between an Operator and the whole shopfloor — a much larger hole than the per-row path ever
  had, created by the very thing that buys atomicity.
- **The batch is all or nothing.** An unknown device or cell anywhere in the array rolls back the
  moves already applied in the same call. A half-applied rearrangement — three machines moved,
  three not, no record the other three were intended — is worse than the immediate writes this
  replaced, not better.
- **`location_scope` is required, never defaulted.** Defaulting to `'cell'` would let a caller
  that omitted the key silently clear `site_wide` off an asset an operator deliberately asserted
  has no single cell.
- **A no-op is reported as `unchanged`, not `applied`.** `0005` suppresses the no-op `UPDATE`, so
  counting it would promise a thread row that deliberately does not exist — and the UI would
  offer a "Same transaction" link into an empty result. The returned `causation_id` is `NULL`
  when nothing changed, for the same reason.

The gateway is deliberately untouched. A drop says where a machine **is**; it says nothing about
which connector reaches it, and expressing location by rewiring the data path is the coupling
archived migration `0036` removed.

`supabase/migrations/test_relocate_devices.py` covers all four, plus the grant baseline — the
`supabase_admin` default ACL grants `EXECUTE` on every new public function to `anon`, so the
`REVOKE` is the only thing narrowing it.

---

## API Gateway (`envoy.yaml`)

**This file is a template, and ONE template serves both deployment targets.** Committing literal
keys would make `.env` no longer authoritative, so the `__UPPER_SNAKE__` placeholders are
substituted outside the container on both paths:

| | Substituted by | Notes |
| :--- | :--- | :--- |
| Docker Compose | `supabase-kong-init` (`sed` into a volume) | |
| Kubernetes | an initContainer in the Kong pod (`sed` into an `emptyDir`) | `supabase-kong-init` has no counterpart |

**Not by Helm at template time**, which is the tempting shortcut and breaks the externally-managed
Secret path in the worst way available: with the Secret owned outside the chart the chart cannot see
the key values, Helm would substitute **empty strings**, and Kong would register empty API keys —
*which `key-auth` accepts*. A gateway that reports healthy with its authentication silently off.

`__REALTIME_UPSTREAM_URL__` is a placeholder for the same reason but a different one: it is the only
upstream that genuinely differs between the targets. Realtime resolves its tenant from the **leading
hostname label**, so it is `realtime-dev.supabase-realtime` (a Compose network alias) or
`realtime-dev` (a Kubernetes Service *named* for the tenant). Both substituters validate that label
and refuse anything else — addressing it by the plain service name makes every WebSocket handshake
fail with a bare 403 that mentions neither tenants nor hostnames.

**Adding a placeholder means adding it to both substituters.** Each scans for surviving markers and
fails loudly, and each skips comment lines — because the template documents the convention by name,
so a whole-file scan would flag the documentation of the rule as a violation of it.

**The edge functions are delivered differently too.** Compose bind-mounts `functions/` for hot-reload;
Kubernetes bakes them into an image (`functions/Dockerfile`, built with the **repository root** as
context because `simulation/node_red_flow.json` sits outside `supabase/functions/`). Baking is what makes "which revision of
`aas-export` is running" a property of the deployed artefact, so a rollback rolls the functions back.

`key-auth` is enabled on `/rest/v1/`, `/realtime/v1/`, `/storage/v1/` and `/functions/v1/`.
**Six routes are deliberately open, across four exemptions**, and every one is load bearing:

| Route(s) | Exemption | Why |
| :--- | :--- | :--- |
| `/auth/v1/` | sign-in | GoTrue authenticates its own callers, and is the OAuth 2.1 server Grafana talks to. Sign-in must work before any session exists |
| `/storage/v1/object/public/` | public objects | An AAS `File` URL must be dereferenceable by a viewer holding no session. Requiring a key would break every shell already handed out |
| `/functions/v1/grafana-userinfo`, `/functions/v1/nodered-userinfo` | OAuth userinfo | An OAuth client presents client credentials, never a Supabase apikey, and **no Grafana setting can add a header to `api_url`** — gated, it 401s and Grafana reports `invalid role`, an RBAC fault rather than a gateway one. Exact paths and not a prefix, because `/functions/v1/` would re-open the whole runtime |
| `/ping`, `/v1/` | Factory+ Directory | A Factory+ client has no apikey and no way to acquire one. `/ping` is open by specification; `/v1/` is authenticated by the **function**, which refuses a request carrying no bearer token and then queries as the *caller*, so RLS still applies |

The public-object exemption is a **separate service** with `/object/public/` baked into its
upstream URL, not an exempt route, because `strip_path: true` would otherwise remove the segment
storage-api routes on.

**This table is asserted rather than maintained by hand.**
[`scripts/check-gateway-surface.mjs`](../scripts/check-gateway-surface.mjs) compares `envoy.yaml`'s
whole routing and authentication surface against a reviewed inventory — which services exist, which
routes they carry, which are gated, and which are open under which exemption. It exists because
`validate.py` asserts the 401s that *should* happen and **nothing can assert the absence of a route
nobody wrote**: a route added here and gated nowhere fails no test that probes. It was written
against the surface rather than against Kong, so it is also the specification a move to Envoy
(roadmap §5) has to satisfy.

> This table said **two** routes until that check was written, and had done since the userinfo and
> Directory exemptions were added. Every one of the four was argued for carefully in the
> gateway config; the
> document it points readers at for the full reasoning listed half of them.

> Adding a plugin name to `KONG_PLUGINS` **replaces** the default `bundled` set rather than adding
> to it. `key-auth` had to be named explicitly or Kong would refuse to start on a config
> referencing it.

---

## Schema Versioning

A published schema is **read-only**. Changing one means forking the next version, editing the
draft, and publishing it.

`fork_schema()` and `publish_schema_version()` are RPCs, not table writes: `version` is computed
from the parent, and publishing must repoint every device and archive the predecessor in one
transaction. `enforce_schema_version_provenance()` rejects a directly-inserted version and
`prevent_active_schema_mutation()` rejects a directly-flipped status — **no manual version input is
possible**.

The freeze is **deny-by-default**: the guard diffs `to_jsonb(NEW)` against `to_jsonb(OLD)` with
`status` removed, so a column added later is frozen when it exists, not when someone remembers.

It binds app-facing roles only (`authenticated`/`anon`/`service_role`), and that is load bearing —
migrations rewrite seeded schemas by name on every boot, so a guard binding `postgres` would break
db-init the first time anyone published a v2. The **status-transition check sits above that bypass**
and binds everyone: history that can be re-opened is not history.

---

## Runtime configuration (`system_settings`)

Values an `Administrator` changes from the dashboard instead of editing a host `.env` and
restarting a container. On a plant the person who needs a retention window changed is rarely the
person with a shell on the machine.

**The key set is closed, and that is the decision the rest follows from.** RLS grants `UPDATE` and
nothing else — no `INSERT` policy, no `DELETE` policy — so a new setting arrives by **migration**,
declared beside the code that reads it. A settings table exists so that *code can read a value*; a
row nobody reads is not configuration, it is a note that looks like configuration. Someone sets
`telemetry_retenton_days`, the page accepts it, nothing changes, and nothing anywhere says why.

It is enforced by the **absence** of policies rather than by a rule someone remembers, so `0031`'s
self-check asserts that absence directly.

| Column | Notes |
| :--- | :--- |
| `key` | Dotted `namespace.name`. **Immutable** — it names the value some code reads |
| `value` / `value_type` | `jsonb` with a CHECK that the pair agrees, so a reader may trust the type |
| `min_value` / `max_value` | Inclusive bounds for a number. NULL means unbounded (`0032`) |
| `fallback_source` | The env var or constant that applies when the row was never changed |
| `updated_by` | Stamped by trigger from `auth.uid()`; **not writable by the caller** |

**Nothing secret goes in this table — that is a rule, not a convention.** Every row is readable by
every authenticated user, deliberately: a setting shapes what a page renders, so an
Administrator-only `SELECT` would break that page for everyone else in a way that reads as a bug.

**Secrets belong in Supabase Vault, managed through Supabase Studio.** The mechanism is already in
use here — `0002` and `0006` store the Node-RED admin token and webhook secret through
`vault.create_secret()` — and Studio ships a Vault UI on both deployment targets. Building a second
secrets interface would duplicate a maintained upstream component and put a security-sensitive
surface into this codebase to own. **Note the trust boundary:** Studio is not gated by this
schema's RLS or `user_roles`. It is protected by network placement and grants database-level
access well beyond what an `Administrator` in the dashboard holds, so the two are not the same
permission and are not necessarily the same person.

**The fallback contract keeps a local boot zero-configuration.** An absent row, an unreadable
table, or a database that has not run `0031` all mean *use the compiled-in default* — so a fresh
install behaves exactly as it did before settings existed. `useSetting()` in the frontend swallows
read errors for that reason; the Settings page itself surfaces them, because there the read is the
subject.

**Adding one** means a migration calling `public.seed_setting(...)` beside the consumer that reads
it. Seeds on first boot and refreshes only the metadata afterwards, so an operator's value survives
every replay — `value` is the one column an operator owns.

---

## Backup and Recovery

Two tiers, and they answer different questions. **Tier 1 recovers data; tier 2 recovers a machine.**
Neither substitutes for the other: a filesystem snapshot cannot restore one dropped table, and a
logical dump cannot boot a dead appliance.

| | Tier 1 — logical dumps | Tier 2 — infrastructure snapshots |
| :--- | :--- | :--- |
| Granularity | One table, one row, one schema | The whole machine or volume |
| Portable across hosts | Yes — plain SQL | No — tied to the hypervisor or CSI driver |
| Recovers from | Bad migration, dropped table, corrupted row | Dead disk, dead node, ransomware |
| Where it runs | `scripts/backup-databases.sh`, or the chart's CronJob | Proxmox Backup Server, CSI, Velero |

### Tier 1: logical dumps

```bash
scripts/backup-databases.sh                  # both databases + the 3D model objects
BACKUP_STAMP=<stamp> scripts/restore-databases.sh
```

Writes three timestamped artefacts plus a manifest into `./backups/` (gitignored — a dump holds
`auth.users`, hashed OAuth client secrets and the whole `digital_thread`). Defaults target Docker
Compose; `BACKUP_MODE=direct` with `SUPABASE_DB_HOST`/`TIMESCALE_HOST` reaches any PostgreSQL.

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `BACKUP_MODE` | `docker` | `direct` to use a local `pg_dump` against host/port |
| `BACKUP_FORMAT` | `plain` | `.sql.gz`. Use `custom` for `.dump` — selective `pg_restore`, and what the chart's CronJob writes |
| `BACKUP_DIR` | `./backups` | |
| `BACKUP_RETENTION_DAYS` | `14` | `0` disables pruning |
| `INCLUDE_STORAGE` | `true` | The `asset-3d-models` objects |

Without a stack, `docker compose exec` directly:

```bash
docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
  pg_dump -Fp -Z6 -U postgres -d postgres > supabase-db.sql.gz
```

Four things about these dumps are not obvious and each has bitten someone:

- **Ownership and privileges stay in the dump, and nine roles must already exist.** A dump contains
  **no `CREATE ROLE`** at all, yet objects are owned by roles and RLS policies reference them **by
  name** — so a dump restored with `--no-owner` produces a database where every policy denies.
  `restore-databases.sh` refuses up front, naming what is missing, because the alternative is
  failing several hundred statements in. Two of the nine are traps:

  | Role | Created by |
  | :--- | :--- |
  | `anon`, `authenticated`, `authenticator`, `service_role`, `supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin` | the `supabase/postgres` image |
  | **`supabase_realtime_admin`** | the **supabase-realtime container**, on its first start — nothing in this repository creates it |
  | **`supabase_functions_admin`** | pg_net's setup. The dump *appears* to create it, but that `CREATE USER` sits inside an event-trigger function **body**, which a restore only defines and never executes — while a plain `GRANT USAGE ON SCHEMA net TO supabase_functions_admin` thousands of lines later *is* executed, and fails |

  Between them, this is why "restore into a stack that has booted once" means the **whole stack**,
  not just the database.

- **Connect as `supabase_admin`, not `postgres`.** `postgres` is not a superuser in the
  `supabase/postgres` image, and the six event triggers (`pgrst_ddl_watch`, `pgrst_drop_watch`,
  `issue_pg_cron_access`, …) are owned by `supabase_admin`. A restore as `postgres` dies on the
  first of them with `must be owner of event trigger pgrst_drop_watch`. Both scripts default to
  `supabase_admin` for this reason.

- **Restore into a freshly initialised database, not over a previously restored one.** The plain
  format carries `--clean --if-exists`, which is what lets it replace the `auth` and `storage`
  schemas the image ships. It cannot, however, drop an *inherited* constraint on Realtime's
  daily `realtime.messages_*` partitions — a second restore over the first fails with
  `cannot drop inherited constraint`. Drop the volume, or the database, first.

- **The historian's password travels inside the dump.** `public.telemetry`'s user mapping carries
  the credential `0001` registered. Restore into a historian whose password differs and the
  wrapper authenticates as nobody — `could not connect to server "timescaledb_server"` — with both
  databases otherwise perfectly restored. The verification step at the end exists to catch exactly
  this.
- **Restore order is fixed: Supabase first, then TimescaleDB, then verify.** `public.telemetry` is
  a `postgres_fdw` foreign table, not a table; restoring the historian first leaves the wrapper
  pointing at nothing, and the failure surfaces as a *relation-level* PostgREST error that reads
  like a schema fault. `restore-databases.sh` enforces the order and then queries through the
  wrapper as `authenticated`, because a restore that loses grants queries fine as `postgres`.
- **The historian restore is wrapped in `timescaledb_pre_restore()` / `post_restore()`.** The
  extension's `_timescaledb_catalog.continuous_agg` carries circular foreign keys — `pg_dump` warns
  at dump time — and restoring it with background workers live leaves the three rollups from `0010`
  registered but never refreshing. The script runs `post_restore()` even when the restore fails,
  because the alternative is a database whose retention, compression and refresh jobs are all
  silently stopped.
- **`digital_thread` is why this matters most.** Telemetry can be re-derived from a rebirth; an
  append-only audit trail cannot.

**This is not PITR.** Recovery is to the last run and no finer. A real RPO wants WAL archiving or
pgBackRest.

### Tier 2: infrastructure snapshots

For the Kubernetes target — CSI `VolumeSnapshot`, Velero, and the storage-PVC gap — see
[`../deploy/k8s/README.md`](../deploy/k8s/README.md#backups). For an on-prem edge appliance running
Compose on a VM, the recommended pattern is **Proxmox VE + Proxmox Backup Server**:

> **`qemu-guest-agent` must be running in the guest, and this is the whole invariant.** Proxmox
> issues `fs-freeze` through the agent before it snapshots, which flushes and quiesces the
> filesystem so both PostgreSQL data directories are captured at one consistent point. Without the
> agent the snapshot is taken live and is **crash-consistent, not transaction-consistent** — it
> restores like a machine that lost power. PostgreSQL will usually recover from WAL, but "usually"
> is doing real work in that sentence, and a snapshot of *two* independent databases taken without
> a freeze can land them at different points in time, which is how `public.telemetry` ends up
> referencing assets the Supabase database has never heard of.
>
> Verify it, rather than assuming it: `qm agent <vmid> ping` from the Proxmox host must answer, and
> `Agent: Enabled` must appear in the VM's Options. Installing the package in the guest is not
> sufficient — the VM option has to be ticked too, and a snapshot taken with it unticked reports
> success.

**Neither tier is a backup until a restore has been rehearsed.** An untested backup is a belief,
not a capability.

---

## Storage buckets and why they differ

Three buckets, created by `scripts/storage-init.mjs` and governed by `storage-policies.sql`. The
first two are opposites in the one setting that matters, and the reasoning belongs together rather
than split across comment blocks in the policy file.

| | `asset-3d-models` | `gateway-backups` | `broker-captures` |
| :--- | :--- | :--- | :--- |
| Public read | **yes** | **no** | **no** |
| Write | `device:manage` (Administrator, Shopfloor_Manager) | Administrator, Shopfloor_Manager | those two, plus the ingestion daemon for one path |
| Read | anyone, including `anon` | those two plus **Auditor** | those two plus **Auditor** |
| Operator | read | nothing | nothing |
| Reached by | a plain public URL | a signed URL, minted after a role check | a signed URL, minted after a role check |

### `asset-3d-models` is public-read, and that is not laziness

An exported AAS `File` element's URL has to be dereferenceable by a viewer holding no Factory+
session — that is what makes the shell a document rather than a pointer into this stack. A signed
URL would expire, which turns every shell already handed out into a time bomb.

The consequence is a constraint on what may go in it: **nothing beyond machine geometry.** Writes
are gated on `device:manage` rather than merely `authenticated`, because an upload both changes
what a shell publishes *and* puts bytes at a world-readable URL.

### `gateway-backups` is private, and holds behaviour rather than secrets

A `flows.json` describes the plant's edge topology, its broker addresses, its device ids and its
processing logic. None of that is public, and there is deliberately no `getPublicUrl()` path for
this bucket.

**`flows.json` only.** `flows_cred.json` — Node-RED's credential store, encrypted with
`NODERED_CREDENTIAL_SECRET` — is excluded on purpose. Stored here it would either be useless (the
secret is not in this bucket) or catastrophic (if the secret ever were). A restored appliance
re-injects its credentials from the environment enrolment wrote, exactly as
`scripts/node-red-init.mjs` already does for the platform's own Node-RED. So a backup describes
behaviour, never secrets.

### The role split is asymmetric on purpose

An auditor's job is to see what the plant was configured to do and when it changed, and a flow
backup is the only artefact that answers that for the edge — so `SELECT` is the point of the role.
`INSERT` would let an auditor rewrite the record they exist to examine, which is the same objection
that makes `digital_thread` append-only.

Operator gets nothing: nothing on the operator dashboard reads or writes a backup, and a role that
cannot use a capability should not hold it.

### The path is confined by the database, not by the uploader

Every object must live under `<sparkplug_id>/`, and that folder must name a gateway that exists.
Same idea as `mosquitto.acl`'s `pattern readwrite spBv1.0/+/+/%u/#` one layer up: **the client does
not get to assert where its data belongs.** A convention the frontend happens to follow is not a
control — Storage's REST API is reachable with any authenticated session.

`SELECT` is deliberately *not* path-confined: a reader may list the bucket to find backups, and
requiring a valid gateway prefix on read would hide the backups of a gateway that had since been
deleted — which is exactly when someone is looking for them.

The trap in writing that policy, and why its test asserts an *accepted* path as well as rejected
ones, is recorded inline in `storage-policies.sql`, because it constrains the SQL on the very next
line.

### `broker-captures` gives one machine principal one object at a time

The ingestion daemon has to put a capture's bytes somewhere, and this is the bucket that had to bend
for it. **The authority cannot be a `SECURITY DEFINER` function**: the bytes travel over the Storage
REST API, `storage.objects` is written by storage-api under the caller's own JWT, and no SQL
function can carry a file into a bucket. So the daemon's access is a policy arm, and
`is_ingestion_caller()` does resolve inside a storage request.

**It cannot be write-only either**, which was the first design and is impossible rather than merely
awkward. Each subject holds exactly one capture, so re-recording *overwrites* it; storage-js spells
overwrite as `upsert: true`; storage-api serves that as `INSERT … ON CONFLICT DO UPDATE`; and
Postgres evaluates the **SELECT** policy too, because the statement has to see the row it conflicts
with. Probed directly, the first insert returned 200 and the upsert immediately after returned
`new row violates row-level security policy`.

**So the arm is scoped rather than narrowed**: `is_ingestion_caller() AND
is_active_capture_object(name)`. The daemon may read, insert and overwrite exactly the one path
named by the job it is currently running, can reach nothing at all in the bucket with no capture in
flight, and never deletes — so nothing is destroyed before its replacement exists, and an orphan is
impossible. Deleting a stale capture stays with the roles that own the bucket, and the browser's
replace confirmation names what it is about to destroy.

**The prefix is the subject recorded**, not the gateway a capture plays back as, so
`is_capture_subject_prefix()` admits a `dev…` folder beside a `gwy…` one — a device is a capture
subject in its own right. `100 MiB`, above the 50 MiB cap `capture_jobs` puts on a recording, so a
capture that completed cannot then fail to upload.

---

## Adding a vocabulary

A **vocabulary** is reference data describing what a standard *defines*. It is deliberately separate
from `metric_catalog`, which records what a device actually *publishes* — that separation is the
reason a vocabulary can be replaced wholesale without touching device configuration. The seeded
standards and how each identity was verified are in [`../docs/vocabularies.md`](../docs/vocabularies.md).

Every vocabulary must satisfy all nine, and CI checks five of them:

1. Migration is **idempotent** (`ON CONFLICT … DO UPDATE`) — db-init replays it every boot.
2. RLS enabled, SELECT policy for `authenticated`, `REVOKE ALL FROM PUBLIC, anon`, no write policy.
3. `metric_groups` rows registered in the migration, carrying `standard` provenance.
4. `NOTIFY pgrst, 'reload schema'`.
5. `node scripts/sync-helm-chart-files.mjs` run and committed (CI checks it with `--check`).
6. Migration header carries a ⚠ VERIFY block naming what was and was not confirmed against the
   source document. **Seeds are transcriptions**; generate them from the machine-readable source
   rather than typing them, and say which source.
7. Frontend mirror module plus unit tests; check whether `scripts/check-docs-drift.mjs` or
   `scripts/check-mirror-drift.mjs` needs a new pair.
8. `docs/openapi.yaml` updated if any endpoint shape changes.
9. **A `STANDARD_NAMESPACES` entry in [`../i3x/address_space.py`](../i3x/address_space.py).** This
   is the one that fails silently: i3X maps `metric_catalog.standard` onto a Namespace, so a
   standard with no entry is **omitted from `GET /namespaces`** — a 200 with a shorter list, which
   reads as "this deployment does not use that standard". The key must be the exact `standard`
   string the migration writes.

---

## Testing

```bash
# No stack required — spins up its own Postgres in CI
python supabase/migrations/test_user_roles_rls.py
python supabase/migrations/test_schema_versioning.py
python supabase/functions/approve-quarantine/test_approve_quarantine.py
python supabase/functions/deploy-nodered/test_deploy_nodered.py
python supabase/functions/aas-export/test_aas_export.py
```

`test_schema_versioning.py` runs its assertions as `authenticated` with simulated JWT claims,
because the immutability guard deliberately exempts the owner — a suite connecting as `postgres`
would pass against a database with the trigger dropped.

`test_aas_export.py` has two layers: offline checks (the Sparkplug→XSD mapper parity guard and the
authorization ladder) always run; live checks invoke the deployed function and validate the emitted
document against the **official IDTA schema**, skipping when no stack is reachable.

---

## Related

- [`../ingestion/README.md`](../ingestion/README.md) — Sparkplug parsing and telemetry mapping
- [`../frontend/README.md`](../frontend/README.md) — how the UI consumes this API
- [`migrations/archive/README.md`](migrations/archive/README.md) — squash verification notes
