# suite:
#   lanes: db
#   why: The role table's RLS -- who may read and who may grant.

"""
PostgreSQL Integration test suite for public.user_roles Row-Level Security (RLS) policy.
Genuinely exercises the deployed SQL policy 'user_roles_select_own_or_privileged'
in PostgreSQL by executing queries under 'authenticated' role with simulated JWT claims.

Each test seeds its people (an auth.users row each, which user_roles' foreign key needs) and
their roles in its own transaction, and rolls back.
"""
import json
import os
import unittest
import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn

class TestUserRolesRLSIntegration(unittest.TestCase):

    op_user_id = "11111111-1111-1111-1111-111111111111"
    other_user_id = "22222222-2222-2222-2222-222222222222"
    auditor_user_id = "33333333-3333-3333-3333-333333333333"
    admin_user_id = "44444444-4444-4444-4444-444444444444"
    mgr_user_id = "55555555-5555-5555-5555-555555555555"

    def setUp(self):
        """Seed deterministic test records into public.user_roles for RLS testing."""
        self.conn = get_connection()
        cur = self.conn.cursor()
        cur.execute("SELECT to_regclass('public.user_roles');")
        if not cur.fetchone()[0]:
            raise RuntimeError("public.user_roles table does not exist in database!")

        cur.execute("SELECT name, id FROM public.roles;")
        role_ids = dict(cur.fetchall())
        people = [
            (self.op_user_id, "Operator"),
            (self.other_user_id, "Operator"),
            (self.auditor_user_id, "Auditor"),
            (self.admin_user_id, "Administrator"),
            (self.mgr_user_id, "Shopfloor_Manager"),
        ]
        for user_id, role in people:
            cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@user-roles-rls.test"),
            )
            cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, role_ids[role]),
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def as_person(self, user_id, role):
        cur = self.conn.cursor()
        cur.execute("SET LOCAL ROLE authenticated;")
        cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                    (json.dumps({"sub": user_id, "app_metadata": {"role": role}}),))
        return cur

    def test_operator_can_read_own_user_roles(self):
        """Operator reading their own user_id record must succeed in Postgres RLS."""
        cur = self.as_person(self.op_user_id, "Operator")
        cur.execute("SELECT user_id FROM public.user_roles WHERE user_id = %s;", (self.op_user_id,))
        rows = cur.fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], self.op_user_id)

    def test_operator_cannot_read_other_user_roles(self):
        """Operator attempting to read another user's user_roles record must return 0 rows (denied by RLS)."""
        cur = self.as_person(self.op_user_id, "Operator")
        cur.execute("SELECT user_id FROM public.user_roles WHERE user_id = %s;", (self.other_user_id,))
        rows = cur.fetchall()
        self.assertEqual(len(rows), 0)

    def test_auditor_cannot_read_other_user_roles(self):
        """Auditor attempting to read another user's user_roles record must return 0 rows (denied by RLS)."""
        cur = self.as_person(self.auditor_user_id, "Auditor")
        cur.execute("SELECT user_id FROM public.user_roles WHERE user_id = %s;", (self.other_user_id,))
        rows = cur.fetchall()
        self.assertEqual(len(rows), 0)

    def test_administrator_can_read_other_user_roles(self):
        """Administrator reading any user's user_roles record must succeed (all rows visible)."""
        cur = self.as_person(self.admin_user_id, "Administrator")
        cur.execute("SELECT user_id FROM public.user_roles WHERE user_id IN (%s, %s);", (self.op_user_id, self.other_user_id))
        rows = cur.fetchall()
        self.assertEqual(len(rows), 2)

    def test_shopfloor_manager_can_read_other_user_roles(self):
        """Shopfloor_Manager reading any user's user_roles record must succeed (all rows visible)."""
        cur = self.as_person(self.mgr_user_id, "Shopfloor_Manager")
        cur.execute("SELECT user_id FROM public.user_roles WHERE user_id IN (%s, %s);", (self.op_user_id, self.other_user_id))
        rows = cur.fetchall()
        self.assertEqual(len(rows), 2)

if __name__ == "__main__":
    unittest.main()
