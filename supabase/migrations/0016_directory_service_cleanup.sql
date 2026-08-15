-- =============================================================================================
-- 0016_directory_service_cleanup.sql
--
-- Two corrections to the seeded service directory, for databases created before the rows in
-- 0002 changed. A fresh database is built correct by 0002 alone and matches nothing here.
--
--   1. REMOVES the dashboard's own entry. The directory exists to tell an operator where the
--      other services are; an entry linking to the page they are already looking at is the one
--      row that can never be useful, and it sat first in the list because the list was
--      alphabetical.
--
--   2. RENAMES 'Node-RED Edge Gateway' to 'Node-RED (Virtual Edge Gateway Simulator)'. The old
--      name claimed a piece of edge hardware. What is actually at :1880 is the bundled Node-RED
--      publishing simulated Sparkplug B for the demo stack, and an engineer who reads the
--      directory as an inventory of what is deployed should not have to find that out by
--      opening it. Cosmetic in a way 0015 was NOT: this name is display text, on nothing's wire
--      format and in no lookup.
--
-- WHY A MIGRATION AND NOT JUST THE SEED. 0002 uses ON CONFLICT ... DO NOTHING throughout, so it
-- inserts rows that are missing and never touches rows that exist. Editing it alone would leave
-- every database seeded before today on the old name, with the retired row still listed.
--
-- Idempotent: db-init replays it on every boot and the second run matches no rows.
-- =============================================================================================

SET search_path TO public;

DO $$
DECLARE
  v_removed INTEGER;
  v_renamed INTEGER;
BEGIN
  -- Matched on id AND on both historical names. The id is the seeded row; the names catch a
  -- database where the entry was re-created by hand under a fresh id. 'Factory+ Web Dashboard'
  -- is the pre-rename spelling -- a database that has not replayed the seed since still holds
  -- it, and this migration is the only thing that removes it.
  DELETE FROM public.directory_services
   WHERE id = 'f1111111-0000-0000-0000-000000000002'
      OR service_name IN ('ACS-Cymru Web Dashboard', 'Factory+ Web Dashboard');
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  -- Guarded on the new name being free. Without the NOT EXISTS an operator who had already
  -- registered a service under the new name would get a unique violation on service_name here,
  -- and db-init would fail the whole boot over a display string.
  IF NOT EXISTS (
    SELECT 1 FROM public.directory_services
     WHERE service_name = 'Node-RED (Virtual Edge Gateway Simulator)'
  ) THEN
    UPDATE public.directory_services
       SET service_name = 'Node-RED (Virtual Edge Gateway Simulator)'
     WHERE service_name = 'Node-RED Edge Gateway';
    GET DIAGNOSTICS v_renamed = ROW_COUNT;
  ELSE
    v_renamed := 0;
  END IF;

  RAISE NOTICE '0016: removed % dashboard directory entr(y/ies), renamed % Node-RED entr(y/ies).',
               v_removed, v_renamed;
END;
$$;

-- Self-check. The DO block above reports what it changed; this asserts the end state, which is
-- what the next boot has to be able to assume.
DO $$
DECLARE
  v_dashboard INTEGER;
  v_old_name  INTEGER;
BEGIN
  SELECT count(*) INTO v_dashboard
    FROM public.directory_services
   WHERE service_name IN ('ACS-Cymru Web Dashboard', 'Factory+ Web Dashboard');
  IF v_dashboard > 0 THEN
    RAISE EXCEPTION '0016 self-check: % dashboard entr(y/ies) still in the directory', v_dashboard;
  END IF;

  SELECT count(*) INTO v_old_name
    FROM public.directory_services
   WHERE service_name = 'Node-RED Edge Gateway';
  IF v_old_name > 0 THEN
    RAISE EXCEPTION '0016 self-check: Node-RED is still registered under its old name';
  END IF;

  RAISE NOTICE '0016 self-check passed: dashboard entry gone, Node-RED renamed.';
END;
$$;

NOTIFY pgrst, 'reload schema';
