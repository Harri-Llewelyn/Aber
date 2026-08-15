-- =============================================================================================
-- Migration: 0004_drop_gateway_ip_address.sql
-- Remove public.gateways.ip_address -- a field nothing in the monitoring flow reads
-- =============================================================================================
--
-- THIS DESTROYS DATA and is not reversible without a restore. Recorded here rather than in a
-- commit message, because a later reader finding an empty `ip_address` in a backup deserves to
-- know it was deliberate.
--
-- Idempotent, as every migration must be -- db-init replays them all on every boot.
--
-- Why the field went, why the view is dropped and rebuilt rather than CASCADEd, and why fresh
-- and existing databases converge:  supabase/README.md -> "Dropping a gateways column (0004)"
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. Drop the dependent view, drop the column, rebuild the view
-- ---------------------------------------------------------------------------------------------
-- gateway_status selects from gateways, so the column cannot be dropped while it exists. CASCADE
-- would drop the view instead of rebuilding it, leaving the gateways page 404ing.
DROP VIEW IF EXISTS public.gateway_status;

ALTER TABLE public.gateways DROP COLUMN IF EXISTS ip_address;

-- Rebuilds from `g.*`, so it comes back with the current column set. Also re-applies its own
-- grants -- DROP VIEW discards them, which is why they live inside the function rather than
-- beside it.
SELECT public.ensure_gateway_status_view();


-- ---------------------------------------------------------------------------------------------
-- 2. Self-check
-- ---------------------------------------------------------------------------------------------
-- Proves the outcome rather than asserting it. The second assertion is the one that matters:
-- a CASCADE drop would satisfy the first and leave the page broken.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'gateways' AND column_name = 'ip_address'
  ) THEN
    RAISE EXCEPTION '0004 self-check: gateways.ip_address still exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.views
     WHERE table_schema = 'public' AND table_name = 'gateway_status'
  ) THEN
    RAISE EXCEPTION '0004 self-check: gateway_status was not rebuilt after the column drop';
  END IF;

  -- The derived columns are the reason the view exists; a rebuild that lost them would be
  -- worse than no rebuild, because the page would render with every gateway looking healthy.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'gateway_status' AND column_name = 'live_status'
  ) THEN
    RAISE EXCEPTION '0004 self-check: gateway_status lost its derived live_status column';
  END IF;

  RAISE NOTICE '0004 self-check passed: gateways.ip_address is gone and gateway_status is intact.';
END;
$$;
