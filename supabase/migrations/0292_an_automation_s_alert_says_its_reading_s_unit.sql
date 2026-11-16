-- 0292: An automation's alert says its reading's unit.
--
-- automation_value_words() and automation_threshold_words() (0283) said a measured metric's value and
-- its threshold as they print, p_value::text, so an alert on a temperature read "82.4" against "80"
-- in the bell, History's Alerts tab, an email and a webhook, where History and the device drawer say
-- "82.4 °C" for the same reading. Only a time in state's share had a sign, and only a derived value
-- its window.
--
--   * unit_symbol(code) holds the pairs of UNIT_SYMBOLS in frontend/src/utils/units.js, and answers
--     NULL for a code with no symbol. Mirror check 104 fails when either side has a pair the other
--     lacks, or a different symbol. It is IMMUTABLE with its search_path pinned.
--   * with_unit(text, code) is withUnit(): a number's text with the symbol after it. A % or a °
--     stands against the number, "42%" and "90°", and any other symbol follows a space, "82.4 °C".
--     A code with no symbol is printed as it is, as the dashboard does, and no code leaves the text.
--   * automation_value_words() and automation_threshold_words() give a measured metric's value and
--     threshold its unit, read from metric_catalog.units. Every other arm is 0283's: a time in
--     state's share is a percentage, a derived metric's value is rounded and followed by its window,
--     and a metric the catalogue does not hold, or holds with no unit, is as it prints.
--
-- Only the words change. What an alert's labels and values hold, what is compared, a webhook's JSON
-- labels and the CSV export keep the code and the number. An alert already firing keeps the summary
-- it was written with; the next one is worded with the unit.
--
-- No function here is granted to an API role, as in 0283.
--
-- Reasoning: supabase/README.md, "An automation's alert says its reading's unit (0292)". Idempotent.
--
-- Redefines public.automation_value_words: 0292 follows a measured metric's value with its unit
--   ("82.4 °C"); 0283 printed the value alone, and a derived metric's and a time in state's words
--   are 0283's
-- Redefines public.automation_threshold_words: 0292 follows a measured metric's threshold with its
--   unit ("80 °C"); 0283 printed it alone, and a time in state's is 0283's

-- -------------------------------------------------------------------------------------------------
-- 1. The symbols
-- -------------------------------------------------------------------------------------------------
-- The pairs are UNIT_SYMBOLS', one WHEN each. A code is exact text, as the catalogue holds it.
CREATE OR REPLACE FUNCTION public.unit_symbol(p_code text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  SELECT CASE p_code
           WHEN 'AMPERE'                     THEN 'A'
           WHEN 'CELSIUS'                    THEN '°C'
           WHEN 'COULOMB'                    THEN 'C'
           WHEN 'COUNT'                      THEN 'count'
           WHEN 'COUNT/SECOND'               THEN 'count/s'
           WHEN 'CUBIC_METER'                THEN 'm³'
           WHEN 'CUBIC_MILLIMETER'           THEN 'mm³'
           WHEN 'CUBIC_MILLIMETER/SECOND'    THEN 'mm³/s'
           WHEN 'CUBIC_MILLIMETER/SECOND^2'  THEN 'mm³/s²'
           WHEN 'DECIBEL'                    THEN 'dB'
           WHEN 'DEGREE'                     THEN '°'
           WHEN 'DEGREE/SECOND'              THEN '°/s'
           WHEN 'DEGREE/SECOND^2'            THEN '°/s²'
           WHEN 'DEGREE_3D'                  THEN '° (3D)'
           WHEN 'GRAM'                       THEN 'g'
           WHEN 'GRAM/CUBIC_METER'           THEN 'g/m³'
           WHEN 'HERTZ'                      THEN 'Hz'
           WHEN 'JOULE'                      THEN 'J'
           WHEN 'KILOGRAM'                   THEN 'kg'
           WHEN 'LITER'                      THEN 'L'
           WHEN 'LITER/SECOND'               THEN 'L/s'
           WHEN 'METER'                      THEN 'm'
           WHEN 'METER/SECOND^2'             THEN 'm/s²'
           WHEN 'MICRO_RADIAN'               THEN 'µrad'
           WHEN 'MILLIGRAM'                  THEN 'mg'
           WHEN 'MILLIGRAM/CUBIC_MILLIMETER' THEN 'mg/mm³'
           WHEN 'MILLIGRAM/LITER'            THEN 'mg/L'
           WHEN 'MILLILITER'                 THEN 'mL'
           WHEN 'MILLIMETER'                 THEN 'mm'
           WHEN 'MILLIMETER/REVOLUTION'      THEN 'mm/rev'
           WHEN 'MILLIMETER/SECOND'          THEN 'mm/s'
           WHEN 'MILLIMETER/SECOND^2'        THEN 'mm/s²'
           WHEN 'MILLIMETER_3D'              THEN 'mm (3D)'
           WHEN 'NEWTON'                     THEN 'N'
           WHEN 'NEWTON_METER'               THEN 'N·m'
           WHEN 'OHM'                        THEN 'Ω'
           WHEN 'OHM_METER'                  THEN 'Ω·m'
           WHEN 'PASCAL'                     THEN 'Pa'
           WHEN 'PASCAL/SECOND'              THEN 'Pa/s'
           WHEN 'PASCAL_SECOND'              THEN 'Pa·s'
           WHEN 'PERCENT'                    THEN '%'
           WHEN 'PH'                         THEN 'pH'
           WHEN 'REVOLUTION/MINUTE'          THEN 'rpm'
           WHEN 'REVOLUTION/SECOND'          THEN 'rev/s'
           WHEN 'REVOLUTION/SECOND^2'        THEN 'rev/s²'
           WHEN 'SECOND'                     THEN 's'
           WHEN 'SIEMENS/METER'              THEN 'S/m'
           WHEN 'SQUARE_MILLIMETER'          THEN 'mm²'
           WHEN 'UNIT_VECTOR_3D'             THEN 'unit vector (3D)'
           WHEN 'VOLT'                       THEN 'V'
           WHEN 'VOLT_AMPERE'                THEN 'VA'
           WHEN 'VOLT_AMPERE_REACTIVE'       THEN 'var'
           WHEN 'WATT'                       THEN 'W'
           WHEN 'WATT_SECOND'                THEN 'W·s'
           WHEN 'AMPERE_HOUR'                THEN 'Ah'
           WHEN 'BAR'                        THEN 'bar'
           WHEN 'CENTIPOISE'                 THEN 'cP'
           WHEN 'COUNT/MILLION'              THEN 'ppm'
           WHEN 'COUNT/TRILLION'             THEN 'ppt'
           WHEN 'CUBIC_FOOT'                 THEN 'ft³'
           WHEN 'CUBIC_FOOT/HOUR'            THEN 'ft³/h'
           WHEN 'CUBIC_FOOT/MINUTE'          THEN 'ft³/min'
           WHEN 'DEGREE/MINUTE'              THEN '°/min'
           WHEN 'FAHRENHEIT'                 THEN '°F'
           WHEN 'FOOT'                       THEN 'ft'
           WHEN 'FOOT/MINUTE'                THEN 'ft/min'
           WHEN 'FOOT/SECOND'                THEN 'ft/s'
           WHEN 'FOOT/SECOND^2'              THEN 'ft/s²'
           WHEN 'FOOT_3D'                    THEN 'ft (3D)'
           WHEN 'GALLON/MINUTE'              THEN 'gal/min'
           WHEN 'GRAVITATIONAL_ACCELERATION' THEN 'gₙ'
           WHEN 'GRAVITATIONAL_FORCE'        THEN 'g-force'
           WHEN 'HOUR'                       THEN 'h'
           WHEN 'INCH'                       THEN 'in'
           WHEN 'INCH/MINUTE'                THEN 'in/min'
           WHEN 'INCH/REVOLUTION'            THEN 'in/rev'
           WHEN 'INCH/SECOND'                THEN 'in/s'
           WHEN 'INCH/SECOND^2'              THEN 'in/s²'
           WHEN 'INCH_3D'                    THEN 'in (3D)'
           WHEN 'INCH_POUND'                 THEN 'in·lb'
           WHEN 'KELVIN'                     THEN 'K'
           WHEN 'KILOWATT'                   THEN 'kW'
           WHEN 'KILOWATT_HOUR'              THEN 'kWh'
           WHEN 'LITER/MINUTE'               THEN 'L/min'
           WHEN 'MICROMETER'                 THEN 'µm'
           WHEN 'MICROTORR'                  THEN 'µTorr'
           WHEN 'MILLIMETER/MINUTE'          THEN 'mm/min'
           WHEN 'MILLIMETER_MERCURY'         THEN 'mmHg'
           WHEN 'MINUTE'                     THEN 'min'
           WHEN 'OTHER'                      THEN 'other'
           WHEN 'PASCAL/MINUTE'              THEN 'Pa/min'
           WHEN 'POUND'                      THEN 'lb'
           WHEN 'POUND/INCH^2'               THEN 'psi'
           WHEN 'RADIAN'                     THEN 'rad'
           WHEN 'RADIAN/MINUTE'              THEN 'rad/min'
           WHEN 'RADIAN/SECOND'              THEN 'rad/s'
           WHEN 'RADIAN/SECOND^2'            THEN 'rad/s²'
           WHEN 'RANKINE'                    THEN '°R'
           WHEN 'SQUARE_INCH'                THEN 'in²'
           WHEN 'TORR'                       THEN 'Torr'
           WHEN 'MILLISECOND'                THEN 'ms'
           WHEN 'PARTS/MILLION'              THEN 'ppm'
         END;
$$;

ALTER FUNCTION public.unit_symbol(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.unit_symbol(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.unit_symbol(text) IS
  'The symbol a person reads for a unit code, "°C" for CELSIUS, or NULL for a code with no symbol. The '
  'pairs of UNIT_SYMBOLS in frontend/src/utils/units.js, which mirror check 104 holds alike. Granted '
  'to no API role (0292).';

-- A number's text with its unit, as withUnit() in the dashboard says it: "82.4 °C", "42%", "90°". A
-- code with no symbol is printed as it is, and no code leaves the text alone.
CREATE OR REPLACE FUNCTION public.with_unit(p_text text, p_code text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  SELECT CASE
           WHEN coalesce(p_code, '') = '' THEN p_text
           WHEN coalesce(public.unit_symbol(p_code), p_code) IN ('%', '°') THEN p_text || coalesce(public.unit_symbol(p_code), p_code)
           ELSE p_text || ' ' || coalesce(public.unit_symbol(p_code), p_code)
         END;
$$;

ALTER FUNCTION public.with_unit(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.with_unit(text, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.with_unit(text, text) IS
  'A number''s text followed by its unit''s symbol, as withUnit() in the dashboard says it: "82.4 °C", '
  'with a % or a ° against the number ("42%") and any other symbol after a space. A code with no symbol '
  'is printed as it is; no code leaves the text. Granted to no API role (0292).';

-- -------------------------------------------------------------------------------------------------
-- 2. A value and a threshold in words, with the unit
-- -------------------------------------------------------------------------------------------------
-- 0283's two functions with one change: a measured metric's value and threshold take the unit its
-- catalogue row holds. A derived metric is worded as 0283 words it, and a metric with no catalogue
-- row, or no unit, is as it prints, so an alert on one reads as it did.
CREATE OR REPLACE FUNCTION public.automation_value_words(p_metric text, p_value double precision) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
           WHEN m.derivation IS NULL THEN public.with_unit(p_value::text, m.units)
           ELSE CASE WHEN m.derivation ->> 'kind' = 'time_in_state'
                     THEN trim_scale(round((p_value * 100)::numeric, 1))::text || '%'
                     ELSE trim_scale(round(p_value::numeric, 3))::text END
                || CASE public.derived_window_minutes(m.derivation) WHEN 0 THEN ' at the last whole minute' ELSE ' over the last hour' END
         END
    FROM (SELECT 1) AS one
    LEFT JOIN public.metric_catalog m ON m.name = p_metric;
$$;

ALTER FUNCTION public.automation_value_words(text, double precision) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_value_words(text, double precision) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_value_words(text, double precision) IS
  'A threshold value in words, for an automation''s detail and its alert''s summary: a measured metric''s '
  'value followed by its unit ("82.4 °C", "42%"), a derived metric''s rounded to three decimals and '
  'followed by its window ("4.167 over the last hour", "7 at the last whole minute"), a time in state''s '
  'as a percentage with one decimal at most ("42% over the last hour"). A metric with no unit is the '
  'value as it prints. Granted to no API role (0283, 0292).';

CREATE OR REPLACE FUNCTION public.automation_threshold_words(p_metric text, p_threshold double precision) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
           WHEN m.derivation ->> 'kind' = 'time_in_state'
           THEN trim_scale(round((p_threshold * 100)::numeric, 1))::text || '%'
           WHEN m.derivation IS NULL THEN public.with_unit(p_threshold::text, m.units)
           ELSE p_threshold::text
         END
    FROM (SELECT 1) AS one
    LEFT JOIN public.metric_catalog m ON m.name = p_metric;
$$;

ALTER FUNCTION public.automation_threshold_words(text, double precision) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_threshold_words(text, double precision) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_threshold_words(text, double precision) IS
  'A threshold in words, beside automation_value_words(): a measured metric''s followed by its unit '
  '("80 °C"), a time in state''s as a percentage ("90%" for 0.9), any other as it prints. Words only: the '
  'threshold stays the number a file holds. Granted to no API role (0283, 0292).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn text;
BEGIN
  -- The symbols are a pure lookup: immutable, with the search_path pinned to nothing.
  FOREACH v_fn IN ARRAY ARRAY['public.unit_symbol(text)', 'public.with_unit(text, text)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn::regprocedure AND p.provolatile = 'i'
                      AND p.proconfig @> ARRAY['search_path=""']) THEN
      RAISE EXCEPTION '0292: % is not IMMUTABLE with its search_path pinned', v_fn;
    END IF;
  END LOOP;
  IF public.unit_symbol('CELSIUS') IS DISTINCT FROM '°C' OR public.unit_symbol('PERCENT') IS DISTINCT FROM '%'
     OR public.unit_symbol('NOT_A_UNIT') IS NOT NULL OR public.unit_symbol(NULL) IS NOT NULL THEN
    RAISE EXCEPTION '0292: unit_symbol() does not answer a symbol for a code that has one and NULL for one that has not';
  END IF;
  IF public.with_unit('82.4', 'CELSIUS') IS DISTINCT FROM '82.4 °C' OR public.with_unit('42', 'PERCENT') IS DISTINCT FROM '42%'
     OR public.with_unit('90', 'DEGREE') IS DISTINCT FROM '90°' OR public.with_unit('7', 'NOT_A_UNIT') IS DISTINCT FROM '7 NOT_A_UNIT'
     OR public.with_unit('5', NULL) IS DISTINCT FROM '5' OR public.with_unit('5', '') IS DISTINCT FROM '5' THEN
    RAISE EXCEPTION '0292: with_unit() does not say a unit as the dashboard does';
  END IF;
  -- A metric the catalogue does not hold is still worded as it prints (0283's own check says so too).
  IF public.automation_value_words('not-in-the-catalogue', 80.12345678) IS DISTINCT FROM '80.12345678' THEN
    RAISE EXCEPTION '0292: a metric the catalogue does not hold is not worded as its value prints';
  END IF;
  IF public.automation_threshold_words('not-in-the-catalogue', 0.9) IS DISTINCT FROM '0.9' THEN
    RAISE EXCEPTION '0292: a metric the catalogue does not hold has its threshold worded otherwise than as it prints';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.unit_symbol(text)', 'public.with_unit(text, text)',
                              'public.automation_value_words(text, double precision)',
                              'public.automation_threshold_words(text, double precision)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0292: an API role may execute %', v_fn;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
