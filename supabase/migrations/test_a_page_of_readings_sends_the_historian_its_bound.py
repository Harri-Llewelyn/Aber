# suite:
#   lanes: stack
#   why: What postgres_fdw sends the historian for each reader's page (0315), read off the plans
#     auto_explain gives for the statements inside telemetry_page() and telemetry_rollup_page(): two
#     remote aggregates, then a read whose remote WHERE carries the page's start, so no more rows
#     cross than the page, those before it and those sharing its last instant. The foreign tables
#     have no statistics on a stack, which is the estimate this has to hold at. It plants a device's
#     readings on the historian and removes them, with their buckets, afterwards.

"""
A page of readings sends the historian its bound (0315).

    python supabase/migrations/test_a_page_of_readings_sends_the_historian_its_bound.py

Needs a running stack: the platform database (54322, SUPABASE_DB_PASSWORD) and the historian (5433,
DB_PASSWORD), as `npm run dev:test` forwards them. auto_explain is preloaded on the platform image and
`postgres` may set its options (supautils), so each statement inside the page reads comes back to
this client as a plan. Skips, saying why, when either database or auto_explain is absent.

What is held, for each reader's call (the dashboard's route, i3X's window and the read before it, the
AAS bundle's first page, and a rollup page as i3X reads one):

  * the first remote read is an aggregate, a count by bin with GROUP BY, and the second an
    aggregate naming the page's last row (`array_agg(...)[n]`): one row crosses for the second;
  * the third's remote WHERE carries a lower bound on time the caller did not give, and no more rows
    cross for it than the page asks for, plus those that share its last instant;
  * the rows are the view read's rows, in its order.

The device is the suite's own and pinned, so a run killed half way leaves rows the next run removes.
The planted hours are two to four hours old: in uncompressed chunks, and refreshed into telemetry_1m
here, since a reading older than a rollup's watermark reaches it only when a refresh covers it.
"""
import os
import re
import time
import unittest
from datetime import timedelta

import psycopg2
import psycopg2.errors

TS_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
TS_PORT = os.getenv("TS_TEST_PORT", "5433")
TS_NAME = os.getenv("DB_NAME", "postgres")
TS_USER = os.getenv("DB_USER", "postgres")
TS_PASSWORD = os.getenv("DB_PASSWORD", "")

DB_HOST = os.getenv("SUPABASE_DB_HOST", "localhost")
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", "")

ASSET = "dev0315a0000000000000000"
TEMP, PRESSURE = "Test_0315/Temp", "Test_0315/Pressure"
CONNECT_TIMEOUT = 10
# How long a refresh waits out a policy's refresh of the same window, as test_rollup_refresh.py does.
REFRESH_WAIT_SECONDS = 60
REMOTE_SQL = re.compile(r"Remote SQL: (.*)")
ACTUAL_ROWS = re.compile(r"Foreign Scan.*\(actual (?:time=\S+ )?rows=(\d+)")
RAW = '"time", asset_id, metric_name, val_double, val_string, val_bool'
BUCKET = ("bucket, asset_id, metric_name, avg_double, min_double, max_double, last_double,"
          " last_string, last_bool, n_double, n_rows")


def connect(host, port, name, user, password):
    conn = psycopg2.connect(host=host, port=port, dbname=name, user=user, password=password,
                            connect_timeout=CONNECT_TIMEOUT)
    conn.autocommit = True
    return conn


class APageSendsItsBound(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not TS_PASSWORD or not DB_PASSWORD:
            raise unittest.SkipTest("DB_PASSWORD or SUPABASE_DB_PASSWORD is unset; run this through `npm run dev:test`.")
        try:
            cls.ts = connect(TS_HOST, TS_PORT, TS_NAME, TS_USER, TS_PASSWORD)
            cls.addClassCleanup(cls.ts.close)
            cls.db = connect(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)
            cls.addClassCleanup(cls.db.close)
        except psycopg2.OperationalError as err:
            raise unittest.SkipTest(f"a database is unreachable: {err}") from err
        with cls.db.cursor() as cur:
            cur.execute("SELECT to_regprocedure('public.telemetry_page(text, text, timestamp with time zone,"
                        " timestamp with time zone, boolean, integer, integer)') IS NOT NULL;")
            if not cur.fetchone()[0]:
                raise unittest.SkipTest("0315 is not applied to this stack")
            # SET, not set_config(): supautils lets postgres set these through the statement only.
            try:
                cur.execute("SET auto_explain.log_min_duration = 0;"
                            "SET auto_explain.log_nested_statements = on;"
                            "SET auto_explain.log_analyze = on;"
                            "SET auto_explain.log_verbose = on;"
                            "SET auto_explain.log_timing = off;"
                            "SET auto_explain.log_level = notice;"
                            "SET client_min_messages = notice;")
            except psycopg2.Error as err:
                raise unittest.SkipTest(f"auto_explain cannot be set here: {err}") from err
        cls.addClassCleanup(cls.remove)
        cls.plant()

    # ---- the device's readings -----------------------------------------------------------------
    @classmethod
    def ts_query(cls, sql, args=None):
        with cls.ts.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall() if cur.description else []

    @classmethod
    def plant(cls):
        cls.remove()
        cls.start = cls.ts_query("SELECT date_trunc('hour', now()) - interval '4 hours';")[0][0]
        cls.end = cls.start + timedelta(hours=2)
        cls.ts_query("INSERT INTO assets (asset_id, asset_name) VALUES (%s, %s) ON CONFLICT DO NOTHING;",
                     (ASSET, ASSET))
        # Temp every 10 s and Pressure every 30 s on Temp's instants, two hours of each.
        for metric, step, count in ((TEMP, 10, 720), (PRESSURE, 30, 240)):
            cls.ts_query("INSERT INTO telemetry (time, asset_id, metric_name, val_double)"
                         " SELECT %s::timestamptz + g * %s * interval '1 second', %s, %s, g"
                         "   FROM generate_series(0, %s - 1) g;", (cls.start, step, ASSET, metric, count))
        cls.refresh()

    @classmethod
    def remove(cls):
        start = cls.ts_query("SELECT min(time) FROM telemetry WHERE asset_id = %s;", (ASSET,))[0][0]
        cls.ts_query("DELETE FROM telemetry WHERE asset_id = %s;", (ASSET,))
        if start is not None:
            # The deletion invalidates the buckets; refreshing removes them.
            cls.start, cls.end = start, start + timedelta(hours=2)
            cls.refresh()
        cls.ts_query("DELETE FROM assets WHERE asset_id = %s;", (ASSET,))

    @classmethod
    def refresh(cls):
        deadline = time.monotonic() + REFRESH_WAIT_SECONDS
        while True:
            try:
                cls.ts_query("CALL refresh_continuous_aggregate('telemetry_1m', %s, %s);",
                             (cls.start - timedelta(minutes=1), cls.end + timedelta(minutes=1)))
                return
            except psycopg2.errors.LockNotAvailable:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1.0)

    # ---- a page read, and what it sent -------------------------------------------------------
    def explained(self, sql, args):
        """The rows, and (remote SQL, rows that crossed) for each remote read the statement made."""
        del self.db.notices[:]
        with self.db.cursor() as cur:
            cur.execute("SET ROLE authenticated;")
            try:
                cur.execute(sql, args)
                rows = cur.fetchall()
            finally:
                cur.execute("RESET ROLE;")
        remote = []
        for notice in self.db.notices:
            for scan, sent in zip(ACTUAL_ROWS.finditer(notice), REMOTE_SQL.finditer(notice)):
                remote.append((sent.group(1), int(scan.group(1))))
        return rows, remote

    def view(self, sql, args):
        with self.db.cursor() as cur:
            cur.execute("SET ROLE authenticated;")
            try:
                cur.execute(sql, args)
                return cur.fetchall()
            finally:
                cur.execute("RESET ROLE;")

    def assertBounded(self, remote, column, need, sharing):
        self.assertEqual(len(remote), 3, remote)
        (count_sql, _), (start_sql, start_rows), (read_sql, read_rows) = remote
        self.assertIn("count(*)", count_sql)
        self.assertIn("GROUP BY", count_sql)
        self.assertIn("array_agg(", start_sql)
        self.assertEqual(start_rows, 1, start_sql)
        # The page's start: a lower bound on the time column that the caller did not give.
        starts = re.findall(rf"\({column} >= '([^']+)'\)", read_sql)
        self.assertTrue(starts, read_sql)
        self.assertLessEqual(read_rows, need + sharing - 1, read_sql)
        self.assertGreaterEqual(read_rows, need, read_sql)

    def test_each_readers_raw_page_sends_its_start(self):
        sql = f"SELECT {RAW} FROM public.telemetry_page(%s, %s, %s, %s, %s, %s, %s);"
        old = f"SELECT {RAW} FROM public.telemetry t WHERE t.asset_id = %s{{}} ORDER BY t.\"time\" DESC, t.metric_name LIMIT %s OFFSET %s;"
        before = self.start + timedelta(hours=1, minutes=30)
        for name, args, where, view_args, need, sharing in (
            ("the dashboard's route: one metric, a page after two", (ASSET, TEMP, self.start, self.end, True, 100, 200),
             " AND t.metric_name = %s AND t.\"time\" >= %s AND t.\"time\" <= %s", (ASSET, TEMP, self.start, self.end, 100, 200), 300, 1),
            ("i3X: a device's window", (ASSET, None, self.start, self.end, True, 101, 0),
             " AND t.\"time\" >= %s AND t.\"time\" <= %s", (ASSET, self.start, self.end, 101, 0), 101, 2),
            ("i3X: the read before a device's window", (ASSET, None, None, before, False, 100, 0),
             " AND t.\"time\" < %s", (ASSET, before, 100, 0), 100, 2),
            ("the AAS bundle's first raw page", (ASSET, None, None, None, True, 500, 0),
             "", (ASSET, 500, 0), 500, 2),
        ):
            with self.subTest(reader=name):
                rows, remote = self.explained(sql, args)
                self.assertBounded(remote, '"time"', need, sharing)
                self.assertEqual(rows, self.view(old.format(where), view_args))

    def test_a_rollup_page_sends_its_start(self):
        sql = f"SELECT {BUCKET} FROM public.telemetry_rollup_page('1m', %s, %s, %s, %s, true, 10, 0);"
        rows, remote = self.explained(sql, (ASSET, TEMP, self.start, self.end))
        self.assertBounded(remote, "bucket", 10, 1)
        self.assertEqual(rows, self.view(
            f"SELECT {BUCKET} FROM public.telemetry_1m t WHERE t.asset_id = %s AND t.metric_name = %s"
            " AND t.bucket >= %s AND t.bucket <= %s ORDER BY t.bucket DESC LIMIT 10;",
            (ASSET, TEMP, self.start, self.end)))
        self.assertEqual(len(rows), 10)


if __name__ == "__main__":
    unittest.main()
