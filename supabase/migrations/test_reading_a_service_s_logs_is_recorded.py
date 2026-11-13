# suite:
#   lanes: db
#   why: 0225 -- that a read of a service's logs on the System page writes one SERVICE_LOGS_READ row
#     in the service's lane of the security domain, naming the Administrator and the read's service,
#     level, filter and range; that the database, not the caller, decides a row is due: one on the
#     first load and on each change, none on a refresh or a repeated direct call, and another
#     person's reads are not the caller's; that only an Administrator may write one; and that a
#     parameter outside the function's rule is refused with no row.

"""
Reading a service's logs is recorded in the Audit Trail (0225).

    python supabase/migrations/test_reading_a_service_s_logs_is_recorded.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: record_service_logs_read() writes one SERVICE_LOGS_READ row in the service_logs
lane of the security domain, naming the Administrator and the read's service, level, filter and
range, and returns its id. It writes nothing and returns NULL while the parameters are the caller's
last recorded read: so a row on the first load, one on each change, none on a refresh, and none on a
repeated direct call. Another person's reads are not the caller's. Only an Administrator may write
one; a level, range, service or filter outside the function's rule is refused with no row. An
Auditor reads the rows and a Shopfloor_Manager does not.

EVERY TEST ROLLS BACK. The acts write Audit Trail rows, and the audit table cannot be pruned.
"""
import hashlib
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "a0d17070-0000-4000-8000-0000000225a1"
OTHER_ADMIN_ID = "a0d17070-0000-4000-8000-0000000225a5"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000225a2"
OPERATOR_ID = "a0d17070-0000-4000-8000-0000000225a3"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000225a4"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000225c1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000225d1"

# A service name no stack runs, so the rows this suite writes are its own.
SERVICE = "logs-check-0225"
OTHER_SERVICE = "logs-check-0225-other"


def lane(service):
    """The id 0225 files every read of a service under: the md5 of `service_logs:<service>`."""
    return str(uuid.UUID(hashlib.md5(f"service_logs:{service}".encode()).hexdigest()))


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class ServiceLogsReadBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        # The form 0230 added the window's two ends to; this suite reads rolling windows alone.
        self.cur.execute("SELECT to_regprocedure('public.record_service_logs_read(text, text, text, text,"
                         " timestamp with time zone, timestamp with time zone)');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0225 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        people = [
            (ADMIN_ID, "Administrator"), (OTHER_ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"),
            (OPERATOR_ID, "Operator"), (AUDITOR_ID, "Auditor"), (NO_ROLE_ID, None),
        ]
        for user_id, role in people:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@service-logs.test"),
            )
            if role:
                self.cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (user_id, roles[role]),
                )
        # A machine identity: no email, no password, and so no role.
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, NULL, NULL, now()) ON CONFLICT (id) DO NOTHING;",
            (MACHINE_ID,),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def call(self, user_id, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id`. A refusal rolls back to the
        savepoint, so the test can go on, and is raised."""
        claims = {"sub": user_id, "role": role}
        self.cur.execute("SAVEPOINT service_logs_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT service_logs_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT service_logs_call;")
        return rows

    def read(self, service=SERVICE, level="any", filter="", range="1h", caller=ADMIN_ID, role="authenticated"):
        return self.call(caller, "SELECT public.record_service_logs_read(%s, %s, %s, %s);",
                         (service, level, filter, range), role=role)[0][0]

    def rows(self, service=SERVICE):
        self.cur.execute(
            "SELECT id, action, old_data, new_data, changed_by::text, actor_source, audit_domain, causation_id"
            "  FROM public.audit_trail WHERE entity_type = 'service_logs' AND entity_id = %s ORDER BY id;",
            (lane(service),),
        )
        return self.cur.fetchall()

    def txid(self):
        self.cur.execute("SELECT txid_current();")
        return self.cur.fetchone()[0]


class OneRowPerRead(ServiceLogsReadBase):
    def test_a_read_writes_one_row_naming_the_administrator_and_what_was_read(self):
        row_id = self.read(level="warning", filter='dev01" |= "x', range="6h")
        [(rid, action, old, new, changed_by, source, domain, causation)] = self.rows()
        self.assertEqual(rid, row_id)
        self.assertEqual(action, "SERVICE_LOGS_READ")
        self.assertIsNone(old)
        self.assertEqual(new, {"name": SERVICE, "level": "warning", "filter": 'dev01" |= "x', "range": "6h"})
        self.assertEqual((changed_by, source, domain), (ADMIN_ID, "user", "security"))
        self.assertEqual(causation, self.txid())

    def test_no_filter_is_recorded_as_none(self):
        self.read(filter="")
        self.assertIsNone(self.rows()[0][3]["filter"])

    def test_a_row_on_load_and_on_each_change_and_none_on_a_refresh_or_a_repeated_call(self):
        answers = [
            self.read(),                                      # the tab's first load
            self.read(),                                      # a refresh, or a poll
            self.read(filter="dev01"),                        # a filter typed
            self.read(filter="dev01"),                        # the same read, straight to the API
            self.read(filter="dev01", level="error"),         # a level picked
            self.read(filter="dev01", level="error", range="24h"),  # a range picked
            self.read(),                                      # back to the first read: a change too
            self.read(),
        ]
        self.assertEqual([a is not None for a in answers], [True, False, True, False, True, True, True, False])
        self.assertEqual(len(self.rows()), 5)

    def test_each_service_is_its_own_lane(self):
        self.read()
        self.read(service=OTHER_SERVICE)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(len(self.rows(OTHER_SERVICE)), 1)
        self.assertNotEqual(lane(SERVICE), lane(OTHER_SERVICE))

    def test_another_administrators_read_is_not_the_callers(self):
        self.assertIsNotNone(self.read())
        self.assertIsNotNone(self.read(caller=OTHER_ADMIN_ID))
        self.assertIsNone(self.read())
        self.assertEqual([r[4] for r in self.rows()], [ADMIN_ID, OTHER_ADMIN_ID])

    def test_a_read_older_than_a_day_is_not_the_last_read(self):
        self.read()
        # The row as if written yesterday: the owner's session may move it, as no API role can.
        self.cur.execute("UPDATE public.audit_trail SET recorded_at = now() - interval '25 hours'"
                         " WHERE entity_type = 'service_logs' AND entity_id = %s;", (lane(SERVICE),))
        self.assertIsNotNone(self.read())
        self.assertEqual(len(self.rows()), 2)

    def test_a_parameter_outside_the_rule_is_refused_with_no_row(self):
        for kwargs in [
            {"level": "critical"}, {"level": None}, {"level": ""},
            {"range": "30d"}, {"range": "1h30m"}, {"range": None},
            {"service": ""}, {"service": None}, {"service": "s" * 129}, {"service": "two\nlines"},
            {"filter": "x" * 201},
        ]:
            with self.subTest(**{k: (v if v is None or len(str(v)) < 20 else f"{len(v)} chars") for k, v in kwargs.items()}):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.read(**kwargs)
        self.assertEqual(self.rows(), [])

    def test_the_limits_are_counted_in_characters(self):
        self.read(filter="é" * 200)
        self.read(service="é" * 128)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(len(self.rows("é" * 128)), 1)


class WhoMay(ServiceLogsReadBase):
    def test_only_an_administrator_records_a_read(self):
        for caller in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NO_ROLE_ID, MACHINE_ID):
            with self.subTest(caller=caller):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.read(caller=caller)
        self.assertEqual(self.rows(), [])

    def test_anon_and_service_role_cannot_call_it(self):
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.read(role=role)

    def test_the_rows_are_in_the_security_lane_an_auditor_reads_and_a_manager_does_not(self):
        self.read()
        sql = ("SELECT action FROM public.audit_trail WHERE entity_type = 'service_logs'"
               " AND entity_id = %s ORDER BY id;")
        self.assertEqual([r[0] for r in self.call(AUDITOR_ID, sql, (lane(SERVICE),))], ["SERVICE_LOGS_READ"])
        self.assertEqual(self.call(MANAGER_ID, sql, (lane(SERVICE),)), [])
        self.assertEqual(self.call(OPERATOR_ID, sql, (lane(SERVICE),)), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
