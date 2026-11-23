-- 0312: Setting up an enrolled gateway again revokes its credential at once.
--
-- A setup issued for a Remote gateway whose appliance has enrolled is for the appliance that replaces
-- it: one that never published, or one rebuilt after its machine died. The Re-issue Setup dialog says
-- the issue "also revokes the broker credential its appliance is holding". It did not: the old
-- password was replaced only when the new setup was redeemed.
--
--   * issue_gateway_enrollment_token() owes and asks the revocation of the credential an enrolment
--     stands for (gateway_has_broker_credential(), whose Remote arm is enrolmentStands()'s rule since
--     0308) and stamps credential_revoked_at in the UPDATE that sets PENDING_ENROLLMENT, so the Audit
--     Trail holds one row. The revocation is owed until the credential service confirms it (0311).
--   * Redeeming the new setup gives the new appliance a credential: enroll-gateway re-enables the
--     account with a new password and writes enrolled_at, which is newer than the stamp, so the sweep
--     asks nothing more.
--   * A gateway that never enrolled, or whose enrolment a revocation already followed, is not asked
--     for: a second setup in a row revokes nothing more. The body is 0309's, the archived refusal
--     with it.
--
-- Reasoning: supabase/README.md, "Setting up an enrolled gateway again revokes its credential at once
-- (0312)". Idempotent.
--
-- Redefines public.issue_gateway_enrollment_token: 0312 revokes the credential an enrolled gateway's
--   appliance holds, as a change of type does; 0309 left it working until the new setup was redeemed

-- -------------------------------------------------------------------------------------------------
-- 1. A setup for an enrolled gateway ends the credential its appliance holds
-- -------------------------------------------------------------------------------------------------
-- 0309's body, with the revocation added before the token is written.
CREATE OR REPLACE FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer DEFAULT 30) RETURNS TABLE(token text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_token    text;
  v_expires  timestamp with time zone;
  v_gateway  public.gateways%ROWTYPE;
  v_ends     boolean;
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

  -- A setup for a gateway whose enrolment stands is for the appliance that replaces the enrolled one,
  -- so the credential that one holds ends now, as a change of type ends it: owed until the credential
  -- service confirms it, and stamped below. The new appliance's enrolment is newer than the stamp.
  v_ends := public.gateway_has_broker_credential(v_gateway);
  IF v_ends THEN
    PERFORM public.owe_gateway_revocation(v_gateway.sparkplug_id);
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
  -- would append an audit row on every re-issue. The status and the stamp are one row.
  IF v_gateway.status IS DISTINCT FROM 'PENDING_ENROLLMENT' OR v_ends THEN
    UPDATE public.gateways
       SET status = 'PENDING_ENROLLMENT',
           credential_revoked_at = CASE WHEN v_ends THEN now() ELSE credential_revoked_at END
     WHERE id = p_gateway_id;
  END IF;

  RETURN QUERY SELECT v_token, v_expires;
END $$;

ALTER FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) IS 'Mint a single-use enrolment token for a Remote gateway and move it to PENDING_ENROLLMENT. For a gateway whose enrolment stands (gateway_has_broker_credential), revokes the credential its appliance holds at once and stamps credential_revoked_at: the revocation is owed until the credential service confirms it, and the appliance that redeems the token is given a new credential (0312). Refuses a Host or Third-party gateway, which is issued its credential in the dashboard, and an archived gateway, which has to be restored first. Returns the raw token ONCE -- only its SHA-256 is stored. Requires Administrator or Shopfloor_Manager. Re-issuing consumes any previous live token, so a regenerated bundle invalidates the one already downloaded.';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_src text;
BEGIN
  IF has_function_privilege('anon', 'public.issue_gateway_enrollment_token(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '0312: anon may execute issue_gateway_enrollment_token()';
  END IF;

  -- 0309's refusals stay, and the revocation is owed for the credential an enrolment stands for.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.issue_gateway_enrollment_token(uuid, integer)'::regprocedure;
  IF position('''third_party''' IN v_src) = 0 OR position('''host''' IN v_src) = 0
     OR position('v_gateway.is_archived' IN v_src) = 0 THEN
    RAISE EXCEPTION '0312: issue_gateway_enrollment_token() no longer refuses a Host, a Third-party or an archived gateway';
  END IF;
  IF position('public.gateway_has_broker_credential(v_gateway)' IN v_src) = 0
     OR position('public.owe_gateway_revocation(v_gateway.sparkplug_id)' IN v_src) = 0 THEN
    RAISE EXCEPTION '0312: issue_gateway_enrollment_token() does not revoke the credential an enrolled appliance holds';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
