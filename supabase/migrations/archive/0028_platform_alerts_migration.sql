-- =============================================================================================
-- Migration: 0028_platform_alerts_migration.sql
-- Move an existing database's `device_alerts` onto `platform_alerts`
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- 0023 describes a fresh database; this moves an existing one. The order is what makes both
-- idempotent: 0023 creates `platform_alerts` (IF NOT EXISTS), and this file does nothing unless
-- `device_alerts` still exists. A rename inside 0023 would fight its own CREATE TABLE IF NOT
-- EXISTS every boot.
--
-- Copy-then-drop rather than RENAME, so the surviving table's indexes, constraints and
-- publication membership are the ones 0023 defines under the new names. Safe in one statement at
-- this volume (alert occurrences, thousands at most).
-- =============================================================================================

SET check_function_bodies = false;

DO $migrate$
DECLARE
  v_moved   INTEGER := 0;
  v_skipped INTEGER := 0;
BEGIN
  IF to_regclass('public.device_alerts') IS NULL THEN
    RAISE NOTICE '0028: no device_alerts table; nothing to migrate.';
    RETURN;
  END IF;

  IF to_regclass('public.platform_alerts') IS NULL THEN
    RAISE EXCEPTION
      '0028: device_alerts exists but platform_alerts does not. 0023 creates it and runs first, '
      'so this means the chain was applied out of order or 0023 failed.';
  END IF;

  -- ON CONFLICT DO NOTHING against the occurrence key, so a partially-completed previous run --
  -- an interrupted boot, a deadlock like #40 -- resumes rather than failing on the rows it already
  -- moved. `uq_platform_alerts_event` is (fingerprint, starts_at), which is the same identity the
  -- webhook upserts on, so "already moved" and "the same occurrence" are the same question.
  INSERT INTO public.platform_alerts (
      id, fingerprint, entity_type, entity_id, sparkplug_id,
      alert_name, severity, status, summary, starts_at, ends_at, recorded_at
  )
  SELECT d.id,
         d.fingerprint,
         -- EVERY EXISTING ROW IS A DEVICE ALERT, and that is a fact about history rather than a
         -- default: until this change the webhook refused to write anything else, so there is no
         -- row here whose subject could have been a gateway.
         'device',
         d.device_id,
         d.sparkplug_id,
         d.alert_name, d.severity, d.status, d.summary, d.starts_at, d.ends_at, d.recorded_at
    FROM public.device_alerts d
   WHERE d.sparkplug_id IS NOT NULL
  ON CONFLICT ON CONSTRAINT uq_platform_alerts_event DO NOTHING;

  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- The new table's CHECK requires an asset alert to carry a wire identity. The old one required
  -- it of EVERY row, so this can only be non-zero on a database where something bypassed that
  -- NOT NULL -- which is worth saying out loud rather than discarding in silence.
  SELECT count(*) INTO v_skipped FROM public.device_alerts WHERE sparkplug_id IS NULL;
  IF v_skipped > 0 THEN
    RAISE WARNING
      '0028: % device_alerts row(s) carried no sparkplug_id and were not migrated. The old schema '
      'declared that column NOT NULL, so these predate it or were written around it.', v_skipped;
  END IF;

  -- Out of the publication before the drop. `ALTER PUBLICATION ... DROP TABLE` on a table that is
  -- about to disappear is not strictly required -- the drop removes the membership -- but doing it
  -- explicitly keeps `pg_publication_tables` correct at every point rather than only afterwards,
  -- and 0001's reconciliation reads that view.
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'device_alerts'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.device_alerts;
  END IF;

  -- CASCADE takes `device_alerts_active` with it. That view is replaced by
  -- `platform_alerts_active`, which 0023 has already created, and nothing is left pointing at the
  -- old name -- the edge function, the hook and the OpenAPI contract all move in the same change.
  DROP TABLE public.device_alerts CASCADE;

  RAISE NOTICE '0028: migrated % alert occurrence(s) to platform_alerts and dropped device_alerts.',
    v_moved;
END;
$migrate$;

-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  v_bad INTEGER;
BEGIN
  IF to_regclass('public.device_alerts') IS NOT NULL THEN
    RAISE EXCEPTION '0028 self-check: device_alerts still exists after the migration';
  END IF;

  IF to_regclass('public.platform_alerts') IS NULL THEN
    RAISE EXCEPTION '0028 self-check: platform_alerts is missing';
  END IF;

  -- The invariant the CHECK constraint encodes, asserted against the DATA as well -- a constraint
  -- added to a table that already held violating rows would have been created NOT VALID by any
  -- route that avoided a full scan, and this is the cheap way to know it was not.
  SELECT count(*) INTO v_bad
    FROM public.platform_alerts
   WHERE entity_type <> 'platform' AND sparkplug_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '0028 self-check: % asset alert(s) carry no sparkplug_id', v_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'platform_alerts'
  ) THEN
    RAISE EXCEPTION
      '0028 self-check: platform_alerts is not in the supabase_realtime publication, so the '
      'dashboard would never see an alert arrive';
  END IF;

  RAISE NOTICE '0028 self-check passed: one alert table, published, every asset alert attributed.';
END;
$selfcheck$;
