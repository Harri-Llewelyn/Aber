-- 0209: A service token shows when it was last used.
--
-- An Administrator looking at a machine identity's active tokens could not tell which ones a tool
-- still presents. The i3X server now records the first use of each token in each hour, and the
-- token list shows it as Last Used. It covers the clients of the i3X server, MCP hosts through it
-- included. A client calling the REST API directly is not recorded.
--
--   * service_token_last_use holds one row per token ever recorded: its jti, its identity and the
--     hour it was last used. It is not audited, because an audit row per token per hour is the
--     write this exists to avoid; the TOKEN_MINTED row stays the record of the token itself.
--   * record_service_token_use() is the one writer. The i3X server calls it AS THE CALLER, with the
--     caller's own token, so it reads the jti and sub from the verified claims and takes no
--     argument: a caller records its own token and nothing else. It records only a jti with a
--     TOKEN_MINTED row for the same identity, so a person's session token or a key is a no-op, and
--     a second call in the same hour writes nothing. auth_pre_request() has already refused a
--     revoked token, or one whose identity is withdrawn, before the function runs.
--   * An Administrator or an Auditor reads it: whoever reads the token list (the security lane and
--     revoked_service_tokens).
--
-- Reasoning: supabase/README.md, "A service token shows when it was last used (0209)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The table
-- -------------------------------------------------------------------------------------------------
-- last_used_at is the start of the hour, so a second use in the same hour has nothing to change.
CREATE TABLE IF NOT EXISTS public.service_token_last_use (
    jti text NOT NULL,
    principal_id uuid NOT NULL,
    last_used_at timestamp with time zone NOT NULL,
    CONSTRAINT service_token_last_use_pkey PRIMARY KEY (jti)
);

ALTER TABLE public.service_token_last_use OWNER TO postgres;
ALTER TABLE public.service_token_last_use ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.service_token_last_use IS
  'When each machine-identity token was last presented to the i3X server, to the hour: one row '
  'per jti, written only by record_service_token_use(), which the i3X server calls as the caller. '
  'A client calling the REST API directly is not recorded. Read by an Administrator or an Auditor; '
  'not audited (0209).';
COMMENT ON COLUMN public.service_token_last_use.jti IS
  'The token''s jti, as its TOKEN_MINTED audit row records it.';
COMMENT ON COLUMN public.service_token_last_use.principal_id IS
  'The machine identity the token names: the entity_id of its TOKEN_MINTED row, and its sub.';
COMMENT ON COLUMN public.service_token_last_use.last_used_at IS
  'The start of the latest hour in which the i3X server accepted the token. Never moves back.';

-- -------------------------------------------------------------------------------------------------
-- 2. Who reaches it
-- -------------------------------------------------------------------------------------------------
-- Nothing writes it but record_service_token_use(). anon and service_role hold nothing.
REVOKE ALL ON TABLE public.service_token_last_use FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.service_token_last_use TO authenticated;

SELECT public.replay_policy('public.service_token_last_use', 'service_token_last_use_select_privileged', $ddl$
CREATE POLICY service_token_last_use_select_privileged ON public.service_token_last_use FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Auditor'::text]) AS has_role));
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. Recording a use
-- -------------------------------------------------------------------------------------------------
-- Called through POST /rest/v1/rpc/record_service_token_use: PostgREST runs a GET read-only. The
-- recorded hour is checked first, so the common call reads one row and writes nothing. The
-- TOKEN_MINTED read is 0204's: the security lane's last service_token_max_days() + 1 days, so older
-- partitions are pruned and the rest read through idx_audit_trail_domain. The hour is UTC's, as the
-- i3X server counts it, whatever the session's time zone. Returns true when it wrote.
CREATE OR REPLACE FUNCTION public.record_service_token_use() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_claims    jsonb;
  v_jti       text;
  v_sub       text;
  v_hour      timestamp with time zone := date_trunc('hour', now(), 'UTC');
  v_principal uuid;
BEGIN
  -- PostgREST verified the signature before setting this. Claims that will not parse record nothing.
  BEGIN
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  v_jti := v_claims ->> 'jti';
  v_sub := v_claims ->> 'sub';
  IF v_jti IS NULL OR v_jti = '' OR length(v_jti) > 128
     OR v_sub IS NULL OR v_sub !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM public.service_token_last_use u
              WHERE u.jti = v_jti AND u.last_used_at >= v_hour) THEN
    RETURN false;
  END IF;

  SELECT a.entity_id INTO v_principal
    FROM public.audit_trail a
   WHERE a.audit_domain = 'security'
     AND a.recorded_at > now() - make_interval(days => public.service_token_max_days() + 1)
     AND a.entity_type = 'service_principals'
     AND a.action = 'TOKEN_MINTED'
     AND a.new_data ->> 'jti' = v_jti
     AND a.entity_id = v_sub::uuid
   LIMIT 1;
  IF v_principal IS NULL THEN
    RETURN false;
  END IF;

  -- Two replicas recording the same hour at once: the second matches the WHERE and writes nothing.
  INSERT INTO public.service_token_last_use AS u (jti, principal_id, last_used_at)
  VALUES (v_jti, v_principal, v_hour)
  ON CONFLICT (jti) DO UPDATE SET last_used_at = EXCLUDED.last_used_at
   WHERE u.last_used_at < EXCLUDED.last_used_at;
  RETURN FOUND;
END
$$;

ALTER FUNCTION public.record_service_token_use() OWNER TO postgres;

COMMENT ON FUNCTION public.record_service_token_use() IS
  'Records that the caller''s own token was used this hour, in service_token_last_use. The i3X '
  'server calls it as the caller after accepting a token. Reads the jti and sub from the verified '
  'claims, never an argument; records only a jti with a TOKEN_MINTED row for that sub, and writes '
  'nothing on a second call in the same hour. Returns true when it wrote. Granted to authenticated '
  'only (0209).';

-- Machine identities' tokens carry role authenticated. anon and service_role never record.
REVOKE ALL ON FUNCTION public.record_service_token_use() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_service_token_use() TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_role      text;
  v_privilege text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.service_token_last_use'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '0209: service_token_last_use does not have row-level security on';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.service_token_last_use', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '0209: % holds a privilege on service_token_last_use', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.service_token_last_use', 'SELECT') THEN
    RAISE EXCEPTION '0209: authenticated cannot read service_token_last_use, so the token list shows no last use';
  END IF;
  -- One privilege per call: has_table_privilege() answers true when ANY of a list is held.
  FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('authenticated', 'public.service_token_last_use', v_privilege) THEN
      RAISE EXCEPTION '0209: authenticated may % service_token_last_use directly', v_privilege;
    END IF;
  END LOOP;
  IF position('Auditor' IN coalesce(
       public.live_policy_statement('public.service_token_last_use', 'service_token_last_use_select_privileged'), '')) = 0 THEN
    RAISE EXCEPTION '0209: service_token_last_use_select_privileged is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.record_service_token_use()'::regprocedure
                  AND prosecdef AND provolatile = 'v' AND 'search_path=""' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0209: record_service_token_use() is not a volatile SECURITY DEFINER with its search_path pinned';
  END IF;
  IF has_function_privilege('anon', 'public.record_service_token_use()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.record_service_token_use()', 'EXECUTE') THEN
    RAISE EXCEPTION '0209: anon or service_role may execute record_service_token_use()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.record_service_token_use()', 'EXECUTE') THEN
    RAISE EXCEPTION '0209: authenticated may not execute record_service_token_use(); the i3X server calls it as the caller';
  END IF;

  -- No claims, and claims naming no recorded token, record nothing and raise nothing.
  PERFORM set_config('request.jwt.claims', '', true);
  IF public.record_service_token_use() THEN
    RAISE EXCEPTION '0209: record_service_token_use() recorded a call with no claims';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'jti', gen_random_uuid())::text, true);
  IF public.record_service_token_use() THEN
    RAISE EXCEPTION '0209: record_service_token_use() recorded a jti with no TOKEN_MINTED row';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
END
$check$;

NOTIFY pgrst, 'reload schema';
