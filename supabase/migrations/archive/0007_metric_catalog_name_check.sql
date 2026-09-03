-- =============================================================================================
-- Migration: 0007_metric_catalog_name_check.sql
-- Constrain public.metric_catalog.name to the Factory+ metric-name format
-- =============================================================================================
--
-- WHY. Factory+ requires a metric name to be '/'-delimited folders whose segments use only
-- alphanumerics and the underscore. `name` is IMMUTABLE here, so a non-conforming name is
-- PERMANENT: the row can only be deprecated and superseded, never corrected. The constraint is
-- therefore cheap now and impossible later.
--
-- NOT VALID, AND THAT IS THE WHOLE DESIGN. db-init runs `psql -v ON_ERROR_STOP=1` over every
-- migration on every boot with no applied-migrations ledger, so a plain ADD CONSTRAINT that failed
-- on one legacy row would not fail once -- it would fail on EVERY BOOT, FOREVER, and the stack
-- would never come up again. NOT VALID still enforces on INSERT and UPDATE, so new rows are
-- constrained immediately; only the back-scan of existing rows is deferred.
--
-- Rationale, the seeded catalog's conformance, and how to clear a warning:
--   supabase/README.md -> "Metric name format (0007)"
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. Add the constraint, guarded and NOT VALID
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'metric_catalog_name_format'
       AND conrelid = 'public.metric_catalog'::regclass
  ) THEN
    ALTER TABLE public.metric_catalog
      ADD CONSTRAINT metric_catalog_name_format
      CHECK (name ~ '^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$')
      NOT VALID;
    RAISE NOTICE '0007: added metric_catalog_name_format (NOT VALID).';
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------------------------
-- 2. Try to validate; report offenders instead of aborting
-- ---------------------------------------------------------------------------------------------
-- A caught failure leaves the constraint NOT VALID, so this re-runs and re-warns on every boot
-- until the rows are dealt with. That is the intent: a warning that stops appearing because the
-- migration gave up would be worse than no warning.
DO $$
DECLARE
  offender_count integer;
  offenders      text;
BEGIN
  -- Skip the table scan once validated. VALIDATE on an already-valid constraint is a no-op, but
  -- this keeps every subsequent boot from taking even a brief lock on the catalog.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'metric_catalog_name_format'
       AND conrelid = 'public.metric_catalog'::regclass
       AND convalidated
  ) THEN
    RETURN;
  END IF;

  BEGIN
    ALTER TABLE public.metric_catalog VALIDATE CONSTRAINT metric_catalog_name_format;
    RAISE NOTICE '0007: every existing metric name conforms; constraint is now VALIDATED.';
  EXCEPTION WHEN check_violation THEN
    SELECT count(*), string_agg(format('%L', name), ', ' ORDER BY name)
      INTO offender_count, offenders
      FROM public.metric_catalog
     WHERE name !~ '^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$';

    RAISE WARNING E'0007: metric_catalog holds % name(s) outside the Factory+ format, so the '
      'constraint stays NOT VALID and will be re-checked on the next boot.\n'
      '  Offending name(s): %\n'
      '  New rows ARE already constrained -- only these existing ones are exempt.\n'
      '  `name` is immutable, so each must be deprecated and superseded by a conforming metric '
      '(see supabase/README.md), then:\n'
      '    ALTER TABLE public.metric_catalog VALIDATE CONSTRAINT metric_catalog_name_format;',
      offender_count, offenders;
  END;
END;
$$;


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- Proves the constraint exists and REJECTS, rather than asserting it. A CHECK that was added but
-- silently not enforced is the failure this guards against, and it is invisible otherwise.
DO $$
DECLARE
  rejected boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'metric_catalog_name_format'
       AND conrelid = 'public.metric_catalog'::regclass
  ) THEN
    RAISE EXCEPTION '0007 self-check: metric_catalog_name_format was not created';
  END IF;

  BEGIN
    INSERT INTO public.metric_catalog (name, datatype)
    VALUES ('0007 self check/bad name', 12);
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;

  IF NOT rejected THEN
    -- Clean up before failing: the row is only reachable here if the constraint did not fire.
    DELETE FROM public.metric_catalog WHERE name = '0007 self check/bad name';
    RAISE EXCEPTION '0007 self-check: a name containing spaces was ACCEPTED; the constraint is '
                    'present but not enforcing on INSERT';
  END IF;

  RAISE NOTICE '0007 self-check passed: non-conforming metric names are rejected on INSERT.';
END;
$$;
