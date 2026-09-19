"""
A machine has a name an operator gave it (0125).

    python supabase/migrations/test_machine_principal_naming.py

Requires the Supabase database (54322 by default) and 0125 applied; `npm run test:db` gives it a
throwaway one.

---------------------------------------------------------------------------------------------
THREE THINGS, EACH PINNED WHERE IT COULD DRIFT.

`create_machine_principal()` takes a name and writes `machine_principals` IN THE SAME TRANSACTION
as the `auth.users` row, so a principal created from the page cannot exist without one. A blank or
duplicate name is refused before anything exists, and the refusal names the name rather than a
constraint.

The 0080 two-argument form is GONE, not overloaded. PostgREST resolves an RPC by the argument
names in the body, and an overload whose extra arguments default makes every old-shape call
ambiguous (a 300 rather than a row). 0080 recreates that form on every boot; 0125 drops it on
every boot; this asserts the order held.

The name table reads for Administrator and Auditor, the two roles that label the audit lane, and
for nobody else. No write policy: the function is the only write path.

EVERY TEST ROLLS BACK. The fixtures are seeded inside the test's own transaction, and
`SET LOCAL ROLE` scopes the impersonation to it, so nothing is committed and nothing needs
cleaning up. `is_machine_principal()` is "no email, no password, no identity provider", so the
HUMAN fixtures carry an email or 0080's trigger would refuse them a role.
"""

import os
import unittest
import uuid

import psycopg2
import psycopg2.errors
import psycopg2.extras

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ALLOWED = ("telemetry:read", "quarantine:view", "digital_thread:read")


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class NamingBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SELECT to_regclass('public.machine_principals');")
            if not cur.fetchone()[0]:
                raise unittest.SkipTest("0125 has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        self.admin = self.person("Administrator")
        self.auditor = self.person("Auditor")
        self.manager = self.person("Shopfloor_Manager")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- fixtures ---------------------------------------------------------------------------

    def person(self, role):
        """An auth.users row that can sign in (it has an email), holding one role."""
        user_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO auth.users (instance_id, id, aud, role, email) "
            "VALUES ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s);",
            (user_id, f"{user_id}@naming.test"),
        )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) "
            "SELECT %s, id FROM public.roles WHERE name = %s;",
            (user_id, role),
        )
        self.assertEqual(self.cur.rowcount, 1, f"role {role} is missing; 0001 did not run cleanly")
        return user_id

    def as_user(self, user_id):
        """Become `authenticated` with a JWT subject, the way PostgREST does it: claims only."""
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))

    def as_postgres(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute('RESET "request.jwt.claims";')

    def create(self, name, permissions=("telemetry:read",), purpose=None):
        self.cur.execute(
            "SELECT * FROM public.create_machine_principal(%s, %s::text[], %s);",
            (name, list(permissions), purpose),
        )
        return self.cur.fetchone()


class TheNameIsWrittenWithTheIdentity(NamingBase):

    def test_a_created_principal_carries_its_name_and_purpose(self):
        self.as_user(self.admin)
        row = self.create("Line 4 OEE report", ALLOWED, "Reads the hourly rollup for the OEE board.")
        # 0080's return shape, kept: a changed return type cannot ship under a name 0080 replays.
        self.assertEqual(sorted(row.keys()), ["permissions", "principal_id"])
        self.assertEqual(sorted(row["permissions"]), sorted(ALLOWED))

        self.as_postgres()
        self.cur.execute(
            "SELECT name, purpose, created_by FROM public.machine_principals WHERE principal_id = %s;",
            (row["principal_id"],),
        )
        stored = self.cur.fetchone()
        self.assertEqual(stored["name"], "Line 4 OEE report")
        self.assertEqual(stored["purpose"], "Reads the hourly rollup for the OEE board.")
        self.assertEqual(str(stored["created_by"]), self.admin)

        # STILL A MACHINE: the name lives in its own table, and the auth.users row carries only
        # an id, which is what keeps is_machine_principal() true and the account unable to sign in.
        self.cur.execute("SELECT public.is_machine_principal(%s);", (row["principal_id"],))
        self.assertTrue(self.cur.fetchone()["is_machine_principal"])

    def test_the_audit_row_carries_the_name(self):
        self.as_user(self.admin)
        row = self.create("Kiln telemetry mirror", purpose="  ")
        self.as_postgres()
        self.cur.execute(
            "SELECT new_data, changed_by FROM public.digital_thread "
            "WHERE entity_type = 'service_principals' AND entity_id = %s AND action = 'INSERT';",
            (row["principal_id"],),
        )
        audit = self.cur.fetchone()
        self.assertIsNotNone(audit, "create_machine_principal() wrote no audit row")
        self.assertEqual(audit["new_data"]["name"], "Kiln telemetry mirror")
        # A purpose of whitespace is no purpose, on the row and in the thread alike.
        self.assertIsNone(audit["new_data"]["purpose"])
        self.assertEqual(str(audit["changed_by"]), self.admin)

    def test_the_name_is_trimmed_and_the_purpose_emptied_to_null(self):
        self.as_user(self.admin)
        row = self.create("  Trimmed  ", purpose="")
        self.as_postgres()
        self.cur.execute(
            "SELECT name, purpose FROM public.machine_principals WHERE principal_id = %s;",
            (row["principal_id"],),
        )
        stored = self.cur.fetchone()
        self.assertEqual(stored["name"], "Trimmed")
        self.assertIsNone(stored["purpose"])


class WhatIsRefusedAndWhenNothingExists(NamingBase):

    def _refused(self, errcls, name, permissions=("telemetry:read",), purpose=None):
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(errcls) as ctx:
            self.create(name, permissions, purpose)
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
        return str(ctx.exception)

    def _machine_count(self):
        self.as_postgres()
        self.cur.execute(
            "SELECT count(*) AS n FROM auth.users u WHERE public.is_machine_principal(u.id);"
        )
        return self.cur.fetchone()["n"]

    def test_a_blank_name_is_refused_before_anything_exists(self):
        before = self._machine_count()
        self.as_user(self.admin)
        message = self._refused(psycopg2.errors.InvalidParameterValue, "   ")
        self.assertIn("name is required", message)
        self.assertEqual(self._machine_count(), before)

    def test_a_duplicate_name_is_refused_ignoring_case_and_whitespace(self):
        self.as_user(self.admin)
        self.create("Line 4 SCADA reader")
        before_users = self._machine_count()
        self.as_user(self.admin)
        message = self._refused(psycopg2.errors.UniqueViolation, "  line 4 scada READER ")
        self.assertIn("already exists", message)
        # The refusal came from the function's own check, which names the name, and not from the
        # index -- and either way, no second identity was made.
        self.assertEqual(self._machine_count(), before_users)

    def test_a_name_over_eighty_characters_is_refused(self):
        self.as_user(self.admin)
        self._refused(psycopg2.errors.InvalidParameterValue, "x" * 81)

    def test_a_permission_outside_the_allow_list_is_still_refused(self):
        self.as_user(self.admin)
        message = self._refused(
            psycopg2.errors.InvalidParameterValue, "Writer", ("device:manage",)
        )
        self.assertIn("not grantable", message)

    def test_no_permission_is_still_refused(self):
        self.as_user(self.admin)
        self._refused(psycopg2.errors.InvalidParameterValue, "Empty", ())

    def test_a_shopfloor_manager_is_refused(self):
        self.as_user(self.manager)
        self._refused(psycopg2.errors.InsufficientPrivilege, "Not yours")

    def test_the_table_refuses_a_blank_name_on_its_own(self):
        """The CHECK constraint, not only the function: a future write path meets the same rule."""
        machine = str(uuid.uuid4())
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s);", (machine,))
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute(
                "INSERT INTO public.machine_principals (principal_id, name) VALUES (%s, '  ');",
                (machine,),
            )
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")


class TheOldFormIsGoneNotOverloaded(NamingBase):

    def test_exactly_one_declaration_and_it_takes_a_name(self):
        self.cur.execute(
            "SELECT pg_get_function_identity_arguments(p.oid) AS args "
            "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = 'public' AND p.proname = 'create_machine_principal';"
        )
        args = [r["args"] for r in self.cur.fetchall()]
        self.assertEqual(
            args, ["p_name text, p_permissions text[], p_purpose text"],
            "a second declaration makes every RPC call ambiguous at PostgREST; 0080's "
            "two-argument form must be dropped by 0125 on every boot",
        )

    def test_the_two_argument_call_no_longer_resolves(self):
        self.as_user(self.admin)
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.UndefinedFunction):
            self.cur.execute(
                "SELECT * FROM public.create_machine_principal(%s::text[], %s);",
                (["telemetry:read"], "a note"),
            )
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")


class WhoMayReadTheNames(NamingBase):

    def setUp(self):
        super().setUp()
        self.as_user(self.admin)
        self.named = self.create("Visible to auditors")["principal_id"]
        self.as_postgres()

    def _visible_to(self, user_id):
        self.as_user(user_id)
        self.cur.execute(
            "SELECT count(*) AS n FROM public.machine_principals WHERE principal_id = %s;",
            (self.named,),
        )
        n = self.cur.fetchone()["n"]
        self.as_postgres()
        return n

    def test_administrator_and_auditor_read_it(self):
        self.assertEqual(self._visible_to(self.admin), 1)
        self.assertEqual(self._visible_to(self.auditor), 1)

    def test_a_shopfloor_manager_sees_nothing(self):
        # Zero rows rather than an error: RLS on a SELECT filters. The page treats an empty map as
        # "no names", which is what a Manager is also refused by list_machine_principals().
        self.assertEqual(self._visible_to(self.manager), 0)

    def test_no_write_policy_exists(self):
        self.as_user(self.admin)
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "UPDATE public.machine_principals SET name = 'Renamed' WHERE principal_id = %s;",
                (self.named,),
            )
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")

    def test_deleting_the_identity_takes_the_name_with_it(self):
        self.cur.execute("DELETE FROM auth.users WHERE id = %s;", (self.named,))
        self.cur.execute(
            "SELECT count(*) AS n FROM public.machine_principals WHERE principal_id = %s;",
            (self.named,),
        )
        self.assertEqual(self.cur.fetchone()["n"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
