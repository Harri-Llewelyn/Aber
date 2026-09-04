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

-- =================================================================================================
-- A SEPARATE FUNCTION, AND THE FIRST ATTEMPT IS WHY
--
-- This began by adding a third column to `authorize_virtual_gateway_credential()`, the obvious
-- shape: one authoritative answer, one round trip, delivery decided beside the authorisation it
-- belongs to. It DROPped the old form first, the way 0075 does, and it worked -- once.
--
-- ON THE SECOND BOOT THE ENTIRE CHAIN DIED AT FILE ONE:
--
--     0001_baseline_schema.sql:611: ERROR: cannot change return type of existing function
--     DETAIL:  Row type defined by OUT parameters is different.
--     HINT:    Use DROP FUNCTION authorize_virtual_gateway_credential(uuid) first.
--
-- Migrations replay in filename order on every boot, so 0001 runs BEFORE this file and re-declares
-- the two-column form with CREATE OR REPLACE -- which cannot change a return type, and finds the
-- three-column version this file left behind. The DROP here is far too late: 0001 has already
-- aborted, and it aborts having DROPped the FDW server with CASCADE, so the stack was left running
-- with the whole telemetry read surface missing.
--
-- THE RULE THIS TEACHES, and scripts/check-docs-drift.mjs now enforces it: a later migration may
-- redeclare a function 0001 declares, but it MUST NOT change its return type. 0075 gets away with a
-- new argument because that is a different signature, and 0076 gets away with a rewrite because the
-- return type is unchanged. Same signature, different return type is the one combination that
-- cannot survive a replay.
--
-- So the delivery predicate is its own function. It costs a second round trip from the edge
-- function and leaves the authorisation gate exactly as 0001 declares it.

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
  -- THE SAME ALLOW-LIST AS THE AUTHORISATION GATE, though this only reads a boolean. The caller has
  -- already passed that gate by the time this is asked, so the check is redundant on the intended
  -- path -- and it is here for the same reason `record_service_token_issued()` re-checks its actor:
  -- authorisation must not rest on a check made only by the component that also acts on the answer.
  -- The answer decides whether a broker password is written where the replay worker can read it.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to resolve a playback delivery target'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT is_simulated INTO v_simulated FROM public.gateways WHERE id = p_gateway_id;

  -- FALSE FOR A GATEWAY THAT DOES NOT EXIST, rather than an exception. This is asked immediately
  -- after an authorisation that already refused a missing gateway, so the only way to reach it is a
  -- row deleted in between -- and "do not deliver" is the safe answer to that, where raising would
  -- turn a vanished gateway into a failed credential issue for one that is still there.
  --
  -- COALESCED THOUGH is_simulated IS NOT NULL TODAY, which makes that half dead code and is
  -- deliberate: a later migration relaxing the constraint would otherwise silently change what gets
  -- delivered rather than failing. test_playback_credential_delivery.py pins the NOT NULL, so if it
  -- ever goes this stops being defence and starts being the behaviour.
  RETURN coalesce(v_simulated, false);
END;
$$;

COMMENT ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) IS
  'Whether a freshly-issued broker credential for this gateway may be DELIVERED to the playback worker. is_simulated -- the same predicate start_playback_job() gates on, so the set of passwords the worker can hold is exactly the set of gateways it may publish as. Deliberately NOT a column on authorize_virtual_gateway_credential(): 0001 redeclares that function on every boot and CREATE OR REPLACE cannot change a return type, which aborts the whole chain at file one.';

REVOKE ALL ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) TO authenticated;

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
