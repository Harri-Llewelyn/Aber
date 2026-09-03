-- =============================================================================================
-- Migration: 0062_provisioning_records_what_it_issues.sql
-- The credential inventory's blind spot, for the half of it that can be closed
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT WAS WRONG, MEASURED RATHER THAN ARGUED
--
-- On a provisioned stack, five gateways hold live broker credentials and TWO carry a
-- `CREDENTIAL_ISSUED` row. The other three -- the three cells the demonstrator publishes from --
-- were issued their credentials by `scripts/provision-gateways.mjs`, and nothing recorded it:
--
--              name             | is_virtual | issued_rows
--   -----------------------------+------------+-------------
--    Playback                    | t          |           1     <- minted through the dashboard
--    Sim_Gateway_Cell1_Machining | t          |           0
--    Sim_Gateway_Cell2_Robotics  | t          |           0
--    Sim_Gateway_Cell3_OEE       | t          |           0
--    Sim_Gateway_Site_BMS        | t          |           1     <- minted through the dashboard
--
-- The Access Control page then reports `No platform record` for a gateway whose account is at the
-- broker and publishing. An inventory that under-reports is not cosmetic here: `supabase/README.md`
-- records that these credentials CANNOT BE REVOKED, and README.md's Accepted risks section leans on
-- the inventory by name -- "an accurate inventory is the compensating control". This is that
-- control not working.
--
-- ---------------------------------------------------------------------------------------------
-- WHY 0041's RECORDER COULD NOT BE CALLED, AND WHY THIS IS A SECOND FUNCTION
--
-- `record_gateway_credential_issued()` gates on `has_role()`, which resolves through `auth.uid()`.
-- The provisioning script authenticates with `SUPABASE_SERVICE_ROLE_KEY`, for which `auth.uid()` is
-- NULL, so the gate refuses it. 0043's header names this exact wall: "the same wall
-- `provision-gateways.mjs` hits, and the same one that makes a demonstration floor's credentials
-- unrecorded."
--
-- WIDENING 0041's FUNCTION WAS THE OTHER OPTION AND IS WORSE. It would mean one function whose
-- authorisation depends on which caller reached it, and whose row means a different thing in each
-- case -- `changed_by` naming a person down one path and NULL down the other. The precedent for the
-- machine path is `record_ingestion_rejection()` (0026) and `record_service_token_issued()` (0043):
-- a separate function, revoked from PUBLIC, reachable by `service_role` ALONE, with `actor_source`
-- pinned rather than taken from its caller. This is that shape, and 0041's human path is untouched.
--
-- ---------------------------------------------------------------------------------------------
-- THE ROW CANNOT NAME A PERSON, AND SAYS SO
--
-- `changed_by` is NULL and `actor_source` is pinned to 'service'. The host and OS user the caller
-- claims to be running as go under a `claimed` key, exactly as 0043 does, BECAUSE THE DATABASE CAN
-- VERIFY NEITHER. A key named `issued_by` would have read as an attribution.
--
-- ---------------------------------------------------------------------------------------------
-- NO EXPIRY, AND THAT IS THE DIFFERENCE FROM A TOKEN RATHER THAN AN OMISSION
--
-- 0043 enforces a 90-day ceiling because a signed JWT is bounded only by `exp`. A broker password
-- has no expiry at all: it is bounded by revocation, which for a gateway means
-- `revoke_gateway_credentials()` (0038) and the broker account actually going away. So this row
-- carries `issued_at` and no `expires_at`, and the inventory reads it as "outstanding until
-- revoked" rather than as a countdown. Inventing an expiry here would put a reassuring date against
-- a credential that has none.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS DOES NOT CLOSE, STATED HERE BECAUSE THE GAP IS REAL AND BIGGER THAN IT LOOKS
--
-- `scripts/setup.mjs` mints two principal JWTs -- SUPABASE_INGESTION_KEY and SUPABASE_PLAYBACK_KEY
-- -- and they are NOT recordable through `record_service_token_issued()`. Measured on a running
-- stack: 3650 days and ~2440 days respectively, with no `jti`. The recorder refuses anything beyond
-- `service_token_max_days()`, which is 90.
--
-- That refusal is correct and is the whole point of the ceiling: it exists BECAUSE these tokens
-- cannot be revoked. So recording them would mean either raising a ceiling that is load-bearing, or
-- shortening the lifetime of the two keys the daemon and the playback worker authenticate with --
-- for which there is no rotation path today. Neither is a decision this migration can make on its
-- own, so the surface is made to STATE the gap instead (see utils/serviceIdentities.js) and the
-- decision is filed separately rather than silently taken here.
--
-- Related: 0041 (the human path this mirrors), 0043 (the machine-path shape and the ceiling),
--          0026 (record_ingestion_rejection, the original of this arrangement),
--          0038 (revocation, which is what bounds a broker credential),
--          scripts/provision-gateways.mjs (the only caller).
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.record_gateway_credential_issued_by_service(
  p_gateway_id uuid,
  p_context    jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
  v_id      bigint;
BEGIN
  IF p_gateway_id IS NULL THEN
    RAISE EXCEPTION 'record_gateway_credential_issued_by_service: p_gateway_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_gateway_credential_issued_by_service: gateway % does not exist',
      p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- AN ARCHIVED GATEWAY IS REFUSED, and this is the one check that is not bookkeeping. 0037
  -- withdraws enrolment on archive precisely so a decommissioned appliance cannot come back through
  -- a credential; a provisioning run that reissued one and recorded it as routine would document
  -- the thing 0037 exists to prevent, in the table an auditor reads to check it did not happen.
  IF v_gateway.is_archived THEN
    RAISE EXCEPTION
      'record_gateway_credential_issued_by_service: % is archived. Archiving withdraws enrolment '
      '(0037), so a credential issued to it now is one nothing on this platform will honour.',
      v_gateway.sparkplug_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'gateways',
    v_gateway.id,
    -- THE SAME ACTION 0041 WRITES, deliberately. The inventory asks "does this gateway hold a
    -- credential", and an answer that depended on which route minted it would need every reader to
    -- know both names -- `listGatewayCredentials()`, `gateway_has_broker_credential()` (0056) and
    -- anything written later. The ROUTE is visible in `actor_source` for anyone who needs it.
    'CREDENTIAL_ISSUED',
    NULL,
    -- The identity as it was at the time, and never the password: this table is readable by any
    -- holder of `digital_thread:read` and its rows cannot be deleted. Same rule as 0041.
    jsonb_build_object(
      'name',           v_gateway.name,
      'sparkplug_id',   v_gateway.sparkplug_id,
      'is_virtual',     v_gateway.is_virtual,
      'mqtt_username',  v_gateway.sparkplug_id,
      'issued_at',      now(),
      -- A ROTATION IS A REPLACEMENT AT THE BROKER, unlike a re-minted JWT, which is an ADDITION.
      -- mosquitto holds one password per username, so rotating invalidates the previous one --
      -- which means the inventory must not count two rows for one gateway as two live credentials.
      -- The flag is what lets a reader tell the two stories apart.
      'rotated',        coalesce((p_context ->> 'rotated')::boolean, false),
      -- ASSERTED BY THE CALLER AND LABELLED AS SUCH -- 0043's convention, verbatim. Only these two
      -- keys are lifted out of p_context: storing it wholesale would let a caller add fields that
      -- look authoritative.
      'claimed',        jsonb_build_object(
                          'os_user', p_context ->> 'os_user',
                          'host',    p_context ->> 'host',
                          'script',  p_context ->> 'script'
                        )
    ),
    -- NULL, and pinned 'service'. The caller holds a machine credential, so the row cannot name a
    -- person and does not pretend to.
    NULL,
    'service',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.record_gateway_credential_issued_by_service(uuid, jsonb) IS
  'Record that a host script issued a broker credential to a gateway, as a CREDENTIAL_ISSUED row '
  'in digital_thread. Reachable by service_role ALONE -- 0041''s pair is the operator path and '
  'gates on has_role(), which no host script can satisfy. actor_source is pinned to ''service'' '
  'and changed_by to NULL; the host and OS user are stored under `claimed` because the database '
  'cannot verify either. Carries the wire identity and never the password.';

-- REACHABLE BY service_role ALONE. Not `authenticated`: an operator minting a credential goes
-- through 0041's function, which records them as the author. A browser-reachable function that
-- writes an unattributed row would be a way for a person to make an act look like a machine's.
REVOKE ALL ON FUNCTION public.record_gateway_credential_issued_by_service(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_gateway_credential_issued_by_service(uuid, jsonb)
  TO service_role;


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- THE GRANT IS THE THING WORTH ASSERTING, in both directions. Reachable by service_role or the
-- provisioning script silently records nothing and we are back where we started; reachable by
-- `authenticated` and a signed-in user can write an unattributed CREDENTIAL_ISSUED row into an
-- append-only table, which is a worse defect than the one being fixed.
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
BEGIN
    IF NOT has_function_privilege(
             'service_role',
             'public.record_gateway_credential_issued_by_service(uuid, jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION
          '0062 self-check: service_role cannot execute the recorder, so provisioning would go on '
          'issuing credentials that nothing records.';
    END IF;

    IF has_function_privilege(
         'authenticated',
         'public.record_gateway_credential_issued_by_service(uuid, jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION
          '0062 self-check: `authenticated` can execute the machine-path recorder. A signed-in '
          'user could then write a CREDENTIAL_ISSUED row attributed to no one, into a table whose '
          'rows cannot be deleted. Operators record through 0041''s function, which names them.';
    END IF;

    RAISE NOTICE
      '0062 self-check passed: the machine-path recorder is reachable by service_role and by '
      'nothing else.';
END;
$selfcheck$;
