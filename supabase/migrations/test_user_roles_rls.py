"""
PostgreSQL Integration test suite for public.user_roles Row-Level Security (RLS) policy.
Genuinely exercises the deployed SQL policy 'user_roles_select_own_or_privileged'
in PostgreSQL by executing queries under 'authenticated' role with simulated JWT claims.
"""
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

    @classmethod
    def setUpClass(cls):
        """Seed deterministic test records into public.user_roles for RLS testing."""
        conn = get_connection()
        cur = conn.cursor()
        try:
            # Check if user_roles table exists
            cur.execute("SELECT to_regclass('public.user_roles');")
            if not cur.fetchone()[0]:
                raise RuntimeError("public.user_roles table does not exist in database!")

            # Seed test records
            cls.op_user_id = "11111111-1111-1111-1111-111111111111"
            cls.other_user_id = "22222222-2222-2222-2222-222222222222"
            cls.auditor_user_id = "33333333-3333-3333-3333-333333333333"
            cls.admin_user_id = "44444444-4444-4444-4444-444444444444"
            cls.mgr_user_id = "55555555-5555-5555-5555-555555555555"

            # Insert or ignore test rows
            cur.execute("""
                INSERT INTO public.user_roles (user_id, role_id)
                VALUES
                    (%s, 3),
                    (%s, 3),
                    (%s, 4),
                    (%s, 1),
                    (%s, 2)
                ON CONFLICT (user_id, role_id) DO NOTHING;
            """, (cls.op_user_id, cls.other_user_id, cls.auditor_user_id, cls.admin_user_id, cls.mgr_user_id))
            conn.commit()
        finally:
            conn.close()

    def test_operator_can_read_own_user_roles(self):
        """Operator reading their own user_id record must succeed in Postgres RLS."""
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SET ROLE authenticated;")
            cur.execute(f"SET LOCAL \"request.jwt.claims\" = '{{\"sub\": \"{self.op_user_id}\", \"app_metadata\": {{\"role\": \"Operator\"}}}}';")
            cur.execute("SELECT user_id FROM public.user_roles WHERE user_id = %s;", (self.op_user_id,))
            rows = cur.fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0][0], self.op_user_id)
        finally:
            conn.rollback()
            conn.close()

    def test_operator_cannot_read_other_user_roles(self):
        """Operator attempting to read another user's user_roles record must return 0 rows (denied by RLS)."""
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SET ROLE authenticated;")
            cur.execute(f"SET LOCAL \"request.jwt.claims\" = '{{\"sub\": \"{self.op_user_id}\", \"app_metadata\": {{\"role\": \"Operator\"}}}}';")
            cur.execute("SELECT user_id FROM public.user_roles WHERE user_id = %s;", (self.other_user_id,))
            rows = cur.fetchall()
            self.assertEqual(len(rows), 0)
        finally:
            conn.rollback()
            conn.close()

    def test_auditor_cannot_read_other_user_roles(self):
        """Auditor attempting to read another user's user_roles record must return 0 rows (denied by RLS)."""
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SET ROLE authenticated;")
            cur.execute(f"SET LOCAL \"request.jwt.claims\" = '{{\"sub\": \"{self.auditor_user_id}\", \"app_metadata\": {{\"role\": \"Auditor\"}}}}';")
            cur.execute("SELECT user_id FROM public.user_roles WHERE user_id = %s;", (self.other_user_id,))
            rows = cur.fetchall()
            self.assertEqual(len(rows), 0)
        finally:
            conn.rollback()
            conn.close()

    def test_administrator_can_read_other_user_roles(self):
        """Administrator reading any user's user_roles record must succeed (all rows visible)."""
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SET ROLE authenticated;")
            cur.execute(f"SET LOCAL \"request.jwt.claims\" = '{{\"sub\": \"{self.admin_user_id}\", \"app_metadata\": {{\"role\": \"Administrator\"}}}}';")
            cur.execute("SELECT user_id FROM public.user_roles WHERE user_id IN (%s, %s);", (self.op_user_id, self.other_user_id))
            rows = cur.fetchall()
            self.assertEqual(len(rows), 2)
        finally:
            conn.rollback()
            conn.close()

    def test_shopfloor_manager_can_read_other_user_roles(self):
        """Shopfloor_Manager reading any user's user_roles record must succeed (all rows visible)."""
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SET ROLE authenticated;")
            cur.execute(f"SET LOCAL \"request.jwt.claims\" = '{{\"sub\": \"{self.mgr_user_id}\", \"app_metadata\": {{\"role\": \"Shopfloor_Manager\"}}}}';")
            cur.execute("SELECT user_id FROM public.user_roles WHERE user_id IN (%s, %s);", (self.op_user_id, self.other_user_id))
            rows = cur.fetchall()
            self.assertEqual(len(rows), 2)
        finally:
            conn.rollback()
            conn.close()

if __name__ == "__main__":
    unittest.main()
