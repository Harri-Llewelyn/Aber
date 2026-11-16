# suite:
#   lanes: db
#   why: 0296's export_telemetry() over local tables standing in for the historian: an export naming a
#     measured and a derived metric returns both, the derived one at the resolution's width and at one
#     minute for raw, with the unit History shows and a time in state as a fraction; a derived metric
#     starts at the window's start and not where raw does, a device that lacks an input has no row, the
#     derived rows count against the same 50,000 and say where they end, a fourteen-day rate is read in
#     chunks and whole, the document and the Audit Trail row name each derived metric with its
#     definition, the roles, the second factor and the day limit are as before, and a replay is
#     idempotent.

"""
An export saves a derived metric's values (0296).

    python supabase/migrations/test_an_export_saves_a_derived_metrics_values.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. export_telemetry() (0279) reads a measured name from the raw table or a rollup, and
since 0296 a name that is a derived metric (0267) through derived_series() (0282):

  * both come back in one document, time-ordered, in the five columns; the derived metric's rows are
    the bucket's start and value, at the resolution's width, and at one minute for raw;
  * the unit is the catalogue's for a rate (COUNT/HOUR) and a sum, and "% of the time" for a time in
    state, whose value is the fraction from 0 to 1;
  * a derived metric starts where the window does, whatever raw's horizon is, and a device that lacks
    an input has no row;
  * its rows count against the same 50,000 as the measured ones, whole hours and then whole minutes,
    with truncated and read_to saying where they end; a fourteen-day rate is read in chunks and whole;
  * the document's derived and the Audit Trail row's derived name each metric and its definition,
    and the row is what 0279 wrote when none was asked for;
  * the roles, the second factor, the day limit and the refusals before any read are as they were;
  * a replay of the file leaves one function that answers the same.

The db lane has no historian, so local tables stand in for the foreign ones, inside the transaction.
EVERY TEST ROLLS BACK.
"""
import json
import os
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.errors
from psycopg2.extras import execute_values

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

OPERATOR_ID = "a0d17296-0000-4000-8000-0000000296a1"
MANAGER_ID = "a0d17296-0000-4000-8000-0000000296a2"
ADMIN_ID = "a0d17296-0000-4000-8000-0000000296a3"
AUDITOR_ID = "a0d17296-0000-4000-8000-0000000296a4"
PEOPLE = ((OPERATOR_ID, "Operator"), (MANAGER_ID, "Shopfloor_Manager"), (ADMIN_ID, "Administrator"),
          (AUDITOR_ID, "Auditor"))

KEY = "history.export_max_days"
SWITCH_KEY = "security.require_mfa_for_managers"
DOUBLE, BOOLEAN, STRING = 10, 11, 12
ROLLUPS = {"1m": "1 minute", "5m": "5 minutes", "1h": "1 hour"}
ROLLUP_COLUMNS = (
    "bucket timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,"
    " sum_double double precision, n_double bigint, min_double double precision,"
    " max_double double precision, last_double double precision, last_string text,"
    " last_bool boolean, n_rows bigint"
)
# A window well in the past, on the hour, so now() never cuts it short.
T0 = datetime(2026, 1, 5, 10, 0, tzinfo=timezone.utc)
CAP = 50000
ISO = "%Y-%m-%dT%H:%M:%S.%f"
SHARE_UNIT = "% of the time"
MIGRATION = os.path.join(os.path.dirname(os.path.abspath(__file__)), "0296_an_export_saves_a_derived_metrics_values.sql")
EXPORT = ("public.export_telemetry(timestamp with time zone, timestamp with time zone, text[], text[], text)")


def iso(t):
    """A time as the function writes it: UTC to the millisecond."""
    return t.astimezone(timezone.utc).strftime(ISO)[:-3] + "Z"


def minutes(n):
    return timedelta(minutes=n)


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def counter_values(n):
    """A counter rising by 1, 2 or 3 a minute in turn, from 0."""
    out, v = [], 0
    for i in range(n):
        v += 1 + i % 3
        out.append(v)
    return out


def reference_rate(values, width):
    """The rate per hour of each bucket of `width` minutes from a counter's value in each of consecutive
    minutes, minute 0 having no predecessor: written from the rule, not from the SQL."""
    sums, counts = {}, {}
    for i in range(1, len(values)):
        increase = values[i] - values[i - 1] if values[i] >= values[i - 1] else values[i]
        sums[i // width] = sums.get(i // width, 0) + increase
        counts[i // width] = counts.get(i // width, 0) + 1
    return {b: sums[b] * 60 / counts[b] for b in sums}


class DerivedExportBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s) IS NOT NULL AND to_regprocedure('public.derivation_words(jsonb)') IS NOT NULL;",
                         (EXPORT,))
        if not self.cur.fetchone()[0]:
            self.skipTest("0296 is not applied to this database")
        self.cur.execute("SELECT name, id FROM public.roles;")
        roles = dict(self.cur.fetchall())
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id[-4:]}@derived-export.test"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))

        # The historian's relations as local tables, as the foreign ones are shaped and granted.
        for rollup in ROLLUPS:
            self.cur.execute(f"DROP FOREIGN TABLE timescale.telemetry_{rollup} CASCADE;"
                             f"CREATE TABLE timescale.telemetry_{rollup} ({ROLLUP_COLUMNS});"
                             f"GRANT SELECT ON timescale.telemetry_{rollup} TO authenticated, service_role;")
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry CASCADE;"
            "CREATE TABLE timescale.telemetry (\"time\" timestamptz NOT NULL, asset_id text NOT NULL,"
            " metric_name text NOT NULL, val_double double precision, val_string text, val_bool boolean);"
            "GRANT SELECT ON timescale.telemetry TO authenticated, service_role;")

        self.lathe = self.make_device("Test_0296_Lathe")
        self.press = self.make_device("Test_0296_Press")
        self.mill = self.make_device("Test_0296_Mill")
        # A catalogue of this test's own: the measured inputs and a metric of each kind on them.
        self.group = f"T296{uuid.uuid4().hex[:10]}"
        for leaf, datatype, units in (("TEMPERATURE", DOUBLE, "°C"), ("PART_COUNT", DOUBLE, "COUNT"),
                                      ("EXECUTION", STRING, None), ("PHASE_A", DOUBLE, "KILOWATT"),
                                      ("PHASE_B", DOUBLE, "KILOWATT")):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units) VALUES (%s, %s, %s);",
                             (self.name(leaf), datatype, units))
        self.derive("PARTS_PER_HOUR", {"kind": "counter_rate", "input": self.name("PART_COUNT")})
        self.derive("UPTIME", {"kind": "time_in_state", "input": self.name("EXECUTION"), "states": ["ACTIVE"]})
        self.derive("POWER", {"kind": "sum", "inputs": [{"metric": self.name("PHASE_A"), "sign": 1},
                                                        {"metric": self.name("PHASE_B"), "sign": 1}]})
        self.rate, self.uptime, self.power = (self.name(x) for x in ("PARTS_PER_HOUR", "UPTIME", "POWER"))
        self.temp = self.name("TEMPERATURE")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def name(self, leaf):
        return f"{self.group}/{leaf}"

    def derive(self, leaf, derivation):
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, %s);",
                         (self.name(leaf), DOUBLE, json.dumps(derivation)))

    def make_device(self, name):
        self.cur.execute("INSERT INTO public.devices (id, name) VALUES (%s, %s) RETURNING sparkplug_id;",
                         (str(uuid.uuid4()), name))
        return self.cur.fetchone()[0]

    def numbers(self, asset, leaf, first, values, step=timedelta(minutes=1)):
        """One raw reading of a numeric metric each `step` from `first`, the values given."""
        execute_values(self.cur,
                       "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_double) VALUES %s",
                       [(first + i * step, asset, self.name(leaf), v) for i, v in enumerate(values)], page_size=5000)

    def texts(self, asset, leaf, first, values):
        """One raw reading of a text metric each minute from `first`."""
        execute_values(self.cur,
                       "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_string) VALUES %s",
                       [(first + minutes(i), asset, self.name(leaf), v) for i, v in enumerate(values)], page_size=5000)

    def generated(self, asset, leaf, first, count, per_minute=2):
        """`count` raw readings of a counter rising by `per_minute` a minute, from `first`, made in SQL."""
        self.cur.execute(
            "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_double)"
            " SELECT %s::timestamptz + g * interval '1 minute', %s, %s, g * %s FROM generate_series(0, %s - 1) g;",
            (first, asset, self.name(leaf), per_minute, count))

    def rollups(self):
        """The rollups, as the historian's continuous aggregates would hold what raw holds."""
        for rollup, width in ROLLUPS.items():
            self.cur.execute(
                f"DELETE FROM timescale.telemetry_{rollup};"
                f"INSERT INTO timescale.telemetry_{rollup}"
                "  (bucket, asset_id, metric_name, sum_double, n_double, min_double, max_double, last_double,"
                "   last_string, last_bool, n_rows)"
                " SELECT date_bin(%s::interval, t.time, 'epoch'), t.asset_id, t.metric_name, sum(t.val_double),"
                "        count(t.val_double), min(t.val_double), max(t.val_double),"
                "        (array_agg(t.val_double ORDER BY t.time DESC) FILTER (WHERE t.val_double IS NOT NULL))[1],"
                "        (array_agg(t.val_string ORDER BY t.time DESC) FILTER (WHERE t.val_string IS NOT NULL))[1],"
                "        (array_agg(t.val_bool ORDER BY t.time DESC) FILTER (WHERE t.val_bool IS NOT NULL))[1],"
                "        count(*)"
                "   FROM timescale.telemetry t GROUP BY 1, 2, 3;", (width,))

    def buckets(self, rollup, assets, metric, first, count, step="1 minute"):
        """`count` rollup buckets of each asset from `first`, one every `step`, each one numeric reading."""
        self.cur.execute(
            f"INSERT INTO timescale.telemetry_{rollup}"
            "  (bucket, asset_id, metric_name, sum_double, n_double, min_double, max_double, last_double, n_rows)"
            " SELECT %s::timestamptz + g * %s::interval, a, %s, g, 1, g, g, g, 1"
            "   FROM generate_series(0, %s - 1) g CROSS JOIN unnest(%s::text[]) a;",
            (first, step, metric, count, list(assets)))

    def limit(self, days):
        self.cur.execute("UPDATE public.system_settings SET value = to_jsonb(%s) WHERE key = %s;", (days, KEY))

    def mfa(self, on):
        self.cur.execute("UPDATE public.system_settings SET value = %s::jsonb WHERE key = %s;",
                         ("true" if on else "false", SWITCH_KEY))

    def audit_rows(self):
        self.cur.execute("SELECT id, new_data FROM public.audit_trail"
                         " WHERE action = 'TELEMETRY_EXPORTED' AND recorded_at >= now() ORDER BY id;")
        return self.cur.fetchall()

    # ---- calls -------------------------------------------------------------------------------
    def as_role(self, claims, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for a token. A refusal rolls back to the savepoint, so the
        test can go on, and is raised."""
        self.cur.execute("SAVEPOINT export_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT export_call;")
            raise
        finally:
            self.cur.execute("RESET ROLE;")
            self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT export_call;")
        return rows

    def person(self, user_id, aal="aal1"):
        return {"sub": user_id, "role": "authenticated", "aal": aal, "email": f"{user_id[-4:]}@derived-export.test"}

    def export(self, who, start, end, assets, metrics, resolution=None, aal="aal1"):
        """The document, as `who` exports it. No resolution is the function's default."""
        sql = "SELECT public.export_telemetry(%s, %s, %s, %s" + (", %s" if resolution is not None else "") + ");"
        args = (start, end, list(assets), list(metrics)) + ((resolution,) if resolution is not None else ())
        return self.as_role(self.person(who, aal), sql, args)[0][0]

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, caught.exception.pgerror)
        return caught.exception

    @staticmethod
    def times(doc):
        return [r[0] for r in doc["rows"]]

    def rows_of(self, doc, metric):
        return [r for r in doc["rows"] if r[2] == metric]

    def definitions(self):
        return {
            self.rate: f"rate of {self.name('PART_COUNT')}, per hour",
            self.uptime: f"share of time {self.name('EXECUTION')} is ACTIVE",
            self.power: f"{self.name('PHASE_A')} + {self.name('PHASE_B')}",
        }


class TheRows(DerivedExportBase):
    def test_a_measured_and_a_derived_name_return_both_in_time_order_in_the_five_columns(self):
        values = counter_values(10)
        self.numbers(self.lathe, "PART_COUNT", T0, values)
        self.raw_temperature(self.lathe, (T0 + timedelta(seconds=10), 20.5), (T0 + timedelta(seconds=70), 22.0))
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + minutes(10), [self.lathe], [self.temp, self.rate])
        self.assertEqual(doc["columns"], ["time", "asset_id", "metric_name", "value", "unit"])
        expected = [[iso(T0 + timedelta(seconds=10)), self.lathe, self.temp, 20.5, "°C"],
                    [iso(T0 + timedelta(seconds=70)), self.lathe, self.temp, 22.0, "°C"]]
        # Minute 0 has no predecessor, so the rate starts at the second minute.
        for i in range(1, 10):
            expected.append([iso(T0 + minutes(i)), self.lathe, self.rate, (values[i] - values[i - 1]) * 60.0, "COUNT/HOUR"])
        expected.sort(key=lambda r: (r[0], r[1], r[2]))
        self.assertEqual(doc["rows"], expected)
        self.assertEqual((doc["row_count"], doc["truncated"], doc["resolution"]), (11, False, "raw"))
        self.assertEqual(doc["derived"], [{"metric": self.rate, "kind": "counter_rate", "unit": "COUNT/HOUR",
                                           "definition": self.definitions()[self.rate]}])

    def raw_temperature(self, asset, *pairs):
        execute_values(self.cur,
                       "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_double) VALUES %s",
                       [(at, asset, self.temp, v) for at, v in pairs])

    def test_raw_with_a_derived_metric_has_it_at_one_minute_and_a_derived_metric_alone_has_no_raw_horizon(self):
        values = counter_values(30)
        self.numbers(self.lathe, "PART_COUNT", T0, values)
        self.rollups()
        for resolution in ("raw", "1m"):
            doc = self.export(MANAGER_ID, T0, T0 + minutes(30), [self.lathe], [self.rate], resolution=resolution)
            self.assertEqual(self.times(doc), [iso(T0 + minutes(i)) for i in range(1, 30)], resolution)
            self.assertEqual([r[3] for r in doc["rows"]], [(values[i] - values[i - 1]) * 60.0 for i in range(1, 30)])
            # No measured name: the window starts where it was asked to, and there is no raw horizon.
            self.assertEqual((doc["read_from"], doc["raw_from"], doc["resolution"]), (iso(T0), None, resolution))

    def test_the_bucket_before_the_window_starts_is_not_in_it(self):
        # The counter has a value for the ten minutes before the window, so the bucket at T0 has a rate.
        self.numbers(self.lathe, "PART_COUNT", T0 - minutes(10), counter_values(20))
        self.rollups()
        whole = self.export(MANAGER_ID, T0, T0 + minutes(10), [self.lathe], [self.rate])
        self.assertEqual(self.times(whole)[0], iso(T0))
        doc = self.export(MANAGER_ID, T0 + timedelta(seconds=30), T0 + minutes(10), [self.lathe], [self.rate])
        self.assertEqual(self.times(doc), [iso(T0 + minutes(i)) for i in range(1, 10)])

    def test_a_derived_metric_comes_at_the_rollups_width(self):
        values = counter_values(180)
        self.numbers(self.lathe, "PART_COUNT", T0, values)
        self.rollups()
        for resolution, width in (("5m", 5), ("1h", 60)):
            doc = self.export(MANAGER_ID, T0, T0 + minutes(180), [self.lathe], [self.rate], resolution=resolution)
            reference = reference_rate(values, width)
            self.assertEqual(self.times(doc), [iso(T0 + minutes(width * b)) for b in sorted(reference)], resolution)
            for row in doc["rows"]:
                b = int((datetime.strptime(row[0], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc) - T0).total_seconds() // 60 // width)
                self.assertAlmostEqual(row[3], reference[b], places=9, msg=resolution)

    def test_a_time_in_state_is_a_fraction_in_the_unit_history_draws_it_in(self):
        pattern = ["ACTIVE", "READY", "ACTIVE", "ACTIVE", "READY"] + ["READY"] * 5 + ["ACTIVE"] * 5
        self.texts(self.lathe, "EXECUTION", T0, pattern)
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + minutes(15), [self.lathe], [self.uptime], resolution="5m")
        self.assertEqual([(r[0], r[3], r[4]) for r in doc["rows"]],
                         [(iso(T0), 0.6, SHARE_UNIT), (iso(T0 + minutes(5)), 0.0, SHARE_UNIT),
                          (iso(T0 + minutes(10)), 1.0, SHARE_UNIT)])
        self.assertEqual(doc["derived"], [{"metric": self.uptime, "kind": "time_in_state", "unit": SHARE_UNIT,
                                           "definition": self.definitions()[self.uptime]}])
        # Raw: a minute at a time, each 0 or 1.
        raw = self.export(MANAGER_ID, T0, T0 + minutes(15), [self.lathe], [self.uptime])
        self.assertEqual([r[3] for r in raw["rows"]], [1.0 if s == "ACTIVE" else 0.0 for s in pattern])

    def test_a_sum_is_the_time_average_of_the_minutes_in_the_inputs_unit(self):
        self.numbers(self.lathe, "PHASE_A", T0, [float(i) for i in range(15)])
        self.numbers(self.lathe, "PHASE_B", T0, [10.0] * 15)
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + minutes(15), [self.lathe], [self.power], resolution="5m")
        # The mean of i + 10 over a bucket of five minutes starting at minute 5b.
        self.assertEqual([(r[0], r[3], r[4]) for r in doc["rows"]],
                         [(iso(T0 + minutes(5 * b)), 5.0 * b + 12.0, "KILOWATT") for b in range(3)])
        self.assertEqual(doc["derived"][0]["definition"], self.definitions()[self.power])

    def test_a_device_that_lacks_an_input_has_no_row(self):
        self.numbers(self.lathe, "PART_COUNT", T0, counter_values(10))
        self.numbers(self.press, "TEMPERATURE", T0, [1.0] * 10)
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + minutes(10), [self.lathe, self.press, self.mill], [self.rate])
        self.assertEqual({r[1] for r in doc["rows"]}, {self.lathe})
        self.assertEqual(doc["row_count"], 9)
        # Nothing is asked of the others, and a derived metric no device has is no rows and no audit row.
        none = self.export(MANAGER_ID, T0, T0 + minutes(10), [self.press, self.mill], [self.rate])
        self.assertEqual((none["row_count"], none["rows"], none["audit_id"]), (0, [], None))
        self.assertEqual([d["metric"] for d in none["derived"]], [self.rate])

    def test_several_derived_metrics_and_devices_are_read_whole_in_time_order(self):
        for asset in (self.lathe, self.press):
            self.numbers(asset, "PART_COUNT", T0, counter_values(20))
            self.texts(asset, "EXECUTION", T0, ["ACTIVE"] * 20)
        self.numbers(self.lathe, "PHASE_A", T0, [1.0] * 20)
        self.numbers(self.lathe, "PHASE_B", T0, [2.0] * 20)
        self.rollups()
        doc = self.export(ADMIN_ID, T0, T0 + minutes(20), [self.press, self.lathe], [self.power, self.uptime, self.rate])
        counts = {}
        for r in doc["rows"]:
            counts[(r[1], r[2])] = counts.get((r[1], r[2]), 0) + 1
        self.assertEqual(counts, {(self.lathe, self.rate): 19, (self.press, self.rate): 19, (self.lathe, self.uptime): 20,
                                  (self.press, self.uptime): 20, (self.lathe, self.power): 20})
        self.assertEqual(self.times(doc), sorted(self.times(doc)))
        self.assertEqual([d["metric"] for d in doc["derived"]], sorted([self.rate, self.uptime, self.power]))

    def test_a_derived_metric_starts_where_the_window_does_and_not_where_raw_does(self):
        # Raw begins at T0 for the measured name, and the 1-minute rollup holds two earlier days.
        self.raw_temperature(self.lathe, (T0, 20.0), (T0 + minutes(30), 21.0))
        self.numbers(self.lathe, "PART_COUNT", T0, [5760 + 2 * i for i in range(60)])
        self.rollups()
        early = T0 - timedelta(days=2)
        self.cur.execute(
            "INSERT INTO timescale.telemetry_1m (bucket, asset_id, metric_name, sum_double, n_double, min_double,"
            " max_double, last_double, n_rows) SELECT %s::timestamptz + g * interval '1 minute', %s, %s, 2 * g, 1, 2 * g, 2 * g, 2 * g, 1"
            " FROM generate_series(0, 2879) g;", (early, self.lathe, self.name("PART_COUNT")))
        doc = self.export(MANAGER_ID, early, T0 + minutes(60), [self.lathe], [self.temp, self.rate])
        derived = self.rows_of(doc, self.rate)
        self.assertEqual(derived[0][0], iso(early + minutes(1)))
        self.assertEqual(len(derived), 2880 + 60 - 1)
        # The measured reading is the raw one, and what is said of raw is about it alone.
        self.assertEqual([r[0] for r in self.rows_of(doc, self.temp)], [iso(T0), iso(T0 + minutes(30))])
        self.assertEqual((doc["raw_from"], doc["read_from"]), (iso(T0), iso(T0)))
        self.assertTrue(all(r[3] == 120.0 for r in derived))

    def test_the_unit_is_the_catalogues_and_a_sum_of_unitless_metrics_has_none(self):
        for leaf in ("FLAG_A", "FLAG_B"):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, %s);", (self.name(leaf), DOUBLE))
        self.derive("DIFFERENCE", {"kind": "sum", "inputs": [{"metric": self.name("FLAG_A"), "sign": 1},
                                                             {"metric": self.name("FLAG_B"), "sign": -1}]})
        self.numbers(self.lathe, "FLAG_A", T0, [5.0] * 5)
        self.numbers(self.lathe, "FLAG_B", T0, [2.0] * 5)
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + minutes(5), [self.lathe], [self.name("DIFFERENCE")])
        self.assertEqual({(r[3], r[4]) for r in doc["rows"]}, {(3.0, None)})
        self.assertEqual(doc["derived"][0]["unit"], None)
        self.assertEqual(doc["derived"][0]["definition"], f"{self.name('FLAG_A')} − {self.name('FLAG_B')}")


class TheBound(DerivedExportBase):
    def test_exactly_the_fourteen_day_limit_of_a_rate_is_read_in_chunks_and_whole(self):
        count = 14 * 24 * 60
        values = counter_values(count)
        self.numbers(self.lathe, "PART_COUNT", T0, values)
        self.rollups()
        started = time.perf_counter()
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=14), [self.lathe], [self.rate])
        took = time.perf_counter() - started
        print(f"\n  a 14-day export of one rate, {doc['row_count']} rows, on local tables: {took:.2f} s")
        self.assertEqual((doc["row_count"], doc["truncated"]), (count - 1, False))
        self.assertEqual(doc["read_to"], iso(T0 + timedelta(days=14)))
        self.assertEqual(self.times(doc), [iso(T0 + minutes(i)) for i in range(1, count)])
        self.assertEqual([r[3] for r in doc["rows"]], [(values[i] - values[i - 1]) * 60.0 for i in range(1, count)])
        self.assertLess(took, 60)

    def test_several_devices_are_read_in_chunks_of_whole_buckets(self):
        for asset in (self.lathe, self.press, self.mill):
            self.numbers(asset, "PART_COUNT", T0, counter_values(3 * 24 * 60))
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=3), [self.lathe, self.press, self.mill], [self.rate])
        self.assertEqual((doc["row_count"], doc["truncated"]), (3 * (3 * 24 * 60 - 1), False))
        self.assertEqual(self.times(doc), sorted(self.times(doc)))
        for asset in (self.lathe, self.press, self.mill):
            self.assertEqual(len([r for r in doc["rows"] if r[1] == asset]), 3 * 24 * 60 - 1)

    def test_a_derived_metric_alone_stops_at_the_cap_on_a_minute_and_says_where(self):
        self.limit(40)
        self.generated(self.lathe, "PART_COUNT", T0, 40 * 24 * 60)
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=40), [self.lathe], [self.rate])
        # 833 whole hours are 49,980 buckets; of the next, 20 minutes make 50,000, and the 21st would not.
        # The first of them has no predecessor, so one bucket of the 50,000 has no row.
        cut = T0 + timedelta(hours=833, minutes=20)
        self.assertEqual((doc["row_count"], doc["truncated"], doc["read_to"]), (CAP - 1, True, iso(cut)))
        self.assertEqual(doc["rows"][0][0], iso(T0 + minutes(1)))
        self.assertEqual(doc["rows"][-1][0], iso(cut - minutes(1)))
        self.assertTrue(all(t < doc["read_to"] for t in self.times(doc)))
        self.assertTrue(all(r[3] == 120.0 for r in doc["rows"]))
        self.assertEqual(self.audit_rows()[0][1]["rows"], CAP - 1)
        self.assertTrue(self.audit_rows()[0][1]["truncated"])

    def test_measured_and_derived_rows_share_the_cap(self):
        self.limit(40)
        count = 40 * 24 * 60
        self.generated(self.lathe, "PART_COUNT", T0, count)
        self.rollups()
        # The measured name's 1-minute rollup, a bucket a minute: it adds a row to each minute the rate does.
        self.buckets("1m", [self.lathe], self.temp, T0, count)
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=40), [self.lathe], [self.temp, self.rate], resolution="1m")
        # Two rows a minute: 416 whole hours are 49,920, and 40 minutes of the next make 50,000.
        cut = T0 + timedelta(hours=416, minutes=40)
        self.assertEqual((doc["row_count"], doc["truncated"], doc["read_to"]), (CAP - 1, True, iso(cut)))
        self.assertEqual(len(self.rows_of(doc, self.temp)), 25000)
        self.assertEqual(len(self.rows_of(doc, self.rate)), 24999)
        self.assertEqual(self.times(doc), sorted(self.times(doc)))
        self.assertTrue(all(t < doc["read_to"] for t in self.times(doc)))

    def test_a_derived_metric_a_device_does_not_have_costs_the_cap_nothing(self):
        self.limit(40)
        self.generated(self.lathe, "PART_COUNT", T0, 40 * 24 * 60)
        # A thousand devices ask for the rate and one has its input.
        others = [f"devnone{i:04d}" for i in range(999)]
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=40), [self.lathe] + others, [self.rate])
        self.assertEqual((doc["row_count"], doc["read_to"]), (CAP - 1, iso(T0 + timedelta(hours=833, minutes=20))))
        self.assertEqual({r[1] for r in doc["rows"]}, {self.lathe})

    def test_the_day_limit_holds_for_a_derived_name(self):
        self.cur.execute("DROP TABLE timescale.telemetry, timescale.telemetry_1m, timescale.telemetry_5m, timescale.telemetry_1h;")
        sentence = "An export can cover at most 14 days, set on Settings › History. This window is 15 days."
        refusal = self.assertRefused("22023", self.export, MANAGER_ID, T0, T0 + timedelta(days=14, seconds=1),
                                     [self.lathe], [self.rate])
        self.assertEqual(refusal.diag.message_primary, sentence)
        # Exactly the limit gets as far as the read, which is gone.
        self.assertRefused("42P01", self.export, MANAGER_ID, T0, T0 + timedelta(days=14), [self.lathe], [self.rate])


class TheAuditRow(DerivedExportBase):
    def setUp(self):
        super().setUp()
        self.numbers(self.lathe, "PART_COUNT", T0, counter_values(10))
        self.texts(self.lathe, "EXECUTION", T0, ["ACTIVE"] * 10)
        self.numbers(self.lathe, "TEMPERATURE", T0, [20.0] * 10)
        self.rollups()

    def test_it_names_each_derived_metric_and_its_definition_with_the_metrics_asked_for(self):
        doc = self.export(MANAGER_ID, T0, T0 + minutes(10), [self.lathe], [self.temp, self.uptime, self.rate])
        ((event_id, new),) = self.audit_rows()
        self.assertEqual(doc["audit_id"], event_id)
        names = sorted([self.temp, self.uptime, self.rate])
        self.assertEqual(new["metrics"], names)
        self.assertEqual(new["derived"], [{"name": n, "definition": self.definitions()[n]} for n in sorted([self.uptime, self.rate])])
        self.assertEqual((new["resolution"], new["rows"], new["truncated"]), ("raw", doc["row_count"], False))

    def test_an_export_of_measured_names_alone_writes_the_row_it_always_did(self):
        doc = self.export(MANAGER_ID, T0, T0 + minutes(10), [self.lathe], [self.temp])
        ((_, new),) = self.audit_rows()
        self.assertNotIn("derived", new)
        self.assertEqual(sorted(new), sorted(["name", "devices", "metrics", "from", "to", "resolution", "rows", "truncated",
                                              "read_to", "exported_by_email"]))
        self.assertEqual(doc["derived"], [])

    def test_a_derived_export_is_one_read_in_the_asset_lane_by_the_person_who_made_it(self):
        self.export(ADMIN_ID, T0, T0 + minutes(10), [self.lathe], [self.rate])
        self.cur.execute(
            "SELECT action, entity_type, audit_domain, changed_by::text,"
            "       public.audit_event_class(action, entity_type, audit_domain, old_data, new_data)"
            "  FROM public.audit_trail WHERE action = 'TELEMETRY_EXPORTED' AND recorded_at >= now();")
        self.assertEqual(self.cur.fetchall(), [("TELEMETRY_EXPORTED", "telemetry", "asset", ADMIN_ID, "read")])


class TheGate(DerivedExportBase):
    """Every refusal, with the historian's relations gone: a read would fail with 42P01, so a refusal
    that is not 42P01 came before it."""

    def setUp(self):
        super().setUp()
        self.cur.execute("DROP TABLE timescale.telemetry, timescale.telemetry_1m, timescale.telemetry_5m, timescale.telemetry_1h;")
        self.before = len(self.audit_rows())

    def tearDown(self):
        self.assertEqual(len(self.audit_rows()), self.before, "a refusal wrote an Audit Trail row")
        super().tearDown()

    def asked(self, who=MANAGER_ID, **kwargs):
        return self.export(who, T0, T0 + timedelta(hours=1), [self.lathe], [self.temp, self.rate], **kwargs)

    def test_an_operator_and_an_auditor_are_refused_with_the_roles_in_words(self):
        for who in (OPERATOR_ID, AUDITOR_ID):
            refusal = self.assertRefused("42501", self.asked, who)
            self.assertEqual(refusal.diag.message_primary, "Only an Administrator or a Shopfloor Manager may export readings.")

    def test_an_administrator_and_a_manager_get_as_far_as_the_read(self):
        for who in (MANAGER_ID, ADMIN_ID):
            self.assertRefused("42P01", self.asked, who)

    def test_with_the_second_factor_required_a_session_that_gave_no_code_is_refused(self):
        self.mfa(True)
        for who in (MANAGER_ID, ADMIN_ID):
            refusal = self.assertRefused("42501", self.asked, who, aal="aal1")
            self.assertEqual(refusal.diag.message_detail, "mfa_required")
            self.assertRefused("42P01", self.asked, who, aal="aal2")

    def test_the_other_refusals_are_as_they_were(self):
        for resolution in ("1d", "RAW", ""):
            self.assertRefused("22023", self.asked, resolution=resolution)
        self.assertRefused("22023", self.export, MANAGER_ID, T0, T0, [self.lathe], [self.rate])
        self.assertRefused("22023", self.export, MANAGER_ID, T0, T0 + minutes(5), [], [self.rate])
        self.assertRefused("22023", self.export, MANAGER_ID, T0, T0 + minutes(5), [self.lathe], [])
        self.assertRefused("22023", self.export, MANAGER_ID, T0, T0 + minutes(5), [self.lathe], [f"m{i}" for i in range(501)])


class TheFunctions(DerivedExportBase):
    def test_the_function_is_declared_once_and_only_an_authenticated_role_may_execute_it(self):
        self.cur.execute("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
                         " WHERE n.nspname = 'public' AND p.proname = 'export_telemetry';")
        self.assertEqual(self.cur.fetchone()[0], 1)
        self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'), has_function_privilege('service_role', %s, 'EXECUTE'),"
                         "       has_function_privilege('authenticated', %s, 'EXECUTE');", (EXPORT, EXPORT, EXPORT))
        self.assertEqual(self.cur.fetchone(), (False, False, True))

    def test_no_browser_role_calls_the_words(self):
        for role in ("anon", "authenticated", "service_role"):
            self.cur.execute("SELECT has_function_privilege(%s, 'public.derivation_words(jsonb)', 'EXECUTE');", (role,))
            self.assertFalse(self.cur.fetchone()[0], role)

    def test_a_definition_is_worded_as_the_dashboard_words_it(self):
        words = {
            '{"kind": "counter_rate", "input": "A/X"}': "rate of A/X, per hour",
            '{"kind": "time_in_state", "input": "A/X", "states": ["B", "C", "D"]}': "share of time A/X is B, C or D",
            '{"kind": "sum", "inputs": [{"metric": "A", "sign": -1}, {"metric": "B", "sign": 1}, {"metric": "C", "sign": -1}]}': "−A + B − C",
            '{"kind": "average"}': "unknown kind average",
        }
        for definition, expected in words.items():
            self.cur.execute("SELECT public.derivation_words(%s::jsonb);", (definition,))
            self.assertEqual(self.cur.fetchone()[0], expected)
        self.cur.execute("SELECT public.derivation_words(NULL);")
        self.assertEqual(self.cur.fetchone()[0], "")

    def test_a_replay_of_the_file_leaves_one_function_that_answers_the_same(self):
        self.numbers(self.lathe, "PART_COUNT", T0, counter_values(12))
        self.rollups()
        before = self.export(MANAGER_ID, T0, T0 + minutes(12), [self.lathe], [self.rate])
        with open(MIGRATION, encoding="utf-8") as sql:
            self.cur.execute(sql.read())
        self.cur.execute("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
                         " WHERE n.nspname = 'public' AND p.proname IN ('export_telemetry', 'derivation_words');")
        self.assertEqual(self.cur.fetchone()[0], 2)
        after = self.export(MANAGER_ID, T0, T0 + minutes(12), [self.lathe], [self.rate])
        self.assertEqual({k: v for k, v in after.items() if k != "audit_id"}, {k: v for k, v in before.items() if k != "audit_id"})


if __name__ == "__main__":
    unittest.main()
