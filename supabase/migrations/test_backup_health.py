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
from psycopg2 import sql

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

    def test_each_row_carries_its_off_site_copy(self):
        # 0018: the prune deletes the copy with the files, so it needs to know where the copy is.
        for i, days in enumerate((20, 21, 22, 23)):
            self.backup(f"2026010{i + 1}T023000Z", days)
        self.cur.execute("UPDATE public.backups SET offsite_state = 'COPIED', "
                         "offsite_location = 'https://s3.example/b/p/' || stamp || '/'")
        self.cur.execute("SELECT id::text FROM public.backups WHERE stamp = '20260104T023000Z'")
        oldest = self.cur.fetchone()[0]
        self.cur.execute("SELECT public.backup_prunable(14)")
        self.assertEqual(self.cur.fetchone()[0], [{
            "id": oldest, "stamp": "20260104T023000Z", "location": "/backups/20260104T023000Z",
            "offsite_location": "https://s3.example/b/p/20260104T023000Z/",
        }])


# -------------------------------------------------------------------------------------------------
# The off-site copy (0018)
# -------------------------------------------------------------------------------------------------
# Pinned ids that differ early, and from every other suite's.
OFFSITE_ADMIN_ID = "a0ff5173-0000-4000-8000-0000000ad530"
OFFSITE_OPERATOR_ID = "b1ee6284-0000-4000-8000-00000000c530"
OFFSITE_KEYS = ("endpoint", "region", "bucket", "prefix", "access_key_id", "recipient", "path_style")
RECIPIENT = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
SECOND_RECIPIENT = "age1lggyhqrw2nlhcxprm67z43rta597azn8gknawjehu9d9dl0jq3yqqvfafg"
DESTINATION = {
    "p_endpoint": "https://s3.eu-west-2.amazonaws.com/", "p_region": "eu-west-2",
    "p_bucket": "aber-backups", "p_prefix": "site-a/backups", "p_access_key_id": "AKIAEXAMPLE",
    "p_recipient": RECIPIENT, "p_path_style": False,
}
BASE = "https://s3.eu-west-2.amazonaws.com/aber-backups/site-a/backups/"


def ensure_auth_user(cur, user_id):
    """An account for the fixture: the settings trigger writes changed_by = auth.uid() under a foreign key."""
    cur.execute(
        "INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, 'x') ON CONFLICT (id) DO NOTHING",
        (user_id, f"{user_id}@test.invalid"),
    )


def as_user(cur, user_id):
    cur.execute("SET LOCAL ROLE authenticated")
    cur.execute('SET LOCAL "request.jwt.claims" = %s', ('{"sub": "%s"}' % user_id,))


def as_service(cur):
    """Back to the migration's own session, which is the backup service's shape: no role set."""
    cur.execute("RESET ROLE")
    cur.execute('RESET "request.jwt.claims"')


class OffsiteFixture(unittest.TestCase):
    """An Administrator and an Operator, committed once; every test's own writes roll back."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.backup_offsite_destination()')")
                if cur.fetchone()[0] is None:
                    raise RuntimeError("backup_offsite_destination() is absent -- 0018 did not run.")
                cur.execute("SELECT id, name FROM public.roles WHERE name IN ('Administrator', 'Operator')")
                by_name = {name: rid for rid, name in cur.fetchall()}
                for user_id in (OFFSITE_ADMIN_ID, OFFSITE_OPERATOR_ID):
                    ensure_auth_user(cur, user_id)
                cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING",
                    (OFFSITE_ADMIN_ID, by_name["Administrator"], OFFSITE_OPERATOR_ID, by_name["Operator"]),
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
                cur.execute("DELETE FROM public.user_roles WHERE user_id IN %s", ((OFFSITE_ADMIN_ID, OFFSITE_OPERATOR_ID),))
                cur.execute("DELETE FROM auth.users WHERE id IN %s", ((OFFSITE_ADMIN_ID, OFFSITE_OPERATOR_ID),))
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("DELETE FROM public.backups")

    def tearDown(self):
        self.cur.close()
        self.conn.rollback()
        self.conn.close()

    def set_destination(self, **overrides):
        as_user(self.cur, OFFSITE_ADMIN_ID)
        args = {**DESTINATION, **overrides}
        self.cur.execute(
            "SELECT public.set_backup_offsite_destination(%(p_endpoint)s, %(p_region)s, %(p_bucket)s, "
            "%(p_prefix)s, %(p_access_key_id)s, %(p_recipient)s, %(p_path_style)s)", args)
        self.cur.execute("SELECT public.set_backup_offsite_credential('offsite-secret')")
        as_service(self.cur)

    def setting(self, key):
        self.cur.execute("SELECT value FROM public.system_settings WHERE key = %s", (f"backup_offsite.{key}",))
        return self.cur.fetchone()[0]

    def backup(self, stamp, hours_ago, **offsite):
        self.cur.execute(
            "INSERT INTO public.backups (stamp, origin, location, taken_at) "
            "VALUES (%s, 'scheduled', '/backups/' || %s, now() - make_interval(hours => %s))",
            (stamp, stamp, hours_ago),
        )
        for column, value in offsite.items():
            self.cur.execute(
                sql.SQL("UPDATE public.backups SET {} = %s WHERE stamp = %s").format(sql.Identifier(column)),
                (value, stamp),
            )


class TestOffsiteDestination(OffsiteFixture):
    """The destination is an Administrator's to see and set, checked on write, and its key write-only."""

    def test_every_field_is_administrator_only(self):
        self.cur.execute("SELECT count(*) FROM public.system_settings WHERE starts_with(key, 'backup_offsite.') AND sensitive")
        self.assertEqual(self.cur.fetchone()[0], len(OFFSITE_KEYS))
        as_user(self.cur, OFFSITE_OPERATOR_ID)
        self.cur.execute("SELECT count(*) FROM public.system_settings WHERE starts_with(key, 'backup_offsite.')")
        self.assertEqual(self.cur.fetchone()[0], 0)
        as_user(self.cur, OFFSITE_ADMIN_ID)
        self.cur.execute("SELECT count(*) FROM public.system_settings WHERE starts_with(key, 'backup_offsite.')")
        self.assertEqual(self.cur.fetchone()[0], len(OFFSITE_KEYS))

    def test_an_administrator_sets_it_in_one_call(self):
        self.set_destination()
        self.assertEqual(self.setting("bucket"), "aber-backups")
        self.assertEqual(self.setting("recipient"), RECIPIENT)
        self.assertIs(self.setting("path_style"), False)

    def test_an_operator_may_not(self):
        as_user(self.cur, OFFSITE_OPERATOR_ID)
        for call in ("SELECT public.set_backup_offsite_destination('https://x.example', 'r', 'bkt', 'p', 'k', '', false)",
                     "SELECT public.set_backup_offsite_credential('s')",
                     "SELECT public.clear_backup_offsite_destination()"):
            self.cur.execute("SAVEPOINT refused")
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege, msg=call):
                self.cur.execute(call)
            self.cur.execute("ROLLBACK TO SAVEPOINT refused")

    def test_a_value_the_service_could_not_use_is_refused_and_nothing_is_saved(self):
        for field, bad in (("p_endpoint", "minio:9000"), ("p_bucket", "Aber_Backups"),
                           ("p_prefix", "/site-a"), ("p_prefix", "site-a/"), ("p_region", "eu west"),
                           ("p_access_key_id", "has space"), ("p_recipient", "age1tooshort")):
            self.cur.execute("SAVEPOINT refused")
            with self.assertRaises(psycopg2.errors.CheckViolation, msg=f"{field}={bad!r}"):
                self.set_destination(**{field: bad})
            self.cur.execute("ROLLBACK TO SAVEPOINT refused")
            as_service(self.cur)
            self.assertEqual(self.setting("endpoint"), "", f"{field}={bad!r} saved the other fields")

    def test_several_recipients_are_one_setting(self):
        self.set_destination(p_recipient=f"{RECIPIENT} {SECOND_RECIPIENT}")
        self.cur.execute("SELECT public.backup_offsite_destination() -> 'recipients'")
        self.assertEqual(self.cur.fetchone()[0], [RECIPIENT, SECOND_RECIPIENT])

    def test_the_key_is_write_only(self):
        self.set_destination()
        as_user(self.cur, OFFSITE_ADMIN_ID)
        self.cur.execute("SELECT public.backup_offsite_credential_is_set()")
        self.assertIs(self.cur.fetchone()[0], True)
        as_user(self.cur, OFFSITE_OPERATOR_ID)
        self.cur.execute("SELECT public.backup_offsite_credential_is_set()")
        self.assertIs(self.cur.fetchone()[0], False)
        # The one function that returns it is the service's gate, which no PostgREST role may call.
        for role in ("authenticated", "service_role", "anon"):
            self.cur.execute("SELECT has_function_privilege(%s, 'public.backup_offsite_destination()', 'EXECUTE')", (role,))
            self.assertFalse(self.cur.fetchone()[0], role)

    def test_removing_it_empties_every_field_and_deletes_the_key(self):
        self.set_destination()
        as_user(self.cur, OFFSITE_ADMIN_ID)
        self.cur.execute("SELECT public.clear_backup_offsite_destination()")
        as_service(self.cur)
        self.assertEqual(self.setting("endpoint"), "")
        self.cur.execute("SELECT count(*) FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key'")
        self.assertEqual(self.cur.fetchone()[0], 0)
        self.cur.execute("SELECT public.backup_offsite_destination()")
        self.assertIsNone(self.cur.fetchone()[0])


class TestOffsiteGates(OffsiteFixture):
    """What the backup service reads and writes: the destination, the next backup, the result."""

    def next_stamp(self):
        self.cur.execute("SELECT public.backup_offsite_next() ->> 'stamp'")
        return self.cur.fetchone()[0]

    def test_no_destination_until_every_part_and_the_key_are_set(self):
        self.backup("20260920T023000Z", 1)
        self.cur.execute("SELECT public.backup_offsite_destination(), public.backup_offsite_next()")
        self.assertEqual(self.cur.fetchone(), (None, None))
        as_user(self.cur, OFFSITE_ADMIN_ID)
        self.cur.execute(
            "SELECT public.set_backup_offsite_destination(%(p_endpoint)s, %(p_region)s, %(p_bucket)s, "
            "%(p_prefix)s, %(p_access_key_id)s, %(p_recipient)s, %(p_path_style)s)", DESTINATION)
        as_service(self.cur)
        self.cur.execute("SELECT public.backup_offsite_destination()")
        self.assertIsNone(self.cur.fetchone()[0], "a destination without its secret key is not one")

    def test_the_destination_carries_the_key_and_where_copies_go(self):
        self.set_destination()
        self.cur.execute("SELECT public.backup_offsite_destination()")
        dest = self.cur.fetchone()[0]
        self.assertEqual(dest["base"], BASE)
        self.assertEqual(dest["endpoint"], "https://s3.eu-west-2.amazonaws.com")
        self.assertEqual(dest["secret_key"], "offsite-secret")
        self.assertEqual(dest["recipients"], [RECIPIENT])

    def test_the_newest_without_a_copy_goes_first(self):
        self.set_destination()
        self.backup("20260918T023000Z", 50)
        self.backup("20260919T023000Z", 26, offsite_state="COPIED", offsite_location=f"{BASE}20260919T023000Z/")
        self.backup("20260920T023000Z", 2)
        self.assertEqual(self.next_stamp(), "20260920T023000Z")

    def test_a_failed_copy_waits_its_backoff(self):
        self.set_destination()
        self.backup("20260919T023000Z", 26)
        self.backup("20260920T023000Z", 2)
        self.cur.execute("SELECT id FROM public.backups WHERE stamp = '20260920T023000Z'")
        newest = self.cur.fetchone()[0]
        self.cur.execute("SELECT public.backup_offsite_record(%s, NULL, NULL, 'aws s3api put-object: AccessDenied')", (newest,))
        self.assertEqual(self.next_stamp(), "20260919T023000Z", "a failure just recorded is not retried at once")
        # One failure waits a minute; three wait four.
        self.cur.execute("UPDATE public.backups SET offsite_attempted_at = now() - interval '61 seconds' WHERE id = %s", (newest,))
        self.assertEqual(self.next_stamp(), "20260920T023000Z")
        self.cur.execute("UPDATE public.backups SET offsite_attempts = 3 WHERE id = %s", (newest,))
        self.assertEqual(self.next_stamp(), "20260919T023000Z")
        self.cur.execute("UPDATE public.backups SET offsite_attempts = 40, offsite_attempted_at = now() - interval '15 minutes' WHERE id = %s", (newest,))
        self.assertEqual(self.next_stamp(), "20260920T023000Z", "the backoff stops growing at 15 minutes")

    def test_a_success_records_where_and_what_and_clears_the_failures(self):
        self.set_destination()
        self.backup("20260920T023000Z", 2, offsite_state="FAILED", offsite_attempts=4, offsite_error="timeout")
        self.cur.execute("SELECT id FROM public.backups")
        backup_id = self.cur.fetchone()[0]
        objects = '[{"file": "manifest.json", "key": "site-a/backups/20260920T023000Z/manifest.json.age", "size_bytes": 900, "sha256": "ab"}]'
        self.cur.execute("SELECT public.backup_offsite_record(%s, %s, %s::jsonb, NULL)", (backup_id, f"{BASE}20260920T023000Z/", objects))
        self.cur.execute("SELECT offsite_state, offsite_attempts, offsite_error, offsite_copied_at IS NOT NULL, "
                         "offsite_objects -> 0 ->> 'file' FROM public.backups")
        self.assertEqual(self.cur.fetchone(), ("COPIED", 0, None, True, "manifest.json"))
        self.assertIsNone(self.next_stamp())

    def test_a_copy_at_a_replaced_destination_is_made_again(self):
        self.set_destination()
        self.backup("20260920T023000Z", 2, offsite_state="COPIED", offsite_location="https://old.example/b/p/20260920T023000Z/")
        self.assertEqual(self.next_stamp(), "20260920T023000Z")

    def test_no_postgrest_role_reaches_the_gates(self):
        for fn in ("backup_offsite_base()", "backup_offsite_destination()", "backup_offsite_next()",
                   "backup_offsite_record(uuid, text, jsonb, text)"):
            for role in ("anon", "authenticated", "service_role"):
                self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE')", (role, f"public.{fn}"))
                self.assertFalse(self.cur.fetchone()[0], f"{role} may call {fn}")


class TestOffsiteHealth(OffsiteFixture):
    """What Off-site Backup Stale reads: how long the newest backup has gone without a copy."""

    VIEW = "public.backup_offsite_health"

    def rows(self):
        self.cur.execute("SELECT newest_stamp, offsite_state, age_seconds FROM public.backup_offsite_health")
        return self.cur.fetchall()

    def destination_changed(self, hours_ago):
        # Past the stamp trigger, which would set updated_at to now(); rolled back with the test.
        self.cur.execute("ALTER TABLE public.system_settings DISABLE TRIGGER system_settings_stamp_trg")
        self.cur.execute("UPDATE public.system_settings SET updated_at = now() - make_interval(hours => %s) "
                         "WHERE starts_with(key, 'backup_offsite.')", (hours_ago,))
        self.cur.execute("ALTER TABLE public.system_settings ENABLE TRIGGER system_settings_stamp_trg")

    def test_no_row_without_a_destination(self):
        self.backup("20260920T023000Z", 20)
        self.assertEqual(self.rows(), [])

    def test_no_row_without_a_backup(self):
        self.set_destination()
        self.assertEqual(self.rows(), [])

    def test_the_clock_is_when_the_newest_was_taken(self):
        self.set_destination()
        self.destination_changed(24 * 5)
        self.backup("20260919T023000Z", 44, offsite_state="COPIED", offsite_location=f"{BASE}20260919T023000Z/")
        self.backup("20260920T023000Z", 20)
        self.assertEqual(self.rows(), [("20260920T023000Z", "PENDING", 20 * HOUR)])

    def test_or_when_the_destination_changed_if_that_is_later(self):
        self.set_destination()
        self.destination_changed(1)
        self.backup("20260920T023000Z", 20)
        self.assertEqual(self.rows(), [("20260920T023000Z", "PENDING", 1 * HOUR)])

    def test_zero_once_copied_to_the_current_destination(self):
        self.set_destination()
        self.destination_changed(24 * 5)
        self.backup("20260920T023000Z", 20, offsite_state="COPIED", offsite_location=f"{BASE}20260920T023000Z/")
        self.assertEqual(self.rows(), [("20260920T023000Z", "COPIED", 0)])

    def test_a_copy_at_a_replaced_destination_does_not_count(self):
        self.set_destination()
        self.destination_changed(3)
        self.backup("20260920T023000Z", 20, offsite_state="COPIED", offsite_location="https://old.example/b/p/20260920T023000Z/")
        self.assertEqual(self.rows(), [("20260920T023000Z", "COPIED", 3 * HOUR)])

    def test_no_browser_role_reads_it(self):
        for role in ("anon", "authenticated"):
            self.cur.execute("SELECT has_table_privilege(%s, %s, 'SELECT')", (role, self.VIEW))
            self.assertFalse(self.cur.fetchone()[0], role)
            self.cur.execute("SELECT has_function_privilege(%s, 'public.backup_offsite_health_rows()', 'EXECUTE')", (role,))
            self.assertFalse(self.cur.fetchone()[0], role)

    def test_grafana_reader_reads_it(self):
        self.cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader'")
        if self.cur.fetchone() is None:
            self.skipTest("grafana_reader exists only where BI_READER_PASSWORD is set")
        self.cur.execute("SELECT has_table_privilege('grafana_reader', %s, 'SELECT'), "
                         "has_function_privilege('grafana_reader', 'public.backup_offsite_health_rows()', 'EXECUTE'), "
                         "has_table_privilege('grafana_reader', 'public.backups', 'SELECT')", (self.VIEW,))
        self.assertEqual(self.cur.fetchone(), (True, True, False))


if __name__ == "__main__":
    unittest.main()
