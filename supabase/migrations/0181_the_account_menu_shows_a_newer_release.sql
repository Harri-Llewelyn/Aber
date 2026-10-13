-- 0181: The account menu shows a newer Aber release, when the opt-in release check finds one.
--
-- The release check (releaseCheck.enabled, off by default) asks GitHub once a day for the latest
-- Aber release and records the answer in the one row of release_check, through
-- record_release_check(). It calls as Service_ReleaseCheck, a machine principal of its own seeded
-- here, and the gate admits that principal alone: not service_role, as the ingestion and playback
-- gates admit their principals alone.
--
-- Reasoning: supabase/README.md, "The account menu shows a newer release (0181)". Idempotent.

-- ---------------------------------------------------------------------------------------------
-- 1. The principal
-- ---------------------------------------------------------------------------------------------
-- `...0004`, after Service_Playback. Minimal by construction: no email, no password, no identity,
-- so it cannot sign in. It holds no role and no permission: its one authority is the gate below,
-- which names it. `npm run setup` signs its key (secrets.releaseCheckKey).
INSERT INTO auth.users (id)
VALUES ('b0000000-0000-4000-8000-000000000004')
ON CONFLICT (id) DO NOTHING;

-- One arm, as is_ingestion_caller() and is_playback_caller() have: service_role may not use the
-- gate either, so "who may record a release check" stays a statement about one identity.
CREATE OR REPLACE FUNCTION public.is_release_check_caller()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
BEGIN
  RETURN COALESCE(auth.uid()::text = 'b0000000-0000-4000-8000-000000000004', false);
END
$$;

ALTER FUNCTION public.is_release_check_caller() OWNER TO postgres;

COMMENT ON FUNCTION public.is_release_check_caller() IS
  'True only for the Service_ReleaseCheck principal (0181). Guards record_release_check(). '
  'Deliberately distinct from is_ingestion_caller() and is_playback_caller(), and with no '
  'service_role arm: the release check''s key reaches this gate and nothing else.';

-- The grants is_playback_caller() has: a yes or no about the caller, for the two API roles that
-- can hold a principal's claim.
REVOKE ALL ON FUNCTION public.is_release_check_caller() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_release_check_caller() TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. The row
-- ---------------------------------------------------------------------------------------------
-- The last daily check's answer. A failed check keeps only its reason, so the menu, which shows a
-- newer release from a successful check under two days old, shows nothing.
CREATE TABLE IF NOT EXISTS public.release_check (
    id boolean DEFAULT true NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    running_version text NOT NULL,
    latest_version text,
    latest_url text,
    newer boolean,
    error text,
    CONSTRAINT release_check_pkey PRIMARY KEY (id),
    CONSTRAINT release_check_one_row CHECK (id)
);

ALTER TABLE public.release_check OWNER TO postgres;
ALTER TABLE public.release_check ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.release_check IS
  'The last answer of the opt-in daily release check (releaseCheck.enabled): the latest Aber '
  'release on GitHub against the release this stack runs. One row, written only through '
  'record_release_check(); no row on a stack where the check has never run (0181).';
COMMENT ON COLUMN public.release_check.running_version IS
  'The MAJOR.MINOR.PATCH of the chart''s appVersion the check compared against.';
COMMENT ON COLUMN public.release_check.latest_version IS
  'The MAJOR.MINOR.PATCH of the latest published release. NULL when the check failed.';
COMMENT ON COLUMN public.release_check.latest_url IS
  'That release''s notes on github.com. NULL when the check failed.';
COMMENT ON COLUMN public.release_check.newer IS
  'Whether the latest release is newer than running_version. NULL when the check failed.';
COMMENT ON COLUMN public.release_check.error IS
  'Why the check failed, for an operator; NULL when it succeeded. The account menu shows nothing '
  'for a failed check.';

-- Every signed-in user reads it, for the account menu; nothing but the gate writes it.
REVOKE ALL ON TABLE public.release_check FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.release_check TO authenticated;

SELECT public.replay_policy('public.release_check', 'release_check_select_authenticated', $ddl$
CREATE POLICY release_check_select_authenticated ON public.release_check FOR SELECT TO authenticated USING (true);
$ddl$);

-- ---------------------------------------------------------------------------------------------
-- 3. The gate
-- ---------------------------------------------------------------------------------------------
-- Service_ReleaseCheck only. Versions are MAJOR.MINOR.PATCH, the core frontend/src/utils/
-- releaseVersion.js and scripts/release-check.mjs compare, and `newer` must agree with them. The
-- link must be a release of this repository, since the menu opens it.
CREATE OR REPLACE FUNCTION public.record_release_check(
    p_running text,
    p_latest text DEFAULT NULL,
    p_url text DEFAULT NULL,
    p_newer boolean DEFAULT NULL,
    p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_core constant text := '^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$';
BEGIN
  -- 42501, the code a failed RLS check raises, as require_ingestion_caller() uses.
  IF NOT public.is_release_check_caller() THEN
    RAISE EXCEPTION 'record_release_check: only the release check''s principal may call this'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_running IS NULL OR p_running !~ v_core THEN
    RAISE EXCEPTION 'record_release_check: the running version % is not MAJOR.MINOR.PATCH', quote_nullable(p_running)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_error IS NULL THEN
    IF p_latest IS NULL OR p_latest !~ v_core THEN
      RAISE EXCEPTION 'record_release_check: the latest version % is not MAJOR.MINOR.PATCH', quote_nullable(p_latest)
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_url IS NULL OR p_url !~ '^https://github\.com/Harri-Llewelyn/Aber/releases/tag/[A-Za-z0-9._+-]{1,64}$' THEN
      RAISE EXCEPTION 'record_release_check: % is not a release of github.com/Harri-Llewelyn/Aber', quote_nullable(p_url)
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_newer IS DISTINCT FROM (string_to_array(p_latest, '.')::integer[] > string_to_array(p_running, '.')::integer[]) THEN
      RAISE EXCEPTION 'record_release_check: newer is %, and % against % says otherwise', quote_nullable(p_newer), p_latest, p_running
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  INSERT INTO public.release_check (id, checked_at, running_version, latest_version, latest_url, newer, error)
  VALUES (true, now(), p_running,
          CASE WHEN p_error IS NULL THEN p_latest END,
          CASE WHEN p_error IS NULL THEN p_url END,
          CASE WHEN p_error IS NULL THEN p_newer END,
          NULLIF(left(p_error, 500), ''))
  ON CONFLICT (id) DO UPDATE
     SET checked_at = excluded.checked_at,
         running_version = excluded.running_version,
         latest_version = excluded.latest_version,
         latest_url = excluded.latest_url,
         newer = excluded.newer,
         error = excluded.error;
END
$$;

ALTER FUNCTION public.record_release_check(text, text, text, boolean, text) OWNER TO postgres;

COMMENT ON FUNCTION public.record_release_check(text, text, text, boolean, text) IS
  'Record the daily release check''s answer in release_check''s one row: the latest release, its '
  'notes and whether it is newer than p_running, or with p_error, only why the check failed. '
  'Service_ReleaseCheck only (0181): the release-check CronJob calls it through the gateway with '
  'that principal''s key.';

-- authenticated because the principal is one; is_release_check_caller() is the gate. Not
-- service_role, whose key the release check does not hold.
REVOKE ALL ON FUNCTION public.record_release_check(text, text, text, boolean, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_release_check(text, text, text, boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn text := 'public.record_release_check(text, text, text, boolean, text)';
  v_role text;
BEGIN
  IF NOT public.is_machine_principal('b0000000-0000-4000-8000-000000000004'::uuid) THEN
    RAISE EXCEPTION '0181: Service_ReleaseCheck is missing, or it could sign in';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.release_check'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '0181: release_check does not have row-level security on';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = v_fn::regprocedure AND l.lanname = 'plpgsql' AND p.prosecdef
                    AND p.prosrc LIKE '%is_release_check_caller%') THEN
    RAISE EXCEPTION '0181: % is not a plpgsql SECURITY DEFINER gate on the release check''s principal', v_fn;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0181: % may execute %', v_role, v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0181: authenticated may not execute %; the release check''s principal is authenticated', v_fn;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.release_check', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '0181: % may write release_check directly, past its gate', v_role;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.release_check', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.release_check', 'SELECT') THEN
    RAISE EXCEPTION '0181: release_check must be readable by authenticated and by no one signed out';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
