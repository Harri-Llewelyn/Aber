# suite:
#   lanes: db
#   why: 0276's telemetry_carried_by_group(), over local tables standing in for the historian's
#     hourly rollup: each group's mean across its devices that have a value in a bucket, its total
#     only where every device has one (a carried value counts, a device that never reports keeps the
#     total away), how many had a reading, no row for a text or a flag, bad bounds, lists of
#     different lengths and more than 50,000 devices times buckets refused before any read, and it
#     reads as the caller.

"""
History folds one metric across the devices of each group (0276).

    python supabase/migrations/test_history_folds_one_metric_across_the_devices_of_each_group.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. telemetry_carried_by_group() returns one row per group per bucket for one numeric
metric: the mean across the group's devices that have a value in the bucket, carried or measured, and
the total, which is there only where EVERY device of the group has one. A partial sum reads as a real
one, so it is null. `members` is the group's devices as they were asked for, `with_value` how many had
a value, `measured` how many had a reading rather than a carried value. A device that never reports
the metric keeps its group from ever having a total. A text or a flag metric has no row. Bad bounds,
buckets, lists of different lengths, a missing list or metric, and more than 50,000 devices times
buckets are refused before any read. Whoever reads the telemetry views may call it, and anon may not.

The db lane has no historian, so local tables stand in for the three foreign rollups, inside the
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

OPERATOR_ID = "a0d17070-0000-4000-8000-0000000276a1"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000276a2"

A, B, C, D = (f"dev00000000000000000027{n}" for n in "6789")
METRIC = "Spindle/LOAD"
# A Monday in January, well in the past, so now() never cuts a window short.
DAY0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
HOUR = "1 hour"

ROLLUP_COLUMNS = (
    "bucket timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,"
    " sum_double double precision, n_double bigint, min_double double precision,"
    " max_double double precision, last_double double precision, last_string text,"
    " last_bool boolean, n_rows bigint"
)
SIGNATURE = ("public.telemetry_carried_by_group(timestamp with time zone, timestamp with time zone,"
             " interval, text[], text[], text)")
CALL = "SELECT * FROM public.telemetry_carried_by_group(%s, %s, %s::interval, %s, %s, %s);"


def hours(n):
    return timedelta(hours=n)


def days(n):
    return timedelta(days=n)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class GroupBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s) IS NOT NULL;", (SIGNATURE,))
        if not self.cur.fetchone()[0]:
            self.skipTest("0276 is not applied to this database")
        # The historian's relations as local tables, as the foreign ones are shaped and granted.
        for rollup in ("telemetry_1m", "telemetry_5m", "telemetry_1h"):
            self.cur.execute(f"DROP FOREIGN TABLE timescale.{rollup} CASCADE;"
                             f"CREATE TABLE timescale.{rollup} ({ROLLUP_COLUMNS});"
                             f"GRANT SELECT ON timescale.{rollup} TO authenticated, service_role;")
        self.person(OPERATOR_ID, "Operator")
        self.person(NO_ROLE_ID)

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def hour(self, at, asset, value=None, *, n=1, text=None, flag=None, metric=METRIC):
        """One telemetry_1h bucket: `n` readings averaging `value`, or a text or a flag."""
        numeric = value is not None
        self.cur.execute(
            "INSERT INTO timescale.telemetry_1h (bucket, asset_id, metric_name, sum_double, n_double,"
            " min_double, max_double, last_double, last_string, last_bool, n_rows)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);",
            (at, asset, metric, value * n if numeric else None, n if numeric else 0,
             value, value, value, text, flag, n),
        )

    def person(self, user_id, role=None):
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (user_id, f"{user_id}@history-by-group.test"),
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
        self.cur.execute("SAVEPOINT group_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
            self.columns = [c.name for c in self.cur.description or ()]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT group_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT group_call;")
        return rows

    def read(self, start, end, groups, *, metric=METRIC, bucket=HOUR, user_id=OPERATOR_ID, role="authenticated"):
        """The rows as dicts, in the function's order. `groups` is a dict of group key to its devices."""
        assets = [a for g, members in groups.items() for a in members]
        keys = [g for g, members in groups.items() for _ in members]
        rows = self.as_person(user_id, CALL, (start, end, bucket, assets, keys, metric), role=role)
        return [dict(zip(self.columns, r)) for r in rows]

    def by_hour(self, rows, group):
        return {r["bucket_ts"]: r for r in rows if r["group_key"] == group}


class TheMeanAndTheTotal(GroupBase):
    def test_a_group_is_the_mean_and_the_total_of_its_devices_in_each_bucket(self):
        for asset, value in ((A, 10), (B, 20), (C, 30)):
            self.hour(DAY0 + hours(10), asset, value)
        rows = self.read(DAY0 + hours(10), DAY0 + hours(11), {"cell1": [A, B, C]})
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["group_key"], row["bucket_ts"]), ("cell1", DAY0 + hours(10)))
        self.assertEqual((row["mean_double"], row["total_double"]), (20, 60))
        self.assertEqual((row["members"], row["with_value"], row["measured"]), (3, 3, 3))

    def test_a_total_is_withheld_where_a_device_has_no_value_and_the_mean_is_of_the_rest(self):
        # C reports from 11:00; at 10:00 it has no value to carry, so the sum of two would read as the cell's.
        self.hour(DAY0 + hours(10), A, 10)
        self.hour(DAY0 + hours(10), B, 20)
        self.hour(DAY0 + hours(11), C, 30)
        rows = self.by_hour(self.read(DAY0 + hours(10), DAY0 + hours(12), {"cell1": [A, B, C]}), "cell1")
        ten, eleven = rows[DAY0 + hours(10)], rows[DAY0 + hours(11)]
        self.assertEqual((ten["mean_double"], ten["total_double"], ten["with_value"], ten["members"]), (15, None, 2, 3))
        # At 11:00 A and B carry their values and C has one of its own: all three, so a total.
        self.assertEqual((eleven["mean_double"], eleven["total_double"], eleven["with_value"]), (20, 60, 3))

    def test_a_carried_value_counts_as_a_value_and_measured_says_which_were_readings(self):
        self.hour(DAY0 + hours(10), A, 10)
        self.hour(DAY0 + hours(10), B, 20)
        self.hour(DAY0 + hours(11), A, 14)
        rows = self.by_hour(self.read(DAY0 + hours(10), DAY0 + hours(13), {"cell1": [A, B]}), "cell1")
        # 11:00: A read 14, B carries 20. 12:00: both carry, so the bucket is one nobody reported in.
        self.assertEqual((rows[DAY0 + hours(11)]["total_double"], rows[DAY0 + hours(11)]["measured"]), (34, 1))
        self.assertEqual((rows[DAY0 + hours(12)]["total_double"], rows[DAY0 + hours(12)]["measured"]), (34, 0))
        self.assertEqual(rows[DAY0 + hours(12)]["with_value"], 2)

    def test_a_device_that_never_reports_keeps_its_group_from_ever_having_a_total(self):
        self.hour(DAY0 + hours(10), A, 10)
        rows = self.read(DAY0 + hours(10), DAY0 + hours(12), {"cell1": [A, "dev000000000000000000000"]})
        self.assertEqual([(r["mean_double"], r["total_double"], r["members"], r["with_value"]) for r in rows],
                         [(10, None, 2, 1), (10, None, 2, 1)])

    def test_each_group_has_its_own_rows_in_group_then_bucket_order(self):
        self.hour(DAY0 + hours(10), A, 10)
        self.hour(DAY0 + hours(10), B, 90)
        self.hour(DAY0 + hours(11), B, 70)
        rows = self.read(DAY0 + hours(10), DAY0 + hours(12), {"z": [B], "a": [A]})
        self.assertEqual([(r["group_key"], r["bucket_ts"], r["mean_double"]) for r in rows],
                         [("a", DAY0 + hours(10), 10), ("a", DAY0 + hours(11), 10),
                          ("z", DAY0 + hours(10), 90), ("z", DAY0 + hours(11), 70)])

    def test_a_group_of_one_has_its_value_as_both(self):
        self.hour(DAY0 + hours(10), A, 12)
        row = self.read(DAY0 + hours(10), DAY0 + hours(11), {"solo": [A]})[0]
        self.assertEqual((row["mean_double"], row["total_double"], row["members"]), (12, 12, 1))

    def test_a_device_named_under_two_groups_counts_in_each(self):
        self.hour(DAY0 + hours(10), A, 10)
        self.hour(DAY0 + hours(10), B, 20)
        rows = self.read(DAY0 + hours(10), DAY0 + hours(11), {"one": [A, B], "two": [B]})
        self.assertEqual([(r["group_key"], r["total_double"]) for r in rows], [("one", 30), ("two", 20)])

    def test_only_the_devices_asked_for_and_the_metric_are_read(self):
        self.hour(DAY0 + hours(10), A, 10)
        self.hour(DAY0 + hours(10), D, 999)
        self.hour(DAY0 + hours(10), A, 999, metric="Spindle/SPEED")
        rows = self.read(DAY0 + hours(10), DAY0 + hours(11), {"cell1": [A]})
        self.assertEqual([r["total_double"] for r in rows], [10])

    def test_a_text_or_a_flag_metric_has_no_row(self):
        self.hour(DAY0 + hours(10), A, text="ACTIVE", metric="Controller/EXECUTION")
        self.hour(DAY0 + hours(10), A, flag=True, metric="Controller/EMERGENCY_STOP")
        for metric in ("Controller/EXECUTION", "Controller/EMERGENCY_STOP"):
            with self.subTest(metric=metric):
                self.assertEqual(self.read(DAY0 + hours(10), DAY0 + hours(12), {"cell1": [A]}, metric=metric), [])

    def test_a_window_with_no_reading_has_no_row(self):
        self.assertEqual(self.read(DAY0, DAY0 + days(1), {"cell1": [A, B]}), [])

    def test_no_row_before_every_device_has_a_first_value_has_a_total(self):
        self.hour(DAY0 + hours(12), A, 10)
        rows = self.read(DAY0 + hours(10), DAY0 + hours(14), {"cell1": [A, B]})
        self.assertEqual([r["total_double"] for r in rows], [None, None])
        self.assertEqual([r["bucket_ts"] for r in rows], [DAY0 + hours(12), DAY0 + hours(13)])

    def test_the_row_shape(self):
        self.hour(DAY0 + hours(10), A, 5)
        self.read(DAY0 + hours(10), DAY0 + hours(11), {"cell1": [A]})
        self.assertEqual(self.columns, ["group_key", "bucket_ts", "mean_double", "total_double",
                                        "members", "with_value", "measured"])


class Refusals(GroupBase):
    def test_bad_arguments_are_refused_before_any_read(self):
        end = DAY0 + hours(5)
        cases = {
            "a window that ends first": (DAY0, DAY0 - hours(1), HOUR, ["a"], ["g"], METRIC),
            "an empty window": (DAY0, DAY0, HOUR, ["a"], ["g"], METRIC),
            "a bucket under a minute": (DAY0, end, "30 seconds", ["a"], ["g"], METRIC),
            "a bucket of months": (DAY0, end, "1 month", ["a"], ["g"], METRIC),
            "no assets": (DAY0, end, HOUR, None, ["g"], METRIC),
            "no group keys": (DAY0, end, HOUR, ["a"], None, METRIC),
            "no metric": (DAY0, end, HOUR, ["a"], ["g"], None),
            "more assets than group keys": (DAY0, end, HOUR, ["a", "b"], ["g"], METRIC),
            "more group keys than assets": (DAY0, end, HOUR, ["a"], ["g", "h"], METRIC),
            "over 50,000 devices times buckets": (DAY0, DAY0 + days(366), HOUR, list("abcdef"), ["g"] * 6, METRIC),
        }
        # The caller may read no rollup, so a refusal that came after a read would raise otherwise.
        self.cur.execute("REVOKE SELECT ON timescale.telemetry_1m, timescale.telemetry_5m, timescale.telemetry_1h"
                         " FROM authenticated;")
        for name, (start, stop, bucket, assets, keys, metric) in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.as_person(OPERATOR_ID, CALL, (start, stop, bucket, assets, keys, metric))

    def test_the_length_refusal_names_the_counts(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as raised:
            self.as_person(OPERATOR_ID, CALL, (DAY0, DAY0 + hours(5), HOUR, ["a", "b", "c"], ["g"], METRIC))
        self.assertIn("3 assets but 1 group keys", str(raised.exception))

    def test_50000_rows_is_allowed(self):
        # 2,500 hourly buckets of 20 devices, in 4 groups.
        assets = [f"dev{i:021d}" for i in range(20)]
        keys = [f"cell{i // 5}" for i in range(20)]
        rows = self.as_person(OPERATOR_ID, CALL, (DAY0, DAY0 + hours(2500), HOUR, assets, keys, METRIC))
        self.assertEqual(rows, [])


class WhoMayRead(GroupBase):
    def test_whoever_reads_the_telemetry_views_may_call_it(self):
        self.hour(DAY0 + hours(10), A, 5)
        for label, user_id, role in (("an Operator", OPERATOR_ID, "authenticated"),
                                     ("a person with no role", NO_ROLE_ID, "authenticated"),
                                     ("service_role", NO_ROLE_ID, "service_role")):
            with self.subTest(caller=label):
                self.assertEqual(len(self.read(DAY0 + hours(10), DAY0 + hours(11), {"cell1": [A]}, user_id=user_id, role=role)), 1)

    def test_anon_may_not(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(DAY0 + hours(10), DAY0 + hours(11), {"cell1": [A]}, user_id=NO_ROLE_ID, role="anon")

    def test_it_reads_as_the_caller(self):
        # A caller without SELECT on the rollup gets nothing through the function.
        self.cur.execute("REVOKE SELECT ON timescale.telemetry_1h FROM authenticated;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(DAY0 + hours(10), DAY0 + hours(11), {"cell1": [A]})
        self.cur.execute("SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = %s::regprocedure;",
                         (SIGNATURE,))
        self.assertEqual(self.cur.fetchone(), (False, "s", ["search_path=public"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
