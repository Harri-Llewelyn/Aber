-- =============================================================================================
-- 0043_record_service_token_issued.sql
--
-- Record that a long-lived JWT was signed for a service principal, as a `TOKEN_MINTED` row in
-- `digital_thread`. Roadmap §13.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS EXISTS, AND IT IS NOT CONVENIENCE
--
-- `scripts/mint-mcp-token.mjs` states the constraint that governs this whole feature:
--
--     THERE IS NO REVOCATION: PostgREST checks the signature, not a session table. Revoking means
--     rotating SUPABASE_JWT_SECRET, which invalidates every token in the stack including the anon
--     and service_role keys.
--
-- That was surveyed before this was written and it holds. Deleting the `auth.users` row does not
-- help -- PostgREST validates the signature and never looks the subject up. Removing the role does
-- not help either: 0034 records that the relations the i3X address space is assembled from are
-- `FOR SELECT TO authenticated USING (true)`, so a role-less principal still reads them. A
-- `revoked_at` predicate would have to be added to every RLS policy in the schema.
--
-- SO `exp` IS THE ONLY BOUND THAT EXISTS, AND KNOWING WHAT IS OUTSTANDING IS THE ENTIRE SAFETY
-- STORY. That is what this row is for. Not an audit trail in the ordinary sense -- an inventory of
-- credentials nobody can take back.
--
-- ---------------------------------------------------------------------------------------------
-- WHY IT CANNOT BE GATED ON has_role(), UNLIKE 0041's PAIR
--
-- The caller is a host script authenticating with SUPABASE_SERVICE_ROLE_KEY, and `has_role()`
-- resolves through `auth.uid()`, which is NULL for that key. This is the same wall
-- `provision-gateways.mjs` hits, and the same one that makes a demonstration floor's credentials
-- unrecorded.
--
-- The precedent is `record_ingestion_rejection()` (0026), which is exactly this shape: revoked from
-- PUBLIC, reachable by service_role alone, with `actor_source` PINNED rather than taken from a
-- header. Its comment applies here verbatim -- "this function is the daemon's only route into the
-- table, and what it records about the author is not negotiable by its caller."
--
-- THE CONSEQUENCE IS STATED RATHER THAN PAPERED OVER: this row cannot name a person. It records
-- that a host process signed a token, and the host and OS user it CLAIMS to be running as are
-- stored under a `claimed` key precisely because the database cannot verify either. A field named
-- `issued_by` would have read as an attribution; `claimed.os_user` reads as what it is.
--
-- ---------------------------------------------------------------------------------------------
-- THE EXPIRY CEILING IS ENFORCED HERE TOO, AND THAT IS NOT BELT-AND-BRACES
--
-- The script caps `--days` at 90 and refuses higher. This refuses the same thing, and because the
-- script RECORDS BEFORE IT PRINTS, a refusal here means the token is never handed to anyone: the
-- signing already happened in memory, but the operator gets an error instead of a credential.
--
-- So this is not a duplicated check. It is the one that holds if the script is edited, replaced, or
-- called by something else entirely -- and given that what it is bounding cannot be revoked, the
-- ceiling belongs where it cannot be edited by whoever is in a hurry.
-- =============================================================================================

SET search_path TO public;

-- The same ceiling the script enforces. Declared once here and cited in the script's own comment,
-- so a change to one is visibly a change to the other rather than a silent divergence.
CREATE OR REPLACE FUNCTION public.service_token_max_days()
RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$ SELECT 90 $$;

COMMENT ON FUNCTION public.service_token_max_days() IS
  'The longest life a service-principal token may be recorded with (90 days). Mirrored by the '
  '--days ceiling in scripts/mint-mcp-token.mjs; these tokens cannot be revoked, so the expiry is '
  'the only bound that exists.';


CREATE OR REPLACE FUNCTION public.record_service_token_issued(
  p_principal_id uuid,
  p_jti          text,
  p_expires_at   timestamptz,
  p_context      jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_roles    text[];
  v_is_service boolean;
  v_ttl_days numeric;
  v_id       bigint;
BEGIN
  IF p_principal_id IS NULL THEN
    RAISE EXCEPTION 'record_service_token_issued: p_principal_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- A `jti` DOES NOT ENABLE REVOCATION and nothing here pretends otherwise. It exists so two
  -- tokens for one principal can be told apart -- so an operator holding a token can check whether
  -- it is the one this row describes, and so a re-mint is visibly a second credential rather than
  -- a replacement. Bounded because it lands in an append-only table that cannot be pruned.
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

  -- THE CEILING. See the header: the script refuses this too, and because it records before it
  -- prints, a refusal here means the token never reaches anybody.
  v_ttl_days := extract(epoch FROM (p_expires_at - now())) / 86400.0;
  IF v_ttl_days > public.service_token_max_days() THEN
    RAISE EXCEPTION
      'record_service_token_issued: a token may not outlive % days (asked for %). These tokens '
      'cannot be revoked -- rotating SUPABASE_JWT_SECRET is the only way to invalidate one, and '
      'that invalidates every token in the stack.',
      public.service_token_max_days(), round(v_ttl_days, 1)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- THE SUBJECT MUST BE A SERVICE PRINCIPAL, using 0042's predicate: no email and no password means
  -- no way to authenticate through GoTrue, so the only thing that can present this identity is a
  -- JWT signed outside it.
  --
  -- REFUSING A HUMAN ACCOUNT IS THE POINT OF THIS CHECK. A 90-day non-expiring-in-practice token
  -- minted against an Administrator's login would be a permanent, unrevocable escalation of that
  -- person's session -- and it would be recorded here as routine.
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
      'principal. A long-lived token for it could not be revoked.', p_principal_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- WHAT THE TOKEN COULD DO AT THE MOMENT IT WAS SIGNED, captured rather than left to a join. 0026
  -- gives the reason: an audit row readable only by joining to a live row loses its meaning in
  -- exactly the cases it matters most -- and a role removed later does not shorten a token that
  -- was signed while it was held.
  SELECT coalesce(array_agg(r.name ORDER BY r.name), '{}'::text[])
    INTO v_roles
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_principal_id::text;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    -- NOT A TABLE NAME, which every other entity_type is. There is no public table of service
    -- principals -- they are auth.users rows, and auth is GoTrue's schema. DigitalThreadTab
    -- renders this type explicitly for that reason; see the note there.
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
      'claimed',      jsonb_build_object(
                        'os_user', p_context ->> 'os_user',
                        'host',    p_context ->> 'host'
                      )
    ),
    -- NULL, like 0026's. There is no person here to name: the caller holds a machine credential.
    NULL,
    -- PINNED, not taken from a header. 'user' is refused from a header by
    -- log_digital_thread_event() precisely because claiming a human author is the assertion a
    -- client must not be able to make about itself; the same reasoning applies to a function.
    'service',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.record_service_token_issued(uuid, text, timestamptz, jsonb) IS
  'Record that a long-lived JWT was signed for a service principal, as a TOKEN_MINTED row in '
  'digital_thread. Refuses a human account and any expiry beyond service_token_max_days(). '
  'actor_source is pinned to ''service'' and changed_by to NULL: the caller holds a machine '
  'credential, so the row cannot name a person and does not pretend to.';

REVOKE ALL ON FUNCTION public.record_service_token_issued(uuid, text, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_service_token_issued(uuid, text, timestamptz, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.service_token_max_days() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_token_max_days() TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- ASSERTS THE REFUSAL, not the success. That a valid call writes a row is exercised by the script
-- every time it runs; that an INVALID one is refused is the property nothing else tests, and it is
-- the one standing between this function and a permanent unrevocable token on a person's account.
--
-- Run against a real human account rather than a synthetic one, so it fails if the predicate stops
-- meaning what its name says -- the same reason 0042 checks `auth.identities` rather than trusting
-- the email column.
DO $selfcheck$
DECLARE
  v_human uuid;
  v_ok    boolean := false;
BEGIN
  SELECT id INTO v_human FROM auth.users
   WHERE email IS NOT NULL AND encrypted_password IS NOT NULL AND encrypted_password <> ''
   ORDER BY id LIMIT 1;

  IF v_human IS NULL THEN
    -- CI applies the migrations and never runs seed.sql, so there may be no human account to try
    -- this against. Skipped rather than failed: a self-check that cannot run must not block a boot.
    RAISE NOTICE '0043 self-check skipped: no sign-in-capable account to test the refusal against.';
    RETURN;
  END IF;

  BEGIN
    PERFORM public.record_service_token_issued(v_human, 'selfcheck', now() + interval '1 day');
  EXCEPTION WHEN invalid_parameter_value THEN
    v_ok := true;
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION
      '0043 self-check: a token was recorded against %, an account that CAN SIGN IN. The service '
      'principal predicate has stopped meaning "cannot authenticate".', v_human;
  END IF;

  RAISE NOTICE '0043 self-check passed: a token cannot be recorded against a person''s account.';
END;
$selfcheck$;

NOTIFY pgrst, 'reload schema';
