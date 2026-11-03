-- 0226: A failed or stuck capture or playback, and a playback worker that has stopped reporting
-- while a playback waits, are platform conditions.
--
-- A failed job showed as a banner on the Capture page for fifteen minutes and in the job history,
-- and nothing else. A job stuck in flight, or a playback queued for a worker that is not running,
-- showed nowhere but its own strip. platform_health_rows() gains three arms, each read by a rule in
-- Grafana's Platform Conditions group, which reaches the dashboard's alert counter:
--
--   * job_failed: a capture or playback job that FAILED in the last hour, one row each. A failure is
--     an event, so the row leaves the view an hour after it and the alert resolves by itself.
--   * job_stuck: a capture or playback job still queued, recording or running five minutes past
--     what its own limits allow, one row each.
--   * playback_worker_stale: the playback worker's heartbeat older than two minutes WHILE a playback
--     job is queued or running. Never from the heartbeat's age alone: the row is seeded at 'epoch',
--     and on a site with playback.enabled: false nothing ever reports.
--
-- No arm names an asset: these are the platform's own jobs, so sparkplug_id is NULL and the rules
-- are entity_type: platform. The redeclared function keeps 0001's signature, its grants and 0185's
-- arms. No Audit Trail row is written for a failure: the job history is its record.
--
-- Reasoning: supabase/README.md, "A failed or stuck capture or playback reaches someone (0226)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- platform_health_rows(): three more arms
-- -------------------------------------------------------------------------------------------------
-- 0185's body, then the three arms. CREATE OR REPLACE keeps 0001's grants: service_role, and
-- grafana_reader from 0001's last block.
CREATE OR REPLACE FUNCTION public.platform_health_rows() RETURNS TABLE(condition text, sparkplug_id text, subject text, value numeric, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    -- ---------------------------------------------------------------------------------------
    -- A gateway that has stopped heartbeating. Reads `gateway_status.is_stale` rather than
    -- re-deriving it: that view owns the 90s threshold. Archived gateways are excluded, and so
    -- are shadow gateways: nothing publishes as one until a playback runs, so its silence is not a
    -- fault, and alerting on it would train an operator to ignore the rule.
    -- ---------------------------------------------------------------------------------------
    SELECT 'gateway_stale'::text,
           g.sparkplug_id,
           g.name,
           g.heartbeat_age_seconds::numeric,
           format('%s has not reported for %s seconds', g.name, g.heartbeat_age_seconds)
      FROM public.gateway_status g
     WHERE g.is_stale
       AND NOT g.is_archived
       AND NOT g.is_shadow

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- An enrolment that never completed: redeemed its token, landed in AWAITING_BIRTH, and never
    -- published. Age is measured from `enrolled_at`.
    -- ---------------------------------------------------------------------------------------
    SELECT 'enrolment_stuck'::text,
           g.sparkplug_id,
           g.name,
           EXTRACT(EPOCH FROM (now() - g.enrolled_at))::numeric,
           format('%s has been AWAITING_BIRTH since %s', g.name, g.enrolled_at)
      FROM public.gateways g
     WHERE g.status = 'AWAITING_BIRTH'
       AND g.enrolled_at IS NOT NULL
       AND NOT g.is_archived

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- The quarantine queue: fleet-wide, so one row with no subject (`entity_type = 'platform'`).
    -- Emitted even at zero, so "nothing is quarantined" and "the datasource is down" are
    -- distinguishable.
    -- ---------------------------------------------------------------------------------------
    SELECT 'quarantine_depth'::text,
           NULL::text,
           'fleet'::text,
           count(*)::numeric,
           format('%s device(s) awaiting an approval decision', count(*))
      FROM public.devices d
     WHERE d.is_quarantined
       AND NOT d.is_archived
    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- Devices that SHOULD be publishing. See `0092`'s header for why each exclusion is here and
    -- why zero is the answer that disables the alert rather than a gap in it. Replay lanes are
    -- out, as their gateway is out of gateway_stale: a shadow gateway's devices publish only
    -- while a playback runs, so their silence is not a fault.
    -- ---------------------------------------------------------------------------------------
    SELECT 'expected_publishers'::text,
           NULL::text,
           'fleet'::text,
           count(*)::numeric,
           format('%s device(s) registered, unarchived, unquarantined, not a replay lane, and '
                  'behind a gateway that has reported at least once', count(*))
      FROM public.devices d
      JOIN public.gateways g ON g.id = d.gateway_id
     WHERE NOT d.is_archived
       AND NOT d.is_quarantined
       AND NOT g.is_shadow
       -- 0092. BEING BOUND TO A GATEWAY IS NOT EVIDENCE THAT A PATH HAS EVER EXISTED. See that
       -- migration's header: a device behind an edge node nobody has deployed yet is not late.
       AND (
             -- The device has published. The strongest evidence available, and about the device
             -- itself rather than about something it points at.
             d.first_dbirth_at IS NOT NULL
             -- Or its gateway has been heard from at least once, ever. 0001's own comment on the
             -- column is the contract: "NULL means no heartbeat has ever arrived." Nothing clears
             -- it, so a gateway that has since DIED still counts -- which is correct, because that
             -- is precisely the case this alert exists for.
             OR g.last_heartbeat IS NOT NULL
           )

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- 0133. How far the cold archive has fallen behind, in DAYS past the tiering threshold.
    --
    -- ONLY WHILE ARCHIVING IS ON, and that is the whole gate. On a stack that does not archive,
    -- every chunk is unexported for ever and the frontier is the oldest data there is -- a row
    -- that would be permanently and uselessly alarming. The rule's noDataState is OK, so an
    -- absent row reads as "nothing to report" exactly as it does for a healthy fleet.
    --
    -- Days rather than seconds because the annotation is read by a person deciding whether to go
    -- and look at a link, and because the tolerance is measured in chunk intervals.
    -- ---------------------------------------------------------------------------------------
    SELECT 'archive_backlog'::text,
           NULL::text,
           'fleet'::text,
           round(b.overdue_seconds / 86400.0, 1),
           format('cold telemetry from %s onwards is not yet verified on the remote endpoint: '
                  '%s day(s) past the %s-day threshold',
                  b.oldest_unexported, round(b.overdue_seconds / 86400.0, 1), b.threshold_days)
      FROM public.cold_archive_backlog_state() b
     WHERE b.enabled

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- 0226. A capture or playback that FAILED in the last hour, one row per job, named by its
    -- kind and id. The value is the seconds since it failed. Every writer of FAILED stamps
    -- finished_at. A failure is an event, not a state: the row leaves an hour after it, so the
    -- alert resolves by itself, and the job history on the Capture page keeps the record.
    -- ---------------------------------------------------------------------------------------
    SELECT 'job_failed'::text,
           NULL::text,
           format('%s job %s', f.kind, f.id),
           EXTRACT(EPOCH FROM (now() - f.finished_at))::numeric,
           format('the %s of %s failed at %s: %s', f.kind, f.subject, f.finished_at, f.error)
      FROM (SELECT 'capture'::text AS kind, c.id, c.subject_sparkplug_id AS subject,
                   c.finished_at, c.error
              FROM public.capture_jobs c
             WHERE c.status = 'FAILED'
               AND c.finished_at > now() - interval '1 hour'
            UNION ALL
            SELECT 'playback'::text, p.id, p.target_edge_node_id, p.finished_at, p.error
              FROM public.playback_jobs p
             WHERE p.status = 'FAILED'
               AND p.finished_at > now() - interval '1 hour') f

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- 0226. A capture or playback still in flight five minutes past what its own limits allow,
    -- one row per job. `due` is when those limits ran out, and the value is the seconds since.
    --
    --   * A queued capture is claimed within seconds: the daemon polls every 3 s.
    --   * A recording ends at its duration cap, max_seconds, and reports every second until then.
    --     Its last report is started_at plus elapsed_seconds, as request_capture_stop() reads it,
    --     and two minutes without one is what that function calls stale.
    --   * A queued playback is claimed within seconds of the worker being free: no playback is
    --     running, and none has ended since it was queued.
    --   * A running playback reports at least once a second, and a minute without a report is what
    --     request_playback_stop() calls stalled.
    --
    -- A playback while the worker's heartbeat is stale is playback_worker_stale's, below, so one
    -- cause raises one alert.
    -- ---------------------------------------------------------------------------------------
    SELECT 'job_stuck'::text,
           NULL::text,
           format('%s job %s', s.kind, s.id),
           EXTRACT(EPOCH FROM (now() - s.due))::numeric,
           format('the %s of %s has been %s since %s, and its own limits ran out at %s',
                  s.kind, s.subject, s.status, s.since, s.due)
      FROM (SELECT 'capture'::text AS kind, c.id, c.subject_sparkplug_id AS subject, c.status,
                   coalesce(c.started_at, c.created_at) AS since,
                   CASE WHEN c.status = 'PENDING' THEN c.created_at
                        ELSE least(coalesce(c.started_at, c.created_at)
                                     + make_interval(secs => c.max_seconds),
                                   coalesce(c.started_at, c.created_at)
                                     + make_interval(secs => c.elapsed_seconds)
                                     + interval '2 minutes')
                   END AS due
              FROM public.capture_jobs c
             WHERE c.status IN ('PENDING', 'RECORDING')
            UNION ALL
            SELECT 'playback'::text, p.id, p.target_edge_node_id, p.status,
                   coalesce(p.started_at, p.created_at),
                   CASE WHEN p.status = 'PENDING'
                        THEN greatest(p.created_at,
                                      (SELECT max(e.finished_at) FROM public.playback_jobs e))
                        ELSE coalesce(p.progress_reported_at, p.started_at, p.created_at)
                               + interval '1 minute'
                   END
              FROM public.playback_jobs p
             WHERE p.status IN ('PENDING', 'RUNNING')
               AND (p.status = 'RUNNING'
                    OR NOT EXISTS (SELECT 1 FROM public.playback_jobs r WHERE r.status = 'RUNNING'))
               AND EXISTS (SELECT 1 FROM public.playback_worker_status w
                            WHERE w.reported_at >= now() - interval '2 minutes')) s
     WHERE s.due < now() - interval '5 minutes'

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- 0226. The playback worker has not reported for two minutes WHILE a playback job is queued
    -- or running. The worker stamps reported_at every 30 s (playback_report_credentials()), and
    -- the playback dialog reads a report older than two minutes as a worker that is not running
    -- (WORKER_STALE_MS). Gated on the job and never on the age alone: the row is seeded at
    -- 'epoch', the database cannot tell whether the worker is deployed, and a site with
    -- playback.enabled: false would fire for ever. A missing row reads as never reported.
    -- ---------------------------------------------------------------------------------------
    SELECT 'playback_worker_stale'::text,
           NULL::text,
           'playback worker'::text,
           EXTRACT(EPOCH FROM (now() - w.reported_at))::numeric,
           CASE WHEN w.reported_at = 'epoch'::timestamptz
                THEN 'the playback worker has never reported, and a playback job is queued or running'
                ELSE format('the playback worker last reported at %s, and a playback job is queued '
                            'or running', w.reported_at)
           END
      FROM (SELECT coalesce((SELECT s.reported_at FROM public.playback_worker_status s WHERE s.id),
                            'epoch'::timestamptz) AS reported_at) w
     WHERE w.reported_at < now() - interval '2 minutes'
       AND EXISTS (SELECT 1 FROM public.playback_jobs p WHERE p.status IN ('PENDING', 'RUNNING'))
$$;

ALTER FUNCTION public.platform_health_rows() OWNER TO postgres;

COMMENT ON FUNCTION public.platform_health_rows() IS 'One row per platform condition worth alerting on: stale gateways, stuck enrolments, the quarantine queue depth, how many devices are expected to be publishing, the cold archive''s backlog, capture and playback jobs that failed in the last hour or are stuck past their own limits, and a playback worker that has stopped reporting while a playback waits (0226). SECURITY DEFINER so the Grafana reader needs no privilege on gateways, devices or the job tables -- it emits a count and, where the condition names an asset, that asset''s wire id, and nothing else about it. Shadow gateways are outside gateway_stale (0182) and their devices, the replay lanes, outside expected_publishers (0185): nothing publishes as one between playbacks, so its silence is not a fault.';

-- Re-stated by name: no API role runs it. grafana_reader's grant stays 0001's (check 55).
REVOKE ALL ON FUNCTION public.platform_health_rows() FROM PUBLIC, anon, authenticated;

-- -------------------------------------------------------------------------------------------------
-- Self-check: the arms this file adds are there, the stale-worker arm is gated on a playback in
-- flight, 0185's exclusions survive, and the readers are unchanged. Read from the definition and
-- the catalogue, never from the rows, which depend on what the site has run.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  CONSTANT regprocedure := 'public.platform_health_rows()'::regprocedure;
  v_src text;
  v_arm text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;

  IF v_src NOT LIKE '%''job_failed''::text%' OR v_src NOT LIKE '%''job_stuck''::text%'
     OR v_src NOT LIKE '%''playback_worker_stale''::text%' THEN
    RAISE EXCEPTION '0226: platform_health_rows() lacks one of job_failed, job_stuck and playback_worker_stale';
  END IF;

  v_arm := substring(v_src FROM '''playback_worker_stale''::text.*$');
  IF v_arm !~ 'EXISTS \(SELECT 1 FROM public\.playback_jobs p WHERE p\.status IN \(''PENDING'', ''RUNNING''\)\)' THEN
    RAISE EXCEPTION '0226: the playback_worker_stale arm is not gated on a queued or running playback, so a site that runs no worker would alert for ever';
  END IF;

  IF substring(v_src FROM '''gateway_stale''::text.*?UNION ALL') !~ 'AND NOT g\.is_shadow'
     OR substring(v_src FROM '''expected_publishers''::text.*?UNION ALL') !~ 'AND NOT g\.is_shadow' THEN
    RAISE EXCEPTION '0226: platform_health_rows() lost 0182''s or 0185''s shadow-gateway exclusion';
  END IF;

  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0226: an API role can run platform_health_rows()';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader')
     AND NOT (has_function_privilege('grafana_reader', v_fn, 'EXECUTE')
              AND has_table_privilege('grafana_reader', 'public.platform_health', 'SELECT')) THEN
    RAISE EXCEPTION '0226: grafana_reader can no longer read platform_health, so every Platform Conditions rule would fail';
  END IF;
END
$check$;
