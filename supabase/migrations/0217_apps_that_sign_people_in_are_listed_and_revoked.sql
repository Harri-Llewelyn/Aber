-- 0217: Apps that sign people in are listed, and an approval or an app can be taken back.
--
-- GoTrue's OAuth server signs people in to Grafana, Node-RED, Studio and the forge: an app is one
-- row of auth.oauth_clients, and a person's approval of it one row of auth.oauth_consents. Both
-- were readable only in Studio.
--
--   * list_apps() lists every app not removed, with how many people allow it; app_approvals()
--     lists who allows one. Administrator only. list_my_app_approvals() is the caller's own, for
--     any person role.
--   * revoke_app_approval() does for an Administrator what GoTrue's DELETE /user/oauth/grants does
--     for the person: the approval is revoked and the app's sessions for that person end.
--   * remove_app() does what GoTrue's admin DELETE does (a soft delete), and also revokes every
--     approval and ends every session of the app. The stack's own four (0002) are refused:
--     db-init registers them again on every boot.
--   * Triggers on both tables write APP_REGISTERED, APP_REMOVED, APP_RESTORED, APP_APPROVED and
--     APP_APPROVAL_REVOKED rows, whichever writes the table: GoTrue, these functions or db-init.
--
-- Reasoning: supabase/README.md, "Apps that sign people in are listed and revoked (0217)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The stack's own apps, and an app's facts as the Audit Trail records them
-- -------------------------------------------------------------------------------------------------
-- The ids 0002 pins for Grafana, Node-RED and the Studio and forge doors. Mirror check 30 holds
-- this list to 0002's.
CREATE OR REPLACE FUNCTION public.stack_app_ids() RETURNS uuid[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT ARRAY['c0ffee00-0000-4000-8000-000000000001',
               'c0ffee00-0000-4000-8000-000000000002',
               'c0ffee00-0000-4000-8000-000000000003',
               'c0ffee00-0000-4000-8000-000000000004']::uuid[]
$$;

ALTER FUNCTION public.stack_app_ids() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stack_app_ids() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.stack_app_ids() IS
  'The ids of the four OAuth clients 0002 seeds on every boot: Grafana, Node-RED, and the Studio and '
  'forge doors. remove_app() refuses them (0217).';

-- GoTrue keeps a list as one comma-separated string, and scopes as one space-separated string.
CREATE OR REPLACE FUNCTION public.app_list_items(p_list text, p_separator text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(array_agg(btrim(t.raw) ORDER BY t.n) FILTER (WHERE btrim(t.raw) <> ''), '{}')
    FROM regexp_split_to_table(coalesce(p_list, ''), p_separator) WITH ORDINALITY AS t(raw, n)
$$;

ALTER FUNCTION public.app_list_items(p_list text, p_separator text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.app_list_items(text, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.app_list_items(p_list text, p_separator text) IS
  'GoTrue''s list in one string as an array: redirect_uris and grant_types split on '','' and '
  'scopes on whitespace, each item trimmed, empty ones dropped (0217).';

-- An auth.oauth_clients row, as to_jsonb() gives it, in the words an audit row keeps. Never the
-- secret's hash. `name` is the key the Audit Trail names a lane by.
CREATE OR REPLACE FUNCTION public.app_facts(p_client jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'name', p_client ->> 'client_name',
    'registration_type', p_client ->> 'registration_type',
    'client_type', p_client ->> 'client_type',
    'redirect_uris', to_jsonb(public.app_list_items(p_client ->> 'redirect_uris', ',')),
    'grant_types', to_jsonb(public.app_list_items(p_client ->> 'grant_types', ',')),
    'client_uri', p_client ->> 'client_uri',
    'part_of_stack', coalesce((p_client ->> 'id')::uuid = ANY (public.stack_app_ids()), false))
$$;

ALTER FUNCTION public.app_facts(p_client jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.app_facts(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.app_facts(p_client jsonb) IS
  'An OAuth client row (to_jsonb) as the app audit rows record it: name, registration_type, '
  'client_type, redirect_uris and grant_types as arrays, client_uri and part_of_stack. Never '
  'client_secret_hash (0217).';

-- -------------------------------------------------------------------------------------------------
-- 2. Reading the apps and the approvals
-- -------------------------------------------------------------------------------------------------
-- PL/pgSQL resolves the auth tables when a function runs: GoTrue creates them before db-init.
CREATE OR REPLACE FUNCTION public.list_apps()
RETURNS TABLE(id uuid, client_name text, registration_type text, part_of_stack boolean,
              client_type text, redirect_uris text[], client_uri text,
              created_at timestamp with time zone, people_allowing integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to list the apps that sign people in'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT c.id,
         c.client_name,
         c.registration_type::text,
         c.id = ANY (public.stack_app_ids()),
         c.client_type::text,
         public.app_list_items(c.redirect_uris, ','),
         c.client_uri,
         c.created_at,
         (SELECT count(*)::integer FROM auth.oauth_consents k
           WHERE k.client_id = c.id AND k.revoked_at IS NULL)
    FROM auth.oauth_clients c
   WHERE c.deleted_at IS NULL
   ORDER BY c.id = ANY (public.stack_app_ids()) DESC, lower(coalesce(c.client_name, '')), c.id;
END
$$;

ALTER FUNCTION public.list_apps() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_apps() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.list_apps() TO authenticated;

COMMENT ON FUNCTION public.list_apps() IS
  'Administrator only. Every OAuth client not removed (deleted_at is null), the stack''s own first: '
  'its name, how it was registered (registration_type, and part_of_stack for the four 0002 seeds), '
  'client_type, redirect_uris as an array, client_uri, when it was registered, and how many people '
  'allow it now (consents not revoked). Never the secret''s hash (0217).';

-- Not STABLE: a removed app is answered through raise_not_found(), which is volatile.
CREATE OR REPLACE FUNCTION public.app_approvals(p_client_id uuid)
RETURNS TABLE(user_id uuid, email text, display_name text, scopes text[],
              granted_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to list who allows an app'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.oauth_clients c WHERE c.id = p_client_id AND c.deleted_at IS NULL) THEN
    PERFORM public.raise_not_found(format('app %s not found: it was removed, or was never registered',
                                          coalesce(p_client_id::text, 'NULL')));
  END IF;

  RETURN QUERY
  SELECT k.user_id, u.email::text, p.display_name, public.app_list_items(k.scopes, '\s+'), k.granted_at
    FROM auth.oauth_consents k
    JOIN auth.users u ON u.id = k.user_id
    LEFT JOIN public.person_profiles p ON p.user_id = k.user_id
   WHERE k.client_id = p_client_id AND k.revoked_at IS NULL
   ORDER BY k.granted_at DESC, k.user_id;
END
$$;

ALTER FUNCTION public.app_approvals(p_client_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.app_approvals(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.app_approvals(uuid) TO authenticated;

COMMENT ON FUNCTION public.app_approvals(p_client_id uuid) IS
  'Administrator only. Who allows one app now: each person''s id, email and display name, the '
  'scopes they approved and when, newest first. A removed or unknown app is a 404 (0217).';

-- GoTrue's own GET /user/oauth/grants answers the same rows; this one is the database's, so the
-- dashboard reads both lists one way.
CREATE OR REPLACE FUNCTION public.list_my_app_approvals()
RETURNS TABLE(client_id uuid, client_name text, client_uri text, part_of_stack boolean,
              scopes text[], granted_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor']) THEN
    RAISE EXCEPTION 'insufficient privileges to list your apps: sign in as a person with a role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT c.id, c.client_name, c.client_uri, c.id = ANY (public.stack_app_ids()),
         public.app_list_items(k.scopes, '\s+'), k.granted_at
    FROM auth.oauth_consents k
    JOIN auth.oauth_clients c ON c.id = k.client_id
   WHERE k.user_id = v_caller AND k.revoked_at IS NULL AND c.deleted_at IS NULL
   ORDER BY k.granted_at DESC, c.id;
END
$$;

ALTER FUNCTION public.list_my_app_approvals() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_my_app_approvals() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.list_my_app_approvals() TO authenticated;

COMMENT ON FUNCTION public.list_my_app_approvals() IS
  'The caller''s own approvals in force, newest first: the app''s id, name and address, whether it '
  'is one of the stack''s own, the scopes approved and when. A removed app is left out, as GoTrue''s '
  'GET /user/oauth/grants leaves it out. Any person role; a caller with no role is 42501 (0217).';

-- -------------------------------------------------------------------------------------------------
-- 3. Taking an approval back, for a person
-- -------------------------------------------------------------------------------------------------
-- GoTrue's UserRevokeOAuthGrant, in SQL: the consent's revoked_at, then every session that app
-- holds for the person (their refresh tokens cascade). The consent trigger writes the audit row.
-- check_person_act() (0166) refuses anyone but an Administrator, an unknown person and a machine
-- identity, under the People lock.
CREATE OR REPLACE FUNCTION public.revoke_app_approval(p_user_id uuid, p_client_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_ended integer;
BEGIN
  PERFORM public.check_person_act(p_user_id, 'revoke a person''s approval of an app');

  UPDATE auth.oauth_consents k
     SET revoked_at = greatest(clock_timestamp(), k.granted_at)
   WHERE k.user_id = p_user_id AND k.client_id = p_client_id AND k.revoked_at IS NULL;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('no approval of app %s by this person is in force',
                                          coalesce(p_client_id::text, 'NULL')));
  END IF;

  DELETE FROM auth.sessions s WHERE s.user_id = p_user_id AND s.oauth_client_id = p_client_id;
  GET DIAGNOSTICS v_ended = ROW_COUNT;
  RETURN v_ended;
END
$$;

ALTER FUNCTION public.revoke_app_approval(p_user_id uuid, p_client_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.revoke_app_approval(uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_app_approval(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.revoke_app_approval(p_user_id uuid, p_client_id uuid) IS
  'Administrator only. What GoTrue''s DELETE /user/oauth/grants does for the person: sets their '
  'consent''s revoked_at and deletes every auth.sessions row that app holds for them, so its '
  'refresh tokens stop working and the app asks again at their next sign-in. Returns how many '
  'sessions ended. An approval not in force is a 404; an unknown person a 404, a machine identity '
  '22023. The APP_APPROVAL_REVOKED row names the Administrator (0217).';

-- -------------------------------------------------------------------------------------------------
-- 4. Removing an app
-- -------------------------------------------------------------------------------------------------
-- GoTrue's admin DELETE sets deleted_at and nothing else; its sessions and consents stay. This also
-- revokes every approval and ends every session, in one transaction. 0002 clears deleted_at on
-- every boot, so the stack's own are refused rather than removed until the next boot.
CREATE OR REPLACE FUNCTION public.remove_app(p_client_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_name      text;
  v_approvals integer;
  v_sessions  integer;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to remove an app'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_client_id = ANY (public.stack_app_ids()) THEN
    RAISE EXCEPTION 'this app is part of Aber: it is registered again each time Aber starts, so it cannot be removed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT c.client_name INTO v_name
    FROM auth.oauth_clients c
   WHERE c.id = p_client_id AND c.deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('app %s not found: it was removed, or was never registered',
                                          coalesce(p_client_id::text, 'NULL')));
  END IF;

  UPDATE auth.oauth_consents k
     SET revoked_at = greatest(clock_timestamp(), k.granted_at)
   WHERE k.client_id = p_client_id AND k.revoked_at IS NULL;
  GET DIAGNOSTICS v_approvals = ROW_COUNT;

  DELETE FROM auth.sessions s WHERE s.oauth_client_id = p_client_id;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  UPDATE auth.oauth_clients c
     SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE c.id = p_client_id;

  RETURN jsonb_build_object('name', v_name, 'approvals_ended', v_approvals, 'sessions_ended', v_sessions);
END
$$;

ALTER FUNCTION public.remove_app(p_client_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_app(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.remove_app(uuid) TO authenticated;

COMMENT ON FUNCTION public.remove_app(p_client_id uuid) IS
  'Administrator only. Removes an app as GoTrue''s admin DELETE does (deleted_at), and in the same '
  'transaction revokes every approval of it and deletes every session it holds, so no refresh token '
  'it was issued works. Returns {name, approvals_ended, sessions_ended}. The stack''s own four are '
  'refused (42501): db-init registers them again on every boot. A removed or unknown app is a 404 '
  '(0217).';

-- -------------------------------------------------------------------------------------------------
-- 5. Each registration, removal, approval and revocation is an Audit Trail row
-- -------------------------------------------------------------------------------------------------
-- An app's own acts go in its lane (entity_type oauth_clients, filed under security by
-- audit_domain_for()'s default). 0002's re-seed of an existing row is an UPDATE that leaves
-- deleted_at NULL, so a boot writes nothing; the first seed is one APP_REGISTERED by migration.
CREATE OR REPLACE FUNCTION public.log_app_registration() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_action text;
  v_id     uuid;
  v_new    jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    v_action := 'APP_REGISTERED';
    v_id := NEW.id;
    v_new := public.app_facts(to_jsonb(NEW));
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      v_action := 'APP_REMOVED';
      v_new := public.app_facts(to_jsonb(OLD)) || jsonb_build_object('removed_at', NEW.deleted_at);
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      v_action := 'APP_RESTORED';
      v_new := public.app_facts(to_jsonb(NEW));
    ELSE
      RETURN NULL;
    END IF;
    v_id := NEW.id;
  ELSE
    IF OLD.deleted_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    v_action := 'APP_REMOVED';
    v_id := OLD.id;
    v_new := public.app_facts(to_jsonb(OLD)) || jsonb_build_object('removed_at', now());
  END IF;

  INSERT INTO public.audit_trail (
      entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
      causation_id, recorded_at
  ) VALUES (
      'oauth_clients', v_id, v_action, NULL, v_new,
      auth.uid(), public.audit_actor_source(), txid_current(), now()
  );
  RETURN NULL;
END
$$;

ALTER FUNCTION public.log_app_registration() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.log_app_registration() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.log_app_registration() IS
  'Audit trigger for auth.oauth_clients, in the app''s lane (entity_type oauth_clients): '
  'APP_REGISTERED for a row inserted, APP_REMOVED when deleted_at is set or a live row is deleted, '
  'APP_RESTORED when deleted_at is cleared (0002''s re-seed of a removed stack app). new_data is '
  'app_facts(), with removed_at on a removal; old_data is NULL. Nothing for any other UPDATE, so '
  'a boot''s re-seed writes no row (0217).';

-- An approval goes in the person's lane, beside their sessions. GoTrue writes a consent only for
-- the person whose it is (their consent page, or their own revoke), and carries no token here:
-- its role stands in for them. GoTrue stamps granted_at at each approval, and at nothing else.
CREATE OR REPLACE FUNCTION public.log_app_approval() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_action text;
  v_by     uuid := auth.uid();
  v_source text;
  v_email  text;
  v_new    jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RETURN NULL;
    END IF;
    v_action := 'APP_APPROVED';
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    v_action := 'APP_APPROVAL_REVOKED';
  ELSIF NEW.revoked_at IS NULL AND (OLD.revoked_at IS NOT NULL
                                    OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
                                    OR NEW.scopes IS DISTINCT FROM OLD.scopes) THEN
    v_action := 'APP_APPROVED';
  ELSE
    RETURN NULL;
  END IF;

  IF v_by IS NULL
     AND coalesce(nullif(nullif(current_setting('role', true), 'none'), ''), session_user) = 'supabase_auth_admin' THEN
    v_by := NEW.user_id;
    v_source := 'user';
  ELSE
    v_source := public.audit_actor_source();
  END IF;

  SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = NEW.user_id;
  v_new := jsonb_build_object(
    'email', v_email,
    'app', jsonb_build_object('id', NEW.client_id,
                              'name', (SELECT c.client_name FROM auth.oauth_clients c WHERE c.id = NEW.client_id)),
    'scopes', to_jsonb(public.app_list_items(NEW.scopes, '\s+')),
    'granted_at', NEW.granted_at);
  IF v_action = 'APP_APPROVAL_REVOKED' THEN
    v_new := v_new || jsonb_build_object('revoked_at', NEW.revoked_at);
  END IF;

  INSERT INTO public.audit_trail (
      entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
      causation_id, recorded_at
  ) VALUES (
      'user_roles', NEW.user_id, v_action, NULL, v_new,
      v_by, v_source, txid_current(), now()
  );
  RETURN NULL;
END
$$;

ALTER FUNCTION public.log_app_approval() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.log_app_approval() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.log_app_approval() IS
  'Audit trigger for auth.oauth_consents, in the person''s lane (entity_type user_roles, entity_id '
  'the person): APP_APPROVED for a consent given, given again or re-scoped, APP_APPROVAL_REVOKED '
  'when revoked_at is set; any other UPDATE writes nothing. new_data is {email, app: {id, name}, '
  'scopes, granted_at}, with revoked_at on a revocation. changed_by is the caller''s token; with '
  'none, GoTrue''s own role (the person''s consent page or their revoke) records the person (0217).';

-- GoTrue creates and owns both tables before db-init runs; `postgres` holds every privilege on them
-- (the image's default privileges for supabase_auth_admin), TRIGGER among them, but is not their
-- owner. replay_trigger() drops a trigger whose definition differs: supautils lets `postgres` drop
-- one on auth.oauth_clients (supautils.drop_trigger_grants), and nothing lets it on
-- auth.oauth_consents. So the consent trigger is one, with no WHEN: what it records is decided in
-- log_app_approval(), which a later file may redeclare, and changing the trigger needs GoTrue's role.
DO $$
BEGIN
  IF NOT has_table_privilege('auth.oauth_clients', 'TRIGGER') OR NOT has_table_privilege('auth.oauth_consents', 'TRIGGER') THEN
    RAISE EXCEPTION '0217: % may not create a trigger on auth.oauth_clients and auth.oauth_consents', current_user;
  END IF;
END
$$;

SELECT public.replay_trigger('auth.oauth_clients', 'oauth_clients_audit_trail', $ddl$
CREATE TRIGGER oauth_clients_audit_trail AFTER INSERT OR DELETE ON auth.oauth_clients FOR EACH ROW EXECUTE FUNCTION public.log_app_registration();
$ddl$);
SELECT public.replay_trigger('auth.oauth_clients', 'oauth_clients_audit_trail_update', $ddl$
CREATE TRIGGER oauth_clients_audit_trail_update AFTER UPDATE ON auth.oauth_clients FOR EACH ROW WHEN (((old.deleted_at IS NULL) <> (new.deleted_at IS NULL))) EXECUTE FUNCTION public.log_app_registration();
$ddl$);
SELECT public.replay_trigger('auth.oauth_consents', 'oauth_consents_audit_trail', $ddl$
CREATE TRIGGER oauth_consents_audit_trail AFTER INSERT OR UPDATE ON auth.oauth_consents FOR EACH ROW EXECUTE FUNCTION public.log_app_approval();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_owner name := (SELECT pg_get_userbyid(proowner) FROM pg_proc
                    WHERE oid = 'public.remove_app(uuid)'::regprocedure);
  v_role  text;
  f       text;
  t       text;
  p       text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.list_apps()', 'public.app_approvals(uuid)', 'public.list_my_app_approvals()',
                           'public.revoke_app_approval(uuid, uuid)', 'public.remove_app(uuid)',
                           'public.log_app_registration()', 'public.log_app_approval()'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0217: % is not SECURITY DEFINER with its search_path pinned', f;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF has_function_privilege(v_role, f, 'EXECUTE') THEN
        RAISE EXCEPTION '0217: % may execute %', v_role, f;
      END IF;
    END LOOP;
    IF has_function_privilege('authenticated', f, 'EXECUTE') <> (f NOT LIKE 'public.log_app_%') THEN
      RAISE EXCEPTION '0217: authenticated % execute %; only the dashboard''s five calls are granted',
        CASE WHEN f LIKE 'public.log_app_%' THEN 'may' ELSE 'may not' END, f;
    END IF;
  END LOOP;

  IF cardinality(public.stack_app_ids()) <> 4
     OR (SELECT count(DISTINCT x) FROM unnest(public.stack_app_ids()) x) <> 4 THEN
    RAISE EXCEPTION '0217: stack_app_ids() does not name four distinct apps';
  END IF;
  IF public.app_list_items(' openid  email profile ', '\s+') <> ARRAY['openid', 'email', 'profile']
     OR public.app_list_items('a, b,,', ',') <> ARRAY['a', 'b'] OR public.app_list_items(NULL, ',') <> '{}' THEN
    RAISE EXCEPTION '0217: app_list_items() does not split GoTrue''s lists';
  END IF;
  IF public.app_facts('{"client_secret_hash": "x"}'::jsonb) ? 'client_secret_hash' THEN
    RAISE EXCEPTION '0217: app_facts() records the secret''s hash';
  END IF;

  -- A request with no person behind it is refused before anything is read or changed.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.list_apps();
    RAISE EXCEPTION '0217: list_apps() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.app_approvals(gen_random_uuid());
    RAISE EXCEPTION '0217: app_approvals() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.list_my_app_approvals();
    RAISE EXCEPTION '0217: list_my_app_approvals() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.revoke_app_approval(gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION '0217: revoke_app_approval() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.remove_app(gen_random_uuid());
    RAISE EXCEPTION '0217: remove_app() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- The owner reaches GoTrue's tables, and the three triggers are in place.
  FOREACH t IN ARRAY ARRAY['auth.oauth_clients', 'auth.oauth_consents', 'auth.sessions'] LOOP
    -- One privilege per call: has_table_privilege() answers true when ANY of a list is held.
    FOREACH p IN ARRAY CASE WHEN t = 'auth.sessions' THEN ARRAY['SELECT', 'DELETE']
                            ELSE ARRAY['SELECT', 'UPDATE', 'TRIGGER'] END LOOP
      IF NOT has_table_privilege(v_owner, t, p) THEN
        RAISE EXCEPTION '0217: % may not % %', v_owner, p, t;
      END IF;
    END LOOP;
  END LOOP;
  IF public.live_trigger_statement('auth.oauth_clients', 'oauth_clients_audit_trail') IS NULL
     OR public.live_trigger_statement('auth.oauth_clients', 'oauth_clients_audit_trail_update') IS NULL
     OR public.live_trigger_statement('auth.oauth_consents', 'oauth_consents_audit_trail') IS NULL THEN
    RAISE EXCEPTION '0217: auth.oauth_clients and auth.oauth_consents lack their audit triggers';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
