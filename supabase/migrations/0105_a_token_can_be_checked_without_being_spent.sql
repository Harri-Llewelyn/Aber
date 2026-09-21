-- 0105: an enrolment token can be checked without being spent.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- The one-liner commissioning path (docs/remote-gateways.md) fetches three things from the
-- platform before it enrols: the installer, the platform playbook and the appliance's .env, each
-- authorised by the enrolment token in a header. Fetching must validate the token and must not
-- consume it: consuming is `consume_gateway_enrollment_token()` (0001), the one act that also
-- issues the broker credential, and a token spent by a download would leave the appliance with
-- its files and no way to enrol. So this is that function's read-only twin: the same shape check,
-- the same four refusals (unknown, expired, consumed, archived gateway) answered identically with
-- no rows, and no UPDATE. It says whether the token is live now; a second caller can still spend
-- it first, and enrolment's own claim decides that race.
--
-- service_role alone, like the consumer: the gateway-install edge function calls it with the
-- service key, and a signed-in user who could call it could enumerate which token values exist.
-- =================================================================================================

CREATE OR REPLACE FUNCTION public.peek_gateway_enrollment_token(p_token text)
    RETURNS TABLE(gateway_id uuid, sparkplug_id text, sparkplug_group text, gateway_name text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_hash text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  RETURN QUERY
  SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.name, t.expires_at
    FROM public.gateway_enrollment_tokens t
    JOIN public.gateways g ON g.id = t.gateway_id
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
     AND NOT g.is_archived;
END $$;

COMMENT ON FUNCTION public.peek_gateway_enrollment_token(p_token text) IS
    'Whether an enrolment token is live now, and for which gateway, WITHOUT consuming it: the read-only twin of consume_gateway_enrollment_token(), answering the same four refusals with no rows. Called by the gateway-install edge function with the service-role key to authorise the installer, playbook and .env downloads; only enrolment spends the token.';

REVOKE EXECUTE ON FUNCTION public.peek_gateway_enrollment_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.peek_gateway_enrollment_token(text) TO service_role;

-- -------------------------------------------------------------------------------------------------
-- Self-check
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_problems text[] := ARRAY[]::text[];
BEGIN
    IF has_function_privilege('anon', 'public.peek_gateway_enrollment_token(text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.peek_gateway_enrollment_token(text)', 'EXECUTE') THEN
        v_problems := v_problems || 'peek_gateway_enrollment_token() is callable by a browser-facing role'::text;
    END IF;
    IF NOT has_function_privilege('service_role', 'public.peek_gateway_enrollment_token(text)', 'EXECUTE') THEN
        v_problems := v_problems || 'peek_gateway_enrollment_token() is not callable by service_role'::text;
    END IF;
    IF array_length(v_problems, 1) > 0 THEN
        RAISE EXCEPTION '0105 self-check failed: %', array_to_string(v_problems, '; ');
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
