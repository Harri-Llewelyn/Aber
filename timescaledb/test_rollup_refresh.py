"""
A replay written later than the rollups' refresh policies reach back still reaches the rollups:
ingestion records its hour in rollup_refresh_requests, and the job refresh_requested_rollups()
refreshes that hour in telemetry_1m, _5m and _1h.

    python timescaledb/test_rollup_refresh.py

RUNS AGAINST THE HISTORIAN (port 5433), like the other suites here, as the superuser (DB_PASSWORD),
and as ingest_writer when INGEST_WRITER_PASSWORD is set. Each test writes readings three days old
for an asset of its own, runs the job with run_job(), and removes the asset, its readings and their
buckets afterwards.

THE POLICIES REACH BACK 25 HOURS, so a reading three days old is in raw telemetry and in no rollup
until the job runs: the first assertion is that the gap is there, the second that the job closes it.

THE GAP NEEDS A WATERMARK PAST THE REPLAY. The rollups are real-time: a bucket above a rollup's
watermark is read from raw. On a fresh historian nothing has been materialised, the watermark is
-infinity, and a late reading shows at once. So each test first materialises an anchor reading two
hours old, which moves every watermark past the replayed hour, as a running site's policies have.
"""
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import psycopg2

DB_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("TS_TEST_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
WRITER_USER = os.getenv("INGEST_WRITER_USER", "ingest_writer")
WRITER_PASSWORD = os.getenv("INGEST_WRITER_PASSWORD", "")

ROLLUPS = ("telemetry_1m", "telemetry_5m", "telemetry_1h")
METRIC = "_late_replay_probe"


def connect(user, password):
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=user, password=password)
    # refresh_continuous_aggregate() and run_job() refuse to run inside a transaction block.
    conn.autocommit = True
    return conn


class RollupRefreshTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not DB_PASSWORD:
            raise unittest.SkipTest("DB_PASSWORD is unset; run this through `npm run dev:test`.")
        cls.conn = connect(DB_USER, DB_PASSWORD)
        rows = cls.query_cls(
            "SELECT job_id FROM timescaledb_information.jobs "
            "WHERE proc_schema = 'public' AND proc_name = 'refresh_requested_rollups'")
        cls.job = rows[0][0] if rows else None

    @classmethod
    def tearDownClass(cls):
        conn = getattr(cls, "conn", None)
        if conn is not None:
            conn.close()

    @classmethod
    def query_cls(cls, sql, *args):
        with cls.conn.cursor() as cur:
            cur.execute(sql, args or None)
            return cur.fetchall() if cur.description else []

    def query(self, sql, *args):
        return self.query_cls(sql, *args)

    def setUp(self):
        self.asset = "test-late-replay-" + uuid.uuid4().hex[:12]
        now = datetime.now(timezone.utc)
        self.start = now.replace(minute=0, second=0, microsecond=0) - timedelta(days=3)
        self.end = self.start + timedelta(hours=1)
        self.anchor = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)
        self.query("INSERT INTO assets (asset_id, asset_name) VALUES (%s, %s)", self.asset, self.asset)
        self.addCleanup(self.remove_asset)
        self.materialise_past_the_replay()

    def materialise_past_the_replay(self):
        """One anchor reading inside the policies' window, refreshed in each rollup, parents first."""
        self.query("INSERT INTO telemetry (time, asset_id, metric_name, val_double) VALUES (%s, %s, %s, 1.0)",
                   self.anchor + timedelta(minutes=30), self.asset, METRIC)
        for view in ROLLUPS:
            self.query("CALL refresh_continuous_aggregate(%s, %s, %s)",
                       view, self.anchor, self.anchor + timedelta(hours=1))
        # The watermark is read through TimescaleDB's internal functions: no public view reports it.
        marks = dict(self.query(
            "SELECT c.view_name::text, _timescaledb_functions.to_timestamp("
            "         _timescaledb_functions.cagg_watermark(h.id)) "
            "  FROM timescaledb_information.continuous_aggregates c "
            "  JOIN _timescaledb_catalog.hypertable h "
            "    ON h.schema_name = c.materialization_hypertable_schema "
            "   AND h.table_name = c.materialization_hypertable_name"))
        for view in ROLLUPS:
            self.assertGreater(marks[view], self.end,
                               f"{view}'s watermark did not pass the replayed hour")

    def remove_asset(self):
        self.query("DELETE FROM telemetry WHERE asset_id = %s", self.asset)
        self.query("DELETE FROM rollup_refresh_requests WHERE window_start = %s AND window_end = %s",
                   self.start, self.end)
        # The deletion invalidates both hours; refreshing them removes the probe's buckets.
        for start in (self.start, self.anchor):
            for view in ROLLUPS:
                self.query("CALL refresh_continuous_aggregate(%s, %s, %s)",
                           view, start, start + timedelta(hours=1))
        self.query("DELETE FROM assets WHERE asset_id = %s", self.asset)

    def write_replay(self, conn):
        """An hour of readings three days old and its window, in one transaction, as ingestion does."""
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO telemetry (time, asset_id, metric_name, val_double) "
                    "SELECT t, %s, %s, 1.0 FROM generate_series(%s::timestamptz, "
                    "%s::timestamptz - interval '1 minute', interval '1 minute') t "
                    "ON CONFLICT (time, asset_id, metric_name) DO NOTHING",
                    (self.asset, METRIC, self.start, self.end))
                cur.execute(
                    "INSERT INTO rollup_refresh_requests (window_start, window_end) VALUES (%s, %s) "
                    "ON CONFLICT DO NOTHING", (self.start, self.end))
            conn.commit()
        finally:
            conn.autocommit = True

    def in_rollups(self):
        return {view: self.query(
            f"SELECT coalesce(sum(n_rows), 0)::int FROM {view} "
            f"WHERE asset_id = %s AND metric_name = %s AND bucket >= %s AND bucket < %s",
            self.asset, METRIC, self.start, self.end)[0][0] for view in ROLLUPS}

    def run_job(self):
        self.assertIsNotNone(self.job, "refresh_requested_rollups is not scheduled as a job")
        self.query("CALL run_job(%s)", self.job)

    def test_the_job_is_scheduled(self):
        rows = self.query(
            "SELECT scheduled, schedule_interval FROM timescaledb_information.jobs WHERE job_id = %s",
            self.job)
        self.assertEqual(rows, [(True, timedelta(minutes=5))])

    def test_a_replay_three_days_late_reaches_every_rollup(self):
        self.write_replay(self.conn)
        self.assertEqual(self.in_rollups(), {view: 0 for view in ROLLUPS},
                         "the policies alone already reach three days back; nothing to test")
        self.run_job()
        self.assertEqual(self.in_rollups(), {view: 60 for view in ROLLUPS})
        self.assertEqual(self.query(
            "SELECT count(*) FROM rollup_refresh_requests WHERE window_start = %s", self.start),
            [(0,)], "the request outlived its refresh")

    def test_a_window_waits_once_and_a_claimed_one_does_not_block_it(self):
        self.write_replay(self.conn)
        self.write_replay(self.conn)
        self.assertEqual(self.query(
            "SELECT count(*) FROM rollup_refresh_requests WHERE window_start = %s", self.start),
            [(1,)])
        # As a failed run leaves it: claimed and not deleted. A new reading's window waits beside it.
        self.query("UPDATE rollup_refresh_requests SET claimed_at = now() WHERE window_start = %s",
                   self.start)
        self.write_replay(self.conn)
        self.assertEqual(self.query(
            "SELECT count(*) FILTER (WHERE claimed_at IS NULL), count(*) "
            "FROM rollup_refresh_requests WHERE window_start = %s", self.start), [(1, 2)])
        self.run_job()
        self.assertEqual(self.in_rollups(), {view: 60 for view in ROLLUPS})
        self.assertEqual(self.query(
            "SELECT count(*) FROM rollup_refresh_requests WHERE window_start = %s", self.start),
            [(0,)])

    def test_ingest_writer_records_a_window_and_reads_nothing(self):
        if not WRITER_PASSWORD:
            self.skipTest("INGEST_WRITER_PASSWORD is unset")
        writer = connect(WRITER_USER, WRITER_PASSWORD)
        self.addCleanup(writer.close)
        self.write_replay(writer)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            with writer.cursor() as cur:
                cur.execute("SELECT count(*) FROM rollup_refresh_requests")
        self.run_job()
        self.assertEqual(self.in_rollups(), {view: 60 for view in ROLLUPS})


if __name__ == "__main__":
    import sys
    result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
