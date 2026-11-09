"""
An export of readings is checked, bounded and recorded in the database (0278, 0279).

    python supabase/migrations/test_an_export_of_readings_is_bounded_and_recorded_in_the_database.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * history.export_max_days (0278): declared in the History category as a number from 1 to 366, 14
    unless changed, held to its bounds, and changed by an Administrator alone; 14 days where the row
    is missing.
  * What export_telemetry() refuses, each before any read: a caller who is not an Administrator or a
    Shopfloor Manager (an Operator, an Auditor, a machine identity, no identity, anon, service_role),
    a manager's session that has not given its second factor while that is required, a window that
    does not end after it starts or is longer than the setting (the sentence names the limit and
    where it is set), an unknown resolution, no device or no metric, and too many of either. Every
    refusal runs with the historian's relations gone, so a read would fail with another error.
  * A window of exactly the limit is allowed and a second more refused, with the limit as set.
  * The rows: one per reading with its time, device, metric, value and unit; raw by default; a
    rollup's rows are its own buckets' averages (a text or a flag its last value) and never raw's;
    the window is half open; only the devices and metrics asked for.
  * The bound: at most 50,000 rows, whole hours and then whole minutes of what the rollup counts,
    with truncated and read_to saying where the rows end; a minute holding more than that returns
    none; a count that was short is trimmed; raw is read from the oldest reading the historian holds.
  * The Audit Trail row: one TELEMETRY_EXPORTED row in the asset lane, a read, naming who exported,
    the devices (with their names) and metrics, the window, the resolution and how many rows left.
    The id comes back with the rows. A refusal writes none, and neither does an export with no rows.
    Who reads it.

The db lane has no historian, so local tables stand in for the foreign ones, inside the transaction.
EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

OPERATOR_ID = "a0d17279-0000-4000-8000-0000000279a1"
MANAGER_ID = "a0d17279-0000-4000-8000-0000000279a2"
ADMIN_ID = "a0d17279-0000-4000-8000-0000000279a3"
AUDITOR_ID = "a0d17279-0000-4000-8000-0000000279a4"
MACHINE_ID = "a0d17279-0000-4000-8000-0000000279a5"
PEOPLE = ((OPERATOR_ID, "Operator"), (MANAGER_ID, "Shopfloor_Manager"), (ADMIN_ID, "Administrator"),
          (AUDITOR_ID, "Auditor"))

KEY = "history.export_max_days"
SWITCH_KEY = "security.require_mfa_for_managers"
TEMP = "Test_0279/Temperature"
STATE = "Test_0279/State"
RUN = "Test_0279/Running"
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


def iso(t):
    """A time as the function writes it: UTC to the millisecond."""
    return t.astimezone(timezone.utc).strftime(ISO)[:-3] + "Z"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class ExportBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.export_telemetry(timestamp with time zone,"
                         " timestamp with time zone, text[], text[], text)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0279 is not applied to this database")
        self.cur.execute("SELECT name, id FROM public.roles;")
        roles = dict(self.cur.fetchall())
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id[-4:]}@export.test"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, NULL, '', now()) ON CONFLICT (id) DO NOTHING;", (MACHINE_ID,))

        # The historian's relations as local tables, as the foreign ones are shaped and granted.
        for rollup in ROLLUPS:
            self.cur.execute(f"DROP FOREIGN TABLE timescale.telemetry_{rollup} CASCADE;"
                             f"CREATE TABLE timescale.telemetry_{rollup} ({ROLLUP_COLUMNS});")
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry CASCADE;"
            "CREATE TABLE timescale.telemetry (\"time\" timestamptz NOT NULL, asset_id text NOT NULL,"
            " metric_name text NOT NULL, val_double double precision, val_string text, val_bool boolean);")

        # Two devices, and three metrics in the catalogue: two with a unit and one without.
        self.lathe = self.make_device("Test_0279_Lathe")
        self.press = self.make_device("Test_0279_Press")
        for name, datatype, units in ((TEMP, 10, "°C"), (STATE, 12, None), (RUN, 11, None)):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units) VALUES (%s, %s, %s);",
                             (name, datatype, units))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def make_device(self, name):
        device_id = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.devices (id, name) VALUES (%s, %s) RETURNING sparkplug_id;",
                         (device_id, name))
        return self.cur.fetchone()[0]

    def raw(self, asset, metric, *pairs):
        """Raw readings, each (time, value): a str is a text, a bool a flag, any other a number."""
        for at, value in pairs:
            self.cur.execute(
                "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_double, val_string, val_bool)"
                " VALUES (%s, %s, %s, %s, %s, %s);",
                (at, asset, metric,
                 value if not isinstance(value, (str, bool)) else None,
                 value if isinstance(value, str) else None,
                 value if isinstance(value, bool) else None))

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

    def seconds(self, asset, metric, first, count, step="1 second"):
        """`count` numeric readings of one series from `first`, one every `step`, the value its index."""
        self.cur.execute(
            "INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_double)"
            " SELECT %s::timestamptz + g * %s::interval, %s, %s, g FROM generate_series(0, %s - 1) g;",
            (first, step, asset, metric, count))

    def buckets(self, rollup, assets, metric, first, count, step="1 minute"):
        """`count` rollup buckets of each asset from `first`, one every `step`, each one numeric reading."""
        self.cur.execute(
            f"INSERT INTO timescale.telemetry_{rollup}"
            "  (bucket, asset_id, metric_name, sum_double, n_double, min_double, max_double, last_double, n_rows)"
            " SELECT %s::timestamptz + g * %s::interval, a, %s, g, 1, g, g, g, 1"
            "   FROM generate_series(0, %s - 1) g CROSS JOIN unnest(%s::text[]) a;",
            (first, step, metric, count, list(assets)))

    def limit(self, days):
        """As the owner, past the Settings page; the test rolls it back."""
        self.cur.execute("UPDATE public.system_settings SET value = to_jsonb(%s) WHERE key = %s;", (days, KEY))

    def mfa(self, on):
        self.cur.execute("UPDATE public.system_settings SET value = %s::jsonb WHERE key = %s;",
                         ("true" if on else "false", SWITCH_KEY))

    def audit_rows(self):
        self.cur.execute(
            "SELECT id, action, entity_type, entity_id::text, audit_domain, changed_by::text, actor_source,"
            "       old_data, new_data,"
            "       public.audit_event_class(action, entity_type, audit_domain, old_data, new_data)"
            "  FROM public.audit_trail WHERE action = 'TELEMETRY_EXPORTED' AND recorded_at >= now()"
            " ORDER BY id;")
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
        return {"sub": user_id, "role": "authenticated", "aal": aal, "email": f"{user_id[-4:]}@export.test"}

    def export(self, who, start, end, assets, metrics, resolution=None, aal="aal1"):
        """The document, as `who` exports it. No resolution is the function's default."""
        sql = "SELECT public.export_telemetry(%s, %s, %s, %s" + (", %s" if resolution is not None else "") + ");"
        args = (start, end, list(assets) if assets is not None else None,
                list(metrics) if metrics is not None else None) + ((resolution,) if resolution is not None else ())
        return self.as_role(self.person(who, aal), sql, args)[0][0]

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, caught.exception.pgerror)
        return caught.exception

    @staticmethod
    def times(doc):
        return [r[0] for r in doc["rows"]]


class TheSetting(ExportBase):
    def test_it_is_a_number_from_1_to_366_in_the_history_category(self):
        self.cur.execute("SELECT value, value_type, category, label, min_value, max_value, read_only, sensitive"
                         "  FROM public.system_settings WHERE key = %s;", (KEY,))
        self.assertEqual(self.cur.fetchone(),
                         (14, "number", "History", "Longest export (days)", 1, 366, False, False))

    def test_it_is_held_to_its_bounds(self):
        for days in (0, 0.5, 367):
            with self.subTest(days=days):
                self.cur.execute("SAVEPOINT bound;")
                with self.assertRaises(psycopg2.errors.CheckViolation):
                    self.limit(days)
                self.cur.execute("ROLLBACK TO SAVEPOINT bound;")
        for days in (1, 366):
            self.limit(days)

    def test_only_an_administrator_changes_it_and_every_role_reads_it(self):
        update = "UPDATE public.system_settings SET value = to_jsonb(30) WHERE key = %s RETURNING key;"
        for who in (OPERATOR_ID, MANAGER_ID, AUDITOR_ID):
            self.assertEqual(self.as_role(self.person(who), update, (KEY,)), [], who)
        self.assertEqual(self.as_role(self.person(ADMIN_ID), update, (KEY,)), [(KEY,)])
        for who in (OPERATOR_ID, MANAGER_ID, AUDITOR_ID, ADMIN_ID):
            self.assertEqual(self.as_role(self.person(who), "SELECT value FROM public.system_settings WHERE key = %s;",
                                          (KEY,)), [(30,)], who)

    def test_a_missing_row_is_14_days_and_a_set_one_is_as_set(self):
        def reads():
            self.cur.execute("SELECT public.telemetry_export_max_days();")
            return self.cur.fetchone()[0]
        self.assertEqual(reads(), 14)
        self.limit(3)
        self.assertEqual(reads(), 3)
        self.cur.execute("DELETE FROM public.system_settings WHERE key = %s;", (KEY,))
        self.assertEqual(reads(), 14)

    def test_only_export_telemetry_calls_the_reader(self):
        for role in ("anon", "authenticated", "service_role"):
            self.cur.execute("SELECT has_function_privilege(%s, 'public.telemetry_export_max_days()', 'EXECUTE');", (role,))
            self.assertFalse(self.cur.fetchone()[0], role)


class Refusals(ExportBase):
    """Every refusal, with the historian's relations gone: a read would fail with 42P01, so a
    refusal that is not 42P01 came before it."""

    def setUp(self):
        super().setUp()
        self.cur.execute("DROP TABLE timescale.telemetry, timescale.telemetry_1m, timescale.telemetry_5m,"
                         " timescale.telemetry_1h;")
        self.before = len(self.audit_rows())

    def tearDown(self):
        self.assertEqual(len(self.audit_rows()), self.before, "a refusal wrote an Audit Trail row")
        super().tearDown()

    def asked(self, who=MANAGER_ID, start=T0, end=T0 + timedelta(hours=1), assets=("a",), metrics=("m",), **kwargs):
        return self.export(who, start, end, assets, metrics, **kwargs)

    def test_an_operator_an_auditor_and_a_machine_identity_are_refused_with_the_roles_in_words(self):
        for who in (OPERATOR_ID, AUDITOR_ID):
            refusal = self.assertRefused("42501", self.asked, who)
            self.assertEqual(refusal.diag.message_primary, "Only an Administrator or a Shopfloor Manager may export readings.")
        self.assertRefused("42501", self.as_role, {"sub": MACHINE_ID, "role": "authenticated"},
                           "SELECT public.export_telemetry(%s, %s, %s, %s);", (T0, T0 + timedelta(hours=1), ["a"], ["m"]))

    def test_no_identity_anon_and_service_role_are_refused(self):
        sql = "SELECT public.export_telemetry(%s, %s, %s, %s);"
        args = (T0, T0 + timedelta(hours=1), ["a"], ["m"])
        # The owner, with no token: no person behind the call.
        self.assertRefused("42501", self.as_role, {}, sql, args, role="postgres")
        self.assertRefused("42501", self.as_role, {}, sql, args, role="anon")
        self.assertRefused("42501", self.as_role, {"role": "service_role"}, sql, args, role="service_role")

    def test_a_window_over_the_limit_is_refused_naming_the_limit_and_where_it_is_set(self):
        sentence = "An export can cover at most %s, set on Settings › History. This window is %s days."
        for who in (MANAGER_ID, ADMIN_ID):
            refusal = self.assertRefused("22023", self.asked, who, end=T0 + timedelta(days=14, seconds=1))
            self.assertEqual(refusal.diag.message_primary, sentence % ("14 days", 15))
        self.limit(1)
        refusal = self.assertRefused("22023", self.asked, end=T0 + timedelta(days=1, seconds=1))
        self.assertEqual(refusal.diag.message_primary, sentence % ("1 day", 2))
        self.limit(1.5)
        refusal = self.assertRefused("22023", self.asked, end=T0 + timedelta(hours=36, seconds=1))
        self.assertEqual(refusal.diag.message_primary, sentence % ("1.5 days", 2))
        self.limit(366)
        self.assertRefused("22023", self.asked, end=T0 + timedelta(days=366, seconds=1))

    def test_a_window_of_exactly_the_limit_is_not_refused_for_its_length(self):
        # It gets as far as the read, which is gone: 42P01, not 22023.
        self.assertRefused("42P01", self.asked, end=T0 + timedelta(days=14))
        self.limit(1)
        self.assertRefused("42P01", self.asked, end=T0 + timedelta(days=1))

    def test_a_window_that_does_not_end_after_it_starts_is_refused(self):
        self.assertRefused("22023", self.asked, end=T0)
        self.assertRefused("22023", self.asked, end=T0 - timedelta(hours=1))
        self.assertRefused("22023", self.asked, start=None)
        self.assertRefused("22023", self.asked, end=None)

    def test_an_unknown_resolution_is_refused(self):
        for resolution in ("1d", "RAW", "15m", "", "raw "):
            with self.subTest(resolution=resolution):
                self.assertRefused("22023", self.asked, resolution=resolution)
        # NULL is not raw either: the default is for an argument left out.
        self.assertRefused("22023", self.as_role, self.person(MANAGER_ID),
                           "SELECT public.export_telemetry(%s, %s, %s, %s, NULL);",
                           (T0, T0 + timedelta(hours=1), ["a"], ["m"]))
        for resolution in ("raw", "1m", "5m", "1h"):
            self.assertRefused("42P01", self.asked, resolution=resolution)

    def test_no_device_or_no_metric_is_refused(self):
        for assets, metrics in (((), ("m",)), (("a",), ()), (None, ("m",)), (("a",), None), ((" ", None), ("m",)),
                                (("a",), ("", None))):
            with self.subTest(assets=assets, metrics=metrics):
                self.assertRefused("22023", self.asked, assets=assets, metrics=metrics)

    def test_more_than_1000_devices_or_500_metrics_is_refused_and_the_most_is_not(self):
        self.assertRefused("22023", self.asked, assets=[f"d{i}" for i in range(1001)])
        self.assertRefused("22023", self.asked, metrics=[f"m{i}" for i in range(501)])
        self.assertRefused("42P01", self.asked, assets=[f"d{i}" for i in range(1000)], metrics=[f"m{i}" for i in range(500)])
        # The same device twice, or a blank, is one.
        self.assertRefused("42P01", self.asked, assets=["d"] * 1500 + [" "])

    def test_with_the_second_factor_required_a_manager_needs_a_session_that_gave_it(self):
        self.mfa(True)
        for who in (MANAGER_ID, ADMIN_ID):
            refusal = self.assertRefused("42501", self.asked, who, aal="aal1")
            self.assertEqual(refusal.diag.message_detail, "mfa_required")
            # With the code given it goes on to the read, which is gone.
            self.assertRefused("42P01", self.asked, who, aal="aal2")
        # Off, an aal1 session is let through.
        self.mfa(False)
        self.assertRefused("42P01", self.asked, MANAGER_ID, aal="aal1")


class WhoMayCall(ExportBase):
    def test_the_function_is_declared_once_and_only_an_authenticated_role_may_execute_it(self):
        self.cur.execute("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
                         " WHERE n.nspname = 'public' AND p.proname = 'export_telemetry';")
        self.assertEqual(self.cur.fetchone()[0], 1)
        self.cur.execute(
            "SELECT has_function_privilege('anon', f, 'EXECUTE'), has_function_privilege('service_role', f, 'EXECUTE'),"
            "       has_function_privilege('authenticated', f, 'EXECUTE')"
            "  FROM (SELECT 'public.export_telemetry(timestamp with time zone, timestamp with time zone, text[], text[], text)'::regprocedure) x(f);")
        self.assertEqual(self.cur.fetchone(), (False, False, True))

    def test_an_administrator_and_a_manager_may_and_the_others_may_not(self):
        self.raw(self.lathe, TEMP, (T0, 20.0))
        self.rollups()
        for who in (MANAGER_ID, ADMIN_ID):
            self.assertEqual(self.export(who, T0, T0 + timedelta(hours=1), [self.lathe], [TEMP])["row_count"], 1)
        for who in (OPERATOR_ID, AUDITOR_ID):
            self.assertRefused("42501", self.export, who, T0, T0 + timedelta(hours=1), [self.lathe], [TEMP])


class TheRows(ExportBase):
    def setUp(self):
        super().setUp()
        s = timedelta(seconds=1)
        # The lathe: a temperature three times in two minutes, a state twice and a flag once.
        self.raw(self.lathe, TEMP, (T0, 20.5), (T0 + 30 * s, 21.0), (T0 + 90 * s, 22.0))
        self.raw(self.lathe, STATE, (T0 + 10 * s, "RUN"), (T0 + 100 * s, "STOP"))
        self.raw(self.lathe, RUN, (T0 + 20 * s, True))
        self.raw(self.press, TEMP, (T0 + 15 * s, 30.0))
        # Outside the window: a second before it and the instant it ends.
        self.raw(self.lathe, TEMP, (T0 - s, 99.0), (T0 + timedelta(hours=1), 98.0))
        self.rollups()
        self.end = T0 + timedelta(hours=1)

    def test_raw_is_one_row_a_reading_in_time_order_with_its_value_and_unit(self):
        doc = self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP, STATE, RUN])
        self.assertEqual(doc["columns"], ["time", "asset_id", "metric_name", "value", "unit"])
        self.assertEqual(doc["rows"], [
            [iso(T0), self.lathe, TEMP, 20.5, "°C"],
            [iso(T0 + timedelta(seconds=10)), self.lathe, STATE, "RUN", None],
            [iso(T0 + timedelta(seconds=20)), self.lathe, RUN, True, None],
            [iso(T0 + timedelta(seconds=30)), self.lathe, TEMP, 21.0, "°C"],
            [iso(T0 + timedelta(seconds=90)), self.lathe, TEMP, 22.0, "°C"],
            [iso(T0 + timedelta(seconds=100)), self.lathe, STATE, "STOP", None],
        ])
        self.assertEqual((doc["row_count"], doc["resolution"], doc["truncated"], doc["max_rows"]), (6, "raw", False, CAP))

    def test_raw_is_the_default_and_the_window_is_half_open(self):
        by_default = self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP])
        named = self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP], resolution="raw")
        self.assertEqual(by_default["rows"], named["rows"])
        # The reading a second before the window and the one at its end are not in it.
        self.assertEqual(self.times(by_default), [iso(T0), iso(T0 + timedelta(seconds=30)), iso(T0 + timedelta(seconds=90))])

    def test_only_the_devices_and_metrics_asked_for_and_each_once(self):
        doc = self.export(MANAGER_ID, T0, self.end, [self.press, self.press, " "], [TEMP, TEMP])
        self.assertEqual(doc["rows"], [[iso(T0 + timedelta(seconds=15)), self.press, TEMP, 30.0, "°C"]])
        both = self.export(MANAGER_ID, T0, self.end, [self.press, self.lathe], [TEMP])
        self.assertEqual([r[1] for r in both["rows"]], [self.lathe, self.press, self.lathe, self.lathe])
        self.assertEqual(self.export(MANAGER_ID, T0, self.end, [self.press], [STATE])["row_count"], 0)

    def test_a_rollup_is_its_own_buckets_average_and_a_text_or_a_flag_its_last_value(self):
        doc = self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP, STATE, RUN], resolution="1m")
        self.assertEqual(doc["resolution"], "1m")
        self.assertEqual(doc["rows"], [
            # The 10:00 bucket averages the readings at :00 and :30; the 10:01 bucket holds the one at :30 later.
            [iso(T0), self.lathe, RUN, True, None],
            [iso(T0), self.lathe, STATE, "RUN", None],
            [iso(T0), self.lathe, TEMP, 20.75, "°C"],
            [iso(T0 + timedelta(minutes=1)), self.lathe, STATE, "STOP", None],
            [iso(T0 + timedelta(minutes=1)), self.lathe, TEMP, 22.0, "°C"],
        ])
        five = self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP], resolution="5m")
        self.assertEqual(five["rows"], [[iso(T0), self.lathe, TEMP, (20.5 + 21.0 + 22.0) / 3, "°C"]])
        hour = self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP], resolution="1h")
        self.assertEqual(hour["rows"], [[iso(T0), self.lathe, TEMP, (20.5 + 21.0 + 22.0) / 3, "°C"]])

    def test_a_rollup_is_never_read_in_raw_s_place_nor_raw_in_a_rollup_s(self):
        # The rollups hold what raw does not say, so a substitution would show.
        self.cur.execute("UPDATE timescale.telemetry_1m SET sum_double = 1000, n_double = 10"
                         " WHERE metric_name = %s AND asset_id = %s AND bucket = %s;", (TEMP, self.lathe, T0))
        self.assertEqual(self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP])["rows"][0][3], 20.5)
        self.assertEqual(self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP], resolution="1m")["rows"][0][3], 100.0)
        self.cur.execute("DELETE FROM timescale.telemetry_1m;")
        self.assertEqual(self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP], resolution="1m")["row_count"], 0)

    def test_a_metric_the_catalogue_does_not_know_has_no_unit(self):
        self.raw(self.lathe, "Test_0279/Uncatalogued", (T0 + timedelta(seconds=5), 1.0))
        self.rollups()
        doc = self.export(MANAGER_ID, T0, self.end, [self.lathe], ["Test_0279/Uncatalogued"])
        self.assertEqual(doc["rows"][0][4], None)
        self.assertEqual(self.export(MANAGER_ID, T0, self.end, [self.press], [TEMP])["rows"][0][4], "°C")

    def test_a_number_is_written_as_the_double_that_was_published_whatever_the_session_s_digits(self):
        # The shortest text that reads back as the same double, not the 15 digits a session set to 0 gives.
        self.raw(self.press, TEMP, (T0 + timedelta(seconds=40), 0.1 + 0.2), (T0 + timedelta(seconds=41), 21.166666666666668))
        self.cur.execute("SET extra_float_digits = 0;")
        doc = self.export(MANAGER_ID, T0, self.end, [self.press], [TEMP])
        self.assertEqual([r[3] for r in doc["rows"]], [30.0, 0.30000000000000004, 21.166666666666668])

    def test_a_window_that_starts_before_raw_is_read_from_where_raw_begins_and_says_so(self):
        # The rollups hold two earlier days that raw has dropped.
        early = T0 - timedelta(days=2)
        self.buckets("1m", [self.lathe], TEMP, early, 2880)
        doc = self.export(MANAGER_ID, early, self.end, [self.lathe], [TEMP])
        # Raw begins at the reading a second before T0, which is in: that and the three in the window.
        self.assertEqual(doc["row_count"], 4)
        self.assertFalse(doc["truncated"])
        self.assertEqual((doc["raw_from"], doc["read_from"]), (iso(T0 - timedelta(seconds=1)), iso(T0 - timedelta(seconds=1))))
        # A rollup is read as far back as it goes, and has no raw horizon to name.
        rolled = self.export(MANAGER_ID, early, self.end, [self.lathe], [TEMP], resolution="1m")
        self.assertIsNone(rolled["raw_from"])
        self.assertEqual(rolled["read_from"], iso(early))
        self.assertEqual(rolled["row_count"], 2880 + 3)


class TheBound(ExportBase):
    def test_a_window_of_exactly_the_limit_is_exported_and_a_second_more_is_not(self):
        self.raw(self.lathe, TEMP, (T0, 1.0), (T0 + timedelta(days=14) - timedelta(seconds=1), 2.0))
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=14), [self.lathe], [TEMP])
        self.assertEqual(doc["row_count"], 2)
        self.assertRefused("22023", self.export, MANAGER_ID, T0, T0 + timedelta(days=14, seconds=1), [self.lathe], [TEMP])
        self.limit(2)
        self.assertRefused("22023", self.export, MANAGER_ID, T0, T0 + timedelta(days=3), [self.lathe], [TEMP])
        self.assertEqual(self.export(MANAGER_ID, T0, T0 + timedelta(days=2), [self.lathe], [TEMP])["row_count"], 1)

    def test_exactly_the_cap_is_whole(self):
        self.seconds(self.lathe, TEMP, T0, CAP)
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=1), [self.lathe], [TEMP])
        self.assertEqual((doc["row_count"], doc["truncated"]), (CAP, False))
        self.assertEqual(doc["read_to"], iso(T0 + timedelta(days=1)))

    def test_past_the_cap_it_stops_at_a_minute_and_says_where(self):
        self.seconds(self.lathe, TEMP, T0, CAP + 10000)
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=1), [self.lathe], [TEMP])
        # 13 whole hours are 46,800 readings; the 14th would make 50,400, so its minutes are taken:
        # 53 of them, 3,180 readings, and the 54th would make 50,040.
        self.assertEqual((doc["row_count"], doc["truncated"]), (49980, True))
        self.assertEqual(doc["read_to"], iso(T0 + timedelta(hours=13, minutes=53)))
        self.assertEqual(len(doc["rows"]), 49980)
        self.assertEqual(doc["rows"][-1][0], iso(T0 + timedelta(seconds=49979)))
        # What was left out is what the cut says: nothing before it, everything from it.
        self.assertTrue(all(t < doc["read_to"] for t in self.times(doc)))

    def test_it_is_cut_from_the_window_s_start_when_the_start_is_not_on_the_hour(self):
        self.seconds(self.lathe, TEMP, T0, CAP + 10000)
        self.rollups()
        start = T0 + timedelta(minutes=30)
        doc = self.export(MANAGER_ID, start, start + timedelta(days=1), [self.lathe], [TEMP])
        self.assertTrue(doc["truncated"])
        self.assertLessEqual(doc["row_count"], CAP)
        # The first reading is the window's, and the rows end where the cut is.
        self.assertEqual(doc["rows"][0][0], iso(start))
        self.assertTrue(all(t < doc["read_to"] for t in self.times(doc)))
        self.assertGreater(doc["row_count"], CAP - 3600)

    def test_a_minute_that_holds_more_than_the_cap_returns_nothing_and_writes_no_row(self):
        self.seconds(self.lathe, TEMP, T0, CAP + 1, step="1 millisecond")
        self.rollups()
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(hours=2), [self.lathe], [TEMP])
        self.assertEqual((doc["row_count"], doc["rows"], doc["truncated"]), (0, [], True))
        self.assertEqual(doc["read_to"], doc["read_from"])
        self.assertIsNone(doc["audit_id"])
        self.assertEqual(self.audit_rows(), [])

    def test_a_count_that_was_short_is_trimmed_to_the_cap(self):
        # Raw holds more than the rollup says, as when a read arrives before the rollup has counted.
        self.seconds(self.lathe, TEMP, T0, CAP + 10)
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=1), [self.lathe], [TEMP])
        self.assertEqual((doc["row_count"], doc["truncated"], len(doc["rows"])), (CAP, True, CAP))
        self.assertEqual(doc["read_to"], iso(T0 + timedelta(seconds=CAP)))
        self.assertEqual(self.audit_rows()[0][8]["rows"], CAP)

    def test_a_rollup_is_bounded_the_same_way(self):
        # Three devices, a bucket a minute for 14 days: 60,480 rows; each hour is 180 of them.
        devices = [self.lathe, self.press, self.make_device("Test_0279_Mill")]
        self.buckets("1m", devices, TEMP, T0, 14 * 24 * 60)
        doc = self.export(MANAGER_ID, T0, T0 + timedelta(days=14), devices, [TEMP], resolution="1m")
        # 277 hours are 49,860 rows; of the next, 46 minutes (138 rows), and the 47th would make 50,001.
        self.assertEqual((doc["row_count"], doc["truncated"]), (49998, True))
        self.assertEqual(doc["read_to"], iso(T0 + timedelta(hours=277, minutes=46)))
        self.assertTrue(all(t < doc["read_to"] for t in self.times(doc)))


class TheAuditRow(ExportBase):
    def setUp(self):
        super().setUp()
        self.raw(self.lathe, TEMP, (T0, 20.5), (T0 + timedelta(seconds=30), 21.0))
        self.raw(self.press, STATE, (T0 + timedelta(seconds=15), "RUN"))
        self.rollups()
        self.end = T0 + timedelta(hours=1)

    def test_an_export_writes_one_read_in_the_asset_lane_naming_what_left(self):
        doc = self.export(MANAGER_ID, T0, self.end, [self.press, self.lathe], [TEMP, STATE, RUN], resolution="5m")
        (row,) = self.audit_rows()
        event_id, action, entity_type, entity_id, domain, changed_by, source, old, new, klass = row
        self.assertEqual((action, entity_type, domain, changed_by, source, klass),
                         ("TELEMETRY_EXPORTED", "telemetry", "asset", MANAGER_ID, "user", "read"))
        self.assertIsNone(old)
        self.assertEqual(doc["audit_id"], event_id)
        self.cur.execute("SELECT md5('telemetry:readings')::uuid::text;")
        self.assertEqual(entity_id, self.cur.fetchone()[0])
        self.assertEqual(new, {
            "name": "Readings",
            "devices": [{"id": self.lathe, "name": "Test_0279_Lathe"}, {"id": self.press, "name": "Test_0279_Press"}],
            "metrics": sorted([TEMP, STATE, RUN]),
            "from": iso(T0), "to": iso(self.end), "resolution": "5m",
            "rows": 2, "truncated": False, "read_to": iso(self.end),
            "exported_by_email": f"{MANAGER_ID[-4:]}@export.test",
        })

    def test_a_truncated_export_says_where_its_rows_end(self):
        self.seconds(self.lathe, TEMP, T0 + timedelta(hours=2), CAP + 100)
        self.rollups()
        doc = self.export(ADMIN_ID, T0, T0 + timedelta(days=1), [self.lathe], [TEMP])
        new = self.audit_rows()[0][8]
        self.assertEqual((new["rows"], new["truncated"], new["read_to"]), (doc["row_count"], True, doc["read_to"]))

    def test_each_export_writes_its_own_row_by_the_person_who_made_it(self):
        self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP])
        self.export(ADMIN_ID, T0, self.end, [self.lathe], [TEMP])
        self.assertEqual([r[5] for r in self.audit_rows()], [MANAGER_ID, ADMIN_ID])

    def test_an_export_with_no_rows_writes_none_and_names_no_audit_row(self):
        doc = self.export(MANAGER_ID, T0 + timedelta(hours=5), T0 + timedelta(hours=6), [self.lathe], [TEMP])
        self.assertEqual((doc["row_count"], doc["rows"], doc["audit_id"], doc["truncated"]), (0, [], None, False))
        self.assertEqual(self.audit_rows(), [])

    def test_a_device_the_platform_does_not_know_is_named_by_its_id(self):
        self.raw("devunknown0279", TEMP, (T0, 1.0))
        self.rollups()
        self.export(MANAGER_ID, T0, self.end, ["devunknown0279"], [TEMP])
        self.assertEqual(self.audit_rows()[0][8]["devices"], [{"id": "devunknown0279", "name": None}])

    def test_who_reads_it(self):
        doc = self.export(MANAGER_ID, T0, self.end, [self.lathe], [TEMP])
        read = "SELECT count(*) FROM public.audit_trail WHERE id = %s;"
        # The asset lane: the two roles that export, and an Auditor. Not an Operator.
        for who, seen in ((MANAGER_ID, 1), (ADMIN_ID, 1), (AUDITOR_ID, 1), (OPERATOR_ID, 0)):
            self.assertEqual(self.as_role(self.person(who), read, (doc["audit_id"],))[0][0], seen, who)


if __name__ == "__main__":
    unittest.main()
