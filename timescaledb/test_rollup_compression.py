"""
The rollups are compressed: each has the columnstore segmented by series, its own chunk span, and a
compression policy outside the late-data window.

    python timescaledb/test_rollup_compression.py

RUNS AGAINST THE HISTORIAN (port 5433), like the other suites here. Uncompressed, the rollups were
most of the historian's disk (#415): about 73 MB a series at their default retention, which fills
the chart's 20 Gi volume in about two months at 1,000 series. Compressed they are about a fifth.

A POLICY INSIDE THE LATE-DATA WINDOW would recompress chunks the refresh keeps rewriting, and a
chunk as wide as the one TimescaleDB inherits at creation (ten times the raw interval) would keep
recent buckets uncompressed for weeks; both are asserted against, as the running database has them.
"""
import os
import unittest
from datetime import timedelta

import psycopg2

DB_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("TS_TEST_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")

ROLLUPS = {"telemetry_1m": timedelta(days=1), "telemetry_5m": timedelta(days=7),
           "telemetry_1h": timedelta(days=30)}
# aggregates.sql's refresh start_offset: late data is accepted up to 24 hours old.
LATE_DATA = timedelta(hours=25)


class RollupCompressionTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not DB_PASSWORD:
            raise unittest.SkipTest("DB_PASSWORD is unset; run this through `npm run dev:test`.")
        cls.conn = psycopg2.connect(
            host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
        )

    @classmethod
    def tearDownClass(cls):
        conn = getattr(cls, "conn", None)
        if conn is not None:
            conn.close()

    def query(self, sql, *args):
        with self.conn.cursor() as cur:
            cur.execute(sql, args or None)
            return cur.fetchall()

    def rollups(self):
        return {r[0]: r[1:] for r in self.query(
            "SELECT c.view_name, c.compression_enabled, d.time_interval, "
            "       (SELECT (j.config ->> 'compress_after')::interval "
            "          FROM timescaledb_information.jobs j "
            "         WHERE j.proc_name = 'policy_compression' "
            "           AND j.hypertable_schema = c.view_schema AND j.hypertable_name = c.view_name), "
            "       (SELECT replace(s.segmentby, ' ', '') "
            "          FROM timescaledb_information.hypertable_columnstore_settings s "
            "         WHERE s.hypertable = format('%I.%I', c.materialization_hypertable_schema, "
            "                                     c.materialization_hypertable_name)::regclass) "
            "  FROM timescaledb_information.continuous_aggregates c "
            "  JOIN timescaledb_information.dimensions d "
            "    ON d.hypertable_schema = c.materialization_hypertable_schema "
            "   AND d.hypertable_name = c.materialization_hypertable_name")}

    def test_every_rollup_is_compressed_by_series(self):
        found = self.rollups()
        for view in ROLLUPS:
            enabled, _, _, segmentby = found[view]
            self.assertTrue(enabled, f"{view} has no columnstore")
            self.assertEqual(segmentby, "asset_id,metric_name",
                             f"{view} is segmented by {segmentby!r}; a one-series read would "
                             f"decompress every series in the chunk")

    def test_the_policy_clears_the_late_data_window(self):
        for view, (_, _, after, _) in self.rollups().items():
            self.assertIsNotNone(after, f"{view} has no compression policy")
            self.assertGreater(after, LATE_DATA,
                               f"{view} is compressed after {after}, inside the refresh window")

    def test_each_rollup_has_its_own_chunk_span(self):
        found = self.rollups()
        for view, span in ROLLUPS.items():
            self.assertEqual(found[view][1], span,
                             f"{view} makes chunks of {found[view][1]}, not the {span} "
                             f"aggregates.sql sets")


if __name__ == "__main__":
    import sys
    result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
