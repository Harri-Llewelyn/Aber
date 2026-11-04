-- 0235: An app's token reaches only its own routes.
--
-- GoTrue's OAuth server signs people in to apps: Grafana, Node-RED, and the Studio and forge doors
-- today. The access token it issues an app names the person, so it carried the person's whole role
-- to PostgREST, Storage, Realtime and the edge functions, whichever app held it. It also carries the
-- app's `client_id`, which nothing read. Now three places read it:
--
--   * auth_pre_request() refuses a token with a client_id, before any other arm, with 403. It sees
--     every PostgREST request, whoever relays it: i3X and the functions that read as the caller.
--   * has_role() and has_authority() answer false for one, so the rows a role gates stay closed on
--     Storage and Realtime too, which verify the token themselves and do not run the hook.
--   * The gateway's API listener admits one only on /auth/v1/ and its own app's functions
--     (supabase/envoy.yaml), and answers 403 everywhere else.
--
-- A token with no client_id, or an empty one, is served as before: the dashboard's, a script's, a
-- machine identity's, and the publishable and secret keys'.
--
-- A body change, not a new signature. db-init replays every file on every boot, so each body is
-- declared in place where it is stated, as 0227 declared its form: 0001 for has_role() and
-- has_authority(), and 0205, whose body is the one the API runs, for auth_pre_request(). A copy here
-- would leave each boot serving the old body from 0001 or 0205 until this file. This file holds no
-- copy. CREATE OR REPLACE keeps every grant. It checks what those files now declare.
--
-- Reasoning: supabase/README.md, "An app's token reaches only its own routes (0235)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- Self-check: each of the three reads the claim, keeps its volatility, SECURITY DEFINER and pinned
-- search_path, and may still be run by the roles that run it; the hook refuses an app's token with
-- 403 and serves an empty client_id; and a person's role and permission, where one is on record, are
-- theirs with their own token and nobody's with an app's. Nothing is written.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn     regprocedure;
  v_lang   name;
  v_vol    "char";
  v_def    boolean;
  v_config text[];
  v_src    text;
  v_role   text;
  v_user   uuid;
  v_perm   text;
  v_msg    text;
  v_detail text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.auth_pre_request()'::regprocedure,
                              'public.has_role(text[])'::regprocedure,
                              'public.has_authority(text[])'::regprocedure] LOOP
    SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig, p.prosrc
      INTO v_lang, v_vol, v_def, v_config, v_src
      FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_fn;
    IF position('client_id' IN v_src) = 0 THEN
      RAISE EXCEPTION '0235: % does not read the client_id claim; 0001 and 0205 declare it', v_fn;
    END IF;
    IF v_vol <> 's' OR NOT v_def OR v_config IS DISTINCT FROM ARRAY['search_path=public'] THEN
      RAISE EXCEPTION '0235: % is no longer STABLE, SECURITY DEFINER with search_path public', v_fn;
    END IF;
    IF v_lang <> (CASE WHEN v_fn = 'public.auth_pre_request()'::regprocedure THEN 'plpgsql' ELSE 'sql' END) THEN
      RAISE EXCEPTION '0235: % is declared in %, not as before', v_fn, v_lang;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
      IF NOT has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '0235: % may not execute %; every request it guards would fail', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT has_function_privilege('anon', 'public.auth_pre_request()', 'EXECUTE') THEN
    RAISE EXCEPTION '0235: anon may not execute auth_pre_request(); PostgREST would refuse every request';
  END IF;

  -- The hook: an app's token is refused with insufficient_privilege, which PostgREST answers 403.
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', gen_random_uuid(), 'role', 'authenticated',
                        'client_id', 'c0ffee00-0000-4000-8000-000000000001')::text, true);
    PERFORM public.auth_pre_request();
    RAISE EXCEPTION '0235: auth_pre_request() served a token issued to an app';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    IF v_msg <> 'this token was issued to an app, and reaches only that app''s own routes'
       OR v_detail <> 'client c0ffee00-0000-4000-8000-000000000001' THEN
      RAISE EXCEPTION '0235: an app''s token was refused as "%" (%), not as one issued to an app', v_msg, v_detail;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'client_id', '')::text, true);
  PERFORM public.auth_pre_request();

  -- The role checks, against a person already on record. A fresh install has nobody yet, and then
  -- the claim test in each body, asserted above, is what is checked.
  SELECT ur.user_id, r.name INTO v_user, v_role
    FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
   LIMIT 1;
  IF v_user IS NOT NULL THEN
    SELECT p.name INTO v_perm
      FROM public.user_roles ur
      JOIN public.role_permissions rp ON rp.role_id = ur.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = v_user
     LIMIT 1;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    IF NOT public.has_role(ARRAY[v_role]) THEN
      RAISE EXCEPTION '0235: has_role() refused % their own role % with their own token', v_user, v_role;
    END IF;
    IF v_perm IS NOT NULL AND NOT public.has_authority(ARRAY[v_perm]) THEN
      RAISE EXCEPTION '0235: has_authority() refused % their own permission % with their own token', v_user, v_perm;
    END IF;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_user, 'role', 'authenticated',
                        'client_id', 'c0ffee00-0000-4000-8000-000000000002')::text, true);
    IF public.has_role(ARRAY[v_role]) THEN
      RAISE EXCEPTION '0235: has_role() gave % role % to a token issued to an app', v_user, v_role;
    END IF;
    IF v_perm IS NOT NULL AND public.has_authority(ARRAY[v_perm]) THEN
      RAISE EXCEPTION '0235: has_authority() gave % permission % to a token issued to an app', v_user, v_perm;
    END IF;
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);
END
$check$;
