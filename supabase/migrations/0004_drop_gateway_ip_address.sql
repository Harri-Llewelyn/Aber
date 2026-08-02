-- =============================================================================================
-- Migration: 0004_drop_gateway_ip_address.sql
-- Remove public.gateways.ip_address -- a field nothing in the monitoring flow reads
-- =============================================================================================
--
-- WHY. `ip_address` was captured on the gateway form and on quarantine approval, and displayed as
-- a column, but nothing ever acted on it: it is not part of the gateway search haystack, no view
-- or function derives anything from it, the ingestion daemon resolves edge nodes by
-- `sparkplug_id` and never by address, and the AAS exporter does not read it. It was a field
-- operators were asked to keep accurate for no consumer.
--
-- THIS DESTROYS DATA and is not reversible without a restore. That is the accepted decision --
-- recorded here rather than in a commit message, because a later reader finding an empty
-- `ip_address` in a backup deserves to know it was deliberate.
--
-- IDEMPOTENT, and it has to be: supabase-db-init replays every /migrations/*.sql on every boot
-- with no applied-migrations ledger. `DROP COLUMN IF EXISTS` makes the second run a no-op, and
-- the view is rebuilt unconditionally because rebuilding an identical view is free.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE VIEW MUST BE DROPPED FIRST
-- ---------------------------------------------------------------------------------------------
-- `public.gateway_status` selects from `public.gateways`, so PostgreSQL refuses to drop a column
-- the view references:
--
--     ERROR:  cannot drop column ip_address of table gateways because other objects depend on it
--     DETAIL: view gateway_status depends on column ip_address of table gateways
--
-- `DROP COLUMN ... CASCADE` would "work" by dropping the view along with it -- and then the
-- gateways page would 404 on `gateway_status` until someone noticed. Dropping the view
-- explicitly and rebuilding it from its own definition function is the honest form of the same
-- operation, and it is exactly what `ensure_gateway_status_view()` exists for: 0001's header
-- calls it out as the thing to run after CHANGING the columns of `public.gateways`, because the
-- function's body selects `g.*` and picks the new shape up on its own.
--
-- Verified on the live database: `gateway_status` is the ONLY dependent object.
--
--     SELECT DISTINCT dependent.relname
--     FROM pg_depend d
--     JOIN pg_rewrite r      ON r.oid = d.objid
--     JOIN pg_class dependent ON dependent.oid = r.ev_class
--     JOIN pg_class src       ON src.oid = d.refobjid
--     JOIN pg_attribute a     ON a.attrelid = src.oid AND a.attnum = d.refobjsubid
--     WHERE src.relname = 'gateways' AND a.attname = 'ip_address';
--     -- gateway_status
--
-- ---------------------------------------------------------------------------------------------
-- FRESH INSTALLS CONVERGE ON THE SAME STATE
-- ---------------------------------------------------------------------------------------------
-- 0001 no longer creates the column, in TWO places -- the `CREATE TABLE` and the expanded column
-- list of its inline `gateway_status` definition, which pg_dump wrote out as explicit columns
-- rather than `g.*`. Removing only the first would leave 0001 failing on a fresh database with
-- `column g.ip_address does not exist`, while every existing database kept working because
-- `CREATE TABLE IF NOT EXISTS` is a no-op there. So:
--
--   * fresh   -- 0001 builds the table without the column; the DROP below is a no-op.
--   * existing -- 0001's CREATE is a no-op; the DROP below removes the column.
--
-- Both end with an identical schema, which is the property that matters when the same file set
-- has to serve installs and upgrades.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. Drop the dependent view, drop the column, rebuild the view
-- ---------------------------------------------------------------------------------------------
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
