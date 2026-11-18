-- 0309: An archived gateway is refused a setup token.
--
-- issue_gateway_enrollment_token() refused a Host and a Third-party gateway and not an archived one.
-- Called for an archived Remote gateway it burned any live token, wrote a new one and moved the row to
-- PENDING_ENROLLMENT. Redeeming a token is refused for an archived gateway, so nothing could enrol
-- with it, but the row then read Awaiting setup and a restore brought it back holding a token live for
-- up to a day. authorize_host_gateway_credential(), the function its comment calls its mirror, already
-- refuses an archived gateway.
--
--   * issue_gateway_enrollment_token() raises invalid_parameter_value, "gateway X is archived;
--     restore it before issuing a setup token", for an archived gateway. The check comes after the
--     type checks and before anything is written, as in the credential issue. Nothing else is
--     changed: the body is 0196's.
--
-- Reasoning: supabase/README.md, "An archived gateway is refused a setup token (0309)". Idempotent.
--
-- Redefines public.issue_gateway_enrollment_token: 0309 refuses an archived gateway, as
--   authorize_host_gateway_credential() does; 0196 accepted one, moved it to PENDING_ENROLLMENT and
--   left a live token on it

-- -------------------------------------------------------------------------------------------------
-- 1. The issuer refuses an archived gateway
-- -------------------------------------------------------------------------------------------------
-- 0196's body, with the refusal added after the two type checks.
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
  PERFORM public.require_mfa();

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

  -- Archived is refused, as the credential issue refuses it: redeeming a token is refused for an
  -- archived gateway, so nothing could enrol, and the row would read Awaiting setup.
  IF v_gateway.is_archived THEN
    RAISE EXCEPTION 'gateway % is archived; restore it before issuing a setup token', v_gateway.name
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

COMMENT ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) IS 'Mint a single-use enrolment token for a Remote gateway and move it to PENDING_ENROLLMENT. Refuses a Host or Third-party gateway, which is issued its credential in the dashboard, and an archived gateway, which has to be restored first. Returns the raw token ONCE -- only its SHA-256 is stored. Requires Administrator or Shopfloor_Manager. Re-issuing consumes any previous live token, so a regenerated bundle invalidates the one already downloaded.';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_src text;
BEGIN
  IF has_function_privilege('anon', 'public.issue_gateway_enrollment_token(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '0309: anon may execute issue_gateway_enrollment_token()';
  END IF;

  -- The refusals of 0196 stay, and the new one is there: a Host and a Third-party gateway, and an
  -- archived one.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.issue_gateway_enrollment_token(uuid, integer)'::regprocedure;
  IF position('''third_party''' IN v_src) = 0 OR position('''host''' IN v_src) = 0 THEN
    RAISE EXCEPTION '0309: issue_gateway_enrollment_token() no longer refuses a Host or a Third-party gateway';
  END IF;
  IF position('v_gateway.is_archived' IN v_src) = 0 THEN
    RAISE EXCEPTION '0309: issue_gateway_enrollment_token() does not refuse an archived gateway';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
