-- 0187: A gateway cannot be made a playback target, and a playback maps only onto replay lanes.
--
-- What makes a gateway a playback target is its is_shadow flag: playback_target_must_be_shadow()
-- reads it, and so does gateway_is_playback_delivery_target(), which decides whose broker password
-- the playback worker is given. Nothing guarded the flag. gateways_update_privileged admits a
-- Shopfloor_Manager, no trigger or column grant stopped an update of it, and start_playback_job()
-- never asked whether a mapped device was a replay lane. So a manager could mark a Host gateway
-- is_shadow, map a real device onto itself and replay recorded readings into that device's history,
-- with nothing in the Audit Trail but an UPDATE of a gateway.
--
-- Now only the seed sets the flag:
--
--   * trg_gateways_playback_flag_is_seeded refuses a gateway INSERTed with is_shadow, and an UPDATE
--     that changes it, from every role the API runs as: authenticated (people and machine
--     principals alike), anon and service_role. The database owner is exempt, which is how
--     0002_seed_data.sql creates the Playback gateway and reconciles its flags on every boot. 0002
--     replays BEFORE this file, so from the second boot on the trigger is already in place when it
--     runs; its statements run as the owner and pass.
--   * start_playback_job() requires every mapped target to be a replay lane of the device its key
--     names. A key is the recorded device's sparkplug_id and a value the id it is published as.
--   * One Playback gateway, then. ensure_shadow_devices() still takes the oldest unarchived
--     is_shadow gateway, which is the seeded one; its message and comment, and the archive
--     refusal's, no longer send an operator to mark another gateway. Only their text changes.
--
-- Nothing is reset: a gateway that is already is_shadow keeps the flag, and the release notes say
-- how to find one. Signatures, return types and grants are 0001's and 0165's.

-- -------------------------------------------------------------------------------------------------
-- The flag is set by the seed alone
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refuse_hand_marking_a_playback_gateway() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_what text;
BEGIN
    -- The roles that can run DDL are past this, as they are past the audit trail's append-only
    -- guard: the seed and the SECURITY DEFINER functions run as the owner. What it closes is every
    -- role the API connects as.
    IF current_user IN ('postgres', 'supabase_admin') THEN
        RETURN NEW;
    END IF;

    -- A PATCH sends the whole row, so an edit that mentions the column without changing it passes.
    IF NEW.is_shadow IS NOT DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.is_shadow ELSE false END) THEN
        RETURN NEW;
    END IF;

    v_what := CASE WHEN TG_OP = 'INSERT' THEN 'cannot be created as a playback gateway'
                   WHEN NEW.is_shadow THEN 'cannot be made a playback gateway'
                   ELSE 'cannot stop being a playback gateway' END;

    RAISE EXCEPTION
      'gateway % %. Only the Playback gateway that Aber seeds is a playback target, and its is_shadow '
      'flag cannot be set or cleared through the API. A replay writes recorded readings into the '
      'history of the device it publishes as, so it may only publish as a replay lane. To replay a '
      'capture, play it back onto the Playback gateway.',
      NEW.name, v_what
        USING ERRCODE = 'check_violation';
END;
$$;

ALTER FUNCTION public.refuse_hand_marking_a_playback_gateway() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_hand_marking_a_playback_gateway() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refuse_hand_marking_a_playback_gateway() IS 'Refuses a gateway INSERTed with is_shadow and an UPDATE that changes it, for every role the API runs as. The database owner is exempt: the seed creates the Playback gateway and reconciles its flags on every boot, and 0002 replays before the migrations that add this trigger. UPDATE OF is_shadow fires when the column is mentioned, so the body compares OLD and NEW rather than assuming a change (0187).';

SELECT public.replay_trigger('public.gateways', 'trg_gateways_playback_flag_is_seeded', $ddl$
CREATE TRIGGER trg_gateways_playback_flag_is_seeded BEFORE INSERT OR UPDATE OF is_shadow ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.refuse_hand_marking_a_playback_gateway();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- The archive refusal no longer suggests another gateway
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refuse_archiving_the_last_shadow_gateway() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  -- ON THE TRANSITION ONLY. An ordinary edit to an already-archived gateway must not be refused,
  -- and neither must un-archiving one, which is how an archived Playback gateway is restored.
  IF NOT NEW.is_archived OR COALESCE(OLD.is_archived, false) THEN
    RETURN NEW;
  END IF;

  IF NOT NEW.is_shadow THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.gateways g
     WHERE g.is_shadow AND NOT g.is_archived AND g.id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'gateway % is the Playback gateway, and archiving it would leave broker playback with no edge '
    'node to publish as. No other gateway can be made a playback target, so it stays. It reads '
    'OFFLINE whenever no capture is playing, which is its resting state and not a fault.',
    NEW.name
    USING ERRCODE = 'restrict_violation';
END $$;

ALTER FUNCTION public.refuse_archiving_the_last_shadow_gateway() OWNER TO postgres;

COMMENT ON FUNCTION public.refuse_archiving_the_last_shadow_gateway() IS 'Refuses the archive that would leave a stack with no un-archived shadow gateway. The Playback gateway is the only one a stack makes, so in practice it cannot be archived; a stack upgraded with an older second one can still archive either (0187 words the refusal).';

-- -------------------------------------------------------------------------------------------------
-- ensure_shadow_devices() names the one Playback gateway
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_shadow_devices(p_capture_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_capture   public.captures;
    v_gateway   public.gateways;
    v_wire_id   text;
    v_origin    public.devices;
    v_shadow_id uuid;
    v_map       jsonb := '{}'::jsonb;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'ensure_shadow_devices: creating playback lanes requires Administrator or '
          'Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_capture FROM public.captures WHERE id = p_capture_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ensure_shadow_devices: no capture %', p_capture_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- THE PLAYBACK GATEWAY, found by its flag. The seed is the only thing that sets it, so this is
    -- the one gateway the seed makes; a stack upgraded with an older second one takes the oldest.
    SELECT * INTO v_gateway FROM public.gateways
     WHERE is_shadow AND NOT is_archived
     ORDER BY created_at
     LIMIT 1;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(
          'ensure_shadow_devices: this stack has no playback gateway. The platform seeds one; if it '
          'was archived, restore it from Archived Entities. No other gateway can be made one.');
    END IF;

    FOR v_wire_id IN
        SELECT jsonb_array_elements_text(coalesce(v_capture.manifest -> 'device_ids', '[]'::jsonb))
    LOOP
        SELECT * INTO v_origin FROM public.devices WHERE sparkplug_id = v_wire_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
              'ensure_shadow_devices: the capture records device %, which this stack does not '
              'know. A playback lane stands in for a real machine, and there is none here to '
              'stand in for.', v_wire_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        -- THE ORIGINAL MAY ITSELF BE A SHADOW if someone captured a playback. Refused: the lane
        -- already exists and is the one to replay onto, and a shadow of a shadow is a chain whose
        -- far end nobody can name.
        IF v_origin.shadow_of IS NOT NULL THEN
            RAISE EXCEPTION
              'ensure_shadow_devices: % is itself a playback lane. Replay onto it directly rather '
              'than shadowing it.', v_origin.name
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT id INTO v_shadow_id FROM public.devices
         WHERE gateway_id = v_gateway.id AND shadow_of = v_origin.id;

        IF NOT FOUND THEN
            INSERT INTO public.devices (
                name, gateway_id, shadow_of, status, conformance_policy, description
            ) VALUES (
                left(v_origin.name, 96) || ' (replay)',
                v_gateway.id,
                v_origin.id,
                'OFFLINE',
                v_origin.conformance_policy,
                'Replays recordings of ' || v_origin.name || '. Not a machine: its readings are '
                'genuine but were observed elsewhere, at another time.'
            )
            RETURNING id INTO v_shadow_id;

            -- THE CONTRACT, COPIED: the original's schemas, as device_submodels rows. Without them
            -- a replay is either unjudged or wholly rejected, and both look like a broken capture.
            INSERT INTO public.device_submodels (device_id, schema_id, submodel_key)
            SELECT v_shadow_id, ds.schema_id, ds.submodel_key
              FROM public.device_submodels ds
             WHERE ds.device_id = v_origin.id;
        END IF;

        v_map := v_map || jsonb_build_object(
            v_wire_id,
            (SELECT sparkplug_id FROM public.devices WHERE id = v_shadow_id)
        );
    END LOOP;

    IF v_map = '{}'::jsonb THEN
        PERFORM public.raise_not_found(format(
          'ensure_shadow_devices: capture %s names no devices, so there is nothing to replay as. A '
          'gateway-scoped capture that recorded only node-level messages has no device data in it.',
          p_capture_id));
    END IF;

    RETURN v_map;
END;
$$;

ALTER FUNCTION public.ensure_shadow_devices(p_capture_id uuid) OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- start_playback_job() maps only onto the lane of the device a key names
-- -------------------------------------------------------------------------------------------------
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
    v_lane     RECORD;
    v_origin   RECORD;
    v_named    text;
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
          'Choose the Playback gateway, the only gateway a capture can be played back onto.',
          v_gateway.name
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
    -- "remote and enrolled" and excludes every host-run gateway.
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
    -- Every key is a recorded device's sparkplug_id and every value the sparkplug_id it is
    -- published as. Each target must be an active device of this gateway: publishing another
    -- gateway's device segment is exactly what `verify_gateway_binding()` quarantines. It must
    -- also be a replay lane (`shadow_of` set) and the lane of the device its key names. A replay
    -- writes readings into the history of the device it publishes as, so a real device, or the
    -- lane of some other device, is never a target.
    FOR v_key, v_target IN SELECT key, value FROM jsonb_each_text(coalesce(p_device_map, '{}'::jsonb))
    LOOP
        SELECT d.name, d.shadow_of, o.name AS origin_name INTO v_lane
          FROM public.devices d
          LEFT JOIN public.devices o ON o.id = d.shadow_of
         WHERE d.sparkplug_id = v_target AND d.gateway_id = p_target_gateway_id
           AND NOT d.is_archived;
        IF NOT FOUND THEN
            RAISE EXCEPTION
              'start_playback_job: % maps to %, which is not an active device of gateway %.',
              v_key, v_target, v_gateway.name
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        SELECT o.id, o.name INTO v_origin FROM public.devices o WHERE o.sparkplug_id = v_key;
        v_named := coalesce(v_origin.name || ' (' || v_key || ')', v_key);

        IF v_lane.shadow_of IS NULL THEN
            RAISE EXCEPTION
              'start_playback_job: % maps to % (%), which is a real device and not a replay lane. A '
              'replay writes recorded readings into the history of the device it publishes as, so it '
              'may only publish as a lane. Prepare the replay lanes for this capture and map onto '
              'those.', v_named, v_lane.name, v_target
                USING ERRCODE = 'check_violation';
        END IF;

        IF v_origin.id IS DISTINCT FROM v_lane.shadow_of THEN
            RAISE EXCEPTION
              'start_playback_job: % maps to % (%), the replay lane of %, which is not the device the '
              'recording names. A lane replays only the device it stands in for.',
              v_named, v_lane.name, v_target, v_lane.origin_name
                USING ERRCODE = 'check_violation';
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

ALTER FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) OWNER TO postgres;

COMMENT ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) IS 'Queue a capture for publication onto a simulated gateway. The only way a playback_jobs row is created. Refuses a target that is not is_simulated, one holding no broker credential, a device map naming a device that is not an active replay lane of the gateway and of the device its key names, and a second concurrent playback onto the same edge node. See 0056''s header for the three tiers this is the first of.';

-- -------------------------------------------------------------------------------------------------
-- Self-check: the trigger is in place, and the three redeclared bodies say what this file changed.
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_src text;
BEGIN
  IF public.live_trigger_statement('public.gateways', 'trg_gateways_playback_flag_is_seeded') IS NULL THEN
    RAISE EXCEPTION '0187: gateways has no trg_gateways_playback_flag_is_seeded';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.start_playback_job(uuid, uuid, jsonb, numeric)'::regprocedure;
  IF position('shadow_of' IN v_src) = 0 OR position('may_manage_captures' IN v_src) = 0 THEN
    RAISE EXCEPTION '0187: start_playback_job() does not check the lane, or has lost its caller check';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.refuse_archiving_the_last_shadow_gateway()'::regprocedure;
  IF position('another gateway' IN v_src) > 0 THEN
    RAISE EXCEPTION '0187: the archive refusal still tells an operator to mark another gateway';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.ensure_shadow_devices(uuid)'::regprocedure;
  IF position('mark another gateway' IN v_src) > 0 THEN
    RAISE EXCEPTION '0187: ensure_shadow_devices() still tells an operator to mark another gateway';
  END IF;
END
$$;
