"""
History counts where readings arrived (0245).

    python supabase/migrations/test_history_counts_where_readings_arrived.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. telemetry_coverage() returns one row per device asked for: its readings in each
block of the window as an array, oldest first, 0 for a block with none, with the first block's start
and the width. A block the per-device rollup's own width (5 minutes, 1 hour) is read as it is; a
wider one, a whole number of 5 minutes, for 40 devices or fewer, is summed from the widest rollup
that divides it. More than 40 devices take the rollups' own widths only, and nothing is finer than
5 minutes.
Each row carries what the rollup has counted (computed_from to computed_to), so a block not counted
yet is told from one with no reading. Bounds are refused before any read. Whoever reads the
telemetry views may call it, and anon may not.

The db lane has no historian, so local tables stand in for the foreign device rollups and the
coverage view, inside the transaction. EVERY TEST ROLLS BACK.
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

OPERATOR_ID = "a0d17070-0000-4000-8000-0000000245a1"

DEVICE = "dev000000000000000000245"
OTHER = "dev000000000000000000246"
QUIET = "dev000000000000000000247"
# A window well in the past, so now() never cuts it short.
T0 = datetime(2026, 1, 5, 10, 0, tzinfo=timezone.utc)
COUNTED_FROM = datetime(2025, 12, 1, tzinfo=timezone.utc)
COUNTED_TO = datetime(2026, 2, 1, tzinfo=timezone.utc)

SIGNATURE = ("public.telemetry_coverage(timestamp with time zone, timestamp with time zone, interval, text[])")


def minutes(n):
    return timedelta(minutes=n)


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class CoverageBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s) IS NOT NULL;", (SIGNATURE,))
        if not self.cur.fetchone()[0]:
            self.skipTest("0245 is not applied to this database")
        # The historian's relations as local tables, shaped and granted as the foreign ones are.
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry_device_5m CASCADE;"
            "CREATE TABLE timescale.telemetry_device_5m (bucket timestamptz NOT NULL, asset_id text NOT NULL, n_rows numeric);"
            "GRANT SELECT ON timescale.telemetry_device_5m TO authenticated, service_role;"
            "DROP FOREIGN TABLE timescale.telemetry_device_1h CASCADE;"
            "CREATE TABLE timescale.telemetry_device_1h (bucket timestamptz NOT NULL, asset_id text NOT NULL, n_rows numeric);"
            "GRANT SELECT ON timescale.telemetry_device_1h TO authenticated, service_role;"
        )
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry_device_coverage CASCADE;"
            "CREATE TABLE timescale.telemetry_device_coverage (relation text, computed_from timestamptz,"
            " computed_to timestamptz, complete boolean);"
            "GRANT SELECT ON timescale.telemetry_device_coverage TO authenticated, service_role;"
        )
        for relation in ("telemetry_device_5m", "telemetry_device_1h"):
            self.cur.execute("INSERT INTO timescale.telemetry_device_coverage VALUES (%s, %s, %s, false);",
                             (relation, COUNTED_FROM, COUNTED_TO))
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (OPERATOR_ID, f"{OPERATOR_ID}@history-coverage.test"),
        )
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) SELECT %s, id FROM public.roles"
                         " WHERE name = 'Operator' ON CONFLICT DO NOTHING;", (OPERATOR_ID,))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def count(self, rollup, at, n, asset=DEVICE):
        """One bucket of `rollup`, telemetry_device_5m or telemetry_device_1h, holding `n` readings.
        Literal SQL for each: the source scan flags a statement built from a name."""
        if rollup == "telemetry_device_5m":
            self.cur.execute("INSERT INTO timescale.telemetry_device_5m (bucket, asset_id, n_rows) VALUES (%s, %s, %s);",
                             (at, asset, n))
        elif rollup == "telemetry_device_1h":
            self.cur.execute("INSERT INTO timescale.telemetry_device_1h (bucket, asset_id, n_rows) VALUES (%s, %s, %s);",
                             (at, asset, n))
        else:
            raise ValueError(rollup)

    def call(self, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for an Operator's token (or as `role`). A refusal rolls back
        to the savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT coverage_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": OPERATOR_ID, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall()
            self.columns = [c.name for c in self.cur.description]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT coverage_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT coverage_call;")
        return rows

    def read(self, start, end, block="5 minutes", assets=(DEVICE,), role="authenticated"):
        """The rows as dicts keyed by device."""
        rows = self.call("SELECT * FROM public.telemetry_coverage(%s, %s, %s::interval, %s);",
                         (start, end, block, list(assets)), role=role)
        return {r[0]: dict(zip(self.columns, r)) for r in rows}


class Counts(CoverageBase):
    def test_each_block_holds_its_readings_and_an_empty_one_0(self):
        # By hand: 5-minute blocks from T0, readings in the first, third and fourth.
        for i, n in ((0, 12), (2, 7), (3, 1)):
            self.count("telemetry_device_5m", T0 + minutes(5 * i), n)
        row = self.read(T0, T0 + minutes(25))[DEVICE]
        self.assertEqual(row["counts"], [12, 0, 7, 1, 0])
        self.assertEqual((row["first_block"], row["block_width"]), (T0, timedelta(minutes=5)))

    def test_a_device_with_every_block_filled_reads_as_it_came(self):
        for i in range(6):
            self.count("telemetry_device_5m", T0 + minutes(5 * i), 10 + i)
        self.assertEqual(self.read(T0, T0 + minutes(30))[DEVICE]["counts"], [10, 11, 12, 13, 14, 15])

    def test_every_device_asked_for_has_a_row_and_one_with_no_readings_is_all_0(self):
        self.count("telemetry_device_5m", T0, 3)
        self.count("telemetry_device_5m", T0 + minutes(5), 4, asset=OTHER)
        rows = self.read(T0, T0 + minutes(15), assets=(QUIET, OTHER, DEVICE, DEVICE))
        self.assertEqual(sorted(rows), sorted([DEVICE, OTHER, QUIET]))
        self.assertEqual(rows[DEVICE]["counts"], [3, 0, 0])
        self.assertEqual(rows[OTHER]["counts"], [0, 4, 0])
        self.assertEqual(rows[QUIET]["counts"], [0, 0, 0])

    def test_the_blocks_at_the_window_s_edges(self):
        # A window opening inside a block starts on it; a bucket at or after the end is outside.
        self.count("telemetry_device_5m", T0, 2)
        self.count("telemetry_device_5m", T0 + minutes(10), 5)
        self.count("telemetry_device_5m", T0 + minutes(15), 99)
        row = self.read(T0 + minutes(3), T0 + minutes(12))[DEVICE]
        self.assertEqual(row["first_block"], T0)
        self.assertEqual(row["counts"], [2, 0, 5])
        row = self.read(T0 + minutes(3), T0 + minutes(15))[DEVICE]
        self.assertEqual(row["counts"], [2, 0, 5])

    def test_the_hourly_rollup_is_read_for_hours(self):
        self.count("telemetry_device_5m", T0, 1000)
        self.count("telemetry_device_1h", T0, 60)
        self.count("telemetry_device_1h", T0 + timedelta(hours=2), 61)
        self.assertEqual(self.read(T0, T0 + timedelta(hours=3), block="1 hour")[DEVICE]["counts"], [60, 0, 61])


class Summed(CoverageBase):
    def test_a_small_selection_sums_the_widest_rollup_that_divides_the_block(self):
        self.count("telemetry_device_5m", T0, 2)
        self.count("telemetry_device_5m", T0 + minutes(5), 3)
        self.count("telemetry_device_5m", T0 + minutes(20), 4)
        self.count("telemetry_device_1h", T0, 500)
        self.count("telemetry_device_1h", T0 + timedelta(hours=2), 7)
        self.assertEqual(self.read(T0, T0 + minutes(30), block="10 minutes")[DEVICE]["counts"], [5, 0, 4])
        # Two hours read the hourly rollup, never the 5-minute one.
        self.assertEqual(self.read(T0, T0 + timedelta(hours=4), block="2 hours")[DEVICE]["counts"], [500, 7])

    def test_more_than_40_devices_read_only_the_rollups_own_widths(self):
        many = [f"dev{n:021x}" for n in range(1, 42)]
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.read(T0, T0 + minutes(30), block="10 minutes", assets=many)
        self.assertEqual(len(self.read(T0, T0 + minutes(30), block="5 minutes", assets=many)), 41)
        self.assertEqual(len(self.read(T0, T0 + minutes(30), block="10 minutes", assets=many[:40])), 40)


class NotCountedYet(CoverageBase):
    def test_each_row_says_what_its_rollup_has_counted(self):
        self.cur.execute("UPDATE timescale.telemetry_device_coverage SET computed_from = %s, computed_to = %s, complete = %s"
                         " WHERE relation = 'telemetry_device_1h';", (T0 + timedelta(hours=1), T0 + timedelta(hours=2), True))
        five = self.read(T0, T0 + minutes(10))[DEVICE]
        self.assertEqual((five["computed_from"], five["computed_to"], five["complete"]), (COUNTED_FROM, COUNTED_TO, False))
        hour = self.read(T0, T0 + timedelta(hours=3), block="1 hour")[DEVICE]
        self.assertEqual((hour["computed_from"], hour["computed_to"], hour["complete"]),
                         (T0 + timedelta(hours=1), T0 + timedelta(hours=2), True))

class Refusals(CoverageBase):
    def test_bad_bounds_are_refused_before_any_read(self):
        many = [f"dev{n:021x}" for n in range(1, 1002)]
        cases = {
            "a window that ends first": (T0, T0 - minutes(1), "5 minutes", [DEVICE]),
            "an empty window": (T0, T0, "5 minutes", [DEVICE]),
            "a block under a minute": (T0, T0 + minutes(5), "30 seconds", [DEVICE]),
            "a block of seconds": (T0, T0 + minutes(5), "90 seconds", [DEVICE]),
            "a block under 5 minutes": (T0, T0 + minutes(5), "2 minutes", [DEVICE]),
            "a block not whole 5 minutes": (T0, T0 + minutes(30), "7 minutes", [DEVICE]),
            "a block of months": (T0, T0 + timedelta(days=400), "1 month", [DEVICE]),
            "no devices": (T0, T0 + minutes(5), "5 minutes", None),
            "more than 1,000 devices": (T0, T0 + minutes(5), "5 minutes", many),
            "over 360,000 buckets": (T0, T0 + timedelta(days=30), "1 hour", many[:600]),
            "41 devices summed": (T0, T0 + minutes(30), "10 minutes", many[:41]),
        }
        # The caller may read no rollup, so a refusal that came after a read would raise otherwise.
        self.cur.execute("REVOKE SELECT ON timescale.telemetry_device_5m, timescale.telemetry_device_1h,"
                         " timescale.telemetry_device_coverage FROM authenticated;")
        for name, args in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.call("SELECT * FROM public.telemetry_coverage(%s, %s, %s::interval, %s);", args)

    def test_1000_devices_over_26_hours_of_5_minute_blocks_is_allowed(self):
        many = [f"dev{n:021x}" for n in range(1, 1001)]
        self.assertEqual(len(self.read(T0, T0 + timedelta(hours=26), assets=many)), 1000)


class Shape(CoverageBase):
    def test_the_row_shape(self):
        self.cur.execute("SELECT pg_get_function_result(%s::regprocedure), pg_get_function_arguments(%s::regprocedure);",
                         (SIGNATURE, SIGNATURE))
        result, arguments = self.cur.fetchone()
        self.assertEqual(result, (
            "TABLE(asset_id text, first_block timestamp with time zone, block_width interval, counts integer[],"
            " computed_from timestamp with time zone, computed_to timestamp with time zone, complete boolean)"))
        self.assertEqual(arguments, (
            "from_ts timestamp with time zone, to_ts timestamp with time zone, block interval, asset_ids text[]"))

    def test_the_rollups_foreign_tables_fetch_10000_rows_at_a_time(self):
        self.conn.rollback()
        self.cur.execute("SELECT c.relname, t.ftoptions FROM pg_foreign_table t JOIN pg_class c ON c.oid = t.ftrelid"
                         " WHERE c.relname IN ('telemetry_device_5m', 'telemetry_device_1h') ORDER BY 1;")
        rows = self.cur.fetchall()
        self.assertEqual([r[0] for r in rows], ["telemetry_device_1h", "telemetry_device_5m"])
        for name, options in rows:
            with self.subTest(table=name):
                self.assertIn("fetch_size=10000", options)


class WhoMayRead(CoverageBase):
    def test_whoever_reads_the_telemetry_views_may_call_it(self):
        self.count("telemetry_device_5m", T0, 5)
        for role in ("authenticated", "service_role"):
            with self.subTest(caller=role):
                self.assertEqual(self.read(T0, T0 + minutes(10), role=role)[DEVICE]["counts"], [5, 0])

    def test_anon_may_not(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(T0, T0 + minutes(10), role="anon")

    def test_it_reads_as_the_caller(self):
        self.cur.execute("REVOKE SELECT ON timescale.telemetry_device_5m FROM authenticated;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(T0, T0 + minutes(10))
        self.cur.execute("SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = %s::regprocedure;", (SIGNATURE,))
        self.assertEqual(self.cur.fetchone(), (False, "s", ["search_path=public"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
