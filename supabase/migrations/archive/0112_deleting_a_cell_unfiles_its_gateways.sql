-- 0112: deleting a cell un-files its gateways instead of deleting them with it.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT WAS WRONG
--
-- `gateways_cell_id_fkey` shipped as ON DELETE CASCADE, alone among the children of `cells`:
-- `devices.cell_id` is SET NULL, and `cells.area_id` is SET NULL for the reason 0097 states in
-- words -- "deleting a building un-files its cells into the Unassigned lane rather than deleting
-- them or refusing". A gateway was the one asset that went with its parent.
--
-- That is reachable from one place, and it is the place where it does the most harm. Cells,
-- gateways and devices are only ever ARCHIVED from their own pages; the DELETE is the Archived
-- Entities page's Permanent Delete, or `purge_expired_archives` reaching a row whose retention
-- timer has expired (0002). Both cascaded:
--
--   * an archived gateway marked Permanent (No Auto-Purge) was deleted anyway, by its CELL's
--     30-day timer, having been given the retention the operator asked for and then not kept;
--   * a gateway that was never archived at all was deleted along with the archived cell it
--     happened to be filed into, taking its captures, its playback jobs and its enrolment tokens
--     with it (those cascades are correct -- they just should not have been reached).
--
-- The job's own comment claimed the opposite: "a parent whose child is not yet due fails to
-- delete this run and is retried the next, rather than cascading a child out from under its own
-- timer". That is true of a FK that restricts, and this one cascaded. 0002 is corrected to
-- describe what the chain now does.
--
-- WHAT REPLACES IT. The gateway survives with `cell_id` NULL, which is the Unassigned lane the
-- Site Map already draws -- the same state an area-wide gateway's cell-scoped neighbour reaches,
-- and the same state a device reaches when its cell is deleted. Its lineage is not lost: the
-- UPDATE that clears `cell_id` fires log_digital_thread_event(), so `old_data` on that row names
-- the cell it was filed into, as the DELETE row names everything about the cell itself.
--
-- WHAT THIS DOES NOT DO. It does not restore a gateway an earlier cascade removed; there is
-- nothing in the live tables to restore from, and the digital thread holds the record. It also
-- leaves `purge_expired_archives` ordered children-first, which is still the right order: a
-- gateway that IS due is deleted as itself, with its own audit row, rather than being un-filed
-- first and deleted a second later.
--
-- FRESH AND EXISTING DATABASES CONVERGE, the property that matters when one file set serves
-- installs and upgrades (supabase/README.md, "Fresh and existing databases converge"):
--
--   * fresh    -- 0001 creates the constraint SET NULL; the block below sees no CASCADE and does
--                 nothing.
--   * existing -- 0001's guarded ADD is a no-op because the constraint is already there; the
--                 block below replaces it.
-- =================================================================================================

SET search_path TO public;

-- Guarded on the DELETE ACTION, not on the constraint's existence: the name is unchanged, so an
-- unguarded block would drop and re-add -- and revalidate -- the same foreign key on every boot.
-- `confdeltype` is 'c' for CASCADE and 'n' for SET NULL.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'gateways_cell_id_fkey'
           AND conrelid = 'public.gateways'::regclass
           AND confdeltype = 'c'
    ) THEN
        ALTER TABLE public.gateways DROP CONSTRAINT gateways_cell_id_fkey;

        ALTER TABLE public.gateways
            ADD CONSTRAINT gateways_cell_id_fkey
            FOREIGN KEY (cell_id) REFERENCES public.cells(id) ON DELETE SET NULL;

        RAISE NOTICE '0112: gateways_cell_id_fkey was ON DELETE CASCADE; it is now SET NULL.';
    END IF;
END $$;

COMMENT ON COLUMN public.gateways.cell_id IS
    'The cell this gateway is filed into, or NULL for the Unassigned lane -- which is also where '
    'it lands when that cell is deleted (0112: SET NULL, not CASCADE). NULL by assertion for a '
    'site-wide, area-wide, simulated or shadow gateway; see the CHECK constraints on this table.';
