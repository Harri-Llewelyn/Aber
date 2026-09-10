-- =============================================================================================
-- 0074_a_token_can_finally_be_taken_back.sql
--
-- Revocation for the long-lived service tokens 0043 records. This adds no mint; it adds the
-- control that makes one ordinary.
--
-- WHY A PRE-REQUEST HOOK. Deleting the `auth.users` row does nothing (PostgREST validates the
-- signature and never looks the subject up); removing the role does nothing that matters (the
-- i3X relations are `FOR SELECT TO authenticated USING (true)`); a `revoked_at` predicate would
-- have to be added to every RLS policy. PostgREST's `db-pre-request` runs a function in the
-- caller's role before every request and can RAISE, which is the single choke point. The `jti`
-- every minted token already records is the key.
--
-- WHAT THIS DOES NOT REACH. storage, realtime, the edge runtime and Studio verify the JWT
-- secret for themselves and never consult this hook. The MCP reader and `Service_Ingestor`
-- reach PostgREST and nothing else, so for a machine principal this is the only door; a
-- person's session is revocable through GoTrue's refresh tokens instead.
--
-- FAIL-CLOSED IS THE RISK. A function that runs before every request is a single point of
-- failure, so `auth_pre_request()` raises for exactly one reason (a jti in the denylist) and
-- returns quietly for no claims, unparseable claims and a token with no jti, which is every
-- human session and the anon and service_role keys.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- The denylist
-- ---------------------------------------------------------------------------------------------
-- Self-pruning: a revoked token past its own `exp` is already refused by the signature check,
-- so `revoke_service_token()` prunes such rows on the way past and the per-request lookup stays
-- bounded. Not audit: `digital_thread` holds the history.
CREATE TABLE IF NOT EXISTS public.revoked_service_tokens (
  -- THE PRIMARY KEY IS THE LOOKUP. Every request that carries a jti does one index probe on this
  -- and nothing else, which is the entire cost of the control.
  jti           text        PRIMARY KEY,
  principal_id  uuid        NOT NULL,
  -- The token's own `exp`, copied from the TOKEN_MINTED row. Bounded by 0043's ceiling, so no row
  -- here can outlive service_token_max_days() from the day it was minted.
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz NOT NULL DEFAULT now(),
  -- The Administrator who did it. NULL only if a revocation ever arrives without a session, which
  -- the RPC below refuses -- so in practice this is always somebody.
  revoked_by    uuid
);

COMMENT ON TABLE public.revoked_service_tokens IS
  'Unexpired service-token jtis that public.auth_pre_request() refuses. Operational, not audit: '
  'rows are pruned once the token they name has expired, because the signature check refuses it '
  'from then on. The permanent record is the TOKEN_REVOKED row in digital_thread.';

ALTER TABLE public.revoked_service_tokens ENABLE ROW LEVEL SECURITY;

-- Read is Administrator and Auditor, matching the `security` audit domain. No insert, update or
-- delete policy: the only writer is revoke_service_token(), which is SECURITY DEFINER.
-- DROP then CREATE, because `CREATE POLICY` has no `IF NOT EXISTS` and this replays every boot.
DROP POLICY IF EXISTS revoked_service_tokens_select_privileged ON public.revoked_service_tokens;
CREATE POLICY revoked_service_tokens_select_privileged
  ON public.revoked_service_tokens
  FOR SELECT TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Auditor']));

-- A policy narrows a granted privilege; it does not confer one. Without this GRANT every caller
-- gets `permission denied`. `authenticated` only, matching `digital_thread`.
GRANT SELECT ON public.revoked_service_tokens TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- The choke point
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_pre_request()
RETURNS void
LANGUAGE plpgsql
-- SECURITY DEFINER so the denylist needs no policy for `anon` and `authenticated`. The function
-- returns nothing and answers no question the caller asked, so it leaks nothing about the table:
-- a caller learns only whether their OWN request proceeded, which they were going to find out.
SECURITY DEFINER
-- STABLE, not VOLATILE: it writes nothing, and it lets the planner treat the probe as the cheap
-- read it is.
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_claims text;
  v_jti    text;
BEGIN
  -- NO CLAIMS IS THE COMMON CASE, NOT AN ANOMALY. Every unauthenticated request arrives here with
  -- this GUC unset -- the `true` argument is what makes that return NULL instead of raising.
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN
    RETURN;
  END IF;

  BEGIN
    v_jti := (v_claims::jsonb) ->> 'jti';
  EXCEPTION WHEN others THEN
    -- CLAIMS THAT WILL NOT PARSE ARE NOT THIS FUNCTION'S BUSINESS. PostgREST has already
    -- validated the signature to get here, so malformed JSON in this GUC is a PostgREST-side
    -- surprise rather than an attack this can meaningfully answer -- and raising would take the
    -- whole API down over a condition that has nothing to do with revocation.
    RETURN;
  END;

  -- A TOKEN WITH NO `jti` IS UNREVOKABLE AND MUST STILL BE SERVED. Every human session, the anon
  -- key and the service_role key are in this branch. Refusing them would be a total outage, and
  -- it is the single most likely way for this function to be got wrong.
  IF v_jti IS NULL OR v_jti = '' THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.revoked_service_tokens
     -- THE EXPIRY PREDICATE IS BELT AND BRACES. Pruning should mean no expired row is ever here,
     -- and a token past its `exp` is refused by the signature check before this runs -- so this
     -- can only matter if both of those fail at once, which is exactly when a false positive
     -- would be hardest to diagnose.
     WHERE jti = v_jti AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'this token has been revoked'
      USING ERRCODE = 'insufficient_privilege',
            -- NAMES THE jti, WHICH THE HOLDER ALREADY HAS. It is the one detail that turns
            -- "my integration broke" into "this specific credential was withdrawn", and it is in
            -- the token they presented -- so it discloses nothing and saves the support round
            -- trip this control would otherwise generate.
            DETAIL = 'jti ' || v_jti,
            HINT   = 'This credential was withdrawn by an Administrator. Minting a new token is '
                     'the only way back; the revoked one cannot be reinstated.';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.auth_pre_request() IS
  'PostgREST db-pre-request hook: aborts the request when the caller''s JWT carries a jti that '
  'has been revoked and has not yet expired. Returns quietly for every other condition -- no '
  'claims, unparseable claims, or a token with no jti -- because those are the ordinary majority '
  'and refusing them would take the whole API down.';

-- Every role PostgREST switches to; omitting one is an outage for that role alone. Revoked from
-- PUBLIC first: a GRANT on a function whose ACL is NULL materialises PostgreSQL's default
-- EXECUTE-to-PUBLIC and preserves it, so without the REVOKE the first and second boots
-- produce different schemas, which check-migration-idempotency.mjs refuses. `anon` keeps its
-- grant: PostgREST runs this hook as the request's role, and for an unauthenticated request
-- that role is `anon`.
REVOKE ALL ON FUNCTION public.auth_pre_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_pre_request() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- The act
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_service_token(p_jti text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor     uuid;
  v_mint      jsonb;
  v_principal uuid;
  v_expires   timestamptz;
  v_id        bigint;
BEGIN
  -- Administrator alone: withdrawing a credential is an access-control act, not an operational one.
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to revoke a service token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    -- THE AUDIT ROW MUST NAME SOMEBODY. has_role() above cannot pass without a session, so this
    -- is unreachable in practice and is here so that it stays unreachable: a future caller that
    -- found a way past the role check would still not be able to revoke anonymously.
    RAISE EXCEPTION 'revoke_service_token: no session, so this revocation could not be attributed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_jti IS NULL OR length(p_jti) = 0 OR length(p_jti) > 64 THEN
    RAISE EXCEPTION 'revoke_service_token: p_jti must be 1-64 characters (got %)',
      coalesce(length(p_jti)::text, 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The mint row is the source of the principal and the expiry; requiring it stops this table
  -- filling with jtis nobody issued. Newest first, so the choice is defined.
  SELECT dt.new_data INTO v_mint
    FROM public.digital_thread dt
   WHERE dt.entity_type = 'service_principals'
     AND dt.action = 'TOKEN_MINTED'
     AND dt.new_data ->> 'jti' = p_jti
   ORDER BY dt.id DESC
   LIMIT 1;

  IF v_mint IS NULL THEN
    RAISE EXCEPTION
      'revoke_service_token: no TOKEN_MINTED record for jti %. Only a token this stack recorded '
      'issuing can be revoked here.', p_jti
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT dt.entity_id INTO v_principal
    FROM public.digital_thread dt
   WHERE dt.entity_type = 'service_principals'
     AND dt.action = 'TOKEN_MINTED'
     AND dt.new_data ->> 'jti' = p_jti
   ORDER BY dt.id DESC
   LIMIT 1;

  v_expires := (v_mint ->> 'expires_at')::timestamptz;

  IF v_expires <= now() THEN
    -- REFUSED AS A NO-OP RATHER THAN ACCEPTED QUIETLY. The signature check already refuses this
    -- token, so a row would be pruned on its way in and the operator would be told a credential
    -- was withdrawn when nothing changed. Saying so is the honest answer and costs them nothing.
    RAISE EXCEPTION
      'revoke_service_token: the token % expired on % and is already refused by the signature '
      'check. There is nothing to revoke.', p_jti, v_expires
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- SELF-PRUNING, DONE HERE BECAUSE THIS IS THE ONLY WRITE PATH. A background job would be a
  -- second moving part for a table that is only touched when somebody revokes something, and the
  -- work is bounded by how many tokens were revoked in the last 90 days.
  DELETE FROM public.revoked_service_tokens WHERE expires_at <= now();

  -- IDEMPOTENT. Revoking twice is something an operator will do -- the button is in a page that
  -- refreshes -- and the second press should confirm rather than fail. The audit row below is
  -- still written, because "somebody pressed revoke" is true both times.
  INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at, revoked_by)
  VALUES (p_jti, v_principal, v_expires, v_actor)
  ON CONFLICT (jti) DO NOTHING;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'service_principals',
    v_principal,
    'TOKEN_REVOKED',
    -- THE MINT ROW GOES IN `old_data`, which is what makes this row readable on its own. 0026's
    -- argument: an audit row that needs a join to a live row loses its meaning in exactly the
    -- cases it matters most, and the denylist entry this describes is pruned the moment the token
    -- expires.
    v_mint,
    jsonb_build_object(
      'jti',        p_jti,
      'revoked_at', now(),
      'expires_at', v_expires,
      -- WHAT THE REVOCATION ACTUALLY REACHES, recorded on the row rather than left to the reader.
      -- Four services verify the secret for themselves and never consult this denylist, so a row
      -- claiming a token was revoked without saying where would overstate what happened.
      'scope',      'postgrest'
    ),
    v_actor,
    'user',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.revoke_service_token(text) IS
  'Administrator-only. Adds a minted token''s jti to the denylist auth_pre_request() consults, and '
  'records a TOKEN_REVOKED row. Refuses a jti with no TOKEN_MINTED record and one that has already '
  'expired. Reaches PostgREST only -- storage, realtime, the edge runtime and Studio verify the '
  'JWT secret independently.';

REVOKE ALL ON FUNCTION public.revoke_service_token(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_service_token(text) TO authenticated;
