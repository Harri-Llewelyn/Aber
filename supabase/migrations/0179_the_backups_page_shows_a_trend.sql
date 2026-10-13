-- 0179: The Backups page shows a trend: how often backups succeed, how long they take, how far back
-- a restore goes, how much disk they hold and how much is left.
--
-- backup_summary() answers the page's stat strip in one call, Administrator only like the tables it
-- reads. The free space on the backup volume and the service's schedule are not in the database
-- otherwise: the backup service reports them through backup_report() after each backup and each
-- prune, into the one-row backup_service_report. backup_health stays Grafana's.

-- -------------------------------------------------------------------------------------------------
-- The service's report
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_service_report (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    volume_free_bytes bigint CHECK (volume_free_bytes >= 0),
    volume_total_bytes bigint CHECK (volume_total_bytes >= 0),
    schedule text NOT NULL DEFAULT '',
    reported_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.backup_service_report OWNER TO postgres;
ALTER TABLE public.backup_service_report ENABLE ROW LEVEL SECURITY;
-- Read through backup_summary() only.
REVOKE ALL ON TABLE public.backup_service_report FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.backup_service_report IS
  'One row: the free and total bytes on the backup volume (statfs on /backups; on local-path the '
  'node''s whole disk) and the schedule the backup service runs, as it last reported them through '
  'backup_report(). NULL bytes when statfs failed. Read by backup_summary().';

-- A backup_* gate, as backup_finalise() is: the service's own connection and nobody else.
CREATE OR REPLACE FUNCTION public.backup_report(p_volume_free_bytes bigint, p_volume_total_bytes bigint, p_schedule text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.require_backup_service_caller('backup_report');

  -- A figure statfs could not give stays NULL, never a zero the page would read as a full disk.
  INSERT INTO public.backup_service_report
         (singleton, volume_free_bytes, volume_total_bytes, schedule, reported_at)
  VALUES (true,
          CASE WHEN p_volume_free_bytes >= 0 THEN p_volume_free_bytes END,
          CASE WHEN p_volume_total_bytes >= 0 THEN p_volume_total_bytes END,
          coalesce(btrim(p_schedule), ''), now())
  ON CONFLICT (singleton) DO UPDATE
     SET volume_free_bytes = EXCLUDED.volume_free_bytes,
         volume_total_bytes = EXCLUDED.volume_total_bytes,
         schedule = EXCLUDED.schedule,
         reported_at = EXCLUDED.reported_at;
END
$$;

ALTER FUNCTION public.backup_report(bigint, bigint, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.backup_report(bigint, bigint, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.backup_report(bigint, bigint, text) IS
  'The backup service records the free and total bytes on its volume and its schedule, after each '
  'backup and each prune and at start. One row, replaced each time.';

-- -------------------------------------------------------------------------------------------------
-- What the Backups page reads
-- -------------------------------------------------------------------------------------------------
-- One object. The clock is backup_health's: the last success is when the newest COMPLETED job
-- started. A run "in the last 30 days" ended in them and completed or failed; a cancelled run never
-- ran. The median is over the last 14 completed runs. The newest copy off site counts a copy at
-- the current destination, or any copy while none is set, as the page's Off site column does.
CREATE OR REPLACE FUNCTION public.backup_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_base text;
BEGIN
  -- Checked here: a hidden page is not a gate, and this runs as its owner.
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'only an Administrator may read the backup summary'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_base := public.backup_offsite_base();

  RETURN jsonb_build_object(
    'first_recorded_at', (SELECT min(j.created_at) FROM public.backup_jobs j),
    'last_success', (
      SELECT jsonb_build_object('id', j.id, 'status', j.status, 'started_at', j.started_at,
                                'finished_at', j.finished_at,
                                'duration_seconds', extract(epoch FROM j.finished_at - j.started_at))
        FROM public.backup_jobs j
       WHERE j.status = 'COMPLETED'
       ORDER BY j.finished_at DESC NULLS LAST
       LIMIT 1),
    'latest_outcome', (
      SELECT jsonb_build_object('id', j.id, 'status', j.status, 'started_at', j.started_at,
                                'finished_at', j.finished_at)
        FROM public.backup_jobs j
       WHERE j.status IN ('COMPLETED', 'FAILED')
       ORDER BY j.finished_at DESC NULLS LAST
       LIMIT 1),
    'runs_30d', (
      SELECT count(*) FROM public.backup_jobs j
       WHERE j.status IN ('COMPLETED', 'FAILED') AND j.finished_at > now() - interval '30 days'),
    'succeeded_30d', (
      SELECT count(*) FROM public.backup_jobs j
       WHERE j.status = 'COMPLETED' AND j.finished_at > now() - interval '30 days'),
    'median_duration_seconds', (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d.seconds::double precision)
        FROM (SELECT extract(epoch FROM j.finished_at - j.started_at) AS seconds
                FROM public.backup_jobs j
               WHERE j.status = 'COMPLETED' AND j.started_at IS NOT NULL
               ORDER BY j.finished_at DESC
               LIMIT 14) d),
    'median_runs', (
      SELECT count(*)
        FROM (SELECT 1 FROM public.backup_jobs j
               WHERE j.status = 'COMPLETED' AND j.started_at IS NOT NULL
               ORDER BY j.finished_at DESC
               LIMIT 14) d),
    'backups_held', (SELECT count(*) FROM public.backups),
    'bytes_held', (SELECT coalesce(sum(b.size_bytes), 0) FROM public.backups b),
    'oldest_taken_at', (SELECT min(b.taken_at) FROM public.backups b),
    'newest_size_bytes', (
      SELECT b.size_bytes FROM public.backups b ORDER BY b.taken_at DESC, b.stamp DESC LIMIT 1),
    'offsite_destination_set', v_base IS NOT NULL,
    'newest_offsite', (
      SELECT jsonb_build_object('stamp', b.stamp, 'taken_at', b.taken_at,
                                'copied_at', b.offsite_copied_at)
        FROM public.backups b
       WHERE b.offsite_state = 'COPIED'
         AND (v_base IS NULL OR starts_with(b.offsite_location, v_base))
       ORDER BY b.taken_at DESC
       LIMIT 1),
    'service', (
      SELECT jsonb_build_object('reported_at', r.reported_at,
                                'volume_free_bytes', r.volume_free_bytes,
                                'volume_total_bytes', r.volume_total_bytes,
                                'schedule', r.schedule)
        FROM public.backup_service_report r)
  );
END
$$;

ALTER FUNCTION public.backup_summary() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.backup_summary() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.backup_summary() TO authenticated;

COMMENT ON FUNCTION public.backup_summary() IS
  'The Backups page''s stat strip in one object: the first job recorded, the last success and the '
  'latest outcome, runs and successes in the last 30 days, the median duration of the last 14 '
  'completed runs, the backups held and their bytes, the oldest restorable point, the newest '
  'backup''s size, the newest copy off site, and the backup service''s report. Administrator only '
  '(insufficient_privilege, 403).';

-- What this file decides: the report and its gate answer no API role; the summary answers
-- authenticated, and refuses inside for anybody but an Administrator.
DO $$
DECLARE
  v_wrong text;
BEGIN
  SELECT string_agg(r, ', ') INTO v_wrong
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
   WHERE has_table_privilege(r, 'public.backup_service_report', 'SELECT')
      OR has_function_privilege(r, 'public.backup_report(bigint, bigint, text)', 'EXECUTE');
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '0179: the backup service''s report is reachable by %', v_wrong;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.backup_summary()', 'EXECUTE') THEN
    RAISE EXCEPTION '0179: authenticated cannot execute backup_summary()';
  END IF;
END
$$;
