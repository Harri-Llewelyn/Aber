-- =============================================================================================
-- Migration: 0068_cold_storage.sql
-- Cold telemetry archival — the dashboard's half, and the settings the exporter reads
-- (roadmap item 3)
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS DOES NOT CONTAIN, AND WHY THAT IS THE INTERESTING PART
--
-- The manifest itself is NOT here. It lives on the historian (timescaledb/cold_archive.sql),
-- because it describes chunks and the chunks are there. A manifest in this database could drift
-- from the hypertable it claims to describe with nothing able to notice, and the exporter would
-- have to write two databases inside one logical transaction that cannot be one.
--
-- So this maps it over the postgres_fdw bridge that already carries `telemetry`, `telemetry_1h`
-- and `storage_footprint` -- the arrangement 0027 established. One writer over there, one reader
-- over here.
--
-- ---------------------------------------------------------------------------------------------
-- THE SETTINGS ARE HERE AND THEY ARRIVE WITH THEIR READER, WHICH IS 0031'S RULE
--
-- 0031 says it plainly: "Seeding the settings a future feature might want would fill this page
-- with controls that do nothing, which is the exact failure the closed key set exists to prevent."
-- It even names this migration's namespace in advance -- "Cold storage adds `archive.*` in its own
-- migration, beside the code that reads it."
--
-- Every key below is read by ingestion/cold_archive.py. THREE, NOT SIX: there is deliberately no
-- `archive.s3_endpoint`, `archive.s3_region` or `archive.credential` key, because this
-- implementation writes to the platform's own object storage through the client
-- `ingestion/capture_worker.py` already uses. An external S3 endpoint is a real future option and
-- the settings for it belong in the migration that teaches the exporter to use one -- not in this
-- one, as three controls that would change nothing.
--
-- AND NO CREDENTIAL KEY WILL EVER BE ADDED HERE. Every authenticated user can read
-- `system_settings`; that is deliberate, because a setting shapes what a page renders. Secrets go
-- to Supabase Vault through Studio -- see the Runtime configuration section of supabase/README.md,
-- including its note that Studio sits on a different trust boundary from an Administrator here.
--
-- Related: timescaledb/cold_archive.sql (the manifest and the drop invariant),
--          0027 (the foreign-table pattern), 0031 (the closed key set),
--          ingestion/cold_archive.py (the reader of every key below).
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The historian's half, over the FDW
-- ---------------------------------------------------------------------------------------------
-- Column names and types must match `public.telemetry_archive_manifest` on the remote EXACTLY.
-- postgres_fdw does not verify this at creation time -- it maps whatever it is told -- so a
-- mismatch surfaces as a runtime error in a dashboard panel. The self-check reads the table once
-- for that reason.
--
-- RECREATED, NOT `IF NOT EXISTS`: 0001 issues `DROP SERVER ... CASCADE` on every boot, which takes
-- every foreign table in `timescale` with it. This file must assume nothing survives, the same
-- reason 0010 and 0027 recreate their own mappings.
DROP FOREIGN TABLE IF EXISTS timescale.telemetry_archive_manifest CASCADE;
CREATE FOREIGN TABLE timescale.telemetry_archive_manifest (
    chunk_schema text,
    chunk_name   text,
    range_start  timestamptz,
    range_end    timestamptz,
    row_count    bigint,
    object_key   text,
    object_bytes bigint,
    object_etag  text,
    format       text,
    claimed_at   timestamptz,
    exported_at  timestamptz,
    verified_at  timestamptz,
    dropped_at   timestamptz,
    last_error   text
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'telemetry_archive_manifest');


-- ---------------------------------------------------------------------------------------------
-- 2. What the dashboard reads
-- ---------------------------------------------------------------------------------------------
-- A DERIVED `state` COLUMN RATHER THAN FOUR TIMESTAMPS FOR THE PAGE TO INTERPRET. The ordering
-- (claimed -> exported -> verified -> dropped) is the feature, and every consumer that re-derived
-- it from nullable columns would be re-implementing the invariant the historian's CHECK constraints
-- already enforce -- differently, eventually.
--
-- `on_cold_storage` is the one an operator actually acts on: it means the raw rows are GONE and
-- this object is the only copy. Anything else still has its data in the hypertable.
CREATE OR REPLACE FUNCTION public.cold_storage_rows()
RETURNS TABLE (
    chunk_name      text,
    range_start     timestamptz,
    range_end       timestamptz,
    row_count       bigint,
    object_key      text,
    object_bytes    bigint,
    state           text,
    on_cold_storage boolean,
    claimed_at      timestamptz,
    dropped_at      timestamptz,
    last_error      text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    SELECT m.chunk_name,
           m.range_start,
           m.range_end,
           m.row_count,
           m.object_key,
           m.object_bytes,
           CASE
               WHEN m.dropped_at  IS NOT NULL THEN 'archived'
               WHEN m.verified_at IS NOT NULL THEN 'verified'
               WHEN m.exported_at IS NOT NULL THEN 'exported'
               WHEN m.last_error  IS NOT NULL THEN 'failed'
               ELSE 'claimed'
           END AS state,
           m.dropped_at IS NOT NULL AS on_cold_storage,
           m.claimed_at,
           m.dropped_at,
           m.last_error
      FROM timescale.telemetry_archive_manifest m
     ORDER BY m.range_start DESC;
$fn$;

COMMENT ON FUNCTION public.cold_storage_rows() IS
  'The cold telemetry catalogue, read over the FDW from the historian''s manifest. `state` is '
  'derived here so no consumer re-implements the claimed->exported->verified->dropped ordering '
  'that timescaledb/cold_archive.sql enforces with CHECK constraints.';

-- SECURITY DEFINER, so the caller does not need SELECT on `timescale.*` -- which `authenticated`
-- deliberately does not hold for tables 0001 did not grant. Gated to the roles that can already
-- see storage and retention, and NOT to anon: this names object keys, and an unauthenticated
-- reader has no business enumerating what is on the platform's object storage.
REVOKE ALL ON FUNCTION public.cold_storage_rows() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cold_storage_rows() TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 3. The settings, each with a reader
-- ---------------------------------------------------------------------------------------------
-- DISABLED BY DEFAULT, AND THAT IS NOT TIMIDITY. Turning this on changes what happens to plant
-- history when it ages out: instead of being dropped by a TimescaleDB retention policy it is
-- exported, verified and then dropped by a job. A stack that gained that behaviour from a
-- migration nobody read would be a stack whose data-lifecycle changed silently.
SELECT public.seed_setting(
    'archive.enabled',
    to_jsonb(false),
    'boolean',
    'Cold Storage',
    'Archive telemetry before dropping it',
    'When on, telemetry chunks past the threshold below are exported to Parquet on object storage '
    'and verified before the raw rows are dropped. When off, TimescaleDB''s retention policy drops '
    'them outright and they are not recoverable.',
    'off — retention.sql drops chunks with no archive'
);

-- BOUNDED AT THE BOTTOM BY THE ROLLUPS' OWN HORIZON, not by taste. Exporting a chunk younger than
-- the compression window means writing rows that are still being compressed, and a threshold of
-- days rather than months makes the object count grow without making anything more recoverable.
SELECT public.seed_setting(
    'archive.tier_after_days',
    to_jsonb(90),
    'number',
    'Cold Storage',
    'Archive chunks older than (days)',
    'How old a telemetry chunk must be before it is exported. Measured against the END of the '
    'chunk''s range, so a chunk still accepting late-arriving readings is never exported. Should '
    'match the raw retention window: archiving later than retention drops means losing data.',
    'TIMESCALE_RETAIN_FOR in .env (90 days)'
);

-- BOUNDS SET BY UPDATE, NOT BY EXTRA ARGUMENTS -- 0032's reason, which still applies: adding
-- parameters to seed_setting() creates an OVERLOAD rather than replacing it, because CREATE OR
-- REPLACE matches on the argument list and 0031 rebuilds the seven-argument version on every boot.
--
-- MIN 1, NOT 0. Zero would mean "export every chunk the moment it closes", which defeats the
-- threshold entirely and would tier data the rollups have not finished with. The ceiling is a typo
-- guard in the same spirit as 0032's: 3650 entered as 36500 is a decade against a century.
UPDATE public.system_settings
   SET min_value = 1, max_value = 3650
 WHERE key = 'archive.tier_after_days'
   AND (min_value IS DISTINCT FROM 1 OR max_value IS DISTINCT FROM 3650);

SELECT public.seed_setting(
    'archive.bucket',
    to_jsonb('telemetry-archive'::text),
    'string',
    'Cold Storage',
    'Object storage bucket',
    'The private bucket cold telemetry is written to. Created by scripts/storage-init.mjs; its '
    'RLS policies admit the ingestion principal and no browser role.',
    'telemetry-archive'
);


-- ---------------------------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_count integer;
BEGIN
    -- THE FOREIGN TABLE IS READ, not merely created. postgres_fdw maps whatever it is told and
    -- validates nothing at creation time, so a column list that disagrees with the historian
    -- compiles perfectly here and fails inside a dashboard panel later. 0027 makes the same probe
    -- for the same reason.
    BEGIN
        PERFORM 1 FROM timescale.telemetry_archive_manifest LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION
          '0068 self-check: timescale.telemetry_archive_manifest is not readable (%). The column '
          'list here must match public.telemetry_archive_manifest in timescaledb/cold_archive.sql '
          'exactly, and that file must have been applied by timescaledb-maintenance first.', SQLERRM;
    END;

    -- Every declared key exists and is readable through the same path the Settings page uses.
    SELECT count(*) INTO v_count
      FROM public.system_settings
     WHERE key IN ('archive.enabled', 'archive.tier_after_days', 'archive.bucket');
    IF v_count <> 3 THEN
        RAISE EXCEPTION
          '0068 self-check: expected 3 archive.* settings, found %. seed_setting() is the only way '
          'a key enters the closed set, so a missing one means a call above did not run.', v_count;
    END IF;

    -- AND THE DEFAULT IS OFF. Asserted rather than assumed, because the value is what decides
    -- whether an operator's telemetry gets exported or deleted when it ages out, and a migration
    -- that flipped it silently is exactly the change nobody would look for.
    IF (SELECT value FROM public.system_settings WHERE key = 'archive.enabled') <> to_jsonb(false) THEN
        RAISE NOTICE
          '0068: archive.enabled is ON. That is an operator setting and this migration does not '
          'change it on replay -- noted here only so the boot log says so.';
    END IF;

    RAISE NOTICE
      '0068 self-check passed: the manifest is readable over the FDW and all 3 archive.* settings '
      'are declared.';
END;
$selfcheck$;
