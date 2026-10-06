"""
A site's first administrator (0163).

WHAT THIS DEFENDS. ensure_first_administrator() runs on every install and upgrade while the chart
names a first administrator, so its whole contract is about the second and later runs: it creates
the account once, and afterwards a changed password, a changed role or an account that already
existed are left exactly as they are. A version that "repaired" the account on each run would hand
the chart's password back to an account somebody had deliberately changed.

It also writes a password into auth.users, so no API role may execute it.

Self-seeded with addresses unique to the run, so the suite neither depends on nor disturbs the
demo personas, which the test lane does not apply. The accounts are left behind, as
test_audit_trail_guard.py's are: the lane's database is thrown away, and its auth fixture grants
INSERT on auth.identities but not DELETE.
"""

import os
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

PASSWORD = "first-admin-password-1"


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = True
    return conn


class TestFirstAdministrator(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.conn = connect()
        cls.cur = cls.conn.cursor()
        cls.cur.execute("SELECT to_regprocedure('public.ensure_first_administrator(text, text)')")
        if cls.cur.fetchone()[0] is None:
            raise RuntimeError("public.ensure_first_administrator(text, text) does not exist; is 0163 applied?")

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def ensure(self, email, password):
        self.cur.execute("SELECT public.ensure_first_administrator(%s, %s)", (email, password))
        return self.cur.fetchone()[0]

    def user_id(self, email):
        self.cur.execute("SELECT id FROM auth.users WHERE lower(email) = lower(%s)", (email,))
        row = self.cur.fetchone()
        return row[0] if row else None

    def password_matches(self, user_id, password):
        self.cur.execute(
            "SELECT encrypted_password = extensions.crypt(%s, encrypted_password) FROM auth.users WHERE id = %s",
            (password, user_id),
        )
        return self.cur.fetchone()[0]

    def roles_of(self, user_id):
        self.cur.execute(
            "SELECT r.name FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id"
            " WHERE ur.user_id = %s ORDER BY r.name",
            (user_id,),
        )
        return [r[0] for r in self.cur.fetchall()]

    def address(self):
        return f"first-admin-{uuid.uuid4().hex[:12]}@site.test"

    def test_creates_an_administrator_who_can_sign_in(self):
        email = self.address()
        self.assertEqual(self.ensure(email, PASSWORD), "created")
        user_id = self.user_id(email)

        self.assertTrue(self.password_matches(user_id, PASSWORD))
        self.assertEqual(self.roles_of(user_id), ["Administrator"])
        self.cur.execute(
            "SELECT count(*) FROM auth.identities WHERE user_id = %s AND provider = 'email'", (user_id,)
        )
        self.assertEqual(self.cur.fetchone()[0], 1, "an email identity is what makes the account a person")
        self.cur.execute("SELECT public.is_machine_principal(%s)", (user_id,))
        self.assertFalse(self.cur.fetchone()[0])

    def test_a_later_run_changes_nothing(self):
        email = self.address()
        self.assertEqual(self.ensure(email, PASSWORD), "created")
        user_id = self.user_id(email)

        self.cur.execute(
            "UPDATE auth.users SET encrypted_password = extensions.crypt('changed-by-the-site', extensions.gen_salt('bf'))"
            " WHERE id = %s",
            (user_id,),
        )
        self.cur.execute("UPDATE public.user_roles SET role_id = 3 WHERE user_id = %s", (user_id,))

        self.assertEqual(self.ensure(email, "a-different-chart-password"), "exists")
        self.assertTrue(self.password_matches(user_id, "changed-by-the-site"))
        self.assertEqual(self.roles_of(user_id), ["Operator"])

    def test_an_existing_account_is_matched_ignoring_case_and_left_alone(self):
        email = self.address()
        user_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, 'not-a-real-hash')",
            (user_id, email),
        )


        self.assertEqual(self.ensure(email.upper(), PASSWORD), "exists")
        self.assertEqual(self.roles_of(user_id), [])
        self.cur.execute("SELECT count(*) FROM auth.users WHERE lower(email) = %s", (email,))
        self.assertEqual(self.cur.fetchone()[0], 1)

    def test_an_empty_or_short_password_is_refused_before_anything_is_written(self):
        for password in ("", None, "elevenchars"):
            email = self.address()
            with self.subTest(password=password):
                with self.assertRaisesRegex(psycopg2.Error, "shorter than 12 characters"):
                    self.ensure(email, password)
                self.assertIsNone(self.user_id(email))

    def test_a_malformed_address_is_refused(self):
        for email in ("", "   ", "no-at-sign", "two@@signs", "has space@site.test"):
            with self.subTest(email=email):
                with self.assertRaisesRegex(psycopg2.Error, "is not an email address"):
                    self.ensure(email, PASSWORD)

    def test_no_api_role_may_execute_it(self):
        for role in ("anon", "authenticated", "service_role"):
            with self.subTest(role=role):
                self.cur.execute(
                    "SELECT has_function_privilege(%s, 'public.ensure_first_administrator(text, text)', 'EXECUTE')",
                    (role,),
                )
                self.assertFalse(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main()
