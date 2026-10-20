-- 0196: A Third-party gateway is issued its broker credential in the dashboard.
--
-- `third_party` is the third value of gateways.deployment: an edge node on its own machine,
-- running software Aber does not manage. It is issued its credential the way a Host gateway is,
-- because it cannot enrol, and is placed on the plant the way a Remote gateway is.
--
--   * authorize_host_gateway_credential() mints for it, and keep_gateway_credential() keeps the copy
--     an Administrator can show again (0164).
--   * issue_gateway_enrollment_token() refuses it, as it refuses a Host gateway: a bundle is for
--     Aber's gateway appliance.
--   * gateway_has_broker_credential() counts its CREDENTIAL_ISSUED row, so archiving or deleting it
--     disables its broker account.
--
-- 0001 declares the widened gateways_deployment_valid itself: it replays first on every boot and
-- drops a CHECK that differs from its own, so a CHECK widened here would be narrowed again and the
-- re-add would fail on the first Third-party row.
--
-- Reasoning: supabase/README.md, "A Third-party gateway is issued its credential in the dashboard
-- (0196)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The mint admits it
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) RETURNS TABLE(sparkplug_id text, gateway_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
BEGIN
  -- Fail closed, and before anything observable happens. The same allow-list as the write policies
  -- on `gateways` and as the enrolment token's issuer: minting a broker credential is a
  -- gateway-management act.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to mint a gateway broker credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The mirror of the enrolment path. A Remote gateway is Aber's appliance, which mints its
  -- credential on itself and never through a browser. A Host gateway has no appliance, and a
  -- Third-party one runs software Aber does not manage, so neither can enrol: both are issued here.
  IF v_gateway.deployment NOT IN ('host', 'third_party') THEN
    RAISE EXCEPTION
      'gateway % runs on an appliance; use an enrolment bundle so the credential is minted there '
      'rather than shown in a browser', v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Archived is refused: a credential issued now would resurrect the row to ONLINE.
  IF v_gateway.is_archived THEN
    RAISE EXCEPTION 'gateway % is archived; restore it before minting a credential', v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY SELECT v_gateway.sparkplug_id, v_gateway.name;
END;
$$;

ALTER FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) IS 'Gate for minting a Host or Third-party gateway''s broker credential in the dashboard: checks has_role(), refuses a Remote or archived gateway, and returns the generated sparkplug_id the account must be named after. The mirror of issue_gateway_enrollment_token(), which refuses exactly the gateways this accepts.';

-- -------------------------------------------------------------------------------------------------
-- 2. Its copy is kept, so an Administrator can show it again
-- -------------------------------------------------------------------------------------------------
-- Written by gateway-credential straight after the mint. False for a gateway that keeps none
-- (Remote, Playback, archived), so the caller need not know which those are.
CREATE OR REPLACE FUNCTION public.keep_gateway_credential(p_gateway_id uuid, p_password text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
  v_name    text := 'gateway_broker_password:' || p_gateway_id::text;
  v_id      uuid;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to keep a gateway credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A person types a Host or Third-party gateway's password into its edge node, so it may be
  -- needed again. The Playback gateway's is delivered to the worker.
  IF v_gateway.deployment NOT IN ('host', 'third_party') OR v_gateway.is_shadow OR v_gateway.is_archived THEN
    RETURN false;
  END IF;

  IF coalesce(p_password, '') = '' THEN
    RAISE EXCEPTION 'a gateway credential cannot be empty'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = v_name;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_password, v_name,
      'The broker password last issued to gateway ' || v_gateway.sparkplug_id || '.');
  ELSE
    PERFORM vault.update_secret(v_id, p_password);
  END IF;
  RETURN true;
END
$$;

ALTER FUNCTION public.keep_gateway_credential(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.keep_gateway_credential(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.keep_gateway_credential(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.keep_gateway_credential(uuid, text) IS
  'Keeps an encrypted copy (Vault) of the broker password just issued to an active Host, Simulated '
  'or Third-party gateway, replacing any earlier one, so show_gateway_credential() can show it '
  'again. Administrator or Shopfloor_Manager, the roles that may issue it.';

COMMENT ON FUNCTION public.show_gateway_credential(uuid) IS
  'Administrator only: the kept copy of a Host, Simulated or Third-party gateway''s broker '
  'credential, recording a CREDENTIAL_SHOWN row in the Audit Trail each time. Not found (404) when '
  'no copy is kept.';

-- -------------------------------------------------------------------------------------------------
-- 3. The enrolment token's issuer refuses it
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer DEFAULT 30) RETURNS TABLE(token text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_token    text;
  v_expires  timestamp with time zone;
  v_gateway  public.gateways%ROWTYPE;
BEGIN
  -- Fail closed, and check authority before anything observable happens. Same allow-list as the
  -- write policies on `gateways`: issuing a bundle is a gateway-management act.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to issue a gateway enrolment token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Bounded, because the TTL arrives from a client: a day at most.
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 1440 THEN
    RAISE EXCEPTION 'p_ttl_minutes must be between 1 and 1440 (got %)', p_ttl_minutes
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A bundle enrols Aber's gateway appliance. A Host gateway runs inside this stack and a
  -- Third-party one runs software Aber does not manage, so a bundle for either would produce a
  -- credential nothing could present. Both are issued theirs in the dashboard.
  IF v_gateway.deployment = 'host' THEN
    RAISE EXCEPTION 'gateway % runs on this host; enrolment bundles are for appliances only',
      v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_gateway.deployment = 'third_party' THEN
    RAISE EXCEPTION 'gateway % is a Third-party edge node; enrolment bundles are for Aber''s gateway '
      'appliance only, so issue its broker credential instead', v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Invalidate any live token for this gateway first: re-issuing must kill the bundle already
  -- downloaded, and the partial unique index permits one unconsumed row per gateway.
  UPDATE public.gateway_enrollment_tokens
     SET consumed_at = now()
   WHERE gateway_id = p_gateway_id
     AND consumed_at IS NULL;

  -- 32 bytes, hex-encoded (pgcrypto).
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(mins => p_ttl_minutes);

  INSERT INTO public.gateway_enrollment_tokens (gateway_id, token_hash, expires_at, created_by)
  VALUES (
    p_gateway_id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_expires,
    -- Provenance, not a constraint: NULL when called with the service-role key.
    auth.uid()
  );

  -- Guarded on an actual change: `gateways` carries the audit trigger, and an unconditional write
  -- would append an audit row on every re-issue.
  IF v_gateway.status IS DISTINCT FROM 'PENDING_ENROLLMENT' THEN
    UPDATE public.gateways
       SET status = 'PENDING_ENROLLMENT'
     WHERE id = p_gateway_id;
  END IF;

  RETURN QUERY SELECT v_token, v_expires;
END $$;

ALTER FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) IS 'Mint a single-use enrolment token for a Remote gateway and move it to PENDING_ENROLLMENT. Refuses a Host or Third-party gateway, which is issued its credential in the dashboard. Returns the raw token ONCE -- only its SHA-256 is stored. Requires Administrator or Shopfloor_Manager. Re-issuing consumes any previous live token, so a regenerated bundle invalidates the one already downloaded.';

-- -------------------------------------------------------------------------------------------------
-- 4. Its issued credential counts, so the archive disables it
-- -------------------------------------------------------------------------------------------------
-- Read by revoke_credential_on_decommission() and the revocation sweep. Admits only a gateway
-- that holds an account, so revocation never creates one through the add-only credential service.
CREATE OR REPLACE FUNCTION public.gateway_has_broker_credential(g public.gateways) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT
        (g.deployment = 'remote' AND g.enrolled_at IS NOT NULL)
     OR (g.deployment IN ('host', 'third_party') AND EXISTS (
            SELECT 1 FROM public.audit_trail dt
             WHERE dt.entity_type = 'gateways'
               AND dt.entity_id   = g.id
               AND dt.action      = 'CREDENTIAL_ISSUED'
               AND (g.credential_revoked_at IS NULL OR dt.recorded_at > g.credential_revoked_at)
        ));
$$;

ALTER FUNCTION public.gateway_has_broker_credential(g public.gateways) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gateway_has_broker_credential(g public.gateways) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gateway_has_broker_credential(g public.gateways) TO authenticated, service_role;

COMMENT ON FUNCTION public.gateway_has_broker_credential(g public.gateways) IS 'Does an account exist at the broker for this gateway, by either route it can arrive -- a Remote appliance completing enrolment, or the CREDENTIAL_ISSUED row a Host or Third-party mint leaves -- minus revocation. Cannot admit a gateway that never held one, which is what lets revocation use it without creating accounts through the add-only credential service (0063).';

-- -------------------------------------------------------------------------------------------------
-- 5. Self-check
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text;
  v_src text;
BEGIN
  IF position('''third_party''' IN coalesce(
       public.live_constraint_definition('public.gateways'::regclass, 'gateways_deployment_valid'), '')) = 0 THEN
    RAISE EXCEPTION '0196: gateways_deployment_valid does not admit third_party; 0001 declares it';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.authorize_host_gateway_credential(uuid)',
                              'public.keep_gateway_credential(uuid, text)',
                              'public.issue_gateway_enrollment_token(uuid, integer)',
                              'public.gateway_has_broker_credential(public.gateways)'] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn::regprocedure;
    IF position('''third_party''' IN v_src) = 0 THEN
      RAISE EXCEPTION '0196: % does not name third_party, so a Third-party gateway is judged as %',
        v_fn, CASE WHEN v_fn LIKE '%enrollment%' THEN 'Remote' ELSE 'neither Host nor Remote' END;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0196: anon may execute %', v_fn;
    END IF;
  END LOOP;

  -- A Third-party gateway with no CREDENTIAL_ISSUED row holds no account, so revocation passes it
  -- over rather than asking the credential service to create one.
  IF public.gateway_has_broker_credential(jsonb_populate_record(NULL::public.gateways,
       jsonb_build_object('id', gen_random_uuid(), 'deployment', 'third_party'))) THEN
    RAISE EXCEPTION '0196: gateway_has_broker_credential() admits a Third-party gateway that was never issued one';
  END IF;
END
$check$;
