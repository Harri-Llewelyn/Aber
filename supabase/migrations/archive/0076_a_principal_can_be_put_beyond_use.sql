-- =============================================================================================
-- 0076_a_principal_can_be_put_beyond_use.sql
--
-- Revocation for a whole service principal, not one of its tokens. The `auth.users` row is
-- flagged, not deleted: `digital_thread.changed_by` references it, and the history of a revoked
-- principal is the part most worth keeping.
--
-- A flag nothing reads would change nothing, so it is enforced where 0074 put the token
-- denylist, `auth_pre_request()`, keyed on the `sub` claim.
--
-- Both the principal flag and each outstanding jti are denylisted. The tokens are redundant for
-- PostgREST and not for the audit trail (a TOKEN_REVOKED row per token says what was withdrawn)
-- or for reinstatement: lifting the flag restores the identity, not the tokens that were live,
-- and `revoke_service_token()` has no inverse.
--
-- A person's account is refused: `sub` is on every JWT, and a table that could name a person
-- could lock an Administrator out of PostgREST, including out of undoing it.
-- `is_machine_principal()` is checked in the RPC, not trusted from the caller.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- The flag
-- ---------------------------------------------------------------------------------------------
-- Not self-pruning, unlike revoked_service_tokens: a principal has no expiry, and a row that
-- vanished on a timer would readmit the identity. Bounded by the number of service principals.
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
  -- The principal denylist, checked first
  -- ------------------------------------------------------------------------------------------
  -- The order is about the message: after a principal revocation both arms match, and "this
  -- identity has been revoked" is the fact that explains both. The cast is guarded because `sub`
  -- is a claim, and a bare cast on a malformed one would abort every request through this hook.
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
  -- A token with no `jti` (every human session, the anon and service_role keys) is unrevokable by
  -- this arm and must still be served. The subject arm above does not share that exemption.
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

-- Revoked from PUBLIC first: a GRANT on a function whose ACL is NULL materialises the default
-- EXECUTE-to-PUBLIC and preserves it. All four grantees are revoked and re-granted in one fixed
-- order because pg_dump renders an ACL in array order and check-migration-idempotency.mjs
-- compares a digest of the dump; this is the only function in `public` that `anon` reaches, so
-- 0001's sweep and this file would otherwise order the array differently on the first and
-- second boots. `anon` keeps its grant: PostgREST runs this hook as the request's role.
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
  -- Redundant for PostgREST and not for the audit trail or for reinstatement; see the header.
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
-- Without this the page would sign a credential that is refused on its first request. Here
-- rather than in 0075 so the guard sits beside the table it reads.
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

-- Revoked from PUBLIC first, as the two RPCs above are: `anon` is a member of PUBLIC, so a GRANT
-- on its own narrows nothing. The function is invoker-rights, so the leak was not an escalation,
-- but validate.py's check 13a demands an empty set so a real finding cannot hide.
REVOKE ALL ON FUNCTION public.assert_principal_not_revoked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_principal_not_revoked(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
