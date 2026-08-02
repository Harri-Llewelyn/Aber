# Archived incremental migrations (pre-beta)

The 38 files in this directory are the original incremental migrations,
`20260101000000_init_assets_and_digital_thread.sql` through
`20260101000037_schema_versioning.sql`. They were squashed for the public beta into
`../0001_baseline_schema.sql` (structure) and `../0002_seed_data.sql` (data).

**They are no longer applied.** `supabase-db-init` and the CI workflow both glob
`supabase/migrations/*.sql`, which does not recurse, so nothing here runs.

## Why they are kept rather than deleted

They are the reasoning. The baseline files show *what* the schema is; these show *why* it is that
way — why `metric_catalog.name` is immutable, why gateway staleness is a view rather than a cron
writer, why the Realtime tenant must be addressed as `realtime-dev.supabase-realtime`, why the
metric-group separator is `/` and not `.`. Several of those decisions are cited by migration number
in `CLAUDE.md`, and re-deriving them from a squashed dump would not be possible.

Treat this directory as documentation with a `.sql` extension.

## Reproducing the squash

The baseline was not transcribed by hand. It was produced by replaying this chain onto a virgin
`supabase/postgres:15.6.1.143`, taking `pg_dump --schema-only --schema=public` as the completeness
oracle, subtracting everything a *virgin* image already contains, and rewriting the remainder into
idempotent form. Equivalence was then checked by diffing a database built from this chain against
one built from the baseline — statement sets, per-table content hashes, and the `anon`/
`authenticated` privilege set all had to match.

Three things that verification caught, none of which would have been obvious by inspection:

1. **`SET check_function_bodies = false` is required.** PL/pgSQL resolves `%ROWTYPE` in a
   function's DECLARE block at CREATE time, so `fork_schema()` cannot be created before
   `public.schemas` exists, and no single object order satisfies every such dependency.
2. **pg_dump records only positive grants.** The Supabase image ships
   `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`, and the REVOKEs
   scattered through this chain leave no trace in a dump — so a naive baseline silently handed
   `anon` full access to every table. The baseline resets privileges explicitly before re-granting.
3. **Constraints must be guarded, not dropped and re-added.**
   `DROP CONSTRAINT IF EXISTS cells_pkey` fails on a populated database because foreign keys
   depend on it, which would have broken the second boot rather than the first.

## Adding schema changes from here

Add a new numbered migration (`0003_...`) alongside the baseline. Do not edit `0001`/`0002` to
change an existing deployment — they are guarded to be no-ops once applied, so an edit reaches a
fresh database only.

One ordering dependency is worth knowing about: `0001` ends with a reconciliation that forwards any
device still bound to an archived schema version onto the active one. A later migration that
re-pins a schema binding must either resolve the active version itself or re-run that
reconciliation after itself.
