-- 0308: A revoked credential stays revoked until a new one is issued.
--
-- The platform's record of a gateway's broker credential is read in three places that must agree:
-- the dashboard's credentialState() and enrolmentStands(), and gateway_has_broker_credential() in the
-- database. The dashboard counts an enrolment only while no revocation came after it, and a
-- CREDENTIAL_ISSUED row only while none came after it. For a Host, Simulated or Third-party gateway
-- the database read it that way. For a Remote gateway it counted enrolled_at whatever the stamp said.
--
--   * gateway_has_broker_credential() counts a Remote gateway's enrolment only while no revocation
--     came after it: enrolled_at is set and credential_revoked_at is empty or older. The arm for
--     Host, Simulated and Third-party gateways is as 0196 has it.
--
-- Reasoning: supabase/README.md, "A revoked credential stays revoked until a new one is issued (0308)".
-- Idempotent.
--
-- Redefines public.gateway_has_broker_credential: 0308 counts a Remote gateway's enrolment only while
--   no revocation came after it, as the dashboard does; 0196 counted it whatever the stamp said

-- -------------------------------------------------------------------------------------------------
-- 1. A Remote enrolment a revocation outranks is not a credential held
-- -------------------------------------------------------------------------------------------------
-- 0196's body with the Remote arm narrowed, and nothing else changed. Read by
-- revoke_credential_on_decommission(), clean_up_after_a_gateway_type_change(), the revocation sweep
-- and the Edit form's Type hint.
CREATE OR REPLACE FUNCTION public.gateway_has_broker_credential(g public.gateways) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT
        (g.deployment = 'remote' AND g.enrolled_at IS NOT NULL
            AND (g.credential_revoked_at IS NULL OR g.enrolled_at > g.credential_revoked_at))
     OR (g.deployment IN ('host', 'third_party') AND EXISTS (
            SELECT 1 FROM public.audit_trail dt
             WHERE dt.entity_type = 'gateways'
               AND dt.entity_id   = g.id
               AND dt.action      = 'CREDENTIAL_ISSUED'
               AND (g.credential_revoked_at IS NULL OR dt.recorded_at > g.credential_revoked_at)
        ));
$$;

ALTER FUNCTION public.gateway_has_broker_credential(g public.gateways) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gateway_has_broker_credential(g public.gateways) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gateway_has_broker_credential(g public.gateways) TO authenticated, service_role;

COMMENT ON FUNCTION public.gateway_has_broker_credential(g public.gateways) IS 'Does an account exist at the broker for this gateway, by either route it can arrive -- a Remote appliance completing enrolment, or the CREDENTIAL_ISSUED row a Host or Third-party mint leaves -- minus revocation: an enrolment or an issue older than credential_revoked_at is not counted. Cannot admit a gateway that never held one, which is what lets revocation use it without creating accounts through the add-only credential service (0063).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_row jsonb := jsonb_build_object('id', gen_random_uuid(), 'deployment', 'remote');
BEGIN
  IF has_function_privilege('anon', 'public.gateway_has_broker_credential(public.gateways)', 'EXECUTE') THEN
    RAISE EXCEPTION '0308: anon may execute gateway_has_broker_credential()';
  END IF;

  -- A Remote gateway holds a credential from its enrolment until a revocation comes after it.
  IF NOT public.gateway_has_broker_credential(jsonb_populate_record(NULL::public.gateways,
       v_row || jsonb_build_object('enrolled_at', now() - interval '1 hour'))) THEN
    RAISE EXCEPTION '0308: gateway_has_broker_credential() does not count an enrolment no revocation followed';
  END IF;
  IF NOT public.gateway_has_broker_credential(jsonb_populate_record(NULL::public.gateways,
       v_row || jsonb_build_object('enrolled_at', now() - interval '10 minutes',
                                   'credential_revoked_at', now() - interval '1 hour'))) THEN
    RAISE EXCEPTION '0308: gateway_has_broker_credential() does not count an enrolment that came after the revocation';
  END IF;
  IF public.gateway_has_broker_credential(jsonb_populate_record(NULL::public.gateways,
       v_row || jsonb_build_object('enrolled_at', now() - interval '1 hour',
                                   'credential_revoked_at', now() - interval '10 minutes'))) THEN
    RAISE EXCEPTION '0308: gateway_has_broker_credential() counts an enrolment a revocation followed';
  END IF;
  IF public.gateway_has_broker_credential(jsonb_populate_record(NULL::public.gateways, v_row)) THEN
    RAISE EXCEPTION '0308: gateway_has_broker_credential() counts a Remote gateway that never enrolled';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
