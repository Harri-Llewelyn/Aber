-- =================================================================================================
-- Migration: 0129_the_worker_says_which_credential_it_holds.sql
--
-- Issue #217. The broker holds one password per gateway, so every mint after the first REPLACES
-- one, and `playback_report_credentials()` carried edge-node ids and nothing else -- so the
-- reported set was identical before and after a rotation. During the delivery window the worker
-- went on reporting a target it could no longer authenticate as, the dialog offered it, the job was
-- accepted, and the broker answered CONNACK rc=5 a second later.
--
-- WHAT THE WORKER NOW REPORTS is which of the gateways it holds it has picked up a NEW password
-- for since it last reported. Ids, not a fingerprint: `playback_worker_status` is readable by
-- Administrator, Shopfloor_Manager and Auditor, and a value derived from a secret in a readable
-- table is a deliberate decision this does not take. An id is already public.
--
-- THE DATABASE SAYS WHEN, not the worker. The observation is stamped here with `now()` -- the same
-- clock as the CREDENTIAL_ISSUED row it is compared against -- so no offset between the worker's
-- clock and the database's can make a credential the worker just picked up look older than the
-- issue that delivered it, and refuse a target that works.
--
-- WHAT IT IS COMPARED AGAINST already existed. Every mint writes a CREDENTIAL_ISSUED row to
-- `digital_thread` -- the playback delivery too, because that is the same edge-function call with
-- `deliver_to_playback` set -- so the issue time is recorded and needed no new writer. A worker
-- whose observation of a gateway predates that gateway's last issue is holding the previous
-- password.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, and the declaration sweep below is a
-- no-op once the argument list settles.
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. The column
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.playback_worker_status
    ADD COLUMN IF NOT EXISTS credential_observed_at jsonb DEFAULT '{}'::jsonb NOT NULL;

COMMENT ON COLUMN public.playback_worker_status.credential_observed_at IS
  'sparkplug_id -> when this database last stamped an observation of a NEW password the worker '
  'reported picking up for it. Compared with that gateway''s last CREDENTIAL_ISSUED row to tell "holds a '
  'credential for X" from "holds the CURRENT credential for X" (#217). A jsonb map rather than a '
  'side table because the whole of it is one process''s memory, written as a unit by the same '
  'single writer as the rest of the row. Holds no secret: a timestamp is derived from nothing, '
  'which a truncated hash of the password would not be.';

-- -------------------------------------------------------------------------------------------------
-- 2. The reporting function gains the map
-- -------------------------------------------------------------------------------------------------
-- EVERY DECLARATION, not merely the one this file writes -- the reason 0077, 0115 and 0118 each
-- sweep before creating. `0001` recreates the one-argument form on every boot, so without this the
-- database would carry two declarations and a call by name could choose neither. That is exactly
-- how #236 left `playback_finish` ambiguous for most of every db-init run.
--
-- THE NEW ARGUMENT TAKES A DEFAULT, so there is ONE declaration rather than an overload and a
-- worker from the previous release -- which sends `p_edge_nodes` alone -- still resolves to it
-- during a rollout. An overload would reintroduce the ambiguity this sweep exists to prevent.
DO $own$
DECLARE
    v_existing record;
BEGIN
    FOR v_existing IN
        SELECT p.oid::regprocedure AS signature
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'playback_report_credentials'
    LOOP
        -- No CASCADE: nothing may depend on this.
        EXECUTE format('DROP FUNCTION %s', v_existing.signature);
    END LOOP;
END
$own$;

-- THE WORKER NAMES WHAT CHANGED; THE DATABASE SAYS WHEN. The worker does not send a timestamp of
-- its own, and deliberately: this value is compared against a CREDENTIAL_ISSUED row stamped with
-- the database's `now()`, so a worker clock running even slightly behind would make a credential it
-- had just picked up look older than the issue that delivered it -- and the dialog would refuse a
-- target that works. Both sides of the comparison are now the same clock, and no clock offset
-- between the worker and the database can produce a false answer.
CREATE OR REPLACE FUNCTION public.playback_report_credentials(
    p_edge_nodes text[],
    p_rotated text[] DEFAULT '{}'::text[]
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_held     text[];
    v_rotated  text[];
    v_observed jsonb;
BEGIN
    PERFORM public.require_playback_caller('playback_report_credentials');

    -- COERCED TO A SORTED, DE-DUPLICATED SET rather than stored as sent. The worker builds this
    -- from a JSON object whose key order is not defined, so storing it verbatim would rewrite the
    -- row -- and therefore wake every Realtime subscriber -- on a heartbeat that changed nothing.
    v_held := COALESCE(
      (SELECT array_agg(DISTINCT node ORDER BY node)
         FROM unnest(coalesce(p_edge_nodes, '{}')) AS node
        WHERE node IS NOT NULL AND btrim(node) <> ''),
      '{}'
    );

    -- Only ids actually held: a rotation reported for something no longer in the map would stamp an
    -- observation with nothing to describe.
    v_rotated := COALESCE(
      (SELECT array_agg(DISTINCT node)
         FROM unnest(coalesce(p_rotated, '{}')) AS node
        WHERE node = ANY(v_held)),
      '{}'
    );

    SELECT credential_observed_at INTO v_observed FROM public.playback_worker_status WHERE id;

    -- Keep what is still held and was not just rotated; stamp the rotations at `now()`. Narrowing
    -- to what is held is what stops an observation outliving the credential it describes.
    v_observed := COALESCE(
      (SELECT jsonb_object_agg(key, value)
         FROM jsonb_each(coalesce(v_observed, '{}'::jsonb))
        WHERE key = ANY(v_held) AND NOT (key = ANY(v_rotated))),
      '{}'::jsonb
    ) || COALESCE(
      (SELECT jsonb_object_agg(node, to_jsonb(now())) FROM unnest(v_rotated) AS node),
      '{}'::jsonb
    );

    UPDATE public.playback_worker_status
       SET held_edge_nodes        = v_held,
           credential_observed_at = v_observed,
           reported_at            = now()
     WHERE id;
END;
$$;

COMMENT ON FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[]) IS
  'The playback worker reporting which gateways it can authenticate as, and which of those it has '
  'picked up a NEW password for since it last reported. The only writer of playback_worker_status. '
  'Called on startup and on a heartbeat, so a stale reported_at means the worker is down rather '
  'than credential-less. The worker sends no timestamp of its own: this function stamps the '
  'rotations with now(), the same clock the CREDENTIAL_ISSUED row it is compared against uses. '
  'p_rotated defaults so a worker from the previous release still reports during a rollout.';

REVOKE ALL ON FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[]) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[]) TO service_role;
GRANT ALL ON FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[]) TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- 3. Which of the held credentials are stale
-- -------------------------------------------------------------------------------------------------
-- THREE-VALUED, and the third value is the one that matters. A gateway the worker reports but has
-- no observation for is UNKNOWN, not stale: that is what a worker from the previous release
-- reports, and refusing every target on that basis would break playback on the release that
-- introduces this. Only an observation that is genuinely OLDER than the last issue is stale.
CREATE OR REPLACE FUNCTION public.playback_stale_credentials() RETURNS TABLE(
    sparkplug_id text,
    observed_at timestamp with time zone,
    issued_at timestamp with time zone
)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    SELECT g.sparkplug_id,
           (w.credential_observed_at->>g.sparkplug_id)::timestamptz,
           i.issued_at
      FROM public.playback_worker_status w
      CROSS JOIN LATERAL unnest(w.held_edge_nodes) AS held(node)
      JOIN public.gateways g ON g.sparkplug_id = held.node
      -- THE SAME THREE PREDICATES gateway_has_broker_credential() uses, entity_type included: the
      -- thread is partitioned (0079) and carries no index on (entity_id, action), so the shape of
      -- this lookup is the one already established for that question rather than a new one. It runs
      -- over the held nodes alone -- a handful -- once per dialog open.
      JOIN LATERAL (
            SELECT max(dt.recorded_at) AS issued_at
              FROM public.digital_thread dt
             WHERE dt.entity_type = 'gateways'
               AND dt.entity_id   = g.id
               AND dt.action      = 'CREDENTIAL_ISSUED'
           ) i ON true
     WHERE i.issued_at IS NOT NULL
       -- NOT `IS DISTINCT FROM`: a missing observation must read as unknown, and the comparison
       -- below is false for NULL, which is the wanted answer.
       AND (w.credential_observed_at->>g.sparkplug_id)::timestamptz < i.issued_at
$$;

COMMENT ON FUNCTION public.playback_stale_credentials() IS
  'The gateways the playback worker reports holding a credential for whose credential has been '
  're-issued since the worker last observed it (#217) -- so it is holding the previous password '
  'and a playback onto it would fail at CONNACK. SECURITY DEFINER so the dialog needs no privilege '
  'on digital_thread. A gateway with no observation is absent from this result, not stale: that is '
  'what a worker from the previous release reports.';

REVOKE ALL ON FUNCTION public.playback_stale_credentials() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.playback_stale_credentials() TO service_role, authenticated;

-- -------------------------------------------------------------------------------------------------
-- 4. The self-check
-- -------------------------------------------------------------------------------------------------
-- NO ABSOLUTE COUNTS HERE. 0069 asserted one and 0086 broke it on the SECOND boot, which test:db
-- cannot see; these assert shape, which replay cannot change.
DO $check$
DECLARE
    v_declarations integer;
BEGIN
    SELECT count(*) INTO v_declarations
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'playback_report_credentials';

    IF v_declarations <> 1 THEN
        RAISE EXCEPTION
          '0129 self-check: playback_report_credentials has % declarations, not 1. A call by name '
          'cannot choose between two, which is the failure #236 recorded for playback_finish.',
          v_declarations;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'playback_worker_status'
           AND column_name = 'credential_observed_at'
    ) THEN
        RAISE EXCEPTION '0129 self-check: playback_worker_status has no credential_observed_at column.';
    END IF;

    RAISE NOTICE '0129 self-check passed: one reporting declaration, and the worker can say when it observed what it holds.';
END
$check$;

-- -------------------------------------------------------------------------------------------------
-- 5. The accept path refuses what the dialog now hides
-- -------------------------------------------------------------------------------------------------
-- FIXING THE DIALOG ALONE WOULD NOT FIX THIS. The gates in this stack live in the database and the
-- interface mirrors them, so a caller that never opens the dialog is refused on the same terms.
--
-- REPLACED WITH THE SAME SIGNATURE, so no declaration sweep is needed and the grants survive: a
-- CREATE OR REPLACE that does not change the argument list keeps the ACL, which is the difference
-- between this and the function above.
--
-- The body is 0001's, with ONE block added -- marked TIER TWO AND A HALF. It is carried whole
-- because plpgsql has no way to patch a body, and it folds back into the baseline at the next
-- squash like every other corrective file.
CREATE OR REPLACE FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb DEFAULT '{}'::jsonb, p_speed numeric DEFAULT 1.0) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_gateway  public.gateways;
    v_capture  public.captures;
    v_running  RECORD;
    v_key      text;
    v_target   text;
    v_job_id   uuid;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'start_playback_job: publishing a capture requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_capture FROM public.captures WHERE id = p_capture_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_playback_job: no capture %', p_capture_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT * INTO v_gateway FROM public.gateways WHERE id = p_target_gateway_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_playback_job: no gateway %', p_target_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- TIER ONE: the target must be marked simulated
    -- ------------------------------------------------------------------------------------
    -- A refusal, not a warning: the historian records a replayed reading identically to an
    -- observed one, and `is_simulated` is the only thing that says otherwise.
    IF NOT v_gateway.is_simulated THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % is not marked simulated. Publishing a capture onto it '
          'would write synthetic telemetry that nothing downstream can tell from observed data. '
          'Mark it simulated (0052) or choose a playback target.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_gateway.is_archived THEN
        RAISE EXCEPTION 'start_playback_job: gateway % is archived.', v_gateway.name
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- TIER TWO, the database half: the target must hold a broker credential
    -- ------------------------------------------------------------------------------------
    -- Not `status = 'ONLINE'`: a playback target is legitimately OFFLINE until a playback runs.
    -- This proves the credential exists, not that the worker holds it (the worker refuses for
    -- itself). `gateway_has_broker_credential()`, not `gateway_holds_a_credential()`, which means
    -- "physical and enrolled" and excludes every virtual gateway.
    IF NOT public.gateway_has_broker_credential(v_gateway) THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % holds no broker credential, so nothing can authenticate '
          'as it. Issue one from the Access Control page first -- that is also how you obtain the '
          'password the playback worker needs.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- TIER TWO AND A HALF: the worker must hold the CURRENT credential (#217)
    -- ------------------------------------------------------------------------------------
    -- The check above proves an account EXISTS. It cannot prove the worker holds the password
    -- that account now has, and the broker keeps one password per gateway -- so every mint after
    -- the first REPLACES one, and for the length of the delivery window the worker is still
    -- holding the previous password. Accepting here and failing at CONNACK a second later is
    -- exactly what this refuses.
    --
    -- ABSENT IS NOT STALE. playback_stale_credentials() returns a gateway only when the worker
    -- reported an observation OLDER than the last issue; a worker that has reported no
    -- observation at all -- one from the release before 0129 -- is not listed and is not refused.
    IF EXISTS (
        SELECT 1 FROM public.playback_stale_credentials() s
         WHERE s.sparkplug_id = v_gateway.sparkplug_id
    ) THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % had its broker credential re-issued after the playback '
          'worker last picked one up, so the worker still holds the previous password and the '
          'broker would refuse it. Delivery takes about a minute; try again shortly.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- The device map
    -- ------------------------------------------------------------------------------------
    -- Every target must be a device of this gateway: publishing another gateway's device segment
    -- is exactly what `verify_gateway_binding()` quarantines.
    FOR v_key, v_target IN SELECT key, value FROM jsonb_each_text(coalesce(p_device_map, '{}'::jsonb))
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM public.devices d
             WHERE d.sparkplug_id = v_target AND d.gateway_id = p_target_gateway_id
               AND NOT d.is_archived
        ) THEN
            RAISE EXCEPTION
              'start_playback_job: % maps to %, which is not an active device of gateway %.',
              v_key, v_target, v_gateway.name
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END LOOP;

    -- ------------------------------------------------------------------------------------
    -- One playback per target, reported rather than left to the index
    -- ------------------------------------------------------------------------------------
    SELECT j.id, j.status INTO v_running
      FROM public.playback_jobs j
     WHERE j.target_gateway_id = p_target_gateway_id AND j.status IN ('PENDING', 'RUNNING')
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
          'start_playback_job: a playback onto % is already %. Two publishers on one edge node '
          'interleave their sequence numbers, which the daemon reports as permanent message loss.',
          v_gateway.name, lower(v_running.status)
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.playback_jobs (
        capture_id, capture_storage_path, target_gateway_id, target_edge_node_id,
        sparkplug_group, device_map, speed, status, requested_by
    ) VALUES (
        v_capture.id, v_capture.storage_path, v_gateway.id, v_gateway.sparkplug_id,
        v_gateway.sparkplug_group, coalesce(p_device_map, '{}'::jsonb),
        least(greatest(coalesce(p_speed, 1.0), 0.01), 60), 'PENDING', auth.uid()
    )
    RETURNING id INTO v_job_id;

    RETURN v_job_id;
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 6. The self-check for the accept path
-- -------------------------------------------------------------------------------------------------
-- ASSERTS THE GATE IS IN THE BODY THAT IS ACTUALLY INSTALLED, the way 0063 does: this file and
-- 0001 both define start_playback_job, and filename order decides which one is standing at the end
-- of a boot. If 0001 ever won, the refusal would be silently absent.
DO $gate$
DECLARE
    v_src text;
BEGIN
    SELECT prosrc INTO v_src
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'start_playback_job';

    IF v_src IS NULL OR position('playback_stale_credentials' IN v_src) = 0 THEN
        RAISE EXCEPTION
          '0129 self-check: start_playback_job does not consult playback_stale_credentials(). A '
          're-issued credential would be accepted and fail at CONNACK, which is issue #217.';
    END IF;

    RAISE NOTICE '0129 self-check passed: the accept path refuses a target whose credential the worker has not picked up.';
END
$gate$;
