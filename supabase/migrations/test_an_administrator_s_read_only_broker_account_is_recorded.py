"""
An Administrator's read-only broker account is recorded in the Audit Trail (0218).

    python supabase/migrations/test_an_administrator_s_read_only_broker_account_is_recorded.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: record_broker_account_created() writes one INSERT row and
record_broker_account_deleted() one DELETE row, each in the broker_accounts lane of the security
domain, naming the Administrator, with what the account is for and its MQTT username, and both
rows of one account under one entity id. Only an Administrator may write either; a username
outside the subscriber scheme, and a name or description outside the credential service's rule,
are refused with no row. An Auditor reads the rows and a Shopfloor_Manager does not.

EVERY TEST ROLLS BACK. The acts write Audit Trail rows, and the audit table cannot be pruned.
"""
import json
import os
import unittest

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "a0d17070-0000-4000-8000-0000000218a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000218a2"
OPERATOR_ID = "a0d17070-0000-4000-8000-0000000218a3"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000218a4"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000218c1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000218d1"

USERNAME = "sub0a1b2c3d4e5f60718293a"
# The username's 21 hex characters, padded with zeros: the id both of its rows carry.
ENTITY_ID = "0a1b2c3d-4e5f-6071-8293-a00000000000"
NAME = "Line 4 OEE board"
DESCRIPTION = "The contractor dashboard on line 4. Reads only."

OUTSIDE_THE_SCHEME = [
    "gwy120000000000400080000", "gwy110000000000400080000", "aber_ingestion", "dynsec-admin",
    "scada-reader", "SUB0A1B2C3D4E5F60718293A", "sub0a1b2c3d4e5f60718293", "sub0a1b2c3d4e5f60718293ab",
    "sub0a1b2c3d4e5f60718293g", "", None,
]


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class BrokerAccountRecordBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.record_broker_account_created(text, text, text)');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0218 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        people = [
            (ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"), (OPERATOR_ID, "Operator"),
            (AUDITOR_ID, "Auditor"), (NO_ROLE_ID, None),
        ]
        for user_id, role in people:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@broker-accounts.test"),
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
        self.cur.execute("SAVEPOINT broker_account_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT broker_account_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT broker_account_call;")
        return rows

    def created(self, username=USERNAME, name=NAME, description=DESCRIPTION, caller=ADMIN_ID, role="authenticated"):
        return self.call(caller, "SELECT public.record_broker_account_created(%s, %s, %s);",
                         (username, name, description), role=role)[0][0]

    def deleted(self, username=USERNAME, name=NAME, description=DESCRIPTION, caller=ADMIN_ID, role="authenticated"):
        return self.call(caller, "SELECT public.record_broker_account_deleted(%s, %s, %s);",
                         (username, name, description), role=role)[0][0]

    def rows(self, entity_id=ENTITY_ID):
        self.cur.execute(
            "SELECT id, action, old_data, new_data, changed_by::text, actor_source, audit_domain, causation_id"
            "  FROM public.audit_trail WHERE entity_type = 'broker_accounts' AND entity_id = %s ORDER BY id;",
            (entity_id,),
        )
        return self.cur.fetchall()

    def txid(self):
        self.cur.execute("SELECT txid_current();")
        return self.cur.fetchone()[0]


class CreatingOne(BrokerAccountRecordBase):
    def test_one_insert_row_names_the_administrator_and_what_the_account_is_for(self):
        row_id = self.created()
        [(rid, action, old, new, changed_by, source, domain, causation)] = self.rows()
        self.assertEqual(rid, row_id)
        self.assertEqual(action, "INSERT")
        self.assertIsNone(old)
        self.assertEqual(new, {"name": NAME, "description": DESCRIPTION, "mqtt_username": USERNAME, "role": "subscriber"})
        self.assertEqual((changed_by, source, domain), (ADMIN_ID, "user", "security"))
        self.assertEqual(causation, self.txid())

    def test_the_name_and_description_are_stored_trimmed(self):
        self.created(name=f"  {NAME} ", description=f" {DESCRIPTION}  ")
        new = self.rows()[0][3]
        self.assertEqual((new["name"], new["description"]), (NAME, DESCRIPTION))

    def test_the_limits_are_counted_in_characters(self):
        self.created(name="é" * 80, description="✓" * 500)
        self.assertEqual(len(self.rows()), 1)

    def test_a_name_or_description_outside_the_rule_is_refused_with_no_row(self):
        for name, description in [
            ("", DESCRIPTION), ("   ", DESCRIPTION), (None, DESCRIPTION), ("x" * 81, DESCRIPTION),
            ("two\nlines", DESCRIPTION), ("a\ttab", DESCRIPTION),
            (NAME, ""), (NAME, None), (NAME, "x" * 501), (NAME, "two\nlines"), (NAME, "a\x7fb"),
        ]:
            with self.subTest(name=name, description=description):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.created(name=name, description=description)
        self.assertEqual(self.rows(), [])

    def test_a_username_outside_the_scheme_is_refused_with_no_row(self):
        for username in OUTSIDE_THE_SCHEME:
            with self.subTest(username=username):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.created(username=username)
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'broker_accounts'"
                         " AND (new_data ->> 'mqtt_username') = ANY (%s);", ([u for u in OUTSIDE_THE_SCHEME if u],))
        self.assertEqual(self.cur.fetchone()[0], 0)


class DeletingOne(BrokerAccountRecordBase):
    def test_one_delete_row_with_what_the_broker_held_under_the_creations_id(self):
        self.created()
        self.deleted()
        rows = self.rows()
        self.assertEqual([r[1] for r in rows], ["INSERT", "DELETE"])
        _, _, old, new, changed_by, source, domain, _ = rows[1]
        self.assertEqual(old, {"name": NAME, "description": DESCRIPTION, "mqtt_username": USERNAME})
        self.assertIsNone(new)
        self.assertEqual((changed_by, source, domain), (ADMIN_ID, "user", "security"))

    def test_an_account_the_broker_held_no_purpose_for_is_recorded_with_none(self):
        self.deleted(name=None, description="  ")
        self.assertEqual(self.rows()[0][2], {"name": None, "description": None, "mqtt_username": USERNAME})

    def test_a_username_outside_the_scheme_is_refused_with_no_row(self):
        for username in OUTSIDE_THE_SCHEME:
            with self.subTest(username=username):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.deleted(username=username)
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'broker_accounts'"
                         " AND (old_data ->> 'mqtt_username') = ANY (%s);", ([u for u in OUTSIDE_THE_SCHEME if u],))
        self.assertEqual(self.cur.fetchone()[0], 0)


class WhoMay(BrokerAccountRecordBase):
    def test_only_an_administrator_writes_either_row(self):
        for caller in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NO_ROLE_ID, MACHINE_ID):
            with self.subTest(caller=caller):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.created(caller=caller)
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.deleted(caller=caller)
        self.assertEqual(self.rows(), [])

    def test_anon_and_service_role_cannot_call_either(self):
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.created(role=role)
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.deleted(role=role)

    def test_the_rows_are_in_the_security_lane_an_auditor_reads_and_a_manager_does_not(self):
        self.created()
        self.deleted()
        sql = ("SELECT action FROM public.audit_trail WHERE entity_type = 'broker_accounts'"
               " AND entity_id = %s ORDER BY id;")
        self.assertEqual([r[0] for r in self.call(AUDITOR_ID, sql, (ENTITY_ID,))], ["INSERT", "DELETE"])
        self.assertEqual(self.call(MANAGER_ID, sql, (ENTITY_ID,)), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
