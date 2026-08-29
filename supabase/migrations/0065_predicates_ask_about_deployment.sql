-- =============================================================================================
-- Migration: 0065_predicates_ask_about_deployment.sql
-- Every SQL predicate that meant "is there a machine out there" now says so
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE SQL LAYER FIRST, AND SEPARATELY
--
-- `0064` added `deployment` ('host' | 'remote') because `is_virtual` carries three incompatible
-- definitions -- roadmap §15 makes that case. This migration moves the six functions that read the
-- old column onto the new one, and it goes first because THE SQL LAYER IS WHERE THE AMBIGUITY HAS
-- ACTUALLY COST SOMETHING:
--
--   * `0056` -- `gateway_holds_a_credential()` refused every playback target, so a second predicate
--     had to be written to ask the question that was meant.
--   * `0062` (#91) -- the credential inventory reported nothing outstanding for gateways holding
--     live broker accounts.
--   * `0063` (#102) -- revocation never fired for a virtual gateway, so a deleted gateway's broker
--     credential went on publishing. Demonstrated end to end before the fix.
--
-- Three defects, one root, all of them in a WHERE clause. The frontend's uses of `is_virtual` are
-- labels and filters -- wrong-looking rather than wrong-behaving -- and they move next, with the
-- column itself.
--
-- ---------------------------------------------------------------------------------------------
-- THE TRANSLATION, WHICH IS MECHANICAL AND WORTH STATING ONCE
--
--     NOT is_virtual   ->   deployment = 'remote'      a physical appliance on the plant network
--         is_virtual   ->   deployment = 'host'        a connector running inside this stack
--
-- `0064`'s trigger keeps the two columns in agreement in both directions, so this migration changes
-- how the questions are ASKED and not what they answer. Every one of these functions returns
-- exactly what it returned before it, on every row, today.
--
-- REPRODUCED IN FULL, and here that is forced rather than chosen: `CREATE OR REPLACE FUNCTION`
-- takes a whole body, so there is no patching form to prefer. Each is registered in
-- `INTENDED_REDECLARATIONS` in scripts/check-docs-drift.mjs, which is where "yes, I meant to
-- replace that" has to be written down.
--
-- `gateway_health_rows()` is NOT here: `is_virtual` is in its RETURNS TABLE signature, so changing
-- it means dropping the function and the view built on it. That belongs with the column's removal
-- rather than with a body swap.
--
-- Related: 0064 (the column), 0025/0038/0041/0056/0062 (where each of these was declared),
--          README.md §15.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The two credential predicates -- the ones that have been wrong three times
-- ---------------------------------------------------------------------------------------------
-- IMMUTABLE is kept. It is called from triggers and 0038 relies on it; the body reads two columns
-- of the row handed to it and nothing else, which is as true of `deployment` as it was of
-- `is_virtual`.
CREATE OR REPLACE FUNCTION public.gateway_holds_a_credential(g public.gateways)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$ SELECT g.deployment = 'remote' AND g.enrolled_at IS NOT NULL $fn$;

COMMENT ON FUNCTION public.gateway_holds_a_credential(public.gateways) IS
  'True for a REMOTE appliance that completed enrolment, and false for everything else -- which '
  'includes every host-run gateway, whose credential leaves no enrolment behind. Ask '
  'gateway_has_broker_credential() instead when the question is "does an account exist at the '
  'broker": this one is about enrolment, and mistaking the two is what 0056, 0062 and 0063 each '
  'had to correct.';

CREATE OR REPLACE FUNCTION public.gateway_has_broker_credential(g public.gateways)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
    SELECT
        (g.deployment = 'remote' AND g.enrolled_at IS NOT NULL)
     OR (g.deployment = 'host' AND EXISTS (
            SELECT 1 FROM public.digital_thread dt
             WHERE dt.entity_type = 'gateways'
               AND dt.entity_id   = g.id
               AND dt.action      = 'CREDENTIAL_ISSUED'
               AND (g.credential_revoked_at IS NULL OR dt.recorded_at > g.credential_revoked_at)
        ));
$fn$;

COMMENT ON FUNCTION public.gateway_has_broker_credential(public.gateways) IS
  'Does an account exist at the broker for this gateway, by either route it can arrive -- a remote '
  'appliance completing enrolment, or the CREDENTIAL_ISSUED row a host-run mint leaves -- minus '
  'revocation. Cannot admit a gateway that never held one, which is what lets revocation use it '
  'without creating accounts through the add-only credential service (0063).';


-- ---------------------------------------------------------------------------------------------
-- 2. The two issuance paths, which are mirror images of each other
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid)
RETURNS TABLE(sparkplug_id text, gateway_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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

  RETURN QUERY SELECT v_gateway.sparkplug_id, v_gateway.name;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.issue_gateway_enrollment_token(
  p_gateway_id uuid,
  p_ttl_minutes integer DEFAULT 30
)
RETURNS TABLE(token text, expires_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_token    text;
  v_expires  timestamp with time zone;
  v_gateway  public.gateways%ROWTYPE;
BEGIN
  -- Fail closed, and check authority before anything observable happens. Same allow-list as the
  -- write policies on `gateways`: issuing a bundle is a gateway-management act.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to issue a gateway enrolment token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- BOUNDED, because the TTL arrives from a client. A 30-minute default matches the time it takes
  -- to carry a bundle to an appliance and boot it; the ceiling is a day, past which a "short-lived
  -- single-use claim" is neither.
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 1440 THEN
    RAISE EXCEPTION 'p_ttl_minutes must be between 1 and 1440 (got %)', p_ttl_minutes
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A HOST-RUN GATEWAY HAS NO APPLIANCE TO ENROL. `deployment = 'host'` means the connector runs
  -- inside this stack -- a host connector or a simulator -- so a bundle for one would produce a
  -- broker credential nothing could ever present. Refused here rather than left to fail later at
  -- the point where a download does nothing.
  --
  -- This read `is_virtual` until 0065, and it is the clearest example of why that word had to go:
  -- the check is about whether there is a MACHINE to carry the bundle to, and "virtual" was three
  -- other claims wearing the same name.
  IF v_gateway.deployment = 'host' THEN
    RAISE EXCEPTION 'gateway % runs on this host; enrolment bundles are for appliances only',
      v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Invalidate any live token for this gateway FIRST. Two reasons, and the second is structural:
  -- re-issuing must kill the bundle already downloaded (otherwise "regenerate" hands out a second
  -- valid claim rather than replacing the first), and the partial unique index permits only one
  -- unconsumed row per gateway.
  UPDATE public.gateway_enrollment_tokens
     SET consumed_at = now()
   WHERE gateway_id = p_gateway_id
     AND consumed_at IS NULL;

  -- 32 bytes, hex-encoded. `extensions.gen_random_bytes` is pgcrypto, already relied on by 0002 and
  -- 0006 for the OAuth client secret hashes -- the same extension, in the same schema.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(mins => p_ttl_minutes);

  INSERT INTO public.gateway_enrollment_tokens (gateway_id, token_hash, expires_at, created_by)
  VALUES (
    p_gateway_id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_expires,
    -- Nullable and carries no FK on purpose: auth.uid() is NULL when this is called with the
    -- service-role key (provisioning scripts, tests), and recording who asked is useful while
    -- failing because nobody did is not. It is provenance, not a constraint.
    auth.uid()
  );

  -- The gateway enters the lifecycle here rather than at creation, so a row created before this
  -- migration -- or one whose bundle is being re-issued after a failed enrolment -- lands in the
  -- same state as a new one. Guarded on an actual change: `gateways` carries the digital_thread
  -- trigger, and an unconditional write would append an audit row on every re-issue.
  IF v_gateway.status IS DISTINCT FROM 'PENDING_ENROLLMENT' THEN
    UPDATE public.gateways
       SET status = 'PENDING_ENROLLMENT'
     WHERE id = p_gateway_id;
  END IF;

  RETURN QUERY SELECT v_token, v_expires;
END $fn$;


-- ---------------------------------------------------------------------------------------------
-- 3. The two recorders, and the one field in them that changes meaning
-- ---------------------------------------------------------------------------------------------
-- THE AUDIT ROW NOW CARRIES `deployment` RATHER THAN `is_virtual`, and rows already written keep
-- the old key. That is correct rather than unfortunate: an audit row records what was true when it
-- was written, in the vocabulary of the time, and rewriting history to use a word coined later
-- would be a lie about a table whose whole value is that it cannot be edited.
--
-- Nothing reads either key -- the Digital Thread page renders `new_data` generically -- so the
-- change is legible to a human reader and invisible to code.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
    -- reveal-once flow is that the secret exists in one browser for one minute.
    jsonb_build_object(
      'name',           v_gateway.name,
      'sparkplug_id',   v_gateway.sparkplug_id,
      'deployment',     v_gateway.deployment,
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
$fn$;

CREATE OR REPLACE FUNCTION public.record_gateway_credential_issued_by_service(
  p_gateway_id uuid,
  p_context    jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
    -- know both names. The ROUTE is visible in `actor_source` for anyone who needs it.
    'CREDENTIAL_ISSUED',
    NULL,
    jsonb_build_object(
      'name',           v_gateway.name,
      'sparkplug_id',   v_gateway.sparkplug_id,
      'deployment',     v_gateway.deployment,
      'mqtt_username',  v_gateway.sparkplug_id,
      'issued_at',      now(),
      -- A ROTATION IS A REPLACEMENT AT THE BROKER, unlike a re-minted JWT, which is an ADDITION.
      -- mosquitto holds one password per username, so rotating invalidates the previous one --
      -- which means the inventory must not count two rows for one gateway as two live credentials.
      'rotated',        coalesce((p_context ->> 'rotated')::boolean, false),
      -- ASSERTED BY THE CALLER AND LABELLED AS SUCH -- 0043's convention, verbatim. Only these
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
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------------------------
-- SOURCE ASSERTIONS, not behaviour: every one of these functions either takes a role the migration
-- has no session for, writes to an append-only table, or issues a token. What is worth asserting
-- here is that none of them still reads the old column, because a single missed body is a
-- predicate that keeps the defect while everything around it looks migrated.
--
-- The behaviour is covered where it can be observed and rolled back:
-- test_credential_revocation.py, test_credential_recorder.py and test_gateway_enrollment.py.
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  v_stragglers text;
BEGIN
  -- COMMENTS ARE STRIPPED FIRST, and finding that out is worth the two lines it costs. `prosrc` is
  -- the whole body, prose included, so the first version of this check failed on
  -- `issue_gateway_enrollment_token` -- whose new body explains, in a comment, that it USED to read
  -- `is_virtual`. A check that cannot tell a mention from a use forces the documentation to be
  -- thinned to keep it quiet, which is the wrong thing to trade.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_stragglers
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%is_virtual%'
     -- The two 0064 declares to keep the columns in step while both exist, and the view builder
     -- which names no column at all. Everything else must have moved.
     AND p.proname NOT IN ('sync_gateway_deployment', 'gateway_health_rows');

  IF v_stragglers IS NOT NULL THEN
    RAISE EXCEPTION
      '0065 self-check: function(s) [%] still read gateways.is_virtual. A predicate left behind '
      'keeps asking a question with three meanings while everything around it has moved to one.',
      v_stragglers;
  END IF;

  IF NOT (SELECT public.gateway_holds_a_credential(g) IS NOT NULL FROM public.gateways g LIMIT 1)
     AND EXISTS (SELECT 1 FROM public.gateways) THEN
    RAISE EXCEPTION '0065 self-check: gateway_holds_a_credential() returned NULL for a live row.';
  END IF;

  RAISE NOTICE
    '0065 self-check passed: no predicate reads is_virtual, and the credential predicates answer '
    'for live rows.';
END;
$selfcheck$;
