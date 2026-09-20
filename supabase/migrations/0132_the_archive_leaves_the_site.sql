-- =============================================================================================
-- Migration: 0132_the_archive_leaves_the_site.sql
-- Cold telemetry is written to a remote S3 endpoint, and the site names itself in every key
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS CHANGES
--
-- Cold telemetry went to the `telemetry-archive` bucket in Supabase Storage -- a PVC in this
-- cluster, usually on the node holding the database the rows were rescued from. `--drop` had
-- already removed the originals, so a site loss took the only remaining copy with it. The
-- destination is now an S3 endpoint the operator configures, and only an S3 endpoint.
--
-- `archive.bucket` is retired with the bucket it named. The destination is the chart's
-- `coldArchive.s3.*`, not a setting: the endpoint, the bucket and a foreign credential are install
-- configuration, and a bucket name editable in the browser would re-point the archive at
-- something nothing has verified.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE SITE KEY IS FROZEN, AND WHY IT IS THE LEFTMOST SEGMENT
--
-- Object keys are `site=<site_key>/dataset=telemetry/v=1/year=YYYY/month=MM/<from>-<to>.parquet`.
--
-- Chunk names are sequential per database, so two fresh installs both begin at `_hyper_1_1_chunk`.
-- A local PVC made that safe by accident; a remote bucket is exactly the thing two sites get
-- pointed at, and the upload upserts -- so without a site segment, site B silently overwrites
-- site A's object while site A's manifest still reads verified and its rows are already dropped.
--
-- `site=` is leftmost because an IAM policy scopes on a left-anchored prefix: anything to its left
-- makes a per-site credential impossible to write. That is also why the key is settled here rather
-- than on the first export -- the operator has to write the bucket policy before the first object,
-- not after it.
--
-- IMMUTABLE, because renaming a site must not move objects that have already been written. The
-- human-readable mapping belongs in the manifest and in `site.name`, which stays editable. This is
-- the identifier `site.name` cannot be: `site.name` is free text seeded empty (`0097`), and an
-- archive prefix cannot be blank, cannot change and cannot contain a separator.
-- =============================================================================================

-- psql leaves an unset variable as the literal `:'name'`, so every caller that does not pass one
-- gets no key at all -- which is the unconfigured state, not an error. `0131` uses this idiom.
\if :{?archive_site_key} \else \set archive_site_key '' \endif

-- Handed to SQL through a GUC because psql does NOT substitute :variables inside dollar-quoted
-- strings, and every block below is dollar-quoted.
SELECT set_config('acs_cymru.archive_site_key', :'archive_site_key', false);

-- ---------------------------------------------------------------------------------------------
-- 1. The site key, seeded once and then held
-- ---------------------------------------------------------------------------------------------
-- UNSET IS NOT A MISMATCH, and unlike `0131`'s group there is no default to fall back to. A stack
-- that never names a site key cannot archive remotely, and cold_archive.py refuses the run saying
-- so. That keeps the throwaway test database and the CI lanes unaffected, and it keeps the failure
-- at the exporter -- where an operator is already looking -- rather than in db-init.
DO $$
DECLARE
    v_key text := coalesce(nullif(current_setting('acs_cymru.archive_site_key', true), ''), '');
    v_stored text;
BEGIN
    IF v_key <> '' THEN
        -- The form is what an S3 prefix and an IAM policy can both carry. `=` is excluded as well
        -- as `/` because the segment is `site=<key>` -- a second `=` would split a Hive partition
        -- name that DuckDB, Spark and Arrow all parse positionally.
        IF v_key !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN
            RAISE EXCEPTION
                '0132: archive site key % must be lower-case letters, digits and hyphens, '
                'starting and ending alphanumeric. It is the leftmost segment of every object '
                'key and the prefix an IAM policy is scoped on.', quote_literal(v_key);
        END IF;
        IF length(v_key) < 3 OR length(v_key) > 48 THEN
            RAISE EXCEPTION
                '0132: archive site key % is % characters; it must be between 3 and 48.',
                quote_literal(v_key), length(v_key);
        END IF;
    END IF;

    SELECT value #>> '{}' INTO v_stored
      FROM public.system_settings
     WHERE key = 'archive.site_key';

    -- An empty stored value means the key was never settled, so adopting the chart's is the normal
    -- path: a stack installs, runs for a year on local retention, and turns remote archiving on
    -- later. Only two DIFFERENT non-empty values are a disagreement.
    IF coalesce(v_stored, '') <> '' AND v_key <> '' AND v_stored IS DISTINCT FROM v_key THEN
        RAISE EXCEPTION
            '0132: this site archives under key %, and the chart now says %. Objects already '
            'written live under the first prefix and renaming does not move them -- a new key '
            'orphans every archived chunk while the manifest still points at the old prefix. '
            'Restore coldArchive.s3.siteKey to %, or follow the site key procedure in '
            'supabase/README.md.',
            quote_literal(v_stored), quote_literal(v_key), quote_literal(v_stored);
    END IF;

    PERFORM public.seed_setting(
        'archive.site_key',
        to_jsonb(coalesce(nullif(v_stored, ''), v_key)),
        'string',
        'Cold Storage',
        'Archive site key',
        'This site''s identity in the object key of every archived chunk: '
        'site=<key>/dataset=telemetry/v=1/year=YYYY/month=MM/<from>-<to>.parquet. Fixed when the '
        'stack was installed -- it is the prefix the bucket''s IAM policy is scoped on, and '
        'changing it would orphan every object already written. Empty means remote archiving is '
        'not configured and nothing is exported.',
        'values.yaml coldArchive.s3.siteKey'
    );

    -- seed_setting() inserts on the first boot and refreshes only the metadata afterwards, so a
    -- key supplied on a LATER boot than the first has to be written here.
    --
    -- THE ROW IS ALREADY READ-ONLY BY THEN, and `0131`'s trigger refuses a value change while it
    -- is -- so the flag is lifted for the one statement that adopts the key and set again below.
    -- That is the whole of the exception, and it is safe for the reason the guard exists: nothing
    -- has been archived under a key that was never set, so there is nothing to orphan. A key that
    -- is already non-empty never reaches here; it raised above.
    IF v_key <> '' AND coalesce(v_stored, '') = '' THEN
        UPDATE public.system_settings
           SET read_only = false
         WHERE key = 'archive.site_key'
           AND read_only;

        UPDATE public.system_settings
           SET value = to_jsonb(v_key)
         WHERE key = 'archive.site_key'
           AND coalesce(value #>> '{}', '') = '';
    END IF;

    -- Frozen, whichever of the two paths set it.
    UPDATE public.system_settings
       SET read_only = true
     WHERE key = 'archive.site_key'
       AND NOT read_only;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The bucket setting goes with the bucket
-- ---------------------------------------------------------------------------------------------
-- `archive.bucket` named a Supabase Storage bucket that this migration's companion change removes
-- from scripts/storage-init.mjs along with its four policies. Leaving the row would offer an
-- operator a destination that no longer exists, editable in a page, above a table of objects
-- written somewhere else.
--
-- ONCE, NOT ON EVERY BOOT, and the guard is the whole point of this block rather than a bare
-- DELETE. 0134 gives this key a SECOND, unrelated meaning -- the S3 bucket, set from the page --
-- and every migration here is replayed by db-init on every start. Unconditional, this statement
-- therefore deleted the operator's S3 bucket on each `helm upgrade`, 0134 re-seeded it from the
-- chart's empty default, and the stack came back up with archiving switched on and nowhere to
-- write: a nightly CronJob refusing, telemetry silently accumulating past its threshold, and one
-- field to look at out of six to find out why. MEASURED, not theorised -- it happened on the dev
-- cluster during an unrelated frontend rebuild.
--
-- `sensitive` is 0134's column, so its absence is exactly "the new meaning does not exist here
-- yet", which is the only state in which the old row should be removed. Fresh install: the column
-- is absent when this runs, the DELETE finds nothing, 0134 then seeds the key. Upgrade from before
-- 0132: absent, the stale Storage bucket name is removed as intended. Every replay after that: the
-- column exists and this is a no-op.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'system_settings'
           AND column_name = 'sensitive'
    ) THEN
        DELETE FROM public.system_settings WHERE key = 'archive.bucket';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. What `archive.enabled` now means
-- ---------------------------------------------------------------------------------------------
-- The switch is unchanged; the sentence describing it named object storage in this cluster.
SELECT public.seed_setting(
    'archive.enabled',
    to_jsonb(false),
    'boolean',
    'Cold Storage',
    'Archive telemetry before dropping it',
    'When on, telemetry chunks past the threshold below are exported to Parquet on the configured '
    'S3 endpoint and verified there before the raw rows are dropped. When off, TimescaleDB''s '
    'retention policy drops them outright and they are not recoverable. Exporting also requires a '
    'site key and an endpoint in the chart: without them nothing is written and the exporter says '
    'so.',
    'off — retention.sql drops chunks with no archive'
);
