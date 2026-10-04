-- =============================================================================================
-- Migration: 0142_mtconnect_metrics_carry_their_data_item_type_id.sql (applied as 0009 until the 1.0 squash)
-- An MTConnect metric's semantic id names its data item type, not the metric (#457)
-- =============================================================================================
--
-- The original seed and the Add Metric form minted an MTConnect id from the whole metric name
-- (`…/mtconnect/v2.0/Axes/C/ANGLE`), while the standards seed took the vocabulary's concept id
-- (`…/mtconnect/v2.0/DataItemType/POSITION`). The first identifies a data item, so no two metrics
-- could share it. 0002 and the form now use the concept id; this repoints a database seeded
-- earlier.
--
-- A row is repointed only when its id is still exactly the name-built form and its data item type
-- is in `mtconnect_vocabulary`. The type is the last segment of the name once a trailing
-- `sub_type` segment is removed: the subType qualifies the concept and stays in the name. An id an
-- operator typed is left alone, and so is a row whose type the vocabulary lacks; a NOTICE counts
-- those. `semantic_id` is correctable in place (test_metric_catalog_seed.py asserts it), so this
-- is an UPDATE rather than a deprecation.
--
-- Idempotent: the second run matches nothing.
-- =============================================================================================

SET search_path TO public;

WITH typed AS (
  SELECT c.id,
         regexp_replace(
           CASE WHEN NULLIF(c.sub_type, '') IS NOT NULL
                 AND right(c.name, length(c.sub_type) + 1) = '/' || c.sub_type
                THEN left(c.name, length(c.name) - length(c.sub_type) - 1)
                ELSE c.name
           END,
           '^.*/', '') AS data_item_type
    FROM public.metric_catalog c
   WHERE c.standard = 'MTConnect'
     AND c.semantic_id = 'https://aber.local/semantics/mtconnect/v2.0/' || c.name
)
UPDATE public.metric_catalog c
   SET semantic_id = v.semantic_id,
       semantic_id_type = 'IRI'
  FROM typed t
  JOIN public.mtconnect_vocabulary v
    ON v.kind = 'DATA_ITEM_TYPE'
   AND v.name = t.data_item_type
 WHERE c.id = t.id
   AND v.semantic_id IS NOT NULL;

DO $$
DECLARE
  kept integer;
BEGIN
  SELECT count(*) INTO kept
    FROM public.metric_catalog c
   WHERE c.standard = 'MTConnect'
     AND c.semantic_id = 'https://aber.local/semantics/mtconnect/v2.0/' || c.name;
  IF kept > 0 THEN
    RAISE NOTICE '0009: % MTConnect metric(s) keep an id built from their name: mtconnect_vocabulary has no data item type to point them at.', kept;
  END IF;
END $$;
