-- 0078: the authorisation gate also says whether a credential may be delivered to the playback
-- worker, so issuing one from the Gateways page is the whole act.
--
-- The worker does not mint its own credentials: holding the credential service's token is the
-- ability to publish as any gateway on the site. Minting stays a human act with an audit row and
-- only delivery is automated, which makes "which credentials may be delivered" a security
-- boundary answered here, because `is_simulated` is the database's fact. It is the same
-- predicate `start_playback_job()` uses, so a gateway that can never be a playback target can
-- never have its password delivered to the playback worker.
-- See docs/incidents.md and ingestion/README.md -> "Issuing a playback credential delivers it".

-- =================================================================================================
-- A SEPARATE FUNCTION, not a third column on `authorize_virtual_gateway_credential()`: a later
-- migration may redeclare a function 0001 declares but must not change its return type, because
-- 0001 re-declares its own form first on every boot with CREATE OR REPLACE and aborts the chain
-- on the second boot (check-docs-drift.mjs enforces this). The cost is a second round trip from
-- the edge function.

CREATE OR REPLACE FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid)
RETURNS boolean
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_simulated boolean;
BEGIN
  -- The same allow-list as the authorisation gate, re-checked here: authorisation must not rest on
  -- a check made only by the component that also acts on the answer.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to resolve a playback delivery target'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT is_simulated INTO v_simulated FROM public.gateways WHERE id = p_gateway_id;

  -- False for a gateway that does not exist, rather than an exception: "do not deliver" is the safe
  -- answer to a row deleted between the two calls. Coalesced though is_simulated is NOT NULL today,
  -- so relaxing the constraint later cannot silently change what is delivered.
  RETURN coalesce(v_simulated, false);
END;
$$;

COMMENT ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) IS
  'Whether a freshly-issued broker credential for this gateway may be DELIVERED to the playback worker. is_simulated -- the same predicate start_playback_job() gates on, so the set of passwords the worker can hold is exactly the set of gateways it may publish as. Deliberately NOT a column on authorize_virtual_gateway_credential(): 0001 redeclares that function on every boot and CREATE OR REPLACE cannot change a return type, which aborts the whole chain at file one.';

REVOKE ALL ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) TO authenticated;

-- =================================================================================================
-- SELF-CHECK: the delivery predicate and the job gate must not drift apart, or the worker would be
-- handed credentials for gateways it can no longer target. Read-only, asserting the source, so it
-- passes on an empty stack.
DO $check$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'start_playback_job';

  IF v_src IS NULL THEN
    RAISE EXCEPTION
      '0078: start_playback_job() is missing, so the delivery predicate has nothing to agree with.';
  END IF;

  IF position('is_simulated' IN v_src) = 0 THEN
    RAISE EXCEPTION
      '0078: start_playback_job() no longer mentions is_simulated, but this migration delivers '
      'playback credentials on exactly that predicate. One of the two moved without the other -- '
      'reconcile them before this ships, or the worker is handed credentials for gateways it may '
      'not target.';
  END IF;

  RAISE NOTICE
    '0078: delivery is scoped to is_simulated, which start_playback_job() still gates on.';
END
$check$;
