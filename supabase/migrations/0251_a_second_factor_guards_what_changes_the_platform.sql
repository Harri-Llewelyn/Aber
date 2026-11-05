-- 0251: With MFA required, a manager's or an Administrator's change to the platform needs a session
-- that gave its code.
--
-- The Settings row security.require_mfa_for_managers (0002) is off by default and only an
-- Administrator may change it. While it is on, an Administrator or a Shopfloor Manager changes the
-- platform only from an aal2 session (or one another identity provider signed in). Reads never ask.
--
--   * mfa_satisfied() is the one predicate, and require_mfa() its guard: true, or 42501 with the
--     sentence that points to Profile › MFA. 0001 declares both, and every write policy there that
--     admits either role calls require_mfa() beside has_role(). The functions that change the
--     platform for them call it after their role check, in the file that holds each final form.
--     db-init replays every file on every boot, so a body or policy declared here would leave the
--     older one serving each boot until this file ran: these files hold none.
--   * oauth_authorization_client() is the consent gate's reader (functions/consent-gate): which
--     app a pending authorization is for, as 0217's readers read auth.oauth_clients.
--   * end_covered_door_sessions() ends the app sessions (auth.sessions with an oauth_client_id)
--     of every person the switch covers, Grafana's excepted: a door session records no assurance,
--     and GoTrue issues every one at aal1. Triggers run it when the switch turns on, for everyone
--     covered, and when a person gains a covered role while it is on. One SESSIONS_ENDED row per
--     person, in their lane.
--
-- Reasoning: supabase/README.md, "With MFA required, a change to the platform needs a session that
-- gave its code (0251)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Which app a pending authorization is for
-- -------------------------------------------------------------------------------------------------
-- The consent page names only the authorization; the gate needs its client, to let Grafana's
-- through at aal1. PL/pgSQL, so auth.oauth_authorizations (GoTrue's) is resolved when it runs.
CREATE OR REPLACE FUNCTION public.oauth_authorization_client(p_authorization_id text) RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN (SELECT a.client_id FROM auth.oauth_authorizations a WHERE a.authorization_id = p_authorization_id);
END
$$;

ALTER FUNCTION public.oauth_authorization_client(p_authorization_id text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.oauth_authorization_client(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oauth_authorization_client(text) TO service_role;

COMMENT ON FUNCTION public.oauth_authorization_client(p_authorization_id text) IS
  'The OAuth client (auth.oauth_clients.id) of the authorization GoTrue''s consent endpoints name '
  'by authorization_id, or NULL for none. service_role only: the consent gate calls it to admit '
  'Grafana''s sign-in at aal1 (0251).';

-- -------------------------------------------------------------------------------------------------
-- 2. Ending the app sessions of the people the switch covers
-- -------------------------------------------------------------------------------------------------
-- As 0217 and 0208 end a session: its auth.sessions row goes, and its refresh tokens with it.
-- Every app but Grafana's (stack_app_ids()'s first, 0002), whose sign-in the switch does not cover.
-- NULL is everyone covered. The covered roles are mfa_satisfied()'s; mirror check 59 holds both.
CREATE OR REPLACE FUNCTION public.end_covered_door_sessions(p_user_id uuid, p_reason text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_ended integer;
BEGIN
  WITH ended AS (
    DELETE FROM auth.sessions s
     WHERE s.oauth_client_id IS NOT NULL
       AND s.oauth_client_id <> 'c0ffee00-0000-4000-8000-000000000001'::uuid
       AND (p_user_id IS NULL OR s.user_id = p_user_id)
       AND EXISTS (SELECT 1
                     FROM public.user_roles ur
                     JOIN public.roles r ON r.id = ur.role_id
                    WHERE ur.user_id = s.user_id
                      AND r.name = ANY (ARRAY['Administrator', 'Shopfloor_Manager']))
    RETURNING s.user_id, s.oauth_client_id
  ), per_person AS (
    SELECT e.user_id,
           count(*)::integer AS sessions,
           array_agg(DISTINCT coalesce(c.client_name, e.oauth_client_id::text)) AS apps
      FROM ended e
      LEFT JOIN auth.oauth_clients c ON c.id = e.oauth_client_id
     GROUP BY e.user_id
  ), logged AS (
    -- Run whether or not the query below reads it, as every data-modifying WITH is.
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    )
    SELECT 'user_roles', p.user_id, 'SESSIONS_ENDED', NULL,
           jsonb_build_object('email', (SELECT u.email::text FROM auth.users u WHERE u.id = p.user_id),
                              'sessions_ended', p.sessions,
                              'apps', to_jsonb(p.apps),
                              'reason', p_reason),
           auth.uid(), public.audit_actor_source(), txid_current(), now()
      FROM per_person p
    RETURNING 1
  )
  SELECT coalesce(sum(p.sessions), 0)::integer INTO v_ended FROM per_person p;
  RETURN v_ended;
END
$$;

ALTER FUNCTION public.end_covered_door_sessions(p_user_id uuid, p_reason text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.end_covered_door_sessions(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.end_covered_door_sessions(p_user_id uuid, p_reason text) IS
  'Deletes the app sessions (auth.sessions with an oauth_client_id, Grafana''s excepted) of one '
  'person, or of everyone when p_user_id is NULL, who holds Administrator or Shopfloor_Manager, and '
  'returns how many ended. One SESSIONS_ENDED row per person whose sessions ended: their email, the '
  'count, the apps and p_reason. Called only by mfa_ends_door_sessions() (0251).';

-- The switch turning on ends everyone covered; a covered role gained while it is on ends that
-- person's. A promotion within the covered roles changes nothing: their sessions were already won
-- under the switch.
CREATE OR REPLACE FUNCTION public.mfa_ends_door_sessions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_covered CONSTANT text[] := ARRAY['Administrator', 'Shopfloor_Manager'];
BEGIN
  IF TG_TABLE_NAME = 'system_settings' THEN
    IF NEW.key = 'security.require_mfa_for_managers' AND NEW.value = 'true'::jsonb
       AND (TG_OP = 'INSERT' OR OLD.value IS DISTINCT FROM NEW.value) THEN
      PERFORM public.end_covered_door_sessions(NULL, 'MFA was turned on in Settings');
    END IF;
    RETURN NULL;
  END IF;

  IF NOT coalesce((SELECT s.value = 'true'::jsonb FROM public.system_settings s
                    WHERE s.key = 'security.require_mfa_for_managers'), false) THEN
    RETURN NULL;
  END IF;
  IF (SELECT r.name FROM public.roles r WHERE r.id = NEW.role_id) = ANY (v_covered)
     AND (TG_OP = 'INSERT'
          OR coalesce((SELECT r.name FROM public.roles r WHERE r.id = OLD.role_id) <> ALL (v_covered), true)) THEN
    PERFORM public.end_covered_door_sessions(NEW.user_id, 'Given a role that needs MFA');
  END IF;
  RETURN NULL;
END
$$;

ALTER FUNCTION public.mfa_ends_door_sessions() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mfa_ends_door_sessions() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.mfa_ends_door_sessions() IS
  'Trigger on system_settings and user_roles. While security.require_mfa_for_managers is on, a '
  'person given Administrator or Shopfloor_Manager from another role or none has their app '
  'sessions ended; when the setting turns on, everyone who holds one does. Grafana''s are kept '
  '(0251).';

SELECT public.replay_trigger('public.system_settings', 'mfa_ends_door_sessions_trg', $ddl$
CREATE TRIGGER mfa_ends_door_sessions_trg AFTER INSERT OR UPDATE OF value ON public.system_settings FOR EACH ROW WHEN ((new.key = 'security.require_mfa_for_managers'::text)) EXECUTE FUNCTION public.mfa_ends_door_sessions();
$ddl$);
SELECT public.replay_trigger('public.user_roles', 'mfa_ends_door_sessions_trg', $ddl$
CREATE TRIGGER mfa_ends_door_sessions_trg AFTER INSERT OR UPDATE OF role_id ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.mfa_ends_door_sessions();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- What this file did, and what 0001 declares for it. Nothing is written.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn   regprocedure;
  v_role text;
BEGIN
  -- The predicate and its guard (0001): their language, volatility and pin, and who runs them. Every
  -- write policy is evaluated as its caller, so authenticated must; anon reaches none of them.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = 'public.mfa_satisfied()'::regprocedure AND l.lanname = 'sql'
                    AND p.provolatile = 's' AND p.prosecdef
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']) THEN
    RAISE EXCEPTION '0251: mfa_satisfied() is not STABLE SECURITY DEFINER SQL with search_path public';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = 'public.require_mfa()'::regprocedure AND l.lanname = 'plpgsql'
                    AND p.provolatile = 's' AND NOT p.prosecdef
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']) THEN
    RAISE EXCEPTION '0251: require_mfa() is not STABLE PL/pgSQL with search_path public';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.mfa_satisfied()'::regprocedure, 'public.require_mfa()'::regprocedure] LOOP
    FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
      IF NOT has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '0251: % may not execute %; every write policy it guards would fail', v_role, v_fn;
      END IF;
    END LOOP;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0251: anon may execute %', v_fn;
    END IF;
  END LOOP;

  -- This file's three functions: SECURITY DEFINER and pinned; the reader the gate's alone.
  FOREACH v_fn IN ARRAY ARRAY['public.oauth_authorization_client(text)'::regprocedure,
                              'public.end_covered_door_sessions(uuid, text)'::regprocedure,
                              'public.mfa_ends_door_sessions()'::regprocedure] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef
                    AND proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']) THEN
      RAISE EXCEPTION '0251: % is not SECURITY DEFINER with search_path public', v_fn;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '0251: % may execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF has_function_privilege('service_role', v_fn, 'EXECUTE')
       <> (v_fn = 'public.oauth_authorization_client(text)'::regprocedure) THEN
      RAISE EXCEPTION '0251: service_role''s EXECUTE on % is not as declared; only the gate''s reader is granted', v_fn;
    END IF;
  END LOOP;
  IF public.live_trigger_statement('public.system_settings', 'mfa_ends_door_sessions_trg') IS NULL
     OR public.live_trigger_statement('public.user_roles', 'mfa_ends_door_sessions_trg') IS NULL THEN
    RAISE EXCEPTION '0251: system_settings and user_roles lack the trigger that ends door sessions';
  END IF;

  -- The predicate's answers that read no switch: a caller with no role on record, and an aal2
  -- session, are admitted whatever the switch says; require_mfa() refuses with its detail.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'aal', 'aal1')::text, true);
  IF NOT public.mfa_satisfied() OR NOT public.require_mfa() THEN
    RAISE EXCEPTION '0251: mfa_satisfied() refused a caller who holds no role';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  -- The owner may end GoTrue sessions and read the authorizations, once GoTrue has made them.
  IF to_regclass('auth.oauth_authorizations') IS NOT NULL
     AND NOT has_table_privilege((SELECT pg_get_userbyid(proowner) FROM pg_proc
                                   WHERE oid = 'public.oauth_authorization_client(text)'::regprocedure),
                                 'auth.oauth_authorizations', 'SELECT') THEN
    RAISE EXCEPTION '0251: the owner of oauth_authorization_client() may not read auth.oauth_authorizations';
  END IF;
  IF to_regclass('auth.sessions') IS NOT NULL
     AND NOT has_table_privilege((SELECT pg_get_userbyid(proowner) FROM pg_proc
                                   WHERE oid = 'public.end_covered_door_sessions(uuid, text)'::regprocedure),
                                 'auth.sessions', 'DELETE') THEN
    RAISE EXCEPTION '0251: the owner of end_covered_door_sessions() may not delete from auth.sessions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.system_settings
                  WHERE key = 'security.require_mfa_for_managers' AND value_type = 'boolean'
                    AND NOT sensitive AND NOT read_only) THEN
    RAISE EXCEPTION '0251: 0002 did not declare security.require_mfa_for_managers as a boolean every role reads';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
