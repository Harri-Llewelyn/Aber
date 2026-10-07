"""
A function that finds nothing answers 404 through the API (0165).

    python supabase/migrations/test_not_found_is_a_404.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: the error raise_not_found() raises is the shape PostgREST turns into a 404 (SQLSTATE
PGRST, a JSON body with code P0002 as the message, {"status": 404, "headers": {}} as the detail), and no API role
may call it directly. The functions that call it are asserted in their own suites.
"""
import json
import os
import unittest

import psycopg2
from psycopg2 import errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

FN = "public.raise_not_found(text)"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class RaiseNotFound(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s);", (FN,))
        if self.cur.fetchone()[0] is None:
            self.skipTest("0165 is not applied to this database")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def raised(self, message):
        self.cur.execute("SAVEPOINT raise;")
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT public.raise_not_found(%s);", (message,))
        self.cur.execute("ROLLBACK TO SAVEPOINT raise;")
        return ctx.exception

    # -- the shape PostgREST reads ----------------------------------------------------------------

    def test_it_raises_the_body_and_the_status(self):
        exc = self.raised("proposal 42 not found")
        self.assertEqual(exc.pgcode, "PGRST")
        self.assertEqual(
            json.loads(exc.diag.message_primary),
            {"code": "P0002", "message": "proposal 42 not found", "details": None, "hint": None},
        )
        self.assertEqual(json.loads(exc.diag.message_detail), {"status": 404, "headers": {}})

    def test_quotes_and_percent_signs_survive_as_json(self):
        message = 'gateway "Line 1"\'s copy is 100% gone\\'
        exc = self.raised(message)
        self.assertEqual(json.loads(exc.diag.message_primary)["message"], message)

    def test_a_null_message_still_parses(self):
        # PostgREST cannot read a body whose message is null, and would answer 500 instead.
        exc = self.raised(None)
        self.assertEqual(json.loads(exc.diag.message_primary)["message"], "not found")

    # -- who may call it --------------------------------------------------------------------------

    def test_no_api_role_holds_execute(self):
        for role in ("anon", "authenticated", "service_role"):
            self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE');", (role, FN))
            self.assertFalse(self.cur.fetchone()[0], role)
        self.cur.execute(
            "SELECT p.proowner::regrole::text, p.proacl IS NOT NULL"
            "  AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)"
            "  FROM pg_proc p WHERE p.oid = %s::regprocedure;",
            (FN,),
        )
        self.assertEqual(self.cur.fetchone(), ("postgres", True), "owned by postgres, no PUBLIC grant")

    def test_anon_and_authenticated_are_refused_a_direct_call(self):
        for role in ("anon", "authenticated"):
            self.cur.execute("SAVEPOINT direct;")
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            with self.assertRaises(errors.InsufficientPrivilege, msg=role):
                self.cur.execute("SELECT public.raise_not_found('x');")
            self.cur.execute("ROLLBACK TO SAVEPOINT direct;")


if __name__ == "__main__":
    unittest.main(verbosity=2)
