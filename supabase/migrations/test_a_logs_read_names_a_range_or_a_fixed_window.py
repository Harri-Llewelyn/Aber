# suite:
#   lanes: db
#   why: 0230 -- that a read of a service's logs names a rolling range or a fixed window's two ends:
#     a fixed window's row records its ends in UTC to the millisecond, one row for each new window
#     and none for a repeat, whatever offset or session time zone the ends arrive in; a range or two
#     ends, never both, in order and at most 169 hours apart; and one six-argument form after 0225
#     and 0230 replay over the four-argument one.

"""
A read of a service's logs names a rolling range or a fixed window's two ends (0230).

    python supabase/migrations/test_a_logs_read_names_a_range_or_a_fixed_window.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * record_service_logs_read() takes p_from and p_to after p_range. A fixed window's row records its
    two ends, in UTC to the millisecond, and no range; a rolling window's records its range, as
    before. A row is written for each new window and none for a repeat: a poll of the last hour, a
    refresh of yesterday, and yesterday's ends written with another offset or under another session
    time zone are each the read before them.
  * A range or two ends, never both; both ends, in order; at most 169 hours apart, the 7 days of a
    week and the hour it gains when the clocks go back. Anything else is refused with no row.
  * One form is declared, with p_from and p_to defaulting to NULL, so a call naming the four
    arguments alone, as a rolling read is sent, is still that form's. A database still holding the
    four-argument form is brought to the one form by 0225 and 0230 replayed, and 0230 drops it by
    itself too.

EVERY TEST ROLLS BACK. The acts write Audit Trail rows, and the audit table cannot be pruned.
"""
import hashlib
import json
import os
import re
import unittest
import uuid
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "a0d17070-0000-4000-8000-0000000230a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000230a2"

# A service name no stack runs, so the rows this suite writes are its own.
SERVICE = "logs-check-0230"

HERE = Path(__file__).resolve().parent
OWNER = HERE / "0225_reading_a_service_s_logs_is_recorded.sql"
MIGRATION = HERE / "0230_a_logs_read_names_a_range_or_a_fixed_window.sql"

FORM = (
    "p_service text, p_level text, p_filter text, p_range text, "
    "p_from timestamp with time zone, p_to timestamp with time zone"
)
TYPES = "text, text, text, text, timestamp with time zone, timestamp with time zone"

# Yesterday and the day before, in London on 2 November 2026, which is GMT.
YESTERDAY = ("2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z")
DAY_BEFORE = ("2026-10-31T00:00:00Z", "2026-11-01T00:00:00Z")
# London's week of 19 October 2026: Monday's midnight is BST's, the next Monday's GMT's.
CLOCK_CHANGE_WEEK = ("2026-10-18T23:00:00Z", "2026-10-26T00:00:00Z")


def lane(service):
    """The id 0225 files every read of a service under: the md5 of `service_logs:<service>`."""
    return str(uuid.UUID(hashlib.md5(f"service_logs:{service}".encode()).hexdigest()))


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s);", (f"public.record_service_logs_read({TYPES})",))
        if self.cur.fetchone()[0] is None:
            self.skipTest("0230 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in ((ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@service-logs.test"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def call(self, user_id, sql, args=()):
        """Run `sql` as PostgREST would for a token naming `user_id`. A refusal rolls back to the
        savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT window_call;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": "authenticated"}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT window_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT window_call;")
        return rows

    def read(self, window=None, range=None, level="any", filter="", caller=ADMIN_ID):
        """A read as service-logs sends it: the range alone for a rolling window, by name, and the
        two ends with a NULL range for a fixed one."""
        if window is None:
            return self.call(
                caller,
                "SELECT public.record_service_logs_read(p_service => %s, p_level => %s, p_filter => %s,"
                " p_range => %s);",
                (SERVICE, level, filter, range or "1h"),
            )[0][0]
        return self.call(
            caller,
            "SELECT public.record_service_logs_read(p_service => %s, p_level => %s, p_filter => %s,"
            " p_range => %s, p_from => %s, p_to => %s);",
            (SERVICE, level, filter, range, window[0], window[1]),
        )[0][0]

    def rows(self):
        self.cur.execute(
            "SELECT new_data FROM public.audit_trail WHERE entity_type = 'service_logs' AND entity_id = %s"
            " ORDER BY id;",
            (lane(SERVICE),),
        )
        return [r[0] for r in self.cur.fetchall()]

    def forms(self):
        self.cur.execute(
            "SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'record_service_logs_read' ORDER BY 1;"
        )
        return [r[0] for r in self.cur.fetchall()]


# -------------------------------------------------------------------------------------------------
# What a row records, and when one is due
# -------------------------------------------------------------------------------------------------
class AWindowsRow(Base):
    def test_a_fixed_window_records_its_two_ends_in_utc_and_no_range(self):
        self.assertIsNotNone(self.read(YESTERDAY, level="error", filter="dev01"))
        self.assertEqual(self.rows(), [{
            "name": SERVICE, "level": "error", "filter": "dev01",
            "from": "2026-11-01T00:00:00.000Z", "to": "2026-11-02T00:00:00.000Z",
        }])

    def test_a_rolling_window_records_its_range_as_before(self):
        self.read(range="6h")
        self.assertEqual(self.rows(), [{"name": SERVICE, "level": "any", "filter": None, "range": "6h"}])

    def test_one_row_for_each_new_window_and_none_for_a_repeat(self):
        answers = [
            self.read(),                                            # Last 1 hour, the tab's first load
            self.read(),                                            # a poll of it
            self.read(YESTERDAY),                                   # stepped to yesterday
            self.read(YESTERDAY),                                   # a refresh of yesterday
            self.read(("2026-11-01T01:00:00+01:00", "2026-11-02T00:00:00.000+00:00")),  # the same, spelt otherwise
            self.read(DAY_BEFORE),                                  # the day before
            self.read(),                                            # back to Last 1 hour
            self.read(),
        ]
        self.assertEqual([a is not None for a in answers], [True, False, True, False, False, True, True, False])
        self.assertEqual(len(self.rows()), 4)

    def test_the_session_time_zone_does_not_change_what_is_recorded(self):
        self.read(YESTERDAY)
        self.cur.execute("SET LOCAL TimeZone = 'Pacific/Auckland';")
        self.assertIsNone(self.read(YESTERDAY))
        self.assertEqual(self.rows()[0]["from"], "2026-11-01T00:00:00.000Z")

    def test_a_week_that_holds_a_clock_change_is_recorded(self):
        self.assertIsNotNone(self.read(CLOCK_CHANGE_WEEK))
        self.assertEqual((self.rows()[0]["from"], self.rows()[0]["to"]),
                         ("2026-10-18T23:00:00.000Z", "2026-10-26T00:00:00.000Z"))

    def test_a_window_outside_the_rule_is_refused_with_no_row(self):
        for name, window, range in [
            ("a range and two ends", YESTERDAY, "1h"),
            ("a range and one end", (YESTERDAY[0], None), "1h"),
            ("one end alone", (YESTERDAY[0], None), None),
            ("the other end alone", (None, YESTERDAY[1]), None),
            ("neither end and no range", (None, None), None),
            ("the ends equal", (YESTERDAY[0], YESTERDAY[0]), None),
            ("the ends reversed", (YESTERDAY[1], YESTERDAY[0]), None),
            ("a millisecond over 169 hours", (CLOCK_CHANGE_WEEK[0], "2026-10-26T00:00:00.001Z"), None),
            ("a month", ("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"), None),
        ]:
            with self.subTest(name):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.read(window, range=range)
        self.assertEqual(self.rows(), [])

    def test_only_an_administrator_records_a_fixed_window(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.read(YESTERDAY, caller=MANAGER_ID)
        self.assertEqual(self.rows(), [])


# -------------------------------------------------------------------------------------------------
# One form, whatever replays
# -------------------------------------------------------------------------------------------------
class OneForm(Base):
    def create_four_argument_form(self):
        """The form a database from before 0230 holds, beside the one 0225 now declares."""
        self.cur.execute(
            "CREATE FUNCTION public.record_service_logs_read(p_service text, p_level text, p_filter text,"
            " p_range text) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'"
            " AS $$ SELECT NULL::bigint $$;"
        )

    def block(self, path, pattern):
        found = re.search(pattern, path.read_text(encoding="utf-8"), re.S)
        self.assertIsNotNone(found, f"{path.name} no longer has the block this replays")
        return found.group(0)

    def oid(self):
        self.cur.execute("SELECT %s::regprocedure::oid;", (f"public.record_service_logs_read({TYPES})",))
        return self.cur.fetchone()[0]

    def test_the_chain_leaves_one_form_with_the_ends_defaulting_to_null(self):
        self.assertEqual(self.forms(), [FORM])
        self.cur.execute(
            "SELECT pronargdefaults, prosecdef, 'search_path=public' = ANY (proconfig),"
            "       has_function_privilege('authenticated', oid, 'EXECUTE'),"
            "       has_function_privilege('anon', oid, 'EXECUTE'),"
            "       has_function_privilege('service_role', oid, 'EXECUTE')"
            "  FROM pg_proc WHERE oid = %s;",
            (self.oid(),),
        )
        self.assertEqual(self.cur.fetchone(), (2, True, True, True, False, False))

    def test_a_first_upgrade_boot_ends_with_the_one_form(self):
        """0225 declares the new form beside the old one, its self-check calls the new one by its
        six arguments, and 0230 drops the old one."""
        self.create_four_argument_form()
        self.cur.execute(OWNER.read_text(encoding="utf-8"))
        self.assertEqual(len(self.forms()), 2)
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.assertEqual(self.forms(), [FORM])
        # A rolling read names four arguments, and is not ambiguous.
        self.assertIsNotNone(self.read())

    def test_a_later_boot_replays_without_recreating_anything(self):
        before = self.oid()
        for path in (OWNER, MIGRATION):
            self.cur.execute(path.read_text(encoding="utf-8"))
        self.assertEqual(self.oid(), before)
        self.assertEqual(self.forms(), [FORM])

    def test_0230_drops_the_four_argument_form_by_itself(self):
        self.create_four_argument_form()
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.assertEqual(self.forms(), [FORM])

    def test_the_self_check_refuses_two_forms(self):
        check = self.block(MIGRATION, r"DO \$check\$.*?\$check\$;")
        self.create_four_argument_form()
        with self.assertRaises(psycopg2.errors.RaiseException) as raised:
            self.cur.execute(check)
        self.assertIn("declared 2 times", str(raised.exception))

    def test_every_declaration_is_the_six_argument_form(self):
        declared = re.compile(r"CREATE OR REPLACE FUNCTION public\.record_service_logs_read\((.*?)\)\s+RETURNS", re.S)
        found = []
        for path in sorted(HERE.glob("[0-9][0-9][0-9][0-9]_*.sql")):
            for m in declared.finditer(path.read_text(encoding="utf-8")):
                found.append(path.name)
                args = " ".join(m.group(1).split())
                for arg in ("p_range text", "p_from timestamp with time zone DEFAULT NULL",
                            "p_to timestamp with time zone DEFAULT NULL"):
                    self.assertIn(arg, args, f"{path.name} declares record_service_logs_read without {arg}")
        self.assertEqual(found, [OWNER.name])


if __name__ == "__main__":
    unittest.main(verbosity=2)
