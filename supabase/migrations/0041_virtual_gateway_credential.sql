-- =============================================================================================
-- 0041_virtual_gateway_credential.sql
--
-- The authority half of "Generate broker credential" for a VIRTUAL gateway, so the last workflow
-- that requires shell access to put a gateway on the broker can be retired. See Machine
-- Identities in supabase/README.md, and the
-- step §14 named as the one thing missing from a hand-built simulator.
--
-- ---------------------------------------------------------------------------------------------
-- THE PROBLEM THIS SOLVES, WHICH IS NARROW AND SPECIFIC
--
-- A gateway created in the dashboard gets a random UUID, so its `sparkplug_id` -- 'gwy' plus the
-- first 21 hex characters of that UUID -- is not known until the row exists. `mosquitto.acl` pins
-- the topic's edge-node segment to the connecting username (`pattern readwrite spBv1.0/+/+/%u/#`),
-- so the broker account can only be minted AFTER the row, and must be named exactly that id.
--
-- For a PHYSICAL gateway that is solved: `gateway-bundle` mints a single-use token, the appliance
-- carries it, and `enroll-gateway` exchanges it for a credential at first boot.
--
-- FOR A VIRTUAL GATEWAY THERE IS NO APPLIANCE, and both halves of that path refuse one outright --
-- `issue_gateway_enrollment_token()` (0025) raises on `is_virtual`, for the reason it states: "a
-- bundle for one would produce a broker credential nothing could ever present." That refusal is
-- correct and is not being relaxed here. What is left for a virtual gateway is the workflow 0025
-- was written to eliminate, and its header describes it exactly: "create a row in the UI, then
-- have an operator with shell access run a script and hand the password over by some other means."
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS IS TWO FUNCTIONS AND NOT ONE, WHICH IS THE ONLY REAL DESIGN DECISION IN THE FILE
--
-- Minting is a THREE-PARTY act: the database decides authority, the credential service does the
-- work, and the browser shows the result once. The database is not in the loop for the middle
-- step -- it cannot reach the broker's password file, and giving it a way to would be a far larger
-- authority than this feature is worth.
--
-- So the edge function has to call out and come back, and the question is where the audit row goes:
--
--   * BEFORE the mint, in one function -- then a credential service that is down produces an audit
--     row saying a credential was issued when none was. The record is a lie in exactly the case an
--     operator would go looking for it.
--   * AFTER the mint, in a second function -- then a failure between the two loses the audit row
--     for a credential that DOES exist. That is the worse direction: an unrecorded broker account.
--
-- Neither is free, so the split makes the failure VISIBLE instead of picking one silently. The
-- authorisation function gates and returns the identity; the recording function writes the row once
-- the password is real. If the second call fails the edge function still returns the password --
-- withholding it would strand an account nobody can ever authenticate as, since the service stores
-- only a hash -- and says so in the response, which is the one outcome an operator can act on.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
--
--   * NO TOKEN TABLE. `gateway_enrollment_tokens` exists because the caller is an appliance holding
--     no session. This caller holds one, so the claim it would exchange is a claim it already has.
--     A second single-use token here would be ceremony around an authorisation that has already
--     happened.
--   * NO STATUS TRANSITION. 0025 moves a physical gateway to PENDING_ENROLLMENT because enrolment
--     is a lifecycle with a waiting state. A virtual gateway has no appliance to wait for: it goes
--     ONLINE when something publishes under its id, and inventing a state it passes through would
--     put a label on the Gateways page that nothing ever clears.
--   * NO REVOCATION CHANGES. 0038 already revokes on archive and delete, and
--     `gateway_holds_a_credential()` is `NOT is_virtual AND enrolled_at IS NOT NULL` -- so a
--     virtual gateway is outside its scope by definition. Bringing it in is a separate decision
--     with a separate failure mode (rotating an account a running host-side connector is holding),
--     and it belongs with the rest of §13 rather than smuggled in beside a button.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The authority decision
-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER AND CHECKING has_role() ITSELF, which is the property `gateway-bundle` records
-- and the reason it holds no service-role key: "the database makes the authority decision -- once,
-- in the same place the RLS policies make it." The edge function's own role check is then a
-- courtesy that turns a refusal into a usable 403 instead of a 500 carrying an
-- `insufficient_privilege` raise.
--
-- IT RETURNS THE IDENTITY RATHER THAN LETTING THE CALLER SUPPLY IT. `sparkplug_id` is a GENERATED
-- column and is the username the ACL matches exactly; a caller that passed its own would be one
-- typo away from an account confined to a subtree nothing publishes to -- which authenticates
-- fine and then silently drops every message.
CREATE OR REPLACE FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid)
RETURNS TABLE (sparkplug_id text, gateway_name text)
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

  -- THE MIRROR IMAGE OF 0025, AND THE INVERSION IS THE WHOLE POINT OF THIS FILE. That function
  -- refuses a virtual gateway because there is no appliance to carry a bundle; this one requires
  -- one, because a physical gateway already has a path and it is a better path -- the credential is
  -- minted on the appliance itself and never travels through a browser.
  --
  -- Offering this for a physical gateway would be offering a WORSE option beside a working one,
  -- and the operator choosing it would have no way to know that.
  IF NOT v_gateway.is_virtual THEN
    RAISE EXCEPTION
      'gateway % is a physical gateway; use an enrolment bundle so the credential is minted on the '
      'appliance rather than shown in a browser', v_gateway.name
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

  RETURN QUERY SELECT v_gateway.sparkplug_id, v_gateway.name;
END;
$$;

COMMENT ON FUNCTION public.authorize_virtual_gateway_credential(uuid) IS
  'Gate for minting a VIRTUAL gateway''s broker credential: checks has_role(), refuses a physical '
  'or archived gateway, and returns the generated sparkplug_id the account must be named after. '
  'The mirror of issue_gateway_enrollment_token(), which refuses exactly the gateways this accepts.';

REVOKE ALL ON FUNCTION public.authorize_virtual_gateway_credential(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_virtual_gateway_credential(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_virtual_gateway_credential(uuid) TO service_role;


-- ---------------------------------------------------------------------------------------------
-- 2. The audit row
-- ---------------------------------------------------------------------------------------------
-- A `CREDENTIAL_ISSUED` row in `digital_thread`, written the way 0026 writes SCHEMA_REJECTION: a
-- narrow SECURITY DEFINER gate rather than a direct INSERT by whoever holds a key.
--
-- WHY IT CANNOT BE A TRIGGER, which is the obvious question given every other row in that table is
-- one. Minting touches no column of `gateways` -- the account lives in the broker's password file,
-- not in the database -- so there is no write for a trigger to fire on. Inventing a column to
-- update purely so a trigger has something to notice would put a timestamp on a
-- world-readable table, copy it into the audit trail on every later write, and still not record
-- WHO asked.
--
-- ATTRIBUTION HAPPENS HERE BECAUSE IT CANNOT HAPPEN ANYWHERE ELSE. `log_digital_thread_event()`
-- deliberately refuses a 'user' actor asserted through the `X-ACS-Cymru-Actor` header -- "claiming
-- a human author is exactly the assertion a client must not be able to make about itself." Inside
-- a SECURITY DEFINER function the database already knows who the caller is, so `auth.uid()` is the
-- attribution rather than a claim.
--
-- THE FORGERY SURFACE IS STATED RATHER THAN GLOSSED. Because this is EXECUTE-able by
-- `authenticated` and role-gated, an Administrator can call it directly and write a row saying a
-- credential was issued when none was. That is not a meaningful escalation -- the same
-- Administrator can archive gateways, delete devices and approve quarantined assets -- and closing
-- it would mean a shared secret between this function and the edge worker, which is a credential to
-- rotate in exchange for making an already-privileged user slightly more honest.
CREATE OR REPLACE FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
  v_id      bigint;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to record a gateway credential issue'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'gateways',
    v_gateway.id,
    'CREDENTIAL_ISSUED',
    NULL,
    -- THE IDENTITY AS IT WAS AT THE TIME, for 0026's reason: `name` is mutable and the gateway may
    -- later be renamed or purged, and an audit row readable only by joining to a live row loses
    -- its meaning in exactly the cases it matters most.
    --
    -- NO PASSWORD, AND NOT EVEN A HASH OF ONE. This table is readable by any authenticated user
    -- holding `digital_thread:read`, its rows cannot be deleted, and the whole point of the
    -- reveal-once flow is that the secret exists in one browser for one minute. A credential in an
    -- append-only table is a credential with no revocation story at all.
    jsonb_build_object(
      'name',           v_gateway.name,
      'sparkplug_id',   v_gateway.sparkplug_id,
      'is_virtual',     v_gateway.is_virtual,
      'mqtt_username',  v_gateway.sparkplug_id,
      'issued_at',      now()
    ),
    -- Not NULL, unlike 0026's: that function records a DAEMON's judgement and pins actor_source to
    -- 'ingestion'. This one records a PERSON's act, and the person is the reason the row exists.
    auth.uid(),
    'user',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.record_gateway_credential_issued(uuid) IS
  'Record that a broker credential was minted for a virtual gateway, as a CREDENTIAL_ISSUED row in '
  'digital_thread attributed to the calling operator. Carries the wire identity and never the '
  'password: the audit trail is append-only and the secret is reveal-once.';

REVOKE ALL ON FUNCTION public.record_gateway_credential_issued(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_gateway_credential_issued(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_gateway_credential_issued(uuid) TO service_role;


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- Asserts the two properties that would fail SILENTLY. A missing function surfaces as a 404 from
-- PostgREST the first time somebody clicks the button, which is loud; a function that exists with
-- the WRONG grants is what lets an Operator mint a credential, and nothing would report it.
DO $$
DECLARE
  v_anon_authorize boolean;
  v_anon_record    boolean;
BEGIN
  IF to_regprocedure('public.authorize_virtual_gateway_credential(uuid)') IS NULL
     OR to_regprocedure('public.record_gateway_credential_issued(uuid)') IS NULL THEN
    RAISE EXCEPTION '0041 self-check: one or both credential functions are missing';
  END IF;

  -- anon must hold neither. Checked rather than trusted, for 0033's reason: the REVOKE above
  -- narrows a DEFAULT ACL rather than declining to grant, so if that ACL changes shape the REVOKE
  -- is what stops being sufficient and nothing else here would notice.
  SELECT has_function_privilege('anon', 'public.authorize_virtual_gateway_credential(uuid)', 'EXECUTE')
    INTO v_anon_authorize;
  SELECT has_function_privilege('anon', 'public.record_gateway_credential_issued(uuid)', 'EXECUTE')
    INTO v_anon_record;

  IF v_anon_authorize OR v_anon_record THEN
    RAISE EXCEPTION
      '0041 self-check: anon holds EXECUTE on % -- an unauthenticated caller could reach the '
      'credential path.',
      concat_ws(' and ',
        CASE WHEN v_anon_authorize THEN 'authorize_virtual_gateway_credential' END,
        CASE WHEN v_anon_record    THEN 'record_gateway_credential_issued' END);
  END IF;

  RAISE NOTICE '0041 self-check passed: both credential functions exist and anon holds neither.';
END;
$$;

NOTIFY pgrst, 'reload schema';
