"""
The historian's physical backup is running: a backup was taken and WAL reaches the repository.

    python timescaledb/test_physical_backup.py

RUNS AGAINST THE HISTORIAN (port 5433), like the other suites here, and reads the repository
through the backup sidecar with kubectl. Skips when timescaledb.physicalBackup is off (archive_mode
off), which is the chart's default; the dev loop turns it on with a posix repository.

The sidecar takes a full backup as soon as the server is up on a repository holding none, so a
freshly installed stack has one within minutes; the suite waits up to BACKUP_WAIT_SECONDS for it.
What it asserts is the chain an operator relies on: the run was recorded (the Historian Backup
Stale alert reads that table), the repository agrees, and a WAL segment switched now arrives in the
archive, which is what makes a restore reach past the backup. A backup asked for from the Backups
page is taken once, by the sidecar's minute loop, and recorded.

ScheduleTestCase is that loop's rules: when a slot is due (a missed one is taken late, once), which
type it takes, one waiting request claimed once, and the schedule the page reads. It needs only
physical_backup.sql, so it runs whether or not physical backup is on; it asks about days in 2100,
so no real run counts, and rolls back every row.
"""
import json
import os
import shutil
import subprocess
import time
import unittest
from datetime import datetime, timedelta, timezone

import psycopg2

DB_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("TS_TEST_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
NAMESPACE = os.getenv("ABER_NAMESPACE", "aber")
WAIT = int(os.getenv("BACKUP_WAIT_SECONDS", "300"))


def pgbackrest_info():
    out = subprocess.run(
        ["kubectl", "-n", NAMESPACE, "exec", "timescaledb-0", "-c", "pgbackrest", "--",
         "pgbackrest", "--stanza=historian", "--output=json", "info"],
        capture_output=True, text=True, timeout=120, check=True,
    ).stdout
    return json.loads(out)[0]


class PhysicalBackupTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not DB_PASSWORD:
            raise unittest.SkipTest("DB_PASSWORD is unset; run this through `npm run dev:test`.")
        cls.conn = psycopg2.connect(
            host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
        )
        cls.conn.autocommit = True
        with cls.conn.cursor() as cur:
            cur.execute("SELECT current_setting('archive_mode')")
            if cur.fetchone()[0] == "off":
                cls.conn.close()
                raise unittest.SkipTest("archive_mode is off: timescaledb.physicalBackup is not enabled.")
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
            f"kubectl -n {NAMESPACE} logs timescaledb-0 -c pgbackrest")
        label, database_bytes, backup_bytes = rows[0]
        self.assertGreater(database_bytes, 0)
        self.assertGreater(backup_bytes, 0)

        # The repository agrees with the record.
        info = pgbackrest_info()
        self.assertEqual(info["status"]["code"], 0, info["status"]["message"])
        self.assertIn(label, [b["label"] for b in info["backup"]])

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

    def test_a_requested_backup_is_taken_once_and_recorded(self):
        # Asked the way the backup service asks, through the superuser-only gate; the sidecar's
        # minute loop claims it and takes a differential.
        (request,) = self.query("SELECT public.physical_backup_request('test_physical_backup.py')")[0]
        deadline = time.time() + WAIT
        answer = []
        while time.time() < deadline:
            (claimed,) = self.query(
                "SELECT claimed_at FROM public.physical_backup_requests WHERE id = %s", request)[0]
            if claimed is not None:
                answer = self.query(
                    "SELECT id, kind, succeeded, detail FROM public.physical_backup_runs "
                    "WHERE kind <> 'check' AND finished_at >= %s ORDER BY finished_at", claimed)
                if answer:
                    break
            time.sleep(5)
        self.assertTrue(answer, f"request {request} was not answered within {WAIT}s. "
                                f"kubectl -n {NAMESPACE} logs timescaledb-0 -c pgbackrest")
        _, kind, succeeded, detail = answer[0]
        self.assertTrue(succeeded, detail)
        self.assertIn(kind, ("diff", "full"))

        # Once: a minute's step later nothing more was taken for it, and nothing waits.
        time.sleep(70)
        runs = self.query("SELECT count(*) FROM public.physical_backup_runs "
                          "WHERE kind <> 'check' AND finished_at >= %s", claimed)[0][0]
        self.assertEqual(runs, 1, "the request was taken more than once")
        self.assertEqual(self.query(
            "SELECT count(*) FROM public.physical_backup_requests WHERE claimed_at IS NULL")[0][0], 0)

    def test_the_exporter_role_can_read_the_record(self):
        rows = self.query(
            "SELECT has_table_privilege('metrics_reader', 'public.physical_backup_runs', 'SELECT'), "
            "has_function_privilege('metrics_reader', "
            "'public.physical_backup_record(text, timestamptz, boolean, text, jsonb)', 'EXECUTE')")
        can_read, can_write = rows[0]
        self.assertTrue(can_read, "the Historian Backup Stale alert reads this table as metrics_reader")
        self.assertFalse(can_write, "only the superuser records a run")


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
    return json.dumps([{"name": "historian", "backup": backups}])


class ScheduleTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not DB_PASSWORD:
            raise unittest.SkipTest("DB_PASSWORD is unset; run this through `npm run dev:test`.")
        cls.conn = psycopg2.connect(
            host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
        )

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.cur.close()
        self.conn.rollback()

    def ran(self, kind, started, succeeded=True):
        self.cur.execute(
            "INSERT INTO public.physical_backup_runs (kind, started_at, succeeded) VALUES (%s, %s, %s)",
            (kind, started, succeeded))

    def missed(self, now, hour=1):
        self.cur.execute("SELECT public.physical_backup_missed_slot(%s, %s)", (hour, now))
        return self.cur.fetchone()[0]

    def type_for(self, slot, repository, full_on=0):
        self.cur.execute("SELECT public.physical_backup_type(%s, %s, %s::jsonb, %s)",
                         (full_on, slot, repository, TODAY + timedelta(hours=9)))
        return self.cur.fetchone()[0]

    def test_a_start_before_the_hour_waits_for_it(self):
        self.ran("diff", utc(2100, 1, 5, 1, 0, 30))
        self.assertIsNone(self.missed(utc(2100, 1, 6, 0, 30)))

    def test_a_start_after_the_hour_with_a_run_since_takes_nothing(self):
        self.ran("diff", utc(2100, 1, 6, 1, 0, 20))
        self.assertIsNone(self.missed(utc(2100, 1, 6, 9, 0)))

    def test_a_start_after_the_hour_without_one_takes_the_slot(self):
        self.ran("diff", utc(2100, 1, 5, 1, 0, 30))
        # The archive check at start is not a backup.
        self.ran("check", utc(2100, 1, 6, 2, 0))
        self.assertEqual(self.missed(utc(2100, 1, 6, 9, 0)), utc(2100, 1, 6, 1))

    def test_the_slot_is_due_on_the_minute(self):
        self.assertEqual(self.missed(utc(2100, 1, 6, 1, 0)), utc(2100, 1, 6, 1))
        self.assertEqual(self.missed(utc(2100, 1, 6, 0, 59)), utc(2100, 1, 5, 1))

    def test_a_failed_run_is_the_slots_attempt(self):
        # Retrying belongs to the stale alert; a catch-up is one run for one missed slot.
        self.ran("diff", utc(2100, 1, 6, 1, 0, 20), succeeded=False)
        self.assertIsNone(self.missed(utc(2100, 1, 6, 9, 0)))

    def test_a_late_hour_reaches_back_across_midnight(self):
        self.assertEqual(self.missed(utc(2100, 1, 6, 0, 30), hour=23), utc(2100, 1, 5, 23))

    def test_a_differential_while_the_newest_full_is_recent(self):
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), info(3, diffs_days_ago=(2, 1))), "diff")

    def test_a_full_on_its_weekday(self):
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), info(1), full_on=3), "full")

    def test_an_overdue_full_is_taken_whatever_the_day(self):
        # Sunday was missed: the newest full is eight days old.
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), info(8, diffs_days_ago=(2, 1))), "full")

    def test_a_repository_without_a_full_takes_one(self):
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), info()), "full")

    def test_an_unreadable_repository_keeps_the_weekday_rule(self):
        self.assertEqual(self.type_for(TODAY + timedelta(hours=1), "[]"), "diff")

    def test_one_request_waits_and_one_claim_takes_it(self):
        self.cur.execute("DELETE FROM public.physical_backup_requests WHERE claimed_at IS NULL")
        self.cur.execute("SELECT public.physical_backup_request('a'), public.physical_backup_request('b')")
        first, second = self.cur.fetchone()
        self.assertEqual(first, second, "asking again while one waits returns the waiting request")
        self.cur.execute("SELECT public.physical_backup_claim_request()")
        self.assertEqual(self.cur.fetchone()[0], first)
        self.cur.execute("SELECT public.physical_backup_claim_request()")
        self.assertIsNone(self.cur.fetchone()[0], "a request is claimed once")
        self.cur.execute("SELECT public.physical_backup_request('c')")
        self.assertGreater(self.cur.fetchone()[0], first)

    def test_the_schedule_is_one_row_holding_the_latest(self):
        self.cur.execute("SELECT public.physical_backup_record_schedule(1, 0)")
        self.cur.execute("SELECT public.physical_backup_record_schedule(3, 6)")
        self.cur.execute("SELECT hour_utc, full_on FROM public.physical_backup_schedule")
        self.assertEqual(self.cur.fetchall(), [(3, 6)])

    def test_the_platform_reads_what_the_page_needs_and_writes_none_of_it(self):
        self.cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'fdw_reader'")
        if self.cur.fetchone() is None:
            self.skipTest("fdw_reader exists only where roles.sql has run")
        for table in ("physical_backup_runs", "physical_backup_schedule", "physical_backup_requests"):
            self.cur.execute("SELECT has_table_privilege('fdw_reader', %s, 'SELECT'), "
                             "has_table_privilege('fdw_reader', %s, 'INSERT, UPDATE, DELETE')",
                             (f"public.{table}", f"public.{table}"))
            self.assertEqual(self.cur.fetchone(), (True, False), table)

    def test_nobody_but_the_superuser_runs_the_schedule(self):
        for signature in ("public.physical_backup_missed_slot(integer, timestamptz)",
                          "public.physical_backup_type(integer, timestamptz, jsonb, timestamptz)",
                          "public.physical_backup_record_schedule(integer, integer)",
                          "public.physical_backup_request(text)",
                          "public.physical_backup_claim_request()"):
            self.cur.execute(
                "SELECT count(*) FROM pg_proc p, "
                "aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a "
                "WHERE p.oid = %s::regprocedure AND a.grantee = 0", (signature,))
            self.assertEqual(self.cur.fetchone()[0], 0, f"PUBLIC may execute {signature}")


if __name__ == "__main__":
    import sys
    result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
