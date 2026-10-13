"""
The Backups page's stat strip (0179): backup_summary() and the backup service's report.

- backup_summary() is an Administrator's, as the tables it reads are: anybody else is refused with
  the code PostgREST answers 403.
- Its figures: successes out of the runs that ended in the last 30 days (a cancelled run never ran),
  the last success on backup_health's clock, the median of the last 14 completed runs and no older
  one, the backups held and their bytes, the oldest restorable point, the newest backup's size, and
  the newest copy off site, at the current destination once one is set.
- backup_report() is a backup_* gate: the service's own connection and no API role. It keeps one
  row, and a figure statfs could not give stays NULL rather than reading as a full disk.

Every write is rolled back. Runs against the Supabase database, not the historian:

    python supabase/migrations/test_backup_summary.py
"""
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Pinned ids that differ EARLY: a generated id derived from these has limited width.
ADMIN_ID = "c3793793-0000-4000-8000-0000000000ad"
OPERATOR_ID = "d4804804-0000-4000-8000-00000000009e"

DESTINATION = {
    "p_endpoint": "https://s3.eu-west-2.amazonaws.com",
    "p_region": "eu-west-2",
    "p_bucket": "aber-backups",
    "p_prefix": "site-a/backups",
    "p_access_key_id": "AKIAEXAMPLEONLY",
    "p_recipient": "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
    "p_path_style": False,
}
BASE = "https://s3.eu-west-2.amazonaws.com/aber-backups/site-a/backups/"


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


def ensure_auth_user(cur, user_id):
    """An auth.users row, which the audit trigger's foreign key needs; savepointed per attempt."""
    for statement, args in (
        ("INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, 'x') ON CONFLICT (id) DO NOTHING",
         (user_id, f"{user_id}@test.invalid")),
        ("INSERT INTO auth.users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING", (user_id,)),
    ):
        try:
            cur.execute("SAVEPOINT au")
            cur.execute(statement, args)
            cur.execute("RELEASE SAVEPOINT au")
            return
        except psycopg2.Error:
            cur.execute("ROLLBACK TO SAVEPOINT au")
    raise RuntimeError(f"could not create auth user {user_id}")


def as_user(cur, user_id):
    """Become `authenticated` with a JWT subject, the way PostgREST does: claims only."""
    cur.execute("SET LOCAL ROLE authenticated")
    cur.execute('SET LOCAL "request.jwt.claims" = %s', ('{"sub": "%s"}' % user_id,))


def as_service(cur):
    """The suite's own session: no role set, which is the backup service's shape."""
    cur.execute("RESET ROLE")
    cur.execute('RESET "request.jwt.claims"')


class BackupSummary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.backup_summary()')")
                if cur.fetchone()[0] is None:
                    raise RuntimeError("backup_summary() is absent -- 0179 did not run.")
                cur.execute("SELECT id, name FROM public.roles WHERE name IN ('Administrator', 'Operator')")
                by_name = {name: rid for rid, name in cur.fetchall()}
                for user_id in (ADMIN_ID, OPERATOR_ID):
                    ensure_auth_user(cur, user_id)
                cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING",
                    (ADMIN_ID, by_name["Administrator"], OPERATOR_ID, by_name["Operator"]),
                )
            conn.commit()
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls):
        conn = get_connection()
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM public.user_roles WHERE user_id IN %s", ((ADMIN_ID, OPERATOR_ID),))
                cur.execute("DELETE FROM auth.users WHERE id IN %s", ((ADMIN_ID, OPERATOR_ID),))
        finally:
            conn.close()

    def setUp(self):
        # A known history: none, no report and no off-site destination. Rolled back after.
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("DELETE FROM public.backups")
        self.cur.execute("DELETE FROM public.backup_jobs")
        self.cur.execute("DELETE FROM public.backup_service_report")
        self.cur.execute("DELETE FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key'")

    def tearDown(self):
        self.cur.close()
        self.conn.rollback()
        self.conn.close()

    def summary(self):
        as_user(self.cur, ADMIN_ID)
        self.cur.execute("SELECT public.backup_summary()")
        value = self.cur.fetchone()[0]
        as_service(self.cur)
        return value

    def job(self, status, ended_days_ago, minutes=10):
        """A finished run that took `minutes` and ended `ended_days_ago` days ago."""
        self.cur.execute(
            """
            INSERT INTO public.backup_jobs (origin, status, created_at, started_at, finished_at)
            VALUES ('scheduled', %(status)s,
                    now() - make_interval(days => %(days)s, mins => %(mins)s + 1),
                    CASE WHEN %(status)s = 'CANCELLED' THEN NULL
                         ELSE now() - make_interval(days => %(days)s, mins => %(mins)s) END,
                    now() - make_interval(days => %(days)s))
            """,
            {"status": status, "days": ended_days_ago, "mins": minutes},
        )

    def backup(self, stamp, days_ago, size, **offsite):
        self.cur.execute(
            "INSERT INTO public.backups (stamp, origin, location, taken_at, size_bytes) "
            "VALUES (%s, 'scheduled', '/backups/' || %s, now() - make_interval(days => %s), %s)",
            (stamp, stamp, days_ago, size),
        )
        if offsite:
            self.cur.execute(
                "UPDATE public.backups SET offsite_state = 'COPIED', offsite_location = %s, "
                "offsite_copied_at = now() WHERE stamp = %s",
                (offsite["location"], stamp),
            )

    # -- who may read it -------------------------------------------------------------------------

    def test_an_operator_is_refused_with_the_code_postgrest_answers_403(self):
        as_user(self.cur, OPERATOR_ID)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as raised:
            self.cur.execute("SELECT public.backup_summary()")
        self.assertEqual(raised.exception.pgcode, "42501")

    def test_only_authenticated_may_call_it_and_no_api_role_reaches_the_report(self):
        checks = [
            ("anon", "has_function_privilege", "public.backup_summary()", "EXECUTE", False),
            ("service_role", "has_function_privilege", "public.backup_summary()", "EXECUTE", False),
            ("authenticated", "has_function_privilege", "public.backup_summary()", "EXECUTE", True),
        ]
        for role in ("anon", "authenticated", "service_role"):
            checks.append((role, "has_function_privilege", "public.backup_report(bigint, bigint, text)", "EXECUTE", False))
            checks.append((role, "has_table_privilege", "public.backup_service_report", "SELECT", False))
        for role, probe, target, privilege, expected in checks:
            with self.subTest(role=role, target=target):
                if probe == "has_table_privilege":
                    self.cur.execute("SELECT has_table_privilege(%s, %s, %s)", (role, target, privilege))
                else:
                    self.cur.execute("SELECT has_function_privilege(%s, %s, %s)", (role, target, privilege))
                self.assertIs(self.cur.fetchone()[0], expected)

    # -- the figures ------------------------------------------------------------------------------

    def test_a_stack_with_no_backups_reads_as_empty_not_as_zero_failures(self):
        s = self.summary()
        self.assertIsNone(s["first_recorded_at"])
        self.assertIsNone(s["last_success"])
        self.assertEqual((s["runs_30d"], s["succeeded_30d"]), (0, 0))
        self.assertIsNone(s["median_duration_seconds"])
        self.assertEqual((s["backups_held"], s["bytes_held"]), (0, 0))
        self.assertIsNone(s["oldest_taken_at"])
        self.assertIsNone(s["newest_offsite"])
        self.assertIsNone(s["service"])

    def test_successes_count_the_runs_that_ended_in_30_days_and_not_a_cancelled_one(self):
        for days in (1, 2, 3, 5, 8):
            self.job("COMPLETED", days)
        self.job("FAILED", 4)
        self.job("FAILED", 6)
        self.job("CANCELLED", 7)
        self.job("FAILED", 40)
        self.job("COMPLETED", 45)
        s = self.summary()
        self.assertEqual((s["succeeded_30d"], s["runs_30d"]), (5, 7))

    def test_the_last_success_and_the_latest_outcome(self):
        self.job("COMPLETED", 3, minutes=20)
        self.job("COMPLETED", 2, minutes=25)
        self.job("FAILED", 1)
        s = self.summary()
        self.assertEqual(s["last_success"]["status"], "COMPLETED")
        self.assertAlmostEqual(float(s["last_success"]["duration_seconds"]), 25 * 60, places=3)
        self.assertEqual(s["latest_outcome"]["status"], "FAILED")
        self.assertIsNotNone(s["first_recorded_at"])

    def test_the_median_is_of_the_last_14_completed_runs_only(self):
        # Fourteen recent runs of 10 to 23 minutes, and two older ones of ten hours that would move
        # the median if they were counted.
        for i in range(14):
            self.job("COMPLETED", i + 1, minutes=10 + i)
        self.job("COMPLETED", 20, minutes=600)
        self.job("COMPLETED", 21, minutes=600)
        self.job("FAILED", 0, minutes=900)
        s = self.summary()
        self.assertEqual(s["median_runs"], 14)
        self.assertAlmostEqual(float(s["median_duration_seconds"]), 16.5 * 60, places=3)

    def test_what_the_volume_holds_and_how_far_back_a_restore_goes(self):
        self.backup("20260901T023000Z", 10, 1000)
        self.backup("20260905T023000Z", 6, 2000)
        self.backup("20260910T023000Z", 1, 4000)
        s = self.summary()
        self.assertEqual((s["backups_held"], s["bytes_held"], s["newest_size_bytes"]), (3, 7000, 4000))
        self.cur.execute("SELECT to_jsonb(min(taken_at)) #>> '{}' FROM public.backups")
        self.assertEqual(s["oldest_taken_at"], self.cur.fetchone()[0])

    def test_the_newest_copy_off_site_is_at_the_current_destination_once_one_is_set(self):
        self.backup("20260901T023000Z", 10, 1, location=f"{BASE}20260901T023000Z/")
        self.backup("20260905T023000Z", 6, 1, location="https://old.example/b/p/20260905T023000Z/")
        self.backup("20260910T023000Z", 1, 1)
        s = self.summary()
        # No destination: any copy counts, as the page's Off site column has it.
        self.assertFalse(s["offsite_destination_set"])
        self.assertEqual(s["newest_offsite"]["stamp"], "20260905T023000Z")
        as_user(self.cur, ADMIN_ID)
        self.cur.execute(
            "SELECT public.set_backup_offsite_destination(%(p_endpoint)s, %(p_region)s, %(p_bucket)s, "
            "%(p_prefix)s, %(p_access_key_id)s, %(p_recipient)s, %(p_path_style)s)", DESTINATION)
        self.cur.execute("SELECT public.set_backup_offsite_credential('summary-test-key')")
        as_service(self.cur)
        s = self.summary()
        self.assertTrue(s["offsite_destination_set"])
        self.assertEqual(s["newest_offsite"]["stamp"], "20260901T023000Z")

    # -- the service's report --------------------------------------------------------------------

    def test_the_service_reports_through_its_gate_and_one_row_is_kept(self):
        as_service(self.cur)
        self.cur.execute("SELECT public.backup_report(%s, %s, %s)", (5 * 2**30, 100 * 2**30, " 30 2 * * * "))
        self.cur.execute("SELECT public.backup_report(%s, %s, %s)", (4 * 2**30, 100 * 2**30, "30 2 * * *"))
        self.cur.execute("SELECT count(*) FROM public.backup_service_report")
        self.assertEqual(self.cur.fetchone()[0], 1)
        service = self.summary()["service"]
        self.assertEqual(service["volume_free_bytes"], 4 * 2**30)
        self.assertEqual(service["volume_total_bytes"], 100 * 2**30)
        self.assertEqual(service["schedule"], "30 2 * * *")
        self.assertIsNotNone(service["reported_at"])

    def test_a_figure_statfs_could_not_give_stays_null(self):
        as_service(self.cur)
        self.cur.execute("SELECT public.backup_report(NULL, -1, '')")
        service = self.summary()["service"]
        self.assertIsNone(service["volume_free_bytes"])
        self.assertIsNone(service["volume_total_bytes"])
        self.assertEqual(service["schedule"], "")

    def test_an_administrator_cannot_write_the_report(self):
        as_user(self.cur, ADMIN_ID)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.backup_report(1, 2, 'x')")


if __name__ == "__main__":
    unittest.main(verbosity=2)
