-- =============================================================================================
-- 0076_a_principal_can_be_put_beyond_use.sql
--
-- Revocation for a whole service PRINCIPAL, not one of its tokens.
--
-- THE LAST OPEN BULLET OF ROADMAP ITEM 3, which asks: *"Whether revoking a principal deletes its
-- `auth.users` row or flags it. Flagging it and revoking its outstanding tokens is the
-- recommendation: deleting orphans the `digital_thread` attribution, and the history of a revoked
-- principal is the part most worth keeping."* That recommendation is followed here, and the
-- reasoning holds up: `digital_thread.changed_by` is a foreign key to `auth.users`, so deleting the
-- row would either fail against its own audit trail or, with a cascade, erase who did what.
--
-- ---------------------------------------------------------------------------------------------
-- A FLAG THAT NOTHING READS IS THE EXACT TRAP 0043 ALREADY DOCUMENTED.
--
-- 0043 rejected deleting the `auth.users` row because *"the signature is validated and the subject
-- never looked up"* -- the token keeps working against a principal that no longer exists. A flag
-- has PRECISELY the same problem: writing `revoked_at` somewhere changes nothing on its own, and
-- would ship a control that reads as safety while every outstanding token carried on working.
--
-- So the flag is enforced where 0074 put the token denylist -- `auth_pre_request()`, PostgREST's
-- `db-pre-request` hook -- and keyed on the `sub` claim. That is what makes this a revocation
-- rather than an annotation.
--
-- ---------------------------------------------------------------------------------------------
-- WHY BOTH, WHEN THE SUBJECT CHECK ALONE WOULD COVER THE TOKENS.
--
-- Revoking the principal refuses every token naming it, including ones this stack has no
-- TOKEN_MINTED row for. So denylisting each outstanding jti as well is redundant *for PostgREST*.
-- It is not redundant for two other things:
--
--   * THE AUDIT TRAIL. A TOKEN_REVOKED row per token is what says which credentials were actually
--     withdrawn on the day. `PRINCIPAL_REVOKED` alone would leave a reader to work out what was
--     outstanding at that moment, from an append-only log, after the fact.
--   * REINSTATEMENT. Lifting the principal flag must not resurrect credentials that were live when
--     it was revoked -- an operator reinstating an identity is restoring the IDENTITY, not handing
--     back whatever tokens happened to exist. Because the tokens are separately denylisted, they
--     stay withdrawn, and `revoke_service_token()` has no inverse to undo that.
--
-- That composition is why reinstatement can exist at all without being dangerous.
--
-- ---------------------------------------------------------------------------------------------
-- A PERSON'S ACCOUNT IS REFUSED, AND THAT IS A SAFETY PROPERTY RATHER THAN TIDINESS.
--
-- `sub` is on every JWT, a human session included. If this table could name a person, an
-- Administrator could be locked out of PostgREST entirely through a control built for machines --
-- and, since the same hook then refuses the request that would undo it, locked out of undoing it.
-- `is_machine_principal()` (0042) is the guard, and it is checked in the RPC rather than trusted
-- from the caller.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- The flag
-- ---------------------------------------------------------------------------------------------
-- NOT SELF-PRUNING, UNLIKE revoked_service_tokens, and the difference is real rather than an
-- oversight. A token row can go once the token expires, because the signature check refuses it
-- from then on. A principal has no expiry: it is revoked until somebody reinstates it, and a row
-- that vanished on a timer would silently readmit the identity. The table is bounded by the number
-- of service principals, which is single digits.
CREATE TABLE IF NOT EXISTS public.revoked_service_principals (
  principal_id  uuid        PRIMARY KEY,
  revoked_at    timestamptz NOT NULL DEFAULT now(),
  revoked_by    uuid,
  -- Free text, and the only field an operator supplies. Recorded because "why" is the question a
  -- reader of this table will have and the audit row is where it would otherwise have to be found.
  reason        text
);

COMMENT ON TABLE public.revoked_service_principals IS
  'Service principals that public.auth_pre_request() refuses by subject. Not self-pruning: a '
  'principal has no expiry, so a row stays until reinstate_service_principal() removes it. The '
  'permanent record is the PRINCIPAL_REVOKED / PRINCIPAL_REINSTATED rows in digital_thread.';

ALTER TABLE public.revoked_service_principals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS revoked_service_principals_select_privileged
  ON public.revoked_service_principals;
CREATE POLICY revoked_service_principals_select_privileged
  ON public.revoked_service_principals
  FOR SELECT TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Auditor']));

-- A policy narrows a granted privilege; it does not confer one. Without this every caller --
-- Administrator included -- gets `permission denied`, and the policy above reads as though it were
-- working. 0074 shipped with exactly that defect for one commit.
GRANT SELECT ON public.revoked_service_principals TO authenticated;


-- ---------------------------------------------------------------------------------------------
-- The choke point learns a second question
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_claims text;
  v_jti    text;
  v_sub    text;
BEGIN
  -- NO CLAIMS IS THE COMMON CASE, NOT AN ANOMALY. Every unauthenticated request arrives here with
  -- this GUC unset -- the `true` argument is what makes that return NULL instead of raising.
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN
    RETURN;
  END IF;

  BEGIN
    v_jti := (v_claims::jsonb) ->> 'jti';
    v_sub := (v_claims::jsonb) ->> 'sub';
  EXCEPTION WHEN others THEN
    -- CLAIMS THAT WILL NOT PARSE ARE NOT THIS FUNCTION'S BUSINESS. PostgREST has already validated
    -- the signature to get here, so malformed JSON in this GUC is a PostgREST-side surprise rather
    -- than an attack this can meaningfully answer -- and raising would take the whole API down
    -- over a condition that has nothing to do with revocation.
    RETURN;
  END;

  -- ------------------------------------------------------------------------------------------
  -- The principal denylist (0076), CHECKED FIRST
  -- ------------------------------------------------------------------------------------------
  -- THE ORDER IS ABOUT THE MESSAGE, NOT ABOUT CORRECTNESS -- either arm refuses the request, so
  -- the outcome is identical and only the explanation differs. Revoking a principal CASCADES to
  -- its outstanding tokens, so after one both arms match, and with the token arm first the holder
  -- was told "this token has been revoked" -- true, and the least useful of the two true answers.
  -- It invites them to ask for a replacement, which the mint then refuses for a reason they have
  -- not been told. "This identity has been revoked" is the fact that explains both.
  --
  -- THE CAST IS GUARDED, because `sub` is a claim and this function must not raise on a malformed
  -- one. PostgREST puts whatever the JWT carried into the GUC; a token signed elsewhere with
  -- `sub: "hello"` would abort every request through this hook if the cast were bare -- turning a
  -- junk token presented by one caller into a total outage for everybody.
  IF v_sub IS NOT NULL AND v_sub <> '' THEN
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.revoked_service_principals WHERE principal_id = v_sub::uuid
      ) THEN
        RAISE EXCEPTION 'this identity has been revoked'
          USING ERRCODE = 'insufficient_privilege',
                DETAIL = 'principal ' || v_sub,
                HINT   = 'The service principal this token names was withdrawn by an '
                         'Administrator. Every token naming it is refused, including ones issued '
                         'afterwards, until the principal is reinstated.';
      END IF;
    EXCEPTION
      -- RE-RAISED, NOT SWALLOWED. Only the CAST is being guarded here; the refusal above must
      -- travel. Catching everything would make the control silently fail open, which is the one
      -- failure mode a denylist must not have.
      WHEN insufficient_privilege THEN RAISE;
      WHEN invalid_text_representation THEN NULL;
    END;
  END IF;

  -- ------------------------------------------------------------------------------------------
  -- The token denylist (0074)
  -- ------------------------------------------------------------------------------------------
  -- A TOKEN WITH NO `jti` IS UNREVOKABLE BY THIS ARM AND MUST STILL BE SERVED. Every human
  -- session, the anon key and the service_role key are in that case. The subject arm above does
  -- NOT share that exemption, which is the point of having it: a principal revocation reaches a
  -- token this stack never recorded.
  IF v_jti IS NOT NULL AND v_jti <> '' AND EXISTS (
    SELECT 1 FROM public.revoked_service_tokens
     WHERE jti = v_jti AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'this token has been revoked'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'jti ' || v_jti,
            HINT   = 'This credential was withdrawn by an Administrator. Minting a new token is '
                     'the only way back; the revoked one cannot be reinstated.';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.auth_pre_request() IS
  'PostgREST db-pre-request hook: aborts the request when the caller''s JWT carries a revoked jti '
  '(0074) or names a revoked service principal (0076). Returns quietly for every other condition '
  '-- no claims, unparseable claims, a token with no jti, a sub that is not a uuid -- because '
  'those are the ordinary majority and refusing them would take the whole API down.';

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
-- ALL FOUR GRANTEES REVOKED AND RE-GRANTED IN ONE FIXED ORDER, which is stronger than it looks
-- and is about the DUMP rather than about privilege.
--
-- An ACL is an ordered array, and pg_dump renders it in that order, so two boots that arrive at the
-- same PERMISSIONS by different routes still produce different SQL -- and
-- check-migration-idempotency.mjs compares a sha256 of the dump, so a pure reordering fails it
-- while reporting no added or removed line at all.
--
-- The routes genuinely differ, because this is the only function in `public` that `anon` is meant
-- to reach. 0001's section 6 sweep strips PUBLIC and anon from every function and then restores
-- only the `authenticated` and `service_role` grants it found, so `anon` is re-added afterwards by
-- the GRANT below and lands LAST -- but only from the second boot onwards, since on the first this
-- function does not exist when 0001 runs. Measured:
--
--     boot 1       {postgres, service_role, anon, authenticated}
--     boot 2+      {postgres, service_role, authenticated, anon}
--
-- Revoking all three roles here empties the array to `{postgres}` whatever preceded it, so the
-- three GRANTs below always append in the same order. This is the last declaration of the function
-- in the chain, so its ordering is the one that survives.
--
-- ANON KEEPS ITS GRANT, which it must: PostgREST runs this hook after switching to the request's
-- role, and for an unauthenticated request that role is `anon`. Revoking anon as the sibling
-- functions do would take the whole anonymous API down, /ping included.
REVOKE ALL ON FUNCTION public.auth_pre_request()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_pre_request() TO anon, authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- The act
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_service_principal(
  p_principal_id uuid,
  p_reason       text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor  uuid;
  v_tokens int := 0;
  v_id     bigint;
  v_row    record;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to revoke a service principal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'revoke_service_principal: no session, so this could not be attributed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_principal_id IS NULL THEN
    RAISE EXCEPTION 'revoke_service_principal: p_principal_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- A PERSON'S ACCOUNT IS REFUSED. `sub` is on every JWT, so a row here naming a human would lock
  -- them out of PostgREST through a control built for machines -- and out of the request that
  -- would undo it. Revoking a person's access is a different act with different tools: remove
  -- their role, or disable the account in GoTrue.
  IF NOT public.is_machine_principal(p_principal_id) THEN
    RAISE EXCEPTION
      'revoke_service_principal: % is not a service principal. It either does not exist or it can '
      'sign in, and locking a person out through the machine denylist would also refuse the '
      'request that reinstated them.', p_principal_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- SELF-REVOCATION IS IMPOSSIBLE BY CONSTRUCTION rather than by a check: has_role() above needs
  -- an Administrator, and is_machine_principal() refuses anything that can sign in, so the actor
  -- and the target can never be the same row. Said here because its absence looks like an omission.

  IF EXISTS (SELECT 1 FROM public.revoked_service_principals WHERE principal_id = p_principal_id) THEN
    RAISE EXCEPTION 'revoke_service_principal: % is already revoked', p_principal_id
      USING ERRCODE = 'unique_violation',
            HINT = 'Reinstate it first if the intent is to change the recorded reason.';
  END IF;

  INSERT INTO public.revoked_service_principals (principal_id, revoked_by, reason)
  VALUES (p_principal_id, v_actor, nullif(btrim(coalesce(p_reason, '')), ''));

  -- ------------------------------------------------------------------------------------------
  -- Every outstanding token as well, which is what makes reinstatement safe
  -- ------------------------------------------------------------------------------------------
  -- Redundant for PostgREST -- the subject arm already refuses them -- and NOT redundant for the
  -- audit trail or for reinstatement. See the header. Each is denylisted individually so that
  -- lifting the principal flag later does not hand back credentials that were live today.
  FOR v_row IN
    SELECT DISTINCT ON (dt.new_data ->> 'jti')
           dt.new_data ->> 'jti'                     AS jti,
           (dt.new_data ->> 'expires_at')::timestamptz AS expires_at
      FROM public.digital_thread dt
     WHERE dt.entity_type = 'service_principals'
       AND dt.action = 'TOKEN_MINTED'
       AND dt.entity_id = p_principal_id
       AND dt.new_data ->> 'jti' IS NOT NULL
       AND (dt.new_data ->> 'expires_at')::timestamptz > now()
     ORDER BY dt.new_data ->> 'jti', dt.id DESC
  LOOP
    INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at, revoked_by)
    VALUES (v_row.jti, p_principal_id, v_row.expires_at, v_actor)
    ON CONFLICT (jti) DO NOTHING;

    IF FOUND THEN
      v_tokens := v_tokens + 1;
      INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
      ) VALUES (
        'service_principals', p_principal_id, 'TOKEN_REVOKED', NULL,
        jsonb_build_object('jti', v_row.jti, 'revoked_at', now(),
                           'expires_at', v_row.expires_at, 'scope', 'postgrest',
                           -- WHY THIS ONE WAS WITHDRAWN, so a reader of a lone TOKEN_REVOKED row
                           -- is not left to correlate timestamps to discover it was collateral.
                           'cascaded_from', 'PRINCIPAL_REVOKED'),
        v_actor, 'user', txid_current(), now()
      );
    END IF;
  END LOOP;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'service_principals',
    p_principal_id,
    'PRINCIPAL_REVOKED',
    NULL,
    jsonb_build_object(
      'revoked_at',      now(),
      'reason',          nullif(btrim(coalesce(p_reason, '')), ''),
      'tokens_revoked',  v_tokens,
      -- THE SUBJECT ARM REACHES FURTHER THAN THE TOKEN COUNT SUGGESTS, and the row should not
      -- imply otherwise: tokens this stack never recorded are refused too, and so is anything
      -- minted afterwards.
      'scope',           'postgrest'
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

COMMENT ON FUNCTION public.revoke_service_principal(uuid, text) IS
  'Administrator-only. Flags a service principal so auth_pre_request() refuses every token naming '
  'it, and denylists its outstanding tokens individually so reinstating the principal does not '
  'restore them. Refuses a human account. Reaches PostgREST only.';

REVOKE ALL ON FUNCTION public.revoke_service_principal(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_service_principal(uuid, text) TO authenticated;


-- ---------------------------------------------------------------------------------------------
-- Putting it back
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reinstate_service_principal(p_principal_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid;
  v_id    bigint;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to reinstate a service principal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'reinstate_service_principal: no session, so this could not be attributed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM public.revoked_service_principals WHERE principal_id = p_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reinstate_service_principal: % is not revoked', p_principal_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'service_principals',
    p_principal_id,
    'PRINCIPAL_REINSTATED',
    NULL,
    -- SAID ON THE ROW, because it is the thing most likely to be assumed wrong. Reinstating
    -- restores the IDENTITY, not its credentials: every token withdrawn when it was revoked stays
    -- withdrawn, because revoke_service_token() has no inverse. A new token must be minted.
    jsonb_build_object(
      'reinstated_at',  now(),
      'tokens_restored', 0,
      'note', 'Tokens revoked with this principal remain revoked; mint a new one.'
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

COMMENT ON FUNCTION public.reinstate_service_principal(uuid) IS
  'Administrator-only. Lifts the flag revoke_service_principal() set, so the identity can hold '
  'tokens again. Does NOT restore the tokens revoked alongside it -- those stay withdrawn and a '
  'new one must be minted.';

REVOKE ALL ON FUNCTION public.reinstate_service_principal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reinstate_service_principal(uuid) TO authenticated;


-- ---------------------------------------------------------------------------------------------
-- A revoked principal cannot be issued a new token
-- ---------------------------------------------------------------------------------------------
-- WITHOUT THIS THE PAGE WOULD OFFER A MINT THAT PRODUCES A DEAD CREDENTIAL. The subject arm
-- refuses anything naming a revoked principal, so a token issued now would be signed, recorded,
-- returned, pasted into a client -- and refused on its first request, with the operator having
-- followed the page to get there. Refusing at the point of issue is the only place that reads as
-- a decision rather than a fault.
--
-- ADDED HERE RATHER THAN IN 0075 so the guard sits beside the mechanism it depends on; 0075 has no
-- knowledge of this table.
CREATE OR REPLACE FUNCTION public.assert_principal_not_revoked(p_principal_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.revoked_service_principals WHERE principal_id = p_principal_id) THEN
    RAISE EXCEPTION
      'principal % has been revoked, so a token for it would be refused on its first request. '
      'Reinstate it before issuing one.', p_principal_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- REVOKED FROM PUBLIC FIRST, as revoke_service_principal() and reinstate_service_principal() above
-- both are. PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and `anon` is a
-- member of PUBLIC -- so a GRANT on its own does not narrow anything, it merely restates a
-- permission everybody already had. This one was written without the REVOKE and leaked to `anon`,
-- which validate.py's check 13a caught on the first end-to-end run.
--
-- NOT AN ESCALATION, AND STILL WORTH FIXING. The function is invoker-rights, so an anonymous caller
-- reaching it gets `permission denied for table revoked_service_principals` -- 0076 grants that
-- table to `authenticated` only. What it costs is the baseline: check 13a demands an EMPTY set
-- precisely so that a real finding cannot hide among harmless ones, and every entry that is
-- "harmless, because of something else" erodes exactly that property.
REVOKE ALL ON FUNCTION public.assert_principal_not_revoked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_principal_not_revoked(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
