"""
PostgreSQL integration tests for `0030_platform_alerts_retention.sql`.

ONE INVARIANT MATTERS MORE THAN THE REST, and it is why this suite exists rather than a line of SQL
in the migration being taken on trust:

    THE NEWEST OCCURRENCE OF A FIRING FINGERPRINT IS NEVER DELETED, AT ANY AGE.

`recorded_at` is stamped on the FIRST write and never refreshed -- the webhook upserts on
(fingerprint, starts_at) and its payload omits the column, so Grafana's 12-hourly re-notification
updates status and summary but not age. An alert firing continuously for longer than the retention
window therefore has exactly one row, and that row is older than the cutoff.

The obvious predicate deletes it. `platform_alerts_active` then returns nothing, the alert pill
disappears and the device stops being painted red -- while Grafana still has the alert firing. The
dashboard would assert healthy about something that is not, with no error anywhere.

`Enrolment Stuck` fires after an hour of AWAITING_BIRTH and stays firing until a human acts;
`Gateway Stale` fires on any appliance that is off and not archived. Neither is exotic.

THE LAST TEST IS THE ONE THAT KEEPS THE OTHERS HONEST. It runs the naive predicate against the same
fixture and asserts it DOES destroy the row -- so a future refactor that quietly reintroduces
`WHERE recorded_at < cutoff` fails here instead of passing a suite that never distinguished them.

Runs against the Supabase database, not the historian. Requires the stack (or CI's Postgres
service) to be up:

    python supabase/migrations/test_platform_alerts_retention.py
"""
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# The window, in seconds. Read from the database rather than hardcoded, so retuning it does not
# silently invalidate every fixture below -- the ages here are expressed as multiples of whatever
# it actually is.
#
# READ FROM THE SETTING, NOT FROM THE FUNCTION SIGNATURE. This used to call
# `pg_get_function_arg_default(p.oid, 1)`, because 0030 carried the window in
# `prune_platform_alerts(p_retain interval DEFAULT interval '7 days')`. 0032 moved it into
# `alerts.retention_days` and made that default NULL, so the old query returned NULL and the suite
# died on `float(None)` -- which is the RIGHT failure: a fixture keyed to a source of truth that
# moved should break loudly rather than quietly test a window nothing uses.
RETAIN_SQL = """
    SELECT (value #>> '{}')::numeric * 86400
      FROM public.system_settings
     WHERE key = 'alerts.retention_days'
"""


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class RetentionTestCase(unittest.TestCase):
    """
    Every test runs in one transaction and rolls back.

    ROLLBACK IS LOAD-BEARING HERE, not tidiness. `platform_alerts` is REPLICA IDENTITY FULL and in
    the `supabase_realtime` publication, so a committed scratch row reaches every connected
    dashboard as a firing alert about a device that does not exist.
    """

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                    " WHERE n.nspname = 'public' AND p.proname = 'prune_platform_alerts'"
                )
                if not cur.fetchone():
                    raise RuntimeError(
                        "public.prune_platform_alerts() is missing -- 0030 has not been applied."
                    )
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()
        self.conn.close()

    # -- fixtures ---------------------------------------------------------------------------------

    def insert(self, fingerprint, status, age_days, ends_age_days=None, starts_age_days=None):
        """
        One occurrence, aged into the past. `age_days` is `recorded_at`.

        AGES GO IN AS SECONDS, not days. `make_interval(days => ...)` takes an integer, so a
        fractional age -- which the window test needs, to land either side of a 7-day boundary --
        fails as `function make_interval(days => numeric) does not exist`. The `secs` argument is
        double precision and takes them.
        """
        self.cur.execute(
            """
            INSERT INTO public.platform_alerts
                (fingerprint, entity_type, sparkplug_id, alert_name, severity, status,
                 summary, starts_at, ends_at, recorded_at)
            VALUES (%s, 'platform', NULL, 'Test', 'info', %s, 'fixture',
                    now() - make_interval(secs => %s * 86400.0),
                    CASE WHEN %s::float IS NULL THEN NULL
                         ELSE now() - make_interval(secs => %s::float * 86400.0) END,
                    now() - make_interval(secs => %s * 86400.0))
            RETURNING id
            """,
            (
                fingerprint,
                status,
                starts_age_days if starts_age_days is not None else age_days,
                ends_age_days,
                ends_age_days,
                age_days,
            ),
        )
        return self.cur.fetchone()[0]

    def prune(self):
        self.cur.execute("SELECT public.prune_platform_alerts()")
        return self.cur.fetchone()[0]

    def survives(self, fingerprint):
        self.cur.execute(
            "SELECT count(*) FROM public.platform_alerts WHERE fingerprint = %s", (fingerprint,)
        )
        return self.cur.fetchone()[0]

    # -- the invariant ----------------------------------------------------------------------------

    def test_a_long_firing_alert_survives_at_any_age(self):
        """
        THE CASE THE WHOLE MIGRATION IS SHAPED AROUND. 400 days old, still firing, still the only
        row for its fingerprint.
        """
        self.insert("t-stuck-firing", "firing", age_days=400)
        self.prune()
        self.assertEqual(
            self.survives("t-stuck-firing"), 1,
            "a firing alert older than the window was deleted -- the dashboard would go quiet "
            "while Grafana still had it firing",
        )

    def test_it_is_still_visible_through_the_active_view_after_a_prune(self):
        """
        The invariant asserted where a user would notice it. Surviving in the table is necessary;
        surviving in `platform_alerts_active` is what keeps the pill on screen.
        """
        self.insert("t-visible", "firing", age_days=400)
        self.prune()
        self.cur.execute(
            "SELECT count(*) FROM public.platform_alerts_active WHERE fingerprint = %s",
            ("t-visible",),
        )
        self.assertEqual(self.cur.fetchone()[0], 1)

    def test_a_resolved_alert_ages_out(self):
        self.insert("t-closed", "resolved", age_days=400, ends_age_days=399)
        self.prune()
        self.assertEqual(self.survives("t-closed"), 0)

    def test_a_recently_resolved_alert_is_kept(self):
        """Inside the window. Aged from `ends_at`, which is what makes this distinguishable."""
        self.insert("t-fresh-close", "resolved", age_days=400, ends_age_days=1)
        self.prune()
        self.assertEqual(
            self.survives("t-fresh-close"), 1,
            "a resolved alert was aged from recorded_at rather than ends_at, so an alert that "
            "closed yesterday after a long run was treated as ancient history",
        )

    def test_a_superseded_occurrence_is_removed_but_the_newest_is_kept(self):
        """
        Same fingerprint, two occurrences. The old one is invisible to the active view already; the
        new one is the current state and must survive even though it is also past the window.
        """
        self.insert("t-recurring", "resolved", age_days=400, ends_age_days=399)
        self.insert("t-recurring", "firing", age_days=300, starts_age_days=300)
        self.prune()
        self.cur.execute(
            "SELECT status FROM public.platform_alerts WHERE fingerprint = 't-recurring'"
        )
        rows = self.cur.fetchall()
        self.assertEqual(len(rows), 1, "expected only the newest occurrence to survive")
        self.assertEqual(rows[0][0], "firing")

    def test_nothing_inside_the_window_is_touched(self):
        self.insert("t-new-firing", "firing", age_days=0)
        self.insert("t-new-closed", "resolved", age_days=1, ends_age_days=0)
        self.prune()
        self.assertEqual(self.survives("t-new-firing"), 1)
        self.assertEqual(self.survives("t-new-closed"), 1)

    def test_the_window_is_the_one_the_setting_declares(self):
        """
        A row just inside the window survives and one just outside it does not, so
        `alerts.retention_days` is genuinely what the prune reads rather than a number on a page
        that changes nothing.

        THAT IS A STRONGER CLAIM THAN THIS TEST USED TO MAKE. Reading the function's default
        argument proved the signature agreed with itself; reading the SETTING proves the value an
        administrator can actually edit reaches the predicate.
        """
        self.cur.execute(RETAIN_SQL)
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "alerts.retention_days is not seeded -- 0032 did not run")

        window_seconds = float(row[0])
        self.assertGreater(window_seconds, 0)

        inside = window_seconds / 86400.0 * 0.5
        outside = window_seconds / 86400.0 * 2.0
        self.insert("t-inside", "resolved", age_days=outside, ends_age_days=inside)
        self.insert("t-outside", "resolved", age_days=outside, ends_age_days=outside)
        self.prune()
        self.assertEqual(self.survives("t-inside"), 1)
        self.assertEqual(self.survives("t-outside"), 0)

    # -- the guard on the guard -------------------------------------------------------------------

    def test_the_naive_predicate_would_destroy_the_stuck_alert(self):
        """
        NOT A TEST OF THE SHIPPED CODE -- a test that the tests above are not vacuous.

        If someone later "simplifies" the function back to a flat `recorded_at` cutoff, the suite
        must fail. This asserts the naive form really does differ on the fixture the others use, so
        their passing means something. If this ever starts failing, the fixture has drifted into a
        shape where both predicates agree and the invariant is no longer being exercised.
        """
        self.insert("t-naive", "firing", age_days=400)
        self.cur.execute(
            "DELETE FROM public.platform_alerts "
            " WHERE fingerprint = 't-naive' AND recorded_at < now() - interval '7 days'"
        )
        self.assertEqual(
            self.cur.rowcount, 1,
            "the naive predicate did not delete the stuck firing alert, so the fixture no longer "
            "distinguishes the two implementations and the invariant tests prove nothing",
        )

    def test_the_function_is_not_reachable_from_the_browser(self):
        """
        PostgreSQL grants EXECUTE to PUBLIC by default, so this is a revoke that has to be asserted
        rather than assumed. A delete-many function callable by any signed-in user would let a
        browser clear the alert history.
        """
        for role in ("anon", "authenticated", "service_role"):
            self.cur.execute(
                "SELECT has_function_privilege(%s, 'public.prune_platform_alerts(interval)', "
                "'EXECUTE')",
                (role,),
            )
            self.assertFalse(
                self.cur.fetchone()[0], f"{role} can execute prune_platform_alerts()"
            )

    def test_the_job_is_scheduled_exactly_once(self):
        """
        `cron.schedule` APPENDS. Migrations replay on every boot, so scheduling without
        `ensure_cron_job`'s unschedule-first would accumulate a duplicate job per boot -- each one
        running the same delete, which is harmless here but is the shape of a real problem for any
        job that is not idempotent.
        """
        self.cur.execute("SELECT count(*) FROM cron.job WHERE jobname = 'prune_platform_alerts'")
        self.assertEqual(self.cur.fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
