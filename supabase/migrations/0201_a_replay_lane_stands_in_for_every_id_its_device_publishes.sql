-- 0201: A replay lane stands in for every id its device publishes.
--
-- A capture keeps each device under the id on the wire, and the playback worker rewrites that id
-- through the job's device map. A device admitted from Quarantine publishes its own id
-- (reported_identity), and one addressed by its Factory+ Instance_UUID publishes its UUID. So a
-- capture of either names an id that is not the device's sparkplug_id. ensure_shadow_devices() and
-- start_playback_job() looked the recorded device up by sparkplug_id alone, so such a capture was
-- refused as recording a device this stack does not know.
--
--   * captured_device_id() resolves an id a capture recorded as ingestion resolves the wire id
--     (ingestion/README.md, "Resolution precedence"): the issued sparkplug_id, then a device's own
--     reported_identity, then its UUID in any letter case. An own id is unique only behind one
--     edge node, so it names the capture's own device, else a device of the capture's gateway,
--     else a device bound to none.
--   * ensure_shadow_devices() makes the lane of the device it resolves, keyed by the recorded id,
--     and start_playback_job() checks each map key's lane against the device it resolves.
--     Otherwise both are unchanged from 0193.
--
-- Reasoning: supabase/README.md, "A replay lane stands in for every id its device publishes (0201)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The device a recorded id names
-- -------------------------------------------------------------------------------------------------
-- plpgsql, so the UUID cast runs only after the shape check passes.
CREATE OR REPLACE FUNCTION public.captured_device_id(p_gateway_id uuid, p_device_id uuid, p_wire_id text) RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
    v_id uuid;
BEGIN
    SELECT d.id INTO v_id FROM public.devices d WHERE d.sparkplug_id = p_wire_id;
    IF FOUND THEN
        RETURN v_id;
    END IF;

    -- Unique behind one edge node only (Sparkplug 3.0.0
    -- tck-id-topic-structure-namespace-duplicate-device-id-across-edge-node).
    SELECT d.id INTO v_id FROM public.devices d
     WHERE d.reported_identity = p_wire_id
       AND (d.id = p_device_id OR d.gateway_id = p_gateway_id OR d.gateway_id IS NULL)
     ORDER BY d.id = p_device_id DESC NULLS LAST, d.gateway_id IS NULL, d.created_at, d.id
     LIMIT 1;
    IF FOUND THEN
        RETURN v_id;
    END IF;

    IF p_wire_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT d.id INTO v_id FROM public.devices d WHERE d.id = p_wire_id::uuid;
        RETURN v_id;
    END IF;
    RETURN NULL;
END;
$$;

ALTER FUNCTION public.captured_device_id(p_gateway_id uuid, p_device_id uuid, p_wire_id text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.captured_device_id(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.captured_device_id(p_gateway_id uuid, p_device_id uuid, p_wire_id text) IS
  'The device an id a capture recorded names, or NULL: its issued sparkplug_id, then its own '
  'reported_identity, then its UUID in any letter case, the order ingestion resolves a wire id in. '
  'An own id names the capture''s own device (p_device_id), else a device of the capture''s gateway '
  '(p_gateway_id), else a device bound to no gateway. Called by ensure_shadow_devices() and '
  'start_playback_job() only (0201).';

-- -------------------------------------------------------------------------------------------------
-- 2. Starting a playback
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
    v_origin_id uuid;
    v_named    text;
    v_map      jsonb := coalesce(p_device_map, '{}'::jsonb);
    v_speed    numeric := least(greatest(coalesce(p_speed, 1.0), 0.01), 60);
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

    -- The target must be marked simulated: the historian records a replayed reading identically to
    -- an observed one, and `is_simulated` is the only thing that says otherwise. The BEFORE INSERT
    -- trigger playback_target_must_be_shadow() narrows this to the Playback gateway.
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

    -- The target must hold a broker credential. Not `status = 'ONLINE'`: a playback target is
    -- OFFLINE until a playback runs. `gateway_has_broker_credential()`, not
    -- `gateway_holds_a_credential()`, which means "remote and enrolled" and excludes every host-run
    -- gateway.
    IF NOT public.gateway_has_broker_credential(v_gateway) THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % holds no broker credential, so the playback worker cannot '
          'connect as it. Issue one from the Access Control page; the platform delivers the '
          'password to the worker within about a minute.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    -- The worker must hold the CURRENT password: the broker keeps one per gateway, so a re-issue
    -- replaces it, and until delivery the worker holds the previous one. A worker that has reported
    -- no observation at all is not listed by playback_stale_credentials() and is not refused.
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

    -- Every key is a device id as the capture recorded it, which captured_device_id() resolves,
    -- and every value the sparkplug_id it is published as. Each target must be an active device of
    -- this gateway: publishing another gateway's device segment is exactly what
    -- `verify_gateway_binding()` quarantines. It must also be a replay lane (`shadow_of` set) and
    -- the lane of the device its key names. A replay writes readings into the history of the
    -- device it publishes as, so a real device, or the lane of some other device, is never a target.
    FOR v_key, v_target IN SELECT key, value FROM jsonb_each_text(v_map)
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

        v_origin_id := public.captured_device_id(v_capture.gateway_id, v_capture.device_id, v_key);
        SELECT o.id, o.name INTO v_origin FROM public.devices o WHERE o.id = v_origin_id;
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

    -- One playback per target, reported rather than left to the index.
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
        v_gateway.sparkplug_group, v_map, v_speed, 'PENDING', auth.uid()
    )
    RETURNING id INTO v_job_id;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'playback_jobs', v_job_id, 'PLAYBACK_STARTED', NULL,
        public.capture_subject_identity(v_capture.subject_kind, v_capture.gateway_id,
                                        v_capture.device_id, v_capture.subject_sparkplug_id)
          || jsonb_build_object('capture_id', v_capture.id,
                                'capture_storage_path', v_capture.storage_path,
                                'capture_recorded_at', v_capture.recorded_at,
                                'target_gateway_id', v_gateway.id,
                                'target_name', v_gateway.name,
                                'target_sparkplug_id', v_gateway.sparkplug_id,
                                'device_map', v_map, 'speed', v_speed),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );

    RETURN v_job_id;
END;
$$;

ALTER FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) OWNER TO postgres;

COMMENT ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) IS
  'Queue a capture for publication onto the Playback gateway. The only way a playback_jobs row is '
  'created. Refuses a target that is not is_simulated, and the BEFORE INSERT trigger '
  'playback_target_must_be_shadow() refuses one that is not is_shadow, which only the seeded Playback '
  'gateway is. Refuses too a target holding no broker credential or whose credential the '
  'worker has not picked up since its re-issue, a device map naming a device that is not an active '
  'replay lane of the gateway and of the device its key names, and a second concurrent playback onto '
  'the same edge node. A key is a device id as the capture recorded it, resolved by '
  'captured_device_id(): the issued id, the device''s own id or its UUID (0201). Writes a '
  'PLAYBACK_STARTED audit row naming the capture, its subject and the target (0193).';

-- -------------------------------------------------------------------------------------------------
-- 3. Preparing the replay lanes
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_shadow_devices(p_capture_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_capture   public.captures;
    v_gateway   public.gateways;
    v_wire_id   text;
    v_origin_id uuid;
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

    -- The Playback gateway: the seed alone sets is_shadow, and an older second one loses to it.
    SELECT * INTO v_gateway FROM public.gateways
     WHERE is_shadow AND NOT is_archived
     ORDER BY created_at
     LIMIT 1;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(
          'ensure_shadow_devices: this stack has no Playback gateway, and a capture can be played '
          'back only there. If it is still missing, upgrade the release: the upgrade creates it '
          'again. No other gateway can be made one.');
    END IF;

    -- Each device under the id the capture recorded it by, which the map is keyed on.
    FOR v_wire_id IN
        SELECT jsonb_array_elements_text(coalesce(v_capture.manifest -> 'device_ids', '[]'::jsonb))
    LOOP
        v_origin_id := public.captured_device_id(v_capture.gateway_id, v_capture.device_id, v_wire_id);
        SELECT * INTO v_origin FROM public.devices WHERE id = v_origin_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
              'ensure_shadow_devices: the capture records device %, which this stack does not '
              'know. A replay lane stands in for a device that exists here, so a capture from '
              'another site, or of a device since deleted, cannot be played back.', v_wire_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        -- A capture of a playback: replay onto the lane itself rather than shadow a shadow.
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

            -- The original's schemas, so a replay is judged as the original is.
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
        IF v_capture.subject_kind = 'device' THEN
            PERFORM public.raise_not_found(format(
              'ensure_shadow_devices: capture %s of device %s holds none of that device''s messages, '
              'only its edge node''s, so there is nothing to replay. Record it again while the device '
              'is publishing.', p_capture_id, v_capture.subject_sparkplug_id));
        END IF;
        PERFORM public.raise_not_found(format(
          'ensure_shadow_devices: capture %s names no devices, so there is nothing to replay as. It '
          'holds only the gateway''s own node-level messages.', p_capture_id));
    END IF;

    RETURN v_map;
END;
$$;

ALTER FUNCTION public.ensure_shadow_devices(p_capture_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.ensure_shadow_devices(p_capture_id uuid) IS
  'Find or create one replay lane per device named in a capture''s manifest, bound to the Playback '
  'gateway, and return the device map start_playback_job() takes, keyed by the id the capture '
  'recorded. That id is resolved by captured_device_id(): the issued id, the device''s own id or its '
  'UUID (0201). Reuses an existing lane rather than minting per playback, so a comparison chart holds '
  'still between runs. Copies the metric contract (the device_submodels rows) and nothing else -- '
  'notably not the nameplate, whose serial number identifies one physical object.';

-- -------------------------------------------------------------------------------------------------
-- Self-check: this file's own declarations
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.start_playback_job(uuid, uuid, jsonb, numeric)',
                              'public.ensure_shadow_devices(uuid)'] LOOP
    IF position('captured_device_id(' IN (SELECT prosrc FROM pg_proc WHERE oid = v_fn::regprocedure)) = 0 THEN
      RAISE EXCEPTION '0201: % does not resolve a recorded device id through captured_device_id()', v_fn;
    END IF;
  END LOOP;
  IF position('''PLAYBACK_STARTED''' IN (SELECT prosrc FROM pg_proc
                                           WHERE oid = 'public.start_playback_job(uuid, uuid, jsonb, numeric)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0201: start_playback_job() no longer writes PLAYBACK_STARTED (0193)';
  END IF;

  IF has_function_privilege('anon', 'public.captured_device_id(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.captured_device_id(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.captured_device_id(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0201: an API role may call captured_device_id(), which only the playback gates use';
  END IF;

  -- An id shaped almost like a UUID is not cast.
  PERFORM public.captured_device_id(NULL, NULL, '00000000-0000-4000-8000-00000000000g');
END
$check$;

NOTIFY pgrst, 'reload schema';
