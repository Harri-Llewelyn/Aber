-- =============================================================================================
-- Migration: 0159_a_deleted_device_takes_its_birth_parameters_with_it.sql (applied as 0029 until the 1.0 squash)
-- A deleted device's asset_config rows are removed with it
-- =============================================================================================
--
-- asset_config holds the parameters each device declared at birth, keyed by asset_id: the
-- device's sparkplug_id as text, with no foreign key to devices. Nothing deleted from it, so a
-- Permanent Delete, purge_expired_archives() and the load test's `down` each left the device's
-- birth parameters behind for good.
--
-- A trigger on devices DELETE now removes the device's rows, and this file removes the rows
-- already orphaned. The quarantine merge in approve_quarantined_device() re-keys the duplicate's
-- rows onto the surviving device before it deletes the duplicate, so the trigger finds none.
--
-- Reasoning: supabase/README.md, "A deleted device takes its birth parameters with it (0029)".
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.delete_device_asset_config() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- SECURITY DEFINER, so the rows go whoever deletes the device: asset_config has a DELETE policy
  -- of its own, and a DELETE the policy filters leaves the rows behind without an error.
  DELETE FROM public.asset_config WHERE asset_id = OLD.sparkplug_id;
  RETURN OLD;
END $$;

ALTER FUNCTION public.delete_device_asset_config() OWNER TO postgres;

COMMENT ON FUNCTION public.delete_device_asset_config() IS
  'Trigger function: removes a deleted device''s birth parameters from asset_config, whose asset_id '
  'is the device''s sparkplug_id with no foreign key to cascade through.';

REVOKE ALL ON FUNCTION public.delete_device_asset_config() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_devices_delete_asset_config ON public.devices;
CREATE TRIGGER trg_devices_delete_asset_config AFTER DELETE ON public.devices
    FOR EACH ROW EXECUTE FUNCTION public.delete_device_asset_config();

-- The rows of devices deleted before the trigger existed.
DELETE FROM public.asset_config a
 WHERE NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.sparkplug_id = a.asset_id);

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- ---------------------------------------------------------------------------------------------
DO $check$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = 'public.devices'::regclass
                      AND tgname = 'trg_devices_delete_asset_config'
                      AND tgfoid = 'public.delete_device_asset_config()'::regprocedure
                      AND NOT tgisinternal) THEN
        RAISE EXCEPTION '0029: devices has no trigger removing a deleted device''s asset_config rows';
    END IF;
    IF EXISTS (SELECT 1 FROM public.asset_config a
                WHERE NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.sparkplug_id = a.asset_id)) THEN
        RAISE EXCEPTION '0029: asset_config still holds rows for a sparkplug_id no device carries';
    END IF;
END
$check$;
