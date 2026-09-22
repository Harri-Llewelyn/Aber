-- =============================================================================================
-- 0075_a_mint_can_name_the_person_who_asked.sql
--
-- `record_service_token_issued()` gains an actor, so a token minted from the Access Control page
-- records the Administrator who asked for it. Revocation (0074) came first, so a mint can exist.
--
-- THE MINT IS NOT HERE. SUPABASE_JWT_SECRET is not in the database and must not be: it signs
-- anything, including a `service_role` token valid at storage, realtime, the edge runtime and
-- Studio, none of which 0074 can revoke. Putting it in Vault would make any path to SQL
-- execution a path to an unrevocable credential. The signing lives in the `mint-service-token`
-- edge function, which already holds JWT_SECRET, as `enroll-gateway` and `gateway-credential`
-- do for their secrets.
--
-- The signature changes rather than a second function appearing: every guard in this function
-- is security-critical, and two copies would drift. DROP and recreate rather than an overload,
-- because a defaulted fifth argument beside the four-argument form makes a four-argument call
-- ambiguous. The host scripts call this with named arguments and need no edit.
-- =============================================================================================

DROP FUNCTION IF EXISTS public.record_service_token_issued(uuid, text, timestamptz, jsonb);

CREATE OR REPLACE FUNCTION public.record_service_token_issued(
  p_principal_id uuid,
  p_jti          text,
  p_expires_at   timestamptz,
  p_context      jsonb DEFAULT '{}'::jsonb,
  -- NULL MEANS "A MACHINE ASKED", which is 0043's original behaviour and stays the default so the
  -- two host scripts keep the attribution they have always had. A non-null value is checked below
  -- rather than believed.
  p_actor_id     uuid  DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_roles      text[];
  v_is_service boolean;
  v_ttl_days   numeric;
  v_actor      uuid := p_actor_id;
  v_source     text;
  v_id         bigint;
BEGIN
  IF p_principal_id IS NULL THEN
    RAISE EXCEPTION 'record_service_token_issued: p_principal_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- A `jti` is the key of the denylist `auth_pre_request()` reads, so it is what a revocation is
  -- performed against. Bounded because it lands in an append-only table.
  IF p_jti IS NULL OR length(p_jti) = 0 OR length(p_jti) > 64 THEN
    RAISE EXCEPTION 'record_service_token_issued: p_jti must be 1-64 characters (got %)',
      coalesce(length(p_jti)::text, 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'record_service_token_issued: p_expires_at must be in the future (got %)',
      coalesce(p_expires_at::text, 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- THE CEILING. The callers refuse this too, and because they record before they print, a
  -- refusal here means the token never reaches anybody.
  v_ttl_days := extract(epoch FROM (p_expires_at - now())) / 86400.0;
  IF v_ttl_days > public.service_token_max_days() THEN
    RAISE EXCEPTION
      'record_service_token_issued: a token may not outlive % days (asked for %). A token can be '
      'revoked against the API (0074), but storage, realtime and the edge functions verify the '
      'signature only -- so the expiry is still the only bound that reaches every service.',
      public.service_token_max_days(), round(v_ttl_days, 1)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The subject must be a service principal: no email and no password means nothing can present
  -- this identity except a JWT signed outside GoTrue. A long-lived token minted against an
  -- Administrator's login would be a permanent escalation of that person's session.
  SELECT (u.email IS NULL AND (u.encrypted_password IS NULL OR u.encrypted_password = ''))
    INTO v_is_service
    FROM auth.users u WHERE u.id = p_principal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_service_token_issued: no principal with id %', p_principal_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_is_service THEN
    RAISE EXCEPTION
      'record_service_token_issued: % can sign in, so it is a person''s account and not a service '
      'principal. A long-lived token for it would escalate that person''s session.', p_principal_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A revoked principal cannot be issued a new token; without this the page would sign a
  -- credential that is refused on its first request. A forward reference to 0076, safe because
  -- PL/pgSQL resolves a call at execution time and the whole chain replays before anything calls
  -- this.
  PERFORM public.assert_principal_not_revoked(p_principal_id);

  -- ---------------------------------------------------------------------------------------------
  -- The actor is re-checked here, not trusted: `mint-service-token` verifies the session before
  -- it signs, and this is the second of two checks, so authorisation does not rest solely on a
  -- function that also holds the signing key. Refused rather than downgraded to NULL.
  -- ---------------------------------------------------------------------------------------------
  IF v_actor IS NULL THEN
    -- 0043's original attribution, unchanged: the caller holds a machine credential and there is
    -- no person to name.
    v_source := 'service';
  ELSE
    IF NOT EXISTS (
      SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.user_id = v_actor::text
         AND r.name = 'Administrator'
    ) THEN
      RAISE EXCEPTION
        'record_service_token_issued: % is not an Administrator, so it cannot be recorded as '
        'having issued a service token.', v_actor
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- 'user', which log_digital_thread_event() refuses from a REQUEST HEADER for good reason --
    -- claiming a human author is the assertion a client must not make about itself. It is written
    -- here only after the claim has been checked against user_roles above.
    v_source := 'user';
  END IF;

  -- WHAT THE TOKEN COULD DO AT THE MOMENT IT WAS SIGNED, captured rather than left to a join. An
  -- audit row readable only by joining to a live row loses its meaning in exactly the cases it
  -- matters most -- and a role removed later does not shorten a token signed while it was held.
  SELECT coalesce(array_agg(r.name ORDER BY r.name), '{}'::text[])
    INTO v_roles
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_principal_id::text;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'service_principals',
    p_principal_id,
    'TOKEN_MINTED',
    NULL,
    jsonb_build_object(
      'jti',          p_jti,
      'issued_at',    now(),
      'expires_at',   p_expires_at,
      'ttl_days',     round(v_ttl_days, 1),
      'roles',        to_jsonb(v_roles),
      -- Asserted by the caller and labelled as such; the database cannot verify either value. Only
      -- these two are lifted out of p_context, so a caller cannot add fields that look authoritative.
      -- Empty for a mint from the page; the attribution is in `changed_by`.
      'claimed',      jsonb_build_object(
                        'os_user', p_context ->> 'os_user',
                        'host',    p_context ->> 'host'
                      )
    ),
    v_actor,
    v_source,
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.record_service_token_issued(uuid, text, timestamptz, jsonb, uuid) IS
  'Record that a long-lived JWT was signed for a service principal, as a TOKEN_MINTED row in '
  'digital_thread. Refuses a human account and any expiry beyond service_token_max_days(). With '
  'p_actor_id NULL the row is attributed to ''service'' with no changed_by, which is how the host '
  'scripts record. With an actor it is re-checked against user_roles for Administrator and the row '
  'names that person -- the shape mint-service-token uses.';

-- Unchanged from 0043: reachable by a session, because the host scripts present a service key and
-- the edge function presents the caller's. The guards above are what decide, not the grant.
REVOKE ALL ON FUNCTION public.record_service_token_issued(uuid, text, timestamptz, jsonb, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_service_token_issued(uuid, text, timestamptz, jsonb, uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
