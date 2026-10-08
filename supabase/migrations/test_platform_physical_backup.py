"""
The platform database's physical backup (0173): its schedule rules, who may read and run them, and,
on a stack with supabaseDb.physicalBackup on, that a backup was taken and WAL reaches the repository.

    python supabase/migrations/test_platform_physical_backup.py

RUNS AGAINST THE SUPABASE DATABASE. ScheduleTestCase needs only the migrations, so it runs in the
db lane: the backup sidecar's two rules (a missed slot is taken late, once; a full on its weekday
or when the newest full is over seven days old), which 0173 declares with the historian's bodies,
the one-row schedule, platform_backup_state()'s Administrator gate, and the grants that keep the
API roles out. It asks about days in 2100, so no real run counts, and rolls back every row.

PhysicalBackupTestCase needs the stack: it skips while archive_mode is off (the chart's default;
the dev loop turns it on with a posix repository) and reads the repository through the sidecar with
kubectl. What it asserts is the chain an operator relies on: the run was recorded where Platform
Database Backup Stale reads, the repository agrees, and a WAL segment switched now is archived.
"""
import json
import os
import shutil
import subprocess
import time
import unittest
from datetime import datetime, timedelta, timezone

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
# supabase_admin: the sidecar's role, and the one that can read the runs past their RLS.
DB_USER = os.getenv("SUPABASE_DB_ADMIN_USER", "supabase_admin")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("POSTGRES_PASSWORD", "postgres"))
NAMESPACE = os.getenv("ABER_NAMESPACE", "aber")
WAIT = int(os.getenv("BACKUP_WAIT_SECONDS", "300"))


def connect():
    return psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)


def pgbackrest_info():
    out = subprocess.run(
        ["kubectl", "-n", NAMESPACE, "exec", "supabase-db-0", "-c", "pgbackrest", "--",
         "pgbackrest", "--stanza=platform", "--output=json", "info"],
        capture_output=True, text=True, timeout=120, check=True,
    ).stdout
    return json.loads(out)[0]


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


# A Wednesday, so fullOn 0 (Sunday) is not today's weekday rule.
TODAY = utc(2100, 1, 6)
assert TODAY.weekday() == 2


def info(*fulls_days_ago, diffs_days_ago=()):
    """`pgbackrest info --output=json` holding full and diff backups that stopped so long before TODAY."""
    backups = [{"type": t, "timestamp": {"stop": int((TODAY - timedelta(days=d)).timestamp())}}
               for t, days in (("full", fulls_days_ago), ("diff", diffs_days_ago)) for d in days]
    backups.sort(key=lambda b: b["timestamp"]["stop"])
    return json.dumps([{"name": "platform", "backup": backups}])


class ScheduleTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.conn = connect()
        with cls.conn.cursor() as cur:
            cur.execute("SELECT to_regprocedure('public.physical_backup_record_schedule(integer,integer)')")
            if cur.fetchone()[0] is None:
                raise RuntimeError("public.physical_backup_record_schedule() does not exist -- 0173 did not run.")
        cls.conn.rollback()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.cur.close()
        self.conn.rollback()

    def ran(self, kind, started, succeeded=True, finished=None, detail=None, label=None, repo_bytes=None):
        self.cur.execute(
            "INSERT INTO public.physical_backup_runs "
            "(kind, started_at, finished_at, succeeded, detail, label, repo_bytes) "
            "VALUES (%s, %s, coalesce(%s, %s), %s, %s, %s, %s)",
            (kind, started, finished, started, succeeded, detail, label, repo_bytes))

    def missed(self, now, hour=1):
        self.cur.execute("SELECT public.physical_backup_missed_slot(%s, %s)", (hour, now))
        return self.cur.fetchone()[0]

    def type_for(self, slot, repository, full_on=0):
        self.cur.execute("SELECT public.physical_backup_type(%s, %s, %s::jsonb, %s)",
                         (full_on, slot, repository, TODAY + timedelta(hours=9)))
        return self.cur.fetchone()[0]

    def as_role(self, role):
        """The Backups page's read, as a signed-in person holding `role` (None for no role)."""
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password) VALUES (gen_random_uuid(), %s, 'x') "
            "RETURNING id", (f"platform-backup-{role or 'none'}@test.invalid",))
        user = self.cur.fetchone()[0]
        if role:
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) "
                             "SELECT %s, id FROM public.roles WHERE name = %s", (user, role))
        self.cur.execute("SET LOCAL ROLE authenticated")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s', (json.dumps({"sub": str(user)}),))
        self.cur.execute("SELECT * FROM public.platform_backup_state()")
        cols = [d[0] for d in self.cur.description]
        rows = [dict(zip(cols, r)) for r in self.cur.fetchall()]
        self.cur.execute("RESET ROLE")
        return rows

    def test_a_start_before_the_hour_waits_for_it(self):
        self.ran("diff", utc(2100, 1, 5, 1, 0, 30))
        self.assertIsNone(self.missed(utc(2100, 1, 6, 0, 30)))

    def test_a_start_after_the_hour_without_one_takes_the_slot(self):
        self.ran("diff", utc(2100, 1, 5, 1, 0, 30))
        # The archive check at start is not a backup.
        self.ran("check", utc(2100, 1, 6, 2, 0))
        self.assertEqual(self.missed(utc(2100, 1, 6, 9, 0)), utc(2100, 1, 6, 1))

    def test_a_failed_run_is_the_slots_attempt(self):
        self.ran("diff", utc(2100, 1, 6, 1, 0, 20), succeeded=False)
        self.assertIsNone(self.missed(utc(2100, 1, 6, 9, 0)))

    def test_a_late_hour_reaches_back_across_midnight(self):
        self.assertEqual(self.missed(utc(2100, 1, 6, 0, 30), hour=23), utc(2100, 1, 5, 23))

    def test_a_differential_while_the_newest_full_is_recent(self):
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), info(3, diffs_days_ago=(2, 1))), "diff")

    def test_a_full_on_its_weekday(self):
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), info(1), full_on=3), "full")

    def test_an_overdue_full_is_taken_whatever_the_day(self):
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), info(8, diffs_days_ago=(2, 1))), "full")

    def test_a_repository_without_a_full_takes_one(self):
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), info()), "full")

    def test_an_unreadable_repository_keeps_the_weekday_rule(self):
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), "[]"), "diff")

    def test_a_run_is_recorded_as_pgbackrest_took_it(self):
        # A differential on an empty repository is the full it became, with its sizes.
        taken = json.dumps([{"name": "platform", "backup": [{
            "type": "full", "label": "21000106-010000F",
            "info": {"size": 4096, "repository": {"delta": 1024}}}]}])
        self.cur.execute("SELECT public.physical_backup_record('diff', %s, true, '', %s::jsonb)",
                         (utc(2100, 1, 6, 1), taken))
        self.cur.execute("SELECT kind, label, database_bytes, backup_bytes, repo_bytes "
                         "FROM public.physical_backup_runs ORDER BY id DESC LIMIT 1")
        self.assertEqual(self.cur.fetchone(), ("full", "21000106-010000F", 4096, 1024, 1024))

    def test_the_schedule_is_one_row_holding_the_latest(self):
        self.cur.execute("SELECT public.physical_backup_record_schedule(1, 0)")
        self.cur.execute("SELECT public.physical_backup_record_schedule(3, 6)")
        self.cur.execute("SELECT hour_utc, full_on FROM public.physical_backup_schedule")
        self.assertEqual(self.cur.fetchall(), [(3, 6)])

    def test_an_administrator_reads_the_last_success_and_a_newer_failure(self):
        self.cur.execute("DELETE FROM public.physical_backup_runs")
        self.cur.execute("SELECT public.physical_backup_record_schedule(1, 0)")
        self.ran("check", utc(2100, 1, 4, 0, 50))
        self.ran("full", utc(2100, 1, 4, 1), finished=utc(2100, 1, 4, 1, 5), label="F1", repo_bytes=10)
        self.ran("diff", utc(2100, 1, 5, 1), finished=utc(2100, 1, 5, 1, 1), succeeded=False, detail="unreachable")
        (row,) = self.as_role("Administrator")
        self.assertEqual((row["hour_utc"], row["full_on"]), (1, 0))
        self.assertEqual(row["first_recorded_at"], utc(2100, 1, 4, 0, 50))
        self.assertEqual(row["last_attempt_at"], utc(2100, 1, 5, 1))
        self.assertEqual((row["last_success_kind"], row["last_success_label"]), ("full", "F1"))
        self.assertEqual(row["last_full_at"], utc(2100, 1, 4, 1, 5))
        self.assertEqual(row["repo_bytes"], 10)
        self.assertEqual((row["last_failure_kind"], row["last_failure_detail"]), ("diff", "unreachable"))

    def test_a_failure_older_than_the_last_success_is_not_reported(self):
        self.cur.execute("DELETE FROM public.physical_backup_runs")
        self.ran("diff", utc(2100, 1, 4, 1), succeeded=False, detail="old")
        self.ran("diff", utc(2100, 1, 5, 1), label="D1")
        (row,) = self.as_role("Administrator")
        self.assertEqual(row["last_success_label"], "D1")
        self.assertIsNone(row["last_failure_at"])

    def test_an_administrator_gets_a_row_before_anything_is_recorded(self):
        # No row would read on the page as a database that cannot be read.
        self.cur.execute("DELETE FROM public.physical_backup_runs")
        self.cur.execute("DELETE FROM public.physical_backup_schedule")
        (row,) = self.as_role("Administrator")
        self.assertTrue(all(v is None for v in row.values()), row)

    def test_nobody_else_reads_the_state(self):
        self.ran("full", utc(2100, 1, 4, 1), label="F1")
        self.assertEqual(self.as_role("Auditor"), [])
        self.assertEqual(self.as_role(None), [])

    def test_the_api_roles_reach_nothing_but_the_state(self):
        for role in ("anon", "authenticated", "service_role"):
            for table in ("public.physical_backup_runs", "public.physical_backup_schedule"):
                self.cur.execute("SELECT has_table_privilege(%s, %s, 'SELECT, INSERT, UPDATE, DELETE')",
                                 (role, table))
                self.assertFalse(self.cur.fetchone()[0], f"{role} reaches {table}")
            for signature in ("public.physical_backup_record(text, timestamptz, boolean, text, jsonb)",
                              "public.physical_backup_missed_slot(integer, timestamptz)",
                              "public.physical_backup_type(integer, timestamptz, jsonb, timestamptz)",
                              "public.physical_backup_record_schedule(integer, integer)"):
                self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE')", (role, signature))
                self.assertFalse(self.cur.fetchone()[0], f"{role} may execute {signature}")
        self.cur.execute("SELECT has_function_privilege('anon', 'public.platform_backup_state()', 'EXECUTE')")
        self.assertFalse(self.cur.fetchone()[0])

    def test_the_exporter_reads_the_runs_through_pg_monitor(self):
        # metrics_reader exists only where databaseMetrics is on; pg_monitor is what it holds.
        self.ran("full", utc(2100, 1, 4, 1), label="F1")
        self.cur.execute("SET LOCAL ROLE pg_monitor")
        self.cur.execute("SELECT count(*) FROM public.physical_backup_runs WHERE label = 'F1'")
        self.assertEqual(self.cur.fetchone()[0], 1, "the policy hides the runs from pg_monitor")
        self.cur.execute("RESET ROLE")


class PhysicalBackupTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.conn = connect()
        cls.conn.autocommit = True
        with cls.conn.cursor() as cur:
            cur.execute("SELECT current_setting('archive_mode')")
            if cur.fetchone()[0] == "off":
                cls.conn.close()
                raise unittest.SkipTest("archive_mode is off: supabaseDb.physicalBackup is not enabled.")
        if shutil.which("kubectl") is None:
            cls.conn.close()
            raise unittest.SkipTest("kubectl is not on PATH; the repository is read through the sidecar.")

    @classmethod
    def tearDownClass(cls):
        conn = getattr(cls, "conn", None)
        if conn is not None:
            conn.close()

    def query(self, sql, *args):
        with self.conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()

    def test_a_backup_was_taken_and_recorded(self):
        deadline = time.time() + WAIT
        while True:
            rows = self.query(
                "SELECT label, database_bytes, backup_bytes FROM public.physical_backup_runs "
                "WHERE kind <> 'check' AND succeeded ORDER BY id DESC LIMIT 1")
            if rows or time.time() > deadline:
                break
            time.sleep(10)
        failures = self.query(
            "SELECT kind, detail FROM public.physical_backup_runs WHERE NOT succeeded "
            "ORDER BY id DESC LIMIT 3")
        self.assertTrue(
            rows,
            f"no successful backup recorded within {WAIT}s. Recent failures: {failures}. "
            f"kubectl -n {NAMESPACE} logs supabase-db-0 -c pgbackrest")
        label, database_bytes, backup_bytes = rows[0]
        self.assertGreater(database_bytes, 0)
        self.assertGreater(backup_bytes, 0)

        info_ = pgbackrest_info()
        self.assertEqual(info_["status"]["code"], 0, info_["status"]["message"])
        self.assertIn(label, [b["label"] for b in info_["backup"]])

    def test_a_switched_wal_segment_reaches_the_archive(self):
        (before,) = self.query("SELECT archived_count FROM pg_stat_archiver")[0]
        (segment,) = self.query("SELECT pg_walfile_name(pg_switch_wal())")[0]
        deadline = time.time() + 120
        while time.time() < deadline:
            archived, last, failed_at, archived_at = self.query(
                "SELECT archived_count, last_archived_wal, last_failed_time, last_archived_time "
                "FROM pg_stat_archiver")[0]
            if archived > before and last is not None and last >= segment:
                break
            time.sleep(2)
        self.assertGreater(archived, before, "no WAL segment was archived within two minutes")
        self.assertGreaterEqual(last, segment)
        if failed_at is not None:
            self.assertGreater(archived_at, failed_at, "archiving failed after its last success")

    def test_the_server_is_not_pid_1(self):
        # tini is: an orphaned archive-push that fails would otherwise read as a crashed backend.
        out = subprocess.run(
            ["kubectl", "-n", NAMESPACE, "exec", "supabase-db-0", "-c", "supabase-db", "--",
             "cat", "/proc/1/comm"], capture_output=True, text=True, timeout=60, check=True).stdout.strip()
        self.assertEqual(out, "tini")


if __name__ == "__main__":
    import sys
    result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
