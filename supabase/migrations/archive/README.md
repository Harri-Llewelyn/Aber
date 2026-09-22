# Archived migrations

The 169 files here are the incremental migrations that built this schema, kept after being
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

## The three squashes

| When | Files folded | Left applied | Postgres |
|---|---|---|---|
| Public beta | 38, `20260101000000_init_assets_and_digital_thread` … `20260101000037_schema_versioning` | `0001`, `0002` | 15.6.1.143 |
| 2026-09-03, `223b49d` | 61, `0003` … `0078` | `0001`, `0002` and a tail of nine | 15.6.1.143 |
| This one | 70, `0004` … `0134` | `0000`, `0001`, `0002` | 17.6.1.160 |

Numbers are not unique across squashes: `0074` names two different migrations, one archived by
the second squash and one by the third, because the chain reused the number after the first was
archived. Cite by filename, not by number alone.

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

1. Build a database from the chain being replaced and dump it:

       pg_dump -U postgres -d postgres --schema-only --schema=public --schema=timescale

   Against a probe with the same preconditions the real one has — GoTrue's `auth` schema present
   and `search_path` set to `auth, public, extensions`. `scripts/verify-schema-equivalence.mjs`
   documents both and why each is load-bearing.

2. `node scripts/generate-baseline-section.mjs <dump.sql> > section4.sql`

3. Assemble: the hand-written head (sections 1–3: extensions, roles, default privileges), the
   generated section 4, then the hand-written tail (sections 5–7: the Realtime publication, the
   privileges withdrawn, the structural self-checks).

4. Check it: `node scripts/verify-schema-equivalence.mjs <new chain dir> <old chain dir>`. It
   builds both databases and compares a dump of each, plus the seeded rows table by table. The
   oracle for the third squash was schema digest `1977c6291706`.

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
   append-only audit table. Section 4b calls that helper.

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

Add a new numbered migration (`0003_...`) alongside the baseline. Do not edit `0001`/`0002` to
change an existing deployment — they are guarded to be no-ops once applied, so an edit reaches a
fresh database only.

`0000` is not a precedent for a second pre-baseline file. It exists because one subtraction in it
has to happen before the schema is described, and it is meant to be folded away by the next squash
like any other tail.

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
