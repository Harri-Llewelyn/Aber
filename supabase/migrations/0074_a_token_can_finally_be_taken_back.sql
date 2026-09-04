-- =============================================================================================
-- 0074_a_token_can_finally_be_taken_back.sql
--
-- Revocation for the long-lived service tokens 0043 has been recording since the day it shipped.
--
-- THE REVOCABLE-TOKENS ROADMAP ITEM, AND ONLY THE HALF THAT MAKES THE OTHER HALF SAFE. That item
-- has since shipped and left the list, so it is named rather than numbered here -- its number was
-- reused the moment it went. It was explicit about the order: *"Revocation is the item and the buttons are its consequence."* A mint button was
-- designed and refused once already, and the refusal is quoted there because it is the whole
-- design constraint -- *"technically neat, and it would have made an unrevocable credential a
-- button press with a tidy audit trail of a thing nobody can undo. Solving the wrong half well is
-- worse than not solving it, because the clean implementation reads as safety."* So this file
-- adds NO mint. It adds the control that makes one ordinary.
--
-- ---------------------------------------------------------------------------------------------
-- THE FOURTH REVOCATION DESIGN. THE FIRST THREE DO NOT WORK, AND 0043 SAYS WHY.
--
--   * DELETING THE `auth.users` ROW does nothing. PostgREST validates the signature and never
--     looks the subject up, so the token keeps working against a principal that no longer exists.
--   * REMOVING THE ROLE does nothing that matters. The relations the i3X address space is
--     assembled from are `FOR SELECT TO authenticated USING (true)`, so a token with no role at
--     all still reads them.
--   * A `revoked_at` PREDICATE would have to be added to EVERY RLS policy in the schema, and a
--     revocation that is only as good as its least-updated policy is not one.
--
-- The fourth is PostgREST's `db-pre-request`: a function named in configuration, run in the
-- caller's role before every request, which can RAISE and abort it. It is the single choke point
-- the third design lacked and it touches no policy at all. `postgrest/postgrest:v14.12` supports
-- it and `PGRST_DB_PRE_REQUEST` is unset on both targets, so nothing is being displaced.
--
-- AND THE KEY IT NEEDS HAS BEEN IN THE INVENTORY SINCE 0043. `mint-mcp-token.mjs` stamps a `jti`
-- from `randomUUID()` and hands it to `record_service_token_issued()`; `rotate-service-keys.mjs`
-- does the same for the ingestion and playback keys. Every token this can revoke has been
-- recording the exact identifier a denylist needs, for an inventory that could not act on it.
-- 0043's own comment says a jti *"DOES NOT ENABLE REVOCATION and nothing here pretends
-- otherwise."* That sentence stops being true here, and 0043 is left alone rather than edited:
-- it was accurate when written, and rewriting history to match the present is how a reader loses
-- the ability to trust any of it.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS DOES NOT REACH, STATED HERE RATHER THAN DISCOVERED LATER.
--
-- A pre-request function is invisible to everything that verifies `SUPABASE_JWT_SECRET` for
-- itself, and four services do: `supabase-storage`, `supabase-realtime`, the edge runtime (which
-- boots `VERIFY_JWT="false"` and authorises per function), and Studio.
--
-- THAT IS COMPLETE COVERAGE FOR WHAT THIS IS ACTUALLY ABOUT, and the gap should not be left
-- looking accidental. The MCP reader and `Service_Ingestor` reach PostgREST and nothing else, so
-- for a MACHINE principal the choke point is the only door. For a person's session it is not --
-- and a person's session is already revocable through GoTrue's refresh tokens, which is a
-- different mechanism for a different problem.
--
-- ---------------------------------------------------------------------------------------------
-- FAIL-CLOSED IS THE RISK, AND IT IS THE REASON THIS FUNCTION IS SHAPED THE WAY IT IS.
--
-- A function that runs before EVERY PostgREST request is a single point of failure by
-- construction. If it raises when it should not, the entire API is down -- the correct direction
-- for a security control and an outage all the same. So `auth_pre_request()` raises for exactly
-- one reason, a jti present in the denylist, and returns quietly for every other condition it can
-- meet: no claims at all (the anon key), claims that will not parse, a token carrying no jti
-- (every human session, and the anon and service_role keys). Those are not errors and must not be
-- treated as suspicious -- they are the overwhelming majority of requests this stack serves.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- The denylist
-- ---------------------------------------------------------------------------------------------
-- SELF-PRUNING BY CONSTRUCTION, WHICH IS WHAT BOUNDS IT. A revoked token past its own `exp` is
-- already refused by the signature check, so its row does no work and can go. `expires_at` is
-- carried for exactly that reason -- it is the token's own expiry, not a retention policy -- and
-- `revoke_service_token()` prunes on the way past. Without this the table grows forever and the
-- lookup this adds to every request grows with it.
--
-- NOT AUDIT. `digital_thread` is where the history lives, appended by the RPC below and
-- unpruneable by design. This is an OPERATIONAL table whose only job is to answer one question
-- quickly, and deleting a dead row from it loses nothing a reader could want.
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

-- READ IS ADMINISTRATOR AND AUDITOR, matching the `security` audit domain these events file
-- under. There is deliberately NO insert, update or delete policy: the only writer is
-- revoke_service_token() below, which is SECURITY DEFINER, so a policy granting write here would
-- widen the surface without enabling anything the RPC does not already do properly.
-- DROP THEN CREATE, because every migration here is REPLAYED ON EVERY BOOT and `CREATE POLICY`
-- has no `IF NOT EXISTS`. Without this, the second `docker compose up` fails db-init with
-- `policy "..." already exists` -- which takes the whole stack down, since every service that
-- depends on db-init completing never starts. The same shape appears throughout 0069 and 0001.
DROP POLICY IF EXISTS revoked_service_tokens_select_privileged ON public.revoked_service_tokens;
CREATE POLICY revoked_service_tokens_select_privileged
  ON public.revoked_service_tokens
  FOR SELECT TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Auditor']));

-- THE POLICY IS DEAD WITHOUT THIS, and the failure does not look like a missing grant. A policy
-- narrows a privilege that has been granted; it does not confer one. Without the GRANT every
-- caller -- Administrator included -- gets `permission denied for table revoked_service_tokens`,
-- so the page that should list withdrawn credentials shows an error to exactly the person
-- entitled to read it, and the policy above reads as though it were working.
--
-- `authenticated` ONLY, matching `digital_thread`: `anon` is granted nothing at all, so an
-- unauthenticated caller cannot learn that a credential was withdrawn or when it lapses.
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

-- EVERY ROLE POSTGREST SWITCHES TO, and the omission of one is an outage for that role alone --
-- which is the kind of partial failure that gets diagnosed as anything but this function.
-- REVOKED FROM PUBLIC, GRANTED TO anon -- AND THOSE ARE NOT THE SAME GRANTEE.
--
-- PostgreSQL gives every new function EXECUTE to PUBLIC. Issuing a GRANT on a function whose ACL is
-- still NULL MATERIALISES that default first and then adds to it, so the GRANT below does not
-- replace PUBLIC's entry -- it preserves it. Measured on a database booted exactly once, before
-- this line existed:
--
--     auth_pre_request  {=X/postgres,postgres=X/postgres,service_role=X/postgres,anon=X/postgres,...}
--                        ^^^^^^^^^^^ PUBLIC
--
-- and on the same chain booted twice, where 0001's section 6 sweep has since removed it. TWO BOOTS
-- OF THE SAME FILES PRODUCED TWO DIFFERENT SCHEMAS, which is what check-migration-idempotency.mjs
-- refuses -- it caught this as `REVOKE ALL ON FUNCTION public.auth_pre_request() FROM PUBLIC;`
-- appearing in the second dump and not the first.
--
-- Revoking PUBLIC here settles it on boot one instead. `anon` KEEPS its explicit grant, which it
-- must: PostgREST runs this hook after switching to the request's role, and for an unauthenticated
-- request that role is `anon`. Revoking anon as the sibling functions do would take the whole
-- anonymous API down.
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
  -- ADMINISTRATOR ALONE, which is the sixth policy in the direction the retired revocable-tokens roadmap item describes:
  -- `system_settings` for read and for write, `list_service_principals()` and
  -- `create_service_principal()` are the five that already separate Administrator from
  -- Shopfloor_Manager by hand. Withdrawing a credential is an access-control act, not an
  -- operational one.
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

  -- THE MINT ROW IS THE SOURCE OF THE PRINCIPAL AND THE EXPIRY, and requiring it is what stops
  -- this table filling with jtis nobody issued. A caller cannot revoke a token this stack has no
  -- record of minting -- and if one exists, the missing record is the more urgent problem.
  --
  -- NEWEST FIRST: a jti is a randomUUID and collision is not a practical concern, but ordering
  -- makes the choice defined rather than incidental.
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
