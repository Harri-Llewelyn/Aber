-- =============================================================================================
-- Migration: 0008_the_223p_metrics_file_under_bms.sql
-- ASHRAE 223P has one metric group, BMS
-- =============================================================================================
--
-- The 223P vocabulary registered a `Building` group while the standards seed filed its five 223P
-- metrics under `BMS`, which nothing registered (#456). 0002 now registers `BMS` under the
-- standard. This is the half 0002 cannot do, for a database seeded before that:
--
--   * a `BMS` row an Administrator registered by hand, with no standard, gains ASHRAE 223P;
--   * `Building` is deleted when no metric is filed under it. Metric names are immutable, so a
--     site that created `Building/...` metrics keeps the group, and a NOTICE says so.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

UPDATE public.metric_groups
   SET standard = 'ASHRAE 223P'
 WHERE name = 'BMS'
   AND standard IS NULL;

DELETE FROM public.metric_groups g
 WHERE g.name = 'Building'
   AND g.standard = 'ASHRAE 223P'
   AND NOT EXISTS (SELECT 1 FROM public.metric_catalog c WHERE c.metric_group = 'Building');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.metric_groups WHERE name = 'Building' AND standard = 'ASHRAE 223P') THEN
    RAISE NOTICE '0008: metrics are filed under Building, so the group stays beside BMS. Metric names are immutable: deprecate those metrics in favour of BMS/... to retire it.';
  END IF;
END $$;
