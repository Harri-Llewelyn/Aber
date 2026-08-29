-- =============================================================================================
-- 0060: an edge node that exists only to be replayed as, and the lanes behind it
-- =============================================================================================
--
-- A capture cannot be published under the identity it was recorded from -- `mosquitto.acl` pins the
-- topic's edge-node segment to the connecting username -- so playback has always been one gateway
-- rewriting captured identities onto its own devices. Until now that gateway was any `is_simulated`
-- one, which in practice meant a simulator: a node Node-RED is publishing as at the same time.
--
-- TWO PUBLISHERS ON ONE EDGE NODE IS NOT A RACE, IT IS A CORRUPTED STREAM, and Sparkplug makes it
-- structural rather than incidental. `seq` is scoped to the EDGE NODE, not to the connection --
-- ingestion.py keys `_last_seq` on `(group, edge_node)` exactly as the specification requires. Two
-- publishers under one identity are incrementing separate private counters into one shared
-- sequence, so the daemon sees 41, 12, 42, 13 and `check_message_sequence()` does the correct thing
-- with that: it concludes a message was dropped and asks for a rebirth. The live node then births
-- mid-playback, the alias table is rebuilt from ITS metrics while replayed frames are still
-- arriving against the old aliases, and the next frame trips the gap detector again. Every part of
-- that loop is behaving as designed.
--
-- Nothing fixes it by staggering, throttling or quieting one side. As long as two publishers share
-- one edge node identity the stream is corrupt by definition, so the answer is an identity nothing
-- else publishes as.
--
-- WHY NOT A STAND-DOWN COMMAND, which is the other obvious answer and was considered first:
--   * Sparkplug defines four node control metrics -- Rebirth, Reboot, Next Server, Scan Rate. There
--     is no "stand down", so it would be a private metric name that works on gateways we wrote and
--     is ignored by every conformant node, while the dashboard reports success;
--   * it is a different KIND of command from the one thing this stack sends. `0058` draws that line
--     and puts a self-check on it: a rebirth asks a node to restate what it already is, and a node
--     that ignores it is in exactly the state it was. "Stop reporting" is not idempotent, carries
--     intent about the process, and on a real plant blinds whoever is watching -- with the failure
--     mode being the stand-down landing and the stand-up never doing.
-- Quieting the simulator is a legitimate thing to want, and it belongs in the simulator: a
-- per-gateway enable flag in Node-RED's own flow context, with no path from the dashboard and no
-- MQTT command involved. Node-RED is ours to switch off; that is not the platform gaining the
-- ability to switch off a node.
--
-- ---------------------------------------------------------------------------------------------
-- SHADOW DEVICES, AND WHY THEY ARE NOT COPIES
-- ---------------------------------------------------------------------------------------------
-- The target's devices are what a playback can publish as -- `start_playback_job()` refuses a map
-- naming devices of another gateway, because `verify_gateway_binding()` would quarantine them. So
-- the playback gateway needs devices, and they are stand-ins for real machines: a lane for a
-- recording of an asset, not a second asset.
--
-- That distinction decides every field, and getting it wrong is not cosmetic:
--
--   * NO NAMEPLATE. `device_nameplate` (0011) is IDTA Nameplate -- manufacturer, SERIAL NUMBER,
--     year of construction. A serial number identifies one physical object. Copying it would leave
--     the platform holding two rows claiming to be serial XYZ-4471, and the AAS Part 5 export would
--     emit two Asset Administration Shells asserting the same asset identity, which is the exact
--     thing AAS identity exists to prevent. Nothing is copied and nothing needs to be: 0011's rule
--     is that a device with no nameplate data has NO ROW rather than a row of nulls, and the
--     exporter omits an empty submodel entirely. A shadow exports without a Nameplate submodel,
--     which is honest -- it is not a product and has no manufacturer.
--
--   * NO LINKS. `links` are documents ABOUT the machine, and a copy goes stale the moment someone
--     edits the original. `shadow_of` resolves them at read time instead.
--
--   * THE SCHEMAS ARE COPIED, and this one is mandatory rather than optional. `schema_id` and
--     `device_submodels` are the METRIC CONTRACT -- what device_modelled_constraints() judges DDATA
--     against. A shadow replaying a machine's metrics without that machine's schema is either
--     unjudged, or, where conformance is set to enforce, has every replayed metric rejected while
--     the job reports success. A contract is not an identity; copying it is correct.
--
--   * NO CELL. A replay is not on the shopfloor. `0059`'s Shadow lane is where it resolves, and
--     `gateways_synthetic_has_no_cell` means there is nothing to inherit in the first place.
--
--   * THE NAME IS SET, NOT COPIED -- '<name> (replay)'. It is the one field where a copy is
--     actively harmful, because it is what appears in a chart legend.
--
-- ONE SHADOW PER REAL DEVICE, REUSED. Replaying the same capture three times should put three
-- replays on one lane, not create three lanes: a stable asset_id is what lets a comparison chart
-- hold still between runs, and what keeps the historian from growing a new series per playback.
--
-- `shadow_of` IS NOT THE MISTAKE 0052 AND 0059 GUARD AGAINST. Those forbid a device-level COPY of
-- a gateway flag, because a stored copy can disagree with its source. This stores something the
-- gateway does not know: WHICH machine this lane stands in for. Lane membership still derives from
-- the gateway; provenance is a different fact and has nowhere else to live.
--
-- ---------------------------------------------------------------------------------------------
-- THE GATE IS A TRIGGER, NOT AN EDIT TO start_playback_job()
-- ---------------------------------------------------------------------------------------------
-- Tightening tier one in place would mean restating 0056's 120-line function here so that one
-- `IF` could change, leaving two full copies to drift. A BEFORE INSERT trigger on `playback_jobs`
-- fires on exactly the same path -- that function is the table's only writer -- states its own
-- reasoning where a reader will find it, and is strictly stronger: it holds for a future writer
-- that forgets, which a copied `IF` would not.
--
-- WHAT THIS BREAKS, DELIBERATELY: a playback onto a simulator. That is the collision above, and
-- refusing it is the point. Making one work again needs the target's broker credential, which is
-- the same mint the Access Control page already performs for any virtual gateway -- see the
-- NOTICE this migration raises.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS, ON CONFLICT DO UPDATE for the seeded row, CREATE OR REPLACE
-- for the functions: db-init replays every migration on every boot in filename order.
--
-- Related: 0011 (device_nameplate, and the empty-submodel rule), 0052 (is_simulated),
--          0055 (captures and the manifest this reads device_ids from),
--          0056 (playback_jobs, start_playback_job, the three tiers),
--          0058 (the line this does not cross), 0059 (is_shadow and the Shadow lane),
--          ingestion/capture.py plan_playback() (which rewrites the identities).
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. Which machine a lane stands in for
-- ---------------------------------------------------------------------------------------------
-- ON DELETE SET NULL rather than CASCADE. A shadow outliving its original is a lane whose label
-- has gone vague, which is recoverable; CASCADE would delete the lane and orphan every telemetry
-- row keyed on its sparkplug_id in TimescaleDB, which is not.
ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS shadow_of uuid;

DO $fk$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'devices_shadow_of_fkey' AND conrelid = 'public.devices'::regclass
    ) THEN
        ALTER TABLE public.devices
            ADD CONSTRAINT devices_shadow_of_fkey FOREIGN KEY (shadow_of)
            REFERENCES public.devices(id) ON DELETE SET NULL;
    END IF;
END;
$fk$;

-- A device cannot stand in for itself. Cheap, same-row, and it is the shape a mis-written map
-- would take -- ensure_shadow_devices() resolving to the original instead of to its lane.
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_shadow_of_is_not_self;
ALTER TABLE public.devices ADD CONSTRAINT devices_shadow_of_is_not_self
    CHECK (shadow_of IS NULL OR shadow_of <> id);

-- ONE LANE PER MACHINE PER GATEWAY, which is what makes ensure_shadow_devices() a reuse rather
-- than a mint. Partial, so the index holds only the shadows and not the whole device table.
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_shadow_per_gateway
    ON public.devices (gateway_id, shadow_of)
    WHERE shadow_of IS NOT NULL;

COMMENT ON COLUMN public.devices.shadow_of IS
  'For a shadow device: the real machine whose recordings this lane replays. NULL for every '
  'ordinary device. This is PROVENANCE, not a copy of a gateway flag -- whether a device is '
  'synthetic still derives from gateways.is_shadow / is_simulated (see 0052 and 0059), and this '
  'stores the one thing the gateway cannot know. Set only by ensure_shadow_devices().';


-- ---------------------------------------------------------------------------------------------
-- 2. The gateway
-- ---------------------------------------------------------------------------------------------
-- A PINNED UUID, following the seeded gateways' convention, because `sparkplug_id` is GENERATED
-- from the primary key: a random id would make the broker account name unpredictable, and the
-- account is configured by hand. 16000000-... continues the 12/13/14/15 series and yields
-- `gwy160000000000400080000`.
--
-- is_virtual: no appliance exists. is_simulated: its telemetry is generated rather than observed.
-- is_shadow: it publishes recordings specifically -- and gateways_shadow_is_simulated (0059)
-- requires the middle one, so all three are stated rather than inferred.
--
-- NO CELL AND NO SITE-WIDE ASSERTION. gateways_synthetic_has_no_cell forbids the first; the second
-- would be a claim that this thing is somewhere on the site, and it is not anywhere.
INSERT INTO public.gateways (id, name, description, is_virtual, is_simulated, is_shadow, location_scope)
VALUES (
    '16000000-0000-4000-8000-000000000001',
    'Playback',
    'Publishes recorded captures. Nothing else publishes as this edge node, which is the point: '
    'two publishers sharing one Sparkplug identity interleave their seq counters and the daemon '
    'reads that as permanent message loss.',
    true, true, true, 'cell'
)
ON CONFLICT (id) DO UPDATE
    -- RECONCILED, NOT LEFT AS FOUND. The flags are what the gate below tests, so a row that lost
    -- one -- an edit, a partial restore -- would silently make every playback impossible with an
    -- error naming the gateway rather than the flag. The NAME is deliberately not reconciled:
    -- renaming a gateway is an operator's to do, and 0059's lane does not read the name.
    SET is_virtual = true, is_simulated = true, is_shadow = true, cell_id = NULL;


-- ---------------------------------------------------------------------------------------------
-- 3. Minting the lanes
-- ---------------------------------------------------------------------------------------------
-- RETURNS THE DEVICE MAP, so the caller passes straight into start_playback_job() and there is no
-- second place that has to know how a captured id becomes a target id.
--
-- READS `captures.manifest->'device_ids'`, which capture_worker.py records: the Sparkplug ids
-- actually observed on the wire during the recording. Not `captures.device_id`, which is set only
-- for a device-scoped capture and is NULL for the gateway-scoped ones this mostly serves.
--
-- A CAPTURE NAMING A DEVICE THIS STACK DOES NOT KNOW IS REFUSED rather than given an anonymous
-- lane. It happens for an uploaded capture from another deployment, and the honest answer is that
-- there is no machine here for the lane to stand in for -- a shadow with no `shadow_of` is an
-- asset with no provenance, which is the thing this design exists to avoid creating.
CREATE OR REPLACE FUNCTION public.ensure_shadow_devices(p_capture_id uuid)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
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

    -- THE SINGLE SHADOW GATEWAY, found by its flag rather than by the pinned id above. An operator
    -- may legitimately want a second one -- two playbacks at once need two edge nodes, since
    -- playback_jobs allows only one RUNNING per target -- and looking it up by flag means that
    -- works without this function being edited. More than one is ambiguous and says so.
    SELECT * INTO v_gateway FROM public.gateways
     WHERE is_shadow AND NOT is_archived
     ORDER BY created_at
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION
          'ensure_shadow_devices: this stack has no playback gateway. One is seeded by migration '
          '0060; if it was archived, restore it or mark another gateway is_shadow.'
            USING ERRCODE = 'no_data_found';
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
                name, gateway_id, shadow_of, status, schema_id, conformance_policy, description
            ) VALUES (
                left(v_origin.name, 96) || ' (replay)',
                v_gateway.id,
                v_origin.id,
                'OFFLINE',
                -- THE CONTRACT, COPIED. See this migration's header: without it a replay is either
                -- unjudged or wholly rejected, and both look like a broken capture.
                v_origin.schema_id,
                v_origin.conformance_policy,
                'Replays recordings of ' || v_origin.name || '. Not a machine: its readings are '
                'genuine but were observed elsewhere, at another time.'
            )
            RETURNING id INTO v_shadow_id;

            -- The many-to-many half of the same contract. `device_schemas` unions this with
            -- devices.schema_id, so copying only one of the two silently narrows what the shadow
            -- is judged against for every device provisioned with submodels.
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
        RAISE EXCEPTION
          'ensure_shadow_devices: capture % names no devices, so there is nothing to replay as. A '
          'gateway-scoped capture that recorded only node-level messages has no device data in it.',
          p_capture_id
            USING ERRCODE = 'no_data_found';
    END IF;

    RETURN v_map;
END;
$fn$;

COMMENT ON FUNCTION public.ensure_shadow_devices(uuid) IS
  'Find or create one shadow device per device named in a capture''s manifest, bound to the '
  'playback gateway, and return the device map start_playback_job() takes. Reuses an existing lane '
  'rather than minting per playback, so a comparison chart holds still between runs. Copies the '
  'metric contract (schema_id and device_submodels) and nothing else -- notably not the nameplate, '
  'whose serial number identifies one physical object. See 0060''s header.';

REVOKE ALL ON FUNCTION public.ensure_shadow_devices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_shadow_devices(uuid) TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 4. The gate
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.playback_target_must_be_shadow()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_gateway public.gateways;
BEGIN
    SELECT * INTO v_gateway FROM public.gateways WHERE id = NEW.target_gateway_id;

    IF NOT FOUND OR NOT v_gateway.is_shadow THEN
        RAISE EXCEPTION
          'playback: % is not a playback gateway. A capture must be published onto an edge node '
          'nothing else publishes as -- two publishers share one Sparkplug seq counter, and the '
          'daemon reads the interleaving as permanent message loss and asks the live node for a '
          'rebirth mid-playback. Choose the Playback gateway (0060).',
          coalesce(v_gateway.name, NEW.target_gateway_id::text)
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_playback_target_must_be_shadow ON public.playback_jobs;
CREATE TRIGGER trg_playback_target_must_be_shadow
    BEFORE INSERT ON public.playback_jobs
    FOR EACH ROW EXECUTE FUNCTION public.playback_target_must_be_shadow();


-- ---------------------------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------------------------
-- WHAT CAN ACTUALLY FAIL is the seeded row losing a flag, and the nameplate decision being
-- reversed by a later migration that "completes" a shadow's AAS export. The second is the one
-- worth a check, because it would look like a fix.
DO $selfcheck$
DECLARE
    v_gw       public.gateways;
    v_bad      integer;
    v_lanes    integer;
    v_credited boolean;
BEGIN
    SELECT * INTO v_gw FROM public.gateways WHERE id = '16000000-0000-4000-8000-000000000001';
    IF NOT FOUND OR NOT (v_gw.is_shadow AND v_gw.is_simulated AND v_gw.cell_id IS NULL) THEN
        RAISE EXCEPTION '0060 self-check: the Playback gateway is missing or has lost a flag.';
    END IF;

    SELECT count(*) INTO v_bad
      FROM public.device_nameplate np
      JOIN public.devices d ON d.id = np.device_id
     WHERE d.shadow_of IS NOT NULL;
    IF v_bad > 0 THEN
        RAISE EXCEPTION
          '0060 self-check: % shadow device(s) carry a nameplate. IDTA Nameplate holds a SERIAL '
          'NUMBER, which identifies one physical object -- a copy makes the AAS export emit two '
          'shells asserting the same asset identity. A replay lane is not a product and has no '
          'manufacturer; 0011''s empty-submodel rule already omits it correctly.', v_bad;
    END IF;

    SELECT count(*) INTO v_lanes FROM public.devices WHERE shadow_of IS NOT NULL;
    v_credited := public.gateway_has_broker_credential(v_gw);

    RAISE NOTICE
      '0060 self-check: the Playback gateway (%) is present with % playback lane(s) behind it. %',
      v_gw.sparkplug_id, v_lanes,
      CASE WHEN v_credited
           THEN 'It holds a broker credential; add it to MQTT_PLAYBACK_CREDENTIALS if you have not.'
           ELSE 'IT HOLDS NO BROKER CREDENTIAL YET, so every playback will be refused. Mint one on '
                'the Access Control page, then put it in MQTT_PLAYBACK_CREDENTIALS as '
                '{"' || v_gw.sparkplug_id || '":"<password>"} and restart the playback worker.'
      END;
END;
$selfcheck$;
