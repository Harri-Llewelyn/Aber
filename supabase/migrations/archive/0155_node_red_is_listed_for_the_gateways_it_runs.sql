-- =============================================================================================
-- Migration: 0024_node_red_is_listed_for_the_gateways_it_runs.sql
-- The Directory names Node-RED for what it runs now
-- =============================================================================================
--
-- `0002` seeds the Node-RED row as 'Node-RED (Host-Run Gateways)'. A database seeded earlier
-- holds it as 'Node-RED (Virtual Edge Gateway Simulator)', from when the stack shipped a
-- demonstration simulator, and the seed inserts ON CONFLICT (id) DO NOTHING, so it cannot correct
-- the name.
--
-- Only that old name is replaced, so an operator who renamed the row keeps their name. Guarded on
-- the new name being free, because service_name is unique and db-init must not fail over a
-- display string.
--
-- Idempotent: a second boot finds no row under the old name.
-- =============================================================================================

DO $rename$
DECLARE
    v_renamed integer := 0;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.directory_services
                    WHERE service_name = 'Node-RED (Host-Run Gateways)') THEN
        UPDATE public.directory_services
           SET service_name = 'Node-RED (Host-Run Gateways)'
         WHERE id = 'f1111111-0000-0000-0000-000000000003'::uuid
           AND service_name = 'Node-RED (Virtual Edge Gateway Simulator)';
        GET DIAGNOSTICS v_renamed = ROW_COUNT;
    END IF;

    IF v_renamed > 0 THEN
        RAISE NOTICE '0024: renamed the Node-RED directory entry for the host-run gateways it runs.';
    END IF;

    -- What this block did: the seeded row no longer carries the simulator's name, unless the new
    -- name was already taken by another row, which is the one case it leaves alone.
    IF EXISTS (SELECT 1 FROM public.directory_services
                WHERE id = 'f1111111-0000-0000-0000-000000000003'::uuid
                  AND service_name = 'Node-RED (Virtual Edge Gateway Simulator)')
       AND NOT EXISTS (SELECT 1 FROM public.directory_services
                        WHERE service_name = 'Node-RED (Host-Run Gateways)') THEN
        RAISE EXCEPTION '0024 self-check: the Node-RED directory entry still carries the simulator''s name.';
    END IF;
END
$rename$;
