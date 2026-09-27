-- =============================================================================================
-- Migration: 0134_cold_storage_is_configured_from_the_page.sql
-- The cold archive's destination is a setting an Administrator can see and change, and its
-- credential lives in the vault
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS CHANGES, AND WHY THE PREVIOUS ANSWER WAS WRONG
--
-- `0132` put the whole destination in `values.yaml` because one of its six fields is a secret and
-- `system_settings` is readable by every signed-in user. That premise is true -- `authenticated`
-- holds SELECT and `system_settings_select_authenticated` is `USING (true)`, deliberately, so a
-- setting can shape what a page renders for every role -- but it only ever excluded the SECRET.
-- An endpoint, a region, a bucket and a path style are not credentials, and an access key *id* is
-- an identifier. One secret field decided the home of all six, and the result was a feature
-- configured by editing a values file and reporting nothing back. See issue #351.
--
-- The destination is now five settings an Administrator can read and edit, and the secret is in
-- the vault beside the three secrets that are already there (`0002` seeds `nodered_admin_token`
-- the same way). The chart values become a SEED rather than the source: an install that set them
-- keeps working, and from then on the page is the control.
--
-- ---------------------------------------------------------------------------------------------
-- A SETTING CAN NOW BE ADMINISTRATOR-ONLY
--
-- `sensitive` and one clause on the SELECT policy. Every existing row is unflagged, so nothing an
-- Operator can see today changes; a flagged row is invisible to everyone but an Administrator, and
-- invisible is the right word -- RLS filters rows rather than refusing the query, so the Settings
-- page renders what the caller may see and neither half needs to know about the other.
--
-- THE INGESTION PRINCIPAL IS NOT AN ADMINISTRATOR and must not be made one. It reads the
-- destination through `cold_archive_destination()`, which is SECURITY DEFINER and admits that one
-- principal -- the same shape `0133`'s backlog uses and for the same reason: the arithmetic is
-- shared, the audience is not.
--
-- ---------------------------------------------------------------------------------------------
-- CHANGING A DESTINATION THAT HAS ALREADY BEEN WRITTEN TO IS A MIGRATION, NOT A PREFERENCE
--
-- Re-point the bucket while `--drop` is on and the next run writes into an empty bucket while
-- still deleting originals; `cold_archive audit` then reports every earlier object missing, and
-- the objects it is looking for are the only copies. So a change is refused once the manifest
-- holds anything, with the procedure named. Setting it for the first time is not a change.
-- =============================================================================================

\if :{?archive_endpoint}        \else \set archive_endpoint        '' \endif
\if :{?archive_region}          \else \set archive_region          '' \endif
\if :{?archive_bucket}          \else \set archive_bucket          '' \endif
\if :{?archive_access_key_id}   \else \set archive_access_key_id   '' \endif
\if :{?archive_path_style}      \else \set archive_path_style      '' \endif
\if :{?archive_secret_access_key} \else \set archive_secret_access_key '' \endif

SELECT set_config('acs_cymru.archive_endpoint',      :'archive_endpoint',      false);
SELECT set_config('acs_cymru.archive_region',        :'archive_region',        false);
SELECT set_config('acs_cymru.archive_bucket',        :'archive_bucket',        false);
SELECT set_config('acs_cymru.archive_access_key_id', :'archive_access_key_id', false);
SELECT set_config('acs_cymru.archive_path_style',    :'archive_path_style',    false);
-- The secret travels the same way `0002` passes nodered_admin_token: a psql variable into a GUC,
-- read once by the block that puts it in the vault and never stored in a settings row.
SELECT set_config('acs_cymru.archive_secret',         :'archive_secret_access_key', false);

-- ---------------------------------------------------------------------------------------------
-- 1. A setting can be Administrator-only
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.system_settings
    ADD COLUMN IF NOT EXISTS sensitive boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.system_settings.sensitive IS
    'The row is readable by Administrators alone. For configuration that is not a secret but is '
    'not everyone''s business either -- where a site''s history is written, and under which '
    'identity. The secret itself is never here: it is in the vault.';

DROP POLICY IF EXISTS system_settings_select_authenticated ON public.system_settings;
CREATE POLICY system_settings_select_authenticated ON public.system_settings
    FOR SELECT TO authenticated
    USING (NOT sensitive OR public.has_role(ARRAY['Administrator']));

-- ---------------------------------------------------------------------------------------------
-- 2. The destination, seeded from the chart on the boot that first supplies it
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_seeded int := 0;
    spec     record;
BEGIN
    FOR spec IN
        SELECT * FROM (VALUES
            ('archive.endpoint', 'string',
             'S3 endpoint',
             'The full URL cold telemetry is written to, including the scheme -- AWS is '
             'https://s3.<region>.amazonaws.com, a MinIO is whatever it is reachable at. "S3" is '
             'a protocol here, not a vendor.',
             nullif(current_setting('acs_cymru.archive_endpoint', true), '')),
            ('archive.region', 'string',
             'S3 region',
             'The region the bucket lives in. Required even where the endpoint implies it, '
             'because the request is signed with it.',
             nullif(current_setting('acs_cymru.archive_region', true), '')),
            ('archive.bucket', 'string',
             'S3 bucket',
             'The bucket objects are written into. Every object is addressed under '
             'site=<site key>/ within it, which is what lets several sites share one bucket.',
             nullif(current_setting('acs_cymru.archive_bucket', true), '')),
            ('archive.access_key_id', 'string',
             'S3 access key ID',
             'The identity the exporter writes as. An identifier rather than a secret -- the '
             'secret half is held in the vault and is never shown here.',
             nullif(current_setting('acs_cymru.archive_access_key_id', true), ''))
        ) AS t(key, value_type, label, description, seeded)
    LOOP
        PERFORM public.seed_setting(
            spec.key,
            to_jsonb(coalesce(spec.seeded, '')),
            spec.value_type,
            'Cold Storage',
            spec.label,
            spec.description,
            'values.yaml coldArchive.s3'
        );

        -- Seeded on a LATER boot too, but only into an empty value: a chart that supplies a
        -- destination to a stack already carrying one must not silently overwrite what an
        -- Administrator set from the page. The page is the control once it has been used.
        IF spec.seeded IS NOT NULL THEN
            UPDATE public.system_settings
               SET value = to_jsonb(spec.seeded)
             WHERE key = spec.key
               AND coalesce(value #>> '{}', '') = '';
            v_seeded := v_seeded + 1;
        END IF;
    END LOOP;

    PERFORM public.seed_setting(
        'archive.path_style',
        to_jsonb(lower(coalesce(nullif(current_setting('acs_cymru.archive_path_style', true), ''), 'false')) IN ('1', 'true', 'yes', 'on')),
        'boolean',
        'Cold Storage',
        'Address the bucket by path',
        'On for MinIO and most self-hosted gateways; off for AWS, R2 and B2, which take the '
        'virtual-host form. Wrong, every upload fails as DNS resolution, which names nothing.',
        'values.yaml coldArchive.s3.pathStyle'
    );

    -- Administrator-only, all five. Not secret, and not everyone's business either.
    UPDATE public.system_settings
       SET sensitive = true
     WHERE key IN ('archive.endpoint', 'archive.region', 'archive.bucket',
                   'archive.access_key_id', 'archive.path_style')
       AND NOT sensitive;

    IF v_seeded > 0 THEN
        RAISE NOTICE '0134: seeded % destination field(s) from the chart.', v_seeded;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The credential goes in the vault, and comes back only to the exporter
-- ---------------------------------------------------------------------------------------------
-- `0002` seeds `nodered_admin_token` exactly this way. create on the first boot, update on every
-- one after, because db-init replays and create_secret would fail its UNIQUE on name.
DO $$
DECLARE
    v_secret text := nullif(current_setting('acs_cymru.archive_secret', true), '');
    v_id     uuid;
BEGIN
    IF v_secret IS NULL THEN
        RETURN;
    END IF;

    SELECT id INTO v_id FROM vault.secrets WHERE name = 'archive_secret_access_key';

    IF v_id IS NULL THEN
        PERFORM vault.create_secret(
            v_secret,
            'archive_secret_access_key',
            'The secret half of the cold archive''s S3 credential. Read by '
            'public.cold_archive_destination() for the ingestion principal alone; set from the '
            'Cold Storage page through public.set_archive_credential().'
        );
        RAISE NOTICE '0134: archive credential seeded into the vault from the chart.';
    END IF;
    -- NOT updated on a later boot, unlike nodered_admin_token: an Administrator may have set this
    -- from the page since, and the chart value is a seed rather than the source. A stack that
    -- wants the chart to win can clear the secret and re-apply.
END
$$;

CREATE OR REPLACE FUNCTION public.set_archive_credential(p_secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
    v_id uuid;
BEGIN
    -- ADMINISTRATOR ONLY, with the errcode `create_machine_principal()` uses: PostgREST maps it to
    -- 403, so the page can tell "you may not" from "that did not work".
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to set the cold archive credential'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_secret IS NULL OR length(trim(p_secret)) = 0 THEN
        RAISE EXCEPTION 'the cold archive credential cannot be empty; clear the destination instead';
    END IF;

    SELECT id INTO v_id FROM vault.secrets WHERE name = 'archive_secret_access_key';

    IF v_id IS NULL THEN
        PERFORM vault.create_secret(trim(p_secret), 'archive_secret_access_key',
                                    'The secret half of the cold archive''s S3 credential.');
    ELSE
        PERFORM vault.update_secret(v_id, trim(p_secret));
    END IF;
END;
$$;

COMMENT ON FUNCTION public.set_archive_credential(text) IS
    'Write the cold archive''s S3 secret key into the vault. Administrator only. WRITE-ONLY BY '
    'CONSTRUCTION: nothing reads it back to a browser, so the page can report that a credential '
    'is set and never what it is.';

REVOKE ALL ON FUNCTION public.set_archive_credential(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_archive_credential(text) TO authenticated, service_role;

-- Whether one is set, which is all a page ever needs to know about it.
CREATE OR REPLACE FUNCTION public.archive_credential_is_set()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
    SELECT public.has_role(ARRAY['Administrator'])
       AND EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'archive_secret_access_key');
$$;

COMMENT ON FUNCTION public.archive_credential_is_set() IS
    'True when a cold archive credential is in the vault AND the caller may be told. False for '
    'everyone else, which reads as "not configured" -- correct for a page they cannot configure.';

REVOKE ALL ON FUNCTION public.archive_credential_is_set() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_credential_is_set() TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. What the exporter reads
-- ---------------------------------------------------------------------------------------------
-- THE ONE PLACE THE SECRET LEAVES THE VAULT, and it leaves it to the ingestion principal alone.
-- Not to an Administrator: a page never needs the secret back, and a function that would return it
-- is a function somebody can be persuaded to call.
-- DROPPED FIRST because the row type is defined by OUT parameters, and CREATE OR REPLACE cannot
-- change one -- `0080` records the same constraint, where a changed return type forced a rename.
-- This function is new here and has never been released, so a drop costs nothing on a fresh chain;
-- what it buys is a replay over a database carrying an EARLIER BUILD of this same migration, which
-- is every development cluster this branch has been deployed to. Without it, db-init aborts with
-- "cannot change return type of existing function" and every file after this one is skipped.
DROP FUNCTION IF EXISTS public.cold_archive_destination();

CREATE OR REPLACE FUNCTION public.cold_archive_destination()
RETURNS TABLE (
    endpoint      text,
    region        text,
    bucket        text,
    access_key_id text,
    secret_key    text,
    path_style    boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
    SELECT
        coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'archive.endpoint'), ''),
        coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'archive.region'), ''),
        coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'archive.bucket'), ''),
        coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'archive.access_key_id'), ''),
        coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'archive_secret_access_key'), ''),
        coalesce((SELECT (value #>> '{}')::boolean FROM public.system_settings WHERE key = 'archive.path_style'), false)
    -- `archive.site_key` is deliberately NOT here. It is not sensitive, the exporter already reads
    -- it with the other archive.* settings, and a fact returned from two places is a fact that
    -- will eventually differ between them.
    WHERE public.is_ingestion_caller();
$$;

COMMENT ON FUNCTION public.cold_archive_destination() IS
    'The cold archive''s destination including its secret, for the ingestion principal alone '
    '(0046). Returns no row to anybody else, so a caller without that identity learns nothing '
    'rather than being refused with a message that confirms the shape of what it holds.';

REVOKE ALL ON FUNCTION public.cold_archive_destination() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cold_archive_destination() TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Re-pointing a destination that has been written to is refused
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_destination_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_written bigint;
BEGIN
    IF NEW.key NOT IN ('archive.endpoint', 'archive.bucket')
       OR NEW.value IS NOT DISTINCT FROM OLD.value
       -- Setting one for the first time is not a change.
       OR coalesce(OLD.value #>> '{}', '') = '' THEN
        RETURN NEW;
    END IF;

    BEGIN
        SELECT count(*) INTO v_written FROM timescale.telemetry_archive_manifest;
    EXCEPTION WHEN OTHERS THEN
        -- The historian is unreachable, so whether anything has been written cannot be known.
        -- ALLOWED, with a warning, rather than refused: refusing would make an unrelated outage
        -- block first-time configuration, and the destructive case this guards is a deliberate
        -- act by somebody who can read the warning.
        RAISE WARNING
            'the cold archive manifest could not be read, so % is being changed without checking '
            'whether objects have already been written under the old destination.', NEW.key;
        RETURN NEW;
    END;

    IF v_written > 0 THEN
        RAISE EXCEPTION
            '% cannot be changed: % object(s) are already catalogued under the current '
            'destination, and renaming it does not move them -- the manifest would point at a '
            'bucket nothing is in, while cold_archive --drop kept deleting the only other copy. '
            'Follow the destination change procedure in supabase/README.md.',
            NEW.key, v_written;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.archive_destination_guard() IS
    'Refuses a change to the archive endpoint or bucket once anything has been written there. A '
    'trigger rather than a policy because RLS cannot see OLD and NEW at once, the same reason '
    'system_settings_read_only_guard() is one.';

REVOKE ALL ON FUNCTION public.archive_destination_guard() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS archive_destination_guard_trg ON public.system_settings;
CREATE TRIGGER archive_destination_guard_trg
    BEFORE UPDATE ON public.system_settings
    FOR EACH ROW EXECUTE FUNCTION public.archive_destination_guard();

-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_missing text;
    v_policy  text;
BEGIN
    SELECT string_agg(k, ', ' ORDER BY k) INTO v_missing
      FROM unnest(ARRAY['archive.endpoint', 'archive.region', 'archive.bucket',
                        'archive.access_key_id', 'archive.path_style']) AS k
     WHERE NOT EXISTS (
        SELECT 1 FROM public.system_settings s WHERE s.key = k AND s.sensitive
     );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            '0134 self-check: [%] are not present and flagged sensitive. A destination field that '
            'is readable by every signed-in user is the thing this migration exists to stop.',
            v_missing;
    END IF;

    -- The policy must actually carry the clause. A column nothing reads is not a control.
    SELECT pg_get_expr(polqual, polrelid) INTO v_policy
      FROM pg_policy
     WHERE polrelid = 'public.system_settings'::regclass
       AND polname = 'system_settings_select_authenticated';

    IF v_policy IS NULL OR position('sensitive' in v_policy) = 0 THEN
        RAISE EXCEPTION
            '0134 self-check: the system_settings SELECT policy does not mention `sensitive` '
            '(it is: %). Every flagged row would be world-readable to signed-in users.',
            coalesce(v_policy, 'absent');
    END IF;

    RAISE NOTICE '0134: the cold archive destination is configurable from the page.';
END
$$;
