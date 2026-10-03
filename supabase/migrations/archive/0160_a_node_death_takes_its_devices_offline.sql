-- =============================================================================================
-- Migration: 0030_a_node_death_takes_its_devices_offline.sql
-- A node's NDEATH marks every device behind it OFFLINE, as a DDEATH would
-- =============================================================================================
--
-- Sparkplug B says a node's death is the death of every device behind it. Ingestion wrote only
-- the gateway's status on NDEATH, so its devices read ONLINE in devices.status until the liveness
-- watchdog timed each one out, five minutes later by default.
--
-- ingest_mark_gateway_devices_offline() is the set-based twin of ingest_mark_device_offline(): one
-- UPDATE over the gateway's devices, behind the same no-op filter, so each device it moves gets
-- one Audit Trail row and a device already OFFLINE gets none. Archived devices are left alone, as
-- the DDEATH path leaves them. It returns the ids it moved, which the daemon holds for a birth.
-- The devices.status COMMENT is restated to name NDEATH among what sets OFFLINE.
--
-- Reasoning: ingestion/README.md, "Device Liveness Watchdog". Idempotent.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.ingest_mark_gateway_devices_offline(p_gateway_id uuid) RETURNS uuid[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_moved uuid[];
BEGIN
    PERFORM public.require_ingestion_caller('ingest_mark_gateway_devices_offline');

    IF p_gateway_id IS NULL THEN
        RAISE EXCEPTION 'ingest_mark_gateway_devices_offline: p_gateway_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    WITH moved AS (
        UPDATE public.devices d
           SET status = 'OFFLINE'
         WHERE d.gateway_id = p_gateway_id
           AND d.is_archived IS NOT TRUE
           AND d.status IS DISTINCT FROM 'OFFLINE'
        RETURNING d.id
    )
    SELECT coalesce(array_agg(id), '{}') INTO v_moved FROM moved;

    RETURN v_moved;
END;
$$;

ALTER FUNCTION public.ingest_mark_gateway_devices_offline(uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.ingest_mark_gateway_devices_offline(uuid) IS
  'NDEATH: set every non-archived device of this gateway OFFLINE in one UPDATE and return the ids it '
  'moved. The filter skips a device already OFFLINE, so each device moved gets one Audit Trail row and '
  'no other gets any. Ingestion principal only.';

-- 0001's names DDEATH and the watchdog as the only writers of OFFLINE.
COMMENT ON COLUMN public.devices.status IS
  'What the platform has OBSERVED of this device, never what an operator intends: ONLINE or OFFLINE. '
  'Written only by ingestion -- DBIRTH sets ONLINE, as does DDATA from a device the liveness watchdog '
  'timed out; DDEATH, its node''s NDEATH and the watchdog set OFFLINE -- and left at its OFFLINE '
  'default for a device registered but not yet connected. devices_online_implies_born refuses ONLINE '
  'without a first_dbirth_at. A device provisioned and never heard from is OFFLINE with a null '
  'first_dbirth_at, which the dashboard draws as awaiting its first birth rather than as a machine '
  'that went away.';

-- authenticated because the ingestion principal is one; require_ingestion_caller() is the gate.
REVOKE ALL ON FUNCTION public.ingest_mark_gateway_devices_offline(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ingest_mark_gateway_devices_offline(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_fn text := 'public.ingest_mark_gateway_devices_offline(uuid)';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                    WHERE p.oid = v_fn::regprocedure AND l.lanname = 'plpgsql' AND p.prosecdef
                      AND p.prosrc LIKE '%require_ingestion_caller%') THEN
        RAISE EXCEPTION '0030: % is not a plpgsql SECURITY DEFINER gate on the ingestion caller', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '0030: % is executable by anon', v_fn;
    END IF;
END
$check$;
