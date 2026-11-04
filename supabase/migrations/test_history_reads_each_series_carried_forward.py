"""
History reads each series carried forward (0233).

    python supabase/migrations/test_history_reads_each_series_carried_forward.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. telemetry_carried() returns one row per series per bucket of the window. A bucket
with readings carries the rollup's average, minimum, maximum and last values, combined from the
widest rollup whose width divides the bucket; a quiet bucket carries the last value forward and
says so. Each series is seeded from the rollups before the window: from the lookback in one query,
from further back one series at a time, and from telemetry_1h for a series older than its own
rollup keeps, so a series silent longer than raw retention still seeds. Raw telemetry is never read.
Nothing is carried past now, and a series with nothing to carry has no row. The bounds are refused
before any read. Whoever reads the telemetry views may call it, and anon may not.

The db lane has no historian, so local tables stand in for the three foreign rollups and raw
telemetry, inside the transaction. EVERY TEST ROLLS BACK.
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

OPERATOR_ID = "a0d17070-0000-4000-8000-0000000233a1"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000233a2"

DEVICE = "dev000000000000000000233"
OTHER = "dev000000000000000000234"
# A window well in the past, so now() never cuts it short.
T0 = datetime(2026, 1, 5, 10, 0, tzinfo=timezone.utc)

ROLLUP_COLUMNS = (
    "bucket timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,"
    " sum_double double precision, n_double bigint, min_double double precision,"
    " max_double double precision, last_double double precision, last_string text,"
    " last_bool boolean, n_rows bigint"
)
SIGNATURE = ("public.telemetry_carried(timestamp with time zone, timestamp with time zone, interval,"
             " text[], text[])")


def minutes(n):
    return timedelta(minutes=n)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class CarriedBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s) IS NOT NULL;", (SIGNATURE,))
        if not self.cur.fetchone()[0]:
            self.skipTest("0233 is not applied to this database")
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
        self.person(OPERATOR_ID, "Operator")
        self.person(NO_ROLE_ID)

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def bucket(self, rollup, at, value=None, *, n=1, low=None, high=None, total=None, last=None,
               text=None, flag=None, metric="Spindle/LOAD", asset=DEVICE):
        """One rollup bucket. A numeric one holds `n` readings averaging `value` unless `total` is
        given, between `low` and `high`, ending at `last`."""
        numeric = value is not None or total is not None
        self.cur.execute(
            f"INSERT INTO timescale.{rollup} (bucket, asset_id, metric_name, sum_double, n_double,"
            " min_double, max_double, last_double, last_string, last_bool, n_rows)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);",
            (at, asset, metric,
             (total if total is not None else value * n) if numeric else None,
             n if numeric else 0,
             (low if low is not None else value) if numeric else None,
             (high if high is not None else value) if numeric else None,
             (last if last is not None else value) if numeric else None,
             text, flag, n),
        )

    def person(self, user_id, role=None):
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (user_id, f"{user_id}@history-carried.test"),
        )
        if role:
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id)"
                " SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    def as_person(self, user_id, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id` (or as anon). A refusal rolls
        back to the savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT carried_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
            self.columns = [c.name for c in self.cur.description or ()]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT carried_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT carried_call;")
        return rows

    def read(self, start, end, bucket="1 minute", assets=(DEVICE,), metrics=("Spindle/LOAD",),
             user_id=OPERATOR_ID, role="authenticated"):
        """The rows as dicts, in the function's order."""
        rows = self.as_person(
            user_id,
            "SELECT * FROM public.telemetry_carried(%s, %s, %s::interval, %s, %s);",
            (start, end, bucket, list(assets), list(metrics)), role=role,
        )
        return [dict(zip(self.columns, r)) for r in rows]

    def by_bucket(self, rows, metric="Spindle/LOAD"):
        return {r["bucket_ts"]: r for r in rows if r["metric_name"] == metric}


class CarriedForward(CarriedBase):
    def test_a_quiet_bucket_carries_the_last_value_and_says_so(self):
        self.bucket("telemetry_1m", T0, 5, n=2, low=4, high=6, last=6)
        self.bucket("telemetry_1m", T0 + minutes(3), 8)
        rows = self.by_bucket(self.read(T0, T0 + minutes(5)))
        self.assertEqual(sorted(rows), [T0 + minutes(i) for i in range(5)])
        self.assertFalse(rows[T0]["is_carried"])
        self.assertEqual((rows[T0]["avg_double"], rows[T0]["min_double"], rows[T0]["max_double"],
                          rows[T0]["last_double"], rows[T0]["n_rows"]), (5, 4, 6, 6, 2))
        for quiet in (T0 + minutes(1), T0 + minutes(2)):
            with self.subTest(bucket=quiet):
                r = rows[quiet]
                self.assertTrue(r["is_carried"])
                self.assertEqual(r["n_rows"], 0)
                # The last value, not the bucket's average: under report-by-exception it is what held.
                self.assertEqual((r["avg_double"], r["min_double"], r["max_double"], r["last_double"]),
                                 (6, 6, 6, 6))
        self.assertEqual(rows[T0 + minutes(3)]["last_double"], 8)
        self.assertFalse(rows[T0 + minutes(3)]["is_carried"])
        self.assertEqual(rows[T0 + minutes(4)]["last_double"], 8)
        self.assertTrue(rows[T0 + minutes(4)]["is_carried"])

    def test_a_state_and_a_flag_are_carried_too(self):
        self.bucket("telemetry_1m", T0, text="ACTIVE", metric="Controller/EXECUTION")
        self.bucket("telemetry_1m", T0 + minutes(2), text="READY", metric="Controller/EXECUTION")
        self.bucket("telemetry_1m", T0, flag=True, metric="Controller/EMERGENCY_STOP")
        rows = self.read(T0, T0 + minutes(4), metrics=("Controller/EXECUTION", "Controller/EMERGENCY_STOP"))
        states = self.by_bucket(rows, "Controller/EXECUTION")
        self.assertEqual([states[T0 + minutes(i)]["last_string"] for i in range(4)],
                         ["ACTIVE", "ACTIVE", "READY", "READY"])
        self.assertEqual([states[T0 + minutes(i)]["is_carried"] for i in range(4)], [False, True, False, True])
        self.assertIsNone(states[T0 + minutes(1)]["avg_double"])
        flags = self.by_bucket(rows, "Controller/EMERGENCY_STOP")
        self.assertEqual([flags[T0 + minutes(i)]["last_bool"] for i in range(4)], [True] * 4)

    def test_the_rows_are_in_series_then_time_order(self):
        self.bucket("telemetry_1m", T0, 1, metric="B/SECOND")
        self.bucket("telemetry_1m", T0, 2, metric="A/FIRST")
        self.bucket("telemetry_1m", T0, 3, asset=OTHER, metric="A/FIRST")
        rows = self.read(T0, T0 + minutes(2), assets=(OTHER, DEVICE), metrics=("B/SECOND", "A/FIRST"))
        self.assertEqual([(r["asset_id"], r["metric_name"], r["bucket_ts"]) for r in rows], [
            (DEVICE, "A/FIRST", T0), (DEVICE, "A/FIRST", T0 + minutes(1)),
            (DEVICE, "B/SECOND", T0), (DEVICE, "B/SECOND", T0 + minutes(1)),
            (OTHER, "A/FIRST", T0), (OTHER, "A/FIRST", T0 + minutes(1)),
        ])


class Seeding(CarriedBase):
    def test_a_series_quiet_all_window_is_seeded_from_before_it(self):
        self.bucket("telemetry_1m", T0 - minutes(45), 3)
        self.bucket("telemetry_1m", T0 - minutes(90), 99)
        rows = self.by_bucket(self.read(T0, T0 + minutes(3)))
        self.assertEqual([rows[T0 + minutes(i)]["last_double"] for i in range(3)], [3, 3, 3])
        self.assertTrue(all(r["is_carried"] for r in rows.values()))

    def test_a_reading_before_the_lookback_is_found_one_series_at_a_time(self):
        # 288 one-minute buckets is under five hours; this one is two days back.
        self.bucket("telemetry_1m", T0 - timedelta(days=2), 7)
        self.bucket("telemetry_1m", T0 - minutes(30), 1, metric="Other/QUICK")
        rows = self.read(T0, T0 + minutes(2), metrics=("Spindle/LOAD", "Other/QUICK"))
        self.assertEqual([r["last_double"] for r in rows if r["metric_name"] == "Spindle/LOAD"], [7, 7])
        self.assertEqual([r["last_double"] for r in rows if r["metric_name"] == "Other/QUICK"], [1, 1])

    def test_a_series_silent_longer_than_raw_retention_still_seeds(self):
        # Raw is dropped after 14 days by default; the rollups outlive it. A newer raw row the
        # function would take if it read raw is there to prove it does not.
        self.bucket("telemetry_1m", T0 - timedelta(days=30), 42.5)
        self.cur.execute("INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_double)"
                         " VALUES (%s, %s, 'Spindle/LOAD', -1);", (T0 - minutes(5), DEVICE))
        rows = self.read(T0, T0 + minutes(2))
        self.assertEqual([r["last_double"] for r in rows], [42.5, 42.5])

    def test_a_series_older_than_its_rollup_keeps_seeds_from_the_hourly_one(self):
        # Kept in telemetry_1h alone, as a reading older than the 1-minute rollup's 180 days is.
        self.bucket("telemetry_1h", T0 - timedelta(days=200), text="MANUAL", metric="Controller/MODE")
        rows = self.read(T0, T0 + minutes(3), metrics=("Controller/MODE",))
        self.assertEqual([r["last_string"] for r in rows], ["MANUAL"] * 3)

    def test_the_seed_is_the_newest_value_before_the_window(self):
        self.bucket("telemetry_1m", T0 - minutes(20), 10)
        self.bucket("telemetry_1m", T0 - minutes(10), 20)
        self.bucket("telemetry_1m", T0, 30)
        rows = self.by_bucket(self.read(T0 + minutes(1), T0 + minutes(3)))
        self.assertEqual([rows[T0 + minutes(i)]["last_double"] for i in (1, 2)], [30, 30])
        rows = self.by_bucket(self.read(T0 - minutes(5), T0 - minutes(3)))
        self.assertEqual([rows[T0 - minutes(i)]["last_double"] for i in (5, 4)], [20, 20])

    def test_a_series_with_nothing_to_carry_has_no_row(self):
        self.bucket("telemetry_1m", T0 + minutes(2), 4)
        rows = self.read(T0, T0 + minutes(4), metrics=("Spindle/LOAD", "Never/PUBLISHED"))
        self.assertEqual([r["bucket_ts"] for r in rows], [T0 + minutes(2), T0 + minutes(3)])
        self.assertEqual({r["metric_name"] for r in rows}, {"Spindle/LOAD"})


class Buckets(CarriedBase):
    def test_a_wider_bucket_combines_the_rollup_s_buckets(self):
        # Ten minutes reads the 5-minute rollup: two of its buckets make one here. The average is
        # the readings', weighted by how many each held, not the mean of the two averages.
        self.bucket("telemetry_5m", T0, total=10, n=2, low=4, high=6, last=6)
        self.bucket("telemetry_5m", T0 + minutes(5), total=30, n=3, low=8, high=12, last=9)
        # A 1-minute bucket the 10-minute read must not take.
        self.bucket("telemetry_1m", T0 + minutes(1), 1000)
        rows = self.read(T0, T0 + minutes(10), bucket="10 minutes")
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["bucket_ts"], r["avg_double"], r["min_double"], r["max_double"],
                          r["last_double"], r["n_rows"], r["is_carried"]),
                         (T0, 8, 4, 12, 9, 5, False))

    def test_each_width_reads_its_own_rollup(self):
        self.bucket("telemetry_1m", T0, 1)
        self.bucket("telemetry_5m", T0, 5)
        self.bucket("telemetry_1h", T0, 60)
        for bucket, expected in (("1 minute", 1), ("7 minutes", 1), ("5 minutes", 5), ("15 minutes", 5),
                                 ("1 hour", 60), ("1 day", 60)):
            with self.subTest(bucket=bucket):
                rows = self.read(T0, T0 + minutes(1), bucket=bucket)
                self.assertEqual(rows[0]["avg_double"], expected)

    def test_a_window_opening_inside_a_bucket_starts_on_the_bucket(self):
        self.bucket("telemetry_5m", T0, 2)
        rows = self.read(T0 + minutes(3), T0 + minutes(12), bucket="5 minutes")
        self.assertEqual([r["bucket_ts"] for r in rows], [T0, T0 + minutes(5), T0 + minutes(10)])

    def test_nothing_is_carried_past_now(self):
        self.cur.execute("SELECT date_trunc('minute', now());")
        now = self.cur.fetchone()[0]
        self.bucket("telemetry_1m", now - minutes(3), 4)
        rows = self.read(now - minutes(3), now + timedelta(hours=1))
        self.assertEqual([r["bucket_ts"] for r in rows], [now - minutes(i) for i in (3, 2, 1, 0)])

    def test_the_row_shape(self):
        self.cur.execute("SELECT pg_get_function_result(%s::regprocedure), pg_get_function_arguments(%s::regprocedure);",
                         (SIGNATURE, SIGNATURE))
        result, arguments = self.cur.fetchone()
        self.assertEqual(result, (
            "TABLE(bucket_ts timestamp with time zone, asset_id text, metric_name text,"
            " avg_double double precision, min_double double precision, max_double double precision,"
            " last_double double precision, last_string text, last_bool boolean, n_rows bigint,"
            " is_carried boolean)"))
        self.assertEqual(arguments, (
            "from_ts timestamp with time zone, to_ts timestamp with time zone, bucket interval,"
            " asset_ids text[], metric_names text[]"))


class Refusals(CarriedBase):
    def test_bad_bounds_are_refused_before_any_read(self):
        cases = {
            "a window that ends first": (T0, T0 - minutes(1), "1 minute", [DEVICE], ["m"]),
            "an empty window": (T0, T0, "1 minute", [DEVICE], ["m"]),
            "a bucket under a minute": (T0, T0 + minutes(5), "30 seconds", [DEVICE], ["m"]),
            "a bucket of seconds": (T0, T0 + minutes(5), "90 seconds", [DEVICE], ["m"]),
            "a bucket of months": (T0, T0 + timedelta(days=400), "1 month", [DEVICE], ["m"]),
            "no assets": (T0, T0 + minutes(5), "1 minute", None, ["m"]),
            "no metrics": (T0, T0 + minutes(5), "1 minute", [DEVICE], None),
            "over 50,000 rows": (T0, T0 + timedelta(days=35), "1 minute", [DEVICE], ["m"]),
        }
        # Every foreign relation is gone, so a refusal that came after a read would raise otherwise.
        for rollup in ("telemetry_1m", "telemetry_5m", "telemetry_1h"):
            self.cur.execute(f"REVOKE SELECT ON timescale.{rollup} FROM authenticated;")
        for name, args in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.as_person(OPERATOR_ID,
                                   "SELECT * FROM public.telemetry_carried(%s, %s, %s::interval, %s, %s);", args)

    def test_50000_rows_is_allowed(self):
        rows = self.read(T0, T0 + timedelta(minutes=25000), assets=(DEVICE, OTHER))
        self.assertEqual(rows, [])


class WhoMayRead(CarriedBase):
    def test_whoever_reads_the_telemetry_views_may_call_it(self):
        self.bucket("telemetry_1m", T0, 5)
        for label, user_id, role in (("an Operator", OPERATOR_ID, "authenticated"),
                                     ("a person with no role", NO_ROLE_ID, "authenticated"),
                                     ("service_role", NO_ROLE_ID, "service_role")):
            with self.subTest(caller=label):
                self.assertEqual(len(self.read(T0, T0 + minutes(2), user_id=user_id, role=role)), 2)
        self.cur.execute("SELECT has_table_privilege('authenticated', 'timescale.telemetry_1m', 'SELECT');")
        self.assertTrue(self.cur.fetchone()[0])

    def test_anon_may_not(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(T0, T0 + minutes(2), user_id=NO_ROLE_ID, role="anon")

    def test_it_reads_as_the_caller(self):
        # A caller without SELECT on the rollups gets nothing through the function.
        self.cur.execute("REVOKE SELECT ON timescale.telemetry_1m FROM authenticated;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(T0, T0 + minutes(2))
        self.cur.execute("SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = %s::regprocedure;",
                         (SIGNATURE,))
        self.assertEqual(self.cur.fetchone(), (False, "s", ["search_path=public"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
