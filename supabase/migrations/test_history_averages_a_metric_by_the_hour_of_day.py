# suite:
#   lanes: db
#   why: 0265's telemetry_hour_of_day(), over local tables standing in for the historian's hourly
#     rollup: each device's mean at each hour of the day in the zone asked for, across the window's
#     days, a quiet hour counted as the value carried into it, every hour weighed alike, the hour
#     moving with the zone and with a clock change, no row for a text or a flag, an unknown zone,
#     bad bounds and more than 50,000 hours times devices refused before any read, and it reads as
#     the caller.

"""
History averages a metric by the hour of the day (0265).

    python supabase/migrations/test_history_averages_a_metric_by_the_hour_of_day.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. telemetry_hour_of_day() returns one row per device per hour of the day in the
time zone given: the mean of that hour across the window's days, from telemetry_carried() at one
hour. A quiet hour counts as the value carried into it, every hour weighs the same however many
readings it held, and a text or a flag metric has no row. The hour moves with the zone, and with a
clock change inside the window. An unknown zone, bad bounds and more than 50,000 hours times
devices are refused before any read. Whoever reads the telemetry views may call it, and anon may
not.

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

OPERATOR_ID = "a0d17070-0000-4000-8000-0000000265a1"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000265a2"

DEVICE = "dev000000000000000000265"
OTHER = "dev000000000000000000266"
METRIC = "Spindle/LOAD"
# A Monday in January, well in the past, so now() never cuts a window short. London is on GMT.
DAY0 = datetime(2026, 1, 5, tzinfo=timezone.utc)

ROLLUP_COLUMNS = (
    "bucket timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,"
    " sum_double double precision, n_double bigint, min_double double precision,"
    " max_double double precision, last_double double precision, last_string text,"
    " last_bool boolean, n_rows bigint"
)
SIGNATURE = ("public.telemetry_hour_of_day(timestamp with time zone, timestamp with time zone,"
             " text[], text, text)")


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


class HourBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s) IS NOT NULL;", (SIGNATURE,))
        if not self.cur.fetchone()[0]:
            self.skipTest("0265 is not applied to this database")
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
    def hour(self, at, value=None, *, n=1, text=None, flag=None, metric=METRIC, asset=DEVICE):
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
            (user_id, f"{user_id}@history-hour-of-day.test"),
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
        self.cur.execute("SAVEPOINT hour_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
            self.columns = [c.name for c in self.cur.description or ()]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT hour_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT hour_call;")
        return rows

    def read(self, start, end, assets=(DEVICE,), metric=METRIC, tz="UTC", user_id=OPERATOR_ID,
             role="authenticated"):
        """The rows as dicts, in the function's order."""
        rows = self.as_person(
            user_id, "SELECT * FROM public.telemetry_hour_of_day(%s, %s, %s, %s, %s);",
            (start, end, list(assets), metric, tz), role=role,
        )
        return [dict(zip(self.columns, r)) for r in rows]

    def by_hour(self, rows, asset=DEVICE):
        return {r["hour_of_day"]: r for r in rows if r["asset_id"] == asset}


class TheMean(HourBase):
    def test_an_hour_is_the_mean_of_that_hour_across_the_days(self):
        for day, value in enumerate((10, 20, 30)):
            self.hour(DAY0 + days(day) + hours(10), value)
        rows = self.by_hour(self.read(DAY0, DAY0 + days(3)))
        self.assertEqual((rows[10]["mean_value"], rows[10]["days"]), (20, 3))

    def test_a_quiet_hour_counts_as_the_value_carried_into_it(self):
        # One reading at 10:00 on day 0 holds all day: every hour that follows is that value.
        self.hour(DAY0 + hours(10), 8)
        rows = self.by_hour(self.read(DAY0, DAY0 + days(1)))
        self.assertEqual(sorted(rows), list(range(10, 24)))
        self.assertTrue(all(r["mean_value"] == 8 for r in rows.values()))

    def test_a_series_has_no_row_before_its_first_value(self):
        self.hour(DAY0 + hours(10), 8)
        rows = self.by_hour(self.read(DAY0, DAY0 + days(1)))
        self.assertNotIn(9, rows)

    def test_every_hour_weighs_the_same_however_many_readings_it_held(self):
        # A chatty hour of 1,000 readings at 10 and a quiet one of 1 at 20, the same hour of two days.
        self.hour(DAY0 + hours(10), 10, n=1000)
        self.hour(DAY0 + days(1) + hours(10), 20, n=1)
        rows = self.by_hour(self.read(DAY0, DAY0 + days(2)))
        self.assertEqual(rows[10]["mean_value"], 15)

    def test_each_device_has_its_own_rows(self):
        self.hour(DAY0 + hours(10), 10)
        self.hour(DAY0 + hours(10), 90, asset=OTHER)
        rows = self.read(DAY0, DAY0 + hours(11), assets=(OTHER, DEVICE))
        self.assertEqual([(r["asset_id"], r["hour_of_day"], r["mean_value"]) for r in rows],
                         [(DEVICE, 10, 10), (OTHER, 10, 90)])

    def test_only_the_metric_asked_for_is_read(self):
        self.hour(DAY0 + hours(10), 10)
        self.hour(DAY0 + hours(10), 99, metric="Spindle/SPEED")
        rows = self.read(DAY0, DAY0 + hours(11))
        self.assertEqual([(r["hour_of_day"], r["mean_value"]) for r in rows], [(10, 10)])

    def test_a_text_or_a_flag_metric_has_no_row(self):
        self.hour(DAY0 + hours(10), text="ACTIVE", metric="Controller/EXECUTION")
        self.hour(DAY0 + hours(10), flag=True, metric="Controller/EMERGENCY_STOP")
        self.assertEqual(self.read(DAY0, DAY0 + days(1), metric="Controller/EXECUTION"), [])
        self.assertEqual(self.read(DAY0, DAY0 + days(1), metric="Controller/EMERGENCY_STOP"), [])

    def test_a_device_with_no_reading_has_no_row(self):
        self.assertEqual(self.read(DAY0, DAY0 + days(1)), [])

    def test_the_rows_are_in_device_then_hour_order(self):
        for asset in (OTHER, DEVICE):
            for h in (5, 3):
                self.hour(DAY0 + hours(h), h, asset=asset)
        rows = self.read(DAY0, DAY0 + hours(6), assets=(OTHER, DEVICE))
        self.assertEqual([(r["asset_id"], r["hour_of_day"]) for r in rows],
                         [(DEVICE, 3), (DEVICE, 4), (DEVICE, 5), (OTHER, 3), (OTHER, 4), (OTHER, 5)])

    def test_the_row_shape(self):
        self.hour(DAY0 + hours(10), 5)
        self.read(DAY0, DAY0 + hours(11))
        self.assertEqual(self.columns, ["asset_id", "hour_of_day", "mean_value", "days"])


class TheTimeZone(HourBase):
    def test_the_hour_is_the_hour_in_the_zone_asked_for(self):
        self.hour(DAY0 + hours(10), 7)
        # 10:00 UTC on a January day: GMT in London, UTC+1 in Paris, UTC-5 in New York.
        for zone, expected in (("UTC", 10), ("Europe/London", 10), ("Europe/Paris", 11), ("America/New_York", 5)):
            with self.subTest(zone=zone):
                self.assertEqual(list(self.by_hour(self.read(DAY0, DAY0 + hours(11), tz=zone))), [expected])

    def test_a_clock_change_inside_the_window_moves_the_hour_with_it(self):
        # London's clocks went back at 01:00 UTC on Sunday 25 October 2026. A reading every hour for
        # three days, its value the UTC hour. Local hour 10 is UTC 9 on the Saturday (BST), then UTC
        # 10 on the Sunday and Monday (GMT); local hour 1 is UTC 0 and 1 on the Sunday, both of them.
        saturday = datetime(2026, 10, 24, tzinfo=timezone.utc)
        for h in range(72):
            self.hour(saturday + hours(h), h % 24)
        rows = self.by_hour(self.read(saturday, saturday + days(3), tz="Europe/London"))
        self.assertAlmostEqual(rows[10]["mean_value"], (9 + 10 + 10) / 3)
        self.assertEqual(rows[10]["days"], 3)
        self.assertAlmostEqual(rows[1]["mean_value"], (0 + 0 + 1 + 1) / 4)
        self.assertEqual(rows[1]["days"], 3)

    def test_a_zone_offset_by_part_of_an_hour_files_a_bucket_under_the_hour_it_starts_in(self):
        self.hour(DAY0 + hours(10), 7)
        # 10:00 UTC is 15:30 in Kolkata.
        rows = self.by_hour(self.read(DAY0, DAY0 + hours(11), tz="Asia/Kolkata"))
        self.assertEqual(list(rows), [15])

    def test_the_session_time_zone_does_not_matter(self):
        self.hour(DAY0 + hours(10), 7)
        self.cur.execute("SET LOCAL timezone = 'Pacific/Auckland';")
        self.assertEqual(list(self.by_hour(self.read(DAY0, DAY0 + hours(11), tz="UTC"))), [10])

    def test_days_counts_the_local_dates(self):
        # 23:00 UTC on Monday is Tuesday 00:00 in Paris: one hour, filed under Tuesday.
        self.hour(DAY0 + hours(23), 7)
        rows = self.by_hour(self.read(DAY0, DAY0 + days(1), tz="Europe/Paris"))
        self.assertEqual((rows[0]["days"], rows[0]["mean_value"]), (1, 7))


class Refusals(HourBase):
    def test_bad_arguments_are_refused_before_any_read(self):
        cases = {
            "a window that ends first": (DAY0, DAY0 - hours(1), ["m"], "m", "UTC"),
            "an empty window": (DAY0, DAY0, ["m"], "m", "UTC"),
            "no assets": (DAY0, DAY0 + hours(5), None, "m", "UTC"),
            "no metric": (DAY0, DAY0 + hours(5), ["m"], None, "UTC"),
            "no time zone": (DAY0, DAY0 + hours(5), ["m"], "m", None),
            "a blank time zone": (DAY0, DAY0 + hours(5), ["m"], "m", "  "),
            "an unknown time zone": (DAY0, DAY0 + hours(5), ["m"], "m", "Not/AZone"),
            "over 50,000 hours": (DAY0, DAY0 + days(2100), ["m"], "m", "UTC"),
            "over 50,000 hours of devices": (DAY0, DAY0 + days(366), ["a", "b", "c", "d", "e", "f"], "m", "UTC"),
        }
        # The caller may read no rollup, so a refusal that came after a read would raise otherwise.
        self.cur.execute("REVOKE SELECT ON timescale.telemetry_1m, timescale.telemetry_5m, timescale.telemetry_1h"
                         " FROM authenticated;")
        for name, args in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.as_person(OPERATOR_ID, "SELECT * FROM public.telemetry_hour_of_day(%s, %s, %s, %s, %s);", args)

    def test_the_refusal_names_the_hours_not_a_bucket(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as raised:
            self.read(DAY0, DAY0 + days(366), assets=("a", "b", "c", "d", "e", "f"))
        self.assertIn("8784 hours of 6 devices is more than 50000 rows", str(raised.exception))
        self.assertIn("shorter window", str(raised.exception))

    def test_50000_rows_is_allowed(self):
        # 2,500 hours of 20 devices, the longest window a cell of 20 may be read over: 104 days.
        rows = self.read(DAY0, DAY0 + hours(2500), assets=[f"dev{i:021d}" for i in range(20)])
        self.assertEqual(rows, [])

    def test_a_year_of_five_devices_is_allowed(self):
        rows = self.read(DAY0, DAY0 + days(365), assets=("a", "b", "c", "d", "e"))
        self.assertEqual(rows, [])


class WhoMayRead(HourBase):
    def test_whoever_reads_the_telemetry_views_may_call_it(self):
        self.hour(DAY0 + hours(10), 5)
        for label, user_id, role in (("an Operator", OPERATOR_ID, "authenticated"),
                                     ("a person with no role", NO_ROLE_ID, "authenticated"),
                                     ("service_role", NO_ROLE_ID, "service_role")):
            with self.subTest(caller=label):
                self.assertEqual(len(self.read(DAY0, DAY0 + hours(11), user_id=user_id, role=role)), 1)

    def test_anon_may_not(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(DAY0, DAY0 + hours(11), user_id=NO_ROLE_ID, role="anon")

    def test_it_reads_as_the_caller(self):
        # A caller without SELECT on the rollup gets nothing through the function.
        self.cur.execute("REVOKE SELECT ON timescale.telemetry_1h FROM authenticated;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(DAY0, DAY0 + hours(11))
        self.cur.execute("SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = %s::regprocedure;",
                         (SIGNATURE,))
        self.assertEqual(self.cur.fetchone(), (False, "s", ["search_path=public"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
