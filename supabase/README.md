# Supabase Backend

Schema, row-level security, triggers, and the seven edge functions. Supabase is the authoritative
store for **asset metadata**; time-series telemetry lives in TimescaleDB and is reached through a
foreign-data-wrapper view.

| Path | Purpose |
| :--- | :--- |
| [`migrations/`](migrations) | `0001` schema, `0002` seed data, then nine corrective migrations |
| [`migrations/archive/`](migrations/archive) | The 99 superseded migrations, preserved for their reasoning. **Never executed** |
| [`functions/`](functions) | Deno edge functions and the worker router |
| [`envoy.yaml`](envoy.yaml) | API gateway routes, CORS, and the `apikey` check. **A template** |
| [`seed.sql`](seed.sql) | Demo user accounts |

---

## Migration Baseline

Squashed **three times**. The pre-beta chain became `0001`/`0002` for the public beta; the 72-file
chain that grew on top of it was squashed back into the same two files with a tail of nine; and the
70 files that grew on top of *that* were squashed back into the same two again, with a tail of one.

| File | Contents |
| :--- | :--- |
| `0000_a_database_from_before_the_fold.sql` | The whole corrective tail: every subtraction the baseline cannot express, plus the conversion and the rename it cannot describe |
| `0001_baseline_schema.sql` | Pure DDL. Tables, views, functions, triggers, policies, grants, the FDW, the Realtime publication |
| `0002_seed_data.sql` | Pure DML. RBAC, vocabularies, metric catalogue, settings, secrets, cron, the Playback gateway |

### Why the tail is one file, and why it sorts before the baseline

**A squash can only fold what a fresh install would do anyway.** The baseline states the shape a
new database is built into, so anything ADDITIVE — a table, a column, a function, a seeded row —
folds into it and the old file is redundant. What cannot fold is a SUBTRACTION: `CREATE TABLE IF
NOT EXISTS` does not remove a column that already exists, and a baseline that simply never mentions
`gateways.ip_address` leaves the column sitting on every database that already has one.

The second squash kept nine files applied for that reason, and it could, because each of those nine
was a small file whose *only* content was its subtraction. **The third could not.** Its
subtractions live inside large feature migrations, and a feature migration replayed after the
baseline **reverts** it: `0108` declares `may_decide_proposal()` as it stood at `0108`, the baseline
declares it as it stands now, and the chain runs the baseline first. Kept as they were, the seven
candidate files left nine functions, two comments and a lane list at their older definitions —
which is exactly what the equivalence check reported the first time it was run against the fold.

So the subtractions were lifted out into `0000`, which holds nothing else. It sorts **before**
`0001` rather than after, and has to: it converts the audit table from an ordinary table into a
partitioned one, and the baseline describes it already partitioned — `CREATE TABLE … PARTITION OF`
fails against a database that has not been converted. The rename to `audit_trail` is the same case:
the baseline names the table by its new name only. Once the first block has to run early they
all may as well, and running early is what makes the `archive.bucket` block correct: it decides by
asking whether `system_settings.sensitive` exists yet, which is precisely "has the new schema
arrived", and only `0000` can still ask it.

`0000` is not a precedent for a second pre-baseline file. It is a tail like any other, meant to be
folded away by the next squash.

### The five rules the next fold carries in

Four were found the hard way across the second and third squashes, and a fold that ignores any of
them rebuilds the thing it was run to remove. The second squash's tail held two examples: `0088`
dropped and re-added `change_proposals_entity_type_known` with three lanes and `0090` widened it to
seven two files later, so on a database holding a cells proposal the re-add scanned the rows,
failed, and aborted db-init with every file after it; and `0097` re-added the integer `cells.floor`
on every boot while `0098` dropped it again.

1. **An additive change folds; a subtractive one waits.** A new table, column, function or seeded
   row goes in a new numbered migration and folds into the baseline at the next squash, because a
   fresh install would do it anyway. A drop, a delete or a withdrawn privilege stays in the tail
   until every database that could receive it has.
2. **Constraints are added guarded, never dropped and re-added.** `DROP CONSTRAINT IF EXISTS`
   followed by `ADD CONSTRAINT` scans the rows, and on a populated database the scan is what fails.
3. **A file that creates a function states its own `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon`**
   rather than leaning on `0001`'s sweeper. The sweeper runs earlier in the same boot, so it
   corrects the ACL one boot late — the first-boot window described in
   [the anon sweep](#the-anon-sweep-runs-after-the-functions-exist-archived-migrations-0009-and-0071).
4. **No file re-asserts an absolute set that a later file widens.** A `CHECK` naming every legal
   value, or a self-check counting every expected permission, is correct on the boot it is written
   and wrong on the first boot after something is added.
5. **A tail file carries its subtraction and nothing else.** Anything additive left in it is
   replayed *after* the baseline and silently reverts whatever the baseline had brought forward.
   The corollary is where the tail earns its keep: a fold that NARROWS a view or a function
   signature cannot be reached by the baseline at all, because `CREATE OR REPLACE VIEW` will not
   drop a column and `CREATE OR REPLACE FUNCTION` will not change a return type. The tail drops;
   the baseline rebuilds.


### The baseline is generated, and the equivalence is checked

`0001` is produced from a `pg_dump` of a database the whole chain built, mechanically rewritten
into idempotent form. That is what makes every function appear **exactly once, in its final form**
— `log_audit_trail_event()` was declared five times across the chain, so four of the five bodies
a reader could find were dead, with nothing in the file to say which.

`scripts/generate-baseline-section.mjs` performs the rewrite, and exists because the first two
squashes did it by hand and left nothing behind — so the form had to be re-derived from the
previous baseline each time, and the traps below had to be rediscovered with it.
`supabase/migrations/archive/README.md` has the procedure and the eight faults only the acceptance
test caught.

`scripts/verify-schema-equivalence.mjs` is that acceptance test: it builds a database from each of
two chains and asserts they arrive at the same schema and the same seed rows. Each squash was
landed on its verdict — 72 files and 11 built the identical schema `623d6f6059e2`; 73 and 3 build
`f2b23af251f4`, over 19 non-empty seed tables. The 73rd is `gateways.is_virtual` being retired,
which this fold performs and the chain it replaces did not, so the oracle carries it too.

**And a database UPGRADED through the fold reaches the same digest**, which is new: a floor-era
database given `0000`/`0001`/`0002` dumps identically to a fresh install of them. Neither earlier
squash could have done that, and the rehearsal that proves it is what found out why — see
`supabase/migrations/archive/README.md`, "What an upgrade needs that a dump does not contain".

**One table is deliberately not compared.** `one_shot_migrations` records which one-shot migrations
have *run*, not what the schema declares; a one-shot folded into the baseline has no claim left to
make, and seeding a row on its behalf would forge a claim for a file that is not in the chain. The
counts are printed under their own heading rather than passed over in silence.

**Five things a dump cannot express**, all of them hand-carried into `0001` and each found by a
failing run rather than by inspection:

1. **Roles.** `grafana_reader` is not a schema object and appears in no `--schema-only` dump.
2. **Conditional grants.** `0027`/`0029`/`0036` grant to that role only when `BI_READER_PASSWORD`
   is set; pg_dump sees the resulting ACL and writes a bare `GRANT` that fails with
   `role "grafana_reader" does not exist` on exactly the deployments the condition exists for.
3. **Privilege *absences*.** A dump says what IS granted. The image's default privileges hand
   `anon`, `authenticated` and `service_role` everything, so append-only on `audit_trail` and
   `one_shot_migrations` exists only as four missing words in one ACL line.
4. **Ordering.** `ALTER DEFAULT PRIVILEGES` applies only to objects created after it runs. The old
   baseline had those three lines *after* the tables they govern, where they narrowed nothing.
5. **Publications.** A publication is a database object, not a schema one, so `--schema=public`
   contains no reference to it. Dropping the Realtime setup was invisible to the schema comparison
   and surfaced two migrations later as `0028` reporting the dashboard would never see an alert.

### Seeding is audited now

The baseline creates every trigger before `0002` runs, so a fresh install records 12 rows in
`audit_trail` with `actor_source = 'migration'` describing what the seed inserted. The old chain
recorded 2, because its ordering meant most seeding happened before the triggers existed.

They are written **once, on first boot** — every statement is `ON CONFLICT`, so a replay matches no
rows and adds nothing, and the count holds across restarts. Treat them as a receipt that the seed
ran and what it inserted, not as a per-boot health signal.

#### A setting is declared once

`seed_setting()` is the one seed whose `ON CONFLICT` is `DO UPDATE` rather than `DO NOTHING`: an
operator's `value` has to survive a replay, but the label and the prose beside it have to be
correctable from a migration. The `UPDATE` is guarded on all five metadata columns, so a
declaration that changes nothing writes nothing — no row version, no stamp trigger, no audit row.

That guard does not make a **second declaration** safe, and nothing can. Two files declaring the
same key with different prose both write a real change, in file order, on every boot: the later
sentence lands, the next boot puts the earlier one back, and `audit_trail` — append-only and
partitioned by month because it only grows — accumulates two edits a boot to a setting nobody
touched. `archive.enabled` did this between `0002` and `0132` until the sentence was folded back
into `0002` (#356). Correct a setting's prose **where it is declared**; a second `seed_setting()`
for a key already declared is the defect, not the fix.

Two guards report it. `scripts/check-docs-drift.mjs` reads the declarations out of the chain and
fails on a key declared twice, which is the one that runs at pull-request time and needs no cluster;
`scripts/check-migration-idempotency.mjs` catches it as rows appended to `audit_trail` across a
replay, which is later but does not depend on the declaration being recognisable to a regex.

### Prefixes must be unique, and the order is the filename

`supabase-db-init` applies `/migrations/*.sql` in **glob order** with no applied-migrations
ledger, so the filename *is* the execution order. Two files sharing a prefix still both run —
lexically, by whatever follows the number — which means the order is decided by an accident of
naming and can change under a rename that looks purely cosmetic. Nothing fails, nothing logs; the
ordering is simply not the one anybody chose.

`scripts/check-docs-drift.mjs` asserts unique prefixes across `supabase/migrations/`.
`0006_nodered_oidc_auth.sql` was renumbered from `0003` for exactly this reason.

### How the chain reaches each target

**The db-init image copies this directory** to `/migrations` (`supabase/db-init/Dockerfile`), so a
migration change is an image rebuild: `npm run dev:up -- --only=db-init`.

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
Secret "sh.helm.release.v1.aber.v1" is invalid: data: Too long
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

### The chain has an end, and now it says so (`0072`)

There is no applied-migrations ledger, so **nothing in the database could distinguish "the chain is
part-way through" from "the chain has finished"** — and on Kubernetes something needed to.

The e2e-validate Job is a plain manifest and `db-init` is a `post-install` hook, so Helm creates the
Job **first** and the two run concurrently. The Job's defence was an init container waiting on
`SELECT 1 FROM public.devices LIMIT 1;`. `0001` creates that table. The probe therefore started
passing once **one migration of seventy** had run, and kept passing for the other sixty-nine.

On CI run `33503395769` the conformance suite began publishing while the chain was in its fifties:

```
11:59:43 [ERROR] Error resolving device identity 'devfffffffffffffffffffff':
         column devices.conformance_policy does not exist        <- 0050 had not run yet
11:59:43 [WARNING] DIRECTORY UNAVAILABLE: dropping DBIRTH without registering it
11:59:55 [INFO]  DEPRECATED IDENTITY: device matched by name     <- the chain caught up
```

Checks 1, 1d, 1e and 1f failed; every check that ran after 11:59:55 passed. **It presented as four
flaky quarantine bugs**, because on a runner where db-init won the race the whole suite was green.

`public.schema_bootstrap` is one row that db-init clears before the loop and stamps after
`seed.sql`, and the gate now waits for `completed_at` to be non-null. Three things about it:

- **The clear matters as much as the stamp.** A row left complete by the previous boot would
  satisfy the gate instantly while a `helm upgrade` replayed the chain — the identical race, one
  deployment later.
- **`SELECT 1/count(*) …` is deliberate.** `aber.waitForPostgres` reads the **exit code**, and
  a query matching no rows still exits 0 — which is why the old probe could not have expressed "and
  the chain has finished" whichever table it named. The division makes an empty result an error.

The three alternatives were weighed and rejected in the migration header: waiting on a *late*
migration's artefact goes stale the moment `0073` lands, reading the Job status through the
Kubernetes API needs a ServiceAccount and a Role to run one query, and making the Job a hook at a
heavier weight would turn a failing conformance run into a failed `helm install` — conflating *"the
stack deployed"* with *"the stack conforms"*.

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

### Dropping a `gateways` column (archived migration 0004)

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

### Audit signal and attribution (archived migration 0005)

On a stack running **one** simulated gateway and **one** device, `audit_trail` was taking
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

| Window | `audit_trail` rows added | Traffic in the window |
| :--- | ---: | :--- |
| 7 min 6 s steady state | **0** | 14 heartbeats, 8 rebirths, 60 telemetry samples |

175 rows/hour → **0**. The suppression is not sensitive to fleet size — it is evaluated per row, so
the same measurement holds at 50 gateways.

**The guard now has a test, which it did not before.**
[`test_audit_trail_guard.py`](migrations/test_audit_trail_guard.py) pins both directions: the
two non-events stay unlogged, and — the case a careless per-column implementation drops — a
heartbeat that *also* carries a status change is still logged. `log_audit_trail_event()` is
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

### Metric catalog standards seed (archived migration 0018)

`metric_catalog` is **curated, not accreted**: `ingestion.py` contains no reference to it at all,
and the only insert path is the operator-facing form behind `POST /api/v1/metric-catalog`. Good
property — but it means a mixed-standard fleet is registered by hand, one form at a time, and
`name` is UNIQUE and IMMUTABLE, so the first row to claim a name owns it permanently along with
whichever `standard` and `semantic_id` it was created with. Both flow into the AAS export, and the
`semantic_id` into i3X as the `sourceTypeId` and namespace of the metric's type.

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

**An MTConnect metric's semantic id names its data item type (#457).** The original seed rows and
the Add Metric form once built the id from the whole name (`…/mtconnect/v2.0/Axes/C/ANGLE`), which
names one data item: `Axes/W/POSITION` could never share a concept with `Axes/X/POSITION`, and an
AAS consumer grouping Properties by `semanticId` split them. Every MTConnect row now carries the
vocabulary's concept id (`…/mtconnect/v2.0/DataItemType/ANGLE`), with the component path, instance
and subType left to the name and `sub_type`. `0002` seeds that form, `mtconnectSemanticId()` derives
it, and `0009_mtconnect_metrics_carry_their_data_item_type_id.sql` repoints a database seeded
earlier. It is an UPDATE because `semantic_id` is correctable in place. Only a row still holding
the name-built id is touched, and only when its type is in `mtconnect_vocabulary`; a NOTICE counts
any left behind. `test_metric_catalog_seed.py` holds every MTConnect row to its type's id.

### A semantic id is an IRI or an IRDI (`0012_a_semantic_id_is_an_iri_or_an_irdi.sql`)

**ModelReference is withdrawn, because nothing could emit one.** `schemas.semantic_id_type` and
`metric_catalog.semantic_id_type` allowed `IRI`, `IRDI` and `ModelReference`. `semanticReference()`
in the AAS exporter ignores the type and writes every id as an `ExternalReference` with one
`GlobalReference` key: right for an IRI or an IRDI, wrong for a ModelReference, which is a typed key
chain into a model that one text column cannot carry. The two forms offered it and disagreed about
what it meant, so the first operator to pick it would have published a wrong shell. It can come
back once something emits it, as a reference to a `ConceptDescription` in the same Environment.

`0012` narrows both CHECKs to IRI and IRDI. It first counts rows still holding `ModelReference`,
and fails the boot naming the table and the fix (set IRI or IRDI, or clear the pair, as the owner)
rather than rewriting them: which of the two was meant is the operator's call.
`idta_submodel_templates` already allowed only the two.

**Replaced on each full boot until the next squash.** `0001` replays first and re-asserts its
three-value CHECK, so `0012` sees `ModelReference` in the definition and narrows it again. The
replacement is guarded on that definition, so a replay of `0012` alone changes nothing, and the
pg_dump digest is the same either way. At the next squash the two-value form folds into `0001` and
`0012` retires. `test_metric_catalog_seed.py` holds both CHECKs to refusing `ModelReference`, a
replay to leaving the constraints alone, and a `ModelReference` row to stopping the migration with
the fix in its HINT.

**Correcting an id is a dashboard action now.** A catalog metric's semantic id was always mutable
(`enforce_metric_catalog_immutability()` freezes only `name` and `datatype`); the Metrics page's
Edit sends the pair to `metric_catalog` and nothing else, gated like Deprecate and refused by
`metric_catalog_update_privileged` for anyone but an Administrator. A draft schema's pair, which
`fork_schema()` copies from its parent, is edited in the draft editor and saved with the draft.
`log_audit_trail_event()` already records both as UPDATEs, so neither needed a trigger change.

### A local extension carries no minted id (`0016_a_local_extension_carries_no_minted_id.sql`)

**No id is minted for a local extension (#516).** `0002` seeded `safety_interlock` and
`max_temp_threshold` with `https://aber.local/semantics/local/<name>`. Nothing outside the
installation resolves either IRI, so neither named a concept, and on every fresh stack the schema
builder marked both as mapped, the AAS export left them out of `unmapped_semantic_ids`, and the
Metrics page's "—" cell for an unmapped metric never appeared (#547). `0002` now seeds both with
no id and no type.

`0016` clears a database seeded earlier. `0002`'s catalog inserts are `ON CONFLICT DO NOTHING`, so
the seed alone cannot. It clears the id and its type together, and only while a metric's id is
still exactly the one minted for it, so an id an Administrator has set since stays. Its self-check
asserts that neither metric still holds its minted id, which is its own work; a replay matches
nothing.

**The clear is on the Audit Trail as the platform's own act.** It is an UPDATE on
`metric_catalog`, whose audit trigger `0010` attaches earlier in the chain, so each clear is an
`UPDATE` row in the asset lane with `actor_source = 'migration'`, `changed_by` NULL, and the
minted id in `old_data`. Nothing else was needed: db-init applies the chain as `postgres`, which
`log_audit_trail_event()` files as `migration`. `test_metric_catalog_seed.py` puts the minted
ids back in a rolled-back transaction and holds `0016` to clearing them, recording both clears that
way, keeping an id an Administrator set, writing nothing on a replay, and naming a metric its
self-check finds.

### Metric name format (archived migration 0007)

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

### The Sparkplug group is part of the address (archived migration 0008)

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

### The group belongs to the site, and is fixed at install (`0131`)

`gateways.sparkplug_group` defaulted to the literal `ACS-Cymru` — the platform vendor's name — so
every site published its own machine data under it. The group is the first segment of the namespace
a plant's data lives in, and it belongs to the plant.

It is now `ingestion.sparkplugGroup` in the chart, and it has **no default**: the render refuses
until the site names one, as it does for `ingestion.primaryHostId`. `0131` seeds it into the
`sparkplug.group_id` setting on the first boot, and the column defaults to
`sparkplug_group_default()`, which reads that row and raises if it is absent.

**The setting is read-only and a mismatch raises**, which are two halves of the same decision.
Changing the group at runtime splits the topic tree at that instant: everything published before is
under the old group and everything after under the new one, with in-flight gateways still on the
old one until each is reconfigured. That is a migration, not a preference. So `system_settings`
gained a `read_only` column with a trigger that refuses a value change, and a boot whose chart value
differs from the stored one **aborts db-init** rather than quietly re-pointing the column.

Passing no `sparkplug_group` is not a mismatch: the migration falls back to the same default the
chart ships, which is what leaves the throwaway database and the CI lanes unaffected.

**The default moved with the platform's name at 1.0 (`0003`).** A stack installed before then holds
`ACS-Cymru` in the setting and in every gateway row that took the default. That one pair — stored
`ACS-Cymru`, chart `Aber` — is the rename rather than a disagreement, so `0002`'s check lets it
through and `0003` moves the setting and those rows on the same boot, and only those: a site that
pinned `ingestion.sparkplugGroup: ACS-Cymru` keeps it, and a gateway on some other group keeps that.
The physical gateways are re-pointed by hand, as the last move (archived `0015`) required, and the
order of operations is in [`docs/upgrades.md`](../docs/upgrades.md).

#### Changing it deliberately

There is no supported in-place change, and the procedure below is a fleet reconfiguration rather
than an edit. In order:

1. Stop the ingestion daemon, so nothing is resolving against a moving target.
2. `UPDATE public.system_settings SET read_only = false WHERE key = 'sparkplug.group_id';` then set
   the value, then set `read_only` back. Both statements run as `postgres`; the guard is a trigger,
   not a policy, so `service_role` does not bypass it.
3. Set `ingestion.sparkplugGroup` to the same value and `helm upgrade`. The broker's Directory grant
   and the daemon's topic prefix are both derived from it, so they move together.
4. `UPDATE public.gateways SET sparkplug_group = ...` for every gateway that should move. The column
   is per-row on purpose: a gateway can stay in the old group while the rest move.
5. Re-issue a bundle for every Remote appliance. The flow template carries the group as a literal,
   substituted at bundle time, so a running appliance goes on publishing under the old one.

**History is not rewritten and cannot be.** `resolve_gateway()` resolves on `(group, node)`, so rows
written before the change stay addressed by the old pair. That is the cost the fixed-at-install rule
exists to make visible before it is paid.

### The Directory reports liveness it observed (`0054`)

`directory_services.status` and `.last_heartbeat` were **never written by anything**. The only
writes were `0002`'s seed INSERTs, which contain the literal `'ACTIVE'` — so every stack reported
fifteen healthy services at every age, and `last_heartbeat` held the moment the row was seeded.

**The green pill was the more harmful half**, which is the opposite of how it looks. A stale date
reads as stale and makes a reader suspicious on their own; a green badge is *believed*, and it
would have said ACTIVE for a service that had been down a week. The Directory page had already
corrected this exact class of fabrication once — it used to render a hardcoded `SYNCED / a8f3e4b`
for Node-RED, removed because nothing can observe what Node-RED is running.

`refresh_directory_liveness()` writes both every minute from Prometheus's `up` series. The job names
it joins on are the chart's component names: `0103` renamed the gateway's from the retired scrape
config's `envoy` to `supabase-envoy`, the name the collector labels the pod with, and `0127` added
the two databases once something scraped them.

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

### The Directory names the image each service runs (`0007_the_directory_names_the_image_each_service_runs.sql`)

`directory_services.image` is the image reference the release deploys for a row's workload, and
the Directory's Version column shows its tag. It comes from the chart, not from the cluster:

- `aber.directoryImages` in `_helpers.tpl` renders a JSON map, component to image, using the same
  expression each workload's own `image:` uses. A component the chart does not deploy is left out.
- db-init passes it to every migration as `directory_images`. `0007` calls
  `record_directory_images()` with it, which writes the sixteen chart-managed rows and clears any
  whose component is absent. Rows registered by anything else are not touched.
- A runner that passes no map (`npm run test:db`, `verify-schema-equivalence.mjs`) records nothing.

So the column is the release's pin, recorded at each install and upgrade. It does not see a
container that failed to roll out, or a mutable tag that now points at a different image.
Host Metrics Exporter carries Alloy's image, because node_exporter's collectors run inside Alloy.

The component list is written twice, as the `served_by` rows in `0007` and the helper's lists, and
`check-docs-drift.mjs` holds the two equal and checks that each component is one the chart
renders. Adding a row the chart deploys means adding it to both.

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

This is the same narrowing `0026` applied to `audit_trail`, on the argument that *"a convention
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

**Neither job table gets an audit-trail trigger.** That trigger is opt-in per table, and both
tables carry a progress column the workers update roughly once a second. Adding it would look like
consistency while writing a row per tick into an append-only table no application role can prune,
which is `0005`'s heartbeat problem. Both tables *are* in the `supabase_realtime` publication,
which is how the page follows a running job at all. They are named in the baseline's `intended`
list, because its absolute `SET TABLE` removes any table not on it, and a docs-drift check fails a
subscription to a table that list omits.

**`Service_Playback` (`0056`) is a machine principal in `0048`'s sense** — no user row, reached
through `is_playback_caller()` — and it holds five gates and one storage object, not `service_role`.
The five are `playback_claim_job()`, `playback_progress()`, `playback_finish()`,
`playback_reconcile_jobs()` and `playback_report_credentials()`; the object is the capture of the
job it is running, and only while that job is `RUNNING`.
Its MQTT identity is a separate matter entirely: the worker authenticates to the broker **as the
target gateway**, so the database says what it may do and the broker ACL says what it may publish.
See [Machine identities](#machine-identities) for why the two never collapse into one credential.

**`gateway_has_broker_credential()` exists because `gateway_holds_a_credential()` (`0038`) answers
the opposite question.** The older predicate was `NOT g.is_virtual AND g.enrolled_at IS NOT NULL`, since translated to
`deployment = 'remote'` —
"a Remote gateway that completed enrolment" — which refuses every host-run gateway and admits
only real hardware. For a playback target that is inverted twice over: the target is normally
host-run, and real hardware is exactly what a playback must never publish as. `0041` had already
recorded that a host-run gateway is outside the older predicate's scope by definition. The new one
asks both routes — Remote enrolment, or the `CREDENTIAL_ISSUED` audit row that is the only trace a
host-run mint leaves — and subtracts revocation.

**`0057` exists because the database cannot know what a process holds.** It records what the
playback worker reports on a heartbeat: the gateways it has an MQTT password for, and when it last
said so. The timestamp is the part that earns its place — an empty list with a recent report means
the worker is up and holds nothing, while no recent report means the worker is down, and an empty
list alone cannot tell those apart. Nothing secret is stored; a `sparkplug_id` is the MQTT username
and is on the Gateways page already.

**`0078` makes issuing a playback credential also *deliver* it**, because the two halves being
separate acts is what left this stack unable to play anything back. The Playback gateway is
`gwy16…`; the broker's only gateway account was `gwy11…`, orphaned from a gateway deleted long ago;
`gateway_has_broker_credential()` answered false; and the worker held a `gwy16…` password out of
`.env` that nothing had ever issued. Connecting with it returned `CONNACK rc = 5, not authorised` —
and nothing said so, because `allow_anonymous false` refuses at CONNECT and Sparkplug's QoS 0 gives
a publisher nothing to observe after it.

`gateway_is_playback_delivery_target()` answers whether the password may be delivered, and the
credential service writes it where the playback worker reads when it is true. **The predicate is
`is_simulated` — the same one `start_playback_job()` gates on** — so the set of passwords the worker
can be handed is exactly the set of gateways it may publish as, and `0078` carries a self-check that
fails if the job gate stops using it.

**It is its own function rather than a third column on the authorisation gate, and that is not a
style choice.** It was written as a column first. That worked on the boot which applied it and
killed the next one:

```
0001_baseline_schema.sql:611: ERROR: cannot change return type of existing function
HINT: Use DROP FUNCTION authorize_virtual_gateway_credential(uuid) first.
```

The chain replays in filename order, so `0001` re-declares its own two-column form *before* `0078`
can drop the three-column one — and `CREATE OR REPLACE` cannot change a return type. `0001` aborts
having already dropped the FDW server with `CASCADE`, leaving the stack serving a database with no
telemetry read surface at all.

**The rule, now enforced by `check-docs-drift.mjs`:** a later migration may redeclare a function
`0001` declares, but must not change its return type. `0075` is safe because a new *argument* is a
new signature; `0076` is safe because only the body changed. Same signature, different return type
is the one combination that cannot survive a replay — and it is invisible until the second boot,
which a fresh CI run never reaches.

**Deciding it here rather than in the caller is the whole point.** The credential service holds a
`sparkplug_id` and no database access by design, and the edge function could compute something
similar from the gateway row — which would be a *second* definition of "is this a playback target".
Two definitions eventually disagree, and the disagreement is a real machine's broker password
written into a file the replay worker reads, from where its broker role would let it publish as that
machine.

**Letting the worker mint its own was rejected**, though it needs no delivery mechanism at all. The
credential service's own header states the cost: a holder of its token can *"publish Sparkplug
telemetry as any gateway on the site"*. `playback_worker._credentials()` calls itself **tier two of
three** because the worker cannot authenticate as a gateway whose password it was not given, and a
minting worker deletes that tier. Minting stays a human act with an audit row; only delivery is
automated. The operational half — the file, the mounts, and why `_credentials()` had to stop running
once at startup — is in [`ingestion/README.md`](../ingestion/README.md#issuing-a-playback-credential-delivers-it-0078).

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

**`0107` makes a stopped playback say it was stopped.** `request_playback_stop()` has two arms: a
`PENDING` job no worker has claimed becomes `CANCELLED` immediately, while a `RUNNING` one can only
be flagged — the worker is mid-publish, so it observes `stop_requested` on its next progress call,
stops, and reports the count it reached. Nothing then read the flag again. `playback_finish()`
decided on the error alone, and an interrupted playback carries none, so it was recorded
`COMPLETED`: indistinguishable from a capture published in full, with a lower `messages_sent` as
the only clue and nothing saying the difference was deliberate. The Capture page's failure banner
selects `FAILED` and `CANCELLED`, so a stopped job left no trace there either. The status now reads
the flag, and **an error outranks it** — a job asked to stop that then failed is a failure, because
the error is the half an operator can act on.

**`0109` makes a playback say what the historian refused.** The same shape one layer down: the
ingestion daemon answers a metric stamped outside its sanity window with a **counter**, not an
error, so nothing travels back to the publisher. A capture whose rebased timestamps all fell outside
that window was therefore published in full, recorded `COMPLETED` with its complete `messages_sent`,
and wrote nothing — indistinguishable on the Capture page from a replay that worked (#216). The
worker now computes the count from the plan *before* publishing and splits the case: a plan the
window would discard **entirely** is refused as `FAILED`, naming the first offending timestamp,
because a total no-op is never what anyone wanted; anything that would write something runs, and the
count lands on `playback_jobs.messages_out_of_window` for the page to report. **That refusal is
decided per metric and the count is per message**, because the daemon judges each metric on its own
timestamp and falls back to the payload's only when it has none — so a capture whose every message
loses a reading and keeps another is a capture that writes, and refusing it would fail a replay the
historian would have taken in full. That column is what the worker
*predicted* would be dropped, never what the daemon dropped — nothing reports that — and it reads
zero on every job written before this migration, where it means "nobody counted".

`playback_finish()` is dropped and recreated rather than overloaded, for the reason `0075` gives: a
defaulted fourth argument beside the three-argument form makes a three-argument call ambiguous. The
new argument is **recorded and not judged** — the worker holds the plan and decides there, and a
function that could turn a job the worker had already reported as sent into a failure would be a
second opinion about an event that is over. `0107`'s three arms are unchanged, and a self-check
fails if either its `stop_requested` arm or the new column goes missing from the body.

**Held and current are different facts (`0129`, [#217](https://github.com/Harri-Llewelyn/Aber/issues/217)).**
The broker keeps one password per gateway, so every mint after the first *replaces* one — and
`playback_report_credentials()` carried edge-node ids and nothing else, which do not change on a
rotation. The worker went on reporting a target it could no longer authenticate as, the dialog
offered it, `start_playback_job()` accepted it because the `CREDENTIAL_ISSUED` row existed, and the
broker answered `CONNACK rc=5` a second later.

The worker now also names the gateways it has picked up a **new** password for since it last
reported. Three decisions in that sentence:

- **Ids, not a timestamp.** The database stamps them into
  `playback_worker_status.credential_observed_at` with its own `now()` — the same clock as the
  `CREDENTIAL_ISSUED` row they are compared against. A timestamp taken on the worker would make the
  answer depend on the offset between two clocks, and a credential the worker had just picked up
  could read as older than the issue that delivered it.
- **Ids, not a fingerprint.** `playback_worker_status` is readable by Administrator,
  Shopfloor_Manager and Auditor. A truncated HMAC of the password is not the password but is derived
  from it; a sparkplug_id and a timestamp are derived from nothing. That was the objection recorded
  in the issue and it is the reason this shape was chosen over the obvious one.
- **Nothing new records the issue time.** Every mint already writes a `CREDENTIAL_ISSUED` row,
  including the playback delivery — it is the same edge-function call with `deliver_to_playback`
  set — so only the worker's half was missing.

`playback_stale_credentials()` compares the two and is consulted in both places: the dialog, so a
stale target is not offered, and `start_playback_job()`, so a caller that never opens the dialog is
refused on the same terms. **Absent is unknown, not stale** — a worker that has reported no
observation at all is one from the release before `0129`, and refusing it would break playback on
the rollout that delivers the fix. `p_rotated` defaults for the same reason.

`playback_report_credentials()` DROPs every existing declaration before creating, the way `0118`
does: the baseline recreates the one-argument form on every boot, and two declarations make a call
by name choose neither — which is what [#236](https://github.com/Harri-Llewelyn/Aber/issues/236)
recorded for `playback_finish`. `start_playback_job()` keeps its signature, so its grants survive
and no sweep is needed.

### What is stale, and what is merely quiet (`0029`, `0061`)

`platform_health` is the view most of Grafana's platform rules read (the others read
`gateway_health`, `backup_health` and `audit_trail_partition_health`), and its `gateway_stale`
arm is the only thing standing between an appliance going quiet and somebody being told. It is
therefore also the arm most easily ruined, and it was: `0029` excluded archived gateways and
nothing else, which was correct until `0060` seeded a gateway that is *never* expected to
heartbeat.

**Nothing publishes as the `Playback` gateway until a playback runs**, which is deliberate — it is
why `start_playback_job()` gates on credential possession rather than on `status = 'ONLINE'`. So it
was permanently stale, permanently in the view, and `aber-gateway-stale` fired five minutes after
every boot and never cleared. `0061` adds `AND NOT g.is_shadow`, for exactly the reason `0029`
already gives for archived appliances: *"alerting on it would train an operator to ignore the
rule."*

**`is_shadow`, and not one of the other three flags.** `is_simulated` is carried by every simulator
gateway, and those do heartbeat — their silence is a real fault. `deployment` answers where the connector runs, not
whether anything publishes as it. `is_archived` would mean
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

### A gateway's status is the fleet's word, within limits (`0014`)

`gateways.status` is free text on purpose: a `Gateway_Status` metric names the gateway's own
operating state, so `MAINTENANCE` or `DEGRADED` is as valid as the `ONLINE` and `OFFLINE` ingestion
infers from the message type. The platform writes `PENDING_ENROLLMENT` (issuing a bundle) and
`AWAITING_BIRTH` (`enroll-gateway`), and the column defaults to `OFFLINE`. `STALE` is derived by
`gateway_status` at read time and never stored.

`0014` adds `gateways_status_valid`, which refuses only what no writer may store: a blank status,
one over 32 characters, `STALE` in any case, and the two lifecycle states spelt any way but the
platform's, which the view, the dashboard and `platform_health` compare exactly. The heartbeat gate,
`ingest_record_gateway_health()`, already refused the same values from a gateway; the constraint
holds them for every other writer, a Manager's PATCH included.

**A database that already holds such a status keeps it.** The constraint is not applied, a
`WARNING` in the `db-init` log names each gateway and what it holds, and the first boot after they
are corrected applies it. Nothing is rewritten, because which status was meant is the operator's
call.

---

## Core Tables

| Table | Notes |
| :--- | :--- |
| `cells` | Factory groupings. `name` is still `UNIQUE` — cells are not addressed on the wire |
| `gateways` | Edge gateways. `sparkplug_id` generated column, `location_scope`, `last_heartbeat` |
| `devices` | `sparkplug_id`, `is_quarantined`, quarantine diagnostics, `last_birth_metrics`, `model_3d_path`, `cell_id`, `conformance_policy` (`0050`: `'audit'` records a schema violation and writes the sample anyway, `'enforce'` drops the offending metric) |
| `links` | Arbitrary labelled URLs against any entity: `(entity_type, entity_id, display_name, url, link_tag)`. Renamed from `documents` / `document_tag` by `0049` — nothing about the model was ever document-specific |
| `audit_trail` | **Append-only** audit log, written only by trigger |
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
| `cells`, `gateways`, `devices`, `links`, `asset_config`, `device_submodels`, `directory_services` | `authenticated` | `Administrator`, `Shopfloor_Manager` |
| `schemas`, `metric_catalog`, `metric_groups` | `authenticated` | `Administrator` — see below (`0069`) |
| `audit_trail` (`asset` lane) | `Administrator`, `Shopfloor_Manager`, `Auditor`, or a machine holding `audit_trail:read` (`0013`) | **nobody** — see below |
| `audit_trail` (`security` lane) | `Administrator`, `Auditor` | **nobody** — see below (`0070`) |
| `*_vocabulary` | `authenticated` | **no write policy at all** |
| `roles`, `permissions`, `role_permissions` | `authenticated` | none |
| `user_roles` | own row, or `Administrator` / `Shopfloor_Manager` | none |
| `principal_permissions` | own row, or `Administrator` | none — `create_machine_principal()` is the only write path |
| `machine_principals` | `Administrator`, `Auditor` | none — `create_machine_principal()` writes it with the identity (`0125`); `describe_machine_principal()` (`0126`) is the only path after |
| `webhook_endpoints` | `Administrator` | **no write policy** |

### The two privileged roles, and what separates them (`0069`)

**`Administrator` operates the platform; `Shopfloor_Manager` operates the shopfloor.** Until `0069`
that sentence was not true of anything: `0002` granted both roles **the same thirteen permissions**,
so the distinction between them was the description text on the `roles` row.

The database had already started separating them by hand — `system_settings` for read and for
write, `list_machine_principals()` and `create_machine_principal()` check `Administrator` alone
(as their predecessors `list_service_principals()` and `create_service_principal()` did before
`0080` renamed them), against dozens of sites that check the pair. `0069` makes the permission table agree with that
direction. Three permissions moved:

| Withdrawn from `Shopfloor_Manager` | What it decides | Where it is enforced |
| :--- | :--- | :--- |
| `authz:manage` | who has access | **nowhere yet** — see below |
| `schema:manage` | what contract ingestion validates against | the write policies on `schemas`, `metric_catalog` and `metric_groups`, **and since `0087` the two schema RPCs** |
| `gitops:manage` | what gets deployed to the edge | `PERMISSION_MAP` in [`nodered-userinfo`](functions/nodered-userinfo/index.ts) |

A manager keeps devices, cells, gateways, links, quarantine approval, telemetry, archives and the
audit trail, and goes on **reading** every table above: publishing a schema is a platform act,
resolving what a device conforms to is not.

**The withdrawal had to reach PostgreSQL, and the reason is worth stating.** *No RLS policy in this
schema reads `role_permissions`* — every database control resolves through `has_role()`, and the
permission table is consumed by `usePermissions.js` alone. So revoking a grant, on its own, hides a
button and changes nothing a caller reaches PostgREST with. That is the object this repository
retired `VITE_ALLOW_SIGNUP` for: *"a frontend flag and therefore never an access control."* The
policies moved in the same migration as the grant, and
[`test_role_permission_split.py`](migrations/test_role_permission_split.py) presents a real manager
session to each of the three tables rather than asserting the grant table twice.

**`gitops:manage` needed two doors closed, not one — and there is only one door now.** The Directory
page's Sync button went through `deploy-nodered`, which pushed the flow committed to the repository;
the Node-RED editor deploys directly, and `nodered-userinfo` is what tells Node-RED which permission
tier a session gets. Narrowing only the first would have produced a manager who cannot press the
button and can still deploy — worse than leaving both open, because it reads as a control.

**`deploy-nodered` has since been retired with the demonstrator**, because the flow it deployed was
the demonstrator's and a blank install commits none. So `nodered-userinfo` is now the sole enforcement
point for this permission. A manager keeps `read` there: the editor still opens and the running flow
is still inspectable, which is most of what that page is for when the shopfloor is misbehaving.

**`authz:manage` gates nothing today, and that is the point of doing this first.** `user_roles` and
`role_permissions` carry a SELECT policy each and no other, so **no authenticated caller —
`Administrator` included — can write either through PostgREST**; role assignment is a migration,
the seed, or `handle_new_user()`. Anything said about a manager promoting themselves describes a
control that does not exist yet. The split is therefore a **prerequisite** for building it: the
first role-assignment surface is where `authz:manage` starts meaning something, and it should arrive
into a schema where the two roles already differ rather than one where they do not.

**It is a breaking change** for a deployment where a `Shopfloor_Manager` publishes schemas or
deploys flows. The repair is to make that person an `Administrator`. Multi-factor authentication ([#184](https://github.com/Harri-Llewelyn/Aber/issues/184)) and the audit-domain work both depended on this split — the MFA reset is gated on
`authz:manage`, and the security lane would otherwise have been hidden from a role that could grant
itself the ability to see it. The second of those shipped as `0070`.

### `0069` narrowed the policies and the RPCs went around them (`0087`)

**`0069` narrowed policies. `fork_schema()` and `publish_schema_version()` are `SECURITY DEFINER`,
so they never consulted a policy in the first place** — they run as the owner — and both went on
checking `has_role(ARRAY['Administrator', 'Shopfloor_Manager'])`. The write `0069` withdrew stayed
reachable through the RPC the Schemas page already calls.

Measured on the shipped stack, in one transaction as a `Shopfloor_Manager` holding neither
`Administrator` nor `schema:manage`:

```
UPDATE public.schemas SET status = 'archived' …    →  UPDATE 0     (0069's policy holds)
SELECT public.publish_schema_version(<draft>)      →  succeeded
SELECT status FROM public.schemas WHERE id=parent  →  'archived'
```

The direct write was refused and the RPC performed it. **This is not a cosmetic status flip**:
publishing activates a draft, archives its predecessor and repoints every `device_submodels` row
and the legacy `devices.schema_id` onto the new version, so it changes what ingestion judges every
attached device against.

**`fork_schema()` carried the same gate**, under a comment claiming *"Same allow-list as the RLS
write policies on `schemas`"* — true when written, false the moment `0069` moved those policies
underneath it. This repository already has a name for that shape: an analysis that was right when
written and wrong when read, which is why [`CONTRIBUTING.md`](../CONTRIBUTING.md) has a sweep read
every comment asserting a runtime fact against whatever produces it, rather than leaving it shorter
and still wrong.

**`0087` gates both on `has_authority(ARRAY['schema:manage'])`** rather than on a role name. The
seven policies `0069` narrowed name the role; these two now name the **permission**, so the gate is
the thing that was withdrawn rather than a second spelling of it that the next role change can put
out of step again — which is exactly how they came to disagree. Today the two resolve identically,
because `Administrator` alone holds `schema:manage`, and `0087`'s self-check fails if that stops
being true. It also fails closed for a machine principal, which resolves through
`principal_permissions` where none holds it.

Reading is untouched: `0069` deliberately left all three SELECT policies open because the Devices
page resolves a device's schema through them. `TestTheRpcsDoNotGoAroundThePolicy` in
[`test_schema_versioning.py`](migrations/test_schema_versioning.py) asserts both halves — the
manager refused, and the administrator still able to fork and publish, because a fix that only
broke the function would pass the first assertion alone.

### The anon sweep runs after the functions exist (archived migrations 0009 and 0071)

`0009` revokes EXECUTE from `PUBLIC` and `anon` on every function in `public`, restoring only what
`authenticated` and `service_role` already held. **It runs at position nine.**

PostgreSQL grants EXECUTE on a new function to `PUBLIC` by default and `anon` inherits it, so every
function created by a migration numbered above 0009 was anon-executable from the moment it was
created — the enrolment withdrawal (`0037`), the playback guards (`0056`), the revocation trigger
(`0063`), the audit-domain stamp (`0070`) and a dozen more.

**A restarted stack self-corrects, which is why this survived sixty migrations.** `CREATE OR REPLACE
FUNCTION` preserves the existing ACL, so the second boot's pass of `0009` revokes what the first
boot's pass of a later migration created. The baseline is met from boot two onward, and every
development machine has restarted often enough to look clean.

**A fresh install is boot one.** `validate.py`'s check 13a requires an anon privilege review to
return an *empty* set — *"that is what makes a real finding visible instead of hiding it among
harmless trigger functions"* — and on a first boot it returned twelve. CI builds a database from
nothing on every run and is the only place that state is ever observed; it had been unable to report
since before half of those functions existed.

`0071` extracts the sweep as `revoke_anon_function_privileges()` and calls it. **A later migration
that creates a function must end with the same one-line call**, and `0071`'s self-check fails the
following boot if it does not — naming the omission at db-init rather than an hour later in an
end-to-end run whose message is about `anon`.

The durable answer is an event trigger on `CREATE FUNCTION`, which would need no call site at all.
It is deliberately not taken yet; `0071`'s header records why.

### A fresh install was less locked down than a restarted one (`0001`, issue #117)

The same shape as the anon sweep above, one file earlier and for tables as well as functions.

`0001` ends with a reset:

```sql
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
```

**`ON ALL TABLES IN SCHEMA public` means everything that exists *right now*.** This is position one.
Every object `0011`, `0013`, `0018` and their successors create is born afterwards, holding the
Supabase image's default-ACL grants in full — `arwdDxtm` for `anon` and `authenticated` on tables,
`EXECUTE` on functions — and nothing takes them away until the chain replays on the next boot, when
the sweep finally sees them.

Measured on a first boot: `authenticated` held every privilege on `ashrae223_vocabulary`,
`device_nameplate`, `idta_submodel_templates`, `platform_alerts` and `platform_alerts_active`, plus
`EXECUTE` on twelve functions, most of them trigger bodies. **One restart narrowed all seventeen.**
Only CI ever builds a database from nothing, so only
[`check-migration-idempotency.mjs`](../scripts/check-migration-idempotency.mjs) ever saw it — as a
schema that changed across a replay of the same files.

**The fix stops objects being born wide** rather than sweeping harder afterwards:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
```

Four things about this are worth knowing.

**The settled state does not move.** The sweep already strips `anon` and `authenticated` from every
existing object on every boot, so a running database has no default-ACL grants left to lose. The
change makes boot one match the boot two every deployment is already on — it cannot take away a
privilege anything currently relies on.

**It could not be a new numbered migration.** `ALTER DEFAULT PRIVILEGES` affects only objects created
*after* it runs, so the house rule of adding a new file would have taken effect exactly one boot too
late and fixed nothing on the install that needs it. It lives in `0001` beside the sweep it repairs.

**The sweep could not simply move to the end of the chain**, the way `0071` moved the anon function
sweep. The intended state for `anon` is *nothing*, so a blanket revoke **is** the goal there. The
intended state for `authenticated` is whatever each migration explicitly granted — and a blanket
revoke last would destroy precisely those grants with nothing left to re-apply them.

**`PUBLIC` is deliberately absent from that list.** The image's recorded default for functions is
`{postgres=X,anon=X,authenticated=X,service_role=X}` — `PUBLIC` is not in it — so revoking `PUBLIC`
removes something never recorded and changes nothing, while PostgreSQL still applies its hardwired
`EXECUTE`-to-`PUBLIC` to every new function. Verified against `supabase/postgres:17.6.1.175`: a
function created *after* such a revoke still comes out holding `=X/postgres`. What removes it is
`0071`'s end-of-chain sweep, on the first boot as much as any later one — the two fixes are
complementary, not alternatives.

A self-check in `0001` fails the boot if a future image reinstates the grants.

#### The sweep was copying the privilege it removed

Narrowing the default ACL fixed the five tables and one of the twelve functions. Eleven trigger
bodies stayed divergent, because of a second and independent bug in the sweeps themselves
(`0009`, and `0071`'s extracted `revoke_anon_function_privileges()`):

```sql
IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN keep_auth := keep_auth || fn; END IF;
...
EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn::regprocedure);
...
EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn::regprocedure);
```

**`has_function_privilege()` answers through `PUBLIC`** — and `PUBLIC` is exactly what the revoke
loop is about to take away. So the sweep captured PUBLIC's implicit `EXECUTE` as something
`authenticated` held, revoked `PUBLIC`, and then handed `authenticated` an **explicit grant it never
had**. The sweep meant to preserve a privilege and instead created one.

This is *not* fixed by the default ACL, because `ALTER DEFAULT PRIVILEGES` cannot suppress
PostgreSQL's hardwired `EXECUTE`-to-`PUBLIC` on a new function — the point made above. A function
created earlier in the same boot still carries that grant when the sweep runs. On every later boot
`0001`'s `REVOKE ALL ON ALL FUNCTIONS` has already stripped `PUBLIC`, the same code keeps nothing,
and the schema settles one grant narrower. **First boot only, which is why it survived two sweeps
written specifically to prevent this class of thing.**

The fix reads the ACL directly instead of asking about effective privilege:

```sql
IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
            WHERE p.oid = fn AND a.grantee = 'authenticated'::regrole
              AND a.privilege_type = 'EXECUTE') THEN
```

`aclexplode()` lists grants actually made to the role, and a NULL `proacl` — the untouched default —
yields no rows, which is the right answer. A genuine RPC that a migration granted on purpose still
matches and is still restored.

**The two fixes are independent and both are needed.** The default ACL stops objects being born
with explicit grants; the predicate stops the sweep manufacturing one out of `PUBLIC`.


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

## Audit Trail (`audit_trail`)

Written by `log_audit_trail_event()`, an `AFTER INSERT OR UPDATE OR DELETE` trigger on `areas`,
`cells`, `gateways`, `devices`, `device_nameplate`, `system_settings`, `schemas` and
`metric_catalog` (`0010`); by `log_role_assignment()` on `user_roles`;
and by eight RPCs that record acts which are not row mutations at all.

### Two lanes, and one of them an engineer cannot read (`0070`)

Every row carries an **`audit_domain`** — `asset` or `security` — and a policy per domain replaces
the single policy that used to cover the table.

| Lane | Who reads it | What is in it |
| :--- | :--- | :--- |
| `asset` | `Administrator`, `Shopfloor_Manager`, `Auditor` | `cells`, `devices`, `gateways`, `links` — the shopfloor's own history, **`CREDENTIAL_ISSUED` included** |
| `security` | `Administrator`, `Auditor` | `service_principals`, `user_roles`, `system_settings`, `schemas` |

**`Auditor` stops being a synonym here.** The role holds one permission, `audit_trail:read`, and
until `0070` did nothing a read-only Administrator could not. Reviewing privileged acts without
being able to perform them is separation of duties, which is what the role was named for.

**Two gaps closed together, because closing one alone made it worse.** Nothing recorded a role
grant — an account becoming an Administrator left no row anywhere — and everything the table *did*
record was readable by everyone privileged. Adding role grants to a table a Shopfloor_Manager can
read in full is not an improvement.

**The rule is who may PERFORM the act, not what the act is about.** `CREDENTIAL_ISSUED` stays in
the asset lane because [`0041`](migrations/archive/0041_virtual_gateway_credential.sql) admits a
Shopfloor_Manager to `authorize_host_gateway_credential()`. Filing it as security would mean a
Manager mints a broker credential and the record of their own act disappears — an empty lane is
only honest when the rows in it belong to somebody else.

**The domain is stamped by trigger, never supplied by a caller.** Nine writers insert into this
table. Asking each to pass a domain is asking nine call sites to agree forever, with the failure
being a security row filed as an asset row. `trg_audit_trail_stamp_domain` overwrites whatever
arrives, from `audit_domain_for()` — the same assertion `actor_source` refuses to accept off a
request header.

**It fails closed.** An `entity_type` nobody classified is `security`. The two failures are not
symmetrical: an unclassified asset row is one a Manager cannot see, which is visible and gets
reported; an unclassified security row is a privileged act sitting in a lane a Manager reads,
silently.

**What is not backfilled, and why.** Existing *rows* are classified — they carry an `entity_type`
and an `action`, which is all the classifier reads. Existing *grants* are not: `user_roles` holds
who currently holds what and says nothing about when it was granted or by whom, so a backfill would
have to invent a timestamp and an actor. `0031` sets the bar at *"a half-legible audit entry is
worse than an absent one"*, and a fabricated one is worse than half-legible. **The trail starts
when the trigger does.**

**Two triggers on `system_settings`, and the split is load bearing.** `seed_setting()` rewrites
every seeded row on every boot with the values it already holds and bumps `updated_at` doing it, so
the generic function's own suppression — which compares the rows minus `last_heartbeat` — saw two
rows that differed and logged. `check-migration-idempotency.mjs` caught it: six rows appended as
`migration` on a replay of a table that cannot be pruned. The UPDATE trigger carries a `WHEN` clause
excluding `updated_at` and `updated_by` rather than teaching the shared function about one table's
churn columns.

**`seed.sql` had the same problem from the other direction.** It cleared all four demo personas'
role mappings and re-inserted them on every boot, which became eight audit rows per boot the moment
`user_roles` was audited — a trail reading as though somebody re-granted every persona's role
nightly. It now deletes only the mappings that are *wrong*, which keeps the one-role-per-persona
guarantee and matches no rows on a settled database.

### Append-only, enforced three ways

1. **No INSERT/UPDATE/DELETE grant** to `authenticated`.
2. **`TRUNCATE`, `REFERENCES` and `TRIGGER` revoked.** These were left behind by an original
   `REVOKE INSERT, UPDATE, DELETE` issued against a prior `GRANT ALL` — and **`TRUNCATE` bypasses
   RLS entirely**, so the SELECT policy did not constrain it.
3. **`enforce_audit_trail_append_only()`** — a `BEFORE UPDATE OR DELETE` trigger that raises for
   every application role, `service_role` included. The service key is in the release Secret and is held by
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

`log_audit_trail_event()` now falls back to a session-local GUC, `aber.actor_id`, which
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
than the bug. A machine falls through to the `X-Aber-Actor` header path and is recorded as what
it is, while `changed_by` still receives the principal. The row improved as well as being corrected:
an ingestion write records `'ingestion'` **and** names the identity, where it used to record
`'ingestion'` and `NULL`.

### A header is believed only from the caller it describes (`0020`)

**The header was a claim anyone could make.** For a caller that is not a person, the trigger took
`actor_source` from `X-Aber-Actor` and accepted `ingestion`, `service` and `migration` from anyone;
only `user` was refused. That was harmless while machine identities could not write. `0013` let
them hold `schema:manage` and `proposal:create`, and a machine sending `X-Aber-Actor: migration`
then had its own `fork_schema()` INSERT filed as a migration. `changed_by` still named it, but the
trail's lanes and filters read `actor_source`, and a reviewer scanning for machine activity would
not have found that row.

Each value is now believed only from the caller it describes:

| Declared | Believed when | Otherwise |
| :--- | :--- | :--- |
| `ingestion` | `is_ingestion_caller()`: the token names `Service_Ingestor` | the rules below |
| `migration` | the owner's own session (`postgres` or `supabase_admin`) with no JWT at all, which a PostgREST request never is | the rules below |
| `service` | any caller that is not a person | — |
| anything else, or nothing | — | a machine identity is `service`; any other caller falls to its effective role, as before |

**A machine identity is `service` whatever it sends**, because its `sub` names it in `changed_by`
and no other label describes it. The service-role key, which carries a JWT with no `sub`, can no
longer claim `migration` either. Nothing in the stack sent that value: the daemon sends
`ingestion` under its own identity, and the edge functions and scripts send `service`.
`test_machine_principal_naming.py` sends each value as a machine and finds every row filed as
`service`, and checks that the daemon's identity and the owner's tokenless session are still
believed.

### Reading past the first page (`0077`)

**The page had a cap and no way to say so.** `audit_trail_page()` has returned `truncated`
alongside every response since `0039`, and the Audit Trail tab has stored it in state since then
and *never rendered it* — so a page answering a question about the whole plant with its newest 200
rows was indistinguishable from one showing everything.

**Raising the cap was rejected.** The expensive half of that query is `matching`, which scans every
row the filters select in order to count deleted assets over the whole match rather than over the
page; a bigger page costs more JSON and more DOM without touching that, and only moves the wall.
`0077` adds a keyset cursor instead — `p_before_recorded_at` and `p_before_id`, returned as
`next_cursor`, with the page size unchanged at 200.

**`recorded_at` is not a key, and that is the whole difficulty.**
`log_audit_trail_event()` stamps one transaction's rows with one `now()`, and a batch relocation
of six devices is deliberately one transaction (`0033`). A cursor of *"older than T"* skips the rest
of the batch; *"T or older"* repeats its first row forever. The cursor is therefore the pair
`(recorded_at, id)`, `id` being the primary key and monotonic, and `ORDER BY` matches it exactly —
as does `idx_audit_trail_recorded_id`, because a cursor walking one order against an index in
another is *correct* while degrading to a full sort per page, which nothing notices until the table
is large.

Measured on a fixture of same-timestamp batches: the composite cursor walked **35 of 35** rows
exactly once; the `recorded_at`-only cursor reached **28**, silently dropping seven.
`test_audit_trail_paging.py` runs both, and the naive one is the control — without it the rest of
the suite would pass against a broken cursor on any fixture whose timestamps happened to be
distinct.

**OFFSET would have been wrong here specifically.** The table is append-only and read newest-first,
so rows are inserted at the end the reader started from: between page 1 and page 2 every offset has
shifted by however many events the plant recorded meanwhile, and the reader sees some rows twice and
misses others. For the same reason the tab's 60-second poll **merges** its first page into what is
already loaded rather than replacing it — append-only means held rows cannot change and new ones can
only belong at the top — and starts again only when the two ranges no longer overlap, which is the
one case where prepending would splice a hole into the middle of the list.

### Saying how much of the trail this is (`0115`)

**A page that can be paged still has to say what fraction of the whole it is.** `0077` gave the tab
a way to ask for more; it did not give it anything to say. The legend read "200 events" above a
button offering 200 more, and read the same whether the next page was the last or the third of
twelve. `truncated` says there *is* more and cannot say how much.

`0115` returns **`total_matching`** — how many rows the filters select, counted under the same
purged rule the page opens with, minus the cursor and the limit. It costs one aggregate over a CTE
that was already being scanned in full to count deleted assets, so the number was there to be
returned and was not. It does not move as the reader pages, which is the property the page needs to
render `200 of 467` and have the second number hold still.

**`is_purged` had never gained `areas`.** `0077` anti-joined the three asset tables that existed and
`0097` added a fourth, so a deleted area's rows were counted in the total, were *not* counted by
`purged_assets`, and were hidden anyway by the tab's own client-side filter, which does know about
areas. Server and page disagreed about what the reader was looking at. That costs nothing while
neither prints a number and becomes a wrong number the moment one does — on the development stack,
467 rows drawn under a total of 471.

**A deleted asset could not be searched for.** The trail stores `entity_id` and nothing else about
the entity, so the tab resolved a typed name against its own lookups of the *live* tables and sent
the matching ids as `p_entity_ids`. A name that had been deleted matched no live row, sent an empty
id list, and rendered as an empty trail — the one question the page exists to answer, answered
"nothing happened". **`p_search` matches the id and the same audit-snapshot fields the lane label
falls back to** (`name`, `sparkplug_id`, `schema_name`, `label`, `key`, `role`, `stamp`), so the
search finds what the timeline draws. That list is shared with `snapshotIdentity()` in
`AuditTrailTab.jsx`; a field in one and not the other is a lane you can see and cannot search
for, or the reverse.

**LIKE metacharacters in the search are literal.** The field promises a substring of a name or an
id, and an unescaped `%` would hand the whole trail to somebody who typed a percentage into it. A
self-check asserts a bare `%` does not select every row.

**One label is not in the payload, and it is matched separately.** A role-assignment row is keyed by
`user_roles.user_id` and names the *role*, so the search cannot read a person out of the snapshot
the way it reads a device — and the dashboard labels that lane from `auth.users` (`0116`). A lane
the timeline draws and the search cannot match is exactly the drift the shared field list exists to
prevent, so `audit_trail_user_ids_matching()` supplies that one disjunct. It is SECURITY DEFINER,
Administrator and Auditor only, and returns an **empty array rather than an error** for anybody
else: it is part of a query, and raising would turn "your search matched nothing here" into "the
Audit Trail is broken" for a reader who cannot see that lane anyway.

**Its CTE is `MATERIALIZED`, and that is measured rather than stylistic.** Inlined, Postgres put the
helper in the per-row `Filter` of every partition scan — a `STABLE` function is *allowed* to be
evaluated once and is not promised to be. On the development stack's 4,065 rows that took a search
from 53 ms to **583 ms**; materialised it is 32 ms. That is the shape of cost that reads as "the
trail got big" rather than as a query doing the wrong thing, which is why the suite asserts the
keyword is still there.

**The search is a scan and that is the right shape here.** No index serves `ILIKE`, and a search
matching nothing reads the whole match before the `LIMIT` discards it — but `matching` is already
scanned in full on every call, so this adds a predicate to a scan rather than a scan. Measured on
the development stack, 4,065 rows: a default page 18 ms, a search matching nothing — the worst case,
a full scan the `LIMIT` then discards — 32 ms. `pg_trgm` is the answer if a trail ever outgrows
that.

**A migration that adds an argument breaks the one before it, on the second boot.** `0077` named a
single argument list in its `DROP` and then created its own — correct while it was the last word on
the function, and wrong the moment `0115` came after it. On every replay `0077` recreated the
nine-argument form beside the ten-argument one `0115` had left, and `0077`'s own self-check calls
`audit_trail_page()` **by argument name**, which cannot choose between two candidates. The chain
aborted *inside `0077`*, leaving a half-migrated database — and the first boot could not show it,
because there was nothing yet for `0115` to have left behind. Both files now drop **every**
declaration of the name before creating theirs, so each owns the function at its point in the chain
whatever comes later. A migration adding an argument to a function an earlier one recreates wants
the same treatment.

**What `0115` deliberately does not do** is make an entity type whose *table* has been retired
purgeable. Rows naming a table that no longer exists — `area_floors`, which `0113` retired — are
still drawn, still unfilterable, and still cannot be hidden. "The table is gone" is a different
question from "the row is gone", and it is being decided with the rest of the archival lifecycle.

### What can be shown to be deleted (`0117`)

**The page had two disagreeing answers to "is this entity gone".** The timeline flags a lane
*deleted* when a lookup covering its kind has landed and does not hold the id — schemas included,
since the tab fetches them to name the lane. The purged rule, which decides what is *hidden* and
what `purged_assets` counts, named the four shopfloor tables and not that one. So a deleted schema
wore the flag, could not be hidden, and was not counted — and because that count is what draws the
reveal control, filtering to Schemas produced a page of lanes all marked deleted with nothing
offering to hide them.

It was not a corner case. On the development stack every one of the 122 audited schemas was gone
(`public.schemas` was empty, the residue of `validate.py` fixture runs) and **their 283 rows were
61% of the 467 the default filters selected**. Closing the gap takes the default view to 184.

**Membership is not "is this shopfloor equipment" but "can this function probe a table for the
row".** That is the rule `0077`, `0097` and `0115` were each applying, and each time a table that
qualified was left out for a release. `0117` names six types against five probes:

| type | probed in | why |
|---|---|---|
| `areas`, `cells`, `gateways`, `devices` | their own tables | the four `0077` and `0115` established |
| `schemas` | `public.schemas` | its `SELECT` policy is `USING (true)` for `authenticated`, exactly as the four asset tables' are, so admitting it to a `SECURITY INVOKER` function adds no role that suddenly sees everything as deleted |
| `device_nameplate` | `public.devices` | a nameplate is keyed by its device's id, so it is gone precisely when the device is. No rows carry the type yet; it is listed so it does not inherit this bug the first time one does |

**`user_roles` and `service_principals` stay out.** Both are `auth.users` rows, which a
`SECURITY INVOKER` function cannot read — `audit_trail_user_ids_matching()` exists because of
that. A kind the server can never hide must never be flagged deleted either, so the tab's
`DELETABLE_KINDS` drops `ACCESS` in the same change: **the flag and the filter are now one set on
both sides**, which is the invariant whose absence caused this. `area_floors` stays out for the
different reason `0115` gives — its table was retired, and "the table is gone" is not "the row is
gone".

**The control says "Show deleted entities", not assets.** A schema is a definition rather than
shopfloor equipment, and the count now covers both. The wire key stays `purged_assets`: renaming it
would break every caller to buy nothing a comment cannot say.

**A tolerated lookup reports `null` when it failed, not `[]`.** `/api/v1/schemas` and
`/api/v1/areas` are fetched with a `catch` so the page cannot fail to load because one of them did —
but an empty list and a refused request are the same value and opposite facts. Reading the second as
the first would call every live schema deleted and then hide it, so one `403` would silently empty a
lane. The tab admits a kind to `DELETABLE_KINDS` only once that kind's own lookup has landed.

### Naming the last two lanes (`0118`)

**Two kinds of lane could not name themselves at all**, and each needed a different answer. On the
development stack they were 25 of the lanes drawn: 24 backup jobs and one service principal, every
one of them a bare uuid.

**A backup job has no name, because there is nothing to name.** `backup_jobs` has no name column —
a job is an *act*, not a thing — and its audit payload carries only `origin`, `note` and `status`.
Of those, only `origin` says what the act was, so it joins the shared snapshot field list **last**:
`backups` rows carry an `origin` too and must keep reading as their `stamp`, which is what the
Backups page calls one, and the order of that list is the only thing deciding it.

`origin` is a **category**, not an identity: every job requested by hand shares it. Two jobs
requested in the same minute — which the development stack has twice over — would be one label
drawn twice, and a label you cannot tell apart is worse than the uuid it replaced. So a lane named
from a category carries its short id as the qualifier chip, the same element a schema's `v2` uses.
`CATEGORY_IDENTITY_FIELDS` in `AuditTrailTab.jsx` is that list, and it holds one field.

**The note and the stamp are on two other tables**, and both are what an operator would type into
the search: the note is theirs, and the stamp is what the Backups page shows. Neither is in the
payload, so `audit_trail_backup_job_ids_matching()` supplies that disjunct — the same shape as
the person matcher `0115` added, and **SECURITY DEFINER for the same reason**. `backup_jobs` and
`backups` are Administrator-only while `audit_trail_select_security` admits Administrator *and*
Auditor, so a plain join in a `SECURITY INVOKER` function would let an Auditor see a backup lane and
never search it — silently, an empty disjunct being indistinguishable from no match. The gate inside
is that same pair, and anybody else gets an empty array rather than an error.

It is a **`LEFT JOIN`** deliberately: over half the jobs on a working stack produced no backup —
they were cancelled or they failed — and an inner join would make exactly those unsearchable by
their note as well, which is the only handle they have.

**A service principal's name comes from two places.** The audit row *is* the record of the
identity, which is why `api.js` lists tokens by reading this lane; the three identities a migration
pinned are named from `KNOWN_PRINCIPALS` in `utils/serviceIdentities.js`, and one an Administrator
created from the Access Control page is named from its `machine_principals` row (`0125`), read by
the same two roles that may read this lane. An id in neither keeps its uuid rather than taking
`describePrincipal()`'s `Undocumented principal` fallback: that wording is right on a page listing
one identity and wrong here, where every unnamed principal would draw the same lane.

**This is the one place the search cannot reach a drawn name**, and it is a known exception rather
than an oversight. The three pinned names are held in frontend source and have nothing in the
database to match; the names in `machine_principals` are in the database, and `audit_trail_page()`
does not join them, because a search across one lane's names is not worth a redeclaration of the
function that pages every lane. A service principal is findable by its id, which an operator
reaches through Access Control anyway.

### A device is offline until it says otherwise (`0119`)

**Two devices registered through the dashboard showed as Online having never sent a byte.** The
device insert in `api.js` wrote `status: body.status || 'ONLINE'`, so creating a row asserted that
the machine was running. Nothing would ever have corrected it: the liveness watchdog tracks devices
the ingestion daemon has *seen*, so a device that has never connected is not a device it is
watching.

`status` is **observed, never asserted**. Ingestion writes `ONLINE` on a DBIRTH and the column
defaults to `OFFLINE`, so the dashboard has no business sending one. The insert no longer does, and
the update path guards `status` and `is_quarantined` the way it already guarded the other optional
fields — both are what the platform observed rather than what an operator asked for, and no edit
form sends either.

**The constraint is what stops it coming back.** `devices_online_implies_born` refuses any row that
is `ONLINE` with a NULL `first_dbirth_at`, so the lie cannot be told again from any path — the
dashboard, PostgREST, or a fixture. Every `ONLINE` writer was audited before it was added
(`ingest_set_device_state`, `ingest_register_quarantined_device`, and the approve-quarantine merge
all set `first_dbirth_at`), and the two repository fixtures that would have violated it were
corrected rather than exempted.

**"Awaiting first birth" is not the same as offline**, and the Devices page now says so. A device
that has never spoken is not a device that has stopped speaking: the first is a provisioning step
that has not finished, the second is a fault. The badge is neutral until the device is more than
24 hours past provisioning and only then turns to a warning, and the Offline / DDEATH filter
excludes the never-seen — a filter for things that have *died* should not list things that were
never alive.


### Three ids, one of them spendable (`0121`)

**The event drawer hands a reader three copyable ids and only one of them went anywhere.** Entity ID
had a single consumer in the platform — the global search's `resolveId`, which probes five tables
(areas, cells, gateways, devices, schemas) while the Audit Trail recorded **twelve** kinds. So a
setting, a backup, a backup job, a proposal, a service identity or a person had a copyable id in the
drawer and nothing in the app that would take it. Mutation ID and the transaction had no consumer at
all: no filter, no search, no RPC argument.

**A search term that is nothing but digits now also matches `audit_trail.id` and `causation_id`.**
It is an additional disjunct, so the name and entity-id matching is untouched and an entity whose
name happens to be digits still matches by name — nothing is taken away, rows are only added. Both
columns are indexed: `audit_trail_pkey` leads on `id`, `idx_audit_trail_causation` covers the
other.

The term is **bounded to 18 digits**. `raw::bigint` on a longer run raises `numeric_value_out_of_range`,
which fails the whole page rather than missing a row; bigint's maximum is 19 digits, so 18 can never
overflow, and a longer number is still matched as text like any other search.

**A short numeric term is noisy, and that is not new.** Searching `22` matches the row whose id is 22
*and* every entity whose uuid contains `22` — but the second half is the pre-existing
`entity_id::text ILIKE` disjunct, not something this migration introduced. Real mutation ids are four
digits and up, where a uuid substring collision is rare, so this adds signal to existing noise rather
than noise of its own.

**This is what makes the drawer's "Same transaction" list exact.** The list is derived from the
loaded, filtered events, so it could only ever report the siblings that happened to be on the page,
and the hint said so. Searching the causation id makes the loaded set the transaction, so the count
becomes the answer instead of a floor — and the page drops the hedge exactly when it stops being
true. The control clears the entity and action filters, because one act crosses both by definition:
an approval writes an UPDATE on `devices` and a `PROPOSAL_APPLIED` row, and either filter would show
half of it under a count that reads as the whole.

**The section now renders whenever the row carries a transaction**, siblings or not. It used to
render only when a sibling was loaded — which meant a group whose other members were outside the
filter looked identical to a single-row act *and* hid the one control that resolves the difference.

**RLS is unchanged.** `audit_trail_page()` is `SECURITY INVOKER`, so a Shopfloor_Manager searching
a mutation id reads what `audit_trail_select_asset` admits and nothing more.

**One word per id.** The drawer said *Transaction*, the CSV column said `causation_id`, and the
database column is `causation_id` — so one thing read as two, which is how it was reported as four
ids in a drawer that shows three. The UI and the export now both say **Transaction ID**, the same
precedent `mutation_id` already set for `audit_trail.id`, and each tooltip names its SQL column so
an id can be carried into a query without guessing.


### The drawer knows how many rows a transaction wrote (`0006`)

`audit_trail_page()` returns `transaction_rows` with each event: how many rows share its
`causation_id`, counted over the whole table rather than the page, and `NULL` where there is no
causation. `idx_audit_trail_causation` covers the lookup, so it is one index probe per row on
the page.

**Why the page could not work it out.** The drawer's "Same transaction" list is drawn from the
loaded, filtered events. A transaction whose other rows are outside the entity or action filter, or
on a page not yet fetched, looks identical to a single-row act, so the section hedged and offered
"Show whole transaction" to every event, including the ones where it reloads the same single row.
With the count known the three states are plain: one row, and nothing to offer; every row loaded,
and the list is complete; rows missing, how many, and the control that loads them. The count chip
is the transaction's size minus one, whatever is loaded. A server without the field gets the hedge
back, because a bare sibling list is a lower bound again.

**Counted under the caller's own policies.** The function is `SECURITY INVOKER`, so the subquery
sees what `audit_trail_select_asset` and `audit_trail_select_security` admit. A
Shopfloor_Manager's count omits the security lane, which is the number of rows "Show whole
transaction" could load for them.

**Deleted entities are counted, and the control now reveals them.** A delete's own row is about an
entity no live table holds, so the default view hides it. The count includes it, and "Show whole
transaction" turns the deleted-entities toggle on along with clearing the entity and action filters;
otherwise a reader would be told a row is missing and shown no way to reach it.

The CSV export carries the number as `transaction_rows` beside `transaction_id`.
`test_audit_trail_paging.py` covers the field; `auditTrailCausation.test.jsx` the drawer.

### An approval and the change it made are one act (`0021`)

**Two of the trail's writers stamped no transaction.** `approve_proposal()` writes a
`PROPOSAL_APPLIED` row naming both parties, and the target's audit trigger records the `UPDATE`
the approval made. The trigger stamps `causation_id = txid_current()`; the `PROPOSAL_APPLIED`
INSERT named no `causation_id`, and the column has no default. The drawer groups an event's rows
by `causation_id` and the page counts them, so an approval read as a single-row act apart from
the `UPDATE` it caused, and a search for the transaction id found only the `UPDATE`.
`expire_open_proposals()` wrote `PROPOSAL_EXPIRED` the same way.

Both now stamp `txid_current()` themselves, the way every other multi-row act in the chain links
its rows: an explicit value in the INSERT, the same one the trigger writes in that transaction. No
session variable carries it. An expiry run is one act, so the proposals one run closes share its
id. Rows written before `0021` keep their NULL.

`0021` also restates two COMMENTs that described withdrawn lanes: `validate_change_proposal()`'s
said it refuses a schema-lane proposal whose target is "not a draft", a check archived migration
0090 withdrew with the lane, and `approve_proposal()`'s described the link lanes archived migration
0108 withdrew. `test_change_proposals.py` approves a proposal and finds both rows under one id, and
`audit_trail_page()` counting them as two.


### The lane a Manager was offered and denied (`0120`)

**`audit_domain_for()` classifies every audit row into `asset` or `security`**, and
`audit_trail_select_security` admits Administrator and Auditor alone. `schemas` had never been
listed in either arm, so it took the fail-closed `ELSE 'security'` — while `AUDIT_TRAIL_ENTITY_TYPES`
in `frontend/src/constants.js` declares the kind `asset`, and `auditTrailEntityTypesFor()` uses
that to decide which filters a role is offered. A Shopfloor_Manager was therefore shown a **Schemas**
filter that the policy could only ever answer with an empty timeline.

**The classifier's rule is who may PERFORM the act**, and writing a schema is Administrator-only, so
the default was not obviously wrong. What makes it wrong is the table it audits:
`schemas_select_authenticated` is `USING (true)`. Every authenticated user already reads the schema
registry, so a security lane made the *history* of a world-readable table more secret than the table
itself. The other three security lanes do not have that shape — `user_roles`, `system_settings` and
`service_principals` are restricted to read as well as to write, so their lane and their contents
agree. `schemas` is the one exception the rule needed, and the rule is otherwise kept.

The binding was leaking regardless: `schema_id` is in `GOVERNANCE_FIELDS`, so a Manager could
already see that a schema had been bound to a machine — just not that the schema had ever been
written.

**Existing rows are re-stamped.** `audit_domain` is written once, at INSERT, by
`trg_audit_trail_stamp_domain`, so recorded rows would otherwise keep `security` while new ones
land in `asset`. That split is not free: `test_audit_domain.py` holds the stored column and the
classifier equal for every kind the platform records, and buying the exception means weakening that
invariant — so the correction is the cheaper option. It is **not** the history-rewriting the
append-only trigger's `HINT` refuses: `audit_domain` is the routing decision this migration changes,
not a fact about the act, and no other column is touched. The trigger exempts `postgres`, which is
the role db-init applies the chain as.

**A self-check must assert only what its own migration changed**, and `0120` shipped asserting more
than that. Its check counted every row in the table disagreeing with the classifier, not every
*schema* row — and a database with history has others. The dev stack carried ten `area_floors` rows
stamped `asset` from before [`0113`](#a-floor-becomes-an-area-0113) retired that table, which the
classifier now fail-closes to `security`: rows no migration has ever backfilled, and about which the
classifier's answer is a default rather than a judgement.

An empty database has none of that, so the assertion passed in CI, passed in every `npm run test:db`
run, and **aborted the chain the first time it met a real deployment** — the `db-init` Job failed
four times and took the Helm upgrade down with it. The scope error was copied from
`test_every_row_in_the_table_agrees_with_it`, which had the same blind spot for the same reason and
is now scoped to the kinds `AUDIT_TRAIL_ENTITY_TYPES` declares. The lesson is cheap to state and
was not cheap to find: **a throwaway database cannot exercise an assertion about history.**

**Nothing compared the two sides, which is why this survived twelve migrations.** The lane a kind
belongs to was written down twice in two languages, and `TheDashboardAgreesWithTheClassifier` in
`test_audit_domain.py` now reads the JS table and calls `audit_domain_for()` for each of its
entries. Only the JS side is parsed as text; the SQL side is the function itself, so the check
cannot drift into agreeing with a regex instead of with the database.


### A metric's deprecation reaches the trail (`0010`)

**Deprecating is the only way to retire a metric, and it left no record.** `metric_catalog.name`
is immutable, so deprecate-and-supersede is the exit the catalog assumes, and the Metrics page's
Deprecated Metrics card can now undo it with a confirmed Restore (#468). The table carried no audit
trigger, so neither act said who made it or when. `0010` attaches `log_audit_trail_event()` for
INSERT, UPDATE and DELETE, as on `schemas`. Deprecate and restore are UPDATEs whose diff moves
`deprecated` (and `superseded_by`), the shape archive and restore already have on the asset tables;
the timeline paints `deprecated` rising as Lifecycle, as it paints `is_archived`. No new action
kind was needed.

**The asset lane, for the reason `schemas` is in it.** Writing the catalog is Administrator-only,
which the authority rule files as security, but `metric_catalog_select_authenticated` is
`USING (true)`: every authenticated user reads the catalog, so its history is no more secret than
it is. `audit_domain_for()` is redeclared with `metric_catalog` in the asset arm, the same
signature and return type, and recorded in `check-docs-drift.mjs`'s `INTENDED_REDECLARATIONS`; the
baseline's copy is the pre-`0010` form and folds forward at the next squash.

**Re-stamped on every boot, matching nothing on a settled one.** `0001` replays first and restores
the baseline classifier, which fails `metric_catalog` closed to security, so a row written between
the two files on one boot (a catalog seed `0002` adds in a later release, once the trigger exists)
would be stamped into the wrong lane. `0010` moves any such row to `asset`, which is the routing it
changes rather than a fact about the act, exactly as `0120` did for `schemas`. Its self-check
asserts the lane, every arm it copied, the trigger, and that no `metric_catalog` row is outside the
asset lane: its own work, not the table's.

A replay writes nothing: `0002`'s catalog inserts are `ON CONFLICT DO NOTHING`, and its unguarded
`permitted_values` UPDATE writes the value the row holds, which the function's no-op rule drops. A
restored seed row stays restored for the first of those reasons: no file re-asserts `deprecated`
(`OEE/PERFORMANCE` is seeded deprecated and can be restored). The metric's lane is
labelled from `name` in the snapshot and searchable by it; `audit_trail_page()` needs no change,
and does not call a catalog row deleted (the catalog has no DELETE policy).
`test_audit_trail_guard.py`, `test_audit_domain.py` and `test_role_permission_split.py` cover it.


### The trail draws every lane (`0128`)

**The Audit Trail no longer caps its lanes, so the setting that sized the cap has no reader.**
`ui.digital_thread_lane_limit` folded every lane past the thirtieth behind a "Show all lanes"
button at the foot of the page. Lanes are ordered busiest-first across the whole page, so the
hidden ones belonged to every section, and pressing a button at the bottom expanded rows at the
top — which is what users reported. The cap was a render guard from when the page grew with its
content; the timeline now scrolls inside the card, and a page holds at most 200 events, so there is
nothing left for it to guard.

**A setting nothing reads is a control that does nothing**, which is the rule `0002` states for
declaring one. The row is removed here rather than left as a dead control on the Settings page.
`0002` no longer declares it, but `0002` replays on every boot and `seed_setting()` would not
re-create a row that was never there — the problem is the stacks that already hold it, and this
migration is the `DELETE` for those. Its self-check asserts the key is absent and that the poll
interval, the trail's remaining setting, is still present: properties, not a count of rows.

The deletion is audited like any other write to `system_settings` — the trail records its own
control being retired, under the `migration` actor.

### A lane nothing wrote (`0122`)

**`device_nameplate` was an Audit Trail filter that could only ever answer empty.**
`audit_domain_for()` classified it, `AUDIT_TRAIL_ENTITY_TYPES` listed it, `api.js` unions its
rows into the timeline of the device they name, and the approvals page reads `entity_id` as a
device id. Every consumer was built. The table carried **no trigger of any kind**, so no row was
ever written: a live stack held 4,075 audit rows across eleven entity types and not one was a
nameplate.

**The obstacle was the key.** `log_audit_trail_event()` read `NEW.id`, and `device_nameplate` is
keyed by `device_id` with no `id` column at all — so the trigger could not be attached, and would
not have failed at write time but at `CREATE TRIGGER` time. That is the same shape that made
`log_role_assignment()` a separate function for `user_roles`, whose key is `(user_id, role_id)`.

**A third copy of the attribution ladder was the obvious move and the wrong one.** That ladder is
eighty lines deciding who a caller is — `auth.uid()`, then `aber.actor_id`, then the
`X-Aber-Actor` header, then the effective role — and the copy that already exists carries a
deliberately reduced version that has to be kept in step by hand. `0122` makes the key column a
trigger argument instead, defaulting to `id`, so the seven triggers already attached are untouched
and a table keyed differently needs a trigger rather than a function.

**The cost of that is a silent failure mode, so it is asserted twice.** A trigger argument naming a
column that is not there reads as NULL through `->>` rather than raising, which would file every
row under no entity. `0122`'s self-check walks every trigger bound to the function and checks the
column it names exists on the table it is attached to; `test_audit_trail_guard.py` asserts the
same thing against whatever is actually attached, which is what a later migration can change. The
function also raises by name rather than letting `entity_id`'s `NOT NULL` report it, because that
constraint names `audit_trail` and not the trigger that is wrong.

**The UPDATE arm is gated the way `system_settings`' is.** The nameplate editor upserts the whole
row and stamps `updated_at` on every save, so an operator who opens the form and saves it unchanged
writes a different row — and would file an event whose two snapshots are identical but for a
timestamp, into a table that is append-only. `audit_telemetry_columns()` cannot cover this: it
names the columns a gateway *heartbeat* rewrites, and widening it to `updated_at` would silence
that column everywhere.

**The entity id recorded is the device's.** A nameplate is an assertion about a device, so its
edits belong in that device's history — which is what every reader already expected.

### An area can be proposed (`0123`)

**Areas gained a page in `0097` and a proposal lane only now.** An Operator holds `proposal:create`
and could ask for a change to a device, a nameplate, a cell or a gateway — and on the one rung
between the site and its cells was shown a greyed-out **Edit Details** reading *"Requires Admin
permissions"*, with nothing to do about it. Reported by operators.

This is the missing arm in six places, not a new mechanism: the queue, the per-asset and per-person
caps, the RLS, the expiry and the audit trail already serve any lane the CHECK admits.

**Three columns, which is every column of an area a person chooses.** `id` and `created_at` are the
platform's, and the self-check asserts their absence rather than the allowlist's length — a count
would pass on the boot that wrote it and break on the next migration that adds a column.

**The decide gate resolves a role pair, not a permission, and that is the rule rather than an
exception to it.** Every lane mirrors whatever its target table's own policy resolves, so the lane
closes when that closes. `cells` and `gateways` resolve `cell:manage` and `gateway:manage` because
that is what `cells_update_privileged` and its gateway twin resolve. `areas_update_privileged`
resolves the role pair Administrator / Shopfloor_Manager, and **there is no `area:manage` grant
anywhere in the schema** — so mirroring it means `has_role()` here, the same shape the two device
lanes use. A lane gated on a permission its table does not consult would be a second, disagreeing
answer to the same question.

`approve_proposal()`'s outer gate needed no change: it is the union of everybody who may decide
anything, and an area approver already passes it on the `has_role()` half.

**The validation trigger's areas arm has no archived test, and cannot.** `areas` carries no
`is_archived` column — an area is deleted outright and its cells become unfiled — so existing is the
whole of what there is to check. Every other arm tests both, which is why its absence is commented
rather than left to read as an oversight.

**What the approval can still refuse is the point of approving being applying.** `areas_name_key`,
`areas_name_topic_safe` and `areas_icon_valid` all run on the UPDATE inside the approver's
transaction. A name that was free when the proposal was filed and taken by the time it was decided
aborts the approval with the database's own sentence, and the proposal stays open — rather than
recording an approval of something that did not happen.

Nothing here touches `audit_domain_for()`: `0097` put `areas` in the asset lane and
[`0120`](#the-lane-a-manager-was-offered-and-denied-0120) left it there, so a Shopfloor_Manager can
read the history of what they approved. Nothing touches the `change_proposals` policies either,
which name no lane at all.

### A shape that can be pruned (`0079`)

**The table could only grow, and suppression was never going to fix that.** `0005` already removes
both classes of machine non-event — an UPDATE that changes nothing, and one that moves only
`gateways.last_heartbeat` — and measured on the shipped stack, fourteen minutes of steady state with
heartbeats and rebirths flowing added *zero* rows. That bounds the rate of noise and does nothing
about the total: every row that survives is a real change, every real change is kept forever.

`0079` range-partitions `audit_trail` by month on `recorded_at`, so retiring history is
`DETACH PARTITION` — instant, barely logged, and leaving the data queryable as a standalone table —
instead of a `DELETE` that is fully logged, bloats the heap and needs a `VACUUM` afterwards. The
runbook is in [`deploy/k8s/README.md`](../deploy/k8s/README.md#trimming-the-audit-trail).

**Nothing about who may clear audit rows changes.** `0003` already settles it: the append-only
trigger exempts `postgres` and `supabase_admin` and refuses everyone else, on the stated grounds
that a trigger cannot constrain a role that can issue DDL. Pruning as an owner was always
sanctioned; what was missing was a shape that made it cheap.

**There is a DEFAULT partition, which the plan did not call for, and it is the important decision.**
A range-partitioned table refuses a row no partition accepts — and because the audit INSERT is a
trigger on `cells`, `gateways` and `devices`, a refused audit row **fails the asset write that
caused it**. "Create partitions ahead of need and alert if the next is missing" makes that outage
less likely without making it less severe: the alert fires at the moment the platform stops
accepting writes. The default partition turns the whole failure class into a slow, observable
degradation instead, and `audit_trail_partition_health` is what observes it. A daily `pg_cron`
job keeps three months of headroom, so the default stays empty in every state that has not already
gone wrong.

**A partition does not inherit the parent's ACL, and the default it gets instead is wrong.** The
first conversion produced `audit_trail` as `service_role=rxtm` — correct — beside
`audit_trail_2026_09` as `service_role=arwdDxtm`, which is everything, from the image's default
privileges. The append-only trigger covers a direct `DELETE`, because a row trigger on the parent
fires for every partition; **`TRUNCATE` is not a row operation and raises no trigger at all**, so a
month of audit history was erasable through a table name as a role the platform hands out.
`secure_audit_trail_partition()` strips every application-role privilege at both creation
sites — the conversion and the monthly job — because otherwise the hole reopens every month.

---

## Machine Identities

Four identities on this stack are held by software rather than people, and each is narrow by
construction. They were built as roadmap items 13 and 16; that work is finished, so it is documented
here rather than left on a checklist.

| Identity | Holds | May do |
| :--- | :--- | :--- |
| `Service_Ingestor` (`0046`) | `telemetry:read` | Nothing directly. Eight `SECURITY DEFINER` functions -- seven gates in `0047` plus `record_ingestion_rejection()` from `0026`, brought under the same rule by `0051` -- each checking the caller **is** this principal |
| `Service_Playback` (`0056`) | `telemetry:read` | Nothing directly. The `playback_*` gates, each checking `is_playback_caller()` |
| MCP reader (`0034`) | `telemetry:read` | Reads the five relations the i3X address space is assembled from. Writes nothing; cannot read `audit_trail` |
| `aber_i3x` | broker account | Reads the namespace, publishes nothing |
| `gateway-credential-service` | broker admin, scoped | Adds one broker account and nothing else |

The three database identities are `auth.users` rows with **no email, no password and no identity
provider**, so none can sign in. That is also `0042`'s predicate for listing them, and `0048`'s for
keeping their writes out of the audit trail's `'user'` bucket.

### They hold permissions, not a person's role (`0080`)

**All three used to hold `Operator`**, and the column above used to say so. It was a good choice when
it was made and `0034` records it as one: `Operator` was picked **over `Auditor`** precisely so a
model could not read the audit trail. The role was chosen for the shape it had.

**The shape was not theirs.** `Operator` is a *person's* role — the read-only shopfloor user — and it
is the role that changes whenever somebody asks for an operator to be able to do one more thing.
Every one of those requests silently re-granted three machine identities, and it had already
happened once: a request to let an `Operator` read the asset lane of `audit_trail` was refused by
`0034`'s own self-check. **A change about people was blocked by a property of a machine.**

`0080` gives each principal grants of its own on `principal_permissions` — the machine-side twin of
`role_permissions` — and `has_authority()` resolves a person through `user_roles` and a machine
through those grants. Two things about it are worth knowing before writing a policy against either:

- **A machine principal may not hold a role at all**, and that is enforced rather than assumed:
  `refuse_role_for_machine_principal()` is a `BEFORE INSERT OR UPDATE` trigger on `user_roles` that
  rejects any identity `is_machine_principal()` recognises. Without it the separation is a
  convention, and the next `create_*_principal()` re-introduces the problem in one INSERT.
- **`has_role()` is untouched**, and should stay that way. Fifty-eight policy sites call it, every
  one names `Administrator` or `Shopfloor_Manager`, and no machine principal has ever satisfied one.
  Use `has_authority()` where a policy would otherwise name a role machine principals happen to
  share — which, since `0080`, means `Operator` and nothing else.

The `user_roles` table comment kept saying all three held `Operator` after the baseline fold.
`0032` (`supabase/migrations/0032_machine_principals_hold_no_role.sql`) restates it; `0001` keeps
the old text until the next squash, and `0032`'s comment wins on every boot.

**The change was provably inert when it shipped, which is why it shipped before it was needed.**
`Operator` is named in exactly three places in `0001` and none of them is an RLS policy, so the role
granted these three nothing: every read they depend on is `FOR SELECT TO authenticated USING (true)`.
What it would have granted is the *next* policy naming `Operator` — an approvals queue admitting a
shopfloor user as a proposer would have admitted the ingestion daemon in the same breath.

`create_machine_principal()` and `list_machine_principals()` replace `create_service_principal()`
(`0044`) and `list_service_principals()` (`0042`). **The rename is not cosmetic:** their second
column moved from the role a machine borrowed to the permissions it holds, and `0001` re-declares its
own copy of every function on each boot with `CREATE OR REPLACE`, which cannot change a return type.
Same name, different columns, and the chain aborts at file one on the *second* boot — after `0001`
has dropped the FDW server with `CASCADE`. `scripts/check-docs-drift.mjs` asserts against exactly
that and names the remedy.

### Machines propose, people decide (`0013`)

`create_machine_principal()` allows six permissions and refuses every other one with the reason
that holds for it. A machine passes `has_authority()` and never `has_role()`, so what a grant opens
for it is whatever consults that permission through `has_authority()`:

| Permission | What it opens for a machine | The check that opens it |
| :--- | :--- | :--- |
| `telemetry:read` | Nothing it could not already read: the inventory and the `telemetry` view are open to every authenticated caller, so the grant records what the identity is for | `USING (true)` on the inventory tables; a grant on the view |
| `quarantine:view` | Nothing, for the same reason: the queue is `devices` rows | `devices_select_authenticated` |
| `audit_trail:read` | The trail's asset lane, and the record of deleted assets | `audit_trail_select_asset`, `retired_entities_select_privileged` |
| `archive:manage` | The record of deleted assets. Archiving and restoring check the role pair, so no write | `retired_entities_select_privileged` |
| `proposal:create` | **A write**: files change proposals, which a person decides | `change_proposals_insert_proposer` |
| `schema:manage` | **A write**: forks, publishes and discards schema versions. The `schemas` write policies name `Administrator`, so not a direct edit | `fork_schema()`, `publish_schema_version()`, `discard_schema_draft()` |

| Refused | Why |
| :--- | :--- |
| `device:manage` | Device writes are made by people |
| `quarantine:approve`, `quarantine:reject` | Quarantine decisions are made by people |
| `cell:manage`, `gateway:manage` | For a machine they would only decide proposals, through `may_decide_proposal()`, and deciding is a person's act |
| `authz:manage` | Access control stays with people |
| `link:manage`, `gitops:manage` | No check a machine passes consults them, so the grant would do nothing |

**The old refusal rested on a premise that stopped being true.** It said a token signed for a
principal cannot be revoked, so any write would be an unrevocable write credential.
`revoke_service_token()` and `revoke_service_principal()` (`0074`, `0076`) made that false:
`auth_pre_request()` refuses a withdrawn token or identity on every PostgREST request, and every
check the two writes open is a database check reached through PostgREST. Storage, Realtime and the
edge runtime still honour a withdrawn token until it expires, and none of them consults these
permissions. `service_token_max_days()`'s COMMENT said the same thing and is restated.

**`audit_trail:read` opened nothing on the trail for a machine.** Both lanes named roles, so a
machine granted it read no trail rows while the page said it could; only `retired_entities`
consulted it. The asset lane is now `has_role(Administrator, Shopfloor_Manager, Auditor) OR
has_authority(audit_trail:read)`. For a person nothing moves, because those three roles are the
ones that hold the permission. The security lane is unchanged.

**`may_decide_proposal()` now says what its cell and gateway lanes check.** Its comments said they
resolve what the tables' own policies resolve. `cells_update_privileged` and
`gateways_update_privileged` name the role pair, and the lanes name `cell:manage` and
`gateway:manage`. The permission stays. For a person the two agree, because the pair are the only
roles holding both grants, and no machine can hold either. The role pair would give the same answer
today and lose what `0090` wanted: withdrawing the grant closes the lane.

**Two guards hold it.** `check-docs-drift.mjs` 11e keeps the page's menu equal to the allow-list.
11f names, for each allowed permission, the policy or function it is meant to open, and requires
that check's latest definition to consult it through `has_authority()`. "Consulted somewhere" would
have passed `audit_trail:read` on `retired_entities` alone. `telemetry:read` and
`quarantine:view` are stated as what they are: 11f asserts that what they describe is open to
every authenticated caller and that nothing consults them. It also holds the refusal reasons that
are facts, and `may_decide_proposal()`'s three premises. `test_machine_principal_naming.py` acts as
the machine: it forks and publishes, files a proposal it cannot decide, reads one lane and not the
other, and is refused before its write once revoked.

### Whoever decides a machine's proposal can read its name (`0022`)

**The person deciding saw eight hex characters.** The Approvals page names a proposer by the email
its token carried, and a machine identity has none. The name an Administrator gave the machine is
in `machine_principals`, which only Administrator and Auditor read, so a Shopfloor_Manager deciding
a cell proposal a scheduler filed saw `b0000000` and had to ask who that was.

`list_proposer_names()` returns the name of each machine that filed a proposal the caller may
decide. It filters by `may_decide_proposal()` on each proposal's lane, the gate `approve_proposal()`
decides by, so a caller who decides nothing gets no rows. It does not restate that gate's
permissions: `check-docs-drift.mjs` 11f holds that only the three deciding functions consult
`cell:manage` and `gateway:manage`, which is why a machine is refused them.
**`machine_principals` is not widened**: a policy admitting every decider would hand them every
machine's name and purpose, where this answers only for machines whose proposals they decide. It
lists proposals of every status, because the Decided list names the proposer as well. A person
has no row, since the proposal already carries their email, and nor does a pinned identity, which
has no name; the page keeps the uuid's first eight characters for that case and marks a named
proposer as a machine. `test_machine_principal_naming.py` checks a Shopfloor_Manager gets the name
and an Operator, an Auditor and the machine itself get nothing.

### A person has a name the dashboard can read (`0116`)

**The audit trail could not say who.** `log_role_assignment()` keys a role-assignment row by
`user_roles.user_id`, so a lane on the Audit Trail is one *person's* history — and nothing
served to the browser could turn that id into anybody. `auth.users` is not exposed by PostgREST,
`public.user_roles` is not published to clients, and `list_machine_principals()` returns only the
identities that *cannot* sign in. The lane that answers "who was given what, and when" drew a
shortened uuid, which answers two thirds of the question.

`list_user_accounts()` returns id and email for the other half of `auth.users`. **Membership is
`NOT is_machine_principal()`**, not a second test of its own: `0048`'s header is explicit that a
second definition of "is this a service account" would be worse than the bug it fixed, and this is
where a second one would have gone. The two would agree until the day they did not.

**The gate matches the policy on the rows these names label.** `audit_trail_select_security`
admits Administrator and Auditor, and a role assignment is stamped into that lane — so anybody who
can read the lane can read the names in it, and nobody else learns anything.
Administrator-only, as `list_machine_principals()` is, would leave an Auditor reading a lane of
uuids beside an Administrator reading people: the same record told two ways, which is the one thing
an audit trail must not do.

Email and nothing else. It is the only human-readable identifier `auth.users` carries here —
`raw_user_meta_data` is empty on every account this stack creates — and a read surface over the auth
schema should return the least that does the job. It may be NULL, and the caller falls back to the
id rather than being told the account does not exist.

Every property that makes this safe is in the function body rather than in a grant, because
`authenticated` holds EXECUTE and the function decides. A gate that stops working therefore fails
**open**, silently, with the page looking exactly as it should — so
`test_user_accounts_listing.py` asserts both directions per role, and that `anon` is stopped by the
missing grant before it reaches the body at all.

### The ingestion daemon does not hold `service_role`

It used to, and that was the one credential on this stack whose compromise no policy written
anywhere else could contain — sitting in the process most exposed to the plant network. It now
authenticates as `Service_Ingestor`, a principal holding `telemetry:read` and nothing else, which
cannot write a single row directly — every write it makes goes through a gate in `0047`.

Its grant is not "enough" and that is the design. Every write policy in this schema names
`Administrator` or `Shopfloor_Manager`, so the gates are the **only** route rather than the tidy
one. A credential that could perform those writes by holding a role that permits them would be a
smaller `service_role`, not a narrower one: it could still write anything that role can write, to
any row, in any shape. This one can do exactly eight things.

#### The eighth function, and the five weeks it spent unreachable

`record_ingestion_rejection()` is the daemon's ninth RPC by call count and was not one of `0047`'s
seven, because it already existed: `0026` built it as the narrow gate replacing `service_role`'s
direct INSERT on `audit_trail`. Its access control was its **grant**, which was correct while
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

The daemon presents the **publishable key as the gateway `apikey` and its own token as the bearer**. That
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
trap `devices.asset_type` was retired for — and would make the lane a row anyone holding the cell
permission can rename or delete, taking every host-run gateway out of its lane with it
(`gateways.cell_id` is `ON DELETE SET NULL` since `0112`; before that it deleted them outright).
`unassigned` is already never stored; it is the `ELSE` arm, and these join it as labels rather than
as data.

**Simulated telemetry is treated exactly like real telemetry**, and that is a decision rather than an
omission. Broker playback depends on it: synthetic devices must roll up exactly like real ones,
because that is the behaviour under test. Shorter retention for simulated data would break the one
feature that needs synthetic data to behave normally, and could not be built cheaply anyway —
retention is one policy on one hypertable dropping whole chunks rather than rows.

### The plant gains areas, and a third scope (`0097`)

ISA-95's hierarchy is enterprise, site, area, work center, work unit. The stack had the two lowest
as `cells` and `devices` and the enterprise as `gateways.sparkplug_group`; `0097` adds the two
between, for the Unified Namespace bridge to name a reading's place
([`ingestion/README.md`](../ingestion/README.md#the-unified-namespace)).

- **The site is one setting**, `site.name`, not a table. The plant is one campus; a second is
  the migration that promotes it. The bridge publishes nothing while it is empty.
- **An area is a building**: `public.areas`, with `cells.area_id` nullable and `ON DELETE SET
  NULL`, so deleting a building un-files its cells into the Areas page's queue rather than
  deleting them. `cells.description` is free text, shown as a
  help tip beside the cell's name on the map. `areas.icon` is a closed set of keys
  (`areas_icon_valid`) mirrored by `frontend/src/utils/areaIcon.jsx`, as `cells.icon` is.
- **`location_scope` gains `area_wide`**: a building's BMS, with no single cell and one area. It
  REQUIRES `area_id` and nothing else may store one (`*_area_wide_names_its_area`), for the reason
  `devices.cell_id` has no default: a cell-scoped asset's area is its cell's, derived in
  `device_locations` (`effective_area_id`) and never stored twice. `site_wide` keeps its meaning.
- **Names become topic segments**, so `areas.name` and `cells.name` refuse `/`, `+` and `#`. The
  cell rule is `NOT VALID`: a cell named before `0097` keeps its row and the migration names it
  in a NOTICE.
- **`device_locations` is dropped and recreated**, in `0001` and again in `0097`. `CREATE OR
  REPLACE` can append a column but cannot take one away, so `0001`'s replay after `0097` had
  widened the view would have failed on the second boot. DROP VIEW discards the grants, and both
  files re-apply them, as `ensure_gateway_status_view()` does.
- **The proposal lanes admit the new columns** (`area_id` on devices and gateways, and `area_id`
  on cells), and `approve_proposal()` assigns them; `relocate_devices()` takes `area_id`
  on a move. `approve_quarantined_device()` is dropped and redeclared with `p_area_id` and
  `p_set_area`, so a quarantined device can be approved straight into Area-Wide; the old
  signature has to go first, or PostgREST would find two. `areas` joins the asset audit domain.

Rejected: a many-to-many between devices and sites for a BMS shared by two buildings. Adjacent
buildings are one ISA-95 site, so such a BMS is already Site-Wide; a join table would have made
the view one row per pair, published each reading once per site, and let a per-site ACL leak a
shared device.

### A cell has a place on its area's plan (`0098`, `0113`)

An area carries one SVG plan and a cell takes a place on it as two fractions of the plan's viewBox
(`plan_x` across, `plan_y` down). **A floor is not modelled.** `0098` first made one a row of its
own (`area_floors`) and the Site Map drew one floor of an area at a time; that hid every cell not
on the floor being shown while the count beside it named the whole area, so `0113` retires the
level — each floor above an area's ground floor becomes an area of its own, and a building with two
floors is two areas. `0098` now describes the database this leaves and `0113` moves one that still
has floors, which is `0028`'s split: one migration creates, another moves, and neither fights the
other's replay.

- **A place needs an area**, and `place_cell_in_its_area()` runs BEFORE INSERT OR UPDATE to keep
  it honest. A place is a point on one area's plan and says nothing on another's, so a cell moved
  between areas without being given a new place loses the one it had; a move that names a place
  keeps what it names, which is how the Cells page files and places in a single write. Two placed
  cells in one area keep `site_map.min_pin_spacing` between them, measured by `plan_distance()` in
  units of the plan's shorter side so one number means the same on a wide plan and a tall one. The
  picker on the Cells page refuses the click first; the trigger is the authority, because an
  approved proposal writes the same columns.
- **The plan is an object, never markup.** `areas.plan_path` names an object in the private
  `area-plans` bucket under `<area_id>/`; `is_area_plan_path()` confines the bucket's write
  policies to an area that exists. The bucket and the check were `floor-plans` and
  `is_floor_plan_path()` until 1.0 ([Storage buckets](#storage-buckets-and-why-they-differ) has
  how they moved). `plan_aspect` is read from the SVG at upload, because a place is
  a fraction and the aspect is what turns it back into a distance. The dashboard renders a plan
  through an `<img>` fed a blob URL, where an SVG's scripts, foreign objects and external
  references cannot run.
- **The proposal lane** for cells admits `plan_x` and `plan_y`, and `approve_proposal()` assigns
  them.
- **`areas` joins the `supabase_realtime` publication**, `REPLICA IDENTITY FULL` like the other
  published tables, so a plan attached on the Areas page reaches an open Site Map at once. `0098`
  adds it where the plan is declared; `0001`'s intended list names it too, because its `SET TABLE`
  replaces the whole membership on every replay.

**What `0113` does to a database that still has floors.** Every floor other than the one the Site
Map used to open on — level 0, else the lowest above ground, else the highest basement — becomes a
new area named `<area> <floor>`, sanitised of `/ + #` and de-duplicated first by level and then by
the floor's id. Its cells move to it; the original area keeps its id, its name, its ground floor's
cells and every Area-Wide asset pointed at it. **Plans do not survive**: an object path names the
floor it was uploaded for and SQL cannot move a storage object, so every area starts on the default
outline and a `NOTICE` names the plans to upload again. An open cells proposal naming `floor_id` is
**rejected with a reason rather than edited**: `approve_proposal()` merges a patch with
`jsonb_populate_record()`, which ignores a key with no matching column, so a patch left alone would
approve cleanly having relocated nothing.

Unplaced is a state, not an error: a cell filed in an area with no place is listed beside the plan,
in the area's own panel on the Site Map. Filing a cell into an area is what puts its devices under
the right Unified Namespace topic, and that must never wait on somebody opening a drawing.

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

Raw telemetry leaves the historian one of two ways: the raw window (`timescaledb.retention.retainFor`)
**drops** chunks past it, or cold archival **moves** them. The window never drops a chunk archiving
is waiting on; see *Raw telemetry is kept for a stated window*.

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

**Its settings arrive with their reader**, which is `0031`'s rule: `archive.enabled` (off by
default), `archive.tier_after_days` and `archive.site_key`, all read by
`ingestion/cold_archive.py`. **No credential key will ever be added** — every authenticated user
can read `system_settings`, so no credential key is declared there and the endpoint and bucket are
chart values rather than settings. The S3 secret itself lives in the Vault: `0134` seeds it once
from `secrets.archiveS3SecretAccessKey` and never again, because an Administrator may have set it
since through `set_archive_credential()` from the Cold Storage page, and `cold_archive.py` reads it
back through `cold_archive_destination()`. #353 is where the rule that admits that writer is being
settled. `archive.bucket` was a setting and is retired with the local bucket it named (`0132`).

#### The destination is somewhere else, and only somewhere else (`0132`)

An archived object is **not a backup**: the raw chunk was dropped *because* this object was
verified, so it is the only remaining copy of that span of history. Until `0132` it landed in the
`telemetry-archive` bucket on the storage PVC — one local volume to another local volume, usually
on the same node as the database the rows were rescued from, with the original deleted. A site
loss took both.

There is now no filesystem path, no local bucket and no fallback. "Remote" is not a property the
code can check, and an optional remote destination is one nobody tests: it gets chosen at install
by whoever wants fewest questions, and its worthlessness is discovered on the day it matters. One
destination type means one code path, exercised at every site.

#### Configuring it, which is a page and not a values file (`0134`)

**Cold Storage → Set up cold storage**, as an Administrator: one dialog holds the S3 endpoint,
region, bucket, access key ID and path style, the **secret access key**, and the `archive.enabled`
switch, which it refuses to turn on until the destination is complete. The secret key is not a
setting — it goes into the vault, and nothing reads it back. The other six stay settings rows, and
the Settings page does not list them.

Those five rows are flagged `sensitive`, which is a column `0134` adds to `system_settings` and one
clause on its SELECT policy: `USING (NOT sensitive OR has_role(ARRAY['Administrator']))`. Every
other setting is unflagged, so an Operator's Settings page is unchanged; these five are invisible to
them. That mechanism is the answer to a question `0132` got wrong — it put the whole destination in
`values.yaml` because *one* of its fields is a secret, when an endpoint, a region, a bucket and a
path style are not credentials and an access key *id* is an identifier (issue #351).

**The chart values are a seed, not the source.** A new install can still be configured from
`values.yaml`, and `0134` writes each field into its settings row *only while that row is empty* —
so a chart value configures a fresh stack and never overwrites what an Administrator later set from
the page:

```yaml
coldArchive:
  s3:
    siteKey: "broughton-7f3a9c21"          # frozen at the first boot that sets it; NOT editable
    endpoint: "https://s3.eu-west-2.amazonaws.com"
    region: "eu-west-2"
    bucket: "plant-history"
    accessKeyId: "AKIA..."
    pathStyle: false                       # true for MinIO and most self-hosted gateways
secrets:
  archiveS3SecretAccessKey: "..."          # seeded into the vault on the first boot only
```

The **site key** is the exception and stays install-time: it is the IAM prefix every object is
already addressed under, so it is frozen read-only by `0132` and changing it is a procedure rather
than an edit.

**Re-pointing a destination that has been written to is refused.** Change the bucket while `--drop`
is on and the next run writes into an empty bucket while still deleting originals; `cold_archive
audit` then reports every earlier object missing, and those objects are the only copies. So
`archive_destination_guard()` refuses a change to the endpoint or bucket once the manifest holds
anything. Setting one for the first time is not a change. If the historian cannot be reached the
change is allowed with a warning rather than refused — an unrelated outage must not block
first-time configuration.

**The page reports the state it is in.** With archiving switched on and the destination incomplete,
the Cold Storage page says so and lists what is missing, in the same words the exporter's own
refusal uses. That combination — on, and unable to run — is otherwise a CronJob that fails nightly
and deletes its own pod.

"S3" names a protocol, not a vendor — AWS, Cloudflare R2, Backblaze B2, Wasabi and a MinIO in
another building all serve it, and the code never knows which. Leave any of it unset and nothing is
exported: the exporter names every missing variable and stops.

**One requirement of the endpoint beyond the core API:** it must accept `x-amz-checksum-sha256` on
`PutObject`, which is how the store is made to validate the payload rather than merely receive it.
AWS, R2, B2 and MinIO releases from 2022 onward all do. An endpoint that rejects the header fails
every upload with the chunk still in the hypertable — loudly, and losing nothing.

**Under `networkPolicy.enabled` this needs an egress rule.** The chart cannot express a peer
outside the cluster, so add the endpoint to `networkPolicy.extraEgress`. Without it every export
fails at connect time, on a schedule, at 03:15.

#### The object key, and why each segment is there

```
site=broughton-7f3a9c21/dataset=telemetry/v=1/year=2026/month=03/20260302T000000Z-20260309T000000Z.parquet
```

`key=value` directory names are read as columns by DuckDB, Spark and Arrow, so a reader skips whole
prefixes without opening a file.

- **`site=` is leftmost, and that is load-bearing.** An IAM policy scopes on a left-anchored
  prefix, so anything to its left makes a per-site credential impossible to write. It is also what
  makes one bucket safe for two sites: chunk numbering is per database, both fresh installs begin
  at `_hyper_1_1_chunk`, and the upload overwrites without complaint.
- **`dataset=`** leaves room for a rollup or a second hypertable without renaming what is written.
- **`v=`** is the escape hatch: an incompatible change writes `v=2` and every existing reader keeps
  working against `v=1`. Nothing is ever rewritten.
- **The leaf is the time range, not the chunk.** `_hyper_1_42_chunk` says nothing to a human and
  does not survive a restore into a fresh database. A range sorts lexically, describes itself, and
  makes a retry produce the same key — which is what keeps overwrite-on-retry correct rather than
  dangerous.

**The month-boundary rule.** `year=`/`month=` come from `range_start`, and a chunk can span up to
seven days, so a chunk can straddle a month: one beginning 29 March holds April
readings under `month=03`. The manifest is the authoritative index; the partitions are a
convenience for a reader that does not have it, and such a reader must widen by one partition on
each side.

#### The site key is frozen, and changing it is a procedure

`archive.site_key` is seeded read-only by `0132` from `coldArchive.s3.siteKey` on the first boot
that supplies one, and a later boot whose chart value differs **raises** rather than re-pointing
the archive — objects already written live under the old prefix, renaming does not move them, and a
new key would orphan every one of them while the manifest still pointed at the old.

To change it deliberately, in this order, with the CronJob suspended:

1. Copy every object under the old prefix to the new one at the provider, and widen the bucket
   policy to admit both prefixes.
2. On **the historian**, repoint the catalogue —
   `UPDATE public.telemetry_archive_manifest SET object_key = replace(object_key, 'site=old/', 'site=new/')`.
   Not through the `timescale.` foreign table: `fdw_reader` is read-only, by design.
3. On the platform database, as `postgres` in Studio's SQL editor — not from the Settings page,
   which has no control for a read-only row and no rights to the `read_only` column:

   ```sql
   UPDATE public.system_settings SET read_only = false WHERE key = 'archive.site_key';
   UPDATE public.system_settings SET value = to_jsonb('new'::text) WHERE key = 'archive.site_key';
   UPDATE public.system_settings SET read_only = true WHERE key = 'archive.site_key';
   ```

4. Set `coldArchive.s3.siteKey` to the new value and upgrade, or the next boot raises on the
   disagreement — which is the check working.
5. `python -m cold_archive audit` is what says it worked, and only then narrow the bucket policy
   and remove the old prefix.

#### The credential is a foreign one, and it cannot delete

We cannot mint, rotate or revoke a key at another provider, so it sits with the SMTP relay password
rather than with the principals this stack issues. Scope it to `PutObject` and `GetObject` on this
site's prefix, with **no `DeleteObject`**:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject"],
    "Resource": "arn:aws:s3:::plant-history/site=broughton-7f3a9c21/*"
  }]
}
```

That turns "the exporter writes and never deletes" from a comment into something the gateway is
unable to break. With bucket versioning and Object Lock on top, a compromised gateway cannot
destroy history at all — which is more than the PVC could ever offer, where root on the node was
the end of the story.

**Verification got cheaper and stricter at the same time.** The upload sends `ChecksumSHA256`, so
the store validates the payload server-side and rejects a corrupt write before it becomes an
object; `verified_at` is then set from a `HEAD` plus one ranged read of the Parquet footer —
measured at **64 KiB to verify a 15.2 MiB object**, against the whole object coming back on the old
path, and checking one thing more than that read-back could.
`telemetry_archive_manifest.object_etag` has existed since the table did and is finally populated.

#### What happened to the old bucket

Nothing deletes a bucket, and this does not either. `telemetry-archive` is dropped from
`scripts/storage-init.mjs` so no new install creates it, and `supabase/storage-policies.sql` drops
its four policies explicitly — a policy the file no longer mentions is one nothing maintains, and
it would otherwise survive every boot guarding a bucket nothing writes to. On an existing install
the bucket is left with whatever it holds, for an Administrator to check against the remote
endpoint and then empty from Studio.

**AAS export bundles did not follow it.** They were stored under `assets/` in the same bucket while
both were local, and they now have their own: `asset-exports`, with its own policies. They are not
the same kind of object — a bundle is a copy somebody asked for, derived from rows still in the
database, and it belongs on local storage where the browser can sign a URL for it. An existing
install's bundles stay where they were written; `asset_exports.object_bucket` is per row, which is
what makes that safe to say.

#### Raw telemetry is kept for a stated window, with or without an archive

**Raw telemetry is kept for 14 days; older readings are in the 1-minute, 5-minute and 1-hour
rollups, and on cold storage while archiving is on.** That is the sentence the Cold Storage page
states, read from the historian rather than restated here.

The window is `timescaledb.retention.retainFor` (`14 days`; `never` keeps raw indefinitely). It is
enforced by one job on the historian, `telemetry_raw_retention()` in
[`timescaledb/retention.sql`](../timescaledb/retention.sql), not by TimescaleDB's retention policy,
which drops on a timer with no knowledge of the archive. Each daily run drops the oldest chunks
that ended more than the window ago, and stops at the first it may not drop:

| Chunk | Archiving off | Archiving on |
| :--- | :--- | :--- |
| no manifest row | dropped | **kept**: not exported yet |
| exported, not verified | **kept**: export in flight | **kept** |
| verified | dropped, and stamped in the manifest | dropped, and stamped in the manifest |

So an archive outage grows the historian's volume, which the Archive Backlog alert below reports,
instead of the window deleting telemetry nothing exported.

**"Archiving on" is what the archiver last reported**, because `archive.enabled` lives in this
database and the historian cannot read it. `python -m cold_archive` reports it on every run
(`cold_archive_report_armed()`), and only when it actually read the setting: an unreadable setting
falls back to off, and reporting that would switch the protection off. Between switching archiving
on and the archiver's next run (03:15 by default) the window still drops unexported chunks; the
Cold Storage page says so while it lasts.

Before 1.0 the window was derived from the chart's destination fields: `never` with a destination,
90 days without. Since `0134` the destination is set on the page, so a stack configured there got
the 90-day timer racing the archiver. **An upgrade from that chart drops raw telemetry older than
14 days on the job's first run**; set `retainFor: "90 days"` before upgrading to keep it. A new
install seeds `archive.tier_after_days` at 14 to match; an existing one keeps its value, which is
safe either way, since a threshold longer than the window keeps raw longer rather than losing it.

#### How far behind the archive is

`cold_archive_backlog()` answers it, from the newest `range_end` this site has **verified**:
everything after that point is telemetry no object is yet known to hold. Before the first export
there is no frontier, so the answer is the oldest raw data there is
(`storage_footprint.oldest_data`), and an archiver that has never reached its endpoint is reported
rather than read as a healthy zero.

It surfaces in two places, from one function so they cannot disagree:

- **The Cold Storage page**, as *Unexported since* — the date the unexported span begins, with the
  overdue figure and the threshold in its tooltip. Shown only while `archive.enabled` is on.
- **The Archive Backlog alert** (`aber-archive-backlog`), through the `archive_backlog` condition on
  `platform_health`, firing above **14 days past the threshold**, held level with the page's
  tolerance by `check-docs-drift.mjs`.

**Up to one chunk interval of backlog is normal**, and the threshold is chosen around that. Chunks
are at most seven days (`timescaledb.retention.chunkInterval`'s ceiling) and
`cold_tier_candidates()` bounds on `range_end`, so a chunk is not eligible until its whole span has
passed the threshold: a healthy site sits between zero and seven days overdue. Fourteen is two of those — beyond anything the ordinary cadence produces, and still two
weeks before a historian with retention off is short of disk. Alerting on any backlog at all would
fire on every install, every week, correctly, and be switched off.

```bash
python -m cold_archive --dry-run   # what would be exported
python -m cold_archive             # export, upload, verify; drop nothing
python -m cold_archive --drop      # ... and drop what verification cleared
```

**Reading it back** does not rehydrate anything:

```bash
python -m cold_archive query --from 2026-04-01 --to 2026-05-01 \
    --asset dev220000000000400080000 --metric SpindleSpeed --limit 50
python -m cold_archive query --from 2026-04-01 --to 2026-05-01 --csv april.csv
```

The manifest's `range_start` / `range_end` are what make this cheap: they say which objects **overlap**
the window, so a question about one March fetches one object rather than the archive. Overlap and
not containment, deliberately — a chunk spanning a month boundary is relevant to a question about
either side of it.

**Only verified objects are read**, and anything skipped is named. An `exported` row has an object
nothing has read back and a `failed` one may be truncated; this answers questions about history,
where a partial result that looks complete is worse than a refusal. The command also prints the span
it actually covered, because a range straddling cold and hot storage gets only the cold half from
here.

**It is not gated on `archive.enabled`.** That setting governs whether telemetry is *exported*, and
has nothing to say about reading what already was — refusing a traceability question because
somebody turned future archiving off would be the setting reaching past what it means.

Each relevant object is fetched whole from the archive's S3 destination and read from a temporary
directory, rather than range-scanned where it lies. DuckDB's httpfs could read only the row groups
a query touches, with no change to the SQL.

### What Grafana can and cannot see

**Grafana cannot read the Parquet, and is not meant to.** It connects as `grafana_reader` over
Postgres to `timescaledb:5432` and `supabase-db:5432`. The objects live in the S3 bucket the Cold
Storage page names, which the archiver reaches through boto3 with the archive's own credential, and
no Postgres datasource can reach it. There is no path between them.

**Archiving therefore removes raw rows from Grafana's reach — and that matters far less than it
sounds, because the rollups were designed for it:**

| relation | retained | Grafana |
| :--- | :--- | :--- |
| `telemetry` (raw) | `timescaledb.retention.retainFor` (14 days by default), then archived | loses the archived span |
| `telemetry_1m` | 180 days | unaffected |
| `telemetry_5m` | 1 year | unaffected |
| `telemetry_1h` | **5 years** | unaffected |

`aggregates.sql` states the intent: *"THE ROLLUPS OUTLIVE THE RAW DATA, and that is the point of
setting their retention separately … these keep shape, excursions and state."* An hourly chart of
last March still works, and still will in 2031. What is lost to Grafana is **per-sample resolution**
older than the threshold — not the history.

**Bridging Grafana to Parquet was researched and rejected.** The historian image offers only
`file_fdw` and `postgres_fdw`; there is no `parquet_fdw` or `duckdb_fdw`, and the image is Alpine,
so adding one means compiling DuckDB's C++ library and the FDW against musl into a custom
TimescaleDB image, re-done on every version bump. Grafana's Infinity plugin reads CSV and JSON over
HTTP, not Parquet. That is a large permanent custom artefact to recover a resolution Grafana charts
do not render — so the boundary is documented instead. For raw archived rows, `cold_archive query`
has `--csv`.

### Running it, and the switch that used to mean nothing

**The chart runs the archiver as a CronJob** — `coldArchive`, on by default with `--drop` on: the
ingestion image under `python -m cold_archive`, at `coldArchive.schedule` (03:15 daily). It re-reads
`archive.enabled` every pass and does nothing while it is off, so it stays inert until the switch is
turned on — which is what makes the switch a control rather than a note about a command somebody has
to remember.

`cold_archive.sql` is mirrored into the chart and applied by the `timescaledb-maintenance` Job,
between `storage.sql` and `roles.sql`, so the manifest exists before the first run and `0068`'s
self-check passes for the right reason.

To see what is eligible, or to force a pass:

```bash
kubectl exec deploy/ingestion -- python -m cold_archive --dry-run
kubectl create job --from=cronjob/aber-cold-archive archive-now
```

> This paragraph described a `cold-archiver` Compose service running `--loop` on
> `COLD_ARCHIVE_INTERVAL_SECONDS`. Both outlived Compose: no such container exists and that variable
> is read nowhere in the tree. The Cold Storage page carried the same instruction and has been
> corrected with it.

It includes `--drop`, and that is the safer option rather than the bolder one: the baseline it
replaces is `retention.sql` dropping chunks on a timer with **no export and no record at all**.

### Auditing, and the reconfiguration that breaks an archive

```bash
python -m cold_archive audit
```

Walks the manifest and checks every object is still fetchable, exiting non-zero if any is not. It
distinguishes an object that is merely gone from one that was **the only copy**, and reports how
many rows that is.

**It checks the other direction too** — objects on storage that no manifest row references. Those are
bytes nothing can reach through the catalogue and nothing can account for, left by a failed drop, an
interrupted export, or a manifest restored from a backup older than the storage beside it. They are
**reported and never deleted**: removing an object is the one irreversible act here.

**The failure it exists for is a reconfiguration, not a bug.** The Cold Storage page can point the
archive at another endpoint or bucket, but changing it **migrates nothing**. The same keys are
looked for at the new destination and 404 while the manifest still reads `archived` and the raw
rows are already gone. Moving the archive therefore means copying the objects across **preserving
their keys exactly**, because `object_key` is what points at them.

### Restoring

```bash
python -m cold_archive restore --chunk _hyper_1_40_chunk
```

Reads the object and inserts the rows back (`ON CONFLICT DO NOTHING`, so an interrupted restore is
safe to repeat), then clears `dropped_at` — putting the row back in exactly the state it held
between verification and the drop: data in **both** places, `verified_at` still set. That is not a
special case, it is the safest state in the flow, so `--drop` will remove the chunk again with no
further work. The round trip closes rather than being one-way.

### `deployment`, and the word it replaced (`0064`)

`is_virtual` carries three incompatible definitions — *"no physical edge appliance behind this
row"* (`0025`, provisioning), *"this connector runs on the app host"* (`GatewaysTab.jsx`), and
*"(Cloud / Server-Simulated)"* (the checkbox, which contradicts the second) — while **every**
behaviour branching on it is about a fourth thing: whether there is a machine out on the plant
network. That was a roadmap item, retired into
[`deployment`, and the word it replaced](#deployment-and-the-word-it-replaced-0064) below;
the bill arrived separately, as
`gateway_holds_a_credential()` being the wrong predicate three times in `0056`, `0062` and `0063`.

`0064` adds **`deployment`** (`'host'` | `'remote'`), the axis the code actually uses, plus the
cross-column `CHECK (NOT is_simulated OR deployment = 'host')` — a simulator is a process this stack
runs, and a remote one is not something it can provision or reason about. Two columns rather than a
three-way enum, so the fourth combination stays *sayable*: folding them together would make a
simulator on a separate load-generation box inexpressible.

**The rename was not in that migration**, deliberately — 126 references across 47 files, and §15's
own rule is that a rename beside a feature is a rename nobody reviews. For the releases it took to
complete, `sync_gateway_deployment()` kept the two columns in agreement in both directions, so
every writer that still named `is_virtual` went on working and got the new column filled
correctly.

**`0000` finished it, at the third baseline squash**, which is where `0064` said the column would
go: it survived that long only because two archived migrations named it in a function signature and
replayed on every boot. `gateway_health_rows()` moves last, because `is_virtual` was in its
`RETURNS TABLE` signature and a return type cannot be replaced in place — the function and the view
built on it are dropped and recreated together, and the tail has to do the dropping because a
generated baseline only ever declares. Then the transitional trigger goes, and the column with it.
`gateway_status` has to be dropped first and rebuilt after: it is `SELECT g.*`, which PostgreSQL
freezes into an explicit column list, and that frozen list is a hard dependency. The same fact that
makes `ensure_gateway_status_view()` necessary when a column is *added* is what blocks a drop.

One thing the drop had to carry with it: `deployment` is `NOT NULL` and had **no default**, because
the trigger derived it from `is_virtual` on every INSERT. Removing the trigger without giving the
column `DEFAULT 'remote'` — exactly what the trigger produced from `is_virtual`'s own default —
breaks every writer that names neither, which is most of the test estate and `relocate_devices()`.

Two things keep the old word: migration filenames (the chain is immutable) and every
`CREDENTIAL_ISSUED` row written before `0065`. The third was
`authorize_virtual_gateway_credential()`, held back because an RPC name is client-visible and
renaming it is its own change. [`0130`](migrations/archive/0130_the_gateway_types_keep_their_names.sql) is
that change.

### The credential gate is named after the type it accepts (`0130`)

`authorize_host_gateway_credential(uuid)`, because a gateway is **Host**, **Remote** or
**Simulated** — `deployment` plus `is_simulated`, rendered as one control by
`frontend/src/utils/gatewayType.js`. The old name outlived the word by four migrations.

`0001` declares the new name, so the only thing left to do is remove the old one, which every
database provisioned before this boot still holds. **A sweep over `pg_proc` rather than one
`DROP FUNCTION`**, for the reason recorded two sections above: this function was briefly given a
third output column, so a database that lived through that shape can hold a declaration whose
argument list this file cannot predict. It is the `0118` idiom.

**The rename is not free, and the cost is a window rather than a risk.** The only caller is
`supabase/functions/gateway-credential`, which ships in an image built from this tree. During a
rollout the previous function image runs against the new schema, and its call fails with
`function does not exist` until the new image lands. It fails *closed* — no credential is minted
against a gate the database no longer documents — and a mint is a deliberate operator act rather
than a background path, so the remedy is to press the button again. Any RPC rename has this
window; naming it here is the point.

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

**On UPDATE there was no conflict to resolve, and that was arithmetic rather than policy.** Both
columns were two-valued and every row started in agreement, so an update changing both necessarily
flipped both, which agreed again; a caller restating one column at its current value was
indistinguishable from one that never mentioned it. The first version of the trigger guarded
against a disagreement that could not occur. On INSERT the rule was real, because `is_virtual` had
a default: a row naming only `deployment` arrived with both set, and the one the caller chose won.
Recorded because the reasoning outlives the trigger — the same shape recurs whenever two columns
are kept in step through a rename.

### Revocation reads that record, which is why it never worked (`0063`)

`0038` revokes a decommissioned gateway's broker credential (since `0102`, by disabling the account
at the broker, which drops its live session; before that, by rotating it to a password nobody
recorded). **It never fired for a host-run gateway, which is every gateway a provisioned stack has**,
because it gated on `gateway_holds_a_credential()`. Demonstrated end to end: create a host-run
gateway, give it a broker account, publish, `DELETE` the row, and it went on publishing — with
nothing queued in `net.http_request_queue`, so the revocation was never attempted rather than
failing.

**The exclusion was deliberate and its purpose was right.** `0040`'s header says so: *"The guard is
there so revocation cannot CREATE an account by rotating one that never existed, and by that
definition a simulator gateway holds nothing."* At the time revocation went through an add-only
credential service, so asking it to rotate an account that did not exist provisioned one; a
disable of an unknown account now creates nothing, and the guard still spares the broker a request
for an account that was never issued. What was wrong is the second half — a simulator gateway holds
exactly what was minted for it on the host.

So `0063` swaps both the trigger and the pg_cron sweep onto `gateway_has_broker_credential()`, which
admits a host-run gateway **only when a `CREDENTIAL_ISSUED` row exists**. That closes the leak and
keeps `0040`'s guarantee: a gateway that never held an account still cannot have one created for it
by being deleted. Revoking unconditionally was the obvious alternative and would have traded the
leak for one junk account per gateway ever deleted.

**Two things SQL cannot reach, and both are on the host:**

- **Credentials issued before `0062`** have no record, so the predicate skips them. The backfill
  that recorded them belonged to `provision-gateways.mjs`, which is retired with the demonstrator;
  a gateway in this state is re-recorded by minting it a fresh credential through the dashboard,
  which is an act with a person behind it and needs no claim on anyone's behalf.
- **Accounts whose gateway row is gone** cannot fire a trigger at all.
  `scripts/revoke-orphaned-broker-accounts.mjs` reads the broker's client list, subtracts every
  gateway row (archived included — those belong to the trigger and the sweep), and disables what is
  left through `revoke_gateway_credential()`. Dry run by default. It considers only enabled
  `gwy` + 21 hex character accounts, so it can never select `aber_ingestion` and stop the
  stack ingesting. The Access Control page lists the same accounts under *Broker accounts*, marked
  *No gateway*.

### What the inventory still cannot see

`npm run setup` mints `SUPABASE_INGESTION_KEY` and `SUPABASE_PLAYBACK_KEY` — the keys the ingestion
daemon and the playback worker authenticate with — **before this database exists**. There is
nothing to record into at that moment, and no arrangement of the code changes that.

So on a stack that has never rotated, those two principals show *"No token recorded"*. That is a
statement about **that stack**, not about the platform, and one command closes it:

```bash
npm run keys:rotate -- --apply   # re-signs both, recording each, and patches the release Secret
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

### Expiry, and where revocation does not reach

Revocation exists since `0074` (see
[Tokens became revocable in `0074`](#tokens-became-revocable-in-0074-and-the-mint-followed-in-0075))
and reaches PostgREST only: Storage, Realtime, the edge runtime and Studio verify the signature for
themselves. Expiry therefore still bounds every token, and the line falls between **keys that name a
principal** and **keys that name nobody**:

| Key | Expiry | Why |
| :--- | :--- | :--- |
| `mint-mcp-token.mjs` tokens | 30 days default, **90 ceiling** | Pasted into a config file on somebody's laptop. It walks out of the building with the machine; revocation reaches PostgREST only, so the expiry bounds the rest |
| `SUPABASE_INGESTION_KEY`, `SUPABASE_PLAYBACK_KEY` | **90 days**, rotatable | They carry a `sub`, so they are the same kind of credential as the row above and are bounded by the same ceiling. `npm run keys:rotate` re-signs them |
| `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | 10 years | Not anybody: `role` and no `sub`, so RLS never asks who is calling. They are also the stack's **API keys** — the gateway admits exactly these two literal strings (or their `sb_*` replacements) — so shortening them needs a story for re-issuing them to every client at once |

The ceiling is enforced in both the script and the database, deliberately duplicated, so it cannot
be removed by editing one file. `mint-mcp-token.mjs` also
**records before it prints** — the token exists nowhere until stdout, so a failed audit write costs
a row describing a credential nobody holds, where the other order costs an unrevocable credential in
the wild with no record of it.

### Rotating the two service keys

The middle row used to read *10 years*, alongside a note that a short expiry would take the stack
off the air "on a date nobody wrote down, and there is no refresh path". Half of that was right and
the other half was the defect ([#101](https://github.com/Harri-Llewelyn/Aber/issues/101)):

* **There is a refresh path**, and building it was cheap because these keys are signed with
  `SUPABASE_JWT_SECRET` and **re-signing them does not rotate that secret**. A new token with a
  later `exp` is valid the instant it is signed, so nothing else is re-issued — not the anon key,
  not the service-role key, not a gateway credential.
* **Length never fixed "a date nobody wrote down"**, it deferred it to 2036 and removed every
  chance to notice on the way. Visibility fixes it, which is what `--check` is for.

```bash
npm run keys:check    # days remaining per key, exits non-zero within 14 days of expiry
npm run keys:rotate -- --apply   # re-sign both, patch the release Secret, restart the two workloads
```

The restart is **not optional and not automatic**. Both workers read their key once at import
(`os.getenv` in `ingestion.py` and `playback_worker.py`), so until they are recreated they are still
presenting the previous token — which still works, and is exactly what makes it easy to believe a
rotation is finished when it is not. `keys:rotate` ends by saying so.

Without `--apply` the two assignments are printed, for a Secret managed outside the cluster. A
release installed from `values-local.yaml` has the file rewritten too, or the next `helm upgrade`
would put the old keys back.

**Rotation shortens exposure going forward; it cannot withdraw a key already issued.** PostgREST
validates a signature and consults no table, so the previous key stays valid until its own `exp` —
which is the entire argument for the ceiling. Rotating a 90-day key leaves at most 90 days of
overlap. Rotating a ten-year one left ten years.

### The Access Control page states what is outstanding

The page lists every gateway with what the platform knows about its broker credential, lists the
machine identities on both planes, lets an Administrator create a database principal with a name
and a purpose (`0125`) and issue its first token in the next dialog, mints tokens for the
identities that read one, and shows what stands against each.

**It also reads the broker (`0102`).** Since the broker's accounts moved to its Dynamic Security
plugin ([`mosquitto/README.md`](../mosquitto/README.md)), the page holds two columns for each
gateway: **Credential**, what the platform issued and recorded, and **Broker**, what the broker
holds at the moment of the read — *Active*, *Disabled* or *No account* — through the
`broker-inventory` function, which forwards the credential service's `listClients` and `listRoles`
to an Administrator with every hash stripped. The pair is the point: a gateway issued on the host
reads *No platform record* beside *Active*, and one revoked since reads *Issued* beside *Disabled*.
The page is four tabs of one card: *Broker credentials*, *Machine identities* (the database
principals), *Broker accounts* and *Broker roles*. *Broker accounts* is every non-gateway account
the broker holds, live, with the purpose of the role each holds, then any account shaped like a
gateway id that no row claims and nothing declares, marked *No gateway*: what
`scripts/revoke-orphaned-broker-accounts.mjs` disables. The validator's test gateway
(`gwy11…`, created at boot from `MQTT_VALIDATOR_*` rather than issued against a row, and only when
that pair is set) is declared in `serviceIdentities.js` and listed there rather than as a stray.
The roles table counts each role's live rules and opens them in the context drawer, annotated with
a purpose declared in `serviceIdentities.js`; `check-docs-drift.mjs` holds that list and
`mosquitto/dynsec-roles.json` together. Revocation is
now `disableClient`: the live session is dropped at once, the account stays listed as disabled, and
a re-issue re-enables it. When the broker cannot be read the column says *Not read* and the page
says why once, rather than drawing an empty column that reads as no accounts.

`tokenStatus()` counts **every** unexpired mint rather than reading the latest, because a re-mint
adds a live credential rather than replacing one — reporting the newer of two would state half the
exposure on the one page whose job is to state all of it.

#### Tokens became revocable in `0074`, and the mint followed in `0075`

This section used to open *"Since nothing can be revoked, knowing how many unexpired tokens exist
and when the first lapses **is** the safety story."* That was the honest position for as long as it
held, and it no longer does.

`0043` surveyed three revocation designs and found none workable: deleting the `auth.users` row does
nothing (the signature is validated and the subject never looked up), removing the role does nothing
that matters (the relations the i3X address space is assembled from are
`FOR SELECT TO authenticated USING (true)`), and a `revoked_at` predicate would have to be added to
every RLS policy in the schema. **The fourth design is PostgREST's `db-pre-request`** — a function
run in the caller's role before every request, which can `RAISE` and abort it, and which touches no
policy at all. `0074` adds `revoked_service_tokens`, `auth_pre_request()` and
`revoke_service_token()`; `PGRST_DB_PRE_REQUEST` names the hook.

**The key it needs had been recorded since `0043`.** Both host scripts stamp a `jti` and hand it to
`record_service_token_issued()`, for an inventory that could not act on it.

**Revocation reaches PostgREST and nothing else, and the page says so.** `supabase-storage`,
`supabase-realtime`, the edge runtime (which boots `VERIFY_JWT="false"`) and Studio each verify
`SUPABASE_JWT_SECRET` for themselves and consult no denylist. That is complete coverage for what
this is about — the MCP reader and `Service_Ingestor` reach PostgREST and nothing else — but the
expiry is still the only bound that reaches every service, which is why the 90-day ceiling stays.

**`0075` is the mint, and it is deliberately not an RPC.** The retired revocable-tokens roadmap item sketched a
`SECURITY DEFINER` function signing with `pgjwt`, on the reasoning that it needed "no secret leaving
the database". The extension is installed; the premise is not true — `SUPABASE_JWT_SECRET` is not in
this database, and nothing in `vault` is that one. Putting it there would let any
path to SQL execution mint a `service_role` token, which is valid at the four services above and
which `0074` cannot revoke. So the signing lives in
[`mint-service-token`](functions/mint-service-token/index.ts), which already holds `JWT_SECRET`, and
`0075`'s change to the database is narrower: `record_service_token_issued()` gains `p_actor_id`, so a
mint from the page names the Administrator who asked instead of the `'service'` attribution `0043`
pinned when every caller was a host script. The actor is **re-checked** against `user_roles` there
rather than believed, so authorisation does not rest solely on a check made inside the component
that holds the signing key.

**The button is not offered on every row.** `Service_Ingestor` and `Service_Playback` read their
keys from the environment, so a token minted for either is valid and unread —
`isMintableFromPage()` is the rule, and those two keep `npm run keys:rotate`, which is what actually
changes what those processes present.

#### `0076` revokes the identity, which reaches further than revoking its tokens

`revoke_service_principal()` flags a principal and `auth_pre_request()` then refuses every token
naming it — **including ones this stack has no `TOKEN_MINTED` row for, and any issued afterwards**.
Withdrawing tokens one at a time from the inventory dialog cannot do either: it reaches exactly the
recorded jtis, and the next mint works.

**A flag nothing reads would have been the same defect `0043` already rejected.** That migration
ruled out deleting the `auth.users` row because *"the signature is validated and the subject never
looked up"* — and writing `revoked_at` somewhere has precisely that failure available to it. The
flag is enforced at the same choke point as the token denylist, keyed on the `sub` claim, which is
what makes it a revocation rather than an annotation.

**It cascades, and that is what makes reinstatement safe.** Revoking also denylists each outstanding
token individually — redundant for PostgREST, since the subject arm already refuses them, and not
redundant for the audit trail or for `reinstate_service_principal()`. Lifting the flag restores the
**identity**, not the credentials that were live when it was withdrawn; `revoke_service_token()` has
no inverse, so those stay refused and a new token must be minted.

**A person's account is refused outright.** `sub` is on every JWT, so a row naming a human would
lock them out of PostgREST through a control built for machines — and out of the request that would
undo it. `is_machine_principal()` is the guard.

#### A call the planner can fold checks nobody (`0015_i3x_authenticates_with_a_call_the_planner_cannot_fold.sql`)

i3X authenticates each request by calling one function through PostgREST as the caller, so the
revocation arms above reach it. PostgreSQL checks EXECUTE on a function when a plan calls it, and
PostgREST runs prepared statements from their generic plan on pooled connections. The probe was
`service_token_max_days()`, SQL and `IMMUTABLE`, which the planner folds to the constant 90: a plan
made for an `authenticated` request held no call left to check when an `anon` request reused it on
the same connection. Measured on 2026-09-28 by `validate.py` check 12h: `not-a-token` passed 1
request in 12 through the gateway. Proved in psql: `PREPARE` as `authenticated`, then `EXECUTE` as
`anon`, returns 90 although `has_function_privilege('anon', …)` is false.

`0015` adds `i3x_auth_probe()`: plpgsql, which the planner does not inline, and `STABLE`, which it
does not fold, granted to `authenticated` and `service_role` only. The call stays in every plan, so
its EXECUTE check runs on every execution. `service_token_max_days()` keeps its own job, the token
ceiling, where folding is harmless. Check 32 of `scripts/check-docs-drift.mjs` holds the probe to
plpgsql and not `IMMUTABLE`, and `test_service_token_revocation.py` replays the attack.

#### A missing hook is a total outage that every health check calls healthy

Worth knowing before anyone edits `PGRST_DB_PRE_REQUEST`. Measured against
`postgrest/postgrest:v14.12` by starting one that named a function which does not exist:

| Signal | Result |
| :--- | :--- |
| Boot | **Succeeds.** Schema cache loads, container runs. |
| `/live`, `/ready` on the admin server | **200** |
| Every data request | **404**, `{"code":"42883","message":"function … does not exist"}` |

So a typo in that variable takes the whole API down, reports healthy on both probes, and surfaces
as **404 rather than 5xx** — invisible to a monitor watching for server errors, and on Kubernetes
the readiness probe keeps the pod in service.

`scripts/check-docs-drift.mjs` is the control: it asserts the chart sets it and that a migration
declares it. That has to be a **static** check — by the time a runtime
probe could notice, the outage has already begun.

**The arm order is about the message.** Both arms refuse the request, so the outcome is identical;
the subject arm runs first because after a cascade both match, and *"this identity has been
revoked"* explains the mint refusal that follows, where *"this token has been revoked"* invites a
replacement request that will also fail. Its uuid cast falls **through** to the token arm rather
than returning — otherwise a token carrying a junk `sub` would bypass the token denylist entirely.

Built by `0041`–`0044`, `0074`, `0075`, `supabase/functions/gateway-credential`,
`supabase/functions/mint-service-token`,
[`AccessControlTab.jsx`](../frontend/src/components/tabs/AccessControlTab.jsx),
[`credentialState.js`](../frontend/src/utils/credentialState.js) and
[`serviceIdentities.js`](../frontend/src/utils/serviceIdentities.js).

---

## Key Triggers

| Trigger | Table | Purpose |
| :--- | :--- | :--- |
| `trg_*_audit_trail` | `cells`, `gateways`, `devices` | Audit logging |
| `trg_audit_trail_append_only` | `audit_trail` | Rejects UPDATE/DELETE |
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
| [`aas-export`](functions/aas-export) | + `Operator`, `Auditor` | Export is a read. `format=bundle` also needs `audit_trail:read`, because it carries the trail |
| [`grafana-userinfo`](functions/grafana-userinfo) | any mapped role | OIDC userinfo for Grafana SSO |
| [`nodered-userinfo`](functions/nodered-userinfo) | any mapped role | The same lookup in Node-RED's permission vocabulary. Only `Administrator` maps to `*`; since `deploy-nodered` was retired this is the sole enforcement point for `gitops:manage` |
| [`fplus-directory`](functions/fplus-directory) | any authenticated user | Factory+ Directory adapter — see below |
| [`forge-membership`](functions/forge-membership) | `Administrator`, `Shopfloor_Manager` | The forge listener's `ext_authz` step: places the caller in the team their role warrants, refuses a role removed since the token was signed (`0094`) |
| [`forge-signout`](functions/forge-signout) | the caller | Gitea's own sign-out link: ends every GoTrue session the caller holds, then the door's sign-out |
| [`forge-events`](functions/forge-events) | **no Supabase role at all** | Gitea's push webhook, authorised on its HMAC; records the head of `main` on the gateway row (`0095`) |
| [`grafana-alert-webhook`](functions/grafana-alert-webhook) | **no Supabase role at all** | Records a Grafana alert in `platform_alerts` — see below |

### `grafana-alert-webhook` — the one that authorises on a shared secret

Every other function above authenticates a *user* and resolves their role. This one has no user:
Grafana is notifying, not somebody clicking. It authorises on `GRAFANA_ALERT_WEBHOOK_SECRET` and then
writes with its own service-role client.

**Grafana is deliberately not given the service-role key.** That key bypasses RLS entirely and can
rewrite `audit_trail`, and this stack has already corrected the same shape once — Grafana used to
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

That is the opposite answer to `audit_trail`, deliberately — one is an audit trail the platform
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
| `GET /v1/schema/{uuid}` | The devices implementing one schema — the **reverse** lookup |

**It is served at the unprefixed paths**, not under `/functions/v1/`, because a Factory+ client has
no Supabase `apikey` and no way to acquire one. Those gateway routes are therefore exempt from the
`apikey` check — which makes the function itself the **only** thing in front of the fleet's address
space. Every `/v1/` path refuses a request with no bearer token *before it routes*, and
`validate.py` check 11b asserts that 401 rather than trusting it.

It **queries as the caller**, not as the service role: a Directory is a live read over the whole
address space, so running it privileged would hand every authenticated user a view their RLS
policies do not grant them. Its entry in `FUNCTION_REGISTRY` grants no `SUPABASE_SERVICE_ROLE_KEY`,
which makes that structural rather than a discipline.

**The reverse lookup deliberately does not filter on status.** `/v1/schema` lists what is in use
and returns only `active` versions; `/v1/schema/{uuid}` resolves an identifier the caller already
holds, and the most useful case it answers is the one a filter would hide — an **archived** schema
with devices still attached to it, which is a migration that has not finished. Answering `404`
there would report "no such schema" about a schema whose members are the answer, so the row's
`status` is returned instead and the caller decides. Members are read through the `device_schemas`
**view**, not `device_submodels`, so a device provisioned through the legacy 1:1 `devices.schema_id`
is not silently omitted — and those are exactly the devices an old schema still holds. A schema
nothing implements is a `200` with an empty list.

**What it does not claim.** Schema and service identifiers are this deployment's own UUIDs, and the
response says so (`"namespace": "local"`). Factory+ `Schema_UUID`s are registered against the AMRC
schema repository; returning local ids unqualified would assert an interoperability that does not
exist — the same rule the semantic-id namespace follows.

Two identity mappings need no new columns, which is why this is an adapter and not a migration:
`Instance_UUID` is `devices.id` (already RFC4122), and the Sparkplug address is
`(gateways.sparkplug_group, gateways.sparkplug_id)`.

**The Directory also has an MQTT half**, and it is off by default:
[The Directory on MQTT](../ingestion/README.md#the-directory-on-mqtt) publishes the same projection
as four retained documents. It is a separate decision from this one for a single reason — the
read-as-the-caller property above does not survive the move. RLS decides what each HTTP caller sees;
a retained topic has one copy for every subscriber, so on MQTT the broker ACL is the whole of the
access control. Everything else about it follows from that.

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

Shared code lives in `functions/_shared/` and is imported by relative path: `servicePath` decides
which directory a worker boots, not what its module graph may import. Reading files at runtime is
still confined to the service path.

### Edge function dependencies

Nothing is fetched when a function loads. `functions/deno.json` declares the dependencies as an
import map, and code imports the bare names (`@supabase/supabase-js`, `fflate`, `djwt`).
`functions/deno.lock` pins them: npm packages by the registry's integrity hash, the `deno.land`
modules djwt imports by content hash.

- **The image resolves them.** The Dockerfile's `modules` stage runs `deno cache --frozen` with
  Deno 2.1.4, the Deno that edge-runtime v1.77.0 embeds (`edge-runtime --version`), and copies the
  module cache into the image as `DENO_DIR=/home/deno/deno-dir`. `--frozen` fails the build when the
  lock does not cover the module graph; bytes that differ from the lock fail its integrity check.
- **The build proves it.** The `offline-check` stage boots every function directory under
  `RUN --network=none` and fails on the router's boot error or on a directory missing from
  `FUNCTION_REGISTRY`. The image keeps the report at `/home/deno/offline-check.txt`.
- **Every worker reads the lock.** The runtime finds `deno.json` and `deno.lock` above each
  entrypoint and resolves npm packages from the lock, so it never asks for a version the cache does
  not hold. Loading the lock reads each package's cached registry metadata, so an image built
  without the cache cannot start even the main service offline. `noModuleCache: false` in
  `main/index.ts` is what lets workers use the cache; `true` would refetch everything.
- **Changing a dependency.** Edit `deno.json`, run `npm run functions:lock`, and commit both files.
  The script runs the Dockerfile's `denoland/deno` image. Renovate's deno manager maintains the lock
  with `constraints.deno`, the same version. The `denoland/deno` tag and that constraint move by
  hand, when edge-runtime's embedded Deno does: a lock written by another Deno can be in a format
  the build cannot read.
- `npm run lint:deno` enforces `no-import-prefix`, so a specifier written into an import instead of
  `deno.json` fails lint. It also runs `deno check --frozen` over every entrypoint with the
  Dockerfile's `denoland/deno` image, so a type error, or an import the lock does not cover, fails
  it too.

### `approve_quarantined_device()`

The merge path used to be four sequential PostgREST calls with no transaction and no compensating
rollback: re-key `asset_config`, update the surviving device, delete the duplicate. A failure
partway left `asset_config` pointing at a device that was never merged, or two un-quarantined rows
claiming one physical asset.

It is now one `SECURITY DEFINER` RPC — atomic, granted to `service_role` only, taking the
authenticated `p_actor_id` explicitly and **re-checking that actor's role against
`public.user_roles`** so authorisation does not rest solely on the caller's check.

### The approvals queue, and the first write an `Operator` has ever had (`0086`)

One queue for a change a person proposes but may not apply. An `Operator` inserts into
`change_proposals`; an `Administrator` or `Shopfloor_Manager` calls `approve_proposal()`, and **the
approval is the write**.

**`Operator` held two permissions before `0086`, neither of them a write**, so this is not the
loosening of an existing grant. It is worth being exact about what it is a write *to*: a queue, not
an asset. The write policies on `devices`, `cells`, `gateways` and `schemas` are unchanged, and
`test_change_proposals.py` asserts that directly rather than inferring it — an `Operator` still
cannot update a device, insert one, or write a nameplate. **If a later change ever adds a second
write path to an asset table, this item has failed**, however convenient that path looks.

**Approving is applying, and that is the property the shape exists for.** Because the write happens
inside the approval, every CHECK, foreign key and trigger on the target runs *then* — a patch
setting `location_scope = 'site_wide'` while leaving `cell_id` populated fails
`devices_site_wide_has_no_cell` and **aborts the approval**. Nothing in `0086` restates that rule.
A queue that accepted such a change would hold an audit record of something that did not happen,
which is worse than no record.

**The patch is operator-controlled input, and no SQL is ever built from its keys.** It is merged
onto the current row with `jsonb_populate_record` and then assigned column by column, in SQL
written out by hand, for the columns `proposable_columns()` admits. The omissions carry the
argument: `status`, `first_dbirth_at`, `reported_identity`, `identity_source` and `is_quarantined`
are what ingestion *observed*, and a proposal able to edit them would let an operator assert a
device's identity by describing it. `gateway_id` is the data path, which `0036` separated from
location precisely so a location change need not rewire one; `schema_id` belongs to
`publish_schema_version()`, transactionally.

**Two caps, doing two different jobs, and both in the database.** A partial unique index gives one
open proposal per asset per person — scoped to the proposer deliberately, since a cap on the asset
alone would let one person's forgotten proposal block everybody else from proposing against that
machine. A trigger reading `proposals.max_open_per_person` bounds total open proposals per person,
which is the one that actually bounds reviewer load. Neither lives in a button: the INSERT policy
admits a direct PostgREST write, and `0069`'s header already made the argument that a rule the
frontend applies and the database does not is "a frontend flag and therefore never an access
control".

**`status` is not writable through PostgREST at all.** An UPDATE policy can say who may write a
row; it cannot say which columns, and a proposer who could set `applied` would hold the asset write
the design exists to withhold. So the transition functions declare themselves with a session flag —
the same mechanism `aber.actor_id` uses — and a trigger refuses every other path. A proposer
may edit the `patch` and `rationale` of their own open row, which the caps make necessary rather
than convenient: told "you already have an open proposal on this device", they have to be able to
open it and add to it.

**Who the record names.** `device_nameplate.updated_by` becomes the **proposer** — the column's own
comment says a nameplate is an assertion about an asset, so who made it is part of the record —
while the `audit_trail` row names the **approver** in `changed_by` and carries `proposed_by` in
its payload. Both are in the record; neither column has to hold both.

**The timer is not a person.** An open proposal nobody acts on closes after
`proposals.open_expiry_days`, whose floor is 1: zero would auto-close every proposal at the moment
it was created — a working configuration in which the feature silently does nothing. Expiry leaves
`decided_by` NULL and declares `actor_source = 'service'`, because a scheduled job has no session
and is not a person. `proposals.retention_days` then prunes decided rows, so the queue arrives with
the retention answer every other durable store here has.

`0086` also adds `device_nameplate` and `change_proposals` to `audit_domain_for()`'s **asset** lane.
Both would otherwise take the fail-closed `security` branch, which would hide a
`Shopfloor_Manager`'s own act from that manager.

### A proposal says who asked, in something a person can read (`0089`)

`change_proposals.proposed_by` is a uuid and is the right thing to key on — it is what the policy
compares, what the per-person cap counts, and what `audit_trail.changed_by` carries. **It is also
unreadable.** An approver sees `a0000000` and there is nowhere in this stack to resolve it:
`auth.users` is not exposed to the browser and `list_machine_principals()` returns machines with no
email at all. So the queue could not answer the first question anybody asks about a request — who is
asking.

**The email comes out of the token, not out of a form.** The obvious repair is a "your name" box,
and `0089` deliberately does not build one: a typed name is exactly the shape this repository
already refuses elsewhere — [a self-declared marker is not
evidence](../ingestion/README.md#schema-conformance) — it is unverified, it can name somebody else,
and it would sit in the record of a change looking like an attribution. The signed access token
already carries the proposer's email, so `auth.email()` answers the question for nothing and cannot
be wrong.

**Stamped by a trigger, not by a `DEFAULT`, and that difference is the whole security of it.** A
default applies only when the column is omitted, so a client that *sends* `proposed_by_email` would
keep its own value — and this table takes a direct PostgREST INSERT from any `Operator` by design.
The trigger overwrites unconditionally, which is what `system_settings_stamp()` does to `updated_by`
for the same reason. Measured on the shipped stack: a client sending `ceo@example.com` alongside a
token for `stamp.probe@aber.test` stores the second. `0089`'s self-check fails if a `DEFAULT`
is ever added, because that would quietly turn the column back into a form field.

**It is a label, not an identity.** Nothing authorises on it, `proposed_by` remains the key, and an
email that changes in GoTrue does not retro-fit onto proposals already filed — the record says who
asked at the time. It joined the columns `0086`'s transition guard forbids a proposer to move, so it
cannot be rewritten under an approver who is already reading it, and `approve_proposal()` carries it
into the audit row beside the uuid.

### The schema lane, and the second approval gate (`0088`, withdrawn by `0090`)

> **This lane no longer exists.** [`0090`](#the-queue-moves-to-the-assets-an-operator-can-see-0090)
> withdrew it. The section is kept because the reasoning below — one function naming who decides
> each lane, rejection gated identically to approval, an act-shaped patch — is what the lanes that
> replaced it are built on. What `0088` could not supply was a reason for an `Operator` to be in
> this lane at all: a draft is created by `fork_schema()`, which needs `schema:manage`, so the only
> person who could create the draft was the only person who could publish it.

`0088` added the queue's second lane: an `Operator` proposed that a **draft schema be published**,
and an `Administrator` approved — at which point the approval called `publish_schema_version()`.

**One inbox, two approval gates, and the asymmetry is the substance.** A `Shopfloor_Manager` may
approve a nameplate edit and may **not** approve a schema publication, because `0069` withdrew
`schema:manage` from that role and [`0087`](#0069-narrowed-the-policies-and-the-rpcs-went-around-them-0087)
made the RPC enforce it. `may_decide_proposal()` is the one function naming who decides each lane,
read by both `approve_proposal()` and `reject_proposal()` so the two cannot drift apart — which is
the failure `0087` had just finished repairing between an RPC and the policies it was written to
match. It is fail-closed for a lane nobody has classified.

**Rejecting is gated identically to approving.** Rejection looks like the lesser act, but a manager
able to refuse a schema publication could block an Administrator-only decision indefinitely, and the
operator would read that refusal as the platform's answer.

**The lane proposes an act, not a column edit.** Publishing activates the draft, archives its
parent, repoints every `device_submodels` row and the legacy `devices.schema_id`, and drops the
duplicate links that would collide — one transaction. A patch of `{"status": "active"}` would name
one column write while the apply path did six other things, so the patch is `{"publish": true}` and
`proposable_columns()` returns `publish` for this lane. Its contract is *the keys a patch may name*:
columns for the asset lanes, the act for this one. Anything else — `{"publish": false}` above all —
is refused, because there is no such act to perform.

**A second table was the alternative and was rejected**: it would give the queue two shapes, two
caps, two retention answers and two pages, to model a difference that is one key in a JSONB column.

**The draft check runs twice, and both are needed.** At proposal time so an operator learns
immediately rather than after a week in a queue; at approval time inside `publish_schema_version()`
because the draft can be published by somebody else in between, and the approval is what has to be
right. `test_change_proposals.py` asserts that a draft published underneath an open proposal aborts
its approval.

**The audit row landed in the `security` domain**, because `audit_domain_for('schemas')` said so and
`0070`'s rule is who may perform the act. [`0120`](#the-lane-a-manager-was-offered-and-denied-0120)
moves `schemas` to the asset lane, which does not change the conclusion here: `audit_trail_select_asset`
admits Administrator, Shopfloor_Manager and Auditor, so the proposing `Operator` still cannot read
it. What they can read is their own proposal row, carrying `status`, `decided_by` and
`applied_trail_id`. The queue is the proposer's record; the trail is the platform's.

### The queue moves to the assets an Operator can see (`0090`)

`0090` does three things: it **withdraws the schema lane**, adds **five lanes** in its place, and
refuses to approve a proposal that **has already come true**.

**The withdrawal is about ingress, not about the lane's design.** `0088`'s lane worked exactly as
written. What it lacked was a reason for an `Operator` to be there: `fork_schema()` requires
`schema:manage`, withdrawn from every role but `Administrator` by `0069` and enforced at the RPC by
`0087` — so the only person who could create a draft was the only person who could publish it. An
`Operator` "proposing" a publication was endorsing somebody else's work rather than asking for a
change they could not make. That is a different feature, and this queue is for the second thing.
[`0087`](#0069-narrowed-the-policies-and-the-rpcs-went-around-them-0087) is **not** reverted: it
closed a live hole and stands on its own.

**The history is not retracted with the lane.** The `CHECK` constraint still admits the string, so
every schema proposal ever applied or rejected survives — a constraint that refused it would have
refused rows already in the table and failed the migration on any stack that had used the lane. The
lane is closed by `proposable_columns()` returning the empty array (so the validator's fail-closed
branch refuses a new one, and *names* the reason) and by `may_decide_proposal()` returning false.
Anything still open was withdrawn with a reason, because a row in a lane nobody can decide is worse
than either keeping the lane or deleting the row.

**Four lanes, one shape.** `cells` and `gateways` take the same shape as `devices`: a patch of
allowlisted columns over an existing row, where an absent key means *leave this alone*.

`0108` withdrew a second shape that `0090` had introduced. `cell_links`, `gateway_links` and
`device_links` made the patch a row to *create* in `links`, with `display_name` and `url` required
rather than optional. No page ever filed one: the modal that attaches a link writes to `links`
directly, through `link:manage`, which is how every link that exists got there, and the helper that
would have filed a proposal was exported, unit-tested and called by nothing. The withdrawal goes
further than the one `schemas` got — the CHECK constraint no longer admits the strings at all — and
every row in those lanes was deleted. `link:manage` is untouched: it gates the direct edit.
`audit_domain_for()` keeps its three link arms, so `audit_trail` rows written before `0108`
stay in the asset domain instead of silently becoming security-domain history.

**The new lanes resolve authority, not role names**, and `0087` is why: it found two predicates
deciding one question and disagreeing silently, with the wider one winning. A lane gated on
`cell:manage` cannot drift from the policy on `public.cells` in that way. The effective answer is
the same today — `Administrator` and `Shopfloor_Manager` hold all three grants — and the point is
what happens the day one is withdrawn: the lane closes with it rather than outliving it. The two
device lanes keep their role pair, because `device:manage` is held by exactly those two roles and
rewriting them would be a no-op with a migration's blast radius.

**What a gateway proposal may not name** is the security half, restated for a new table: not
`deployment`, `is_simulated`, `is_shadow` or `sparkplug_group` — those describe what
the gateway *is* and what it publishes under, and moving one re-points a broker topic namespace —
and not `status`, `last_heartbeat`, `agent_version`, `cert_expires_at` or any health column, which
are what the platform **observed**. A proposal able to edit those would let somebody assert a
gateway is healthy by describing it.

**A proposal that has already come true cannot be approved.** Nothing stops a `Shopfloor_Manager`
editing an asset while a proposal sits open against it, and nothing should — the queue is a way to
*ask*, not a lock. But it means a proposal can be overtaken, and approving it would write a
`PROPOSAL_APPLIED` row naming an approver and a patch for a change that did not happen in that
transaction: an act with no effect, attributed to somebody who did not perform it, while the real
change sits in an earlier row by somebody else. `proposal_is_already_true()` answers the question
and `approve_proposal()` refuses. The repair is to **reject** it — "already done, by hand, on
Tuesday" — which records what actually happened.

The test is `to_jsonb(current_row) @> patch`: **containment, not equality**. It asks whether the row
already holds every value the patch proposes and ignores the columns the patch says nothing about,
which is what a patch means. A partly-overtaken proposal is still approvable. A type mismatch
between a form's string and a typed column makes containment false — so the failure mode is
"approval proceeds", never "a real change is refused as a no-op". The function is granted to
`authenticated` so the queue can *warn* before somebody clicks rather than only refusing afterwards.

**`proposable_link_tags()` was dropped by `0108`**, along with the mirror check in
`scripts/check-mirror-drift.mjs` that compared it against `TAG_LABELS` in
`frontend/src/components/modals/EntityLinksModal.jsx`. `validate_change_proposal()` was its only
caller, and it validated for lanes that no longer exist. The tag vocabulary now has one home, the
modal; `links.link_tag` carries no `CHECK` and never did, so nothing in the database has an opinion
about the value — retro-fitting one to a table with rows in it is a different migration with a
different risk.

### A draft can be discarded (`0091`)

The Schemas page had been telling operators for some time that a draft can be *"published or
discarded"* — it is the tooltip on the disabled Fork control — and there was no way to discard one.

**That made the state a trap.** One draft may exist per lineage at a time, because forking is
refused while one is open (two drafts off one parent would create a second head). So the only exit
from a draft nobody wanted was to **publish** it — which activates it, archives the parent and
repoints every attached device. That is a considerable act to be pushed into by the absence of a
Cancel button.

**It is an RPC, and not the `DELETE` policy that already existed.** `schemas_delete_privileged` has
admitted an Administrator since the baseline, and that is precisely the problem:
`devices.schema_id` is `ON DELETE SET NULL` and `device_submodels.schema_id` is `ON DELETE CASCADE`,
so deleting an **active** schema silently detaches every device bound to it — no error, no warning,
and the next conformance run reports every metric as unmodelled. `discard_schema_draft()` refuses
anything whose status is not `draft`, and returns the number of device attachments the cascade
removed rather than letting them disappear out of sight. The policy is unchanged; what the UI calls
is now a door that cannot make that mistake.

**A draft may legitimately have devices attached** — `publish_schema_version()` depends on that
being possible, since somebody can attach a draft to a machine to try it out before publishing.
Those rows are what the cascade removes, and the count is surfaced so the toast can say so.

**The parent is untouched**, which is the whole point: discarding v2 leaves v1 active, attached and
unarchived, and the lineage returns to the state it was in before the fork. The `DELETE` writes its
own `audit_trail` row, because `schemas` has been in the audit trigger since `0070`. The gate is
`schema:manage`, matching what [`0087`](#0069-narrowed-the-policies-and-the-rpcs-went-around-them-0087)
put on `fork_schema()` and `publish_schema_version()` — a `SECURITY DEFINER` function bypasses RLS
entirely, so its own check is the only one there is.

### An archived schema stops taking new devices (`0093`)

[Issue #167](https://github.com/Harri-Llewelyn/Aber/issues/167). Publishing v2 archives v1 and
repoints every attached device in one transaction, so no machine is judged against a contract the
platform has moved past. The Edit Details dropdown then offered v1 back — one device at a time, with
nothing that would ever sweep it forward again. On a device set to `enforce`, being judged against
the superseded version means the daemon **drops readings from a healthy machine**, which is what made
an untidy dropdown critical.

**The guard forbids the MOVE, not the STATE.** A device already sitting on an archived schema is an
unfinished migration — the case `/v1/schema/{uuid}` above deliberately refuses to hide — and it has
to stay editable, or every rename, relocation and policy change on a device a publish could not reach
would freeze. So `reject_archived_schema_assignment()` returns early on an `UPDATE` that leaves
`schema_id` unchanged, and on a detach to `NULL`. What it refuses is an `INSERT` or an `UPDATE` that
*arrives at* an archived schema.

**Both arms, because a guard on one column is not a guard.** `device_schemas` unions
`device_submodels` with the legacy 1:1 `devices.schema_id`; the trigger is on both tables, one
function body switching on `TG_TABLE_NAME`.

**A draft is still assignable**, deliberately — attaching a draft to a real machine is how a version
is tried before publishing, and `publish_schema_version()` already merges that state rather than
treating it as a fault. **A shadow device is exempt**: `ensure_shadow_devices()` copies the origin's
schema so a replay is judged against the contract it was recorded under, and if the origin is
mid-migration the shadow has to be able to say so.

**Publishing still works because of an ordering it does not state.**
`publish_schema_version()` repoints the devices *before* it archives the parent. That was always
true; it is now load-bearing, and `test_publishing_still_works_with_the_guard_in_force` is what would
catch a reordering.

**The refusal names the successor**, looked up through `parent_schema_id`, because the operator who
reached it picked the wrong row out of a version history and needs to be told which row was right.

**It is in the database as well as the UI** because the dropdown is not the only writer: PostgREST is
a public write surface, and the approvals queue applies a patch on somebody else's behalf. A `CHECK`
cannot see another table and an RLS policy is bypassed by every `SECURITY DEFINER` path, which is why
this is a trigger and why the test suite runs it as the **owner** — this guard exempts nobody.

### A device behind a gateway that never arrived is not late (`0092`)

"Ingestion Consuming Nothing" is gated on `expected_publishers > 0`, because *"no traffic"* and *"no
traffic from a fleet that should be publishing"* are different conditions and only the second is a
fault. **The gate was still too wide.** It counted a device on the strength of
`gateway_id IS NOT NULL` — being *bound* to a gateway, regardless of whether that gateway had ever
existed anywhere but in the database.

Register a device, point it at a gateway whose bundle nobody has deployed yet, and ten minutes later
the platform raises a **critical** alert reading *"Telemetry is not reaching the historian. Check the
broker connection."* Nothing is wrong with the broker, the daemon or the historian — the edge node
was never set up. The alert names the wrong subsystem, at the highest severity, during the exact
task where somebody is least equipped to tell a real fault from a false one.

**A path has to have existed at least once**, and a device now qualifies on either piece of evidence
for that: its own `first_dbirth_at IS NOT NULL`, or its gateway's `last_heartbeat IS NOT NULL`.
`0001`'s comment on that column is the contract this leans on — *"NULL means no heartbeat has ever
arrived"* — and nothing clears it once set, so it is a record of first contact rather than a
liveness reading. **A gateway that was publishing and has died still counts**, which is correct:
that is the case the alert exists for. Only the gateway that has *never* arrived is excluded, and
that distinction is available precisely because the column is never cleared.

`enrolled_at` was rejected as the signal because enrolment issues a credential and does not prove
anything was deployed with it; `status = 'ONLINE'` because it is a liveness reading, and gating on
it would disable the alert in the one state it exists for.

**The file was generated from `0001`'s own text rather than retyped.** `platform_health_rows()` is
one SQL body, so changing one clause means redeclaring all four conditions — and a dropped condition
is silent, because the rule reading it goes to NoData and several of these treat NoData as OK. The
self-check asserts that the two conditions reported even at zero still come back.

### `relocate_devices()` — one rearrangement, one causation

`0033`. Takes the WHOLE batch of staged moves as a `jsonb` array and applies it in one
transaction, which is the only reason it exists.

**The audit trail is the point, not the request count.** Device writes go through PostgREST per
row, so reassigning six machines one row at a time was six `UPDATE`s: six transactions,
six `causation_id`s, and six rows in `audit_trail` describing one decision an operator took
once. Nothing in `0033` stamps an audit row — `log_audit_trail_event()` already writes
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
  counting it would promise a trail row that deliberately does not exist — and the UI would
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

**The template is substituted at boot.** [`envoy.yaml`](envoy.yaml) is committed with
`__UPPER_SNAKE__` placeholders and substituted by an initContainer on the gateway pod. Not by
Helm at template time, because with an externally-managed Secret the chart cannot see the key
values and would substitute empty strings, which the key check would then accept. The initContainer
scans for surviving markers and fails; adding a placeholder means teaching it the new one
([`check-gateway-surface.mjs`](../scripts/check-gateway-surface.mjs) asserts it).

Two placeholders carry the Realtime upstream. Realtime resolves its tenant
from the **leading hostname label**, so `__REALTIME_UPSTREAM_HOST__` is the Host header
(`realtime-dev`) and
`__REALTIME_UPSTREAM_ADDRESS__` is what Envoy dials. The substituter refuses a host that does not
begin `realtime-dev`.

The `apikey` check gates `/rest/v1/`, `/realtime/v1/`, `/storage/v1/` and `/functions/v1/`, and
accepts the `sb_publishable_*` / `sb_secret_*` keys
([`docs/gateway.md`](../docs/gateway.md)). **Six routes are open, across four
exemptions:**

| Route(s) | Exemption | Why |
| :--- | :--- | :--- |
| `/auth/v1/` | sign-in | GoTrue authenticates its own callers and is the OAuth 2.1 server the other logins use. Sign-in must work before any session exists |
| `/storage/v1/object/public/` | public objects | An AAS `File` URL must resolve for a viewer holding no session. Routed before `/storage/v1/`, with `/object/public/` preserved in the upstream path |
| `/functions/v1/grafana-userinfo`, `/functions/v1/nodered-userinfo` | OAuth userinfo | An OAuth client presents client credentials, never a Supabase apikey. Exact paths, before `/functions/v1/`, so a function added later is gated by default |
| `/ping`, `/v1/` | Factory+ Directory | A Factory+ client has no apikey. `/ping` is open by specification; `/v1/` is authenticated by the **function**, which refuses a request with no bearer and queries as the caller, so RLS applies |

**The table is asserted, not maintained by hand.** `check-gateway-surface.mjs` compares the whole
routing and authentication surface against a reviewed inventory, because `validate.py` asserts the
401s that should happen and nothing can assert the absence of a route nobody wrote.

**The edge functions are baked into an image** (`functions/Dockerfile`, built from the repository
root by convention; the appliance's files reach the functions as a generated module under
`_shared/`), so a rollback rolls the functions back with it.

### What the file relies on that Envoy does not say

The template's own comments state each route and filter; the semantics they depend on are these,
because each one produces a stack that looks fine and is not when it is forgotten.

- **Route order is first-match.** `/storage/v1/object/public/` precedes `/storage/v1/`, and the
  userinfo paths precede `/functions/v1/`, so an exemption is a route placed before the gate.
- **Realtime keeps its key and rewrites its Host.** The Realtime client puts the key in the
  WebSocket URL's query string, so a header-only check leaves Realtime permanently 401; it also
  parses the key, so the gateway replaces it with the JWT it stands for rather than stripping it.
  Realtime reads its tenant from the leading Host label, so `host_rewrite_literal` is required.
- **Credential hiding is per route.** Every other route strips the key from both the header and
  the query string, because a query-string `apikey` reaching PostgREST is parsed as a column filter
  (`PGRST100`).
- **The Directory routes keep their path.** `main/index.ts` reads the first segment to pick a
  worker, so the rewrite carries `/fplus-directory/` in front of the original path.
- **SDS takes one secret per file.** A path config source carrying two resources is accepted at
  boot and rejected at runtime, so each login listener reads its client secret and its HMAC secret
  from separate files.
- **The session cap is per door.** `default_refresh_token_expires_in: 3600s` matches
  `GOTRUE_JWT_EXP` and re-derives who is at the keyboard hourly; it is set on the two login
  listeners rather than stack-wide, which would also expire the wall-mounted dashboards.
- **Cookies are scoped by host, not port.** The forge listener renames every cookie the `oauth2`
  filter sets, because on `localhost` its door and Studio's would otherwise sign each other out.
- **`%REQ_WITHOUT_QUERY%` is an extension.** The login listeners log the path without its query
  because `/oauth2/callback` carries the authorization code there, and the formatter has to be
  registered in the access log or Envoy refuses the whole configuration.
- **The placement filter fails open on a 5xx.** `forge-membership` runs as `ext_authz` with
  `failure_mode_allow`: a function that cannot answer lets the request through, because the role
  in the token was already admitted by RBAC; a 403 and a 302 (a dead session, to
  `/oauth2/signout`) are honoured, and only the `Authorization` header travels to it.
- **Clusters are `STRICT_DNS`.** Envoy re-resolves on its refresh interval, and a recreated
  container changes address.

### The second listener, which is Studio's login (`0081`)

**The gateway carries a second listener on `8001`, and everything above describes the first.** They
share a process and nothing else: no filters, no routes, no credentials. The API listener admits
machine principals holding an `apikey`; this one admits a person holding a browser session, and the
separation is the design rather than an implementation detail — a cookie-session filter on the API
path would redirect every daemon in the stack to a login screen it cannot complete.

Studio has no authentication of its own and connects as the database owner. Three filters supply
what it lacks:

| Filter | What it does | The thing worth knowing |
| :--- | :--- | :--- |
| `oauth2` | Runs the authorization-code flow against this stack's GoTrue and holds the session cookie | Needs **Envoy ≥ 1.34**: GoTrue requires PKCE and the filter could not send it before that release |
| `jwt_authn` | Verifies the access token GoTrue signed | An **`oct` JWKS** — the HS256 secret, not a public key — and **no issuer check**, because GoTrue's OAuth access token carries no `iss` claim |
| `rbac` | Requires `app_metadata.role == Administrator` | Reads the claim out of the verified payload; every persona can complete the flow, and only one gets through this |

**`0081` registers the client** — `c0ffee00-…-0003`, the third of the same shape after Grafana
(`0002`) and Node-RED (archived `0006`) — with `client_secret_basic`, matching the filter's
`auth_type: BASIC_AUTH`. GoTrue enforces the registered method exactly.

**What differs from the other two clients is that there is no userinfo function, and there must not
be.** Grafana and Node-RED call one because GoTrue's OIDC claims carry no `app_metadata`;
`custom_access_token_hook` puts the role in the *access* token, and this listener verifies that
token itself. The role arrives in the request rather than being fetched about it — one fewer edge
function, and one fewer round trip per request.

**`openid` is absent from the requested scope and must stay absent.** GoTrue refuses to mint an ID
token while signing HS256 (`HS256 is not supported for ID token signing`), which is what the whole
stack signs with; `grafana.ini` carries the same note for the same reason.

#### Nothing upgrades on this listener, and that was measured rather than assumed

The console's one websocket is the Realtime inspector's, and it does not arrive here:
`/api/platform/projects/default/settings` hands the browser `endpoint: 127.0.0.1:54321`, so the
handshake goes to the **API** listener, which answers `101` and always has. Studio's own client
bundle constructs no socket against its own origin and its server declares no upgrade handler; an
upgrade sent to it through this listener is forwarded and then reset by Studio, which Envoy reports
as `503 upstream connect error` — the upstream refusing, not the gateway blocking. An unauthenticated
upgrade attempt is answered by the same `302` to sign-in as any other request, so a socket is not a
way past the door.

`upgrade_configs` is declared anyway. It costs nothing, and a Studio version that grows a socket
would otherwise fail with a `426` naming neither the line nor its absence.

#### The read-only branch, which was broken rather than wide (`0082`)

Studio picks its database user per request — `readOnly ? POSTGRES_USER_READ_ONLY :
POSTGRES_USER_READ_WRITE`, with one `POSTGRES_PASSWORD` substituted into both. This stack set only
the read-write half, and **the entry that asked for this predicted the wrong failure**: it reasoned
that the unset variable meant the read-only paths were handed the owner. They were not. The image's
own default for that variable is `supabase_read_only_user`, so those paths already asked for the
restricted role — and got `password authentication failed`, because the role ships **with no
password** while `pg_hba.conf` trusts `127.0.0.1` and requires `scram-sha-256` from every container
network. Read-only mode was not too powerful; it did not work.

That also inverts what the fix is. Setting `POSTGRES_USER_READ_ONLY` explicitly changes no
behaviour — it names the value the image already defaults to, and is set explicitly so the
dependency is visible rather than inherited. **What makes the difference is the password**, and it
is issued in the roles-init step rather than here: `supabase_read_only_user` is a RESERVED role
(`only superusers can modify it`), and `db-init` connects as `postgres`, which is not a superuser on
this image. So the `ALTER` sits beside the three scoped passwords in `supabase-db-roles-init` /
`db-roles-init`, and `0082` holds the assertions — that the role exists, has a password, still holds
`pg_read_all_data`, and **cannot write**, which is an `EXCEPTION` rather than a warning.

**Which paths actually take it, measured** with `log_connections` on and one request per path:

| Path | Connects as |
| :--- | :--- |
| `/api/mcp?read_only=true` | **`supabase_read_only_user`** |
| `/api/mcp` (no flag) | `postgres` |
| SQL editor (`/api/platform/pg-meta/default/query`), with or without `read_only` in the body | `postgres` |
| Table editor listings (`/tables`) | `postgres` |

So this narrows **one** caller: an MCP client that asks for read-only mode. Under it a write is
refused — `cannot execute CREATE TABLE in a read-only transaction` — and reads still work, because
the image's role holds `pg_read_all_data` and `BYPASSRLS`. Everything a human does in the console
still runs as the owner, and no setting in this repository changes that: the table editor cannot use
a read-only connection, and the SQL editor does not ask for one.

**Which is why the `Administrator` check is load bearing rather than tidy.** Studio's own
`/api/platform/projects/default/settings` hands whoever is signed in the project's `jwt_secret` and
both service API keys, and the SQL editor runs as the owner. The door is not defence in depth over a
restricted console; it is the only thing between a signed-in session and the database.

**The password is the owner's, necessarily.** The image substitutes one password into both branches,
so there is no separate secret to hold: this role cannot be rotated independently of `postgres`. It
is not a new exposure — anything that can read it can already read `POSTGRES_PASSWORD`, in the same
environment, in the same container — but it is a real limit on what this control is, and `0082`
states it rather than absorbing it.

**Two operational consequences.** The listener publishes on the port Studio itself used to publish,
so `0002`'s Directory entry stays true and the container publishes nothing. And both halves fail
closed: without `STUDIO_OAUTH_CLIENT_SECRET`, `0081` skips the registration with a `WARNING` and the
substituter renders credentials that cannot authenticate — a stack that runs normally with a console
nobody can open, which is the same posture as the loopback binding it replaces.

---

### The forge's door, and the room behind it (`0094`)

Gitea's web login is the gateway's `forge` listener in [`envoy.yaml`](envoy.yaml), on `8002`
(`git.<domain>`). It is the Studio listener with the
RBAC widened: an OAuth 2.1 code flow against this stack's GoTrue, a session cookie, `jwt_authn`
against the shared secret, and a role check admitting `Administrator` and `Shopfloor_Manager`.
`Operator` and `Auditor` complete the login and meet a 403. `0094` registers the OAuth client and
puts the forge in the Directory.

**Gitea is not an OIDC client of GoTrue, and cannot be.** Three things were measured against
`gitea/gitea:1.27.3`: GoTrue's discovery document carries an empty `issuer` and relative endpoint
paths, so Gitea resolves `/oauth/authorize` against itself; its request carries `scope=openid`,
which GoTrue refuses with `HS256 is not supported for ID token signing`; and whether it sends the
`code_challenge` GoTrue requires is unmeasured behind the first two. Moving the stack off HS256
would be necessary and not sufficient, since the relative paths would remain.

**Identity enters Gitea as headers**, through `ENABLE_REVERSE_PROXY_AUTHENTICATION` with
auto-registration. The username is the token's `sub` (Gitea refuses `@` in a name), the email rides
in its own header, and the full name carries the email so the UI shows a person. Gitea trusts
`X-WEBAUTH-USER` from **any** peer — `REVERSE_PROXY_TRUSTED_PROXIES` governs `X-Forwarded-For`
only — so the access control is reachability: the NetworkPolicy edge list admits only the gateway
and the edge runtime. The API ignores the header (`ENABLE_REVERSE_PROXY_AUTHENTICATION_API` off), so the machine
account's basic-auth path is not a second door. The listener overwrites or removes the identity
headers on every route, so a value a browser sent never reaches Gitea.

**Membership is placed on the way through** by [`forge-membership`](functions/forge-membership),
the listener's `ext_authz` step: one call per non-static request, the role read from `user_roles`,
and the person placed in the team that role warrants — `administrators` or `managers` in the
`gateways` organisation — through the machine account. A login whose role has gone since the
token was signed is taken out of both teams and refused. What that does not cover is a revoked
login that never returns, which is what [the sweep on a timer](#the-forge-is-swept-on-a-timer-0099)
is for.

**Authorisation stays in Postgres.** `user_roles` and `has_role()` decide who passes the door;
Gitea's teams decide what they may do inside, and the team is a function of the verified role,
never of anything the person chose. `main` is protected on every gateway repository with one
approval required from `administrators` ([`_shared/forge.ts`](functions/_shared/forge.ts)), which
is where `gitops:manage` being Administrator-only is enforced inside the forge. Gitea's own
sign-out link is routed to `forge-signout`, which ends every GoTrue session the caller holds,
because under reverse-proxy authentication Gitea's own sign-out is a no-op.

Two things a laptop finds and a cluster does not: the listener renames all seven of its cookies,
because browsers scope cookies by host and not port, so on `localhost` this door and Studio's would
otherwise sign each other out; and `/assets/ssh_host_key.pub` and `/api/` pass the door without a
session, in all three filters, because the host key is public and the API authenticates itself.
`test_forge_membership.py` drives the whole flow for all three personas.

### What a gateway's repository comes with, and how the forge reports back (`0095`)

Enrolment furnishes the repository as well as creating it
([`_shared/forge.ts`](functions/_shared/forge.ts)). Its **wiki** starts with a Home page naming the
gateway and saying what belongs there: what a person needs to know and the appliance never reads.
The wiki is a second git repository beside the first, edited in place by either team with no
protection and no pull request, which is the right shape for notes and the wrong one for anything
the appliance deploys, and the page says so. Seeded once, never overwritten. Its **issues** start
with an *Incident* template and label, committed to `main` in the one moment the machine account
still may — immediately before the branch is protected, because `enable_push: false` binds the
machine account too and the contents API answers 403 afterwards. A repository from before this
gets no template from enrolment; an administrator adds one by pull request. Projects and Packages
are hidden from every repository (`DISABLED_REPO_UNITS`). Both teams may **create repositories**
in the organisation, for a playbook a class of gateway is provisioned from; a hand-made one carries
no protection until a gateway enrols under its name and adopts it. The gateway drawer links the
repository, its issues and its wiki as three acts.

**The forge reports a push.** Enrolment registers a webhook on the repository (`branch_filter:
{main,appliance}`, one per repository rather than one on the organisation, because only a
gateway's repository has a row to record on). Gitea delivers every push to `main` to
[`forge-events`](functions/forge-events), directly over the NetworkPolicy edge
`gitea → supabase-functions`, never through the gateway. The
delivery's `X-Gitea-Signature` — hex HMAC-SHA256 of the raw body under `GITEA_WEBHOOK_SECRET` — is
the whole of the authentication, verified over the bytes before they are parsed. On a verified push
`0095`'s columns on `gateways` record the head: `forge_head_sha`, the message's first line, who,
when, and the SHA-256 of `flows.json` at that commit, read through the machine account. The drawer
shows it as **Committed**, so a merge is visible at once rather than on the appliance's next tick.
Pushes to other branches, repositories that are not a gateway's, deleted branches and unknown
gateways are answered 200 with `ignored`, because a non-2xx is a failed delivery on the hook's page.
Gitea's `webhook.ALLOWED_HOST_LIST` defaults to public addresses only and refuses every in-stack
target; it is `private` here. `0095` ends with `ensure_gateway_status_view()`, and the baseline's
dumped copy of that view became a call to the same function, because `CREATE OR REPLACE VIEW`
cannot narrow a view the function has just widened and every boot after the first was failing in
`0001`.

**The drift check.** `flow_hash` is the same digest from the other side: `flow-sync.mjs` records
the SHA-256 of every flow it deploys in `/data/gitops/deployed.json` (and `bootstrap.mjs` records
the enrolment flow there in the same shape), a `file in` node in the appliance's flow reads that
record every minute into the flow cache, and the heartbeat reports it as `Flow_Hash`. It is a file
and not an environment variable because a reload does not re-source `gateway.env`; an appliance
enrolled before this reports its enrolment hash until it is re-enrolled, and reads as differing.
The drawer's **Flow** row compares the two: equal is *matches main*; different within two sync
intervals of the push is *main moved, deploying*; different past that is *differs from main*, in
red, and the appliance's `flow-sync` log says why. An edit made in the Node-RED editor is in
neither digest; the next approved deploy overwrites it. `frontend/src/utils/flowDrift.js` holds the
states and `scripts/check-gateway-flow-template.mjs` asserts the flow reads the file both scripts
name. `test_forge_events.py` covers the signature, what is recorded and ignored, and one delivery
sent by the forge itself for a freshly enrolled gateway.

**A deployed flow is an event, and a reading is not (`0100`).** The audit trigger compared whole
rows minus `last_heartbeat`, and an appliance rewrites six more columns on every heartbeat, so
each one that carried health appended an UPDATE row: 2,880 a day per appliance, none an event.
`audit_telemetry_columns()` names those columns and the trigger subtracts them all. The one
reading that is an event, the flow hash, is in that list too, and `ingest_record_gateway_health()`
records its change itself as a `FLOW_DEPLOYED` row: the digest before and after, the gateway's
identity at the time, and what the forge's `main` held at that moment as `matches_main`. Actor
`ingestion`, no user, as a schema rejection is: the puller never touches this database, the
heartbeat is its only channel, and the daemon is the witness, so no fourth actor kind was needed
and the approvals queue's expiry timer stays `service`. `cert_expires_at` and `agent_version` stay
in the generic comparison, since a re-enrolment or an in-place upgrade is an event.
`test_gateway_flow_deployed.py` proves both halves on the throwaway database.

**The forge is swept on a timer (`0099`).** `forge-membership` acts on the way through the door,
so a login whose role was revoked and who never returns keeps its team membership, usable over SSH
if they had added a key. `sweep_forge()` asks the `forge-sweep` function for one pass every fifteen
minutes through pg_net, authorised by `FORGE_SWEEP_SECRET` from Vault and nothing else: every
member of either team whose `user_roles` row no longer maps to it is removed, every login the forge
knows that holds an admitted role is seated, every gateway repository gets its push webhook and
branch protection back, and a repository somebody made by hand in the organisation has `main`
protected the same way, without the incident template, because a playbook a gateway later adopts
should have been reviewed from the start. A member who is not a dashboard identity was seated by
hand and is left alone. Nothing is created that enrolment would not create, and nothing is deleted.
An empty secret leaves the sweep inert, and `0002` says so at boot. `test_forge_sweep.py` drives a
role changed behind the door, a deleted hook and a hand-made repository. One pass runs at a time
([One pass at a time](#one-pass-at-a-time-0025)).

### The appliance reports on a branch of its own (`0104`)

`main` is what was approved; **`appliance` is what is running**, a second branch in the gateway's
repository written only by the appliance and read by people in the forge. After every pass
`flow-sync.mjs` pushes an allowlist there when it has changed, `flows.json` as Node-RED is running
it and `deployed.json`, and never widens it: `flows_cred.json` is on no list, and a staged path
outside the list aborts the commit on the appliance. The branch is based on the repository's root
commit so the two branches share an ancestor and the forge's compare view between them
(`compare/main..appliance`, two dots for the direct diff) is the drift diff, which the drawer's
repository panel links as **Running vs approved** once the appliance has pushed.

**The deploy key is read-write, and three rules make that a reporting key.** `read_only` in
[`_shared/forge.ts`](functions/_shared/forge.ts) flipped, on the gateway's own repository only.
`main` keeps `enable_push: false` with deploy keys not whitelisted; an `appliance` rule admits
pushes from deploy keys and from nobody else and blocks force-push; and a `**` rule closes every
other branch to deploy keys while admitting both teams. Four things were measured against
`gitea/gitea:1.27.3`: a rule can be created before its branch exists; rules are matched by
ascending priority and the first match decides, so the catch-all is created at priority 1000;
`*` as a rule name does not match a slash, so `feature/x` stayed open until the rule became `**`;
and the machine account's contents API answers 403 on `appliance`, so nothing but a deploy key
writes it. Enrolment creates both rules before it registers the key, and removes every other
key on the repository, because a re-enrolment is a replaced appliance. The same key can be
registered in a different mode on another repository (`key_id` is shared, `read_only` is per
repository; measured), which is what the platform repository will use.

**One thing no rule covers.** A writable deploy key can push to the repository's wiki (measured:
a clone of `<repo>.wiki.git` with the key and a push to it succeed). The wiki therefore stops
being a place only people wrote; [Accepted risks](../README.md#accepted-risks) records the
decision to keep it there.

**The webhook records both heads.** Its branch filter is `{main,appliance}`; the sweep patches a
hook registered before this. Gitea resolves a push's hooks when it processes the queued push
rather than when the push happens, so the incident template committed a moment before the hook is
registered is delivered too, and a fresh repository's **Committed** row is filled at enrolment
(measured). `forge-events` records a push to `appliance` as
`forge_appliance_sha`, `forge_appliance_at` and `forge_appliance_flow_sha256`, the digest of the
flows.json on that branch, and names nobody: a deploy-key push carries whatever author the
appliance set. The drawer's **Reported** row shows the head and says *edited on the appliance*
when that digest differs from the heartbeat's `flow_hash`, which is an edit made in the box's
editor since the last deploy (`flowEditedOnAppliance()` in `frontend/src/utils/flowDrift.js`).

**The sweep reconciles keys, the third revocation handle.** A gateway holds four things and
loses all four on archive: the broker client (`disableClient`), any unredeemed enrolment token
(`withdraw_gateway_enrollment_tokens()`), the deploy key, and — since `0114`, below — the
repository's own writability. `forge-sweep` reads
`gateways` and, per gateway repository, removes every key when the row is archived or gone, and
re-registers a read-only key read-write when the row is active, from the material the forge lists
(Gitea has no edit for a deploy key). It also creates the two rules on a repository from before
this and closes `main` again if a rule was found admitting pushes. `test_forge_events.py` covers
the appliance push; `test_forge_sweep.py` covers the rules, a key downgraded by hand, an archived
gateway's key, and the archive mark below.

### Archiving a gateway reaches the forge (`0114`)

**Archiving a gateway archives its repository, which is the fourth thing it loses**
([#197](https://github.com/Harri-Llewelyn/Aber/issues/197)). The key stops the appliance
reaching the repository and does nothing about the repository itself, which went on reading in the
forge's own listing exactly like one in service — and the forge is where a gateway's flow and a
plant's notes about it live, so it was the one place the archive was invisible. The sweep now sets
Gitea's own archive mark (`PATCH /repos/{owner}/{repo}`), which makes the repository read-only and
badges it while keeping every branch, issue and wiki page — including `appliance`, the last thing
the gateway reported, which is a better record than the heartbeat table, because that stops. A
restored gateway's repository comes back out, **first in the pass**: everything else the sweep does
is a write, and Gitea refuses writes to an archived repository.

**Nothing deletes a repository, and that is the decision rather than an omission.** The wiki is the
one place a plant's notes about a gateway live, so a delete is a decision a person takes in the
forge, never a cascade from the dashboard; the forge is in every backup, and that is the retention
answer rather than a second one. A repository whose gateway row is gone is archived, not removed.

**Where the call lives** was the open question the request left. Not a new edge function: the
database holds no forge credential and reaches Gitea through nothing, and the sweep already
enumerates the organisation and matches each repository to its row. `0114` adds only the
immediacy — `trg_gateways_forge_follows_archive` asks for one pass through `sweep_forge()`'s
existing pg_net call as the archive lands, so the fifteen-minute timer is the retry rather than the
first attempt. `forge_archived_at` is written by the sweep once the forge has answered, **not**
stamped optimistically as `credential_revoked_at` is: a stamp written in the trigger would tell the
dashboard a repository was archived on a deployment that has no forge at all.

**`0110` records that the repository exists, because enrolment's own timestamp does not.**
`enroll-gateway` sets `enrolled_at` in step 3 and creates the repository in step 4, and step 4 is
non-fatal by construction: it is skipped on a deployment with no forge, skipped when the appliance
sent no usable public key, and survives its own failure. So `enrolled_at IS NOT NULL` is necessary
for a repository to exist and not sufficient, and a page reading it offered four links that answer
404 — on a stack with no forge, four links to whatever address the frontend falls back to.
`forge_repository_at` is written by step 4 itself, and by the sweep for a repository it finds whose
row carries none, so a fleet enrolled before the column existed settles on the next pass rather than
needing a backfill nothing can compute. The migration backfills only rows with a push recorded
against them (`forge_head_sha` or `forge_appliance_sha`), which proves a repository. Nothing clears
it: a sweep that could not reach the forge must not read as *the repository is gone*.

**`0111` says how far back each telemetry resolution actually reaches.** Exporting telemetry over a
range older than the raw retention window returned nothing and reported *"No telemetry in that range
for the selected metrics"* — a sentence describing a device that published nothing, when what
happened is that the chunks were dropped and the data is still held in a rollup
([#160](https://github.com/Harri-Llewelyn/Aber/issues/160)). To offer that rollup the dialog has
to know what each resolution still covers, and **the retention settings cannot answer it**: they say
what will eventually be dropped, not what is there. A stack installed three weeks ago holds three
weeks of raw however `retainFor` is set, and widening a policy does not restore deleted chunks.

`timescale.telemetry_horizons` maps a view in `timescaledb/aggregates.sql` that reads `min()` from
the raw hypertable and each rollup. It is evaluated on the other side for the reason
`telemetry_latest` is: `postgres_fdw` pushes `WHERE` down but **not** `LIMIT`, so
`ORDER BY time LIMIT 1` over the projection would stream the relation across the link to discard all
but one row. Four rows cross instead. A null `oldest` means that relation is empty — not that it
fails to reach that far, which is a distinction the dialog acts on: an empty stack covers nothing at
any resolution, so there is no better one to offer.

Readable by `authenticated` with no per-row policy, because it carries no metric values and no device
identity: four relation names and four timestamps. Retention is a property of the chunk rather than
of a device, so there is nothing to filter by either.

### One pass at a time (`0025`)

**Every step of a pass reads the forge and then writes**, so two passes that overlap both write.
The webhook was the case seen: `ensureWebhook()` lists a repository's hooks and creates ours when
none matches, and two passes that both listed before either created left two hooks, so
`forge-events` received every push twice. Deploy keys, team seats and branch protection have the
same shape. Passes began to overlap once the database's calls reached the function on Kubernetes:
`sweep_forge()` asks every fifteen minutes and on every archive transition, one call per gateway
row, and people and the stack suite call the function directly.

**A pass is exclusive.** `forge_sweep_lease` is one row. Before it reads anything a pass calls
`claim_forge_sweep(300)`, a conditional `UPDATE … WHERE held_until <= clock_timestamp()`, so two
claims at the same instant serialise on the row lock and exactly one wins. It calls
`release_forge_sweep()` in a `finally`, before it answers. A call that finds the lease held does
nothing and answers **`200 {"already_sweeping": true}`** at once: 200 because pg_net records the
status in `net._http_response`, which is the only record of a sweep the database asked for, and a
call that met a running pass did not fail. **The lease lasts five minutes**, above the 60 seconds the
edge runtime gives a worker (`main/index.ts`) and pg_net gives the call, so it outlasts a pass only
when the pass died holding it, and the first claim after `held_until` takes it over. Raise it with
either limit. Each claim returns a fresh holder id and only that id renews or releases, so a pass
that outlived its lease cannot end its successor's.

**Nothing asked for is lost.** A refused claim sets `requested`, and the release that ends the
running pass queues one more through `sweep_forge()` when it is set. An archive whose call arrived
after the running pass had read the gateway rows is followed within seconds rather than at the next
quarter hour, and any number of calls refused during one pass come to that one follow-up. A pass
that starts clears `requested`, because it reads everything committed before it.

**A caller may hold the lease itself.** The three functions are `service_role`'s, and the table is
readable by it and written only through them. A caller holding the lease names it in
`x-sweep-lease`: the pass renews it, runs under it and leaves it held, and a lease the caller does
not hold answers 409. `test_forge_sweep.py` holds it for each test, so the database's own asks (an
archive's trigger, the schedule, one a previous test queued) are refused while a test changes the
forge and reads its own pass's report. `test_forge_follows_the_archive.py` covers the claim, the
takeover, the release and the follow-up on the throwaway database.

**Duplicates converge.** `ensureWebhook()` deletes every hook of ours but one, the oldest with the
right branch filter, so a repository that already has two, or gets two from an enrolment racing a
pass, ends with one.

### Archiving is a lifecycle rather than a flag (`0124`)

**Archiving was one flag, a timestamp and a timer, and an area could not be archived at all.** A
cell's archive set the flag and nothing else; a device's stopped its readings and set the flag;
only a gateway's meant anything further, and that half is above. Underneath, nothing heard: the
replay lane a device had been given stayed live on the playback gateway, deleting the original left
that lane standing in for nothing (`shadow_of` is `ON DELETE SET NULL`, which `0083` tolerates
deliberately), and deleting anything removed it from the Archived Entities page entirely, which was
the one act the page could not account for. `0124` makes the four missing pieces one lifecycle:
archived, then retired, with the record's history and identifiers surviving both.

**Areas archive like everything else.** The three columns, the same dialog, and a fourth `DELETE`
in `purge_expired_archives`, **areas last and only those nothing names**: the job is one
transaction, and an area-wide device or gateway still pointing at an area would abort the whole
pass, so the DELETE carries a `NOT EXISTS` guard over both and the area waits for the asset to be
moved. **An archived area moves nothing beneath it**, which was the first question the entry asked:
`areas.name` is a segment of every `uns/` topic under it, and `device_locations` never consults
`is_archived`, so the cells stay filed and the topics keep their name, exactly as an archived cell
behaves. The Site Map keeps drawing its plan, muted, with the archive glyph where the status dot
was, because a card that vanished would misplace what is still under it. The Areas page offers
Archive and Restore where it offered Delete; deleting an area is done from Archived Entities, like
every other type. `validate_change_proposal()` gains the `is_archived` test on its areas arm
that `0123` could not write because the column did not exist.

**A shadow follows its original.** One function, `shadow_follows_its_original()`, attached twice:
`AFTER UPDATE OF is_archived` copies the flag, the timestamp and the timer to every lane whose
`shadow_of` is the device, and `BEFORE DELETE` deletes the lanes first, so a restored machine
gets its lane back and a deleted one takes it along. The FK stays `SET NULL` and `0083`'s gate
stays silent about a lane already orphaned: a lane whose original went before `0124`, or whose
`shadow_of` was cleared by hand, is still a legal state, and the suite for `0083` now asserts the
orphan is *edited* rather than *made* by a delete.

**A tombstone is written on the way out, not derived later.** The audit trail's `DELETE` row
carries the whole row as `old_data`, but the trail is month-partitioned for an eventual
`DETACH` that would take the oldest tombstones with it, so `retired_entities` is a small table of
its own: type, id, the name and `sparkplug_id` the row had, when it was archived and retired, who
retired it (nobody, when the timer did), the id of the trail's `DELETE` row, and `old_data`.
`record_retired_entity()` writes it from an `AFTER DELETE` trigger on all four tables **and only
for a row that was archived**: a delete that skipped the archive stage is still recorded by the
trail, but it is not a retirement. Readable by `archive:manage` or `audit_trail:read`; no
write policy exists, and the trigger runs as definer. The Archived Entities page gains its second
card from this table, and each tombstone links to what survives it: the audit trail (opened with
deleted entities shown), a gateway's repository in the forge (derived from the id as everywhere
else; `0114` archived it and nothing deletes it), any bundle exported while the device was alive,
and the historian id its readings are still keyed by. The vocabulary stayed in the UI: the first
card is *Archived* and the second *Retired*, and no column was added to say so.

**An asset can be taken away before it is taken out of service.** `aas-export?format=bundle`
returns the same AASX as `format=aasx`, the same Environment and OPC chain, with supplementary
parts under `aasx/files/aber/`: the device's audit trail as JSON, the readings still in
the live historian at raw and hourly resolution as CSV, and a manifest
(`aber/asset-bundle/2`) that says what each part holds, where it was cut, and which cold-tier
objects hold what the live historian no longer does. **The bundle states rather than reaches for.**
Cold telemetry keeps its no-read-back rule, so the manifest names the objects whose range overlaps
the device's life and fetches none of them; both telemetry parts are capped, newest first
(`ASSET_EXPORT_MAX_TELEMETRY_ROWS`, `ASSET_EXPORT_MAX_TRAIL_ROWS`, defaults in the function),
and a cap that was hit is a sentence under `not_included` rather than a silent tail. The hourly
rollup is included because it reaches years further back than raw (`0111`); the minute rollups
are not, and the manifest says so. A copy is stored in the cold tier's bucket under
`assets/<sparkplug_id>/<stamp>.aasx` and recorded in `asset_exports` with its SHA-256, so a
tombstone can still offer the download; it is **not** a row in the cold manifest, which is keyed by
chunk and exists to make dropping a chunk safe, and a per-asset bundle has no chunk. A storage
failure does not fail the export: the file is still returned, the response says it was not stored,
and the page says to keep the file. Every export is an `EXPORTED` row on the trail, written by a
trigger on the insert. Readable by the three roles the bucket admits (Administrator,
Shopfloor_Manager, Auditor), and the export itself is offered to `archive:manage`.

**The bundle is for the roles that may read what it holds.** Its trail part names who changed
what, with the values from before each change, and every earlier export of the device with its
taker's email: rows `audit_trail_select_asset` and `asset_exports_select_privileged` close to
an Operator. It was first built with the plain export's role list, so an Operator could download
what RLS refused them everywhere else (#527). `format=bundle` now also asks `has_authority()` for
`audit_trail:read`, as the caller, and a caller without it gets `403` naming the trail; JSON
and AASX keep the four-role list. The permission rather than a second role list, because it is
one name the Devices page already gates View Audit Trail on and now gates Export Bundle on too,
and `role_permissions`, written only by the seed, decides who holds it: today exactly the three
roles both policies admit. `test_aas_export.py` reads the seed and the two policies and fails if
the holders and that intersection ever differ. The trail part is read through the caller's client,
as the cold catalogue already was, so RLS decides its rows and the part no longer depends on the
service key; `loadTrail()` also filters on `audit_domain = 'asset'`, so a bundle taken by an
Administrator or an Auditor, who may read the security lane, never carries a row from it.

### A machine has a name an operator gave it (`0125`)

**`create_machine_principal()` made an identity nobody could name.** The `auth.users` row holds
an id and nothing else, which is what keeps it unable to sign in; the permissions and a note went
to an append-only audit row; and the Access Control page named the three identities a migration
pinned from `KNOWN_PRINCIPALS` in `serviceIdentities.js` and called every other one
*Undocumented principal*. That is the right word for a fixture a suite left behind and the wrong
word for an identity an Administrator created on purpose, which nothing on the page let them do
anyway: the RPC and its `api.js` wrapper existed, and no button called either.

**The name lives in `machine_principals`**, keyed to the `auth.users` row and cascading with it:
`name` (unique ignoring case, 1 to 80 characters), `purpose` (up to 500), `created_by` and
`created_at`. Not in `auth.users.raw_user_meta_data`, which `0116` relies on being empty on
every account this stack creates and which GoTrue owns; not in the audit row, which records what
was asked for at the time rather than what the identity is for now. The function takes the name
and purpose and writes the row **in the same transaction** as the identity, so a principal created
from the page cannot exist without a name, and a blank or duplicate name is refused before
anything exists. Read is Administrator and Auditor, matching `list_user_accounts()`: a name here
labels audit-trail rows both roles may read, and holds nothing a token could be derived from.
No write policy; the function is the only write path.

**The two-argument form is dropped, not overloaded.** PostgREST resolves an RPC by the argument
names in the body, and an overload whose extra arguments default makes every old-shape call
ambiguous. `0080` recreates its form on every boot and `0125` drops it on every boot, in that
order, and the self-check asserts exactly one declaration survives. Recorded in
`check-docs-drift.mjs`'s `INTENDED_REDECLARATIONS`. The first suite to call the function found
that `0080`'s body never ran: its `ON CONFLICT (principal_id, permission_id)` is ambiguous inside a
function whose first output column is also `principal_id`, and PL/pgSQL refuses it at the call.
`0125` names the constraint instead. Nothing had called it since `0080` shipped.

**The page creates, then mints.** *New Machine Identity* on the Machine identities card takes a name, a
purpose and a set of permissions from the fixed menu, calls the RPC, and opens the existing token
dialog for the new row so the first token is shown once the way every other is. No new edge
function: `mint-service-token` already signs and records, and a principal left without a token is
harmless, since it reaches nothing until one is signed and *Withdraw* covers it either way. The
dialog says which plane the identity is on (*does not reach the broker*), because the page lists
identities on both and an MQTT client is issued a broker account, not a principal.

**The menu is the allow-list, checked at build time.** `GRANTABLE_PERMISSIONS` in
`serviceIdentities.js` is the keys of `PERMISSION_REACH`, and `check-docs-drift.mjs` (11e)
asserts it equals `c_allowed` in the last migration that declares the function, so a permission
added to one side without the other fails the build rather than the click. What each entry
reaches is held by 11f; see [Machines propose, people decide](#machines-propose-people-decide-0013). Check 11d is
unchanged: it requires a registry entry for every id a migration pins, and a principal created at
runtime has no id to write down ahead of time, which is what the table is for. The Audit Trail
reads the same table to label the *Machine identities* category, so a principal created from the page
is named there too; the search still cannot reach that name, for the reason stated under
[Naming the last two lanes](#naming-the-last-two-lanes-0118).

### A principal can be described again (`0126`)

**`0125` closed the table and left out the ordinary case.** A purpose that was right when it was
typed is not right once the report is renamed or the client moves lines, and a table with no
write policy had no way to say so. `describe_machine_principal(p_principal_id, p_name,
p_purpose)` is the one write path after creation: Administrator only, machine principals only,
**rows that exist only**, so the three identities a migration pinned are refused with a message
saying their name lives in the dashboard's registry rather than *not found*. The name stays
unique ignoring case, excluding the row being renamed. An unchanged save writes nothing and
returns `NULL`; a change is a `PRINCIPAL_DESCRIBED` row on the *Machine identities* category carrying
the old and new name and purpose, and the function returns that row's id.

**Permissions are not editable, on purpose.** Widening what a principal holds is a change of
authority that every token already signed for it would carry at once; that is a new principal.
The dialog says so, and offers the name and purpose alone. On the page, the pencil beside a
principal's name is offered only for a row with a name of its own.

### The platform playbook is published by the sweep

[`forge/gateway-platform/`](../forge/gateway-platform) is the playbook every appliance converges to
(its README says what it decides). The sweep publishes it into the forge as
`platform/gateway-platform`, in its own organisation so the `gateways` organisation's rules do
not apply, and tags it `v<version>` once per platform version. No migration: nothing about it is
a row.

**The playbook reaches the edge runtime as a module.** An edge worker has no filesystem, and the
bundle's route (one environment variable per file, each named in `main/index.ts`) does not fit a
directory tree, so [`scripts/sync-gateway-platform.mjs`](../scripts/sync-gateway-platform.mjs)
writes every file of `forge/gateway-platform/`, the compose project under its `appliance/` included, into
[`_shared/gatewayPlatform.generated.ts`](functions/_shared/gatewayPlatform.generated.ts) with a
digest over the lot. The copy is committed, like the chart mirrors, and CI fails when it is
stale.

**Publishing is one read on the ordinary pass.** `publishPlatform()` in
[`_shared/forge.ts`](functions/_shared/forge.ts) creates the organisation, a `readers` team with
read on every repository in it (both dashboard teams are seated there by `forge-membership` at the
door and by the sweep), and the repository with `main` admitting pushes from the machine account
and nobody else, deploy keys not whitelisted. It reads `.aber/manifest.json` at `main`; when the
digest there is not this build's it reads the tree and makes one commit through the contents API
that creates, updates and deletes whatever differs. The tag comes from `ABER_PLATFORM_VERSION`,
which the chart sets to its `appVersion`, so the playbook an appliance converges to and the images
it reports to ship from one tag. **A tag is created once and never moved:** a tag found at other
content than this build ships is reported in the sweep's `warnings` and left where it is, because a
released version's playbook is immutable. It is a warning and not an error because nothing failed
and no retry clears it: the sweep did what it was asked and declined only the one thing a released
tag forbids, so `errors` stays what an operator watches for a forge that could not be reached or a
key that could not be re-registered. Bump the version, or on a development forge delete the
tag (`DELETE /repos/platform/gateway-platform/tags/v0.1.0` as the machine account) and let the
next sweep recreate it.

**What enrolment adds.** Before `main` is protected it seeds `platform.yml` beside the incident
template, pointing at the tag current at enrolment; afterwards the pointer changes by pull request
through the lane the forge already has, which is the staged rollout. The same key the appliance
generated is registered read-only on the platform repository (one key, two repositories, two
modes; measured), and the enrolment response carries `platform_ssh_url` and `platform_tag`, which
`bootstrap.mjs` records in `repository.json` for the converge script on the host. The sweep keeps
both links per gateway and removes the platform one when the gateway is archived or gone.

**What the appliance does with it** is the converge role's: `aber-gateway-converge`, on an hourly
timer, reads the tag from the puller's checkout of the gateway's `main`, runs `ansible-pull`
against the platform repository at that tag with the deploy key and the pinned host key, and
records the outcome in `/data/gitops/converged.json`, which the puller adds to the `appliance`
branch. The playbook installs the timer that runs it, so the first run is the installer's (or a
person's) and every later one is the appliance's own. Nothing on the platform side connects to an
appliance. `test_forge_sweep.py` asserts one sweep leaves the repository published, tagged and
protected and a second publishes nothing; `test_forge_events.py`'s appliance class clones the
platform repository with its key and is refused when it pushes.

### The broker's root rides on `main` of the platform repository

An appliance is given the broker's root at enrolment and then never told about a re-issue, which
made re-minting the root the one operation that takes the whole fleet down at once. `trust/` on
`main` of the platform repository is what replaces that.

**The sweep is the publisher, and the credential service is the source.** `GET /ca` on
[`scripts/gateway-credential-service.mjs`](../scripts/gateway-credential-service.mjs) returns the
certificate, the window it is valid for, and the pin of its public key, read from the file the
broker itself loads — that service is a sidecar in the broker's pod and is the one component that
can say what a gateway will actually be shown. `forge-sweep` reads it on every pass and writes
`trust/ca-bundle.pem` and `trust/manifest.json` through `publishTrust()`.

**On a branch, not in a tag.** Everything else in that repository is pinned: an appliance reads the
tag its own `platform.yml` names, and a fleet on three platform versions reads three trees. A
re-issued root has to reach all of them, so it goes on the one ref they all share. `PublishSpec`
gained an `unmanaged` field for this: without it, the next publication of the playbook would delete
`trust/` as a file this build no longer ships, and the two would take turns removing each other's
work.

**The bundle is a union.** `mergeTrustBundle()` keeps the current root plus every previously
published root whose `not_after` is still ahead, keyed by pin, the current one first. A broker
presenting either verifies, which is what makes "publish the new root" and "switch the broker's
leaf to it" two independent steps rather than a flag day. A root the manifest cannot date is kept
rather than dropped: dropping one that is still signing the broker's certificate takes the fleet
off the air, and keeping an expired one costs nothing.

**It is compared by its bytes, not by its set of keys.** `internal-ca.yaml` re-issues the root with
`rotationPolicy: Never`, so a re-issue keeps the same public key and changes only the certificate —
the case the fleet most needs to be given, and the one a set comparison would miss.

**The appliance refuses a bundle that would cut it off.** `aber-gateway-converge` offers each root
to the live broker with `openssl s_client -verify_return_error` and installs nothing unless one
verifies; then it writes `/data/certs/ca.crt` and `ca.json` and restarts Node-RED once, only if the
bytes changed. The flow reads `ca.json` every minute through a file-in node — the `deployed.json`
pattern — and reports `Cert_Expires_At` from it, so the date on the Gateways page is the root the
appliance holds now. `gateway-bundle`'s readiness `GET` reports the platform's own root beside it,
and the drawer says *holds an older root* when a gateway is more than a day behind. That is the
signal the runbook's rotation waits on (`docs/remote-gateways.md` §8).

### The forge checks a flow before it is merged

`flow-sync.mjs` refuses a `flows.json` it cannot deploy, and that refusal happens on the appliance,
after an administrator has approved and merged the change. A file uploaded through the forge's own
web UI met no check before that. **`main` on every gateway repository now requires the commit
status `aber/flow-shape`**, and the platform posts it.

**No Actions runner, which is the part worth stating.** The obvious reading of "required status
check" is CI, and CI on the forge means enabling Gitea Actions -- a runner that executes whatever a
repository tells it to, on a host beside the database, plus a registry as a fourth credential plane.
None of that is needed here. The platform already holds the machine account and already receives
every push; posting a commit status is one API call on a delivery it was going to get anyway. The
runner stays off (`gitea.actions.enabled: false`) and so does the registry.

**How it runs.** The push webhook's branch filter widens from `{main,appliance}` to `*`, so a push
to a proposal branch reaches [`forge-events`](functions/forge-events). Nothing on the gateway row
moves for it -- those two branches are what it records -- but the `flows.json` at that commit is
read through the machine account, checked, and the status posted. A repository with no `flows.json`
at that commit passes: that is the ordinary state of a fresh enrolment, and a proposal changing
something else is not a flow change. A file the forge cannot be asked about is `error`, never a
pass, because "not known" must not merge.

**Two copies of the check, held together by a test.** The same two refusals live in
`flow-sync.mjs` on the appliance and in `forge-events` here, because they run in two places and
neither can import the other. A divergence would be worse than no check: a file that passes in the
forge and fails on the appliance was approved by somebody who was told it was fine, and the gateway
then stops converging with the only evidence in its own log. `scripts/lib/flow-shape.test.mjs`
lifts both copies out of their files and runs the same fixtures through them.

**Measured against `gitea/gitea:1.27.3`.** A merge is refused `405 Not all required status checks
successful` both when no such status exists and when it is `failure`, and succeeds on `success`.
The pull request's own `mergeable` field stays `true` throughout -- it reports conflicts, not
checks -- so the merge endpoint is the enforcement and `mergeable` is not the signal to read. A
status must be posted against a **commit** sha: Gitea answers 500 for a blob's, which is easy to
reach because a contents-API response carries both. And a webhook's `branch_filter` glob is not the
branch rules': `*` matches across a slash here, so `feature/x` is delivered, where a branch rule
needed `**` for the same reach.

**Reconciled, not only created.** `ensureBranchProtection()` adds the context to a repository that
predates it, keeping whatever else `main` already requires, so the fifteen-minute sweep brings an
older gateway up without anybody visiting it. It also removes the context's name from before the
rename to Aber, `acs/flow-shape`: nothing posts that name any more, so a rule that kept requiring it
beside the new one would refuse every merge. A proposal whose head was checked under the old name
carries no status under the new one until its next push. `test_forge_events.py` covers the four
answers and that a proposal moves no column; `test_forge_sweep.py` covers the reconcile and the
rename.

### A gateway that needs code of its own (`0106`)

Some machinery — serial, Modbus, OPC-DA — no Node-RED node reaches, and the adapter that does is
worth nothing to anybody else. It is admissible on one condition: **a container built from a
commit, never a payload handed to the appliance.** The repository carries a `custom.yml` beside its
flow, the converge script runs it after the platform playbook, and the image is built on the
appliance from the checkout. That costs no registry, no new credential and no fourth revocation
handle, because the deploy key is all the appliance holds and a registry could not have accepted
it.

**Cloning is seeding, and the seed is a template repository.**
[`forge/gateway-custom-example/`](../forge/gateway-custom-example) is published by the sweep as
`platform/gateway-custom-example`, in the same organisation as the playbook and marked as a
template, so the forge offers **Use this template**. Untagged, because it is copied once rather
than converged to: `publishToForge()` takes a `version` of `null` and returns without tagging.
Somebody making a gateway that needs an adapter generates
`gateways/gateway-<sparkplug_id>` from it before commissioning, and enrolment adopts what it finds
— `ensureRepository` reads the repository that is already there, then the protection, the pointer
and the key follow as they always do. **No column records the choice**; the repository is the
record.

Four things were measured against `gitea/gitea:1.27.3`: the machine account may set `template` on
a repository it owns (`PATCH /repos/{owner}/{name}`); `POST /repos/{owner}/{name}/generate` into
the `gateways` organisation answers 201; a generated repository is **not** itself a template and
carries **no** branch protection, so enrolment's is the first; and generation copies the whole
tree, `.aber/manifest.json` included. That last one is why `ensureBranchProtection()` removes that
file in the same window it commits the incident template — the one moment the machine account may
still write `main` — since a manifest stating the digest and date of the *example* is a file
about the wrong repository. It is not fatal if the removal fails: a stray file reads badly and
works identically, and the protection matters more.

**The example carries no `flows.json` and no `platform.yml`, deliberately.** A flow copied from a
template would be deployed over the one enrolment installed, taking the gateway's heartbeat with
it; and `seedPlatformPointer()` keeps a pointer that already exists, so a copied `platform.yml`
would pin every gateway seeded from it to whatever tag was current when the example was written.

**What the operator sees.** `aber-gateway-converge` records both outcomes in `converged.json`,
which the puller already pushes to the `appliance` branch under the allowlist it never widens. On
that push `forge-events` reads the file at the pushed commit the way it reads `flows.json`'s
digest, and `0106` records five columns: the platform tag and outcome, when the appliance recorded
it, and the custom playbook's outcome and revision. The gateway drawer shows them as **Platform**
and **Custom**. Every field is treated as untrusted — it is JSON from a box in a cabinet arriving
over a deploy key — so an absent, malformed or oddly-shaped file resolves to nulls rather than to
a failed delivery, and a `converged_at` that will not parse is dropped rather than handed to
Postgres, which would refuse the whole update.

**Custom is the row that earns its place.** A bespoke adapter is a container on somebody else's
hardware with no heartbeat of its own, so a gateway whose adapter is crash-looping keeps
publishing everything else and reads ONLINE. `custom.yml` in the example therefore asserts the
service is actually running after `up -d`, because compose reports success for a container that
started and exited.

### The one-liner (`0105`)

Commissioning as a pasted command
([`docs/remote-gateways.md`](../docs/remote-gateways.md#on-the-appliance-the-command)).
`gateway-bundle` mints the token as before and, asked for `format: "command"`, answers JSON
instead of a ZIP: the token, its expiry, the command, and the pin. `gateway-install` is what the
command and the installer fetch from, three things against the token in `X-Enrolment-Token`: the
installer (`forge/gateway-platform/install.sh` with the public values substituted; the token is in the
environment the command sets, never in the script's text), the platform playbook as a zip, and
the appliance's `.env` (rendered by [`_shared/gatewayEnv.ts`](functions/_shared/gatewayEnv.ts),
which the ZIP bundle now shares). Nothing on that route is cacheable.

**A token can be checked without being spent.** `peek_gateway_enrollment_token()` is the
read-only twin of `consume_gateway_enrollment_token()`: the same shape check, the same four
refusals (unknown, expired, consumed, archived gateway) answered identically with no rows, and no
UPDATE. `service_role` alone, like the consumer, because a signed-in user who could call it could
enumerate which token values exist. Only enrolment spends the token, and the credential secret in
the `.env` is generated per fetch: the installer writes the file once, so a retry before enrolment
costs nothing and a fetch after changes nothing. `test_gateway_enrollment.py` proves the check
leaves the token live and refuses what redemption refuses.

**The pin.** [`_shared/caPin.ts`](functions/_shared/caPin.ts) walks the root's DER to its
SubjectPublicKeyInfo and hashes it, which is what `openssl x509 -pubkey | openssl pkey -outform
DER | openssl dgst -sha256` prints on the appliance (measured equal on the dev cluster's root).
The root reaches the functions as `ABER_CA_PEM`, read at start by the image's entrypoint from the
ingress TLS Secret's `ca.crt`, which the chart mounts as one projected key when ingress TLS is on:
that is the root that signs the API's own certificate, the one an appliance must trust to reach
the installer, and not the broker's, which is allowed to differ. The same key is served over plain
HTTP by the frontend at `/.well-known/aber/ca.pem` (`nginx.conf`, `frontend.yaml`), which is
where stage 0 fetches it; the chart hands the functions that address as `ABER_CA_URL`. The mount is
optional so the pods start before cert-manager has issued; a functions pod that started before
the issue offers no command until it is restarted, and the readiness answer says so. The same
root reaches the appliance's `bootstrap` container as `platform-root.pem` beside the compose
project, which its `NODE_EXTRA_CA_CERTS` names: the installer copies the root stage 0 verified,
and the ZIP bundle carries `ABER_CA_PEM`, or an empty file when there is none.

**HTTPS or nothing.** [`_shared/installer.ts`](functions/_shared/installer.ts) refuses a
plain-HTTP public URL for the whole route, in both functions, so a command is never minted for a
route that would refuse it; `supabaseFunctions.gatewayEnrolment.allowPlaintextInstaller` lifts
that on the development values alone, and the command it mints then has no stage 0 and says so.
The readiness answer (`GET gateway-bundle`) carries `installer.available` and the reason, and the
setup modal mints the command when it can and the bundle otherwise; switching between the two
re-mints and asks first, because both spend the one token. `test_gateway_install.py` drives the
mint by role, the three fetches, the identical refusals, and the token surviving every fetch to
be redeemed by enrolment.

## A replay lane is minted, not assigned (`0083`)

The Playback gateway's devices are **replay lanes**. Each stands in for one real machine, records
which one in `shadow_of`, and is created by `ensure_shadow_devices()` when a capture is played — one
per recorded device, reused across runs so a comparison chart holds still between them.

The dashboard offered that gateway in three "Assigned Edge Gateway" pickers like any other, and
choosing it worked. The result was not obviously wrong on screen: the device appeared on the shadow
lane, correctly badged, because `is_shadow` is a property of the **gateway** and devices inherit it.
What it lacked was `shadow_of` — and the migration that introduced these lanes names that state
exactly, while explaining why it refuses to mint one: *"a shadow with no `shadow_of` is an asset
with no provenance, which is the thing this design exists to avoid creating."* The dashboard was
creating it around the back of the function that refuses to.

Nothing raised. `device_locations` resolved it to the Shadow lane, so it was a thing on no shopfloor
that nothing on the shopfloor explained; the AAS export emitted a shell for it, asserting an asset
identity corresponding to no asset; and `uq_devices_shadow_per_gateway` is partial
(`WHERE shadow_of IS NOT NULL`), so the row was not even covered by the index that makes lanes
one-per-machine. Any number could pile up.

**The gate is on arrival, and only on arrival**, which is the part worth reading twice. The obvious
rule — *a device on a shadow gateway must have `shadow_of`* — is wrong. `devices_shadow_of_fkey` is
`ON DELETE SET NULL`, chosen over `CASCADE` because *"a shadow outliving its original is a lane whose
label has gone vague, which is recoverable"* whereas cascading would orphan every telemetry row keyed
on its `sparkplug_id`. So a lane whose original was deleted sits on the shadow gateway with a null
`shadow_of`, **legally** — and the FK reaches that state by `UPDATE`-ing the lane, which fires
triggers. A guard written against the state rather than the act would have made deleting any
replayed machine fail, with an error about playback provenance on an operation that mentions
neither.

So `trg_devices_replay_lane_is_minted` fires on `INSERT`, and on an `UPDATE` that **changes**
`gateway_id`. An update that merely mentions it — which PostgREST does on every `PATCH`, since it
sends the whole row — is not an arrival and is left alone.

The three pickers are fixed too, and disable the option rather than hiding it: a device that *is* a
lane must still see its own gateway in the list, or its form would fall back to "Unassigned" and
saving would move it off the lane. But the pickers are a courtesy. `devices` is writable through
PostgREST by any Administrator or Shopfloor_Manager, so they are three doors of an unbounded number,
and the trigger is the one that holds for the fourth.

---

## The Directory says what can reach a service (`0084`)

`directory_services` held an address and no statement of who could use it, so the page rendering
those rows had to guess. `isBrowsableEndpoint` guesses well, and the guess is the right one for the
question it can answer — scheme plus host tells you whether a string is a **web page**, which is all
a URL carries. It cannot tell you whether the browser reading it can **reach** that page.

That gap became visible when four ports moved to `127.0.0.1` — both databases, Prometheus and the
ingestion metrics endpoint. Two of the four are `http://localhost:…`, so the scheme-and-host test
says "web page", correctly, and the page rendered a link. That link works for a browser on the
deployment host and fails for every other browser — and the dashboard is published on `:3000` for
exactly those other browsers. **The failure looks like the service being down**, which is the same
failure the container-hostname clause was written to avoid.

`exposure` describes the **port binding**, not the URL:

| | |
| :--- | :--- |
| `NETWORK` | published on every interface — reachable from another machine, subject to firewall and DNS |
| `HOST` | bound to `127.0.0.1` — the deployment host, or an SSH tunnel |
| `INTERNAL` | no host port at all — the container network only |
| `UNKNOWN` | **not recorded** |

**The port and the URL can disagree, and both are consulted.** Studio is `NETWORK` — `supabase-envoy`
publishes 54323 on every interface and holds the console behind an OAuth flow and an `Administrator`
check (`0081`) — while its `endpoint_url` still reads `http://127.0.0.1:54323`, which is the
`STUDIO_PUBLIC_URL` default rather than a claim about the binding. A loopback *address* cannot work
from a remote browser however broadly the *port* is published, so the page tests the address too.

**`UNKNOWN` behaves as `NETWORK` in the UI, and it is the one place the page does not err towards a
copy button.** This column arrived after the rows did; anything registering into this table that has
never heard of it defaults to `UNKNOWN`, and demoting every such row would make adding the column a
regression for services that are perfectly reachable. The loopback and container-hostname tests still
apply to those rows, which is what the page could already do on its own.

**What the table cannot hold, the browser supplies.** Whether a `localhost` address is reachable
depends on which machine the *reader* is at — a fact that differs per viewer rather than per service.
`viewerIsOnDeploymentHost` reads it off the dashboard's own hostname: a page served from `localhost`
is being read on the host, so its sibling `localhost` addresses resolve; one served from
`aber-server.factory.local` is not. The case this gets wrong is a reader who tunnelled the dashboard
alone, and it is the right trade — the alternative withholds a working link from everyone developing
on the host to protect a reader who already knows what a tunnel is.

**The seed's rows described a loopback deployment.** In a cluster these rows were wrong
before this column was reached — `endpoint_url` said `localhost` while the chart serves
`grafana.<publicBaseDomain>` through an Ingress — and `0084` does not fix that; `0085` below fixes
three of them and leaves the rest. What `0084` does is make the remaining wrongness quieter: a row
marked `HOST` offers a copy button and a tunnel hint instead of a link that was never going to work.

---

## The Directory reads the address the browser uses (`0085`)

`endpoint_url` was a hardcoded string. `0002` seeded `http://localhost:1880`, `http://localhost:3002`
and `http://127.0.0.1:54323`, and nothing ever moved them — while the deployment stated its own
browser-facing addresses in `NODERED_PUBLIC_URL`, `GRAFANA_PUBLIC_URL` and `STUDIO_PUBLIC_URL`, which
are **not cosmetic**: they build the `redirect_uris` registered in `auth.oauth_clients`, Grafana's
`GF_SERVER_ROOT_URL`, and the `callbackURL` `settings.js` hands passport-oauth2.

So a correctly configured stack had every login working at a real hostname and one page still
advertising `localhost`. The frontend already got this right — `constants.js` reads `VITE_GRAFANA_URL`
for every Grafana link the dashboard renders — which made the Directory row the odd one out beside
links that followed the deployment.

**Nothing was added to db-init.** `templates/jobs/db-init.yaml` already passes `grafana_public_url`,
`studio_public_url` and `nodered_redirect_uri` to psql once per file, because `0002` needs them for
the OAuth clients. `0085` reads the same three values, which is the point: a row and a
`redirect_uri` computed from one input cannot disagree.

**Three rows, not fifteen**, and the limit is what db-init passes rather than a judgement about which
rows deserve it. Swagger, Mosquitto and the four Supabase gateway rows have no `-v` entry.

**These three are now derived, so hand edits no longer stick.** `directory_services` carries UPDATE
RLS for Administrator and Shopfloor_Manager, and a replay stamps over an edit to these rows on the
next boot — the same treatment `0002` gives the OAuth rows for the same stated reason. An
independently editable copy of a value the deployment already holds is the drift this closes; the
place to change one of these addresses is the variable, where the login flow follows it.

**A row whose variable is absent is left entirely alone.** Empty means "this deployment said nothing",
not "this deployment wants the fallback", and stamping a fallback over an operator's edit on the
strength of a variable nobody set would be the worst of both behaviours.

This is what surfaces the chart's port-free hostnames on the page.

---

## The Directory names the gateway that runs (`0096`)

The stack runs Envoy, and the seeded directory row still read *Supabase API Gateway (Kong)*.
The name is display text and also the key `directory_liveness_job_map()` joins the `envoy` scrape
job to, so the two change together: `0001` maps `envoy` to *Supabase API Gateway (Envoy)* and is
replayed every boot, `0002` seeds the new name, and `0096` renames the row on a database that
already holds the old one. The seed's INSERT for this row conflicts on `id` rather than
`service_name`, as the Node-RED row has since `0016`: a database from before the rename holds the
id under the old name, and a name-targeted clause raises on the primary key every boot instead of
skipping. The rename is guarded on the new name being free, so a service an operator registered
under it by hand is kept. The anon key's vault description in `0002` no longer names Kong either;
the seed rewrites the three revocation secrets on every boot, so that needed no migration.

## The Directory names Node-RED for what it runs (`0024`)

The Node-RED row was seeded as *Node-RED (Virtual Edge Gateway Simulator)*, from when the stack
shipped a demonstration simulator. That simulator is retired and `deployment` replaced
`is_virtual`; what the platform's Node-RED runs now is the host-run gateways, so `0002` seeds
*Node-RED (Host-Run Gateways)*. The seed inserts `ON CONFLICT (id) DO NOTHING`, so `0024` renames
the row on a database that holds the old name, only while it holds exactly that name and only while
the new one is free. Nothing joins on this name: `directory_liveness_job_map()` does not map
Node-RED, and the public-URL update keys on the row's id.

The same pass renamed the vault secret the revocation and sweep calls pass the gateway's key
check with, from `supabase_anon_key` to `supabase_publishable_key`, since the legacy anon key is
retired and the secret holds the publishable key. `0002` rewrites that secret from db-init's
variable on every boot, so the rename is the old name joining the list it deletes first; there
is no stored value to carry across and no migration.

## The Directory observes both databases (`0127`)

Both databases read `UNKNOWN` on the Directory page, and the map was right to say so: nothing
scraped either of them. `UNKNOWN` is the honest value — it means *nothing observes this service*,
which is a different claim from `DOWN`, and the page has to keep those apart or it fabricates
health the way the seeded `'ACTIVE'` literals once did.

What changed is underneath: a `postgres_exporter` sidecar now runs in each database pod, and Alloy
labels every scraped pod's `job` with its component, so `supabase-db` and `timescaledb` are jobs
that exist. `0127` adds the two rows that join to them.

**The service names are the join key, not decoration.** They must match
`directory_services.service_name` exactly — *Supabase PostgreSQL* and *TimescaleDB Telemetry
Store*, as `0002` seeds them. A near-miss is the worse of the two failures available here: the
database is scraped, the series arrive, and the page still says `UNKNOWN`, which reads as a missing
exporter rather than as a typo in a map. `scripts/check-docs-drift.mjs` asserts in one direction —
every job the map names is one a scraped pod actually carries — because a job named here that no
pod produces makes a healthy service report `UNKNOWN` forever.

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

Values an `Administrator` changes from the dashboard instead of editing a values file and
rolling a pod. On a plant the person who needs a retention window changed is rarely the
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

**Secrets live in Supabase Vault, and who issued a secret decides how it gets there.**

- **A stack-internal secret is seeded from chart values and is never editable.** It is a value the
  stack generates or is told once at install, such as `supabase_functions_url`,
  `gateway_revoke_secret` or `forge_sweep_secret`. `0002` writes it from db-init's variables on
  every boot, and no page or function changes it.
- **A foreign credential is set by an `Administrator` from the page that uses it**, through a
  write-only `SECURITY DEFINER` writer. It is issued by a system this stack does not own and
  rotates on that system's schedule. The cold archive's S3 key is set from the Cold Storage page by
  `set_archive_credential()`, and the off-site backup key from the Backups page by
  `set_backup_offsite_credential()`. Each writer has an `..._is_set()` companion that answers
  whether a value is stored, never what it is; nothing reads the value back to a page.

Supabase Studio's Vault UI remains the escape hatch for anything else. **Note the trust boundary:**
Studio is not gated by this schema's RLS or `user_roles`. It is protected by network placement and grants database-level
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
scripts/backup-databases.sh                  # both databases + the storage objects
kubectl -n aber scale deploy/supabase-realtime --replicas=0
BACKUP_STAMP=<stamp> scripts/restore-databases.sh
kubectl -n aber scale deploy/supabase-realtime --replicas=1
```

Writes three timestamped artefacts plus a manifest into `./backups/` (gitignored — a dump holds
`auth.users`, hashed OAuth client secrets and the whole `audit_trail`). It runs a local `pg_dump`
against whatever `SUPABASE_DB_HOST`/`TIMESCALE_HOST` name; the defaults are the dev loop's
port-forwards (`npm run dev:forward`), and the passwords come from `POSTGRES_PASSWORD` /
`DB_PASSWORD` in the environment.

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `BACKUP_FORMAT` | `plain` | `.sql.gz`. Use `custom` for `.dump` — selective `pg_restore`, and what the chart's CronJob writes |
| `BACKUP_DIR` | `./backups` | |
| `BACKUP_RETENTION_DAYS` | `14` | `0` disables pruning |
| `INCLUDE_STORAGE` | `true` | Every bucket's objects, as a tar of `STORAGE_HOST_PATH`: the storage volume's directory on this host, which must then be set |
| `DUMP_TIMESCALE` | `true` | `false` where pgBackRest backs the historian up (`timescaledb.physicalBackup`); the manifest then reads `timescaledb=physical` and the restore leaves the historian to `scripts/restore-historian.mjs` ([`deploy/k8s/README.md`](../deploy/k8s/README.md), *Backing up the historian*) |

Without a port-forward, `kubectl exec` directly:

```bash
kubectl -n aber exec statefulset/supabase-db -- \
  pg_dump -Fp -Z6 -U supabase_admin -d postgres > supabase-db.sql.gz
```

Ten things about these dumps are not obvious and each has bitten someone:

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

- **Restore into a freshly initialised database.** The plain format carries `--clean --if-exists`,
  which is what lets it replace the `auth` and `storage` schemas the image ships. It cannot,
  however, drop a partition's *inherited* primary key, and a fresh stack always has partitions:
  Realtime creates its daily `realtime.messages_*` on every start, and `0001` creates
  `audit_trail`'s monthly ones and its DEFAULT. So `restore-databases.sh` drops every partition
  of every partitioned table first, and the dump recreates each with its rows. The first rehearsal
  to reach the restore step found that; before it, the runbook failed on every fresh stack with
  `cannot drop inherited constraint`.
- **The image's default privileges are suspended for the replay.** They grant ALL on every new
  object in `public` to anon, authenticated and service_role, and a dump's grants are a diff from
  PostgreSQL's built-in default, not from those — so a plain replay creates every table and
  function with the surplus and grants the source's rights on top: `service_role` could write the
  audit trail, and anon could call the backup service's gates. `restore-databases.sh` revokes the
  defaults first; the dump re-declares them last, after every object and grant, so the restored
  ACLs are exactly the dumped ones. The rehearsal asserts it on `backup_claim_job()`.

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
- **Realtime is stopped for the restore.** It makes its daily `realtime.messages` partitions while
  it runs, and one made between the partition drop and the replay fails the restore with `cannot
  drop inherited constraint`. `restore-databases.sh` refuses while Realtime is connected (it
  connects as `supabase_admin`, so the check is by application name).
- **PostgREST is told to reload its schema cache after the replay.** It reloads on the image's DDL
  event triggers, and `--clean` drops those triggers early and recreates them last, so the reload it
  saw ran mid-restore with the tables gone, and it answered 404 for them afterwards
  (`PGRST205 ... not find the table 'public.backup_jobs'`). A hand-run `pg_restore` needs the same
  `NOTIFY pgrst, 'reload schema'`, or a restart of `supabase-rest`.
- **The historian restore is wrapped in `timescaledb_pre_restore()` / `post_restore()`.** The
  extension's `_timescaledb_catalog.continuous_agg` carries circular foreign keys — `pg_dump` warns
  at dump time — and restoring it with background workers live leaves the three rollups from `0010`
  registered but never refreshing. The script runs `post_restore()` even when the restore fails,
  because the alternative is a database whose retention, compression and refresh jobs are all
  silently stopped.
- **`audit_trail` is why this matters most.** Telemetry can be re-derived from a rebirth; an
  append-only audit trail cannot.

**This is not PITR.** Recovery is to the last run and no finer. A real RPO wants WAL archiving or
pgBackRest.

**The log store is deliberately not in tier 1.** `loki_data` holds thirty days of container logs
and is not a database of record, so `backup-databases.sh` does not touch it and is not expected to.
The distinction the decision rests on is what a log is FOR here: the store answers a question
somebody is asking during or shortly after a fault — which device, under which edge node, and why —
and a restored copy of last month's logs answers a question nobody is still asking. Everything from
those lines that matters beyond the incident is already kept as a row and already in the dump:
`audit_trail` is the audit trail and carries the conformance record as well, and
`platform_alerts` is the alert history. Backing up the logs too would be a second, weaker copy of
records that are captured properly, plus a great deal of noise the retention window exists to
expire.

So deleting Loki's PVC costs up to thirty days of logs and nothing else — the stack returns with an
empty store and works. That is worth stating next to the broker's volume and the internal CA's
Secret, where the same deletion is a fleet-wide re-enrolment: they sit in the same list of things
on disk and are not the same kind of thing, which is why those two are in tier 1
(`backup.includeBroker`, `backup.ca`) and the log store is not. A tier 2 snapshot does capture the
log store, because it captures the machine, but that is a side effect rather than a promise and no
retention story should be built on it.

### Backups from the dashboard (0101)

The tier 1 backup above needed a shell. `0101` gives it a caller: the **Backups** page (Administrator
only) queues a `backup_jobs` row through `request_backup()`, and the **backup service**
(`scripts/backup-service.mjs`, a Deployment behind `backupService.enabled`) claims it, takes the
backup and records a `backups` row.
The shape is the Capture page's: the job is the act, the row is the artefact, and the page reads
both and writes neither.

**What a backup of the historian covers.** Raw telemetry for the raw window (14 days by default)
and the rollups beyond it. Raw readings older than the window are only on cold storage, which no
backup includes; see *Raw telemetry is kept for a stated window*.

**What the service takes.** Both databases as their superusers (`supabase_admin`, for the reason
above), the storage objects, the forge, the broker's volume and the internal CA, into one
directory per backup on its own volume (the backup PVC), named by the UTC stamp:

```
/backups/20260911T143000Z/
  supabase-db-20260911T143000Z.dump         # or .sql.gz, with backupService.format=plain
  timescaledb-20260911T143000Z.dump
  vault-key-20260911T143000Z.txt            # pgsodium's root key, read through the dump's session
  storage-objects-20260911T143000Z.tar.gz   # absent when no storage volume is mounted
  forge-20260911T143000Z.tar.gz             # absent when no forge volume is mounted
  broker-20260911T143000Z.tar.gz            # absent when no broker volume is mounted
  ca-20260911T143000Z.tar.gz                # absent when backup.ca names no Secret
  manifest-20260911T143000Z.txt             # what restore-databases.sh reads
  manifest.json                             # sizes and SHA-256 digests, as the row records them
```

The forge archive is the forge's volume minus its logs, with `gitea.db` replaced by a copy taken
through sqlite3's online backup (consistent while Gitea writes), or, when the read-only mount
refuses that, a raw copy of the database with its WAL folded in and an integrity check passed.
`manifest.json` says which. The SSH host keys are in it: a forge recreated without them is a
fleet-wide re-enrolment, because every appliance pins them.

The Vault key is pgsodium's root key, read through the same superuser session as the dump
(`pg_read_file` against the data directory, where the chart's getkey script keeps it). Every
Vault secret is ciphertext under it and nothing else, a fresh server mints its own, and a dump
carries the ciphertext only: the first rehearsal to reach the assertions restored every Vault row
and could decrypt none of them. The cold archive's S3 secret, typed on the page, is one of those
rows and no chart value can re-seed it.

The broker archive is the broker's data volume (`backup.includeBroker`): the Dynamic Security
document, which is every issued gateway account and the only copy of it. The CA archive
(`backup.ca`) is the key pair behind the broker's and the databases' certificates, read from its
Secret in the ClusterIssuer's namespace through the API with a Role granting `get` on that one
name, and staged under `ca/` as cert-manager keeps it (`tls.crt`, `tls.key`, `ca.crt`). Both are
in tier 1 for the same reason as the host keys: every appliance pins the CA, so losing it is a
fleet-wide re-enrolment; losing the document is every gateway re-issued.

**How the service talks to the database.** Through `psql`, as `supabase_admin`, the session
`pg_dump` needs anyway. The gates it calls (`backup_claim_job()`, `backup_finalise()`,
`backup_fail()`, `backup_reconcile_jobs()`, `backup_prunable()`, `backup_forget()`,
`backup_schedule()`) are revoked from every PostgREST role and refuse any session that is not a
superuser's, so the one credential the service holds is the whole of its authority and there is
no second one to keep in step. It publishes nothing but `/healthz`.

**Scheduled and requested backups are one row shape** and differ in two columns. `origin` says
which; `requested_by` names the Administrator or is NULL. The schedule is the service's: at start
it registers `enqueue_scheduled_backup()` with pg_cron on `BACKUP_SCHEDULE` (`backup.schedule` on
the chart), or removes the job when that is empty, so a stack with no service queues nothing that
nobody will take. On Kubernetes, enabling the service retires the CronJob; the PVC is shared, and
the service's directories sit beside the CronJob's flat files.

**Retention is decided once, here.** A scheduled backup is pruned by the service once it is older
than `BACKUP_RETENTION_DAYS`; the files go first and `backup_forget()` removes the row and writes
`BACKUP_PRUNED`. A requested backup is **pinned** at birth and the window does not apply until an
Administrator releases it on the page (`release_backup()`), because a backup taken before a risky
change is the one a timer must not delete first. `0` disables pruning.

**The newest three are never pruned (`0017`).** `backup_prunable()` used to select by age alone,
and the service prunes after every job it claims, a failed one included. So a fortnight of failed
backups (a `pg_dump` older than a server, or one component down and taking the all-or-nothing
backup with it) deleted the last good scheduled backup on the day it passed the window, while
Backup Stale was already firing. Now it never returns any of the newest three rows, pinned or not,
whatever their age. Every `backups` row is a successful backup, so those are the newest three good
ones; three rather than one, because the newest may be the one that is wrong. The floor is in the
SQL rather than the service so it covers every caller: the prune after a job, the prune at start,
and anything added later. It is a constant: a different number would be a new argument, which is a
new function, dropped and re-granted by name.

The service still prunes after a failure, deliberately. When the failure was a full volume,
pruning is what lets the next run succeed, and the floor makes that safe; pruning only after a
success is the obvious alternative and the wrong one. The CronJob and `backup-databases.sh` need no
floor: both prune last in a script that stops at the first failure. The page's Retention column says
**Kept: one of the newest three** on a backup the window has passed and the floor is keeping; it
reads the window from `backup.retentionDays` through the frontend's runtime configuration, and
`check-docs-drift.mjs` holds its `BACKUP_RETENTION_FLOOR` equal to the SQL's.

**Every act is a trail row.** `BACKUP_REQUESTED`, `BACKUP_CANCELLED` and `BACKUP_RELEASED` as the
user who did it; `BACKUP_TAKEN`, `BACKUP_FAILED` and `BACKUP_PRUNED` as `service`, with no user.
`audit_domain_for()` files both entity types under `security` by its fail-closed default, which is
where an act on the whole database belongs.

**The page lists runs, not backups.** Every finished `backup_jobs` row, newest first, 30 to a page
and filtered to all, completed or failed. A completed run carries its `backups` row through the
`backups.job_id` foreign key while the files exist, and says it was pruned once `backup_forget()`
has removed the row; job rows are never deleted, so the list is the history. A failure is history
too once a later backup succeeds, so the current condition is one line of its own, shown only when
the latest run that completed or failed was a failure, or when the last success is older than 36
hours (before the first success, the first job recorded is the clock). The second is what a
stopped service produces, since a service that is not running records no failure. A stack with no
job row at all has never run the service, and the page shows its empty state and nothing else
(#474).

**Grafana reads the same clock through `backup_health` (0011).** `grafana_reader` may read views
and no table, and `backup_jobs` is Administrator-only; the view runs as its owner and exposes one
row, `last_success_at` and `age_seconds`, and none while no job exists. The *Backup Stale* rule
fires past 36 hours; its reasoning is in [`grafana/README.md`](../grafana/README.md).

**What was decided, and why the alternatives were not taken.**

- *The artefact lives on a volume, not in a Storage bucket.* Uploading to a bucket needs the
  service-role key or a JWT minted from the JWT secret, either of which is a larger authority than
  "dump the database" and exactly the second credential this design avoids. A later download, if
  one is ever wanted, is a signed URL from an edge function over a bucket the service does not
  write; it is not built, and the page says so.
- *No download, no restore button.* A dump holds `auth.users`, every OAuth secret's hash, the whole
  `audit_trail` and the historian's password; a download lowers "shell access on the host" to
  "any Administrator session". Restore is the runbook below: it needs nine roles no dump creates
  and cannot be replayed over a previous restore.
- *`pg_dump`, not pgBackRest or CloudNativePG.* Either changes what the privilege is and what the
  chart deploys, and is a separate piece of work. This is the floor, not the ceiling, as the
  CronJob's header says.

**Restoring from a service-made backup** is the tier 1 runbook with three differences: the files
are in a directory on the volume, there are volume archives beside the dumps, and the dump was
taken while a backup job was RUNNING, so the restored database carries that row. The service
fails it on its next poll (`BACKUP_POLL_SECONDS`, 15 s), as it fails any RUNNING job no process
is running; until then `request_backup()` refuses, naming it. This is the runbook
`scripts/rehearse-restore.sh` runs, step for step. After losing the node there is no pod to stream
from: start from the bucket instead (*An encrypted copy off site*, below), then continue here from
the root key.

```bash
# The directory, off the backup PVC as a streamed tar (a directory `kubectl cp` may land the
# directory or its contents, and the two restore differently). Then the two databases as above:
# .dump files by default (backupService.format), so restore-databases.sh runs pg_restore.
POD=$(kubectl -n aber get pod -l app.kubernetes.io/component=backup-service -o jsonpath='{.items[0].metadata.name}')
kubectl -n aber exec "$POD" -- tar -czf - -C /backups <stamp> | tar -xzf - -C ./backups

# pgsodium's root key FIRST, onto the fresh database's volume, and a restart so the server reads
# it: Vault's rows are ciphertext under this key, and the fresh server minted its own.
# restore-databases.sh verifies Vault decrypts and names this step if it does not.
kubectl -n aber exec -i statefulset/supabase-db -c supabase-db -- \
  sh -c 'umask 077; cat > /var/lib/postgresql/data/pgsodium_root.key' < ./backups/<stamp>/vault-key-<stamp>.txt
kubectl -n aber delete pod supabase-db-0 --wait
kubectl -n aber rollout status statefulset/supabase-db

BACKUP_DIR=./backups/<stamp> BACKUP_STAMP=<stamp> scripts/restore-databases.sh

# The storage objects, into the storage pod's volume.
POD=$(kubectl -n aber get pod -l app.kubernetes.io/component=supabase-storage -o jsonpath='{.items[0].metadata.name}')
kubectl -n aber exec -i "$POD" -- tar -xzf - -C /var/lib/storage < ./backups/<stamp>/storage-objects-<stamp>.tar.gz

# A volume the workload holds open (the forge, then the broker): scale it to zero, replace the
# volume's contents through a helper pod holding the same claim, scale it back. The forge archive
# restores the host keys, so appliances keep cloning; the broker archive restores the document,
# and the boot reconcile keeps every account it holds.
restore_volume() {   # <deployment> <archive>; the claim is the deployment's "data" volume
  CLAIM=$(kubectl -n aber get "deploy/$1" -o jsonpath='{.spec.template.spec.volumes[?(@.name=="data")].persistentVolumeClaim.claimName}')
  IMAGE=$(kubectl -n aber get "deploy/$1" -o jsonpath='{.spec.template.spec.containers[0].image}')
  kubectl -n aber scale "deploy/$1" --replicas=0
  kubectl -n aber wait --for=delete pod -l "app.kubernetes.io/component=$1" --timeout=5m
  kubectl -n aber apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata: { name: volume-restore-$1 }
spec:
  restartPolicy: Never
  securityContext: { runAsUser: 0 }
  containers: [{ name: restore, image: "$IMAGE", command: [sleep, "3600"], volumeMounts: [{ name: data, mountPath: /volume }] }]
  volumes: [{ name: data, persistentVolumeClaim: { claimName: $CLAIM } }]
EOF
  kubectl -n aber wait --for=condition=Ready "pod/volume-restore-$1" --timeout=5m
  kubectl -n aber exec -i "volume-restore-$1" -- sh -c 'rm -rf /volume/* /volume/.[!.]*; tar -xzf - -C /volume' < "$2"
  kubectl -n aber delete pod "volume-restore-$1"
  kubectl -n aber scale "deploy/$1" --replicas=1
  kubectl -n aber rollout status "deploy/$1"
}
restore_volume gitea     ./backups/<stamp>/forge-<stamp>.tar.gz
restore_volume mosquitto ./backups/<stamp>/broker-<stamp>.tar.gz

# The CA, on a NEW cluster, before deploy/k8s/internal-ca.yaml is applied: cert-manager then finds
# a key pair matching the Certificate and issues nothing new, so every leaf certificate is issued
# from the CA the appliances already pin. Applied after cert-manager has minted a fresh CA, the
# broker and both databases have to be re-issued and every appliance re-enrolled anyway.
tar -xzf ./backups/<stamp>/ca-<stamp>.tar.gz
kubectl -n cert-manager create secret generic aber-ca-key-pair \
  --from-file=tls.crt=ca/tls.crt --from-file=tls.key=ca/tls.key --from-file=ca.crt=ca/ca.crt
kubectl apply -f deploy/k8s/internal-ca.yaml
```

**The buckets and their policies come back from the dump, not from the chart.** `storage.buckets`
and the RLS policies on `storage.objects` are rows and objects in `supabase-db`, so the `--clean`
restore replaces what the fresh install's storage-policies and storage-init Jobs created with the
backup's copy. Nothing reconciles them to the chart until the next `helm upgrade`, when those two
Jobs run again: until then a bucket added since the backup was taken is missing, and a bucket's
settings and policies are the backup's. So run `helm upgrade` with the release's values once the
restore is done. This follows from what the dump holds and from `restore-databases.sh`'s `--clean`;
it has not been tested live, and the rehearsal does not assert it.

**Rehearsed weekly, from a backup the service took.** `.github/workflows/restore-rehearsal.yml`
asks for its backup the way the Backups page does, with an off-site destination set, and restores
both databases and the three volumes into a fresh install from the copy it fetches out of the
bucket and decrypts, once the namespace and the backup volume are gone. It asserts what a count
cannot catch, and asks for a second backup, so a green run also says the restored stack can back
itself up and copy that backup off site
([`deploy/k8s/README.md`](../deploy/k8s/README.md#rehearsing-the-restore-weekly-and-by-hand)
lists the assertions). The CA is the one component it does not rehearse: the rehearsal installs
no cert-manager.

### An encrypted copy off site (0018)

**Every backup was on the disk it protects.** The service wrote each backup onto the backup PVC
and nowhere else, and on the default storage class that claim is `local-path`: one node, no
replication, no snapshots, usually the disk that holds both databases. So the backups recovered a
dropped table or a bad migration, and not a failed disk, a lost node or a lost site, which are the
failures a backup exists for. The parts the documentation calls irreplaceable (`supabase-db`, the
Vault key, the internal CA, the broker's accounts, the forge) had no copy anywhere else.
`0132` made the same argument for the cold archive.

**What the service does.** When the Backups page names a destination, the service copies every
backup to an S3 endpoint and keeps the local one; the PVC stays the fast copy with its own
retention. On each poll with no job to take it copies one backup that has no copy at the current
destination, newest first, so a requested backup waits behind one upload at most. Each file of the
backup directory becomes one object, `<prefix>/<stamp>/<file>.age`, with the manifests last, so a
copy holding `manifest.json.age` holds every file it names.

- **Encrypted before it leaves the pod, with age.** Every directory holds pgsodium's root key beside
  the dump holding the Vault's ciphertext, and the CA's key pair. Anyone who could read an
  unencrypted bucket could decrypt every Vault secret, the cold archive's S3 key among them, and
  sign certificates every appliance trusts. The service holds only the recipients (age public
  keys) from the settings, so neither a stolen bucket credential nor a compromised pod can read a
  copy. The identity that decrypts is the operator's, and is never in this stack.
- **Checked the way the cold archive checks.** Each object is sent with the SHA-256 of its
  ciphertext as `ChecksumSHA256`, so the store refuses a corrupted upload, and a `HEAD` with
  checksum mode on confirms the size and the digest the store computed (`verify_object()` in
  `ingestion/cold_archive.py`). A file over 64 MiB (`BACKUP_OFFSITE_PART_BYTES`) goes as a
  multipart upload with a checksum on every part, and the `HEAD` is compared with the composite
  S3 keeps, the SHA-256 of the parts' digests followed by `-<parts>`. An implementation that
  returns no checksum has still checked it on write, so absent is not a mismatch. The
  `manifest.json` digests are of the plaintext and are checked after decryption on restore.
- **An existing client, not a signer of our own.** The AWS CLI (`s3api put-object`,
  `upload-part`, `head-object`) and `age`, both Alpine packages in `backup-service/Dockerfile`. They
  add about 250 MB to the image, nearly all of it the CLI's Python and botocore. The checksum goes
  as a header, never as the trailer the CLI adds by default
  (`AWS_REQUEST_CHECKSUM_CALCULATION=when_required`), because not every S3 implementation reads
  trailers.
- **A failed upload never fails the backup.** The local backup is good, so the run stays
  COMPLETED; the copy has its own state on the `backups` row (`offsite_state`: PENDING, COPIED or
  FAILED, with `offsite_error`), and a failed copy is tried again after 1, 2, 4 and 8 minutes, then
  every 15, so an unreachable endpoint is not sent the same gigabytes every poll. Setting or
  changing the destination copies every backup still on the volume to it.

**The remote copies follow the local rules.** `backup_prunable()` hands the prune each row's
`offsite_location`, and the service deletes the copy (every object under `<prefix>/<stamp>/`) with
the local files, so pinning and the newest-three floor apply to the bucket too. A delete that
fails never holds the local prune back, and the `BACKUP_PRUNED` reason says what happened to the
copy: deleted, not deleted and why, or left because the destination has changed or been removed.
That is deliberate, because the stricter arrangement is supported: a bucket with versioning or
Object Lock, and a credential without `s3:DeleteObject`, so that nothing this stack holds can
delete a copy. There a lifecycle rule expires old copies instead; set its expiry well past
`backup.retentionDays`, because a lifecycle rule knows nothing of the floor, and a run of failed
backups longer than the expiry would lose the last good copies to it.

A credential scoped to the prefix needs `s3:PutObject`, `s3:GetObject` (for the `HEAD`),
`s3:ListBucket` on the prefix, `s3:AbortMultipartUpload` and, unless a lifecycle rule prunes
instead, `s3:DeleteObject`.

**Configured on the Backups page, as cold storage is.** The endpoint, region, bucket, prefix,
access key ID, path-style switch and encryption recipient are `backup_offsite.*` settings, flagged
`sensitive` so only an Administrator reads them, and checked on write by
`backup_offsite_setting_guard()` (a URL, a bucket name, a prefix without a leading or trailing
`/`, one or more `age1` keys). The page's destination dialog writes them in one statement through
`set_backup_offsite_destination()`, and the secret key into the Vault through the write-only
`set_backup_offsite_credential()`, the second foreign credential there beside the cold archive's.
`clear_backup_offsite_destination()` empties them and deletes the secret; copies already made stay
in the bucket. The service reads the whole destination on each poll through
`backup_offsite_destination()`, a gate no PostgREST role can call, so a change on the page applies
without a restart. The Settings page does not list these rows, so the dialog is their one editor.

**The circularity, which the dialog states.** The Vault is inside every backup. Keeping the bucket
credential there is fine for the service's own writes, but a restore after losing the site starts
without the Vault, so the bucket credentials and the age identity must be kept outside this stack.

**Under `networkPolicy.enabled` the endpoint needs an egress rule.** The chart cannot derive one
from a page setting, so `backupService.offsiteEgress` takes NetworkPolicy egress rules for the
backup service's pod (an `ipBlock` and port for the endpoint). Without one every copy fails at
connect time.

**It shows.** The Backups page shows each backup's copy in an Off site column, and the destination
in its header button. The Grafana rule *Off-site Backup Stale* reads `backup_offsite_health`, which has a
row only while the destination is complete: how long the newest backup has gone without a copy at
the current destination, counted from when it was taken or the destination last changed, whichever
is later. It fires past 12 hours (`grafana/README.md`).

**Restoring from the bucket** is the runbook above with a different first step: the directory comes
from the bucket, not from the pod, and is decrypted with the identity the operator kept. After a
node or site loss there is no pod and no volume to stream from, so this is the one to rehearse
(`scripts/rehearse-restore.sh fetch` runs it, step for step).

```bash
# Every object of the backup, then each decrypted beside itself. age authenticates what it
# decrypts, so a tampered object fails here rather than in the restore.
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=<region>
aws --endpoint-url <endpoint> s3 cp --recursive s3://<bucket>/<prefix>/<stamp>/ ./backups/<stamp>/
for f in ./backups/<stamp>/*.age; do age -d -i identity.txt -o "${f%.age}" "$f" && rm "$f"; done

# The digests the manifest recorded, against the plaintext.
( cd ./backups/<stamp> && jq -r '.components[] | "\(.sha256)  \(.file)"' manifest.json | sha256sum -c )

# Then from "pgsodium's root key FIRST" above, unchanged.
```

### Tier 2: infrastructure snapshots

For the cluster — CSI `VolumeSnapshot`, Velero, and the storage-PVC gap — see
[`../deploy/k8s/README.md`](../deploy/k8s/README.md#backups). For a single-node k3s on a VM, the
recommended pattern is **Proxmox VE + Proxmox Backup Server**:

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

### How the service takes a backup

**Why a service.** `request_backup()` (archived migration 0101) is a row, and nothing else in the
stack can turn a row into a backup: `pg_dump` against both databases, a tar of the storage
objects and a consistent copy of the forge's volume need a process beside the volumes holding a
superuser credential, which is neither an edge function nor a browser. `scripts/backup-service.mjs`
is that process and does that one thing. It serves nothing but `/healthz` and hands no bytes to
anybody: a dump holds `auth.users`, every OAuth secret's hash, the whole `audit_trail` and the
historian's password, and "any Administrator session" is a wider audience than "a shell on the
host". Restore is the runbook above, run from that shell against the volume. The chart projects
the script through a ConfigMap over an image built from the database's own
(`backup-service/Dockerfile`), so `pg_dump` is at least the server's version.

**It talks to the database through psql, as `supabase_admin`**, the session `pg_dump` needs
anyway: the event triggers are its, and a dump taken as `postgres` restores as nobody. Values are
passed as psql variables and interpolated as quoted literals, on stdin because psql substitutes
variables in a script it reads and not in a `-c` command, so nothing concatenates a value into
SQL. The gates it calls refuse every PostgREST role and any session that is not a superuser's, so
holding this credential is the whole of the authority and there is no second one to keep in step.
Both database passwords are required: a service that could reach one of them would record a
backup of half the stack as a backup.

**The schedule is this process's.** At start it registers `enqueue_scheduled_backup()` with
pg_cron on `BACKUP_SCHEDULE`, or removes the job when the schedule is empty, so a stack with no
service queues nothing nobody will take. Retention is applied after every run, failed ones
included: a scheduled backup older than `BACKUP_RETENTION_DAYS` and not one of the newest three is
deleted and forgotten, the row only after the files are gone, and a prune can never remove a path
outside the backup directory; a requested backup is
pinned until an Administrator releases it. A `RUNNING` job that no process is running is failed
before each claim, not only at start: the service is one replica, so such a row is a previous
process's, or it came back in a restore from a backup taken while that job ran, and left standing
it would refuse every new backup.

**The files.** One directory per backup, named by the UTC stamp, holding what
`backup-databases.sh` writes plus the keys and the volumes: `supabase-db-<stamp>.sql.gz`,
`timescaledb-<stamp>.sql.gz`, `vault-key-<stamp>.txt`, `storage-objects-<stamp>.tar.gz`,
`forge-<stamp>.tar.gz`, `broker-<stamp>.tar.gz` (the broker's data volume, which is the Dynamic
Security document), `ca-<stamp>.tar.gz` (the internal CA's key pair, read from its Secret through
the API), `manifest-<stamp>.txt` (the text manifest `restore-databases.sh` reads) and
`manifest.json` (digests). Written under `.partial-<stamp>` and renamed on success, so a directory
named by a stamp is a complete backup or absent, and a `.partial-*` directory found at start is a
backup the previous process did not finish. A dump smaller than `MIN_DUMP_BYTES` is a failure,
not a backup: an empty database, a wrong `-d` or a server that died mid-write all produce a
well-formed short file. `--clean --if-exists` on the plain format is what lets a restore replace
the auth and storage schemas the image ships; the custom format carries the same as a flag at
restore time. A component whose directory is not mounted is absent from the backup and the
manifest says so; an empty path variable disables one deliberately.

**The forge's SQLite database** is copied with sqlite3's online backup, which is consistent while
Gitea writes, from a staging directory so that tar's second `-C` lands it at `gitea/gitea.db`
inside the archive where a restore expects it. On a read-only volume SQLite cannot open the WAL
database for reading, so the raw `db`, `-wal` and `-shm` files are copied together, the WAL
folded into the copy with a checkpoint, and the copy integrity-checked; the method used is in
`manifest.json`. GNU tar exits 1 for "file changed as we read it", which an upload landing
mid-run produces and which is acceptable for immutable blobs, so that status is a warning and
every other non-zero status is a failure.

**The two keys.** pgsodium's root key is read through the same superuser session the dump uses,
since `pg_read_file` resolves a relative path against the data directory; a dump without it
restores a Vault that nothing can decrypt, because a fresh server mints its own key, and the file
is written as read with no newline so a restore can put it back byte for byte. The CA's key pair
is read from its Secret as cert-manager keeps it (`tls.crt`, `tls.key`, `ca.crt`), staged at
0600 and archived; a named CA that cannot be read fails the backup rather than going absent,
because the values named it and a backup without it is a fleet-wide re-enrolment. The
ServiceAccount token is read on every API call because projected tokens are short-lived and
rotated in place.

## Storage buckets and why they differ

Four buckets, created by `scripts/storage-init.mjs` and governed by `storage-policies.sql`. The
first two are opposites in the one setting that matters, and the reasoning belongs together rather
than split across comment blocks in the policy file. `area-plans` is the odd one out below.

There is no bucket for cold telemetry: it leaves the cluster entirely, for a configured S3
endpoint. See "Cold telemetry archival" above.

| | `asset-3d-models` | `broker-captures` | `area-plans` | `asset-exports` |
| :--- | :--- | :--- | :--- | :--- |
| Public read | **yes** | **no** | **no** | **no** |
| Write | `device:manage` (Administrator, Shopfloor_Manager) | Administrator, Shopfloor_Manager, plus the ingestion daemon for one path | Administrator, Shopfloor_Manager, under an existing area's prefix | no browser role: the `aas-export` function writes as `service_role` |
| Read | anyone, including `anon` | those two plus **Auditor** | every signed-in role | Administrator, Shopfloor_Manager, Auditor |
| Operator | read | nothing | read | nothing |
| Reached by | a plain public URL | a signed URL, minted after a role check | an authenticated download, handed to an `<img>` as a blob URL | a signed URL, minted after a role check |

`asset-exports` has no write policy at all, and that is the point: an object in it is evidence of
an export that an `asset_exports` row records, so a hand-uploaded file would be a bundle with no
provenance sitting beside ones that have it. Deletes are Administrator-only because the row's
tombstone points at the object — removing one is a decision about the record, not about disk.

`area-plans` is readable by every signed-in role because the Site Map is the page an Operator
lives on, and private because a plan is a drawing of the plant and SVG is active content: the
bucket admits `image/svg+xml` only, and the dashboard never inlines it.

**It was `floor-plans` until 1.0.** The name first outlived the retirement of floors as a modelled
level, on the grounds that the drawing was still a floor plan; it was renamed with every other
identifier that still said floor, because after 1.0 a bucket name cannot change without an upgrade
path. `storage-policies.sql` drops the four `floor_plans_*` policies and then
`is_floor_plan_path()`, which the two write policies called, and `storage-init.mjs` moves the
objects (below). `areas.plan_path` holds only the object key, `<area_id>/<file>.svg`, so no row
changes.

### How `storage-init.mjs` creates them

**Not a SQL migration.** `storage.buckets` is owned by storage-api, which runs its own migrations
against that schema when it boots. The supabase/postgres image ships only a stub of it (`id`,
`name`, `owner`, timestamps, and none of `public`, `file_size_limit` or `allowed_mime_types`), and
db-init replays our migrations long before storage-api starts. On a fresh stack a migration
inserting into `storage.buckets` would hit the stub: it could create the row but could not mark it
public, so the bucket would come up private on first boot and correct itself only on the second.
Creating it through the Storage REST API instead runs after storage-api is healthy and is
indifferent to which columns this version's schema has. The two files must agree on the bucket
names: a bucket created with no policies is invisible to every browser-facing role, and a policy
naming a bucket that was never created is dead text. Neither errors, which is why
`check-docs-drift.mjs` holds the script, `storage-policies.sql` and the table above together.

**Idempotent by inspection, and reconciled on every boot.** The hook Job runs on every upgrade.
The script asks whether each bucket exists before deciding to create it, rather than creating it
and treating the failure as success, because storage-api v1.11 answers a duplicate create with
HTTP 400 "The resource already exists" rather than 409, and answers a missing bucket with 400 as
well, so a conflict, an absence and a malformed request are indistinguishable by status and only
the payload tells them apart (verified against the running service; the obvious reading of 404
and 409 is wrong for both). The settings are then reconciled either way, on the create path too,
so a bucket created by an older revision of the script or by hand in Studio is brought up to the
current settings, a changed size limit takes effect on the next boot rather than needing the bucket
dropped, and for the private buckets `public: false` is re-asserted. The buckets are created
sequentially, not with `Promise.all`, so a failure part-way through names the bucket that failed.

**A renamed bucket is moved, then deleted.** Nothing else removes a bucket: this script only
creates and reconciles, and `storage-policies.sql` only replaces what it names, which is why the
retired `gateway-backups` bucket had to be deleted from the dev cluster by hand. `RENAMED_BUCKETS`
lists each old name with its new one. After every bucket above exists, the script lists the old
bucket's objects folder by folder, moves each into the new bucket under the same key
(`POST /object/move` with `destinationBucket`), and deletes the old bucket, which storage-api
allows only once it is empty. A move that fails stops the Job before the delete, so the objects
still unmoved stay where they were and the next upgrade picks them up. An old bucket that no longer
exists is the settled state: the second run lists nothing, moves nothing and logs that it is gone.
The only entry is `floor-plans` to `area-plans`. A restored backup that predates the rename brings
`floor-plans` back, and the next upgrade moves it the same way.

**The buckets are a list in code, not parameters.** They differ in the setting that matters most,
whether they are public, and expressing that as an environment variable would leave "is this
bucket public?" answerable only by reading a `.env` file. `asset-exports` and `area-plans` are fixed names rather
than environment variables because `storage-policies.sql` and `frontend/src/api.js` name them
too; a name that can be changed in one place is a bucket with no policies.

**Two size variables, two jobs.** `STORAGE_FILE_SIZE_LIMIT` is storage-api's global ceiling for
every bucket, and storage-api refuses to create a bucket whose limit exceeds it, so the ceiling has
to be at least the largest bucket (`broker-captures`, 100 MiB). `STORAGE_MODEL_FILE_SIZE_LIMIT`
is the 3D-model bucket's own limit; reading the ceiling for it would mean raising the ceiling for
one bucket silently raised this one too.

**The capture limit is sized from the traffic and read together with the job caps.** The fleet's
measured rate is 0.95 msg/s and a message is a few hundred bytes of JSON, so an hour of a real
shift is single-digit megabytes and a full working day fits in 100 MiB; what the limit refuses is
a capture taken at the ingestion ceiling and left running for far longer than anybody needs.
Archived migration 0055 raised it from 25 MiB because `capture_jobs` caps a recording at 50 MiB,
and that cap is useless unless the bucket can hold what it allows: the failure of getting it
backwards is the worst possible ordering, a capture that reached its size cap terminating
successfully, being uploaded, and being refused, by which time the recording exists only in a
buffer about to be freed. The three job caps are mutually consistent so that the message cap binds
first (100,000 messages at a few hundred bytes is roughly 40 MB), leaving headroom above the size
cap. Anything raising the job cap in `capture_jobs_caps_are_bounded` has to raise the bucket limit
too. The export bucket's 256 MiB is likewise above the largest bundle the row caps in
`supabase/functions/_shared/aas/bundle.ts` admit (200,000 telemetry rows and 20,000 trail rows);
the row caps are the real limit, and the bucket limit is what stops a bug from becoming a disk.

**The MIME lists are the control, and two of them are deliberately loose.** The client-side
accept filter is a convenience. `model/*` is the registered tree for 3D formats (RFC 9245 registers
`model/gltf+json` and `model/gltf-binary`), but browsers are inconsistent about what they put in
`File.type`: `.obj` and `.stl` frequently arrive as `application/octet-stream` or an empty string
because the OS has no mapping for them, so rejecting those would make uploads fail on some
machines and not others. The octet-stream fallback is deliberate rather than lax, and the
extension allow-list in the 3D-model migration's CHECK is what actually constrains what a shell can
reference. Captures admit `text/plain` and `application/octet-stream` for the same reason and not
because anything but JSON is allowed; the uploader checks that the payload carries
`aber_capture_version` and a `messages` array before it is sent, so the list is the coarse outer
bound rather than the check. `.aasx` is a ZIP by construction and browsers disagree about what to
call one, so both the generic and the ZIP types are admitted; the function sets the type itself
and uploads as `service_role`, and the list is what keeps a hand-uploaded file from arriving as
something a viewer would execute. Area plans admit `image/svg+xml` exactly, with no fallback:
every browser reports it, and the dashboard sets the type itself.

**`asset-exports` is its own bucket, not the cold archive's.** They are not the same kind of
object: a bundle is a copy somebody asked for, derived from rows still in the database, so it
belongs on local storage where the browser can sign a URL for it. A cold telemetry object is the
only remaining copy of that history and goes to a remote endpoint the browser never touches
(archived migration 0132). One retention decision cannot serve both.

### `asset-3d-models` is public-read, and that is not laziness

An exported AAS `File` element's URL has to be dereferenceable by a viewer holding no Aber
session — that is what makes the shell a document rather than a pointer into this stack. A signed
URL would expire, which turns every shell already handed out into a time bomb.

The consequence is a constraint on what may go in it: **nothing beyond machine geometry.** Writes
are gated on `device:manage` rather than merely `authenticated`, because an upload both changes
what a shell publishes *and* puts bytes at a world-readable URL.

### `broker-captures` is private, and holds the plant's traffic

A capture is a recording of every edge node, device id, metric name and value that spoke in the
window. None of that is public, and there is deliberately no `getPublicUrl()` path for this
bucket: `public: true` would make storage-api serve the objects without consulting
`storage.objects` RLS at all, so the role split below would silently stop applying to reads.
`storage-init.mjs` re-asserts `public: false` on every boot.

### The role split is asymmetric on purpose

An auditor's job is to see what the plant did and when, and a capture is the record of what the
edge actually published — so `SELECT` is the point of the role. `INSERT` would let an auditor
rewrite the record they exist to examine, which is the same objection that makes `audit_trail`
append-only.

Operator gets nothing: nothing on the operator dashboard reads or writes a capture, and a role that
cannot use a capability should not hold it.

### The path is confined by the database, not by the uploader

Every object must live under `<subject>/`, and that folder must name a gateway or device that
exists (`is_capture_subject_prefix()`). Same idea as the broker's per-gateway role
(`spBv1.0/+/+/<sparkplug_id>/#`) one layer up: **the client does not get to assert where its data
belongs.** A convention the frontend happens to follow is not a control — Storage's REST API is
reachable with any authenticated session.

`SELECT` is deliberately *not* path-confined: a reader may list the bucket to find captures, and
requiring a valid prefix on read would hide the capture of a subject that had since been deleted —
which is exactly when someone is looking for it.

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

### How the policies are applied

`storage-policies.sql` runs on every boot as the storage-policies Job, after `supabase-storage`
is healthy and before `storage-init`. The order is the whole of the ordering argument:
storage-api creates `storage.objects` by its own migrations and the PG17 image ships the
`storage` schema empty, which is why the policies are not in the baseline migration; and
`storage-init` creates the buckets through the Storage REST API as `service_role`, which needs the
grants this file makes or fails with a misleading `400 new row violates row-level security
policy`. The script checks that the table exists before anything else and fails with the reason
rather than a bare "relation does not exist", because reaching it too early is an ordering fault
in the service graph and a different problem from a wrong policy. Between storage-api creating
the table and this file running, RLS is enabled with no policies, so `anon` and `authenticated`
are denied and `service_role`, which bypasses RLS, is unaffected: a brief loss of function, never
of control. RLS is enabled here again rather than assumed, because this file is the access control
for the table and must not depend on storage-api's migrations having done it.

**The grants are enumerated.** On the PG17 image storage-api creates its tables with no grants to
the API roles, so each privilege is stated and only what each role needs. `service_role` gets the
admin surface because storage-api assumes it to serve the REST API, and since it bypasses RLS the
grants are the only limit that applies to it, which is why it is enumerated rather than given
`ALL`.

**Public reads never consult a SELECT policy.** `/object/public/...` is served by the bucket's
`public` flag. SELECT governs listing, and storage-api's writes read the row back, so on the
3D-model bucket it takes the same authority as writing: the geometry is public, the inventory of
which devices have a model is not.

**`storage.objects.name` is qualified in every policy, and must be.** `public.gateways` has a
`name` column of its own, and an unqualified reference inside a policy binds to the gateway's
display label, which refuses every upload and would accept any prefix if a gateway were ever named
something path-shaped.

**Every bucket's block ends in a self-check.** The failure these guard against is silent in the
direction that matters least and loudest in the direction that matters most: a missing policy
denies, so the viewer simply shows nothing and nobody reads a log. The checks assert the set is
complete by name rather than by count, so a policy another chart version left behind is reported
without failing the boot; the capture bucket's check also asserts that Auditor never writes, that
the ingestion daemon appears in exactly SELECT, INSERT and UPDATE with every arm confined to the
object of its running job, that it never deletes, and that the playback worker appears in SELECT
alone. Each exception says what the missing arm looks like from outside, which is a job that
failed for no stated reason.

**Retired policies are dropped explicitly.** Cold telemetry once had a bucket here and now goes
to a configured S3 endpoint, somewhere a site loss does not reach. Deleting the block would not
remove the policies: this file drops each policy it is about to create, so a policy it no longer
mentions survives every boot on a database that already has it, guarding a bucket nothing writes
to. The four `telemetry_archive_*` policies are therefore dropped by name and asserted gone. The
bucket itself is deleted by nobody: it is left with whatever it holds, for an Administrator to
empty and remove from Studio once satisfied the objects in it are also at the remote endpoint,
which `cold_archive audit` answers for the manifest's rows.

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
9. **i3X namespaces follow the semantic ids.** A metric's i3X type is its catalog row, in the
   namespace its semantic id is defined in (`metric_type_namespace` in `i3x/address_space.py`,
   [`../i3x/README.md`](../i3x/README.md#address-space)). Ids under a new authority are local
   there until it gains a case, and `GET /namespaces` lists a namespace only while a type uses it.

---

## The development seed

[`seed.sql`](seed.sql) creates the four demo personas and nothing else. It is local development
data, never for a production database, and db-init replays it on every start against a
persistent volume, so every statement in it has to be repeatable on a database that already holds
these rows.

**GoTrue's columns.** Every varchar token column on `auth.users` must be set to the empty string
rather than NULL: GoTrue maps them to Go `string` fields, and a NULL aborts the row scan with
`converting NULL to string is unsupported`, which the login reports as a 500. `email_change` in
particular is nullable with no default, so omitting it from the INSERT is enough to break
authentication entirely. `aud` must be `authenticated` and match `GOTRUE_JWT_AUD` in the chart's
auth environment, or GoTrue looks users up under a different audience and finds nothing;
`raw_app_meta_data` must carry the `role` key, and `identity_data` on `auth.identities` must carry
`sub` and `email`.

**`ON CONFLICT DO UPDATE`, not `DO NOTHING`.** With `DO NOTHING` a persona row written by an
older, broken version of the seed could never be repaired; the seed would silently report
`INSERT 0 0` forever.

**Only the role mappings that are wrong are removed.** `user_roles` is audited and append-only
(archived migration 0070), and the unconditional DELETE this replaced removed all four rows and
the INSERT put them straight back, so every boot appended four `ROLE_REVOKED` and four
`ROLE_GRANTED` rows to a table that cannot be pruned. `check-migration-idempotency.mjs` reported
it, and the audit trail would have read as though somebody re-granted every persona's role
nightly. The `NOT IN` keeps the guarantee, that any mapping for these four that is not the
intended pair is removed, while a settled database matches no rows. Each persona holds exactly one
role because `usePermissions.js` reads `data[0]` and `custom_access_token_hook()` uses `LIMIT 1`,
so a persona holding two would resolve non-deterministically.

**The causation demonstration is gone, with the floor it demonstrated on.** The seed used to end
by re-describing one gateway and three of its devices inside a single transaction, so the audit
rows shared one `txid_current()` and the drawer's "Same transaction" control had something to
render on a fresh stack. Its subject was addressed by pinned ids a provisioning script issued, and
that script, those ids and the four-cell floor were retired together, so the UPDATEs could match
no row on any stack and the NOTICE they fell through to named a command that no longer existed.
What was lost is the demonstration, not the feature: `causation_id` is written on every
transaction, so the control works the moment one act touches several rows, and commissioning a
gateway alongside its devices through the UI is exactly that act. The tutorial walks a reader
through doing it for real.

## Testing

```bash
# No stack required — spins up its own Postgres in CI
python supabase/migrations/test_user_roles_rls.py
python supabase/migrations/test_schema_versioning.py
python supabase/functions/approve-quarantine/test_approve_quarantine.py
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
