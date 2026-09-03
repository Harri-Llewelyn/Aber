-- =============================================================================================
-- 0075_a_mint_can_name_the_person_who_asked.sql
--
-- `record_service_token_issued()` gains an ACTOR, so a token minted from the Access Control page
-- records the Administrator who asked for it.
--
-- THE SECOND HALF OF ROADMAP ITEM 3. 0074 built revocation, which is what the item says has to
-- come first -- *"Build revocation first and the same RPC stops being a hazard."* The hazard is
-- gone, so the mint can exist; this is the database's part of it.
--
-- ---------------------------------------------------------------------------------------------
-- THE MINT ITSELF IS NOT HERE, AND THE ROADMAP'S SKETCH FOR IT DOES NOT WORK.
--
-- Item 3 proposes a SECURITY DEFINER RPC that signs the JWT in the database: *"pgjwt is installed
-- and `extensions.sign()` exists, so a SECURITY DEFINER RPC could mint one today with no new
-- dependency and no secret leaving the database."* The extension is indeed installed. The premise
-- underneath it is false: **SUPABASE_JWT_SECRET is not in the database.** There is no
-- `app.settings.jwt_secret`, and Vault holds four secrets, none of them this one. Nothing in this
-- database can sign a token PostgREST would accept, and that is a property worth keeping rather
-- than an oversight to correct.
--
-- Putting it in Vault would work mechanically, and `nodered_webhook_jwt_secret` looks like a
-- precedent for it. IT IS NOT ONE, AND THE DIFFERENCE IS THE WHOLE ARGUMENT. That key signs
-- 60-second tokens that only Node-RED's webhook endpoint accepts; its blast radius is one
-- consumer. SUPABASE_JWT_SECRET signs ANYTHING -- including a `service_role` token, which is valid
-- at storage, realtime, the edge runtime and Studio, and which 0074 CANNOT REVOKE because
-- `auth_pre_request()` is a PostgREST hook and those four never consult it. Storing it here would
-- mean any path to SQL execution becomes a path to an unrevocable god credential.
--
-- SO THE SIGNING LIVES IN AN EDGE FUNCTION, `mint-service-token`, which already holds JWT_SECRET
-- and holds it for this purpose. That is also the shape this repository already uses for exactly
-- this kind of act -- `enroll-gateway` and `gateway-credential` mint a secret, reveal it once, and
-- record the issue before returning it -- and the OpenAPI tag for that group says so outright:
-- "Edge Functions: privileged server-side operations."
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE SIGNATURE CHANGES RATHER THAN A SECOND FUNCTION APPEARING.
--
-- 0043 pins `changed_by` to NULL and `actor_source` to 'service', and its comment gives the
-- reason: *"There is no person here to name: the caller holds a machine credential."* That was
-- true of every caller it had -- `mint-mcp-token.mjs` and `rotate-service-keys.mjs` both run on
-- the host with a service key and no session.
--
-- IT IS NO LONGER TRUE OF EVERY CALLER. A mint from the page is a person's act, and an audit row
-- that cannot say whose is the weaker record precisely where the act is more sensitive.
--
-- A SECOND RECORDER WAS THE OBVIOUS ALTERNATIVE AND IS WORSE. Every guard in this function is
-- security-critical -- the 90-day ceiling, the refusal of a human account, the roles snapshot --
-- and two copies of them is two things to keep in step with no test that would notice a drift.
-- One function with an optional actor keeps a single set of guards.
--
-- DROP AND RECREATE RATHER THAN AN OVERLOAD, because a defaulted fifth argument alongside the
-- existing four-argument form makes a four-argument call AMBIGUOUS -- Postgres refuses it, and
-- the failure would land on the two scripts rather than here. Both scripts call this over
-- PostgREST with NAMED arguments (`p_principal_id`, `p_jti`, `p_expires_at`, `p_context`), which
-- resolve against the new signature unchanged, so neither needs an edit.
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

  -- A `jti` NOW DOES ENABLE REVOCATION, WHICH IT DID NOT WHEN 0043 WROTE THIS COMMENT. The
  -- original said it exists only so two tokens for one principal can be told apart, and that
  -- *"A `jti` DOES NOT ENABLE REVOCATION and nothing here pretends otherwise."* 0074 made it the
  -- key of the denylist `auth_pre_request()` reads, so this identifier is now the thing a
  -- revocation is performed against. Still bounded, for the same reason: it lands in an
  -- append-only table that cannot be pruned.
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

  -- THE SUBJECT MUST BE A SERVICE PRINCIPAL, using 0042's predicate: no email and no password
  -- means no way to authenticate through GoTrue, so the only thing that can present this identity
  -- is a JWT signed outside it.
  --
  -- REFUSING A HUMAN ACCOUNT IS THE POINT OF THIS CHECK. A long-lived token minted against an
  -- Administrator's login would be a permanent escalation of that person's session -- and it would
  -- be recorded here as routine.
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

  -- ---------------------------------------------------------------------------------------------
  -- THE ACTOR IS RE-CHECKED HERE, NOT TRUSTED.
  --
  -- `mint-service-token` verifies the caller's session and resolves their role before it signs
  -- anything, so this is the second of two checks -- exactly the arrangement approve_quarantined_device
  -- uses, and for the reason its caller records: authorisation must not rest solely on a check made
  -- in a function that also holds the signing key. An edge worker that skipped its own check, or
  -- was reached some other way, still cannot produce an attributed mint for a non-Administrator.
  --
  -- REFUSED RATHER THAN DOWNGRADED TO NULL. Recording the row as though a machine had asked would
  -- hide the more interesting fact -- that something claimed an actor it could not substantiate.
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
      -- ASSERTED BY THE CALLER AND LABELLED AS SUCH. The database cannot verify either value, and
      -- a key called `issued_by` would have read as an attribution. Only these two are lifted out
      -- of p_context: storing it wholesale would let a caller add fields that look authoritative.
      --
      -- EMPTY FOR A MINT FROM THE PAGE, which is correct -- there is no host shell to name, and
      -- the actual attribution is in `changed_by` where it can be trusted.
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
