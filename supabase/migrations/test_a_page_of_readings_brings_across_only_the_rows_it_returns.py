# suite:
#   lanes: db
#   why: 0315's telemetry_page() and telemetry_rollup_page(), over local tables standing in for the
#     historian's relations: each returns the rows a read of the view returned, in its order and with
#     its page boundaries, wherever the page's last row falls (the newest bin, an older one, mid
#     instant, past the window's end); offset pages tile a window; a rollup's average is the view's;
#     a bad page is refused before any read; and they run as the caller, granted as the telemetry
#     views are.

"""
A page of readings brings across only the rows it returns (0315).

    python supabase/migrations/test_a_page_of_readings_brings_across_only_the_rows_it_returns.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * The rows. Each page read returns what `SELECT ... FROM public.telemetry` (or the rollup view)
    returned for the same bounds, newest first with ties in device and metric order, LIMIT and
    OFFSET applied: for one metric, one device and every device; with and without each bound; an
    upper bound that includes or excludes its instant; a page that ends in the newest bin, in an
    older one, or inside an instant several metrics share; and a window holding fewer rows than the
    page.
  * The pages. Consecutive offset pages tile the window with no gap and no overlap.
  * Where a page starts. telemetry_page_start() names the instant of the page's last row, and NULL
    when the window holds fewer rows.
  * The refusals, before any read: a limit under one, an offset under zero, a resolution that is not
    1m, 5m or 1h, a relation that is not telemetry or a rollup, a page of no rows.
  * Who may call them: authenticated and service_role, not anon, as SECURITY INVOKER.

The db lane has no historian, so local tables stand in for the foreign ones, inside the transaction.
The stack suite test_a_page_of_readings_sends_the_historian_its_bound.py holds what the historian is
sent. EVERY TEST ROLLS BACK.
"""
import os
import unittest
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.errors
from psycopg2 import sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

PAGE = ("public.telemetry_page(text, text, timestamp with time zone, timestamp with time zone,"
        " boolean, integer, integer)")
ROLLUP_PAGE = ("public.telemetry_rollup_page(text, text, text, timestamp with time zone,"
               " timestamp with time zone, boolean, integer, integer)")
START = ("public.telemetry_page_start(text, text, text, timestamp with time zone,"
         " timestamp with time zone, boolean, bigint)")
ROLLUPS = {"1m": "1 minute", "5m": "5 minutes", "1h": "1 hour"}
ROLLUP_COLUMNS = (
    "bucket timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,"
    " sum_double double precision, n_double bigint, min_double double precision,"
    " max_double double precision, last_double double precision, last_string text,"
    " last_bool boolean, n_rows bigint"
)
A, B = "dev10000000000000000315a", "dev20000000000000000315b"
# Well in the past, on the hour.
T0 = datetime(2026, 1, 5, 10, 0, tzinfo=timezone.utc)
RAW = ('"time", asset_id, metric_name, val_double, val_string, val_bool')
BUCKET = ("bucket, asset_id, metric_name, avg_double, min_double, max_double, last_double,"
          " last_string, last_bool, n_double, n_rows")
ROLLUP_VIEWS = {"1m": "telemetry_1m", "5m": "telemetry_5m", "1h": "telemetry_1h"}
# A read of the view as the readers made one, an omitted bound filtering nothing.
VIEW_READ = sql.SQL(
    "SELECT {columns} FROM {relation} t"
    " WHERE (%(asset)s::text IS NULL OR t.asset_id = %(asset)s)"
    "   AND (%(metric)s::text IS NULL OR t.metric_name = %(metric)s)"
    "   AND (%(start)s::timestamptz IS NULL OR t.{at} >= %(start)s)"
    "   AND (%(end)s::timestamptz IS NULL OR t.{at} < %(end)s OR (%(inclusive)s AND t.{at} = %(end)s))"
    " ORDER BY t.{at} DESC, t.asset_id, t.metric_name LIMIT %(limit)s OFFSET %(offset)s;")


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class PageBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s) IS NOT NULL;", (PAGE,))
        if not self.cur.fetchone()[0]:
            self.skipTest("0315 is not applied to this database")
        # The historian's relations as local tables, as the foreign ones are shaped and granted, and
        # the views over them as 0001 declares them.
        for rollup in ROLLUPS:
            self.cur.execute(f"DROP FOREIGN TABLE timescale.telemetry_{rollup} CASCADE;"
                             f"CREATE TABLE timescale.telemetry_{rollup} ({ROLLUP_COLUMNS});"
                             f"GRANT SELECT ON timescale.telemetry_{rollup} TO authenticated, service_role;"
                             f"CREATE VIEW public.telemetry_{rollup} WITH (security_invoker='true') AS"
                             f" SELECT bucket, asset_id, metric_name,"
                             f" (sum_double / (NULLIF(n_double, 0))::double precision) AS avg_double,"
                             f" min_double, max_double, last_double, last_string, last_bool, n_double, n_rows"
                             f" FROM timescale.telemetry_{rollup} t;")
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry CASCADE;"
            "CREATE TABLE timescale.telemetry (\"time\" timestamptz NOT NULL, asset_id text NOT NULL,"
            " metric_name text NOT NULL, val_double double precision, val_string text, val_bool boolean);"
            "GRANT SELECT ON timescale.telemetry TO authenticated, service_role;"
            "CREATE VIEW public.telemetry WITH (security_invoker='true') AS"
            " SELECT \"time\", asset_id, metric_name, val_double, val_string, val_bool FROM timescale.telemetry;")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def every(self, asset, metric, first, count, step):
        """`count` numeric readings of one series from `first`, one every `step`, the value its index."""
        self.cur.execute(
            "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_double)"
            " SELECT %s::timestamptz + g * %s::interval, %s, %s, g FROM generate_series(0, %s - 1) g;",
            (first, step, asset, metric, count))

    def reading(self, asset, metric, at, value):
        """One reading: a str is a text, a bool a flag, any other a number."""
        self.cur.execute(
            "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_double, val_string, val_bool)"
            " VALUES (%s, %s, %s, %s, %s, %s);",
            (at, asset, metric,
             value if not isinstance(value, (str, bool)) else None,
             value if isinstance(value, str) else None,
             value if isinstance(value, bool) else None))

    def buckets(self, rollup, asset, metric, first, count, step):
        """`count` buckets of one series from `first`, one every `step`, each of two readings."""
        self.cur.execute(
            f"INSERT INTO timescale.telemetry_{rollup}"
            "  (bucket, asset_id, metric_name, sum_double, n_double, min_double, max_double, last_double, n_rows)"
            " SELECT %s::timestamptz + g * %s::interval, %s, %s, 2 * g + 1, 2, g, g + 1, g + 1, 2"
            "   FROM generate_series(0, %s - 1) g;",
            (first, step, asset, metric, count))

    # ---- the two reads -----------------------------------------------------------------------
    def page(self, asset=None, metric=None, start=None, end=None, inclusive=True, limit=500, offset=0):
        self.cur.execute(f"SELECT {RAW} FROM public.telemetry_page(%s, %s, %s, %s, %s, %s, %s);",
                         (asset, metric, start, end, inclusive, limit, offset))
        return self.cur.fetchall()

    def view(self, asset=None, metric=None, start=None, end=None, inclusive=True, limit=500, offset=0):
        """What a read of public.telemetry returned for the same bounds, its ties in device and metric order."""
        self.cur.execute(VIEW_READ.format(columns=sql.SQL(RAW), relation=sql.Identifier("public", "telemetry"),
                                          at=sql.Identifier("time")),
                         {"asset": asset, "metric": metric, "start": start, "end": end,
                          "inclusive": inclusive, "limit": limit, "offset": offset})
        return self.cur.fetchall()

    def rollup_page(self, resolution, asset=None, metric=None, start=None, end=None, inclusive=True,
                    limit=500, offset=0):
        self.cur.execute(f"SELECT {BUCKET} FROM public.telemetry_rollup_page(%s, %s, %s, %s, %s, %s, %s, %s);",
                         (resolution, asset, metric, start, end, inclusive, limit, offset))
        return self.cur.fetchall()

    def rollup_view(self, resolution, asset=None, metric=None, start=None, end=None, inclusive=True,
                    limit=500, offset=0):
        self.cur.execute(VIEW_READ.format(columns=sql.SQL(BUCKET),
                                          relation=sql.Identifier("public", ROLLUP_VIEWS[resolution]),
                                          at=sql.Identifier("bucket")),
                         {"asset": asset, "metric": metric, "start": start, "end": end,
                          "inclusive": inclusive, "limit": limit, "offset": offset})
        return self.cur.fetchall()

    def start(self, relation, asset=None, metric=None, start=None, end=None, inclusive=True, rows=1):
        self.cur.execute("SELECT public.telemetry_page_start(%s, %s, %s, %s, %s, %s, %s);",
                         (relation, asset, metric, start, end, inclusive, rows))
        return self.cur.fetchone()[0]


class TheRowsAreTheViewsRows(PageBase):
    def setUp(self):
        super().setUp()
        # Three hours of A/Temp every 10 s; A/Pressure every 30 s, on Temp's instants; B/Temp every
        # minute; and a text and a flag on A that share an instant with Temp.
        self.every(A, "Temp", T0, 1080, "10 seconds")
        self.every(A, "Pressure", T0, 360, "30 seconds")
        self.every(B, "Temp", T0, 180, "1 minute")
        self.reading(A, "State", T0 + timedelta(hours=2, minutes=59, seconds=50), "RUN")
        self.reading(A, "Running", T0 + timedelta(hours=2, minutes=59, seconds=50), True)

    def test_each_reader_shape_returns_the_views_rows_in_its_order(self):
        end = T0 + timedelta(hours=3)
        for shape in (
            {"asset": A, "metric": "Temp", "start": T0, "end": end, "limit": 500},
            {"asset": A, "metric": "Temp", "start": T0, "end": end, "limit": 500, "offset": 500},
            {"asset": A, "start": T0, "end": end, "limit": 1001},
            {"asset": A, "end": T0 + timedelta(hours=2), "inclusive": False, "limit": 1000},
            {"asset": A, "limit": 5000},
            {"asset": A, "end": T0 + timedelta(hours=1, minutes=30), "limit": 5001},
            {"start": T0 + timedelta(hours=2), "limit": 5000},
            {"start": T0, "end": end, "limit": 7},
            {"asset": B, "metric": "Temp", "start": T0, "end": end, "limit": 1},
        ):
            with self.subTest(**{k: str(v) for k, v in shape.items()}):
                expected = self.view(**shape)
                self.assertTrue(expected, "the shape reads something")
                self.assertEqual(self.page(**shape), expected)

    def test_a_page_ending_in_an_older_bin_is_whole(self):
        # A/Temp holds 360 rows an hour, so its 800th newest is in the third hour back.
        shape = {"asset": A, "metric": "Temp", "start": T0, "limit": 300, "offset": 500}
        self.assertEqual(len(self.page(**shape)), 300)
        self.assertEqual(self.page(**shape), self.view(**shape))

    def test_a_page_ending_inside_a_shared_instant_takes_its_rows_in_metric_order(self):
        # The newest instant, 12:59:50, holds Running, State and Temp.
        last = T0 + timedelta(hours=2, minutes=59, seconds=50)
        for limit in (1, 2, 3, 4, 5, 6):
            with self.subTest(limit=limit):
                shape = {"asset": A, "limit": limit}
                self.assertEqual(self.page(**shape), self.view(**shape))
        self.assertEqual([r[2] for r in self.page(asset=A, limit=3)], ["Running", "State", "Temp"])
        self.assertEqual({r[0] for r in self.page(asset=A, limit=3)}, {last})

    def test_an_upper_bound_includes_its_instant_or_not_as_asked(self):
        at = T0 + timedelta(minutes=30)
        included = self.page(asset=A, metric="Temp", end=at, limit=1)
        excluded = self.page(asset=A, metric="Temp", end=at, inclusive=False, limit=1)
        self.assertEqual(included[0][0], at)
        self.assertEqual(excluded[0][0], at - timedelta(seconds=10))

    def test_a_window_holding_fewer_rows_than_the_page_is_read_whole(self):
        shape = {"asset": B, "metric": "Temp", "start": T0, "end": T0 + timedelta(hours=3), "limit": 5000}
        self.assertEqual(len(self.page(**shape)), 180)
        self.assertEqual(self.page(**shape), self.view(**shape))
        self.assertEqual(self.page(asset="dev-nobody", limit=10), [])
        self.assertEqual(self.page(asset=A, start=T0 + timedelta(hours=4), limit=10), [], "past every row")

    def test_offset_pages_tile_the_window(self):
        whole = self.view(asset=A, start=T0, limit=100000)
        pages, offset = [], 0
        while True:
            page = self.page(asset=A, start=T0, limit=333, offset=offset)
            pages += page
            if len(page) < 333:
                break
            offset += 333
        self.assertEqual(pages, whole)
        self.assertEqual(len(pages), 1080 + 360 + 2)

    def test_the_page_starts_at_its_last_rows_instant(self):
        newest = T0 + timedelta(hours=2, minutes=59, seconds=50)
        # Newest first, A/Temp's 361st row is an hour back, in the bin before the newest.
        self.assertEqual(self.start("telemetry", A, "Temp", rows=361), newest - timedelta(hours=1))
        self.assertEqual(self.start("telemetry", A, "Temp", rows=1), newest)
        self.assertIsNone(self.start("telemetry", A, "Temp", rows=1081), "a window holding fewer has no start")
        self.assertEqual(self.start("telemetry", A, "Temp", rows=1080), T0)
        self.assertEqual(self.start("telemetry", A, "Temp", end=T0 + timedelta(hours=1), inclusive=False, rows=1),
                         T0 + timedelta(minutes=59, seconds=50))


class TheRollupsAreTheViewsRows(PageBase):
    def setUp(self):
        super().setUp()
        self.buckets("1m", A, "Temp", T0, 600, "1 minute")
        self.buckets("1m", A, "Pressure", T0, 300, "2 minutes")
        self.buckets("1m", B, "Temp", T0, 600, "1 minute")
        self.buckets("5m", A, "Temp", T0, 600, "5 minutes")
        self.buckets("1h", A, "Temp", T0, 2000, "1 hour")
        self.buckets("1h", A, "Pressure", T0, 2000, "1 hour")

    def test_each_reader_shape_returns_the_views_rows_in_its_order(self):
        for resolution, shape in (
            ("1m", {"asset": A, "metric": "Temp", "start": T0, "end": T0 + timedelta(hours=10), "limit": 1001}),
            ("1m", {"asset": A, "end": T0 + timedelta(hours=5), "inclusive": False, "limit": 1000}),
            ("1m", {"start": T0, "limit": 500, "offset": 250}),
            ("5m", {"asset": A, "metric": "Temp", "end": T0 + timedelta(days=1), "limit": 100}),
            ("1h", {"asset": A, "limit": 5000}),
            ("1h", {"asset": A, "end": T0 + timedelta(days=40), "limit": 1501}),
            ("1h", {"asset": A, "metric": "Pressure", "limit": 3, "offset": 1990}),
        ):
            with self.subTest(resolution=resolution, **{k: str(v) for k, v in shape.items()}):
                expected = self.rollup_view(resolution, **shape)
                self.assertTrue(expected, "the shape reads something")
                self.assertEqual(self.rollup_page(resolution, **shape), expected)

    def test_a_bucket_carries_the_views_average(self):
        row = self.rollup_page("1m", A, "Temp", limit=1)[0]
        self.assertEqual(row[3], (2 * 599 + 1) / 2)
        self.assertEqual((row[9], row[10]), (2, 2))


class ABadPageIsRefusedBeforeAnyRead(PageBase):
    def setUp(self):
        super().setUp()
        # A read would fail on these with another error.
        self.cur.execute("DROP TABLE timescale.telemetry CASCADE;"
                         "DROP TABLE timescale.telemetry_1m CASCADE;")

    def refused(self, statement, args):
        self.cur.execute("SAVEPOINT bad;")
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as caught:
            self.cur.execute(statement, args)
        self.cur.execute("ROLLBACK TO SAVEPOINT bad;")
        return str(caught.exception)

    def test_each_refusal_names_what_is_wrong(self):
        for statement, args, phrase in (
            ("SELECT * FROM public.telemetry_page(%s, NULL, NULL, NULL, true, %s, 0);", (A, 0), "p_limit 0"),
            ("SELECT * FROM public.telemetry_page(%s, NULL, NULL, NULL, true, %s, 0);", (A, None), "p_limit"),
            ("SELECT * FROM public.telemetry_page(%s, NULL, NULL, NULL, true, 10, %s);", (A, -1), "p_offset -1"),
            ("SELECT * FROM public.telemetry_rollup_page(%s, %s);", ("30s", A), "1m, 5m or 1h"),
            ("SELECT * FROM public.telemetry_rollup_page(%s, %s);", (None, A), "1m, 5m or 1h"),
            ("SELECT * FROM public.telemetry_rollup_page('1m', %s, NULL, NULL, NULL, true, %s);", (A, 0), "p_limit 0"),
            ("SELECT public.telemetry_page_start(%s, %s, NULL, NULL, NULL, true, 1);", ("assets", A), "not telemetry"),
            ("SELECT public.telemetry_page_start('telemetry', %s, NULL, NULL, NULL, true, %s);", (A, 0), "first row"),
        ):
            with self.subTest(statement=statement, args=args):
                self.assertIn(phrase, self.refused(statement, args))


class WhoMayCallThem(PageBase):
    def test_authenticated_and_service_role_and_not_anon(self):
        for fn in (PAGE, ROLLUP_PAGE, START):
            self.cur.execute("SELECT p.prosecdef, p.provolatile, p.proconfig FROM pg_proc p WHERE p.oid = %s::regprocedure;",
                             (fn,))
            definer, volatility, config = self.cur.fetchone()
            self.assertEqual((definer, volatility), (False, "s"), f"{fn} is STABLE and runs as the caller")
            self.assertIn("search_path=public", config)
            for role, may in (("anon", False), ("authenticated", True), ("service_role", True)):
                with self.subTest(fn=fn, role=role):
                    self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE');", (role, fn))
                    self.assertEqual(self.cur.fetchone()[0], may)

    def test_it_reads_as_the_caller(self):
        self.every(A, "Temp", T0, 10, "1 second")
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.assertEqual(len(self.page(asset=A, limit=5)), 5)
        self.cur.execute("RESET ROLE;")
        # Without the grant the caller reads through, the caller is refused, not the owner's rows served.
        self.cur.execute("REVOKE SELECT ON timescale.telemetry FROM authenticated;")
        self.cur.execute("SET LOCAL ROLE authenticated;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.page(asset=A, limit=5)


if __name__ == "__main__":
    unittest.main()
