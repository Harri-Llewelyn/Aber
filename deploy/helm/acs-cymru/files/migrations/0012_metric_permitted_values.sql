-- =============================================================================================
-- Migration: 0012_metric_permitted_values.sql
-- Record the value domain of a discrete metric, so an out-of-vocabulary reading is detectable
-- =============================================================================================
--
-- WHY. `Controller/EXECUTION` has five legal values and `Controller/EMERGENCY_STOP` has two, and
-- until now that was recorded only in the prose of each row's `description`. Prose cannot be
-- checked, and the gap is not hypothetical: the Node-RED demo flow once set the execution state to
-- `RUNNING`, which is not in the MTConnect EXECUTION vocabulary at all, and every subsequent
-- reading was silently wrong -- a valid string, a real metric, an accepted DDATA, and a value no
-- standard defines. Nothing in the stack could have said so.
--
-- WHAT THIS IS NOT. It is not ingestion validation. A device that publishes a value outside its
-- vocabulary is still reporting what it genuinely believes, and refusing it at the door would lose
-- the evidence that something is misconfigured. The finding is DERIVED AT READ TIME, alongside
-- Unmodelled in utils/deviceTags.js -- same discipline as gateway staleness and device location:
-- computed where it is read, never stored.
--
-- ------------------------------------------------------------------------------------------
-- THE MUTABILITY DECISION, WHICH REVERSES THE ONE THIS WAS PLANNED WITH.
-- ------------------------------------------------------------------------------------------
-- The obvious call is to freeze `permitted_values` in enforce_metric_catalog_immutability()
-- alongside `name` and `datatype`, on the argument that a device is configured against its value
-- set the same way it is configured against its name. That argument does not survive contact with
-- what this column actually is.
--
-- `name` and `datatype` are a WIRE CONTRACT. A device is physically configured against them, they
-- appear in the Sparkplug payload, and changing one silently re-points historical telemetry. That
-- is why they are frozen and why a correction costs a deprecation.
--
-- `permitted_values` is an ASSERTION ABOUT A STANDARD -- transcribed by a human, from a document,
-- and therefore wrong sometimes. Nothing is configured against it: no device reads it, ingestion
-- does not consult it, and no historical row is re-pointed by editing it. Freezing it would mean a
-- mistyped value could only be corrected by DEPRECATING THE METRIC AND RE-PROVISIONING EVERY
-- DEVICE THAT PUBLISHES IT, to fix a string that never left this database.
--
-- That is the exact trade migration 0029 already made for `semantic_id`, and for the same reason:
-- "semantic_id is an assertion that gets corrected BY HAND, so re-stamping it would make a
-- hand-entered crosswalk permanently unfixable". This column is in that family, not the other one.
-- Standards also ADD values between editions -- MTConnect has grown EXECUTION values, PackML
-- changed its state model between the 2015 and 2022 editions -- so a frozen set would go stale by
-- the standard's action rather than anyone's mistake.
--
-- So it stays updatable, and the probe at the end of this file is the regression guard, mirroring
-- the one 0029 wrote to protect the same property for the same reason.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------------------------
-- `text[]` rather than JSONB: every value in a Sparkplug discrete metric is a string, the set is
-- small and unordered, and an array gives `= ANY(...)` and `@>` without a JSON path expression.

ALTER TABLE public.metric_catalog
  ADD COLUMN IF NOT EXISTS permitted_values text[];

COMMENT ON COLUMN public.metric_catalog.permitted_values IS
  'The values a discrete metric is allowed to report, from its standard vocabulary. NULL means unconstrained -- most metrics are, and a continuous SAMPLE always is. Deliberately NOT frozen by enforce_metric_catalog_immutability: it is a transcribed assertion about a standard, not a wire contract a device is configured against. See this migration''s header.';

-- NULL means "no value domain". An EMPTY ARRAY would be a second spelling of the same thing, and
-- two spellings of one state is how a check ends up written against only one of them. A NULL or
-- empty-string member is likewise refused: neither is a value a device could publish.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'metric_catalog_permitted_values_shape'
       AND conrelid = 'public.metric_catalog'::regclass
  ) THEN
    ALTER TABLE public.metric_catalog
      ADD CONSTRAINT metric_catalog_permitted_values_shape CHECK (
        permitted_values IS NULL
        OR (
          cardinality(permitted_values) > 0
          AND array_position(permitted_values, NULL) IS NULL
          AND '' <> ALL (permitted_values)
        )
      );
  END IF;
END
$migration$;


-- ---------------------------------------------------------------------------------------------
-- Backfill: the two value sets this deployment already documents in prose
-- ---------------------------------------------------------------------------------------------
-- Idempotent by construction -- db-init replays every migration on every boot, and these are
-- unconditional assignments to two named rows.
--
-- Scoped by `standard` as well as by name so a locally-minted metric that happens to share the
-- name is not given MTConnect's vocabulary on its behalf.

UPDATE public.metric_catalog
   SET permitted_values = ARRAY['READY', 'ACTIVE', 'INTERRUPTED', 'FEED_HOLD', 'STOPPED']
 WHERE name = 'Controller/EXECUTION'
   AND standard = 'MTConnect';

UPDATE public.metric_catalog
   SET permitted_values = ARRAY['ARMED', 'TRIGGERED']
 WHERE name = 'Controller/EMERGENCY_STOP'
   AND standard = 'MTConnect';


-- ---------------------------------------------------------------------------------------------
-- Regression guard for the mutability decision documented above
-- ---------------------------------------------------------------------------------------------
-- If a later edit adds permitted_values to enforce_metric_catalog_immutability(), this fails the
-- migration rather than shipping a column that can only be corrected by deprecating the metric.
-- Modelled on 20260101000029's probe, including the leading DELETE: this migration replays on
-- every boot, so an interrupted run must not leave a row that makes the next run fail.

DO $migration$
DECLARE
  probe_id UUID;
BEGIN
  DELETE FROM public.metric_catalog WHERE name = '__permitted_values_mutability_probe__';

  INSERT INTO public.metric_catalog (name, datatype, description, permitted_values)
  VALUES ('__permitted_values_mutability_probe__', 12, 'transient; removed by this migration',
          ARRAY['ONE'])
  RETURNING id INTO probe_id;

  BEGIN
    UPDATE public.metric_catalog
       SET permitted_values = ARRAY['ONE', 'TWO']
     WHERE id = probe_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'permitted_values must remain updatable on metric_catalog, but an UPDATE was rejected (%). '
      'It is a transcribed assertion about a standard, not a wire contract -- see the MUTABILITY '
      'note in 0012_metric_permitted_values.sql.', SQLERRM;
  END;

  DELETE FROM public.metric_catalog WHERE id = probe_id;
END
$migration$;


NOTIFY pgrst, 'reload schema';
