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
archive, which is what makes a restore reach past the backup.
"""
import json
import os
import shutil
import subprocess
import time
import unittest

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

    def test_the_exporter_role_can_read_the_record(self):
        rows = self.query(
            "SELECT has_table_privilege('metrics_reader', 'public.physical_backup_runs', 'SELECT'), "
            "has_function_privilege('metrics_reader', "
            "'public.physical_backup_record(text, timestamptz, boolean, text, jsonb)', 'EXECUTE')")
        can_read, can_write = rows[0]
        self.assertTrue(can_read, "the Historian Backup Stale alert reads this table as metrics_reader")
        self.assertFalse(can_write, "only the superuser records a run")


if __name__ == "__main__":
    import sys
    result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
