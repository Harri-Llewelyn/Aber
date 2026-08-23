-- =============================================================================================
-- Migration: 0032_alert_retention_setting.sql
-- The alert retention window becomes a setting, and settings gain a range
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS ONE FIRST, of everything roadmap item 7 could surface.
--
-- THE POINT IS READING IT, NOT ONLY SETTING IT. `0030` put the window in the default argument of
-- `prune_platform_alerts()`, so an administrator asking "how long do we keep alerts" has to open a
-- migration or a README to find out -- and the person accountable for that answer is not usually
-- the person with a shell on the machine. Surfacing it puts the answer on a page. Being able to
-- change it is the smaller half.
--
-- IT IS ALSO THE FIRST BACKEND READER. Everything consuming `system_settings` until now is React.
-- This reader is SQL in the same database, which is the cheapest possible place to prove the
-- pattern works outside the browser -- no new transport, no credential, no restart.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A RANGE HAD TO COME WITH IT, AND WHY IT IS A COLUMN RATHER THAN A CHECK ON THIS ONE KEY.
--
-- `system_settings` enforced the TYPE of a value and nothing about its magnitude. A retention of
-- `0` is a number, so the table would have taken it, the page would have said saved, and the next
-- nightly run would have deleted every alert in the database. A negative one is worse in the same
-- direction.
--
-- The alternative was to defend inside `prune_platform_alerts()` -- clamp the value, warn, carry
-- on. That is the shape this repository keeps rejecting: the write SUCCEEDS, the page reports
-- success, and the setting silently does not mean what it says. Refusing at the constraint is the
-- only version where the operator finds out, and the Settings page already surfaces the database's
-- own message rather than flattening it to "Save failed".
--
-- GENERIC, because the next numeric setting has the same problem and would otherwise each grow
-- their own bespoke CHECK. Meaningful only for `value_type = 'number'`; NULL means unbounded,
-- which is the correct default for a setting whose sensible range nobody has thought about yet.
--
-- ---------------------------------------------------------------------------------------------
-- WHY `seed_setting()` IS NOT EXTENDED to take the bounds.
--
-- Adding parameters would create an OVERLOAD rather than replace the function: `CREATE OR REPLACE`
-- matches on the argument list, so a nine-argument version would sit beside the seven-argument one
-- that `0031` recreates on every single boot. Dropping the old one here does not help either --
-- `0031` replays first and builds it again. Two functions with one name, one of them reachable
-- only by accident, is a worse outcome than one plain UPDATE.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Bounds on a numeric setting
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.system_settings ADD COLUMN IF NOT EXISTS min_value numeric;
ALTER TABLE public.system_settings ADD COLUMN IF NOT EXISTS max_value numeric;

COMMENT ON COLUMN public.system_settings.min_value IS
    'Inclusive lower bound for a number setting. NULL means unbounded. Enforced by CHECK, not by '
    'the reader: a value the table accepts and the consumer then ignores is a setting that lies.';
COMMENT ON COLUMN public.system_settings.max_value IS
    'Inclusive upper bound for a number setting. NULL means unbounded.';

-- DROPPED AND RECREATED rather than added conditionally, because this file is replayed on every
-- boot and `ADD CONSTRAINT` is not idempotent. The pair is cheap and leaves no room for a stale
-- definition to survive a change to the predicate.
ALTER TABLE public.system_settings DROP CONSTRAINT IF EXISTS system_settings_value_within_bounds;
ALTER TABLE public.system_settings ADD CONSTRAINT system_settings_value_within_bounds CHECK (
    value_type <> 'number'
    OR (
        (min_value IS NULL OR (value #>> '{}')::numeric >= min_value)
        AND
        (max_value IS NULL OR (value #>> '{}')::numeric <= max_value)
    )
);

-- ---------------------------------------------------------------------------------------------
-- 2. The setting
-- ---------------------------------------------------------------------------------------------
SELECT public.seed_setting(
    'alerts.retention_days',
    to_jsonb(7),
    'number',
    'Retention',
    'Alert history kept for (days)',
    'How long a resolved or superseded alert occurrence is kept before the nightly prune removes '
    'it. The telemetry that triggered the alert is retained separately under the historian''s own '
    'policy, so shortening this destroys no measurement -- only the record that a threshold was '
    'crossed. A currently firing alert is never removed however old it is.',
    'the p_retain default in prune_platform_alerts()'
);

-- MIN 1, NOT 0. Zero would mean "delete every alert on the next run", which is a thing an operator
-- might type meaning "keep none going forward" and would not expect to apply retroactively.
-- Ten years is not a real ceiling, it is a typo guard: 36500 entered instead of 3650 is the
-- difference between a decade and a century, and neither is a number anyone reasons about.
UPDATE public.system_settings
   SET min_value = 1, max_value = 3650
 WHERE key = 'alerts.retention_days'
   AND (min_value IS DISTINCT FROM 1 OR max_value IS DISTINCT FROM 3650);

-- ---------------------------------------------------------------------------------------------
-- 3. The reader
-- ---------------------------------------------------------------------------------------------
-- THREE FALLS, AND EACH ONE IS REACHABLE.
--
--   1. An explicit argument wins. `prune_platform_alerts(interval '400 days')` is how the test
--      suite drives this without touching a shared row, and it must keep working.
--   2. Then the setting, which is the point of this migration.
--   3. Then the literal, because a database mid-replay may not have the row yet -- 0031 seeds it
--      and 0032 declares this one, so there is a window during a FIRST boot where this function
--      exists and the row does not. Pruning nothing would be safe; pruning with a NULL interval
--      would delete rows at `now() - NULL`, which is no rows at all, silently. The literal makes
--      the ordinary case ordinary.
--
-- READ WITHOUT RLS INTERFERING because the nightly job runs as the table owner, for whom row
-- level security is not enforced. That is worth stating rather than discovering: were this ever
-- invoked as `authenticated`, the SELECT would still succeed -- 0031 grants every authenticated
-- user SELECT on settings deliberately -- so the fall-through is not load bearing for permissions.
CREATE OR REPLACE FUNCTION public.prune_platform_alerts(p_retain interval DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
    v_days    numeric;
    v_retain  interval;
    v_cutoff  timestamptz;
    v_deleted integer;
BEGIN
    IF p_retain IS NULL THEN
        SELECT (value #>> '{}')::numeric INTO v_days
          FROM public.system_settings
         WHERE key = 'alerts.retention_days';

        -- `make_interval(days => numeric)` does not exist -- the days argument is an integer and
        -- the overload resolution fails rather than rounding. Seconds takes a double, which is
        -- why 0030 used this form and why it is kept.
        v_retain := COALESCE(make_interval(secs => v_days::double precision * 86400.0),
                             interval '7 days');
    ELSE
        v_retain := p_retain;
    END IF;

    v_cutoff := now() - v_retain;

    DELETE FROM public.platform_alerts a
     WHERE
        -- Closed, and old enough. `ends_at` is when it stopped firing, which is the only honest
        -- age for a resolved occurrence.
        (a.status = 'resolved' AND a.ends_at < v_cutoff)
        -- Or superseded: an older occurrence of the same fingerprint that a newer one replaced.
        -- THE NEWEST ROW OF A FINGERPRINT IS NEVER MATCHED HERE, which is what keeps a long-firing
        -- alert alive past the window -- `recorded_at` is stamped once and never refreshed, so a
        -- flat age cutoff would delete the CURRENT STATE of a live alert and the dashboard pill
        -- would vanish while Grafana still had it firing.
        OR (a.recorded_at < v_cutoff
            AND EXISTS (SELECT 1 FROM public.platform_alerts n
                         WHERE n.fingerprint = a.fingerprint
                           AND (n.starts_at, n.recorded_at) > (a.starts_at, a.recorded_at)));

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.prune_platform_alerts(interval)
    FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_days     numeric;
    v_survived boolean;
BEGIN
    SELECT (value #>> '{}')::numeric INTO v_days
      FROM public.system_settings WHERE key = 'alerts.retention_days';
    IF v_days IS NULL THEN
        RAISE EXCEPTION '0032 self-check: alerts.retention_days was not seeded.';
    END IF;

    -- THE BOUND, EXERCISED RATHER THAN TRUSTED, in a subtransaction so the failure does not abort
    -- the migration. Zero is the value that matters: it is a number, the type CHECK would pass it,
    -- and the next nightly run would empty the table.
    BEGIN
        UPDATE public.system_settings SET value = to_jsonb(0) WHERE key = 'alerts.retention_days';
        RAISE EXCEPTION
          '0032 self-check: a retention of 0 days was accepted. The bounds CHECK is not doing '
          'anything, and the next prune would delete every alert in the database.';
    EXCEPTION
        WHEN check_violation THEN NULL;   -- expected
    END;

    -- THE INVARIANT 0030 EXISTS FOR, RE-ASSERTED THROUGH THE NEW READER. A long-firing alert must
    -- survive its own age. Fabricated and rolled back so the running stack is untouched.
    BEGIN
        -- Column list copied from 0030's self-check rather than written from memory: `alert_name`
        -- is NOT NULL and was missing on the first attempt, which failed the whole migration.
        INSERT INTO public.platform_alerts
            (fingerprint, entity_type, sparkplug_id, alert_name, severity, status,
             summary, starts_at, ends_at, recorded_at)
        VALUES
            ('selfcheck-0032', 'platform', NULL, 'Self Check', 'info', 'firing',
             'fixture', now() - interval '400 days', NULL, now() - interval '400 days');

        PERFORM public.prune_platform_alerts();

        SELECT EXISTS (SELECT 1 FROM public.platform_alerts WHERE fingerprint = 'selfcheck-0032')
          INTO v_survived;

        IF NOT v_survived THEN
            RAISE EXCEPTION
              '0032 self-check: a 400-day-old FIRING alert was deleted. Reading the window from a '
              'setting must not have changed the predicate -- the newest row of a fingerprint is '
              'never superseded, however old it is.';
        END IF;

        RAISE EXCEPTION 'rollback_selfcheck';
    EXCEPTION
        WHEN raise_exception THEN
            IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
    END;

    RAISE NOTICE '0032 self-check passed: retention is % day(s), bounded, and a firing alert '
                 'still survives its own age.', v_days;
END;
$selfcheck$;
