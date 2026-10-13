-- 0182: The Playback gateway is never reported stale.
--
-- platform_health_rows()'s gateway_stale arm reads gateway_status.is_stale, which is heartbeat age
-- alone, and Grafana's Gateway Stale rule fires on any row it emits. Archived migration 0061
-- excluded shadow gateways from that arm: nothing publishes as the Playback gateway between
-- playbacks, so its silence is the design. Archived migration 0074 redeclared the function without
-- the exclusion, and the baseline carries that form. Since every replay ends with an NDEATH, which
-- writes last_heartbeat, the rule fired for Playback about six minutes after each one.
-- check-docs-drift check 71 holds the last declaration to the exclusion.

-- -------------------------------------------------------------------------------------------------
-- platform_health_rows(): the shadow exclusion, back in the gateway_stale arm
-- -------------------------------------------------------------------------------------------------
-- 0001's body unchanged but for that line and its comment. CREATE OR REPLACE keeps 0001's grants:
-- service_role, and grafana_reader from 0001's last block.
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

ALTER FUNCTION public.platform_health_rows() OWNER TO postgres;

COMMENT ON FUNCTION public.platform_health_rows() IS 'One row per platform condition worth alerting on: stale gateways, stuck enrolments, the quarantine queue depth, and how many devices are expected to be publishing. SECURITY DEFINER so the Grafana reader needs no privilege on gateways or devices -- it emits a count and, where the condition names an asset, that asset''s wire id, and nothing else about it. Shadow gateways are outside gateway_stale (0182): nothing publishes as one between playbacks, so its silence is not a fault.';

-- -------------------------------------------------------------------------------------------------
-- Self-check: the arm excludes shadow gateways, and still emits every other stale gateway. The
-- source test holds on a fresh install, where no gateway is stale; the comparison is one statement,
-- so a heartbeat written meanwhile cannot make the two sides disagree.
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_arm      text;
  v_shadows  text;
  v_missing  text;
BEGIN
  v_arm := substring(
    (SELECT prosrc FROM pg_proc WHERE oid = 'public.platform_health_rows()'::regprocedure)
    FROM '''gateway_stale''::text.*?UNION ALL');
  IF v_arm IS NULL OR v_arm !~ 'AND NOT g\.is_shadow' THEN
    RAISE EXCEPTION '0182: platform_health_rows()''s gateway_stale arm does not exclude shadow gateways';
  END IF;

  SELECT string_agg(h.subject, ', ' ORDER BY h.subject) FILTER (WHERE g.is_shadow),
         string_agg(s.name, ', ' ORDER BY s.name) FILTER (WHERE h.sparkplug_id IS NULL)
    INTO v_shadows, v_missing
    FROM (SELECT * FROM public.platform_health_rows() WHERE condition = 'gateway_stale') h
    LEFT JOIN public.gateways g ON g.sparkplug_id = h.sparkplug_id
    FULL JOIN (SELECT sparkplug_id, name FROM public.gateway_status
                WHERE is_stale AND NOT is_archived AND NOT is_shadow) s
      ON s.sparkplug_id = h.sparkplug_id;
  IF v_shadows IS NOT NULL THEN
    RAISE EXCEPTION '0182: shadow gateway(s) [%] are reported as gateway_stale', v_shadows;
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '0182: stale gateway(s) [%] are missing from gateway_stale', v_missing;
  END IF;
END
$$;
