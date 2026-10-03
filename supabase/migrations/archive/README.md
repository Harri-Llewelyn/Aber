# Archived migrations

The 197 files here are the incremental migrations that built this schema, kept after being
squashed back into `../0001_baseline_schema.sql` (structure) and `../0002_seed_data.sql` (data).

**They are no longer applied.** `supabase/db-init/Dockerfile` copies `migrations/*.sql`, a glob
that does not recurse, and the CI workflow uses the same one — so nothing in this directory runs.

## Why they are kept rather than deleted

They are the reasoning. The baseline files show *what* the schema is; these show *why* it is that
way — why `metric_catalog.name` is immutable, why gateway staleness is a view rather than a cron
writer, why the Realtime tenant must be addressed as `realtime-dev.supabase-realtime`, why the
metric-group separator is `/` and not `.`. Several of those decisions are cited by filename from
the applied migrations and the component READMEs, and re-deriving them from a squashed dump would
not be possible.

Treat this directory as documentation with a `.sql` extension. An applied file that cites one of
them says "archived migration NNNN", which is how to tell a citation from a claim that something
still runs.

## The four squashes

| When | Files folded | Left applied | Postgres |
|---|---|---|---|
| Public beta | 38, `20260101000000_init_assets_and_digital_thread` … `20260101000037_schema_versioning` | `0001`, `0002` | 15.6.1.143 |
| 2026-09-03, `223b49d` | 61, `0003` … `0078` | `0001`, `0002` and a tail of nine | 15.6.1.143 |
| 2026-09-22, `12a050c6` | 70, `0004` … `0134` | `0000`, `0001`, `0002` | 17.6.1.160 |
| Before 1.0, 2026-10-03 | 28, `0000` … `0032`, archived as `0135` … `0162` | `0001`, `0002` | 17.6.1.175 |

**A number is never issued twice.** Until the fourth squash it was: the third restarted the live
chain at `0003`, so `0003`–`0032` each named an archived file and a live one, and a bare
citation of the archived file came to name the live one as the chain grew past it. The fourth
archived its files under the numbers after the archive's highest, below, and every migration since
takes the next number never issued: the first after 1.0 is `0163`. Check 9d of
`scripts/check-docs-drift.mjs` refuses a live number the archive holds. The two `0074`s, one archived
by the second squash and one by the third, predate the rule; cite either by filename.

Each file's header names its number in the archive and the number it was applied as.

| Applied as | Archived as |
| :--- | :--- |
| `0000` | [`0135_a_database_from_before_the_fold`](0135_a_database_from_before_the_fold.sql) |
| `0003` | [`0136_the_group_answers_to_aber`](0136_the_group_answers_to_aber.sql) |
| `0004` | [`0137_the_namespace_answers_to_aber`](0137_the_namespace_answers_to_aber.sql) |
| `0005` | [`0138_raw_telemetry_has_a_stated_window`](0138_raw_telemetry_has_a_stated_window.sql) |
| `0006` | [`0139_the_drawer_knows_how_many_rows_a_transaction_wrote`](0139_the_drawer_knows_how_many_rows_a_transaction_wrote.sql) |
| `0007` | [`0140_the_directory_names_the_image_each_service_runs`](0140_the_directory_names_the_image_each_service_runs.sql) |
| `0008` | [`0141_the_223p_metrics_file_under_bms`](0141_the_223p_metrics_file_under_bms.sql) |
| `0009` | [`0142_mtconnect_metrics_carry_their_data_item_type_id`](0142_mtconnect_metrics_carry_their_data_item_type_id.sql) |
| `0010` | [`0143_a_metric_deprecation_reaches_the_thread`](0143_a_metric_deprecation_reaches_the_thread.sql) |
| `0011` | [`0144_grafana_sees_how_long_since_a_backup_succeeded`](0144_grafana_sees_how_long_since_a_backup_succeeded.sql) |
| `0012` | [`0145_a_semantic_id_is_an_iri_or_an_irdi`](0145_a_semantic_id_is_an_iri_or_an_irdi.sql) |
| `0013` | [`0146_machine_identities_may_hold_write_permissions`](0146_machine_identities_may_hold_write_permissions.sql) |
| `0014` | [`0147_a_gateway_status_is_a_label_and_never_stale`](0147_a_gateway_status_is_a_label_and_never_stale.sql) |
| `0015` | [`0148_i3x_authenticates_with_a_call_the_planner_cannot_fold`](0148_i3x_authenticates_with_a_call_the_planner_cannot_fold.sql) |
| `0016` | [`0149_a_local_extension_carries_no_minted_id`](0149_a_local_extension_carries_no_minted_id.sql) |
| `0017` | [`0150_retention_keeps_the_newest_three_backups`](0150_retention_keeps_the_newest_three_backups.sql) |
| `0018` | [`0151_every_backup_has_an_encrypted_copy_off_site`](0151_every_backup_has_an_encrypted_copy_off_site.sql) |
| `0020` | [`0152_the_thread_files_a_machine_as_a_service`](0152_the_thread_files_a_machine_as_a_service.sql) |
| `0021` | [`0153_an_approval_shares_a_causation_id_with_the_change_it_made`](0153_an_approval_shares_a_causation_id_with_the_change_it_made.sql) |
| `0022` | [`0154_whoever_decides_a_proposal_can_read_the_machine_that_filed_it`](0154_whoever_decides_a_proposal_can_read_the_machine_that_filed_it.sql) |
| `0024` | [`0155_node_red_is_listed_for_the_gateways_it_runs`](0155_node_red_is_listed_for_the_gateways_it_runs.sql) |
| `0025` | [`0156_one_forge_sweep_runs_at_a_time`](0156_one_forge_sweep_runs_at_a_time.sql) |
| `0026` | [`0157_the_backups_page_reads_the_historians_own_backup`](0157_the_backups_page_reads_the_historians_own_backup.sql) |
| `0028` | [`0158_a_revocation_is_judged_by_its_own_reply`](0158_a_revocation_is_judged_by_its_own_reply.sql) |
| `0029` | [`0159_a_deleted_device_takes_its_birth_parameters_with_it`](0159_a_deleted_device_takes_its_birth_parameters_with_it.sql) |
| `0030` | [`0160_a_node_death_takes_its_devices_offline`](0160_a_node_death_takes_its_devices_offline.sql) |
| `0031` | [`0161_the_seeded_quarantine_webhook_is_retired`](0161_the_seeded_quarantine_webhook_is_retired.sql) |
| `0032` | [`0162_machine_principals_hold_no_role`](0162_machine_principals_hold_no_role.sql) |

### What the fourth squash changed about the shape

**It has no tail.** Each earlier squash kept its subtractions applied, because a database built by
the chain it replaced still held what they removed. Before 1.0 no such database is upgraded
([`docs/upgrades.md`](../../../docs/upgrades.md#the-floor-100)), so `0000`, the third squash's tail,
folded away with the rest, and so did the one-shot repairs that only ever touched an older
database's rows: `0136`'s Sparkplug group move, `0137`'s semantic-id authority, `0155`'s Directory
rename, `0161`'s webhook deletion. Their tests went with them.

**One statement had to move by hand, and the check could not have found it.** `0140` called
`record_directory_images()` with the chart's image map on every boot. The map arrives as a psql
variable the equivalence probes never pass, so a fold that dropped the call would have compared
clean and left every Directory version blank on a real install. It is in `0002` now. Read every
folded file for `:'name'` and `:{?name}` before trusting the comparison.

**The audit trail's monthly partitions come before its default** (`AROUND_PARTITION` in the
generator). The third squash created them in a tail section after every audit trigger existed, so
on a first install anything audited while db-init was still running landed in the default
partition. That month's partition could then never be created, and every later boot failed. CI
found it on this squash's first run.

**`gateway_status` is built by its function** (`REBUILT_BY` in the generator). The baseline used
to state the view with a dumped column list, so a migration that widened `gateways` and rebuilt
the view broke the replay after it.

### What the third squash changed about the shape

The second squash kept nine files applied beside the baseline, each a subtraction the baseline
could not express — a dropped column, a deleted row, a withdrawn grant. That worked because those
nine happened to be small files whose *only* content was the subtraction.

This one could not do the same. Its subtractions live inside large feature migrations, and a
feature migration replayed after the baseline **reverts** it: `0108` defines
`may_decide_proposal()` as it stood at `0108`, the baseline defines it as it stands now, and the
chain runs the baseline first. Keeping the tail as it was left nine functions, two comments and a
lane list at their older definitions — which is what the equivalence check reported the first time
it was run against the fold.

So the tail is one file, `0000_a_database_from_before_the_fold.sql`, holding the subtractions and
nothing else. It sorts **before** the baseline, and has to: it converts `digital_thread` from an
ordinary table into a partitioned one, and the baseline describes it already partitioned.

## Reproducing the squash

Not transcribed by hand. `scripts/generate-baseline-section.mjs` rewrites a `pg_dump
--schema-only` into the idempotent form section 4 takes, and it exists because the first two
squashes did this by hand and left nothing behind — so the form had to be re-derived from the
previous baseline each time, and the rules below had to be rediscovered each time with it.

1. Build a database from the chain being replaced and dump it, with the same preconditions the real
   one has (GoTrue's `auth` schema present, `search_path` set to `auth, public, extensions`):

       node scripts/verify-schema-equivalence.mjs --dump <old chain dir> dump.sql

   That is `pg_dump --schema-only --schema=public --schema=timescale` against the same probe the
   comparison builds; the script's header says why each precondition is load-bearing.

2. `node scripts/generate-baseline-section.mjs <dump.sql> > section4.sql`

3. Assemble: the hand-written head (sections 1–3: extensions, roles, default privileges), the
   generated section 4, then the hand-written tail (sections 5–7: the Realtime publication, the
   privileges withdrawn, the structural self-checks).

4. Check it: `node scripts/verify-schema-equivalence.mjs <new chain dir> <old chain dir>`. It
   builds both databases and compares a dump of each, plus the seeded rows table by table. The
   oracle for the third squash was schema digest `1977c6291706`, and for the fourth `fefbbb17fce2`.

### What only that check catches

Each of these produced an identical-looking baseline that was wrong, and none would have been
found by reading it.

1. **`SET check_function_bodies = false` is required.** PL/pgSQL resolves `%ROWTYPE` in a
   function's DECLARE block at CREATE time, so `fork_schema()` cannot be created before
   `public.schemas` exists, and no single object order satisfies every such dependency.

2. **pg_dump records only positive grants.** The Supabase image ships
   `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`, and the REVOKEs
   scattered through the chain leave no trace in a dump — so a naive baseline silently hands
   `anon` full access to every table. The baseline resets privileges explicitly before re-granting,
   and section 6 states by hand the withdrawals no dump can express: the backup lane's eight
   functions, closed to `service_role` because holding the service key is not a reason to be able
   to claim a backup job.

3. **Constraints must be guarded, not dropped and re-added.**
   `DROP CONSTRAINT IF EXISTS cells_pkey` fails on a populated database because foreign keys
   depend on it, which would have broken the second boot rather than the first.

4. **A grant to `grafana_reader` must survive the role not existing.** The role is created only
   where `BI_READER_PASSWORD` is set, and a dump records the resulting ACL as a bare `GRANT` that
   fails with `role "grafana_reader" does not exist` on exactly the deployments the condition
   exists for. No probe catches this, because every fixture sets the password. The generator wraps
   all eight in a role-exists guard.

5. **A partition is written as `PARTITION OF`, not as a table plus an attach.** pg_dump splits
   each one into five objects — a bare `CREATE TABLE`, a `TABLE ATTACH`, one `INDEX` per inherited
   index, a `CONSTRAINT` for the primary key, and an `INDEX ATTACH` each — because that order lets
   it restore a large table in parallel. Replayed verbatim it builds indexes that are **not
   attached to the parent's**, which is a different schema wearing the same names. The parent's
   own indexes are emitted without `ON ONLY` so they recurse, and the partition's are dropped.

6. **A partition's privileges do not follow its parent's**, because they are checked when it is
   addressed directly. The chain created `digital_thread_default` through a helper that withdraws
   everything; a baseline that creates it directly gets the image's default privileges instead,
   which hand `service_role` INSERT, UPDATE, DELETE and TRUNCATE on the default partition of the
   append-only audit table. The generator calls that helper beside the default partition's
   `CREATE` (`AROUND_PARTITION`).

7. **`BETWEEN` does not round-trip.** pg_dump expands `x BETWEEN a AND b` into
   `((x >= a) AND (x <= b))`, and re-parsing that flattens the pair into the enclosing `AND` — so
   the constraint comes back with a different expression tree and the two dumps differ over a
   CHECK that means the same thing. The generator restores the `BETWEEN` where the dump bracketed
   the pair as its own, which is exactly where it came from one.

8. **An ACL's ORDER is in the dump.** `auth_pre_request()` is PostgREST's `db-pre-request` hook and
   must stay executable by `anon` — the sweep in section 6 withdraws it, so it is re-granted after.
   Re-granting `anon` alone leaves it last in the ACL instead of first: the same three grants, a
   different order, and a different digest. All three are withdrawn and re-granted together.

## Adding schema changes from here

Add a new numbered migration alongside the baseline, numbered above the archive's highest: the
first after 1.0 is `0163_...`. Do not edit `0001`/`0002` to change an existing deployment — they
are guarded to be no-ops once applied, so an edit reaches a fresh database only.

One ordering dependency is worth knowing about: `0001` ends with a reconciliation that forwards any
device still bound to an archived schema version onto the active one. A later migration that
re-pins a schema binding must either resolve the active version itself or re-run that
reconciliation after itself.

## What an upgrade needs that a dump does not contain

A dump describes a database as it is, so everything in it is a `CREATE`. Replay that against a
database that already exists and every `IF NOT EXISTS` is satisfied by something OLDER, silently.
**Both earlier squashes shipped with that hole** — an upgrade through them stops at the first
object naming something the old database never got, and there was no rehearsal to find out.

There is one now: build a database from the chain at `223b49d^`, apply the fold to it, and compare
it against a fresh install of the fold. It takes five faults to converge, each found by the run
before it, and all five are the same shape — a `CREATE` that a dump cannot express as a change:

| What is missing | How it shows | What the generator emits |
|---|---|---|
| A column added since | `column "forge_head_sha" ... does not exist`, raised by the first object naming it | `ADD COLUMN IF NOT EXISTS`, per table |
| An inline table constraint | `constraint "devices_online_implies_born" ... does not exist`, raised by its `COMMENT` | a guarded `ADD CONSTRAINT`, per constraint |
| A column DEFAULT that moved | nothing — `gateways.sparkplug_group` keeps a literal where the fold has a function call | `ALTER COLUMN ... SET DEFAULT`, per column |
| A constraint DEFINITION that changed | nothing — `gateways_location_scope_valid` admits two values where the fold admits three | compare `pg_get_constraintdef`, drop only on disagreement |
| A stale function overload | nothing — `CREATE OR REPLACE` matches on the argument list, so the old arity survives beside the new one and a caller passing it still reaches the old body | a sweep over `pg_proc`, narrowed to the names this file declares |

Three of the five fail silently, which is the argument for the rehearsal rather than for reading
the diff and reasoning about it.

**Column order survives, which is not obvious.** A column added by `ALTER` lands at the end of the
table, so an upgraded database should differ from a fresh one in the order a dump prints. It does
not, because the baseline's own order is the order the incremental chain produced — those columns
were appended by `ALTER` the first time too. The rehearsal asserts the whole dump, so this is
checked rather than assumed, and it would stop holding for a database whose columns are not a
prefix of the end state.

**One limit is real.** `NOT NULL` with no default cannot be added to a populated table: the
migration that first added such a column backfilled it, and no rule here can reconstruct the
backfill. The generator counts them on stderr; the rehearsal says whether any database in scope
actually lacks one. For the floor, none does.

`0000` handles the other direction — it removes what the baseline stopped describing, and converts
what a description cannot express.
