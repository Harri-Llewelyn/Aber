-- Migration: 20260101000023_realtime_publication.sql
-- Description: Publish the asset metadata tables to the `supabase_realtime` publication so
--              the dashboard can subscribe to changes instead of polling every 3 seconds
--              (frontend/src/hooks/usePolling.js, wired into four tabs).
--
-- WHAT IS DELIBERATELY NOT PUBLISHED
--
--   public.telemetry -- a postgres_fdw foreign table (migration 0010). Its rows live in the
--   standalone TimescaleDB's WAL, never this database's, so logical decoding here would emit
--   nothing at all. Adding it would not error; it would silently do nothing, which is worse.
--   The Telemetry tab therefore keeps its paged queries and its explicit refresh control.
--
--   Anything ingestion writes at message rate. Realtime evaluates RLS per change PER
--   SUBSCRIBER, so a high-churn table costs (changes x connected clients) policy
--   evaluations inside the realtime server. The four tables below are metadata: device
--   CRUD, quarantine flips, gateway heartbeats. That is a rate the design tolerates.

-- The supabase/postgres image already ships an empty `supabase_realtime` publication, so
-- this guard is normally a no-op. It exists for a database built from these migrations alone.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete');
  END IF;
END $$;

-- SET TABLE (not ADD TABLE) so this is idempotent: supabase-db-init replays every migration
-- on every stack start, and ADD TABLE errors on an already-published table.
ALTER PUBLICATION supabase_realtime SET TABLE
  public.cells,
  public.gateways,
  public.devices,
  public.digital_thread;

-- REPLICA IDENTITY FULL puts the complete OLD row in the WAL record for UPDATE and DELETE.
-- Required for two separate reasons:
--   1. Realtime evaluates RLS against the old row as well as the new one. With the DEFAULT
--      identity it only has the primary key, so it cannot decide whether a subscriber was
--      allowed to see the pre-change row and errs toward withholding the event.
--   2. The client receives a usable `old_record` to diff against.
--
-- Cost: a larger WAL record per write. The relevant write rate here is gateways.last_heartbeat,
-- stamped by ingestion on every NBIRTH/NDATA/NDEATH -- roughly 2/min per gateway with the
-- Node-RED simulator's 30s beat. Fine at this scale; revisit past a few hundred gateways.
ALTER TABLE public.cells          REPLICA IDENTITY FULL;
ALTER TABLE public.gateways       REPLICA IDENTITY FULL;
ALTER TABLE public.devices        REPLICA IDENTITY FULL;
ALTER TABLE public.digital_thread REPLICA IDENTITY FULL;
