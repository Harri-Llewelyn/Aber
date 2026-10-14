-- 0183: Only a Playback gateway's broker password is delivered to the playback worker.
--
-- gateway_is_playback_delivery_target() answered is_simulated, so issuing any Simulated gateway's
-- credential also merged its password into the file the playback worker reads. A playback can only
-- target an is_shadow gateway (playback_target_must_be_shadow(), the BEFORE INSERT trigger on
-- playback_jobs), so the worker held the password of every Node-RED simulator and could use none
-- of them. The predicate now answers is_shadow on an unarchived gateway.
--
-- playback_delivery_targets() lists the gateways that answer true. gateway-credential passes the
-- list with each delivery, and the credential service drops every delivered password whose gateway
-- is not on it, so a password delivered under the old predicate, or for a gateway since archived,
-- goes at the next delivery.
--
-- Reasoning: supabase/README.md, "0078 makes issuing a playback credential also deliver it".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The predicate
-- -------------------------------------------------------------------------------------------------
-- 0001's signature, return type and role check; only the answer changes. CREATE OR REPLACE keeps
-- 0001's grants (authenticated, service_role).
CREATE OR REPLACE FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_target boolean;
BEGIN
  -- The same allow-list as the authorisation gate, re-checked here: authorisation must not rest on
  -- a check made only by the component that also acts on the answer.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to resolve a playback delivery target'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- is_shadow is what playback_target_must_be_shadow() admits a job by. An archived gateway's
  -- account is disabled, so it is no target. False for a gateway that does not exist: "do not
  -- deliver" is the safe answer to a row deleted between the two calls.
  SELECT is_shadow AND NOT is_archived INTO v_target FROM public.gateways WHERE id = p_gateway_id;

  RETURN coalesce(v_target, false);
END;
$$;

COMMENT ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) IS
  'Whether a freshly-issued broker credential for this gateway may be DELIVERED to the playback '
  'worker: an unarchived is_shadow gateway, the target playback_target_must_be_shadow() admits '
  '(0183; it answered is_simulated before, which delivered every simulator''s password). '
  'playback_delivery_targets() lists the gateways it is true for. Deliberately NOT a column on '
  'authorize_host_gateway_credential(): 0001 redeclares that function on every boot and CREATE OR '
  'REPLACE cannot change a return type, which aborts the whole chain at file one.';

-- -------------------------------------------------------------------------------------------------
-- 2. The set it is true for
-- -------------------------------------------------------------------------------------------------
-- Read by gateway-credential, in the caller's session, beside the predicate, so the credential
-- service can drop a delivered password whose gateway is no longer a target. Filtered through the
-- predicate, so the two cannot disagree.
CREATE OR REPLACE FUNCTION public.playback_delivery_targets() RETURNS TABLE(sparkplug_id text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to list playback delivery targets'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT g.sparkplug_id
      FROM public.gateways g
     WHERE public.gateway_is_playback_delivery_target(g.id)
     ORDER BY g.sparkplug_id;
END;
$$;

ALTER FUNCTION public.playback_delivery_targets() OWNER TO postgres;

COMMENT ON FUNCTION public.playback_delivery_targets() IS
  'The sparkplug_ids of every gateway gateway_is_playback_delivery_target() is true for (0183). '
  'gateway-credential passes them with each delivery, and the credential service keeps a delivered '
  'password only for a gateway on this list. Administrator or Shopfloor_Manager, as the predicate.';

REVOKE ALL ON FUNCTION public.playback_delivery_targets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.playback_delivery_targets() TO authenticated, service_role;
