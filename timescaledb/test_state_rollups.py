# suite:
#   lanes: stack
#   why: History marks a text or flag bucket past raw retention from three state rollups, 1m from
#     raw and 5m and 1h above it: each column, the composition up to an hour, the policies kept as
#     long as the series rollups', the backfill and its first chunk, a late replay, fdw_reader's
#     grant and a second load of their statements.

"""
History's text and flag charts mark each bucket older than raw that held more than one value from
three state rollups (aggregates.sql): telemetry_state_1m from raw telemetry, text and flag readings
only, telemetry_state_5m from it and telemetry_state_1h from that. Each bucket keeps any_true and
all_true (bool_or and bool_and of the flag), min_string and max_string, and n_rows, which compose
up the hierarchy. All three are materialised only, kept as long as the series rollup of their
width, filled back by backfill_state_rollups() to raw's oldest hour, refreshed by
refresh_requested_rollups() after a late replay, and readable by fdw_reader.

    python timescaledb/test_state_rollups.py

RUNS AGAINST THE HISTORIAN (port 5433), like the other suites here, as the superuser (DB_PASSWORD),
and reads as fdw_reader when FDW_READER_PASSWORD is set. Each test that writes plants readings for
an asset of its own, about three days old so no refresh policy reaches them, and removes the
readings, their buckets and the asset afterwards. The backfill test pauses the backfill job and
puts its progress row back as it found it.

A POLICY MAY HOLD A ROLLUP. TimescaleDB refuses a refresh that overlaps one in progress instead of
waiting for it, so each refresh here retries that refusal for up to a minute, as
test_rollup_refresh.py does.
"""
import os
import re
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2

DB_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("TS_TEST_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
READER_USER = os.getenv("FDW_READER_USER", "fdw_reader")
READER_PASSWORD = os.getenv("FDW_READER_PASSWORD", "")

AGGREGATES = Path(__file__).resolve().parent / "aggregates.sql"
STATE = ("telemetry_state_1m", "telemetry_state_5m", "telemetry_state_1h")
SOURCE = {"telemetry_state_1m": "telemetry", "telemetry_state_5m": "telemetry_state_1m",
          "telemetry_state_1h": "telemetry_state_5m"}
# The series rollup of each one's width, whose policies it follows.
SERIES = {"telemetry_state_1m": "telemetry_1m", "telemetry_state_5m": "telemetry_5m",
          "telemetry_state_1h": "telemetry_1h"}
# Every rollup, parents first, as refresh_requested_rollups() names them: what a test's cleanup refreshes.
EVERY_ROLLUP = ("telemetry_1m", "telemetry_5m", "telemetry_1h", "telemetry_device_5m", "telemetry_device_1h") + STATE
COLUMNS = ["bucket", "asset_id", "metric_name", "any_true", "all_true", "min_string", "max_string", "n_rows"]
REFRESH_WAIT = timedelta(seconds=60)
REFRESH_RETRY_EVERY = 1.0


def connect(user, password):
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=user, password=password)
    # refresh_continuous_aggregate() and run_job() refuse to run inside a transaction block.
    conn.autocommit = True
    return conn


def hour_of(at):
    return at.replace(minute=0, second=0, microsecond=0)


class StateRollups(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not DB_PASSWORD:
            raise unittest.SkipTest("DB_PASSWORD is unset; run this through `npm run dev:test`.")
        cls.conn = connect(DB_USER, DB_PASSWORD)

    @classmethod
    def tearDownClass(cls):
        conn = getattr(cls, "conn", None)
        if conn is not None:
            conn.close()

    def query(self, sql, *args):
        with self.conn.cursor() as cur:
            cur.execute(sql, args or None)
            return cur.fetchall() if cur.description else []

    def retrying(self, sql, *args):
        """Runs a refresh, waiting out a policy's refresh of the same rollup."""
        deadline = time.monotonic() + REFRESH_WAIT.total_seconds()
        while True:
            try:
                return self.query(sql, *args)
            except psycopg2.errors.LockNotAvailable as refused:
                if time.monotonic() >= deadline:
                    raise AssertionError(f"a concurrent refresh held it for {REFRESH_WAIT.total_seconds():.0f} s. {refused}") from refused
                time.sleep(REFRESH_RETRY_EVERY)

    def refresh(self, start, end, views=STATE):
        for view in views:
            self.retrying("CALL refresh_continuous_aggregate(%s, %s, %s)", view, start, end)

    def plant(self, *rows):
        """An asset of the test's own and its readings, each (time, metric, double, text, flag), removed after."""
        asset = "test-state-rollups-" + uuid.uuid4().hex[:12]
        self.query("INSERT INTO assets (asset_id, asset_name) VALUES (%s, %s)", asset, asset)
        for at, metric, number, text, flag in rows:
            self.query("INSERT INTO telemetry (time, asset_id, metric_name, val_double, val_string, val_bool)"
                       " VALUES (%s, %s, %s, %s, %s, %s)", at, asset, metric, number, text, flag)
        stamps = [r[0] for r in rows]

        def remove():
            self.query("DELETE FROM telemetry WHERE asset_id = %s", asset)
            # The deletion invalidates the hours; refreshing them in every rollup removes the asset's buckets.
            self.refresh(hour_of(min(stamps)), hour_of(max(stamps)) + timedelta(hours=1), EVERY_ROLLUP)
            self.query("DELETE FROM assets WHERE asset_id = %s", asset)
        self.addCleanup(remove)
        return asset

    def rows(self, view, asset):
        return self.query(
            f"SELECT bucket, metric_name, any_true, all_true, min_string, max_string, n_rows::int FROM {view}"
            " WHERE asset_id = %s ORDER BY metric_name, bucket", asset)

    # ---- definitions and policies -------------------------------------------------------------
    def test_each_is_built_from_the_one_before_materialised_only_with_its_columns(self):
        found = dict((r[0], r[1:]) for r in self.query(
            "SELECT view_name::text, view_definition, materialized_only FROM timescaledb_information.continuous_aggregates"
            " WHERE view_schema = 'public' AND view_name::text = ANY(%s)", list(STATE)))
        self.assertEqual(sorted(found), sorted(STATE))
        for view in STATE:
            with self.subTest(rollup=view):
                definition, materialized_only = found[view]
                self.assertRegex(definition, rf"FROM {SOURCE[view]}\b")
                self.assertTrue(materialized_only)
                self.assertEqual([r[0] for r in self.query(
                    "SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'public'"
                    " AND table_name = %s ORDER BY ordinal_position", view)], COLUMNS)
        # Text and flag readings only: a number's readings never reach the family.
        self.assertRegex(found["telemetry_state_1m"][0], r"val_string IS NOT NULL\)? OR \(?\w*\.?val_bool IS NOT NULL")

    def test_each_has_one_of_each_policy_and_follows_its_width_s_series_rollup(self):
        rows = self.query(
            "SELECT hypertable_name::text, proc_name::text, count(*)::int FROM timescaledb_information.jobs"
            " WHERE hypertable_name::text = ANY(%s) GROUP BY 1, 2 ORDER BY 1, 2", list(STATE))
        self.assertEqual(rows, [(view, proc, 1) for view in sorted(STATE)
                                for proc in ("policy_compression", "policy_refresh_continuous_aggregate", "policy_retention")])
        policy = {(r[0], r[1]): r[2:] for r in self.query(
            "SELECT hypertable_name::text, proc_name::text, schedule_interval, config ->> 'drop_after',"
            "       config ->> 'start_offset', config ->> 'compress_after'"
            "  FROM timescaledb_information.jobs WHERE hypertable_name::text = ANY(%s)", list(STATE) + list(SERIES.values()))}
        for view, series in SERIES.items():
            with self.subTest(rollup=view):
                for proc in ("policy_retention", "policy_refresh_continuous_aggregate", "policy_compression"):
                    self.assertEqual(policy.get((view, proc)), policy.get((series, proc)),
                                     f"{view}'s {proc} differs from {series}'s")

    # ---- what each bucket says ----------------------------------------------------------------
    def test_each_column_and_their_composition_up_to_an_hour(self):
        h = hour_of(datetime.now(timezone.utc) - timedelta(days=3))
        m = lambda minutes, seconds=0: h + timedelta(minutes=minutes, seconds=seconds)  # noqa: E731
        asset = self.plant(
            # The flag: both values inside the minute at 0:10; steady minutes at 0:30, 0:33 and 0:34
            # that, together, held both.
            (m(10, 10), "Door/OPEN", None, None, True), (m(10, 40), "Door/OPEN", None, None, False),
            (m(30), "Door/OPEN", None, None, True), (m(33), "Door/OPEN", None, None, False),
            (m(34), "Door/OPEN", None, None, False),
            # The text: two steady minutes that, together, held two values; a steady second hour.
            (m(40), "Controller/EXECUTION", None, "IDLE", None), (m(41), "Controller/EXECUTION", None, "RUNNING", None),
            (m(65), "Controller/EXECUTION", None, "IDLE", None), (m(110), "Controller/EXECUTION", None, "IDLE", None),
            # A number never reaches the family.
            (m(50), "Spindle/LOAD", 41.5, None, None),
        )
        self.refresh(h, h + timedelta(hours=2))
        door, program = "Door/OPEN", "Controller/EXECUTION"
        self.assertEqual(self.rows("telemetry_state_1m", asset), [
            (m(40), program, None, None, "IDLE", "IDLE", 1),
            (m(41), program, None, None, "RUNNING", "RUNNING", 1),
            (m(65), program, None, None, "IDLE", "IDLE", 1),
            (m(110), program, None, None, "IDLE", "IDLE", 1),
            (m(10), door, True, False, None, None, 2),
            (m(30), door, True, True, None, None, 1),
            (m(33), door, False, False, None, None, 1),
            (m(34), door, False, False, None, None, 1),
        ])
        self.assertEqual(self.rows("telemetry_state_5m", asset), [
            (m(40), program, None, None, "IDLE", "RUNNING", 2),
            (m(65), program, None, None, "IDLE", "IDLE", 1),
            (m(110), program, None, None, "IDLE", "IDLE", 1),
            (m(10), door, True, False, None, None, 2),
            (m(30), door, True, False, None, None, 3),
        ])
        self.assertEqual(self.rows("telemetry_state_1h", asset), [
            (h, program, None, None, "IDLE", "RUNNING", 2),
            (h + timedelta(hours=1), program, None, None, "IDLE", "IDLE", 2),
            (h, door, True, False, None, None, 5),
        ])

    def test_a_late_replay_reaches_the_state_rollups(self):
        jobs = self.query("SELECT job_id FROM timescaledb_information.jobs"
                          " WHERE proc_schema = 'public' AND proc_name = 'refresh_requested_rollups'")
        self.assertEqual(len(jobs), 1, "refresh_requested_rollups is not scheduled once")
        start = hour_of(datetime.now(timezone.utc) - timedelta(days=3))
        asset = self.plant((start + timedelta(minutes=5), "Door/OPEN", None, None, True),
                           (start + timedelta(minutes=5, seconds=30), "Door/OPEN", None, None, False))
        self.addCleanup(self.query, "DELETE FROM rollup_refresh_requests WHERE window_start = %s AND window_end = %s",
                        start, start + timedelta(hours=1))
        self.assertEqual(self.rows("telemetry_state_1h", asset), [], "a policy already reaches three days back")
        self.query("INSERT INTO rollup_refresh_requests (window_start, window_end) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                   start, start + timedelta(hours=1))
        self.retrying("CALL run_job(%s)", jobs[0][0])
        for view in STATE:
            with self.subTest(rollup=view):
                self.assertEqual([r[2:4] for r in self.rows(view, asset)], [(True, False)])

    # ---- the backfill -------------------------------------------------------------------------
    def test_the_backfill_fills_a_chunk_from_an_hour_inside_the_policies_reach(self):
        jobs = self.query("SELECT job_id, schedule_interval FROM timescaledb_information.jobs"
                          " WHERE proc_schema = 'public' AND proc_name = 'backfill_state_rollups'")
        self.assertEqual([r[1] for r in jobs], [timedelta(minutes=2)], "backfill_state_rollups is not scheduled once")
        job = jobs[0][0]
        saved = self.query("SELECT view_name, chunk, reached, done, chunk_ms, updated_at FROM public.state_rollup_backfill")
        self.assertEqual([(r[0], r[1]) for r in saved], [("telemetry_state_1m", timedelta(hours=6))])
        # Paused, and its progress put back afterwards, so the stack's own backfill carries on as it was.
        self.query("SELECT alter_job(%s, scheduled => false)", job)
        self.addCleanup(self.query, "SELECT alter_job(%s, scheduled => true)", job)
        self.addCleanup(self.query, "UPDATE public.state_rollup_backfill SET chunk = %s, reached = %s, done = %s,"
                        " chunk_ms = %s, updated_at = %s WHERE view_name = %s", *saved[0][1:], saved[0][0])
        upto = self.query("SELECT time_bucket('1 hour', now() - interval '24 hours')")[0][0]
        # One flip in the hour before the first chunk's end, which the policies' first whole bucket
        # passes over, and one an hour further back, beyond their reach.
        asset = self.plant((upto - timedelta(minutes=55), "Door/OPEN", None, None, True),
                           (upto - timedelta(minutes=54), "Door/OPEN", None, None, False),
                           (upto - timedelta(hours=2, minutes=-10), "Door/OPEN", None, None, True),
                           (upto - timedelta(hours=2, minutes=-11), "Door/OPEN", None, None, False))
        self.query("UPDATE public.state_rollup_backfill SET reached = NULL, done = false")
        self.retrying("CALL run_job(%s)", job)
        if self.query("SELECT time_bucket('1 hour', now() - interval '24 hours')")[0][0] != upto:
            self.skipTest("an hour turned while the backfill ran; its first chunk moved with it")
        oldest = self.query("SELECT time_bucket('1 hour', min(time)) FROM telemetry")[0][0]
        reached, done = self.query("SELECT reached, done FROM public.state_rollup_backfill")[0]
        self.assertEqual(reached, max(upto - timedelta(hours=6), oldest))
        self.assertEqual(done, reached == oldest)
        self.assertEqual([r[0] for r in self.rows("telemetry_state_1h", asset)],
                         [upto - timedelta(hours=2), upto - timedelta(hours=1)])

    # ---- who reads them, and a second load ----------------------------------------------------
    def test_fdw_reader_may_read_each(self):
        if not READER_PASSWORD:
            self.skipTest("FDW_READER_PASSWORD is unset")
        reader = connect(READER_USER, READER_PASSWORD)
        try:
            with reader.cursor() as cur:
                cur.execute("SELECT count(*) >= 0 FROM public.telemetry_state_1m WHERE bucket > now() - interval '1 hour'")
                self.assertTrue(cur.fetchone()[0])
                cur.execute("SELECT count(*) >= 0 FROM public.telemetry_state_5m WHERE bucket > now() - interval '1 hour'")
                self.assertTrue(cur.fetchone()[0])
                cur.execute("SELECT count(*) >= 0 FROM public.telemetry_state_1h WHERE bucket > now() - interval '1 hour'")
                self.assertTrue(cur.fetchone()[0])
        finally:
            reader.close()

    def test_a_second_load_of_their_statements_changes_nothing(self):
        source = AGGREGATES.read_text(encoding="utf-8")
        statements = re.findall(r"^CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_state_\w+\n.*?WITH NO DATA;", source, re.S | re.M)
        statements += re.findall(r"^ALTER MATERIALIZED VIEW telemetry_state_\w+ SET .*?;$", source, re.M)
        statements += re.findall(r"^CREATE TABLE IF NOT EXISTS public\.state_rollup_backfill \(.*?\n\);", source, re.S | re.M)
        statements += re.findall(r"^INSERT INTO public\.state_rollup_backfill .*?;$", source, re.S | re.M)
        statements += [s for s in re.findall(r"^DO \$\$\n.*?\nEND \$\$;", source, re.S | re.M) if "'backfill_state_rollups'" in s]
        self.assertEqual(len(statements), 9, "aggregates.sql's state-rollup statements changed shape")
        before = self.snapshot()
        for statement in statements:
            self.query(statement)
        self.assertEqual(self.snapshot(), before)

    def snapshot(self):
        return (
            self.query("SELECT view_name::text, view_definition, materialized_only, compression_enabled"
                       " FROM timescaledb_information.continuous_aggregates WHERE view_name::text = ANY(%s) ORDER BY 1", list(STATE)),
            self.query("SELECT proc_name::text, hypertable_name::text, schedule_interval, scheduled FROM timescaledb_information.jobs"
                       " WHERE hypertable_name::text = ANY(%s) OR proc_name = 'backfill_state_rollups' ORDER BY 1, 2", list(STATE)),
            self.query("SELECT view_name, chunk, reached, done FROM public.state_rollup_backfill"),
        )


if __name__ == "__main__":
    import sys
    result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
