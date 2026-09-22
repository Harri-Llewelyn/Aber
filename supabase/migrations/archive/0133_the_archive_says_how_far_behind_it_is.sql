-- =============================================================================================
-- Migration: 0133_the_archive_says_how_far_behind_it_is.sql
-- How far the cold archive has fallen behind, on the page and as an alert condition
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS EXISTS, AND WHY IT EXISTS NOW
--
-- `0132` turned a local disk write into a network operation with an unbounded outage window. A
-- link down for three weeks means one of two things, and until now nothing reported which:
--
--   * `TIMESCALE_RETAIN_FOR` deletes chunks on a timer that the archiver never reached, or
--   * retention is off and the historian's volume fills.
--
-- Disk exhaustion is the right failure of the two -- it is recoverable and it loses nothing -- but
-- only if somebody is told it is coming. The chart now defaults retention to `never` once a remote
-- destination is configured, which makes the second outcome the one a site gets; this makes it
-- visible.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT "BEHIND" MEANS, MEASURED FROM THE VERIFIED FRONTIER
--
-- The frontier is the newest `range_end` this site has VERIFIED -- everything after it is telemetry
-- no object is yet known to hold. Its age is the age of the oldest unexported span, which is what
-- the operator actually wants: not "how many chunks are queued" but "how far back does the data I
-- could lose begin".
--
-- Before the first export there is no frontier, and the answer is the oldest raw data there is.
-- That is `storage_footprint.oldest_data`, over the same FDW bridge, so the first run of an
-- archiver that cannot reach its endpoint is reported rather than read as a healthy zero.
--
-- OVERDUE IS THE AGE MINUS THE THRESHOLD, and up to one chunk interval of it is normal. Chunks are
-- seven days (`timescaledb/init/001_schema.sql`) and `cold_tier_candidates()` bounds on `range_end`,
-- so a chunk is not eligible until its whole span is past the threshold: a perfectly healthy site
-- sits between zero and seven days overdue and the alert rule tolerates twice that. A threshold of
-- "any overdue at all" would fire on every install, every week, correctly, and be turned off.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. The state, computed once and read by both consumers
-- ---------------------------------------------------------------------------------------------
-- NO ROLE GATE, and EXECUTE revoked from every caller that could reach it directly. The two
-- wrappers below have different audiences -- a page restricted to three roles, and an alert view
-- Grafana reads as `grafana_reader`, which holds none of them -- and duplicating the arithmetic
-- into both is how the two answers start to disagree.
--
-- IT RETURNS NO ROW RATHER THAN RAISING WHEN THE HISTORIAN IS UNREACHABLE, and that is the whole
-- reason this is plpgsql instead of four lines of SQL.
--
-- `platform_health_rows()` is one UNION: an arm of it that raises takes the entire view down, and
-- with it gateway staleness, stuck enrolments, the quarantine queue and expected publishers -- four
-- conditions that have nothing to do with the archive and are the ones somebody is relying on while
-- the database they read is in trouble. postgres_fdw raises on connect, not on scan, so an
-- unreachable historian is exactly the case: `could not connect to server "timescaledb_server"`.
--
-- Deliberately NOT warned about here. This runs on every alert evaluation, once a minute, and a
-- WARNING per call would put fifteen hundred lines a day in the log to report a condition the
-- stack alarms on by other means. The absence of the figure IS the report: the page stops showing
-- it and the rule goes to NoData, which its noDataState reads as OK.
CREATE OR REPLACE FUNCTION public.cold_archive_backlog_state()
RETURNS TABLE (
    enabled           boolean,
    threshold_days    integer,
    oldest_unexported timestamptz,
    age_seconds       numeric,
    overdue_seconds   numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
    RETURN QUERY
    WITH policy AS (
        SELECT
            coalesce(
                (SELECT (value #>> '{}')::boolean
                   FROM public.system_settings WHERE key = 'archive.enabled'), false) AS enabled,
            coalesce(
                (SELECT (value #>> '{}')::integer
                   FROM public.system_settings WHERE key = 'archive.tier_after_days'), 90) AS threshold_days
    ),
    frontier AS (
        SELECT coalesce(
            -- The newest span known to be on the remote endpoint. `verified_at`, not `exported_at`:
            -- an exported row is an object nothing has read back, which is the state this alert
            -- exists to distinguish from success.
            (SELECT max(m.range_end)
               FROM timescale.telemetry_archive_manifest m
              WHERE m.verified_at IS NOT NULL),
            -- Nothing verified yet, so the unexported span begins at the oldest raw data.
            (SELECT f.oldest_data
               FROM timescale.storage_footprint f
              WHERE f.relation = 'telemetry' AND f.tier = 'raw')
        ) AS frontier_at
    )
    SELECT p.enabled,
           p.threshold_days,
           f.frontier_at,
           EXTRACT(EPOCH FROM (now() - f.frontier_at))::numeric,
           -- GREATEST returns the largest NON-NULL argument, so an empty historian -- no manifest
           -- and no raw data -- reports 0 overdue rather than NULL, and the alert stays quiet on a
           -- stack that has never ingested anything.
           greatest(
               0::numeric,
               EXTRACT(EPOCH FROM (now() - f.frontier_at))::numeric
                 - (p.threshold_days::numeric * 86400)
           )
      FROM policy p, frontier f;
EXCEPTION
    -- The historian is unreachable, or its manifest has not been created yet. Both mean "this
    -- cannot be computed", which is not the same as zero and must not be reported as it.
    WHEN OTHERS THEN
        RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.cold_archive_backlog_state() IS
    'How far the cold archive has fallen behind, measured from the newest verified range_end over '
    'the FDW. Internal: EXECUTE is revoked, and the two wrappers gate it for their own audience.';

REVOKE ALL ON FUNCTION public.cold_archive_backlog_state() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. What the Cold Storage page reads
-- ---------------------------------------------------------------------------------------------
-- Gated on the same three roles as `cold_storage_rows()` and for the reason its comment gives: a
-- hidden tab is not a gate, and this function is SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.cold_archive_backlog()
RETURNS TABLE (
    enabled           boolean,
    threshold_days    integer,
    oldest_unexported timestamptz,
    age_seconds       numeric,
    overdue_seconds   numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
    SELECT b.enabled, b.threshold_days, b.oldest_unexported, b.age_seconds, b.overdue_seconds
      FROM public.cold_archive_backlog_state() b
     WHERE public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']);
$$;

COMMENT ON FUNCTION public.cold_archive_backlog() IS
    'The Cold Storage page''s header figure: when the unexported span begins, how old that is, and '
    'how far past archive.tier_after_days it has run. Up to one chunk interval overdue is normal.';

REVOKE ALL ON FUNCTION public.cold_archive_backlog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cold_archive_backlog() TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. The alert condition
-- ---------------------------------------------------------------------------------------------
-- COPIED FROM `0092`'S TEXT, NOT RETYPED, and extended. A condition dropped from this function does
-- not error: the rule reading it goes to NoData and the alarm simply stops existing. The self-check
-- below asserts every one of them still comes back.
CREATE OR REPLACE FUNCTION public.platform_health_rows() RETURNS TABLE(condition text, sparkplug_id text, subject text, value numeric, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    -- ---------------------------------------------------------------------------------------
    -- A gateway that has stopped heartbeating. Reads `gateway_status.is_stale` rather than
    -- re-deriving it: that view owns the 90s threshold. Archived gateways are excluded.
    -- ---------------------------------------------------------------------------------------
    SELECT 'gateway_stale'::text,
           g.sparkplug_id,
           g.name,
           g.heartbeat_age_seconds::numeric,
           format('%s has not reported for %s seconds', g.name, g.heartbeat_age_seconds)
      FROM public.gateway_status g
     WHERE g.is_stale
       AND NOT g.is_archived

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
    -- why zero is the answer that disables the alert rather than a gap in it.
    -- ---------------------------------------------------------------------------------------
    SELECT 'expected_publishers'::text,
           NULL::text,
           'fleet'::text,
           count(*)::numeric,
           format('%s device(s) registered, unarchived, unquarantined, and behind a gateway that '
                  'has reported at least once', count(*))
      FROM public.devices d
     WHERE NOT d.is_archived
       AND NOT d.is_quarantined
       AND d.gateway_id IS NOT NULL
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
             OR EXISTS (
                  SELECT 1 FROM public.gateways g
                   WHERE g.id = d.gateway_id
                     AND g.last_heartbeat IS NOT NULL
                )
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
$$;

-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_conditions text;
    v_rows       integer;
    v_backlog    record;
BEGIN
    -- THIS QUERY IS THE RESILIENCE TEST, not merely the inventory one, and it is the reason this
    -- block runs before anything else. db-init applies this chain against a database whose FDW may
    -- point at no historian at all -- every CI lane and the throwaway test database do exactly that
    -- -- so if the backlog arm raised on an unreachable server, `platform_health_rows()` would
    -- abort here and take the migration with it. It did, once. The arm now returns no row instead.
    --
    -- The two conditions that are emitted even at zero must also still come back, as `0092`
    -- asserts: this file must not have dropped one while copying the text.
    SELECT string_agg(DISTINCT condition, ',' ORDER BY condition) INTO v_conditions
      FROM public.platform_health_rows();

    IF v_conditions IS NULL
       OR position('expected_publishers' in v_conditions) = 0
       OR position('quarantine_depth' in v_conditions) = 0 THEN
        RAISE EXCEPTION
            '0133 self-check: platform_health_rows() emits [%], which is missing one of the two '
            'conditions it reports even at zero.', coalesce(v_conditions, 'nothing');
    END IF;

    -- ONE ROW OR NONE, never more: both wrappers and the alert arm read `last`, and a second row
    -- would make which of them wins a matter of scan order.
    SELECT count(*) INTO v_rows FROM public.cold_archive_backlog_state();
    IF v_rows > 1 THEN
        RAISE EXCEPTION
            '0133 self-check: cold_archive_backlog_state() returned % rows; it reports one state '
            'and must return one row, or none where the historian cannot be reached.', v_rows;
    END IF;

    IF v_rows = 0 THEN
        -- The ordinary case for a CI lane and the throwaway database, and it is not a failure.
        RAISE NOTICE
            '0133: the archive backlog cannot be computed here (no historian behind the FDW); the '
            'figure is absent and the health view is unaffected.';
    ELSE
        SELECT * INTO v_backlog FROM public.cold_archive_backlog_state();

        IF v_backlog.overdue_seconds IS NULL OR v_backlog.overdue_seconds < 0 THEN
            RAISE EXCEPTION
                '0133 self-check: overdue_seconds is %, which is neither zero nor positive.',
                coalesce(v_backlog.overdue_seconds::text, 'NULL');
        END IF;

        RAISE NOTICE
            '0133: the archive reports how far behind it is (% day(s) overdue, archiving %).',
            round(v_backlog.overdue_seconds / 86400.0, 1),
            CASE WHEN v_backlog.enabled THEN 'on' ELSE 'off' END;
    END IF;
END
$$;
