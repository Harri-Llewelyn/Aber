-- =============================================================================================
-- Migration: 0004_drop_gateway_ip_address.sql
-- Remove public.gateways.ip_address, which nothing reads
-- =============================================================================================
--
-- This destroys data and is not reversible without a restore. Idempotent: db-init replays every
-- migration on every boot. See supabase/README.md -> "Dropping a gateways column (0004)".
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Drop the dependent view, drop the column, rebuild the view
-- ---------------------------------------------------------------------------------------------
-- gateway_status selects from gateways. CASCADE would drop the view instead of rebuilding it.
DROP VIEW IF EXISTS public.gateway_status;

ALTER TABLE public.gateways DROP COLUMN IF EXISTS ip_address;

-- Rebuilds from `g.*`, so it comes back with the current column set. Also re-applies its own
-- grants -- DROP VIEW discards them, which is why they live inside the function rather than
-- beside it.
SELECT public.ensure_gateway_status_view();

-- ---------------------------------------------------------------------------------------------
-- 2. Self-check
-- ---------------------------------------------------------------------------------------------
-- The second assertion is the one that matters: a CASCADE drop would satisfy the first.
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
