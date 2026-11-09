-- 0278: The longest window one export of readings may cover is a setting.
--
-- history.export_max_days is the most days an export may span, from its start to its end: 14
-- unless an Administrator changes it, from 1 to 366. It is the one setting of the History category
-- of Settings, and every role reads it, as every setting that is not marked sensitive. 0279's
-- export_telemetry() holds every export to it, and the dashboard says it before it asks.
--
--   * It is declared here, through seed_setting(), which inserts on a first boot and afterwards
--     refreshes only the label and the description, so an Administrator's value survives every
--     replay. Its bounds are set by an UPDATE guarded on the value it sets, as 0002 sets the
--     others': seed_setting() takes none.
--   * telemetry_export_max_days() answers it as the writer reads it: the setting's value, or 14 where
--     the row is missing or outside 1 to 366, so a damaged setting never stops exports altogether
--     and never lifts the limit. A part day is taken as it is, as the other day settings take one.
--
-- Reasoning: supabase/README.md, "The longest export is a setting (0278)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The setting
-- -------------------------------------------------------------------------------------------------
SELECT public.seed_setting(
    'history.export_max_days',
    to_jsonb(14),
    'number',
    'History',
    'Longest export (days)',
    'The most days one export of readings may span, from its start to its end, 14 unless changed '
    'here. An Administrator or a Shopfloor Manager exports from History''s Device, Overview and '
    'Cell views, and a window longer than this is refused with this limit named. Each export is '
    'recorded in the Audit Trail. Lowering this changes nothing already exported. Older or longer '
    'ranges are in Cold Storage''s Parquet files.',
    'fourteen days, in telemetry_export_max_days()'
);

-- MIN 1, NOT 0: zero would refuse every export. MAX 366: a year. A longer window is a copy of the
-- history, which Cold Storage's Parquet files are for.
UPDATE public.system_settings
   SET min_value = 1, max_value = 366
 WHERE key = 'history.export_max_days'
   AND (min_value IS DISTINCT FROM 1 OR max_value IS DISTINCT FROM 366);

-- -------------------------------------------------------------------------------------------------
-- 2. The limit, as the export reads it
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.telemetry_export_max_days() RETURNS numeric
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_days numeric;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v_days
    FROM public.system_settings
   WHERE key = 'history.export_max_days';
  IF v_days IS NULL OR v_days < 1 OR v_days > 366 THEN
    v_days := 14;
  END IF;
  RETURN v_days;
END
$$;

ALTER FUNCTION public.telemetry_export_max_days() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.telemetry_export_max_days() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.telemetry_export_max_days() TO authenticated;

COMMENT ON FUNCTION public.telemetry_export_max_days() IS
  'The most days one export of readings may span: history.export_max_days, or 14 where the row is '
  'missing or outside 1 to 366. Read by export_telemetry(), and by anyone who may read the setting (0278).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_row public.system_settings;
BEGIN
  SELECT * INTO v_row FROM public.system_settings WHERE key = 'history.export_max_days';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0278: history.export_max_days is not declared';
  END IF;
  IF v_row.category <> 'History' OR v_row.value_type <> 'number'
     OR v_row.min_value IS DISTINCT FROM 1 OR v_row.max_value IS DISTINCT FROM 366 THEN
    RAISE EXCEPTION '0278: history.export_max_days is not a number from 1 to 366 in the History category';
  END IF;
  IF has_function_privilege('anon', 'public.telemetry_export_max_days()', 'EXECUTE') THEN
    RAISE EXCEPTION '0278: anon may execute telemetry_export_max_days()';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
