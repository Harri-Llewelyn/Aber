-- =============================================================================================
-- Migration: 0018_every_backup_has_an_encrypted_copy_off_site.sql
-- The backup service copies every backup, encrypted, to an S3 endpoint set on the Backups page
-- =============================================================================================
--
-- Every backup sat on the backup volume, usually on the disk that holds both databases, so the
-- failures a backup exists for (a lost disk, node or site) took the backups too. The service now
-- uploads each backup's directory, every file encrypted with age to a recipient whose identity
-- the operator keeps outside the stack, and records the copy's state on the row:
--
--   1. The copy's state per backup, on public.backups.
--   2. The destination: seven Administrator-only settings, checked on write.
--   3. The secret key, in the vault through a write-only RPC.
--   4. The service's gates: the destination, the next backup to copy, the result.
--   5. backup_prunable() hands the prune each row's copy, so the remote copies follow the floor.
--   6. backup_offsite_health, for the Off-site Backup Stale rule.
--
-- Reasoning: supabase/README.md, "An encrypted copy off site (0018)". Idempotent.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The copy's state per backup
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.backups
    ADD COLUMN IF NOT EXISTS offsite_state text DEFAULT 'PENDING' NOT NULL,
    ADD COLUMN IF NOT EXISTS offsite_location text,
    ADD COLUMN IF NOT EXISTS offsite_objects jsonb,
    ADD COLUMN IF NOT EXISTS offsite_copied_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS offsite_attempted_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS offsite_attempts integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS offsite_error text;

DO $c$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'backups_offsite_state_valid'
                      AND conrelid = 'public.backups'::regclass) THEN
        ALTER TABLE public.backups
            ADD CONSTRAINT backups_offsite_state_valid
            CHECK (offsite_state = ANY (ARRAY['PENDING'::text, 'COPIED'::text, 'FAILED'::text]));
    END IF;
END $c$;

COMMENT ON TABLE public.backups IS
  'One row per backup that EXISTS on the backup volume; the row is deleted when the service prunes '
  'the files, and BACKUP_PRUNED in digital_thread is the record that it did. Written only by '
  'backup_finalise() and backup_offsite_record(), and released only by release_backup(). Readable '
  'by Administrator only. No byte reaches a browser; the off-site copy is encrypted before it '
  'leaves the service.';

COMMENT ON COLUMN public.backups.offsite_state IS
  'The off-site copy. PENDING: none yet. COPIED: every file uploaded, encrypted, and checked by a '
  'HEAD against its SHA-256. FAILED: the last attempt failed, offsite_error says why, and the '
  'service tries again after a backoff. Written only by backup_offsite_record().';
COMMENT ON COLUMN public.backups.offsite_location IS
  'Where the copy is: <endpoint>/<bucket>/<prefix>/<stamp>/, one <file>.age object per file.';
COMMENT ON COLUMN public.backups.offsite_objects IS
  'The uploaded objects: an array of {file, key, size_bytes, sha256}, the digest of the ciphertext.';
COMMENT ON COLUMN public.backups.offsite_attempts IS
  'Failed attempts since the last success; the backoff before the next one grows with it.';

-- ---------------------------------------------------------------------------------------------
-- 2. The destination
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
    spec record;
BEGIN
    FOR spec IN
        SELECT * FROM (VALUES
            ('backup_offsite.endpoint', 'string', 'S3 endpoint',
             'The full URL every backup is copied to, scheme included: '
             'https://s3.<region>.amazonaws.com on AWS, or wherever a MinIO answers. Empty: no '
             'off-site copy, and every backup shares a disk with the databases.'),
            ('backup_offsite.region', 'string', 'S3 region',
             'The region the bucket is in. The request is signed with it.'),
            ('backup_offsite.bucket', 'string', 'S3 bucket',
             'The bucket the copies are written into. It must already exist.'),
            ('backup_offsite.prefix', 'string', 'Key prefix',
             'Each backup is written under <prefix>/<stamp>/. One prefix per site, and the one a '
             'bucket policy scopes this credential to.'),
            ('backup_offsite.access_key_id', 'string', 'S3 access key ID',
             'The identity the service writes as. The secret half is in the vault and is never '
             'shown.'),
            ('backup_offsite.recipient', 'string', 'Encryption recipient',
             'The age public key (age1...) every file is encrypted to before it leaves the pod; '
             'several, separated by spaces, each decrypt. Keep the matching identity outside this '
             'stack: a restore after losing the site starts without it.')
        ) AS t(key, value_type, label, description)
    LOOP
        PERFORM public.seed_setting(spec.key, to_jsonb(''::text), spec.value_type, 'Backups',
                                    spec.label, spec.description, NULL);
    END LOOP;

    PERFORM public.seed_setting(
        'backup_offsite.path_style', 'false'::jsonb, 'boolean', 'Backups',
        'Address the bucket by path',
        'On for MinIO and most self-hosted gateways; off for AWS, R2 and B2, which take the '
        'virtual-host form.',
        NULL
    );

    UPDATE public.system_settings
       SET sensitive = true
     WHERE starts_with(key, 'backup_offsite.')
       AND NOT sensitive;
END;
$$;

-- A value the service could not use is refused where it is typed, on the Settings page or through
-- set_backup_offsite_destination(). Empty is always allowed: it is "not set".
CREATE OR REPLACE FUNCTION public.backup_offsite_setting_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_value text := CASE WHEN jsonb_typeof(NEW.value) = 'string' THEN NEW.value #>> '{}' END;
    v_rule  text;
BEGIN
    IF NOT starts_with(NEW.key, 'backup_offsite.') OR NEW.value IS NOT DISTINCT FROM OLD.value
       OR coalesce(v_value, '') = '' THEN
        RETURN NEW;
    END IF;

    v_rule := CASE NEW.key
        WHEN 'backup_offsite.endpoint' THEN
            CASE WHEN v_value !~ '^https?://[^\s/?#]+(/[^\s?#]*)?$'
                 THEN 'must be a URL with its scheme, such as https://s3.eu-west-2.amazonaws.com' END
        WHEN 'backup_offsite.region' THEN
            CASE WHEN v_value !~ '^[A-Za-z0-9_-]{1,64}$'
                 THEN 'must be a region name, such as eu-west-2' END
        WHEN 'backup_offsite.bucket' THEN
            CASE WHEN v_value !~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
                 THEN 'must be an S3 bucket name: 3 to 63 lower-case letters, digits, dots and hyphens' END
        WHEN 'backup_offsite.prefix' THEN
            CASE WHEN length(v_value) > 200
                   OR v_value !~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$'
                 THEN 'must be segments of letters, digits, dots, hyphens and underscores separated by /, with no leading or trailing /' END
        WHEN 'backup_offsite.access_key_id' THEN
            CASE WHEN v_value !~ '^[A-Za-z0-9+/=._-]{1,128}$'
                 THEN 'must be an access key ID, with no spaces' END
        WHEN 'backup_offsite.recipient' THEN
            CASE WHEN btrim(v_value) !~ '^age1[ac-hj-np-z02-9]{58}([\s,]+age1[ac-hj-np-z02-9]{58})*$'
                 THEN 'must be one or more age public keys (age1 followed by 58 characters), separated by spaces' END
    END;

    IF v_rule IS NOT NULL THEN
        RAISE EXCEPTION '% %', NEW.key, v_rule USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.backup_offsite_setting_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS backup_offsite_setting_guard_trg ON public.system_settings;
CREATE TRIGGER backup_offsite_setting_guard_trg
    BEFORE UPDATE ON public.system_settings
    FOR EACH ROW EXECUTE FUNCTION public.backup_offsite_setting_guard();

-- The whole destination in one statement, so a refused field saves none of them. Administrator only.
CREATE OR REPLACE FUNCTION public.set_backup_offsite_destination(
    p_endpoint text, p_region text, p_bucket text, p_prefix text, p_access_key_id text,
    p_recipient text, p_path_style boolean
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'only an Administrator may set the off-site backup destination'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE public.system_settings s
       SET value = v.value
      FROM (VALUES
          ('backup_offsite.endpoint',      to_jsonb(btrim(coalesce(p_endpoint, '')))),
          ('backup_offsite.region',        to_jsonb(btrim(coalesce(p_region, '')))),
          ('backup_offsite.bucket',        to_jsonb(btrim(coalesce(p_bucket, '')))),
          ('backup_offsite.prefix',        to_jsonb(btrim(coalesce(p_prefix, '')))),
          ('backup_offsite.access_key_id', to_jsonb(btrim(coalesce(p_access_key_id, '')))),
          ('backup_offsite.recipient',     to_jsonb(btrim(coalesce(p_recipient, '')))),
          ('backup_offsite.path_style',    to_jsonb(coalesce(p_path_style, false)))
      ) AS v(key, value)
     WHERE s.key = v.key
       AND s.value IS DISTINCT FROM v.value;
END;
$$;

COMMENT ON FUNCTION public.set_backup_offsite_destination(text, text, text, text, text, text, boolean) IS
  'Set the six off-site destination settings and the path-style switch in one statement, each '
  'checked by backup_offsite_setting_guard(). Administrator only. The secret key is '
  'set_backup_offsite_credential()''s.';

REVOKE ALL ON FUNCTION public.set_backup_offsite_destination(text, text, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_backup_offsite_destination(text, text, text, text, text, text, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. The secret key, in the vault
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_backup_offsite_credential(p_secret text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_id uuid;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'only an Administrator may set the off-site backup credential'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_secret IS NULL OR length(btrim(p_secret)) = 0 THEN
        RAISE EXCEPTION 'the off-site backup credential cannot be empty; remove the destination instead'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT id INTO v_id FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key';
    IF v_id IS NULL THEN
        PERFORM vault.create_secret(btrim(p_secret), 'backup_offsite_secret_access_key',
                                    'The secret half of the off-site backup copy''s S3 credential.');
    ELSE
        PERFORM vault.update_secret(v_id, btrim(p_secret));
    END IF;
END;
$$;

COMMENT ON FUNCTION public.set_backup_offsite_credential(text) IS
  'Write the off-site backup copy''s S3 secret key into the vault. Administrator only, and '
  'write-only: nothing reads it back to a browser.';

REVOKE ALL ON FUNCTION public.set_backup_offsite_credential(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_backup_offsite_credential(text) TO authenticated, service_role;

-- plpgsql, so a call is never folded into a plan that skips the EXECUTE check.
CREATE OR REPLACE FUNCTION public.backup_offsite_credential_is_set() RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    RETURN public.has_role(ARRAY['Administrator'])
       AND EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key');
END;
$$;

COMMENT ON FUNCTION public.backup_offsite_credential_is_set() IS
  'True when the off-site backup credential is in the vault and the caller is an Administrator; '
  'false for everyone else.';

REVOKE ALL ON FUNCTION public.backup_offsite_credential_is_set() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backup_offsite_credential_is_set() TO authenticated, service_role;

-- Turning the copy off: every field emptied and the secret removed. Copies already made stay in
-- the bucket, and the prune can no longer reach them.
CREATE OR REPLACE FUNCTION public.clear_backup_offsite_destination() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'only an Administrator may remove the off-site backup destination'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.set_backup_offsite_destination('', '', '', '', '', '', false);
    DELETE FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key';
END;
$$;

COMMENT ON FUNCTION public.clear_backup_offsite_destination() IS
  'Empty the off-site destination and delete its secret key from the vault. Administrator only. '
  'Copies already made are left in the bucket.';

REVOKE ALL ON FUNCTION public.clear_backup_offsite_destination() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_backup_offsite_destination() TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. The service's gates
-- ---------------------------------------------------------------------------------------------
-- Where a copy goes, <endpoint>/<bucket>/<prefix>/, or NULL while any part of the destination,
-- the secret key included, is missing.
CREATE OR REPLACE FUNCTION public.backup_offsite_base() RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v jsonb := (SELECT jsonb_object_agg(key, value) FROM public.system_settings
                 WHERE starts_with(key, 'backup_offsite.'));
BEGIN
    IF coalesce(v ->> 'backup_offsite.endpoint', '') = ''
       OR coalesce(v ->> 'backup_offsite.region', '') = ''
       OR coalesce(v ->> 'backup_offsite.bucket', '') = ''
       OR coalesce(v ->> 'backup_offsite.prefix', '') = ''
       OR coalesce(v ->> 'backup_offsite.access_key_id', '') = ''
       OR coalesce(v ->> 'backup_offsite.recipient', '') = ''
       OR NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key') THEN
        RETURN NULL;
    END IF;
    RETURN rtrim(v ->> 'backup_offsite.endpoint', '/') || '/' || (v ->> 'backup_offsite.bucket') || '/'
        || (v ->> 'backup_offsite.prefix') || '/';
END;
$$;

COMMENT ON FUNCTION public.backup_offsite_base() IS
  'Where off-site copies go, <endpoint>/<bucket>/<prefix>/, or NULL while any of the six '
  'settings or the secret key is missing. Not callable through PostgREST.';

REVOKE ALL ON FUNCTION public.backup_offsite_base() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.backup_offsite_destination() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_base text;
    v      jsonb;
BEGIN
    PERFORM public.require_backup_service_caller('backup_offsite_destination');
    v_base := public.backup_offsite_base();
    IF v_base IS NULL THEN
        RETURN NULL;
    END IF;
    v := (SELECT jsonb_object_agg(key, value) FROM public.system_settings WHERE starts_with(key, 'backup_offsite.'));
    RETURN jsonb_build_object(
        'base',          v_base,
        'endpoint',      rtrim(v ->> 'backup_offsite.endpoint', '/'),
        'region',        v ->> 'backup_offsite.region',
        'bucket',        v ->> 'backup_offsite.bucket',
        'prefix',        v ->> 'backup_offsite.prefix',
        'access_key_id', v ->> 'backup_offsite.access_key_id',
        'secret_key',    (SELECT decrypted_secret FROM vault.decrypted_secrets
                           WHERE name = 'backup_offsite_secret_access_key'),
        'recipients',    to_jsonb(regexp_split_to_array(btrim(v ->> 'backup_offsite.recipient'), '[\s,]+')),
        'path_style',    coalesce((v ->> 'backup_offsite.path_style')::boolean, false)
    );
END;
$$;

COMMENT ON FUNCTION public.backup_offsite_destination() IS
  'The off-site destination with its secret key, for the backup service alone, or NULL while it '
  'is incomplete.';

REVOKE ALL ON FUNCTION public.backup_offsite_destination() FROM PUBLIC, anon, authenticated, service_role;

-- The next backup to copy: newest first, one without a copy at the current destination. A failed
-- one waits 1, 2, 4 and 8 minutes after each failure, then 15, so an unreachable endpoint is not
-- sent the same files every poll.
CREATE OR REPLACE FUNCTION public.backup_offsite_next() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_base text;
BEGIN
    PERFORM public.require_backup_service_caller('backup_offsite_next');
    v_base := public.backup_offsite_base();
    IF v_base IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN (
        SELECT jsonb_build_object('id', b.id, 'stamp', b.stamp, 'location', b.location)
          FROM public.backups b
         WHERE NOT (b.offsite_state = 'COPIED' AND starts_with(coalesce(b.offsite_location, ''), v_base))
           AND (b.offsite_state <> 'FAILED'
                OR b.offsite_attempted_at IS NULL
                OR b.offsite_attempted_at <= now()
                   - least(interval '1 minute' * power(2, least(greatest(b.offsite_attempts - 1, 0), 4)),
                           interval '15 minutes'))
         ORDER BY b.taken_at DESC, b.stamp DESC
         LIMIT 1
    );
END;
$$;

COMMENT ON FUNCTION public.backup_offsite_next() IS
  'The newest backup with no copy at the current off-site destination and no failure in its '
  'backoff, or NULL. The backup service''s poll, when it has no job to take.';

REVOKE ALL ON FUNCTION public.backup_offsite_next() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.backup_offsite_record(
    p_backup_id uuid, p_location text, p_objects jsonb, p_error text
) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    PERFORM public.require_backup_service_caller('backup_offsite_record');
    IF p_error IS NULL THEN
        UPDATE public.backups
           SET offsite_state = 'COPIED', offsite_location = p_location,
               offsite_objects = coalesce(p_objects, '[]'::jsonb),
               offsite_copied_at = now(), offsite_attempted_at = now(),
               offsite_attempts = 0, offsite_error = NULL
         WHERE id = p_backup_id;
    ELSE
        UPDATE public.backups
           SET offsite_state = 'FAILED', offsite_attempted_at = now(),
               offsite_attempts = offsite_attempts + 1,
               offsite_error = left(coalesce(nullif(btrim(p_error), ''), 'unspecified failure'), 2000)
         WHERE id = p_backup_id;
    END IF;
END;
$$;

COMMENT ON FUNCTION public.backup_offsite_record(uuid, text, jsonb, text) IS
  'Record an off-site copy: COPIED with where and what, or FAILED with why. The backup service''s '
  'gate.';

REVOKE ALL ON FUNCTION public.backup_offsite_record(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. The prune sees each backup's copy
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_prunable(p_retention_days integer) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_backup_service_caller('backup_prunable');

    -- Zero or less disables pruning, as BACKUP_RETENTION_DAYS=0 does in backup-databases.sh.
    IF coalesce(p_retention_days, 0) <= 0 THEN
        RETURN '[]'::jsonb;
    END IF;

    -- The floor: the newest three rows are never returned. Every row is a successful backup, so
    -- while backups are failing these are the last three good ones. The Backups page holds the
    -- same number (BACKUP_RETENTION_FLOOR), and check-docs-drift.mjs couples the two. The service
    -- deletes each returned row's off-site copy with its files, so the copies follow the floor too.
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', b.id, 'stamp', b.stamp, 'location', b.location,
                                            'offsite_location', b.offsite_location) ORDER BY b.taken_at)
          FROM public.backups b
         WHERE NOT b.pinned
           AND b.taken_at < now() - make_interval(days => p_retention_days)
           AND b.id NOT IN (
               SELECT n.id FROM public.backups n ORDER BY n.taken_at DESC, n.stamp DESC LIMIT 3
           )
    ), '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.backup_prunable(integer) IS
  'The backups the retention window has expired and nobody has pinned, oldest first, never any of '
  'the newest three, each with where its off-site copy is. The service deletes each one''s files '
  'and copy, then calls backup_forget().';

-- ---------------------------------------------------------------------------------------------
-- 6. What the Off-site Backup Stale rule reads
-- ---------------------------------------------------------------------------------------------
-- At most one row, and none while the destination is incomplete or no backup exists: how long the
-- newest backup has gone without a copy at the current destination, counted from when it was taken
-- or the destination last changed, whichever is later. Zero once it is copied. Owner-run, so
-- grafana_reader sees a number and none of the settings or rows behind it.
CREATE OR REPLACE FUNCTION public.backup_offsite_health_rows()
RETURNS TABLE(newest_stamp text, offsite_state text, age_seconds numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_base    text := public.backup_offsite_base();
    v_changed timestamptz;
BEGIN
    IF v_base IS NULL THEN
        RETURN;
    END IF;
    SELECT max(s.updated_at) INTO v_changed FROM public.system_settings s WHERE starts_with(s.key, 'backup_offsite.');
    RETURN QUERY
        SELECT b.stamp, b.offsite_state,
               CASE WHEN b.offsite_state = 'COPIED' AND starts_with(coalesce(b.offsite_location, ''), v_base)
                    THEN 0::numeric
                    ELSE EXTRACT(EPOCH FROM (now() - greatest(b.taken_at, v_changed)))::numeric
               END
          FROM public.backups b
         ORDER BY b.taken_at DESC, b.stamp DESC
         LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.backup_offsite_health_rows() IS
  'The row backup_offsite_health shows. SECURITY DEFINER so grafana_reader needs no privilege on '
  'backups, system_settings or the vault.';

REVOKE ALL ON FUNCTION public.backup_offsite_health_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backup_offsite_health_rows() TO service_role;

CREATE OR REPLACE VIEW public.backup_offsite_health AS
SELECT now() AS collected_at, r.newest_stamp, r.offsite_state, r.age_seconds
  FROM public.backup_offsite_health_rows() r;

ALTER VIEW public.backup_offsite_health OWNER TO postgres;

COMMENT ON VIEW public.backup_offsite_health IS
  'How long the newest backup has gone without an off-site copy at the current destination: '
  'age_seconds from when it was taken or the destination last changed, zero once copied. No row '
  'while the destination is incomplete or no backup exists. Read by the Grafana rule "Off-site '
  'Backup Stale" as grafana_reader.';

REVOKE ALL ON public.backup_offsite_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.backup_offsite_health TO service_role;

-- Guarded: the role exists only where BI_READER_PASSWORD is set.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.backup_offsite_health_rows() TO grafana_reader';
    EXECUTE 'GRANT SELECT ON public.backup_offsite_health TO grafana_reader';
  END IF;
END $grant$;

-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_missing text;
    v_fn      text;
BEGIN
    SELECT string_agg(k, ', ' ORDER BY k) INTO v_missing
      FROM unnest(ARRAY['backup_offsite.endpoint', 'backup_offsite.region', 'backup_offsite.bucket',
                        'backup_offsite.prefix', 'backup_offsite.access_key_id',
                        'backup_offsite.recipient', 'backup_offsite.path_style']) AS k
     WHERE NOT EXISTS (SELECT 1 FROM public.system_settings s WHERE s.key = k AND s.sensitive);
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION '0018: [%] are not present and flagged sensitive', v_missing;
    END IF;

    FOREACH v_fn IN ARRAY ARRAY['public.backup_offsite_base()', 'public.backup_offsite_destination()',
                                'public.backup_offsite_next()',
                                'public.backup_offsite_record(uuid, text, jsonb, text)'] LOOP
        IF has_function_privilege('anon', v_fn, 'EXECUTE')
           OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
           OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
            RAISE EXCEPTION '0018: % is executable by a PostgREST role', v_fn;
        END IF;
    END LOOP;

    IF has_table_privilege('anon', 'public.backup_offsite_health', 'SELECT')
       OR has_table_privilege('authenticated', 'public.backup_offsite_health', 'SELECT') THEN
        RAISE EXCEPTION '0018: backup_offsite_health is readable by anon or authenticated, past backups RLS';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader')
       AND NOT has_table_privilege('grafana_reader', 'public.backup_offsite_health', 'SELECT') THEN
        RAISE EXCEPTION '0018: grafana_reader cannot read backup_offsite_health, so the Off-site Backup Stale rule would sit in error';
    END IF;
END $check$;
