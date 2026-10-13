-- 0178: A foreign credential is written through one helper, and asked about through another.
--
-- A foreign credential is issued by a system this stack does not own, and an Administrator sets it
-- from the page that uses it (supabase/README.md, "Secrets live in Supabase Vault"). The cold
-- archive's S3 key and the off-site backup key each had a copy of the same writer and probe. Both
-- pairs are now thin callers of set_foreign_credential() and foreign_credential_is_set(), and keep
-- their names, signatures and grants. Neither helper is callable through PostgREST: a page reaches
-- a credential only through that credential's own writer, so no page can name a stack-internal
-- secret. The readers stay per consumer (cold_archive_destination(), backup_offsite_destination()).

-- The writer. Runs with its caller's rights, which are the definer's of the wrapper that calls it:
-- granted to nobody, so it cannot be reached directly, and a stray grant would still meet the
-- vault's own refusal.
CREATE OR REPLACE FUNCTION public.set_foreign_credential(p_name text, p_secret text, p_label text, p_description text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF coalesce(p_name, '') = '' THEN
    RAISE EXCEPTION 'set_foreign_credential: a vault name is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- insufficient_privilege, which PostgREST answers 403: the page can tell "you may not" from "that
  -- did not work".
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'only an Administrator may set %', p_label
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- An empty key cannot authenticate, and the probe would then report a configured stack.
  IF p_secret IS NULL OR btrim(p_secret) = '' THEN
    RAISE EXCEPTION '% cannot be empty', p_label
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Updated in place after the first write: the row keeps its id, and the consumer reads the new
  -- value the next time it asks.
  SELECT id INTO v_id FROM vault.secrets WHERE name = p_name;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(btrim(p_secret), p_name, p_description);
  ELSE
    PERFORM vault.update_secret(v_id, btrim(p_secret));
  END IF;
END
$$;

ALTER FUNCTION public.set_foreign_credential(text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_foreign_credential(text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.set_foreign_credential(text, text, text, text) IS
  'Write foreign credential p_name into the vault: created on the first write, updated in place '
  'after. Administrator only (insufficient_privilege, 403); an empty value is refused. Returns '
  'nothing, and nothing reads the value back to a browser. Callable only from a credential''s own '
  'SECURITY DEFINER writer; p_label names the credential in the errors.';

-- The probe: whether, never what. False for anybody but an Administrator, which reads as "not
-- configured" on a page they cannot configure.
CREATE OR REPLACE FUNCTION public.foreign_credential_is_set(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  RETURN public.has_role(ARRAY['Administrator'])
     AND EXISTS (SELECT 1 FROM vault.secrets WHERE name = p_name);
END
$$;

ALTER FUNCTION public.foreign_credential_is_set(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.foreign_credential_is_set(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.foreign_credential_is_set(text) IS
  'True when foreign credential p_name is in the vault and the caller is an Administrator; false '
  'for everyone else. Never the value. Callable only from a credential''s own probe.';

-- ---------------------------------------------------------------------------------------------
-- The cold archive's S3 key, set from the Cold Storage page and read by cold_archive_destination().
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_archive_credential(p_secret text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  PERFORM public.set_foreign_credential('archive_secret_access_key', p_secret,
    'the cold archive credential', 'The secret half of the cold archive''s S3 credential.');
END
$$;

COMMENT ON FUNCTION public.set_archive_credential(p_secret text) IS
  'Write the cold archive''s S3 secret key into the vault through set_foreign_credential(). '
  'Administrator only. WRITE-ONLY BY CONSTRUCTION: nothing reads it back to a browser, so the page '
  'can report that a credential is set and never what it is.';

CREATE OR REPLACE FUNCTION public.archive_credential_is_set() RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  RETURN public.foreign_credential_is_set('archive_secret_access_key');
END
$$;

COMMENT ON FUNCTION public.archive_credential_is_set() IS
  'True when a cold archive credential is in the vault AND the caller may be told. False for '
  'everyone else, which reads as "not configured" -- correct for a page they cannot configure.';

-- ---------------------------------------------------------------------------------------------
-- The off-site backup key, set from the Backups page and read by backup_offsite_destination().
-- clear_backup_offsite_destination() deletes it with the destination.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_backup_offsite_credential(p_secret text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  PERFORM public.set_foreign_credential('backup_offsite_secret_access_key', p_secret,
    'the off-site backup credential', 'The secret half of the off-site backup copy''s S3 credential.');
END
$$;

COMMENT ON FUNCTION public.set_backup_offsite_credential(p_secret text) IS
  'Write the off-site backup copy''s S3 secret key into the vault through set_foreign_credential(). '
  'Administrator only, and write-only: nothing reads it back to a browser.';

CREATE OR REPLACE FUNCTION public.backup_offsite_credential_is_set() RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  RETURN public.foreign_credential_is_set('backup_offsite_secret_access_key');
END
$$;

COMMENT ON FUNCTION public.backup_offsite_credential_is_set() IS
  'True when the off-site backup credential is in the vault and the caller is an Administrator; '
  'false for everyone else.';

-- What this file decides: the helpers answer no API role, and the four page functions still answer
-- authenticated.
DO $$
DECLARE
  v_wrong text;
BEGIN
  SELECT string_agg(format('%s for %s', f, r), ', ') INTO v_wrong
    FROM unnest(ARRAY['public.set_foreign_credential(text, text, text, text)',
                      'public.foreign_credential_is_set(text)']) AS f,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
   WHERE has_function_privilege(r, f, 'EXECUTE');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '0178: a foreign-credential helper is executable by an API role: %', v_wrong;
  END IF;

  SELECT string_agg(f, ', ') INTO v_wrong
    FROM unnest(ARRAY['public.set_archive_credential(text)', 'public.archive_credential_is_set()',
                      'public.set_backup_offsite_credential(text)',
                      'public.backup_offsite_credential_is_set()']) AS f
   WHERE NOT has_function_privilege('authenticated', f, 'EXECUTE');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '0178: authenticated can no longer execute %', v_wrong;
  END IF;
END
$$;
