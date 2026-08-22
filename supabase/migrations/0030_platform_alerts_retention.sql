-- =============================================================================================
-- Migration: 0030_platform_alerts_retention.sql
-- A retention window for alert occurrences, and the one row it must never delete
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHY ALERTS GET DELETED RATHER THAN ARCHIVED.
--
-- `platform_alerts` is the second unbounded append-only table in this database, and it grows on
-- PLANT activity rather than operator activity -- every firing and every resolving instance the
-- Grafana webhook posts. `digital_thread` is the other, and the two get opposite answers on
-- purpose:
--
--   digital_thread    partition, then tier out. The platform's stated value is a permanent audit
--                     trail, so nothing may be destroyed casually.
--   platform_alerts   delete. NOTHING READS A HISTORICAL ALERT -- the dashboard reads
--                     `platform_alerts_active`, which is DISTINCT ON (fingerprint) filtered to
--                     `status = 'firing'`; no Grafana dashboard queries this table at all; and the
--                     Realtime subscription wants change EVENTS, not persistence.
--
-- And an alert row is DERIVED. The telemetry that breached the threshold is retained
-- independently in the historian under its own retention policy, so deleting the alert destroys
-- no unique fact -- the evidence for it outlives it.
--
-- ---------------------------------------------------------------------------------------------
-- THE TRAP THIS FUNCTION EXISTS TO AVOID, AND IT IS THE WHOLE REASON THE PREDICATE IS NOT ONE LINE.
--
-- The obvious implementation is wrong:
--
--     DELETE FROM public.platform_alerts WHERE recorded_at < now() - interval '7 days';  -- NO
--
-- `recorded_at` is stamped DEFAULT now() on the FIRST write and is NEVER REFRESHED. The webhook
-- upserts on (fingerprint, starts_at) and its payload does not include `recorded_at`, so the
-- conflict-update leaves the original value in place. Grafana's `repeat_interval: 12h`
-- re-notification therefore rewrites the row's status and summary but not its AGE.
--
-- So an alert that has been firing continuously for more than the window has exactly one row, and
-- that row is older than the cutoff. The naive delete removes the CURRENT STATE of a live alert:
-- `platform_alerts_active` then returns nothing, the alert pill disappears, the device stops being
-- painted red -- and Grafana still has the alert firing. The dashboard would assert that something
-- is healthy when it is not, silently, with no error anywhere.
--
-- That is not hypothetical. `Enrolment Stuck` fires after one hour of AWAITING_BIRTH and stays
-- firing until a human acts; `Gateway Stale` fires on any appliance that is off and not archived.
-- Both sit firing for weeks on a demonstrator.
--
-- ---------------------------------------------------------------------------------------------
-- SO THE PREDICATE AGES OUT HISTORY, NOT STATE.
--
-- Two disjoint classes, and neither can reach the newest row of a fingerprint that is firing:
--
--   1. CLOSED occurrences, measured from `ends_at` -- when the alert ENDED, not when it was first
--      seen. A firing row has no `ends_at` and cannot match.
--   2. SUPERSEDED occurrences: an older occurrence of a fingerprint that has since fired again.
--      `platform_alerts_active` already ignores these, and age is safe to apply because a newer
--      row exists by definition.
--
-- A row that is the newest for its fingerprint and still `firing` matches neither, at any age.
--
-- WHAT THIS DELIBERATELY DOES NOT BOUND. A fingerprint stuck `firing` forever -- a rule deleted in
-- Grafana, a resolve that never arrived -- is kept forever, and that is correct: it is the current
-- recorded state, and the view's own header calls out the missed-resolve case. Growth is still
-- bounded in practice, because the number of DISTINCT fingerprints is bounded by rules x instances
-- rather than by time. A stuck row is a data-quality problem to surface, not one to delete.
-- =============================================================================================

SET check_function_bodies = false;


-- ---------------------------------------------------------------------------------------------
-- 1. The predicate, as a function
-- ---------------------------------------------------------------------------------------------
-- A FUNCTION RATHER THAN SQL INLINED IN THE CRON COMMAND, for three reasons that all come back to
-- the trap above: the predicate is testable directly (test_platform_alerts_retention.py calls this,
-- not cron), it exists in exactly one place, and it returns a count so a run is observable in
-- `cron.job_run_details` instead of being silent.
--
-- THE DEFAULT ARGUMENT IS THE SINGLE SOURCE OF THE WINDOW. `check-docs-drift.mjs` reads the
-- interval literal out of this signature and asserts the documentation says the same number, so
-- the window cannot be retuned here and left stale in README.md.
CREATE OR REPLACE FUNCTION public.prune_platform_alerts(p_retain interval DEFAULT interval '7 days')
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
    v_cutoff  timestamptz := now() - p_retain;
    v_deleted integer;
BEGIN
    DELETE FROM public.platform_alerts a
     WHERE
           -- 1. Closed, and closed long enough ago. `platform_alerts_resolved_has_end` guarantees
           -- a resolved row carries `ends_at`, so this arm cannot silently skip rows on a NULL.
           (a.status = 'resolved' AND a.ends_at < v_cutoff)

           -- 2. Superseded by a later occurrence of the same fingerprint.
           --
           -- THE COMPARISON MIRRORS `platform_alerts_active`'s OWN ORDER BY -- (starts_at DESC,
           -- recorded_at DESC) -- rather than inventing a second definition of "newest". If the
           -- view's ordering ever changes, this must change with it, and stating it as the same
           -- tuple is what makes that visible. (In practice `uq_platform_alerts_event` makes
           -- `starts_at` unique per fingerprint, so the tiebreaker never decides anything; it is
           -- here so the two definitions cannot diverge, not because it is reachable.)
           OR (a.recorded_at < v_cutoff
               AND EXISTS (
                   SELECT 1
                     FROM public.platform_alerts n
                    WHERE n.fingerprint = a.fingerprint
                      AND (n.starts_at, n.recorded_at) > (a.starts_at, a.recorded_at)
               ));

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$fn$;

COMMENT ON FUNCTION public.prune_platform_alerts(interval) IS
  'Delete alert occurrences older than the retention window, EXCEPT the newest occurrence of any '
  'fingerprint -- so an alert that has been firing longer than the window is never removed while '
  'it is still the current state. Returns the number of rows deleted. Scheduled as '
  'prune_platform_alerts; see the migration header for why the obvious one-line predicate is wrong.';

-- NOT CALLABLE FROM THE BROWSER, and not by the webhook's key either. PostgreSQL grants EXECUTE on
-- a new function to PUBLIC by default, so silence here would make a delete-many function reachable
-- by every signed-in user. `service_role` is revoked too: the webhook writes occurrences and has no
-- business removing them, and 0026 set the precedent that a privileged key held by several
-- services is not a reason to let it do everything.
REVOKE ALL ON FUNCTION public.prune_platform_alerts(interval)
  FROM PUBLIC, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 2. The schedule
-- ---------------------------------------------------------------------------------------------
-- `ensure_cron_job` unschedules before scheduling, which is what makes this survive the every-boot
-- replay -- `cron.schedule` appends rather than replaces. Same helper the three janitorial jobs in
-- 0002 use.
--
-- DAILY, AND NOT IN 0002's ARCHIVE-RETENTION JOB. That job honours a per-row `auto_delete_at` the
-- user chose in the Archive dialog; this is a fixed platform policy. Merging an operator's explicit
-- choice with a constant would make both harder to reason about, and the Archive dialog's promise
-- ("Purges: <date>") is a promise about a date the user picked.
--
-- 03:15, between `prune_cron_history` (03:00) and `purge_expired_archives` (03:30). Deliberately
-- not concurrent with either: `platform_alerts` is REPLICA IDENTITY FULL and in the
-- `supabase_realtime` publication, so every deleted row travels the WAL at full width and reaches
-- every connected dashboard as a delete event. That is survivable -- `usePlatformAlerts` debounces
-- 250ms, so a burst collapses into one refetch, and a day's worth of occurrences is tens of rows,
-- not thousands -- but it is a reason to run this once a day at 3am rather than hourly.
--
-- No VACUUM afterwards. At this volume autovacuum reclaims the space on its own schedule, and a
-- VACUUM scheduled here would be a second thing to reason about for no measurable gain. If the
-- `alerts` tier in `public.storage_footprint` (0027) ever shows the table holding size after a
-- prune, that is the signal to revisit -- and that view exists precisely so the question is
-- answerable from a dashboard rather than by guessing.
SELECT public.ensure_cron_job(
  'prune_platform_alerts',
  '15 3 * * *',
  $job$SELECT public.prune_platform_alerts()$job$
);


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_schedule text;
    v_kept     integer;
BEGIN
    SELECT schedule INTO v_schedule FROM cron.job WHERE jobname = 'prune_platform_alerts';
    IF v_schedule IS NULL THEN
        RAISE EXCEPTION
          '0030 self-check: prune_platform_alerts is not scheduled, so the retention window is '
          'documented but never applied.';
    END IF;

    -- THE INVARIANT, EXERCISED RATHER THAN ASSERTED. A stale firing alert is fabricated well
    -- outside the window, the real function is run against it, and it must survive. Asserting the
    -- predicate by reading it would pass against exactly the naive version this migration exists
    -- to avoid.
    --
    -- Inside a subtransaction so the fixture never commits: this table is published to Realtime,
    -- and a scratch row that escaped would reach every connected dashboard as a firing alert.
    BEGIN
        -- `ends_at` is set IN THE INSERT, not by a follow-up UPDATE:
        -- `platform_alerts_resolved_has_end` rejects a resolved row that does not carry one, so a
        -- two-step fixture fails at the first step.
        INSERT INTO public.platform_alerts
            (fingerprint, entity_type, sparkplug_id, alert_name, severity, status,
             summary, starts_at, ends_at, recorded_at)
        VALUES
            ('0030-selfcheck-stale', 'platform', NULL, 'Self Check', 'info', 'firing',
             'fixture', now() - interval '400 days', NULL, now() - interval '400 days'),
            ('0030-selfcheck-closed', 'platform', NULL, 'Self Check', 'info', 'resolved',
             'fixture', now() - interval '400 days', now() - interval '399 days',
             now() - interval '400 days');

        -- Cost note: this prunes the WHOLE table and then discards the result with the
        -- subtransaction, so a boot pays for one scan of whatever is past the cutoff. That is
        -- bounded by the retention policy itself -- after the first scheduled run it is nothing --
        -- and the backlog is left for 03:15 to clear rather than being deleted by a migration.
        PERFORM public.prune_platform_alerts();

        SELECT count(*) INTO v_kept
          FROM public.platform_alerts
         WHERE fingerprint = '0030-selfcheck-stale';

        IF v_kept <> 1 THEN
            RAISE EXCEPTION
              '0030 self-check: a 400-day-old FIRING alert was deleted by the retention prune. '
              'That is the failure this migration exists to prevent -- the dashboard would report '
              'healthy while Grafana still had the alert firing.';
        END IF;

        IF EXISTS (SELECT 1 FROM public.platform_alerts
                    WHERE fingerprint = '0030-selfcheck-closed') THEN
            RAISE EXCEPTION
              '0030 self-check: a 399-day-old RESOLVED alert survived the prune, so the retention '
              'window is not being applied at all.';
        END IF;

        -- Unwind the fixture. RAISE inside the block would also do it, but only on failure; the
        -- passing path has to clean up after itself explicitly.
        RAISE EXCEPTION USING ERRCODE = 'restrict_violation', MESSAGE = '0030-selfcheck-rollback';
    EXCEPTION
        WHEN restrict_violation THEN
            NULL;  -- expected: the fixture is discarded with the subtransaction
    END;

    RAISE NOTICE
      '0030 self-check passed: retention scheduled at %, and a 400-day-old firing alert survives '
      'the prune while a resolved one does not.', v_schedule;
END;
$selfcheck$;
