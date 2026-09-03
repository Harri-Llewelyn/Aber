-- 0078: the authorisation gate also says whether the credential may be DELIVERED to the playback
-- worker, so that issuing one from the Gateways page is the whole act rather than the first half.
--
-- =================================================================================================
-- WHAT WAS BROKEN, MEASURED ON A RUNNING STACK RATHER THAN REASONED ABOUT
--
-- The Playback gateway is `gwy16...`. The broker's password file held one gateway account and it
-- was `gwy11...`, belonging to a gateway deleted long ago. `gateway_has_broker_credential()`
-- answered false. The worker held a password out of `.env` for `gwy16...` that nothing had ever
-- issued, and connecting with it returned:
--
--     CONNACK rc = 5, Connection Refused: not authorised
--
-- So playback could not have worked, and nothing said so: the password in `.env` looked exactly
-- like configuration, `mosquitto.conf` runs `allow_anonymous false`, and Sparkplug publishes at
-- QoS 0 -- no PUBACK -- so beyond the CONNECT there is nothing for a publisher to notice.
--
-- =================================================================================================
-- WHY DELIVERY IS A SEPARATE QUESTION FROM ISSUANCE, AND WHY THE DATABASE ANSWERS IT
--
-- The obvious fix is to let the playback worker mint its own credentials. It was rejected. The
-- credential service's own header states what holding its token means:
--
--     "any workload that can reach this port can mint a broker account for any edge node -- and
--      because mosquitto.acl confines an account to spBv1.0/+/+/%u/#, that is the ability to
--      publish telemetry as any gateway on the site."
--
-- and `playback_worker._credentials()` names itself TIER TWO OF THREE precisely because "the worker
-- cannot authenticate as a gateway whose password it was not given". A minting worker is a worker
-- that can publish as any machine on the shopfloor, which is the tier deleted.
--
-- So minting stays a human, Administrator-or-Shopfloor_Manager act with an audit row, and only the
-- DELIVERY is automated. That makes "which credentials may be delivered" a security boundary, and
-- it is answered here rather than in the edge function or the credential service because
-- `is_simulated` is the database's fact. The credential service knows only a `sparkplug_id` and has
-- no database access by design; a worker deciding which passwords it is allowed to receive would be
-- deciding its own blast radius.
--
-- THE SAME PREDICATE THE JOB GATE USES, NOT A SECOND ONE. `start_playback_job()` "refuses a target
-- that is not is_simulated" -- tier one. Delivery is scoped to exactly that set, so a gateway that
-- could never be a playback target can never have its password delivered to the playback worker.
-- Two definitions of "is this a playback target" would eventually disagree, and the disagreement
-- would be a real gateway's password sitting in a file the replay worker reads.

DROP FUNCTION IF EXISTS public.authorize_virtual_gateway_credential(uuid);

CREATE OR REPLACE FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid)
RETURNS TABLE(sparkplug_id text, gateway_name text, is_playback_target boolean)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
BEGIN
  -- Fail closed, and before anything observable happens. The same allow-list as the write policies
  -- on `gateways` and as 0025's issuing RPC: minting a broker credential is a gateway-management
  -- act, and there is no reading of it that makes it less than that.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to mint a gateway broker credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- THE MIRROR IMAGE OF 0025, AND THE INVERSION IS THE WHOLE POINT OF THAT FILE. That function
  -- refuses a host-run gateway because there is no appliance to carry a bundle to; this one
  -- REQUIRES one, because a remote appliance already has a path and it is a better path -- the
  -- credential is minted on the appliance itself and never travels through a browser.
  --
  -- Offering this for a remote appliance would be offering a WORSE option beside a working one,
  -- and the operator choosing it would have no way to know that.
  IF v_gateway.deployment <> 'host' THEN
    RAISE EXCEPTION
      'gateway % runs on an appliance; use an enrolment bundle so the credential is minted there '
      'rather than shown in a browser', v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ARCHIVED IS REFUSED, following 0037. That migration made archiving withdraw an outstanding
  -- enrolment bundle, having found that a bundle downloaded and never instantiated stayed
  -- redeemable after the gateway was archived -- issuing a real broker credential and resurrecting
  -- the row to ONLINE. Minting directly is the same hole reached in one step instead of two.
  IF v_gateway.is_archived THEN
    RAISE EXCEPTION 'gateway % is archived; restore it before minting a credential', v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- COALESCED THOUGH THE COLUMN IS NOT NULL TODAY, which makes this dead code and is deliberate.
  -- The cost is a function call; the cost of being wrong is that a NULL reaches the edge function
  -- as a missing key, and a delivery decision made on an absent boolean goes whichever way the
  -- caller happens to read it -- so a later migration relaxing the constraint would silently
  -- change what gets delivered rather than failing. `test_playback_credential_delivery.py` pins the
  -- NOT NULL, so if that ever goes this stops being defence and starts being the behaviour.
  RETURN QUERY SELECT v_gateway.sparkplug_id, v_gateway.name,
                      coalesce(v_gateway.is_simulated, false);
END;
$$;

COMMENT ON FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid) IS
  'Gate for minting a VIRTUAL gateway''s broker credential: checks has_role(), refuses a physical or archived gateway, and returns the generated sparkplug_id the account must be named after. Since 0078 it also returns is_playback_target -- is_simulated, the same predicate start_playback_job() gates on -- which is what authorises DELIVERY of the password to the playback worker. The mirror of issue_gateway_enrollment_token(), which refuses exactly the gateways this accepts.';

-- The grants 0001 puts on the two-column form do not follow it across the DROP, and a function
-- nobody may execute fails at the call site rather than here -- as a 500 from the edge function
-- with the Gateways page's credential button simply not working.
REVOKE ALL ON FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid) TO authenticated;

-- =================================================================================================
-- SELF-CHECK: THE DELIVERY PREDICATE AND THE JOB GATE MUST NOT DRIFT APART
--
-- This is the property the whole file rests on: the set of gateways whose password may be delivered
-- to the playback worker must be exactly the set it is allowed to publish as. If `start_playback_job`
-- were ever narrowed -- to exclude archived simulated gateways, say -- without narrowing this, the
-- worker would be handed credentials for gateways it can no longer legitimately target, and nothing
-- would fail. It would simply hold more than it needs, quietly, which is how a blast radius grows.
--
-- READ-ONLY, and it asserts the SOURCE rather than behaviour, because behaviour here needs a
-- gateway to exist and this must pass on an empty stack.
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
