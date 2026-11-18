-- 0310: A change of type on an archived gateway clears the status the old type left.
--
-- clean_up_after_a_gateway_type_change() (0252) returned at once for an archived gateway. That is
-- right for the setup tokens and the credential, which archiving ended. It is wrong for the status:
-- an archived Remote gateway that never enrolled keeps PENDING_ENROLLMENT when its type is changed
-- to Host, so a restore brings it back reading Awaiting setup, the state 0252 clears for a gateway
-- that is not archived. The Edit dialog is not offered for an archived gateway and a proposal cannot
-- carry a type, so only a direct write through the API reaches the case.
--
--   * clean_up_after_a_gateway_type_change() does the status part of the clean-up whether or not the
--     gateway is archived: one that becomes Remote, or leaves Remote mid-enrolment, reads OFFLINE.
--     The setup tokens and the credential steps stay skipped for an archived gateway. The body is
--     0252's with its early return narrowed to those two steps.
--
-- Reasoning: supabase/README.md, "A change of type on an archived gateway clears the old status
-- (0310)". Idempotent.
--
-- Redefines public.clean_up_after_a_gateway_type_change: 0310 sets OFFLINE the status of an archived
--   gateway whose type crosses Remote's boundary, as it does for one that is not archived; 0252
--   returned before the status for an archived gateway

-- -------------------------------------------------------------------------------------------------
-- 1. The status follows the type, archived or not
-- -------------------------------------------------------------------------------------------------
-- SECURITY DEFINER because the Manager changing the type has no grant on the token table, Vault
-- or revoke_gateway_credential(). BEFORE, so the status and the revocation stamp are written by
-- the UPDATE that changes the type, and the Audit Trail holds one row for the whole act.
CREATE OR REPLACE FUNCTION public.clean_up_after_a_gateway_type_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- `UPDATE OF` fires whenever a column is in the SET list, and the Edit form sends both on every
  -- save. A change among Host, Simulated and Third-party crosses nothing: all three hold a
  -- credential issued in the dashboard.
  IF (OLD.deployment = 'remote') = (NEW.deployment = 'remote') THEN
    RETURN NEW;
  END IF;

  -- An archived gateway's setup tokens were burned and its credential ended when it was archived.
  IF OLD.is_archived IS NOT TRUE THEN
    -- The setup command the old type was issued, burned as archiving burns it. Entering Remote finds
    -- none unless an earlier change left one, and a fresh token is issued by Set up.
    UPDATE public.gateway_enrollment_tokens
       SET consumed_at = now()
     WHERE gateway_id = NEW.id
       AND consumed_at IS NULL;

    -- Asked about OLD: gateway_has_broker_credential() decides by the row's deployment, and NEW
    -- would be asked for the new type's record, which a gateway that has just changed type lacks.
    IF public.gateway_has_broker_credential(OLD) THEN
      IF public.revoke_gateway_credential(OLD.sparkplug_id) THEN
        -- Stamped optimistically, as archiving stamps it: net.http_post is asynchronous.
        NEW.credential_revoked_at := now();
      END IF;
    END IF;

    -- The copy an Administrator could show again was of the credential just ended. A Remote gateway
    -- keeps none, so this deletes nothing on the way out of Remote.
    DELETE FROM vault.secrets WHERE name = 'gateway_broker_password:' || OLD.id::text;
  END IF;

  -- A Remote gateway waits OFFLINE until Set up issues a token. One that leaves Remote mid-enrolment
  -- reads as a new gateway of its type does; any other status is the gateway's own word.
  IF NEW.deployment = 'remote' OR NEW.status IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH') THEN
    NEW.status := 'OFFLINE';
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION public.clean_up_after_a_gateway_type_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clean_up_after_a_gateway_type_change() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.clean_up_after_a_gateway_type_change() IS 'Trigger function: when a gateway''s type crosses Remote''s boundary, burns its unredeemed enrolment tokens, revokes the broker credential the OLD row holds (gateway_has_broker_credential) and stamps credential_revoked_at, forgets the kept copy of a dashboard-issued password, and sets OFFLINE a gateway that becomes Remote or leaves Remote mid-enrolment. An archived gateway had its tokens and credential ended when it was archived, so only its status follows (0310). A change among Host, Simulated and Third-party ends nothing (0252).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_src text;
  v_def text;
BEGIN
  IF has_function_privilege('anon', 'public.clean_up_after_a_gateway_type_change()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.clean_up_after_a_gateway_type_change()', 'EXECUTE') THEN
    RAISE EXCEPTION '0310: a browser-facing role may execute clean_up_after_a_gateway_type_change()';
  END IF;

  -- The status step stands outside the archived gateway's skip, and the token and credential steps
  -- inside it.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.clean_up_after_a_gateway_type_change()'::regprocedure;
  IF position('OLD.is_archived IS NOT TRUE' IN v_src) = 0
     OR position('OLD.is_archived IS NOT TRUE' IN v_src) > position('gateway_enrollment_tokens' IN v_src)
     OR position('OLD.is_archived IS NOT TRUE' IN v_src) > position('revoke_gateway_credential' IN v_src)
     OR position('NEW.status := ''OFFLINE''' IN v_src) < position('vault.secrets' IN v_src) THEN
    RAISE EXCEPTION '0310: clean_up_after_a_gateway_type_change() does not skip the tokens and the credential for an archived gateway and set its status';
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.gateways'::regclass
     AND t.tgname = 'trg_gateways_type_change_cleans_up';
  IF v_def IS NULL OR position('BEFORE UPDATE OF deployment, is_simulated' IN v_def) = 0 THEN
    RAISE EXCEPTION '0310: trg_gateways_type_change_cleans_up is not BEFORE UPDATE OF deployment, is_simulated (found %)', v_def;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
