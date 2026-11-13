# suite:
#   lanes: stack
#   why: History's Overview counts from two device rollups, 5 minutes from telemetry_1m and an hour
#     from telemetry_1h, each materialised only, reconciled once, kept as long as its width's series
#     rollup, and filled back a chunk a run to its own source's oldest bucket; fdw_reader reads what
#     they hold.

"""
History's Overview counts each device's readings in two rollups of their own (aggregates.sql):
telemetry_device_5m from telemetry_1m and telemetry_device_1h from telemetry_1h. Both are
materialised only, reconciled once each however often the maintenance Job runs, kept as long as
the series rollup of their width, and filled back by backfill_device_rollups() to each source's own
oldest bucket, a bounded chunk a run.

    python timescaledb/test_device_rollups.py

RUNS AGAINST THE HISTORIAN (port 5433), like the other suites here, as the superuser (DB_PASSWORD),
and reads as fdw_reader when FDW_READER_PASSWORD is set. It changes nothing: the backfill's window
is a function of its inputs, asked here with chosen ones.
"""
import os
import unittest
from datetime import datetime, timedelta, timezone

import psycopg2

DB_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("TS_TEST_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
READER_USER = os.getenv("FDW_READER_USER", "fdw_reader")
READER_PASSWORD = os.getenv("FDW_READER_PASSWORD", "")

ROLLUPS = {"telemetry_device_5m": "telemetry_1m", "telemetry_device_1h": "telemetry_1h"}
T0 = datetime(2026, 1, 5, 10, 0, tzinfo=timezone.utc)


def connect(user, password):
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=user, password=password)
    conn.autocommit = True
    return conn


class DeviceRollups(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not DB_PASSWORD:
            raise unittest.SkipTest("DB_PASSWORD is unset; run this through `npm run dev:test`.")
        cls.conn = connect(DB_USER, DB_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def query(self, sql, *args):
        with self.conn.cursor() as cur:
            cur.execute(sql, args or None)
            return cur.fetchall()

    def test_each_counts_its_own_source_and_reads_no_raw(self):
        rows = dict(self.query(
            "SELECT view_name, view_definition FROM timescaledb_information.continuous_aggregates"
            " WHERE view_schema = 'public' AND view_name IN ('telemetry_device_5m', 'telemetry_device_1h')"))
        self.assertEqual(sorted(rows), sorted(ROLLUPS))
        for view, source in ROLLUPS.items():
            with self.subTest(rollup=view):
                self.assertRegex(rows[view], rf"FROM {source}\b")
                self.assertIn("sum(", rows[view])
        flags = dict(self.query(
            "SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates"
            " WHERE view_name IN ('telemetry_device_5m', 'telemetry_device_1h')"))
        self.assertEqual(flags, {view: True for view in ROLLUPS})

    def test_each_has_one_of_each_policy_and_keeps_as_long_as_its_width_s_series_rollup(self):
        rows = self.query(
            "SELECT hypertable_name, proc_name, count(*) FROM timescaledb_information.jobs"
            " WHERE hypertable_name IN ('telemetry_device_5m', 'telemetry_device_1h')"
            " GROUP BY 1, 2 ORDER BY 1, 2")
        self.assertEqual([(r[0], r[1], r[2]) for r in rows], [
            (view, proc, 1) for view in sorted(ROLLUPS)
            for proc in ("policy_compression", "policy_refresh_continuous_aggregate", "policy_retention")])
        drop = dict(self.query(
            "SELECT hypertable_name, config ->> 'drop_after' FROM timescaledb_information.jobs"
            " WHERE proc_name = 'policy_retention' AND hypertable_name IN"
            " ('telemetry_device_5m', 'telemetry_device_1h', 'telemetry_5m', 'telemetry_1h')"))
        self.assertEqual(drop["telemetry_device_5m"], drop["telemetry_5m"])
        self.assertEqual(drop["telemetry_device_1h"], drop["telemetry_1h"])

    def test_one_backfill_job_and_a_row_a_rollup_from_its_own_source(self):
        jobs = self.query("SELECT count(*) FROM timescaledb_information.jobs"
                          " WHERE proc_schema = 'public' AND proc_name = 'backfill_device_rollups'")
        self.assertEqual(jobs[0][0], 1)
        rows = dict((v, s) for v, s in self.query("SELECT view_name, source FROM public.device_rollup_backfill"))
        self.assertEqual(rows, ROLLUPS)

    def window(self, reached, oldest, chunk, start_at=T0):
        return self.query("SELECT from_ts, to_ts, done FROM public.device_backfill_window(%s, %s, %s::interval, %s)",
                          reached, oldest, chunk, start_at)[0]

    def test_the_backfill_walks_back_a_chunk_at_a_time_and_stops_at_its_source_s_oldest_bucket(self):
        week = "7 days"
        oldest = T0 - timedelta(days=17, hours=5, minutes=20)
        # Its first chunk ends where the policies start; each next one ends where the last began.
        self.assertEqual(self.window(None, oldest, week), (T0 - timedelta(days=7), T0, False))
        self.assertEqual(self.window(T0 - timedelta(days=7), oldest, week), (T0 - timedelta(days=14), T0 - timedelta(days=7), False))
        # The last stops at the hour holding the oldest bucket, never past it, and says it is done.
        floor = T0 - timedelta(days=17, hours=6)
        self.assertEqual(self.window(T0 - timedelta(days=14), oldest, week), (floor, T0 - timedelta(days=14), True))
        self.assertEqual(self.window(floor, oldest, week), (None, None, True))
        # A source with nothing in it has nothing to fill.
        self.assertEqual(self.window(None, None, "6 hours"), (None, None, True))

    def test_what_each_holds_is_reported_and_fdw_reader_may_read_it(self):
        rows = self.query("SELECT relation, computed_from IS NOT NULL, computed_to IS NOT NULL"
                          " FROM public.telemetry_device_coverage ORDER BY 1")
        self.assertEqual(rows, [("telemetry_device_1h", True, True), ("telemetry_device_5m", True, True)])
        if not READER_PASSWORD:
            self.skipTest("FDW_READER_PASSWORD is unset")
        reader = connect(READER_USER, READER_PASSWORD)
        try:
            with reader.cursor() as cur:
                cur.execute("SELECT count(*) FROM public.telemetry_device_coverage")
                self.assertEqual(cur.fetchone()[0], 2)
                cur.execute("SELECT count(*) >= 0 FROM public.telemetry_device_1h WHERE bucket > now() - interval '1 hour'")
                self.assertTrue(cur.fetchone()[0])
        finally:
            reader.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
