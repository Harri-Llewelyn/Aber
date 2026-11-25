-- 0328: A match is offered only for a device nobody registered.
--
-- Quarantine holds two kinds of device: one Aber has never admitted, and a registered one held again,
-- because it came through another gateway or published a faulty id (ingest_requarantine_device()).
-- Nothing on the row told them apart, so Accept Match could be offered for a registered device and
-- delete it, with its schemas, nameplate, links and captures. And approve_quarantined_device()'s merge
-- checked neither device: not that the one it deletes is held, nor that the one it keeps is still
-- waiting for its first birth.
--
--   * devices.requarantined_at is when a registered device was last held again. A trigger writes it as
--     is_quarantined goes from false to true, whoever holds the device. A device never admitted arrives
--     with the flag already true, so its column is null.
--   * The file that adds the column fills it for the devices held at the upgrade, from the Audit Trail.
--   * approve_quarantined_device()'s merge refuses, in words a person reads: a device that is not in
--     Quarantine or was registered before, and a target that is archived, quarantined or has been seen.
--
-- The dashboard reads the column, and offers no match for a device that has it.
--
-- Redefines public.approve_quarantined_device: its merge refuses a device that is not in Quarantine or
--   was registered before it was held, and a target that is archived, in Quarantine or has been seen
--
-- Reasoning: supabase/README.md, "A match is offered only for a device nobody registered (0328)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The column, what the devices held now were, and the hold that writes it
-- -------------------------------------------------------------------------------------------------
-- One transaction, so no hold falls between the column and its trigger. The fill runs on the boot that
-- adds the column and on no later one. The trail keeps every hold, an UPDATE of the device with the flag
-- true after it and not before, and classes it lifecycle, so the fill reads that class's index alone.
BEGIN;

DO $column$
DECLARE
  v_filled integer;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = 'requarantined_at') THEN
    RETURN;
  END IF;

  ALTER TABLE public.devices ADD COLUMN requarantined_at timestamptz;

  UPDATE public.devices d
     SET requarantined_at = held.last_at
    FROM (SELECT a.entity_id, max(a.recorded_at) AS last_at
            FROM public.audit_trail a
           WHERE public.audit_event_class(a.action, a.entity_type, a.audit_domain, a.old_data, a.new_data) = 'lifecycle'
             AND a.entity_type = 'devices'
             AND a.action = 'UPDATE'
             AND a.entity_id IN (SELECT q.id FROM public.devices q WHERE q.is_quarantined)
             AND (a.new_data -> 'is_quarantined') = 'true'
             AND (a.old_data -> 'is_quarantined') IS DISTINCT FROM 'true'
           GROUP BY a.entity_id) held
   WHERE d.id = held.entity_id;
  GET DIAGNOSTICS v_filled = ROW_COUNT;
  IF v_filled > 0 THEN
    RAISE NOTICE '0328: % device(s) in Quarantine were registered before they were held', v_filled;
  END IF;
END
$column$;

COMMENT ON COLUMN public.devices.requarantined_at IS
  'When this device was last held in Quarantine after it had been registered (0328). Null means it has '
  'never been held again: a device Aber never admitted, or one never held. Written by '
  'trg_devices_requarantined and kept when the device is approved. approve_quarantined_device() refuses '
  'to merge a device that has it into another.';

CREATE OR REPLACE FUNCTION public.stamp_requarantined_device() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.requarantined_at := now();
  RETURN NEW;
END $$;

ALTER FUNCTION public.stamp_requarantined_device() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stamp_requarantined_device() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.stamp_requarantined_device() IS 'Writes devices.requarantined_at as a device that was not in Quarantine is held there, whoever holds it: ingest_requarantine_device(), or a PATCH of is_quarantined (0328).';

SELECT public.replay_trigger('public.devices', 'trg_devices_requarantined', $ddl$
CREATE TRIGGER trg_devices_requarantined BEFORE UPDATE OF is_quarantined ON public.devices FOR EACH ROW WHEN (((new.is_quarantined IS TRUE) AND (old.is_quarantined IS NOT TRUE))) EXECUTE FUNCTION public.stamp_requarantined_device();
$ddl$);

COMMIT;

-- -------------------------------------------------------------------------------------------------
-- 2. approve_quarantined_device()
-- -------------------------------------------------------------------------------------------------
-- 0293's, with the merge's refusals after both rows are locked. Each is raise_exception, the one code
-- the approve-quarantine function answers with the sentence itself (409). Nothing else changes: not the
-- actor re-check, what the merge writes, or the straight approval.
CREATE OR REPLACE FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid DEFAULT NULL::uuid, p_merge_into_device_id uuid DEFAULT NULL::uuid, p_asset_name text DEFAULT NULL::text, p_cell_id uuid DEFAULT NULL::uuid, p_location_scope text DEFAULT NULL::text, p_set_cell boolean DEFAULT false, p_set_location_scope boolean DEFAULT false, p_area_id uuid DEFAULT NULL::uuid, p_set_area boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_quarantined public.devices%ROWTYPE;
  v_candidate   public.devices%ROWTYPE;
  v_result      public.devices%ROWTYPE;
  v_actor_role  text;
  v_cell        uuid := p_cell_id;
  v_area        uuid := p_area_id;
BEGIN
  -- Authorization is re-derived from the database rather than taken on trust. The edge function
  -- checks too; this is the check that still holds if the RPC is ever reached another way.
  SELECT r.name INTO v_actor_role
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_actor_id
   LIMIT 1;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('Administrator', 'Shopfloor_Manager') THEN
    RAISE EXCEPTION 'actor % is not permitted to approve quarantined devices', p_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Attribute every trigger-written audit row in this transaction to the operator. SET LOCAL, so
  -- it is discarded at COMMIT and cannot bleed into the connection's next user.
  PERFORM set_config('aber.actor_id', p_actor_id::text, true);

  SELECT * INTO v_quarantined FROM public.devices WHERE id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('quarantined device %s not found', p_device_id));
  END IF;

  -- ---------------------------------------------------------------------------------------
  -- Merge path: absorb a discovered duplicate into the row that was already provisioned.
  -- ---------------------------------------------------------------------------------------
  IF p_merge_into_device_id IS NOT NULL THEN
    IF p_merge_into_device_id = p_device_id THEN
      RAISE EXCEPTION 'cannot merge device % into itself', p_device_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Two named ids and a short transaction; the FOR UPDATE is what stops a concurrent approval
    -- racing this one into two live rows.
    SELECT * INTO v_candidate FROM public.devices WHERE id = p_merge_into_device_id FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM public.raise_not_found(format('target device %s not found', p_merge_into_device_id));
    END IF;

    -- Both rows are locked, so what is read here is what the merge acts on, however old the list a
    -- person chose from. A device that was registered carries more than its identity, and a target
    -- that has been seen is another machine. The sentences are shown as they are worded.
    IF v_quarantined.is_quarantined IS NOT TRUE THEN
      RAISE EXCEPTION '"%" is not in Quarantine, so it was not merged. It may have been approved since the list was read.',
        v_quarantined.name USING ERRCODE = 'raise_exception';
    END IF;
    IF v_quarantined.requarantined_at IS NOT NULL THEN
      RAISE EXCEPTION '"%" was registered before it was held in Quarantine, so it was not merged. Merging deletes what is set on it, such as its schemas and nameplate. Approve it instead.',
        v_quarantined.name USING ERRCODE = 'raise_exception';
    END IF;
    IF v_candidate.is_archived IS TRUE THEN
      RAISE EXCEPTION '"%" is archived, so nothing was merged into it. Restore it first.',
        v_candidate.name USING ERRCODE = 'raise_exception';
    END IF;
    IF v_candidate.is_quarantined IS TRUE THEN
      RAISE EXCEPTION '"%" is in Quarantine itself, so nothing was merged into it.',
        v_candidate.name USING ERRCODE = 'raise_exception';
    END IF;
    IF v_candidate.first_dbirth_at IS NOT NULL THEN
      RAISE EXCEPTION '"%" has already sent its first birth, so nothing was merged into it. It is a device of its own.',
        v_candidate.name USING ERRCODE = 'raise_exception';
    END IF;

    -- asset_config is keyed by sparkplug_id, not by row id, so the recorded birth parameters
    -- have to be re-keyed onto the surviving row.
    UPDATE public.asset_config
       SET asset_id = v_candidate.sparkplug_id
     WHERE asset_id = v_quarantined.sparkplug_id;

    -- reported_identity carries over deliberately: the physical device keeps publishing under
    -- the id it announced, and that is what ingestion has to keep resolving. Without it the
    -- merged device is re-quarantined on its very next birth. The candidate's deliberately
    -- provisioned fields (gateway_id, its device_submodels) are left alone.
    UPDATE public.devices
       SET status            = v_quarantined.status,
           first_dbirth_at   = COALESCE(v_candidate.first_dbirth_at, v_quarantined.first_dbirth_at),
           reported_identity = v_quarantined.reported_identity,
           identity_source   = v_quarantined.identity_source,
           quarantine_reason = NULL,
           is_quarantined    = false
     WHERE id = v_candidate.id
    RETURNING * INTO v_result;

    DELETE FROM public.devices WHERE id = v_quarantined.id;

    RETURN jsonb_build_object(
      'merged', true,
      'device', to_jsonb(v_result),
      'discarded_device_id', v_quarantined.id
    );
  END IF;

  -- ---------------------------------------------------------------------------------------
  -- Straight approval.
  -- ---------------------------------------------------------------------------------------
  -- Mirrors the scope CHECKs: a site-wide asset, or one that follows its gateway, names neither
  -- cell nor area, an area-wide one names its area and no cell, a cell-scoped one names its cell and
  -- no area. Cleared here rather than left to a constraint violation the caller cannot interpret.
  IF p_set_location_scope AND p_location_scope IN ('site_wide', 'gateway') THEN
    v_cell := NULL;
    v_area := NULL;
  ELSIF p_set_location_scope AND p_location_scope = 'area_wide' THEN
    v_cell := NULL;
    IF v_area IS NULL THEN
      RAISE EXCEPTION 'an area_wide device must name its area'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_set_location_scope THEN
    v_area := NULL;
    -- The cell the row will hold: the one named when the call answers the cell, else the one it has.
    IF p_location_scope = 'cell'
       AND ((p_set_cell AND v_cell IS NULL) OR (NOT p_set_cell AND v_quarantined.cell_id IS NULL)) THEN
      RAISE EXCEPTION 'a cell device must name its cell'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  UPDATE public.devices
     SET is_quarantined    = false,
         quarantine_reason = NULL,
         gateway_id        = p_gateway_id,
         -- LOCATION IS OMITTED WHEN NOT ANSWERED, NEVER DEFAULTED. A device arrives following its
         -- gateway, so writing a value the operator did not choose would pin it to a place of its
         -- own for every device approved this way. The p_set_* flags are what distinguish "not
         -- supplied" from "explicitly cleared" -- a plain NULL argument cannot express the
         -- difference. Any scope but cell clears the cell whether or not one was supplied, since
         -- the CHECK would refuse the pair.
         cell_id           = CASE WHEN p_set_cell OR (p_set_location_scope AND p_location_scope <> 'cell')
                                  THEN v_cell ELSE cell_id END,
         area_id           = CASE WHEN p_set_area OR p_set_location_scope THEN v_area ELSE area_id END,
         location_scope    = CASE WHEN p_set_location_scope THEN p_location_scope ELSE location_scope END,
         name              = COALESCE(NULLIF(btrim(COALESCE(p_asset_name, '')), ''), name)
   WHERE id = p_device_id
  RETURNING * INTO v_result;

  RETURN jsonb_build_object('merged', false, 'device', to_jsonb(v_result));
END;
$$;
ALTER FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) FROM PUBLIC, anon;

COMMENT ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) IS 'Atomically approves or merges a quarantined device. Re-checks the actor role against public.user_roles and attributes the resulting audit_trail rows to that actor. Takes the four location scopes (gateway, cell, area_wide, site_wide); location is written only when answered. A scope of gateway clears the cell and the area, and a cell scope that names no cell is refused. A merge is refused, with a sentence a person reads (raise_exception), when the device is not in Quarantine or was registered before it was held, and when the target is archived, in Quarantine or has been seen (0328).';

-- -------------------------------------------------------------------------------------------------
-- 3. Self-check: structure only.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_src   text := (SELECT prosrc FROM pg_proc
                    WHERE oid = 'public.approve_quarantined_device(uuid, uuid, uuid, uuid, text, uuid, text, boolean, boolean, uuid, boolean)'::regprocedure);
  v_reads text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = 'requarantined_at'
                    AND data_type = 'timestamp with time zone' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION '0328: devices.requarantined_at is missing, or is not a nullable timestamptz';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.devices'::regclass
                    AND t.tgname = 'trg_devices_requarantined'
                    AND t.tgfoid = 'public.stamp_requarantined_device()'::regprocedure
                    AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '0328: public.devices has no enabled trg_devices_requarantined';
  END IF;

  -- Each refusal reads its column before the merge writes anything.
  FOREACH v_reads IN ARRAY ARRAY['v_quarantined.is_quarantined IS NOT TRUE', 'v_quarantined.requarantined_at IS NOT NULL',
                                 'v_candidate.is_archived IS TRUE', 'v_candidate.is_quarantined IS TRUE',
                                 'v_candidate.first_dbirth_at IS NOT NULL'] LOOP
    IF position(v_reads IN v_src) NOT BETWEEN 1 AND position('UPDATE public.asset_config' IN v_src) THEN
      RAISE EXCEPTION '0328: approve_quarantined_device() merges without reading %', v_reads;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.stamp_requarantined_device()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stamp_requarantined_device()', 'EXECUTE') THEN
    RAISE EXCEPTION '0328: an API role may execute stamp_requarantined_device()';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
