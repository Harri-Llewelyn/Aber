-- 0175: A device's schemas are its device_submodels rows; devices.schema_id is gone.
--
-- 1.1.0 deprecated writing `devices.schema_id` (0168) and announced its removal no sooner than
-- 1.2.0. The Devices page and set_device_schemas() already attach schemas as `device_submodels`
-- rows. This moves what the column still holds into rows, then drops the column with the trigger
-- and foreign key that named it. The earlier files no longer create or name it, so a replay never
-- brings it back. A fresh install never has it, and a second boot finds nothing to do: everything
-- below is guarded by the column's existence, so no boot after the first takes a lock on devices.

DO $$
DECLARE
  moved integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.devices'::regclass
                    AND attname = 'schema_id' AND NOT attisdropped) THEN
    RETURN;
  END IF;

  -- One row per schema the column names that no row of the device's already names, in the shape
  -- set_device_schemas() writes. The archived-schema guard is set aside for the move: the device
  -- already holds the binding, and keeping a binding is allowed. The audit trigger stays on, so
  -- the trail records each row.
  ALTER TABLE public.device_submodels DISABLE TRIGGER trg_device_submodels_reject_archived_schema;
  INSERT INTO public.device_submodels (device_id, schema_id)
  SELECT d.id, d.schema_id
    FROM public.devices d
   WHERE d.schema_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.device_submodels ds
                      WHERE ds.device_id = d.id AND ds.schema_id = d.schema_id);
  GET DIAGNOSTICS moved = ROW_COUNT;
  ALTER TABLE public.device_submodels ENABLE TRIGGER trg_device_submodels_reject_archived_schema;

  IF EXISTS (SELECT 1 FROM public.devices d
              WHERE d.schema_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.device_submodels ds
                                 WHERE ds.device_id = d.id AND ds.schema_id = d.schema_id)) THEN
    RAISE EXCEPTION '0175: a device''s devices.schema_id has no device_submodels row after the move';
  END IF;

  -- device_schemas stopped reading the column in 0001 and 0168, so these are all that name it.
  DROP TRIGGER IF EXISTS trg_devices_reject_archived_schema ON public.devices;
  ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_schema_id_fkey;
  ALTER TABLE public.devices DROP COLUMN schema_id;

  RAISE NOTICE '0175: devices.schema_id dropped; % schema attachment(s) moved to device_submodels.', moved;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.devices'::regclass
                AND attname = 'schema_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0175: devices.schema_id is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.devices'::regclass
                AND tgname = 'trg_devices_reject_archived_schema') THEN
    RAISE EXCEPTION '0175: trg_devices_reject_archived_schema is still on devices';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
