# suite:
#   lanes: db
#   why: 0313's retention arm of telemetry_changes(), over local tables standing in for raw
#     telemetry, the series rollups and the state rollups: a bucket older than raw that held more
#     than one value is marked with no count, from the state rollup of the widest width dividing
#     the bucket; a bucket raw holds whole is counted from raw; one the state rollups do not reach
#     is not marked; the foreign tables are the caller's to read and never anon's.

"""
History marks a bucket that held more than one value past raw retention (0313).

    python supabase/migrations/test_history_marks_buckets_past_raw_retention.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. A window whose raw readings the historian has dropped is `retention`, charted
from the buckets. Each bucket older than raw is marked when its state rollup says it held more than
one value: a flag that was both true and false, a text whose least and greatest values differ. That
is all a rollup can say, so the mark's count is NULL. The rollup read is the widest of 1 minute, 5
minutes and 1 hour that divides the bucket, regrouped into the bucket. A bucket that starts at or
after the hour holding raw's oldest reading is counted from raw, as past a cap, unless more than
1,000,000 readings would be counted. A bucket with no state-rollup row is not marked.

The db lane has no historian, so local tables stand in for the foreign ones inside the
transaction. EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

OPERATOR_ID = "a0d17070-0000-4000-8000-0000000313a1"

DEVICE = "dev000000000000000000313"
FLAG = "MotionDevice/OnPath"
TEXT = "MotionDevice/TaskProgramName"
# Raw holds readings from here on; everything before it is past raw. On the hour, as a chunk ends.
RAW_FROM = datetime(2026, 1, 20, 0, 0, tzinfo=timezone.utc)

SERIES_COLUMNS = (
    "bucket timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,"
    " sum_double double precision, n_double bigint, min_double double precision,"
    " max_double double precision, last_double double precision, last_string text,"
    " last_bool boolean, n_rows bigint"
)
STATE_COLUMNS = (
    "bucket timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,"
    " any_true boolean, all_true boolean, min_string text, max_string text, n_rows bigint"
)
STATE_ROLLUPS = ("telemetry_state_1m", "telemetry_state_5m", "telemetry_state_1h")


def hours(n):
    return timedelta(hours=n)


def minutes(n):
    return timedelta(minutes=n)


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class TheForeignTables(unittest.TestCase):
    """As 0313 leaves them, before any test replaces them."""

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def test_each_is_a_foreign_table_on_the_historian_with_the_rollup_s_columns(self):
        for rollup in STATE_ROLLUPS:
            with self.subTest(rollup=rollup):
                self.cur.execute(
                    "SELECT s.srvname, t.ftoptions FROM pg_foreign_table t JOIN pg_foreign_server s ON s.oid = t.ftserver"
                    " WHERE t.ftrelid = to_regclass(%s);", (f"timescale.{rollup}",))
                server, options = self.cur.fetchone()
                self.assertEqual(server, "timescaledb_server")
                self.assertIn(f"table_name={rollup}", options)
                self.cur.execute(
                    "SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute"
                    " WHERE attrelid = to_regclass(%s) AND attnum > 0 AND NOT attisdropped;", (f"timescale.{rollup}",))
                self.assertEqual(self.cur.fetchone()[0], [
                    "bucket", "asset_id", "metric_name", "any_true", "all_true", "min_string", "max_string", "n_rows"])

    def test_the_caller_may_read_them_and_anon_may_not(self):
        for rollup in STATE_ROLLUPS:
            with self.subTest(rollup=rollup):
                self.cur.execute(
                    "SELECT has_table_privilege('authenticated', %s, 'SELECT'),"
                    "       has_table_privilege('service_role', %s, 'SELECT'),"
                    "       has_table_privilege('anon', %s, 'SELECT');", (f"timescale.{rollup}",) * 3)
                self.assertEqual(self.cur.fetchone(), (True, True, False))


class PastRaw(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        for rollup in ("telemetry_1m", "telemetry_5m", "telemetry_1h"):
            self.cur.execute(f"DROP FOREIGN TABLE timescale.{rollup} CASCADE;"
                             f"CREATE TABLE timescale.{rollup} ({SERIES_COLUMNS});"
                             f"GRANT SELECT ON timescale.{rollup} TO authenticated, service_role;")
        for rollup in STATE_ROLLUPS:
            self.cur.execute(f"DROP FOREIGN TABLE timescale.{rollup} CASCADE;"
                             f"CREATE TABLE timescale.{rollup} ({STATE_COLUMNS});"
                             f"GRANT SELECT ON timescale.{rollup} TO authenticated, service_role;")
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry CASCADE;"
            "CREATE TABLE timescale.telemetry (\"time\" timestamptz NOT NULL, asset_id text NOT NULL,"
            " metric_name text NOT NULL, val_double double precision, val_string text, val_bool boolean);"
            "GRANT SELECT ON timescale.telemetry TO authenticated, service_role;"
        )
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (OPERATOR_ID, f"{OPERATOR_ID}@history-marks.test"),
        )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id)"
            " SELECT %s, id FROM public.roles WHERE name = 'Operator' ON CONFLICT DO NOTHING;",
            (OPERATOR_ID,),
        )
        # Raw's oldest reading, so everything before RAW_FROM is past raw.
        self.raw(TEXT, (RAW_FROM, "IDLE"))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def raw(self, metric, *pairs):
        """Raw readings, each (time, value), with the 1-minute rollup's count of them rebuilt."""
        for at, value in pairs:
            text = value if isinstance(value, str) else None
            flag = value if isinstance(value, bool) else None
            self.cur.execute(
                "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_string, val_bool)"
                " VALUES (%s, %s, %s, %s, %s);", (at, DEVICE, metric, text, flag))
        self.cur.execute(
            "DELETE FROM timescale.telemetry_1m;"
            "INSERT INTO timescale.telemetry_1m (bucket, asset_id, metric_name, last_string, last_bool, n_rows)"
            " SELECT date_bin('1 minute', t.time, 'epoch'), t.asset_id, t.metric_name,"
            "        (array_agg(t.val_string ORDER BY t.time DESC))[1], (array_agg(t.val_bool ORDER BY t.time DESC))[1],"
            "        count(*)"
            "   FROM timescale.telemetry t GROUP BY 1, 2, 3;")

    def hourly(self, metric, at, flag=None, text=None):
        """The series rollup's hour, which says the series has readings raw no longer holds."""
        self.cur.execute(
            "INSERT INTO timescale.telemetry_1h (bucket, asset_id, metric_name, last_string, last_bool, n_rows)"
            " VALUES (%s, %s, %s, %s, %s, 1);", (at, DEVICE, metric, text, flag))

    def state(self, rollup, metric, at, *, flags=None, texts=None):
        """A state-rollup bucket: `flags` (any_true, all_true) or `texts` (min_string, max_string)."""
        any_true, all_true = flags or (None, None)
        low, high = texts or (None, None)
        self.cur.execute(
            f"INSERT INTO timescale.{rollup} (bucket, asset_id, metric_name, any_true, all_true, min_string, max_string, n_rows)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, 2);", (at, DEVICE, metric, any_true, all_true, low, high))

    def read(self, start, end, bucket, metric, role="authenticated"):
        """The one series' row, read as PostgREST reads it for the Operator."""
        self.cur.execute("SAVEPOINT marks_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": OPERATOR_ID, "role": role}),))
            self.cur.execute("SELECT * FROM public.telemetry_changes(%s, %s, %s::interval, %s, %s);",
                             (start, end, bucket, [DEVICE], [metric]))
            columns = [c.name for c in self.cur.description]
            rows = [dict(zip(columns, r)) for r in self.cur.fetchall()]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT marks_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT marks_call;")
        self.assertEqual(len(rows), 1)
        return rows[0]

    @staticmethod
    def marks(row):
        return list(zip(row["marked_ts"] or (), row["marked_values"] or ()))

    # ---- the tests ---------------------------------------------------------------------------
    def test_a_flag_hour_past_raw_that_held_both_values_is_marked_with_no_count(self):
        day = RAW_FROM - hours(48)
        self.hourly(FLAG, day, flag=True)
        self.state("telemetry_state_1h", FLAG, day, flags=(True, False))
        self.state("telemetry_state_1h", FLAG, day + hours(1), flags=(True, True))
        self.state("telemetry_state_1h", FLAG, day + hours(2), flags=(False, False))
        self.state("telemetry_state_1h", FLAG, day + hours(3), flags=(True, False))
        row = self.read(day, day + hours(4), "1 hour", FLAG)
        self.assertEqual(row["read"], "retention")
        self.assertEqual(row["raw_from"], RAW_FROM)
        self.assertEqual(self.marks(row), [(day, None), (day + hours(3), None)])

    def test_a_text_hour_past_raw_whose_least_and_greatest_differ_is_marked(self):
        day = RAW_FROM - hours(48)
        self.hourly(TEXT, day, text="IDLE")
        self.state("telemetry_state_1h", TEXT, day, texts=("IDLE", "RUNNING"))
        self.state("telemetry_state_1h", TEXT, day + hours(1), texts=("RUNNING", "RUNNING"))
        row = self.read(day, day + hours(2), "1 hour", TEXT)
        self.assertEqual(self.marks(row), [(day, None)])

    def test_a_wider_bucket_is_composed_from_the_widest_rollup_that_divides_it(self):
        day = RAW_FROM - hours(48)
        self.hourly(FLAG, day, flag=True)
        # Two steady hours, one true and one false: the two-hour bucket held both.
        self.state("telemetry_state_1h", FLAG, day, flags=(True, True))
        self.state("telemetry_state_1h", FLAG, day + hours(1), flags=(False, False))
        # Steady in both, but on two values: the next two hours' text held two.
        self.hourly(TEXT, day, text="A")
        self.state("telemetry_state_1h", TEXT, day + hours(2), texts=("A", "A"))
        self.state("telemetry_state_1h", TEXT, day + hours(3), texts=("B", "B"))
        self.assertEqual(self.marks(self.read(day, day + hours(4), "2 hours", FLAG)), [(day, None)])
        self.assertEqual(self.marks(self.read(day, day + hours(4), "2 hours", TEXT)), [(day + hours(2), None)])

    def test_each_width_reads_its_own_rollup(self):
        day = RAW_FROM - hours(48)
        self.hourly(FLAG, day, flag=True)
        # Each rollup marks a different stretch, so the mark says which was read.
        self.state("telemetry_state_1h", FLAG, day + hours(1), flags=(True, False))
        self.state("telemetry_state_5m", FLAG, day + minutes(15), flags=(True, False))
        self.state("telemetry_state_1m", FLAG, day + minutes(2), flags=(True, False))
        cases = {
            "1 hour": [(day + hours(1), None)],
            "15 minutes": [(day + minutes(15), None)],
            "2 minutes": [(day + minutes(2), None)],
        }
        for bucket, expected in cases.items():
            with self.subTest(bucket=bucket):
                self.assertEqual(self.marks(self.read(day, day + hours(2), bucket, FLAG)), expected)

    def test_a_window_across_raw_s_horizon_counts_the_buckets_raw_holds(self):
        before = RAW_FROM - hours(2)
        self.hourly(FLAG, before, flag=True)
        self.state("telemetry_state_1h", FLAG, before, flags=(True, False))
        # Inside raw: three values in the first hour, one in the second.
        self.raw(TEXT, (RAW_FROM + minutes(10), "RUNNING"), (RAW_FROM + minutes(20), "FAULT"),
                 (RAW_FROM + hours(1) + minutes(5), "IDLE"))
        self.hourly(TEXT, before, text="IDLE")
        self.state("telemetry_state_1h", TEXT, before + hours(1), texts=("FAULT", "IDLE"))
        row = self.read(before, RAW_FROM + hours(2), "1 hour", TEXT)
        self.assertEqual(row["read"], "retention")
        # Past raw from the state rollup, uncounted; inside it from raw, with the count.
        self.assertEqual(self.marks(row), [(before + hours(1), None), (RAW_FROM, 3)])

    def test_a_day_bucket_raw_holds_only_part_of_is_marked_from_the_state_rollup(self):
        # Raw's oldest reading at 06:00, so the day holding it is not whole in raw.
        self.cur.execute("DELETE FROM timescale.telemetry;")
        horizon = RAW_FROM + hours(6)
        self.raw(FLAG, (horizon, True), (horizon + hours(1), True))
        self.hourly(FLAG, RAW_FROM - hours(24), flag=True)
        self.state("telemetry_state_1h", FLAG, RAW_FROM + hours(2), flags=(True, False))
        row = self.read(RAW_FROM - hours(24), RAW_FROM + hours(48), "1 day", FLAG)
        self.assertEqual(row["read"], "retention")
        self.assertEqual(row["raw_from"], horizon)
        self.assertEqual(self.marks(row), [(RAW_FROM, None)])

    def test_a_bucket_the_state_rollups_do_not_reach_is_not_marked(self):
        day = RAW_FROM - timedelta(days=200)
        self.hourly(FLAG, day, flag=True)
        row = self.read(day, day + hours(6), "1 hour", FLAG)
        self.assertEqual(row["read"], "retention")
        self.assertIsNone(row["marked_ts"])
        self.assertIsNone(row["marked_values"])

    def test_past_a_million_readings_the_buckets_raw_holds_are_not_counted(self):
        before = RAW_FROM - hours(1)
        self.hourly(FLAG, before, flag=True)
        self.state("telemetry_state_1h", FLAG, before, flags=(True, False))
        self.raw(FLAG, (RAW_FROM + minutes(1), True), (RAW_FROM + minutes(2), False))
        self.cur.execute("UPDATE timescale.telemetry_1m SET n_rows = 2000000 WHERE metric_name = %s;", (FLAG,))
        row = self.read(before, RAW_FROM + hours(1), "1 hour", FLAG)
        self.assertEqual(self.marks(row), [(before, None)])

    def test_inside_raw_nothing_is_read_from_the_state_rollups(self):
        self.raw(FLAG, (RAW_FROM + minutes(1), True), (RAW_FROM + minutes(2), False))
        self.state("telemetry_state_1h", FLAG, RAW_FROM + hours(1), flags=(True, False))
        row = self.read(RAW_FROM, RAW_FROM + hours(2), "1 hour", FLAG)
        self.assertEqual(row["read"], "changes")
        self.assertIsNone(row["marked_ts"])

    def test_it_reads_the_state_rollups_as_the_caller(self):
        day = RAW_FROM - hours(48)
        self.hourly(FLAG, day, flag=True)
        self.cur.execute("REVOKE SELECT ON timescale.telemetry_state_1h FROM authenticated;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(day, day + hours(2), "1 hour", FLAG)
        self.assertEqual(self.read(day, day + hours(2), "1 hour", FLAG, role="service_role")["read"], "retention")


if __name__ == "__main__":
    unittest.main(verbosity=2)
