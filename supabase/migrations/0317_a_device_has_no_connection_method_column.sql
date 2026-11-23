-- 0317: A device has no connection_method column.
--
-- 1.9.0 deprecated `devices.connection_method`: every device reaches Aber over Sparkplug B, so the
-- column said nothing, and the dashboard stopped sending it. This drops it, as 0219 dropped a cell's
-- dashboard address. The drop is guarded by the column's existence, so only the first boot after the
-- upgrade does anything; a fresh install and every later boot take no lock on devices.
--
--   * The values go with the column, and db-init's log says how many devices held one that was not
--     blank. They are not cleared first: each device's audit rows already hold its value, since the
--     audit trigger records the whole row.
--   * A proposal filed before the upgrade that names the key is refused when someone approves it,
--     with HTTP 400 telling the approver to reject it and ask for a new one. proposable_columns() no
--     longer admits the key, and approve_proposal() re-checks every patch against it. It is never
--     applied with the key left out, and the boot never waits on it.
--
-- The earlier files no longer name the column: 0001 does not create it, 0001 and 0202 do not admit it
-- in proposable_columns(), and 0001 and 0165 declare approve_proposal() without it. So no replay
-- brings it back, and no boot has a moment when a live function names a column that is gone.
--
-- Reasoning: supabase/README.md, "A device has no connection_method column (0317)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The column goes, with its values
-- -------------------------------------------------------------------------------------------------
-- One statement, so one transaction: if the drop fails, the column and every value stay as they were.
DO $$
DECLARE
  v_held integer;
BEGIN
  -- PL/pgSQL plans each statement when it first runs it, so the count never meets a missing column.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.devices'::regclass
                    AND attname = 'connection_method' AND NOT attisdropped) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_held FROM public.devices WHERE btrim(connection_method) <> '';

  -- No view, index, constraint or trigger names the column, so nothing has to be rebuilt.
  ALTER TABLE public.devices DROP COLUMN connection_method;

  RAISE NOTICE '0317: devices.connection_method dropped, with the value % device(s) held. Nothing in Aber read it.',
    v_held;
END
$$;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.devices'::regclass
                AND attname = 'connection_method' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0317: devices.connection_method is still there';
  END IF;
  IF 'connection_method' = ANY (public.proposable_columns('devices')) THEN
    RAISE EXCEPTION '0317: proposable_columns(''devices'') admits connection_method, which devices no longer has';
  END IF;
  -- The live approve_proposal(), from 0165: one that set the column would fail every device
  -- approval, and one that stopped re-checking the patch would apply an old proposal without it.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.approve_proposal(uuid)'::regprocedure
                    AND prosecdef
                    AND 'search_path=public' = ANY (proconfig)
                    AND prosrc !~ '\mconnection_method\M'
                    AND position('PERFORM public.require_mfa();' IN prosrc) > 0
                    AND position('public.proposable_columns(v_proposal.entity_type)' IN prosrc) > 0) THEN
    RAISE EXCEPTION '0317: approve_proposal() names connection_method, no longer re-checks the patch or asks for a second factor, or is not SECURITY DEFINER with its search_path pinned';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
