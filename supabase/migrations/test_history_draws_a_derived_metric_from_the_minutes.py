# suite:
#   lanes: db
#   why: 0282's derived_series() and derived_current(), over local tables standing in for the
#     historian's one-minute rollup: a counter rate is the increase per hour with a reset counting
#     its new value, a time in state is the share of the bucket's minutes with a state carried
#     across a quiet stretch, a sum is the time-average of the per-minute signed sum and a device
#     missing an input has no row, a window of more than one chunk answers as one would (whole
#     buckets, and the devices of a wide bucket), only whole minutes are read, every refusal comes
#     before any read, each kind has its current value by one rule, and anon may call neither.

"""
History draws a derived metric from the minutes (0282).

    python supabase/migrations/test_history_draws_a_derived_metric_from_the_minutes.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. derived_series() computes a derived metric (0267) at query time from
telemetry_carried() at one minute, and combines the minutes into the bucket:

  * a counter rate is the increase per hour, a fall counting as a reset whose new value is the
    increase, over the minutes a bucket has a predecessor for;
  * a time in state is the share of the bucket's minutes in the states, a state carried across a
    quiet stretch and a flag read as 'true' or 'false';
  * a sum is the time-average of the per-minute signed sum, a minute counting only where every
    input has a value, so a device missing an input has no row.

A window that needs more than one chunk answers as one chunk would, for both kinds of split: whole
buckets of a window past 50,000 minutes, and the devices of a bucket too wide for them all. Only whole
minutes are read. Every refusal comes before any read: a metric that is not derived, bad bounds and
buckets, more rows or more minutes than a call may take. derived_current() gives a derived metric's
current value by one rule for each kind, and anon may call neither.

The db lane has no historian, so local tables stand in for the foreign rollups and raw telemetry,
inside the transaction. EVERY TEST ROLLS BACK.
"""
import json
import os
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

OPERATOR_ID = "a0d17282-0000-4000-8000-0000000282a1"

DEVICE = "dev000000000000000000282"
OTHER = "dev000000000000000000283"
LATE = "dev000000000000000000284"
DOUBLE, BOOLEAN, STRING = 10, 11, 12
INVALID_PARAMETER = "22023"
INSUFFICIENT_PRIVILEGE = "42501"
# Far in the past, so now() never cuts a window short, on every grid a bucket here uses.
T0 = datetime(2026, 1, 5, 10, 0, tzinfo=timezone.utc)
DAY0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
# A multiple of four days since the epoch, the grid of a 4-day bucket.
GRID4 = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(days=4 * 5000)

ROLLUP_COLUMNS = (
    "bucket timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,"
    " sum_double double precision, n_double bigint, min_double double precision,"
    " max_double double precision, last_double double precision, last_string text,"
    " last_bool boolean, n_rows bigint"
)
SERIES = "public.derived_series(timestamp with time zone, timestamp with time zone, interval, text[], text[])"


def minutes(n):
    return timedelta(minutes=n)


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def reference_rate(values, width):
    """The rate per hour of each bucket of `width` minutes, from a counter's value in each of
    consecutive minutes starting at minute 0, which has no predecessor: written from the rule, not
    from the SQL."""
    sums, counts = {}, {}
    for i in range(1, len(values)):
        increase = values[i] - values[i - 1] if values[i] >= values[i - 1] else values[i]
        b = i // width
        sums[b] = sums.get(b, 0) + increase
        counts[b] = counts.get(b, 0) + 1
    return {b: sums[b] * 60 / counts[b] for b in sums}


def counter_values(n, start=0, reset_at=None):
    """A counter rising by 1, 2 or 3 a minute in turn, falling to 2 at `reset_at`."""
    out, v = [], start
    for i in range(n):
        v = 2 if i == reset_at else v + 1 + i % 3
        out.append(v)
    return out


class DerivedBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s) IS NOT NULL;", (SERIES,))
        if not self.cur.fetchone()[0]:
            self.skipTest("0282 is not applied to this database")
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
            " VALUES (%s, 'derived-series@test.test', 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (OPERATOR_ID,))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id)"
                         " SELECT %s, id FROM public.roles WHERE name = 'Operator' ON CONFLICT DO NOTHING;",
                         (OPERATOR_ID,))
        # A catalogue of this test's own: the inputs, and a derived metric of each kind on them.
        self.group = f"T282{uuid.uuid4().hex[:10]}"
        for leaf, datatype, units in (("PART_COUNT", DOUBLE, "COUNT"), ("EXECUTION", STRING, None),
                                      ("RUNNING", BOOLEAN, None), ("PHASE_A", DOUBLE, "KILOWATT"),
                                      ("PHASE_B", DOUBLE, "KILOWATT"), ("PHASE_C", DOUBLE, "KILOWATT")):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units) VALUES (%s, %s, %s);",
                             (self.name(leaf), datatype, units))
        self.derive("PARTS_PER_HOUR", {"kind": "counter_rate", "input": self.name("PART_COUNT")})
        self.derive("UPTIME", {"kind": "time_in_state", "input": self.name("EXECUTION"), "states": ["ACTIVE"]})
        self.derive("BUSY", {"kind": "time_in_state", "input": self.name("EXECUTION"), "states": ["ACTIVE", "READY"]})
        self.derive("RUN_SHARE", {"kind": "time_in_state", "input": self.name("RUNNING"), "states": ["true"]})
        self.derive("POWER", {"kind": "sum", "inputs": [
            {"metric": self.name("PHASE_A"), "sign": 1}, {"metric": self.name("PHASE_B"), "sign": 1},
            {"metric": self.name("PHASE_C"), "sign": -1}]})

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def name(self, leaf):
        return f"{self.group}/{leaf}"

    def derive(self, leaf, derivation):
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, %s);",
                         (self.name(leaf), DOUBLE, json.dumps(derivation)))

    def minute(self, at, value=None, *, last=None, n=1, text=None, flag=None, leaf="PART_COUNT", asset=DEVICE):
        """One telemetry_1m row: `n` readings averaging `value`, the last of them `last`."""
        numeric = value is not None
        self.cur.execute(
            "INSERT INTO timescale.telemetry_1m (bucket, asset_id, metric_name, sum_double, n_double, min_double,"
            " max_double, last_double, last_string, last_bool, n_rows) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);",
            (at, asset, self.name(leaf), value * n if numeric else None, n if numeric else 0,
             value if numeric else None, value if numeric else None,
             (last if last is not None else value) if numeric else None, text, flag, n))

    def counter(self, start, values, *, asset=DEVICE, leaf="PART_COUNT"):
        """A counter's value in each of consecutive minutes from `start`, a row for every one."""
        execute_values(self.cur,
                       "INSERT INTO timescale.telemetry_1m (bucket, asset_id, metric_name, sum_double, n_double,"
                       " min_double, max_double, last_double, n_rows) VALUES %s",
                       [(start + minutes(i), asset, self.name(leaf), v, 1, v, v, v, 1) for i, v in enumerate(values)],
                       page_size=5000)

    def person(self):
        self.cur.execute("RESET ROLE;")

    def as_person(self, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for the Operator (or as anon). A refusal rolls back to the
        savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT derived_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": OPERATOR_ID, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
            self.columns = [c.name for c in self.cur.description or ()]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT derived_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT derived_call;")
        return rows

    def series(self, start, end, bucket, leaves, assets=(DEVICE,), role="authenticated"):
        """The rows, sorted by device, metric and bucket, as dicts."""
        rows = self.as_person(
            "SELECT * FROM public.derived_series(%s, %s, %s::interval, %s, %s);",
            (start, end, bucket, list(assets), [self.name(leaf) for leaf in leaves]), role=role)
        out = [dict(zip(self.columns, r)) for r in rows]
        return sorted(out, key=lambda r: (r["asset_id"], r["metric_name"], r["bucket_ts"]))

    def one(self, start, end, bucket, leaf, asset=DEVICE):
        return [r for r in self.series(start, end, bucket, [leaf], assets=(asset,))]

    def assertRefused(self, fn, *args, code=INVALID_PARAMETER, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, str(caught.exception))
        return caught.exception


class ACounterRate(DerivedBase):
    def test_a_rate_is_the_increase_per_hour_and_a_reset_counts_its_new_value(self):
        for i, v in enumerate((100, 110, 120, 5, 15)):
            self.minute(T0 + minutes(i), v)
        rows = self.one(T0, T0 + minutes(10), "5 minutes", "PARTS_PER_HOUR")
        self.assertEqual([r["bucket_ts"] for r in rows], [T0, T0 + minutes(5)])
        first, quiet = rows
        # 10 + 10 + 5 (the reset: the new value) + 10 over the four minutes that have a predecessor.
        self.assertAlmostEqual(first["avg_double"], 35 * 60 / 4)
        self.assertEqual((first["min_double"], first["max_double"], first["last_double"]),
                         (first["avg_double"],) * 3)
        self.assertEqual((first["n_rows"], first["is_carried"]), (5, False))
        # Nothing arrived: the counter holds, so it counts nothing, and the bucket says it is carried.
        self.assertEqual((quiet["avg_double"], quiet["n_rows"], quiet["is_carried"]), (0, 0, True))
        self.assertEqual(self.columns, ["bucket_ts", "asset_id", "metric_name", "avg_double", "min_double",
                                        "max_double", "last_double", "n_rows", "is_carried"])

    def test_a_reset_in_the_middle_of_an_hour_costs_only_what_the_minute_held(self):
        self.minute(T0 - minutes(1), 0)
        values = [2 * (m + 1) for m in range(30)] + [4 + 2 * (m - 30) for m in range(30, 60)]
        self.counter(T0, values)
        [hour] = self.one(T0, T0 + minutes(60), "1 hour", "PARTS_PER_HOUR")
        # 30 minutes of 2, the reset to 4 (its new value), 29 minutes of 2: 122 parts in an hour.
        self.assertAlmostEqual(hour["avg_double"], 122.0)
        self.assertEqual(hour["n_rows"], 60)

    def test_the_first_minute_of_a_series_has_no_predecessor_and_is_not_counted(self):
        self.counter(T0, [10, 12, 14, 16, 18])
        [row] = self.one(T0, T0 + minutes(5), "5 minutes", "PARTS_PER_HOUR")
        # Four increases of 2 over four minutes: 120 an hour, not 96 over five.
        self.assertAlmostEqual(row["avg_double"], 120.0)

    def test_a_bucket_before_the_series_begins_has_no_row(self):
        self.counter(T0 + minutes(30), [1, 2, 3])
        rows = self.one(T0, T0 + minutes(60), "10 minutes", "PARTS_PER_HOUR")
        # The first bucket with a value, then the two the counter is carried through; none before it.
        self.assertEqual([r["bucket_ts"] for r in rows], [T0 + minutes(30), T0 + minutes(40), T0 + minutes(50)])
        self.assertAlmostEqual(rows[0]["avg_double"], 2 * 60 / 9)

    def test_a_device_that_does_not_report_the_counter_has_no_row(self):
        self.counter(T0, [1, 2, 3, 4, 5])
        self.assertEqual(self.one(T0, T0 + minutes(5), "5 minutes", "PARTS_PER_HOUR", asset=OTHER), [])


class ATimeInState(DerivedBase):
    def test_the_share_is_of_the_bucket_s_minutes_with_a_state_carried_across_a_quiet_stretch(self):
        self.minute(T0, text="ACTIVE", leaf="EXECUTION")
        self.minute(T0 + minutes(10), text="READY", leaf="EXECUTION")
        self.minute(T0 + minutes(40), text="ACTIVE", leaf="EXECUTION")
        rows = self.series(T0, T0 + minutes(120), "1 hour", ["UPTIME", "BUSY"])
        by = {(r["metric_name"], r["bucket_ts"]): r for r in rows}
        up, busy = self.name("UPTIME"), self.name("BUSY")
        # Active 0-9 and 40-59: 30 of 60 minutes. Every minute between the readings is the state before it.
        self.assertAlmostEqual(by[(up, T0)]["avg_double"], 0.5)
        self.assertAlmostEqual(by[(busy, T0)]["avg_double"], 1.0)
        self.assertEqual((by[(up, T0)]["n_rows"], by[(up, T0)]["is_carried"]), (3, False))
        # The second hour had no reading at all: ACTIVE carried through it.
        self.assertEqual((by[(up, T0 + minutes(60))]["avg_double"], by[(up, T0 + minutes(60))]["n_rows"],
                          by[(up, T0 + minutes(60))]["is_carried"]), (1.0, 0, True))
        self.assertEqual(by[(up, T0)]["min_double"], by[(up, T0)]["avg_double"])

    def test_a_flag_is_read_as_true_or_false(self):
        self.minute(T0, flag=True, leaf="RUNNING")
        self.minute(T0 + minutes(30), flag=False, leaf="RUNNING")
        [row] = self.one(T0, T0 + minutes(60), "1 hour", "RUN_SHARE")
        self.assertAlmostEqual(row["avg_double"], 0.5)

    def test_a_minute_before_the_first_state_is_not_counted(self):
        self.minute(T0 + minutes(30), text="ACTIVE", leaf="EXECUTION")
        [row] = self.one(T0, T0 + minutes(60), "1 hour", "UPTIME")
        # The 30 minutes it has, all active: a share of those, not of an hour half unknown.
        self.assertAlmostEqual(row["avg_double"], 1.0)


class ASum(DerivedBase):
    def feed(self, asset, a=(), b=(), c=()):
        for leaf, readings in (("PHASE_A", a), ("PHASE_B", b), ("PHASE_C", c)):
            for at, value in readings:
                self.minute(T0 + minutes(at), value, leaf=leaf, asset=asset)

    def test_the_value_is_the_time_average_of_the_minutes_signed_sums(self):
        self.feed(DEVICE, a=[(0, 10)], b=[(0, 1), (2, 3)], c=[(0, 2)])
        [row] = self.one(T0, T0 + minutes(5), "5 minutes", "POWER")
        # A + B - C each minute: 9, 9 (B carried), 11, 11, 11.
        self.assertAlmostEqual(row["avg_double"], (9 + 9 + 11 + 11 + 11) / 5)
        self.assertEqual((row["min_double"], row["max_double"], row["last_double"]), (9, 11, 11))
        self.assertEqual((row["n_rows"], row["is_carried"]), (4, False))

    def test_a_device_that_lacks_an_input_has_no_value(self):
        self.feed(OTHER, a=[(0, 10)], b=[(0, 1)])
        self.assertEqual(self.one(T0, T0 + minutes(5), "5 minutes", "POWER", asset=OTHER), [])

    def test_a_minute_counts_only_where_every_input_has_a_value(self):
        self.feed(LATE, a=[(0, 10)], b=[(0, 1)], c=[(3, 2)])
        [row] = self.one(T0, T0 + minutes(5), "5 minutes", "POWER", asset=LATE)
        # C arrives in minute 3: minutes 0 to 2 are not a sum, so the bucket is the two that are.
        self.assertAlmostEqual(row["avg_double"], 9.0)
        self.assertEqual((row["n_rows"], row["is_carried"]), (1, False))

    def test_the_last_value_is_the_sum_at_the_end_of_the_last_minute(self):
        self.minute(T0, 6, last=7, n=2, leaf="PHASE_A")
        self.minute(T0, 1, leaf="PHASE_B")
        self.minute(T0, 2, leaf="PHASE_C")
        [row] = self.one(T0, T0 + minutes(1), "1 minute", "POWER")
        self.assertEqual((row["avg_double"], row["last_double"]), (5, 6))

    def test_a_quiet_bucket_is_carried(self):
        self.feed(DEVICE, a=[(0, 10)], b=[(0, 1)], c=[(0, 2)])
        rows = self.one(T0, T0 + minutes(10), "5 minutes", "POWER")
        self.assertEqual([(r["avg_double"], r["is_carried"]) for r in rows], [(9, False), (9, True)])


class SeveralAtOnce(DerivedBase):
    def test_one_row_per_device_metric_and_bucket_that_has_a_value(self):
        self.counter(T0, [1, 2, 3, 4], asset=DEVICE)
        self.counter(T0, [5, 10, 15, 20], asset=OTHER)
        self.minute(T0, text="ACTIVE", leaf="EXECUTION", asset=DEVICE)
        rows = self.series(T0, T0 + minutes(4), "2 minutes", ["PARTS_PER_HOUR", "UPTIME"], assets=(OTHER, DEVICE))
        keys = [(r["asset_id"], r["metric_name"].split("/")[1], r["bucket_ts"]) for r in rows]
        self.assertEqual(keys, [
            (DEVICE, "PARTS_PER_HOUR", T0), (DEVICE, "PARTS_PER_HOUR", T0 + minutes(2)),
            (DEVICE, "UPTIME", T0), (DEVICE, "UPTIME", T0 + minutes(2)),
            (OTHER, "PARTS_PER_HOUR", T0), (OTHER, "PARTS_PER_HOUR", T0 + minutes(2))])
        other = [r for r in rows if r["asset_id"] == OTHER]
        # 5 parts a minute is 300 an hour, in the first bucket over the one minute that has a predecessor.
        self.assertAlmostEqual(other[0]["avg_double"], 300.0)
        self.assertAlmostEqual(other[1]["avg_double"], 300.0)

    def test_a_window_opening_inside_a_bucket_starts_on_the_bucket(self):
        self.counter(T0, [1, 2, 3, 4, 5, 6])
        rows = self.one(T0 + minutes(3), T0 + minutes(5), "5 minutes", "PARTS_PER_HOUR")
        # The bucket that holds the window's start is read whole: its minutes 0 to 4, four increases of 1.
        self.assertEqual([r["bucket_ts"] for r in rows], [T0])
        self.assertAlmostEqual(rows[0]["avg_double"], 60.0)


class MoreThanOneChunk(DerivedBase):
    def test_a_window_past_one_read_of_minutes_answers_as_one_chunk_would(self):
        # 35 days of minutes: 50,400 rows, more than the 50,000 one read of telemetry_carried() takes,
        # so the window is read in two chunks of whole days, one of 34 and one of 1.
        n = 35 * 1440
        values = counter_values(n, reset_at=34 * 1440 + 3)
        self.counter(DAY0, values)
        rows = self.one(DAY0, DAY0 + timedelta(days=35), "1 day", "PARTS_PER_HOUR")
        want = reference_rate(values, 1440)
        self.assertEqual(len(rows), 35)
        for i, row in enumerate(rows):
            with self.subTest(day=i):
                self.assertEqual(row["bucket_ts"], DAY0 + timedelta(days=i))
                self.assertAlmostEqual(row["avg_double"], want[i], places=6)

    def test_the_devices_of_a_bucket_too_wide_for_them_all_are_read_in_parts(self):
        # A 4-day bucket is 5,760 minutes: 8 devices fit one read, so 9 take two.
        assets = [f"dev0000000000000000003{i:02d}" for i in range(9)]
        wanted = {}
        for i, asset in enumerate(assets):
            values = counter_values(5760, start=i * 100, reset_at=1000 + i)
            self.counter(GRID4, values, asset=asset)
            wanted[asset] = reference_rate(values, 5760)[0]
        rows = self.series(GRID4, GRID4 + timedelta(days=4), "4 days", ["PARTS_PER_HOUR"], assets=assets)
        self.assertEqual([r["asset_id"] for r in rows], sorted(assets))
        for row in rows:
            with self.subTest(asset=row["asset_id"]):
                self.assertAlmostEqual(row["avg_double"], wanted[row["asset_id"]], places=6)


class WholeMinutesOnly(DerivedBase):
    def test_the_minute_that_holds_now_is_not_read(self):
        self.cur.execute("SELECT date_trunc('minute', now());")
        now_minute = self.cur.fetchone()[0]
        for i, v in enumerate((100, 110, 120)):
            self.minute(now_minute - minutes(3 - i), v)
        self.minute(now_minute, 5000)
        rows = self.one(now_minute - minutes(5), now_minute + minutes(5), "1 minute", "PARTS_PER_HOUR")
        # The first row has no predecessor; the two after it are 10 a minute, and the current minute's
        # jump is not in any bucket.
        self.assertEqual([(r["bucket_ts"], round(r["avg_double"])) for r in rows],
                         [(now_minute - minutes(2), 600), (now_minute - minutes(1), 600)])

    def test_a_window_wholly_in_the_future_has_no_row(self):
        self.cur.execute("SELECT date_trunc('hour', now()) + interval '2 hours';")
        later = self.cur.fetchone()[0]
        self.counter(later - timedelta(hours=3), [1, 2, 3])
        self.assertEqual(self.one(later, later + timedelta(hours=1), "5 minutes", "PARTS_PER_HOUR"), [])


class Refusals(DerivedBase):
    def refuse(self, start, end, bucket, leaves, assets=(DEVICE,), **kw):
        # A read would find no table at all, so a refusal that came first is the only one that can be 22023.
        return self.assertRefused(self.series, start, end, bucket, leaves, assets, **kw)

    def setUp(self):
        super().setUp()
        self.cur.execute("DROP TABLE timescale.telemetry_1m, timescale.telemetry_5m, timescale.telemetry_1h;")

    def test_bad_bounds_and_buckets_are_refused_before_any_read(self):
        for label, args in {
            "window": (T0, T0 - minutes(5), "5 minutes", ["PARTS_PER_HOUR"]),
            "no window": (T0, T0, "5 minutes", ["PARTS_PER_HOUR"]),
            "under a minute": (T0, T0 + minutes(5), "30 seconds", ["PARTS_PER_HOUR"]),
            "not whole minutes": (T0, T0 + minutes(5), "90 seconds", ["PARTS_PER_HOUR"]),
            "months": (T0, T0 + minutes(5), "1 month", ["PARTS_PER_HOUR"]),
            "over four days": (T0, T0 + timedelta(days=30), "5 days", ["PARTS_PER_HOUR"]),
        }.items():
            with self.subTest(label):
                self.refuse(*args)

    def test_a_metric_that_is_not_derived_is_refused_before_any_read(self):
        self.refuse(T0, T0 + minutes(5), "5 minutes", ["PART_COUNT"])
        self.refuse(T0, T0 + minutes(5), "5 minutes", ["PARTS_PER_HOUR", "NOT_IN_THE_CATALOGUE"])
        error = self.refuse(T0, T0 + minutes(5), "5 minutes", ["PART_COUNT"])
        self.assertIn("is not a derived metric", str(error))

    def test_a_missing_list_is_refused(self):
        for assets, metrics in ((None, [self.name("PARTS_PER_HOUR")]), ([DEVICE], None)):
            with self.subTest(assets=assets, metrics=metrics):
                self.assertRefused(self.as_person, "SELECT * FROM public.derived_series(%s, %s, '5 minutes', %s, %s);",
                                   (T0, T0 + minutes(5), assets, metrics))

    def test_more_than_5000_rows_is_refused_and_5000_is_not(self):
        # One device, one metric: 5,001 buckets of a minute, a day and a half too many.
        self.refuse(T0, T0 + minutes(5001), "1 minute", ["PARTS_PER_HOUR"])
        # 5,000 passes the row check, and reaches the read it has no table for.
        with self.assertRaises(psycopg2.Error) as caught:
            self.series(T0, T0 + minutes(5000), "1 minute", ["PARTS_PER_HOUR"])
        self.assertEqual(caught.exception.pgcode, "42P01")
        # Devices and metrics count as well as buckets.
        self.refuse(T0, T0 + minutes(1500), "1 minute", ["PARTS_PER_HOUR", "UPTIME", "BUSY", "RUN_SHARE"], assets=(DEVICE, OTHER))

    def test_more_than_250000_minutes_of_input_is_refused(self):
        # 20 devices over 30 days at a day is 600 rows, and 864,000 minutes to read.
        assets = [f"dev0000000000000000004{i:02d}" for i in range(20)]
        error = self.refuse(DAY0, DAY0 + timedelta(days=30), "1 day", ["PARTS_PER_HOUR"], assets=assets)
        self.assertIn("minutes", str(error))
        # The inputs of a sum count: 3 inputs of 20 devices over 5 days.
        self.refuse(DAY0, DAY0 + timedelta(days=5), "1 day", ["POWER"], assets=[f"dev0000000000000000005{i:02d}" for i in range(40)])


class TheCurrentValue(DerivedBase):
    """The rule for each kind, against minutes counted back from the last whole minute."""

    def setUp(self):
        super().setUp()
        self.cur.execute("SELECT date_trunc('minute', now());")
        self.end = self.cur.fetchone()[0]

    def current(self, leaves, assets=(DEVICE,), role="authenticated"):
        rows = self.as_person("SELECT * FROM public.derived_current(%s, %s);",
                              (list(assets), [self.name(leaf) for leaf in leaves]), role=role)
        out = [dict(zip(self.columns, r)) for r in rows]
        return {(r["asset_id"], r["metric_name"].split("/")[1]): r for r in out}

    def test_a_rate_is_over_the_hour_ending_at_the_last_whole_minute(self):
        # Rising by 1 a minute for the hour before, then by 2: the last hour is 120 an hour.
        values = list(range(60)) + [59 + 2 * (i + 1) for i in range(60)]
        self.counter(self.end - minutes(120), values)
        got = self.current(["PARTS_PER_HOUR"])[(DEVICE, "PARTS_PER_HOUR")]
        self.assertAlmostEqual(got["value"], 120.0)
        self.assertEqual((got["observed_at"], got["window_minutes"]), (self.end, 60))

    def test_a_time_in_state_is_the_share_of_the_last_hour(self):
        self.minute(self.end - minutes(90), text="READY", leaf="EXECUTION")
        self.minute(self.end - minutes(60), text="ACTIVE", leaf="EXECUTION")
        self.minute(self.end - minutes(40), text="READY", leaf="EXECUTION")
        got = self.current(["UPTIME"])[(DEVICE, "UPTIME")]
        # Active for the first 20 minutes of the hour only, though it was ready for the 30 before it.
        self.assertAlmostEqual(got["value"], 20 / 60)
        self.assertEqual((got["observed_at"], got["window_minutes"]), (self.end, 60))

    def test_a_sum_is_its_value_at_the_last_whole_minute(self):
        self.minute(self.end - minutes(30), 10, leaf="PHASE_A")
        self.minute(self.end - minutes(1), 6, last=7, n=2, leaf="PHASE_A")
        self.minute(self.end - minutes(30), 1, leaf="PHASE_B")
        self.minute(self.end - minutes(30), 2, leaf="PHASE_C")
        got = self.current(["POWER"])[(DEVICE, "POWER")]
        # 7 + 1 - 2: the last reading of the last whole minute, not that minute's average, and nothing
        # from the minute that holds now.
        self.assertEqual((got["value"], got["observed_at"], got["window_minutes"]), (6, self.end, 0))

    def test_a_device_with_no_value_has_no_row(self):
        self.counter(self.end - minutes(10), [1, 2, 3, 4])
        self.assertEqual(self.current(["PARTS_PER_HOUR"], assets=(OTHER,)), {})

    def test_the_window_is_the_one_derived_window_minutes_names(self):
        self.cur.execute("SELECT m.name, public.derived_window_minutes(m.derivation) FROM public.metric_catalog m"
                         " WHERE m.name LIKE %s AND m.derivation IS NOT NULL ORDER BY m.name;", (self.group + "/%",))
        self.assertEqual(self.cur.fetchall(), [
            (self.name("BUSY"), 60), (self.name("PARTS_PER_HOUR"), 60), (self.name("POWER"), 0),
            (self.name("RUN_SHARE"), 60), (self.name("UPTIME"), 60)])

    def test_more_devices_than_one_read_of_the_hour_takes_are_read_in_parts(self):
        assets = [f"dev0000000000000000006{i:02d}" for i in range(100)]
        for asset in assets:
            self.counter(self.end - minutes(5), [1, 2, 3, 4, 5, 6], asset=asset)
        got = self.current(["PARTS_PER_HOUR"], assets=assets)
        self.assertEqual(len(got), 100)
        self.assertTrue(all(abs(r["value"] - 60.0) < 1e-9 for r in got.values()))

    def test_a_metric_that_is_not_derived_and_too_many_devices_are_refused(self):
        self.assertRefused(self.current, ["PART_COUNT"])
        self.assertRefused(self.current, ["PARTS_PER_HOUR"], assets=[f"dev{i:021d}" for i in range(5001)])


class WhoMayRead(DerivedBase):
    def test_the_operator_may_call_both(self):
        self.counter(T0, [1, 2, 3, 4, 5])
        self.assertEqual(len(self.one(T0, T0 + minutes(5), "5 minutes", "PARTS_PER_HOUR")), 1)
        self.as_person("SELECT * FROM public.derived_current(%s, %s);", ([DEVICE], [self.name("PARTS_PER_HOUR")]))

    def test_anon_may_call_neither(self):
        self.assertRefused(self.series, T0, T0 + minutes(5), "5 minutes", ["PARTS_PER_HOUR"], role="anon",
                           code=INSUFFICIENT_PRIVILEGE)
        self.assertRefused(self.as_person, "SELECT * FROM public.derived_current(%s, %s);",
                           ([DEVICE], [self.name("PARTS_PER_HOUR")]), role="anon", code=INSUFFICIENT_PRIVILEGE)

    def test_they_run_as_the_caller(self):
        self.cur.execute("SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig FROM pg_proc p"
                         " WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('derived_series', 'derived_current');")
        for name, definer, volatility, config in self.cur.fetchall():
            self.assertFalse(definer, name)
            self.assertEqual(volatility, "s", name)
            self.assertIn("search_path=public", config, name)

    def test_grafana_reader_holds_no_grant_on_either(self):
        self.cur.execute("SELECT to_regrole('grafana_reader') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("this database has no grafana_reader")
        for fn in (SERIES, "public.derived_current(text[], text[])"):
            self.cur.execute("SELECT has_function_privilege('grafana_reader', %s, 'EXECUTE');", (fn,))
            self.assertFalse(self.cur.fetchone()[0], fn)


if __name__ == "__main__":
    unittest.main(verbosity=2)
