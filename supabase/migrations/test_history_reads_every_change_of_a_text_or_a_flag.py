# suite:
#   lanes: db
#   why: 0254's telemetry_changes(), over local tables standing in for raw telemetry and the
#     rollups: a state held for seconds inside one minute is returned with its times, a refresh of
#     an unchanged value collapses, the value in force at the start is carried in, past either cap
#     it says so and marks each bucket that held more than one value, a window whose raw readings
#     were dropped says so, bad bounds are refused before any read, and it reads as the caller.

"""
History reads every change of a text or a flag (0254).

    python supabase/migrations/test_history_reads_every_change_of_a_text_or_a_flag.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. telemetry_changes() returns one row per series. While raw telemetry holds the
window it reads raw: the first reading in the window and each later one whose value differs from the
one before, each at its own time, so a state held for seconds inside one minute is there and a
refresh of an unchanged value is not. The value in force at the window's start is carried in from
the newest raw reading before it, else from the 1-minute rollup's day before, else from telemetry_1h.
Past max_changes, or past the readings one series may bring across, it says so and names each bucket
that held more than one value instead. A window whose raw readings the historian has dropped says so,
and a series with nothing dropped, as on a young stack, is still read from raw. The bounds are
refused before any read. Whoever reads the telemetry views may call it, and anon may not.

The db lane has no historian, so local tables stand in for raw telemetry and the rollups it reads,
inside the transaction. EVERY TEST ROLLS BACK.
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

OPERATOR_ID = "a0d17070-0000-4000-8000-0000000254a1"

DEVICE = "dev000000000000000000254"
OTHER = "dev000000000000000000255"
ON_PATH = "MotionDevice/OnPath"
PROGRAM = "MotionDevice/TaskProgramName"
# A window well in the past, so now() never cuts it short.
T0 = datetime(2026, 1, 5, 10, 0, tzinfo=timezone.utc)

ROLLUP_COLUMNS = (
    "bucket timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,"
    " sum_double double precision, n_double bigint, min_double double precision,"
    " max_double double precision, last_double double precision, last_string text,"
    " last_bool boolean, n_rows bigint"
)
SIGNATURE = ("public.telemetry_changes(timestamp with time zone, timestamp with time zone, interval,"
             " text[], text[], integer)")


def seconds(n):
    return timedelta(seconds=n)


def minutes(n):
    return timedelta(minutes=n)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class ChangesBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s) IS NOT NULL;", (SIGNATURE,))
        if not self.cur.fetchone()[0]:
            self.skipTest("0254 is not applied to this database")
        # The historian's relations as local tables, as the foreign ones are shaped and granted.
        for rollup in ("telemetry_1m", "telemetry_5m", "telemetry_1h"):
            self.cur.execute(f"DROP FOREIGN TABLE timescale.{rollup} CASCADE;"
                             f"CREATE TABLE timescale.{rollup} ({ROLLUP_COLUMNS});"
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
            (OPERATOR_ID, f"{OPERATOR_ID}@history-changes.test"),
        )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id)"
            " SELECT %s, id FROM public.roles WHERE name = 'Operator' ON CONFLICT DO NOTHING;",
            (OPERATOR_ID,),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def readings(self, metric, *pairs, asset=DEVICE, rollup=True):
        """Raw readings, each (time, value): a str is a text, a bool a flag. Each lands in the
        1-minute rollup too, as the historian's continuous aggregate would put it."""
        for at, value in pairs:
            text = value if isinstance(value, str) else None
            flag = value if isinstance(value, bool) else None
            self.cur.execute(
                "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_string, val_bool)"
                " VALUES (%s, %s, %s, %s, %s);", (at, asset, metric, text, flag))
        if rollup:
            self.rebuild_1m()

    def rebuild_1m(self):
        self.cur.execute(
            "DELETE FROM timescale.telemetry_1m;"
            "INSERT INTO timescale.telemetry_1m (bucket, asset_id, metric_name, last_string, last_bool, n_rows)"
            " SELECT date_bin('1 minute', t.time, 'epoch'), t.asset_id, t.metric_name,"
            "        (array_agg(t.val_string ORDER BY t.time DESC))[1], (array_agg(t.val_bool ORDER BY t.time DESC))[1],"
            "        count(*)"
            "   FROM timescale.telemetry t GROUP BY 1, 2, 3;")

    def bucket(self, rollup, at, *, text=None, flag=None, n=1, metric=PROGRAM, asset=DEVICE):
        self.cur.execute(
            f"INSERT INTO timescale.{rollup} (bucket, asset_id, metric_name, last_string, last_bool, n_rows)"
            " VALUES (%s, %s, %s, %s, %s, %s);", (at, asset, metric, text, flag, n))

    def as_person(self, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for a token naming the Operator (or as anon). A refusal
        rolls back to the savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT changes_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": OPERATOR_ID, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
            self.columns = [c.name for c in self.cur.description or ()]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT changes_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT changes_call;")
        return rows

    def read(self, start, end, bucket="5 minutes", assets=(DEVICE,), metrics=(ON_PATH,), cap=None, role="authenticated"):
        """The rows as dicts, keyed by metric when one asset is read."""
        sql = "SELECT * FROM public.telemetry_changes(%s, %s, %s::interval, %s, %s" + (", %s" if cap else "") + ");"
        args = (start, end, bucket, list(assets), list(metrics)) + ((cap,) if cap else ())
        rows = [dict(zip(self.columns, r)) for r in self.as_person(sql, args, role=role)]
        return rows if len(assets) > 1 else {r["metric_name"]: r for r in rows}

    @staticmethod
    def changes(row):
        values = row["val_bool"] if any(v is not None for v in row["val_bool"] or ()) else row["val_string"]
        return list(zip(row["change_ts"] or (), values or ()))


class EveryChange(ChangesBase):
    def test_a_state_held_for_seconds_inside_one_minute_is_there_with_its_times(self):
        # Off the path for 40 s, inside the minute from 10:05: a 1-minute bucket's last value hides it.
        self.readings(ON_PATH, (T0, True), (T0 + minutes(5) + seconds(10), False), (T0 + minutes(5) + seconds(50), True))
        row = self.read(T0, T0 + minutes(10))[ON_PATH]
        self.assertEqual(row["read"], "changes")
        self.assertEqual(self.changes(row), [
            (T0, True), (T0 + minutes(5) + seconds(10), False), (T0 + minutes(5) + seconds(50), True)])
        self.assertEqual(row["n_changes"], 3)
        self.assertIsNone(row["marked_ts"])

    def test_a_refresh_of_an_unchanged_value_is_collapsed(self):
        self.readings(PROGRAM, (T0 + minutes(1), "PICK_BIN_A"), (T0 + minutes(3), "PICK_BIN_A"),
                      (T0 + minutes(4), "PLACE_CONVEYOR"), (T0 + minutes(6), "PLACE_CONVEYOR"),
                      (T0 + minutes(8), "PLACE_CONVEYOR"), (T0 + minutes(9), "IDLE"))
        row = self.read(T0, T0 + minutes(10), metrics=(PROGRAM,))[PROGRAM]
        self.assertEqual(self.changes(row), [
            (T0 + minutes(1), "PICK_BIN_A"), (T0 + minutes(4), "PLACE_CONVEYOR"), (T0 + minutes(9), "IDLE")])

    def test_the_first_reading_in_the_window_is_returned_even_when_it_repeats_the_one_before(self):
        # It is where the value stops being carried in: a reading arrived, and nothing changed.
        self.readings(PROGRAM, (T0 - minutes(2), "IDLE"), (T0 + minutes(3), "IDLE"), (T0 + minutes(7), "IDLE"))
        row = self.read(T0, T0 + minutes(10), metrics=(PROGRAM,))[PROGRAM]
        self.assertEqual(self.changes(row), [(T0 + minutes(3), "IDLE")])
        self.assertEqual(row["carried_string"], "IDLE")

    def test_the_rows_are_in_series_order_one_for_each(self):
        self.readings(ON_PATH, (T0, True))
        self.readings(ON_PATH, (T0, False), asset=OTHER)
        rows = self.read(T0, T0 + minutes(5), assets=(OTHER, DEVICE), metrics=(PROGRAM, ON_PATH))
        self.assertEqual([(r["asset_id"], r["metric_name"], r["read"]) for r in rows], [
            (DEVICE, ON_PATH, "changes"), (DEVICE, PROGRAM, "changes"),
            (OTHER, ON_PATH, "changes"), (OTHER, PROGRAM, "changes")])
        self.assertEqual(rows[1]["n_changes"], 0)
        self.assertIsNone(rows[1]["change_ts"])


class CarriedIn(ChangesBase):
    def test_the_value_in_force_at_the_start_comes_from_the_newest_raw_reading_before_it(self):
        # Inside the bucket holding from_ts, so raw is read from that bucket's start.
        self.readings(ON_PATH, (T0 + minutes(1), True), (T0 + minutes(2) + seconds(30), False), (T0 + minutes(4), True))
        row = self.read(T0 + minutes(3), T0 + minutes(10))[ON_PATH]
        self.assertIs(row["carried_bool"], False)
        self.assertEqual(self.changes(row), [(T0 + minutes(4), True)])

    def test_else_from_the_1_minute_rollup_in_the_day_before(self):
        # On the bucket grid, so nothing raw is before from_ts in the bucket read; the rollup has it.
        self.bucket("telemetry_1m", T0 - timedelta(hours=5), text="MANUAL")
        self.bucket("telemetry_1m", T0 - timedelta(hours=8), text="AUTO")
        row = self.read(T0, T0 + minutes(10), metrics=(PROGRAM,))[PROGRAM]
        self.assertEqual(row["carried_string"], "MANUAL")
        self.assertIsNone(row["change_ts"])

    def test_else_from_telemetry_1h_for_a_series_quiet_longer(self):
        self.bucket("telemetry_1h", T0 - timedelta(days=200), text="SETUP")
        self.bucket("telemetry_1h", T0 - timedelta(days=30), text="AUTO")
        row = self.read(T0, T0 + minutes(10), metrics=(PROGRAM,))[PROGRAM]
        self.assertEqual(row["carried_string"], "AUTO")

    def test_a_series_with_nothing_before_it_carries_nothing(self):
        self.readings(ON_PATH, (T0 + minutes(4), True))
        row = self.read(T0, T0 + minutes(10))[ON_PATH]
        self.assertIsNone(row["carried_bool"])
        self.assertEqual(self.changes(row), [(T0 + minutes(4), True)])


class Caps(ChangesBase):
    def flips(self, count, start=T0, every=seconds(20)):
        value = True
        pairs = []
        for i in range(count):
            pairs.append((start + every * i, value))
            value = not value
        self.readings(ON_PATH, *pairs)

    def test_past_max_changes_it_says_so_and_marks_each_bucket_that_held_more_than_one_value(self):
        # Flips every 20 s for 6 minutes from 10:00: 18 changes, every 5-minute bucket both values.
        self.flips(18)
        row = self.read(T0, T0 + minutes(10), cap=10)[ON_PATH]
        self.assertEqual(row["read"], "change_cap")
        self.assertEqual(row["n_changes"], 18)
        self.assertIsNone(row["change_ts"])
        self.assertEqual(list(zip(row["marked_ts"], row["marked_values"])), [(T0, 2), (T0 + minutes(5), 2)])
        # Under the cap, the same read is every change.
        self.assertEqual(self.read(T0, T0 + minutes(10), cap=18)[ON_PATH]["read"], "changes")

    def test_a_bucket_of_one_value_is_not_marked(self):
        self.readings(PROGRAM, (T0 + minutes(1), "A"), (T0 + minutes(2), "B"), (T0 + minutes(3), "C"),
                      (T0 + minutes(6), "C"), (T0 + minutes(7), "C"))
        row = self.read(T0, T0 + minutes(10), metrics=(PROGRAM,), cap=2)[PROGRAM]
        self.assertEqual(row["read"], "change_cap")
        self.assertEqual(list(zip(row["marked_ts"], row["marked_values"])), [(T0, 3)])

    def test_past_the_readings_it_brings_across_it_reads_none_and_the_historian_marks_the_buckets(self):
        # The rollup says 30,000 readings are in the window: too many to bring across for one series.
        self.flips(6)
        self.cur.execute("UPDATE timescale.telemetry_1m SET n_rows = 30000 WHERE bucket = %s;", (T0,))
        row = self.read(T0, T0 + minutes(10))[ON_PATH]
        self.assertEqual(row["read"], "reading_cap")
        self.assertIsNone(row["n_changes"])
        self.assertEqual(list(zip(row["marked_ts"], row["marked_values"])), [(T0, 2)])

    def test_the_cap_defaults_to_2000_and_is_at_most_5000(self):
        self.cur.execute("SELECT pg_get_function_arguments(%s::regprocedure);", (SIGNATURE,))
        self.assertIn("max_changes integer DEFAULT 2000", self.cur.fetchone()[0])
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.read(T0, T0 + minutes(10), cap=5001)


class RawRetention(ChangesBase):
    def test_a_window_whose_raw_readings_were_dropped_says_so(self):
        # Raw holds from 10:00 on; the 1-hour rollup still has the series at 08:00.
        self.readings(ON_PATH, (T0, True), (T0 + minutes(5), False))
        self.bucket("telemetry_1h", T0 - timedelta(hours=2), flag=True, metric=ON_PATH)
        rows = self.read(T0 - timedelta(hours=3), T0 + minutes(10), bucket="1 hour")
        self.assertEqual(rows[ON_PATH]["read"], "retention")
        self.assertEqual(rows[ON_PATH]["raw_from"], T0)
        self.assertIsNone(rows[ON_PATH]["marked_ts"])
        # Inside what raw holds, the same series is read from raw.
        self.assertEqual(self.read(T0, T0 + minutes(10))[ON_PATH]["read"], "changes")

    def test_a_series_with_nothing_dropped_is_read_from_raw_as_on_a_young_stack(self):
        self.readings(ON_PATH, (T0, True), (T0 + minutes(5), False))
        row = self.read(T0 - timedelta(days=3), T0 + minutes(10), bucket="1 hour")[ON_PATH]
        self.assertEqual(row["read"], "changes")
        self.assertEqual(self.changes(row), [(T0, True), (T0 + minutes(5), False)])

    def test_with_raw_empty_a_series_the_rollups_hold_is_past_retention(self):
        self.bucket("telemetry_1h", T0, flag=True, metric=ON_PATH)
        row = self.read(T0, T0 + minutes(10))[ON_PATH]
        self.assertEqual(row["read"], "retention")
        self.assertIsNone(row["raw_from"])


class Refusals(ChangesBase):
    def test_bad_bounds_are_refused_before_any_read(self):
        many = [f"m{i}" for i in range(26)]
        cases = {
            "a window that ends first": (T0, T0 - minutes(1), "1 minute", [DEVICE], ["m"], 2000),
            "an empty window": (T0, T0, "1 minute", [DEVICE], ["m"], 2000),
            "a bucket under a minute": (T0, T0 + minutes(5), "30 seconds", [DEVICE], ["m"], 2000),
            "a bucket of months": (T0, T0 + timedelta(days=400), "1 month", [DEVICE], ["m"], 2000),
            "no assets": (T0, T0 + minutes(5), "1 minute", None, ["m"], 2000),
            "no metrics": (T0, T0 + minutes(5), "1 minute", [DEVICE], None, 2000),
            "more than 50 series": (T0, T0 + minutes(5), "1 minute", [DEVICE, OTHER], many, 2000),
            "no cap": (T0, T0 + minutes(5), "1 minute", [DEVICE], ["m"], 0),
            "over 50,000 rows": (T0, T0 + timedelta(days=35), "1 minute", [DEVICE], ["m"], 2000),
        }
        # The caller may read nothing of the historian, so a refusal that came after a read would raise otherwise.
        self.cur.execute("REVOKE SELECT ON timescale.telemetry, timescale.telemetry_1m, timescale.telemetry_1h"
                         " FROM authenticated;")
        for name, args in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.as_person("SELECT * FROM public.telemetry_changes(%s, %s, %s::interval, %s, %s, %s);", args)

    def test_50_series_are_allowed(self):
        rows = self.read(T0, T0 + minutes(5), assets=(DEVICE, OTHER), metrics=[f"m{i}" for i in range(25)])
        self.assertEqual(len(rows), 50)


class WhoMayRead(ChangesBase):
    def test_whoever_reads_the_telemetry_views_may_call_it_and_anon_may_not(self):
        self.readings(ON_PATH, (T0, True))
        self.assertEqual(self.read(T0, T0 + minutes(5))[ON_PATH]["read"], "changes")
        self.assertEqual(self.read(T0, T0 + minutes(5), role="service_role")[ON_PATH]["read"], "changes")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(T0, T0 + minutes(5), role="anon")

    def test_it_reads_as_the_caller(self):
        self.cur.execute("REVOKE SELECT ON timescale.telemetry FROM authenticated;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(T0, T0 + minutes(5))
        self.cur.execute("SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = %s::regprocedure;",
                         (SIGNATURE,))
        self.assertEqual(self.cur.fetchone(), (False, "s", ["search_path=public"]))

    def test_the_row_shape(self):
        self.cur.execute("SELECT pg_get_function_result(%s::regprocedure);", (SIGNATURE,))
        self.assertEqual(self.cur.fetchone()[0], (
            "TABLE(asset_id text, metric_name text, read text, change_ts timestamp with time zone[],"
            " val_string text[], val_bool boolean[], carried_string text, carried_bool boolean,"
            " n_changes integer, marked_ts timestamp with time zone[], marked_values integer[],"
            " raw_from timestamp with time zone)"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
