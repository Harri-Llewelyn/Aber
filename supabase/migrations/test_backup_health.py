"""
How long since the platform backup last succeeded (0011).

`backup_health` is what the Grafana rule "Backup Stale" reads. Four properties, each of which
would fail quietly:

- No row while no job has ever been recorded, or every stack without the backup service would
  alert 36 hours after install.
- Before the first success the clock is the first job recorded, so a service that queued a job and
  never ran it is reported rather than read as "nothing to say".
- After that the clock is the start of the last COMPLETED job: a later failure or cancellation
  does not reset it.
- anon and authenticated cannot read it. It runs as its owner, past backup_jobs' Administrator-only
  RLS, so a grant to either would publish the backup history to every signed-in user.

And the retention floor (0017): `backup_prunable()` never returns any of the newest three backups,
pinned or not, so a run of failures longer than the window cannot prune the last good one.

Every write is rolled back. Runs against the Supabase database, not the historian:

    python supabase/migrations/test_backup_health.py
"""
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

VIEW = "public.backup_health"
HOUR = 3600


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


class TestBackupHealth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()
        cls.conn.autocommit = False
        with cls.conn.cursor() as cur:
            cur.execute("SELECT to_regclass(%s)", (VIEW,))
            if cur.fetchone()[0] is None:
                raise RuntimeError(f"{VIEW} does not exist -- 0011 did not run.")
        cls.conn.rollback()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        # A known history: none. now() is the transaction's start, so ages below are exact.
        self.cur = self.conn.cursor()
        self.cur.execute("DELETE FROM public.backup_jobs")

    def tearDown(self):
        self.cur.close()
        self.conn.rollback()

    def job(self, status, created_hours_ago, started_hours_ago=None, finished_hours_ago=None):
        self.cur.execute(
            """
            INSERT INTO public.backup_jobs (origin, status, created_at, started_at, finished_at)
            VALUES ('scheduled', %s,
                    now() - make_interval(hours => %s),
                    now() - make_interval(hours => %s),
                    now() - make_interval(hours => %s))
            """,
            (status, created_hours_ago, started_hours_ago, finished_hours_ago),
        )

    def rows(self):
        self.cur.execute("SELECT last_success_at IS NOT NULL, age_seconds FROM public.backup_health")
        return self.cur.fetchall()

    def test_no_row_while_no_job_has_been_recorded(self):
        self.assertEqual(self.rows(), [])

    def test_before_the_first_success_the_clock_is_the_first_job(self):
        self.job("FAILED", 40, 40, 40)
        # Queued ten hours ago and never claimed: what a stopped service leaves.
        self.job("PENDING", 10)
        self.assertEqual(self.rows(), [(False, 40 * HOUR)])

    def test_the_clock_is_the_start_of_the_last_success(self):
        self.job("COMPLETED", 50, 50, 49)
        self.job("COMPLETED", 26, 26, 25)
        self.job("FAILED", 2, 2, 1)
        self.assertEqual(self.rows(), [(True, 26 * HOUR)])

    def test_a_later_failure_or_cancellation_does_not_reset_the_clock(self):
        self.job("COMPLETED", 40, 40, 39)
        self.job("CANCELLED", 20, None, 20)
        self.job("FAILED", 3, 3, 2)
        self.job("RUNNING", 1, 1)
        self.assertEqual(self.rows(), [(True, 40 * HOUR)])

    def test_no_browser_role_can_read_it(self):
        for role in ("anon", "authenticated"):
            self.cur.execute("SELECT has_table_privilege(%s, %s, 'SELECT')", (role, VIEW))
            self.assertFalse(self.cur.fetchone()[0], f"{role} can read {VIEW}")
        self.cur.execute("SELECT has_table_privilege('service_role', %s, 'SELECT')", (VIEW,))
        self.assertTrue(self.cur.fetchone()[0])

    def test_it_runs_as_its_owner(self):
        # security_invoker would evaluate backup_jobs' RLS as grafana_reader, which sees nothing.
        self.cur.execute(
            "SELECT coalesce(reloptions::text, '') FROM pg_class WHERE oid = %s::regclass", (VIEW,)
        )
        self.assertNotIn("security_invoker=true", self.cur.fetchone()[0])

    def test_grafana_reader_reads_the_view_and_not_the_table(self):
        self.cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader'")
        if self.cur.fetchone() is None:
            self.skipTest("grafana_reader exists only where BI_READER_PASSWORD is set")
        self.cur.execute("SELECT has_table_privilege('grafana_reader', %s, 'SELECT')", (VIEW,))
        self.assertTrue(self.cur.fetchone()[0])
        self.cur.execute("SELECT has_table_privilege('grafana_reader', 'public.backup_jobs', 'SELECT')")
        self.assertFalse(self.cur.fetchone()[0])


class TestRetentionFloor(unittest.TestCase):
    """backup_prunable() never returns any of the newest three backups (0017)."""

    WINDOW_DAYS = 14

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()
        cls.conn.autocommit = False

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()
        self.cur.execute("DELETE FROM public.backups")

    def tearDown(self):
        self.cur.close()
        self.conn.rollback()

    def backup(self, stamp, days_ago, pinned=False):
        self.cur.execute(
            """
            INSERT INTO public.backups (stamp, origin, location, pinned, taken_at)
            VALUES (%s, %s, '/backups/' || %s, %s, now() - make_interval(days => %s))
            """,
            (stamp, "requested" if pinned else "scheduled", stamp, pinned, days_ago),
        )

    def prunable(self, days=WINDOW_DAYS):
        self.cur.execute("SELECT public.backup_prunable(%s)", (days,))
        return [row["stamp"] for row in self.cur.fetchone()[0]]

    def test_four_past_the_window_return_only_the_oldest(self):
        # Two weeks and more of failures: nothing newer than these four exists.
        for i, days in enumerate((20, 21, 22, 23)):
            self.backup(f"2026010{i + 1}T023000Z", days)
        self.assertEqual(self.prunable(), ["20260104T023000Z"])

    def test_three_past_the_window_are_all_kept(self):
        for i, days in enumerate((30, 31, 32)):
            self.backup(f"2026010{i + 1}T023000Z", days)
        self.assertEqual(self.prunable(), [])

    def test_newer_backups_fill_the_floor_first(self):
        self.backup("20260110T023000Z", 1)
        self.backup("20260109T023000Z", 2)
        for i, days in enumerate((20, 21, 22)):
            self.backup(f"2026010{i + 1}T023000Z", days)
        # The floor is the two recent ones and the newest old one; oldest first.
        self.assertEqual(self.prunable(), ["20260103T023000Z", "20260102T023000Z"])

    def test_a_pinned_backup_counts_toward_the_floor(self):
        self.backup("20260110T023000Z", 10, pinned=True)
        for i, days in enumerate((20, 21, 22, 23)):
            self.backup(f"2026010{i + 1}T023000Z", days)
        # Pinned and inside the window, and still one of the three: only two old ones share the floor.
        self.assertEqual(self.prunable(), ["20260104T023000Z", "20260103T023000Z"])

    def test_zero_days_still_disables_pruning(self):
        for i, days in enumerate((20, 21, 22, 23, 24)):
            self.backup(f"2026010{i + 1}T023000Z", days)
        self.assertEqual(self.prunable(0), [])


if __name__ == "__main__":
    unittest.main()
