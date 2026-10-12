-- 0180: The Directory shows the known CVEs of the image each service runs.
--
-- release.yml scans every image the chart runs and packages a summary as the chart file
-- files/image-scans.json: per image reference, the fixable CRITICAL and HIGH findings, the scan
-- time, the date of the vulnerability database the scan used, and for an image Aber builds FROM a
-- third-party product, that product's version. db-init passes it as `directory_image_scans` on
-- every run, as it passes the image map 0002 records, and record_directory_image_scans() writes it
-- beside each row's image. A row whose image the summary does not name, such as an overridden tag,
-- has no scan, which the Directory reads as "not scanned".
--
-- Reasoning: supabase/README.md, "The Directory shows each image's known CVEs (0180)". Idempotent.

ALTER TABLE public.directory_services ADD COLUMN IF NOT EXISTS image_fixable_critical integer;
ALTER TABLE public.directory_services ADD COLUMN IF NOT EXISTS image_fixable_high integer;
ALTER TABLE public.directory_services ADD COLUMN IF NOT EXISTS image_scanned_at timestamptz;
ALTER TABLE public.directory_services ADD COLUMN IF NOT EXISTS image_vulnerability_db_at timestamptz;
ALTER TABLE public.directory_services ADD COLUMN IF NOT EXISTS upstream_version text;

COMMENT ON COLUMN public.directory_services.image_fixable_critical IS
  'Fixable CRITICAL findings in `image` when the release scanned it, from the summary the chart '
  'carries (0180). NULL when the release did not scan that reference.';
COMMENT ON COLUMN public.directory_services.image_fixable_high IS
  'Fixable HIGH findings in `image` when the release scanned it (0180). NULL when not scanned.';
COMMENT ON COLUMN public.directory_services.image_scanned_at IS
  'When the release scanned `image` (0180). A CVE published later is not counted. NULL when not '
  'scanned.';
COMMENT ON COLUMN public.directory_services.image_vulnerability_db_at IS
  'The date of the vulnerability database that scan used (0180). NULL when not scanned.';
COMMENT ON COLUMN public.directory_services.upstream_version IS
  'The version of the third-party product an image Aber builds carries under Aber''s own tag, such '
  'as Node-RED''s, from the same summary (0180). NULL for every other image.';

-- Sets the five columns of every row from the summary's entry for the row's own `image`, and
-- clears them where there is none. An entry missing a count or a date is not a scan.
CREATE OR REPLACE FUNCTION public.record_directory_image_scans(p_summary jsonb)
RETURNS integer
    LANGUAGE sql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    WITH entry AS (
        SELECT d.id,
               p_summary -> 'images' -> d.image AS e
          FROM public.directory_services d
    ), judged AS (
        SELECT id, e,
               coalesce(e ->> 'critical' ~ '^[0-9]{1,9}$'
                        AND e ->> 'high' ~ '^[0-9]{1,9}$'
                        AND e ->> 'scanned_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
                        AND e ->> 'vulnerability_db_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$',
                        false) AS whole
          FROM entry
    ), scan AS (
        SELECT id,
               CASE WHEN whole THEN (e ->> 'critical')::integer END AS critical,
               CASE WHEN whole THEN (e ->> 'high')::integer END AS high,
               CASE WHEN whole THEN (e ->> 'scanned_at')::timestamptz END AS scanned_at,
               CASE WHEN whole THEN (e ->> 'vulnerability_db_at')::timestamptz END AS db_at,
               CASE WHEN jsonb_typeof(e -> 'upstream') = 'string'
                    THEN NULLIF(left(e ->> 'upstream', 128), '') END AS upstream
          FROM judged
    ), changed AS (
        UPDATE public.directory_services d
           SET image_fixable_critical = s.critical,
               image_fixable_high = s.high,
               image_scanned_at = s.scanned_at,
               image_vulnerability_db_at = s.db_at,
               upstream_version = s.upstream
          FROM scan s
         WHERE d.id = s.id
           AND (d.image_fixable_critical, d.image_fixable_high, d.image_scanned_at,
                d.image_vulnerability_db_at, d.upstream_version)
               IS DISTINCT FROM (s.critical, s.high, s.scanned_at, s.db_at, s.upstream)
        RETURNING 1
    )
    SELECT count(*)::integer FROM changed;
$$;

ALTER FUNCTION public.record_directory_image_scans(jsonb) OWNER TO postgres;

COMMENT ON FUNCTION public.record_directory_image_scans(jsonb) IS
  'Writes the known-CVE columns of directory_services from the summary a release packages '
  '(files/image-scans.json), matching each row on its exact image reference and clearing rows the '
  'summary does not name. Returns how many rows changed. Called by 0180 with db-init''s summary; '
  'runs as postgres.';

-- Only db-init calls it, as the owner. Revoked by name, never through the anon sweep.
REVOKE ALL ON FUNCTION public.record_directory_image_scans(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn text := 'public.record_directory_image_scans(jsonb)';
  v_role text;
  v_col text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['image_fixable_critical', 'image_fixable_high', 'image_scanned_at',
                               'image_vulnerability_db_at', 'upstream_version'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'directory_services'
                      AND column_name = v_col) THEN
      RAISE EXCEPTION '0180: directory_services has no % column', v_col;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0180: % may execute %; only db-init records the scans', v_role, v_fn;
    END IF;
  END LOOP;
END
$check$;

-- psql does not substitute variables inside dollar quotes, so the summary is read here. A runner
-- that passes none (test:db, the schema-equivalence check) records nothing and clears nothing;
-- db-init passes `{}` when the chart carries no summary, which clears every row.
\if :{?directory_image_scans} \else \set directory_image_scans '' \endif

SELECT public.record_directory_image_scans(m.summary) AS directory_image_scans_changed
  FROM (SELECT NULLIF(:'directory_image_scans', '')::jsonb AS summary) m
 WHERE m.summary IS NOT NULL;

NOTIFY pgrst, 'reload schema';
