"""
The Audit Trail sorts events into classes in the database (0228).

    python supabase/migrations/test_the_audit_trail_sorts_events_into_classes_in_the_database.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * audit_event_class() answers every case in test-harness/fixtures/audit-event-classes.json, the
    four reads included, and is an IMMUTABLE SQL function with no SET clause, so it inlines.

EVERY TEST ROLLS BACK. An audit row is permanent.
"""
import json
import os
import unittest
from pathlib import Path

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parents[1] / "test-harness" / "fixtures" / "audit-event-classes.json"
CLASSES = ("created", "operational", "configuration", "lifecycle", "read")


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

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()


# -------------------------------------------------------------------------------------------------
# The classifier
# -------------------------------------------------------------------------------------------------
class TheClassifier(Base):
    def classify(self, case):
        self.cur.execute(
            "SELECT public.audit_event_class(%s, %s, %s, %s::jsonb, %s::jsonb);",
            (case["action"], case["entity_type"], case["audit_domain"],
             None if case["old_data"] is None else json.dumps(case["old_data"]),
             None if case["new_data"] is None else json.dumps(case["new_data"])),
        )
        return self.cur.fetchone()[0]

    def test_every_fixture_case(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 40)
        for case in cases:
            with self.subTest(case=case["name"]):
                self.assertIn(case["class"], CLASSES)
                self.assertEqual(self.classify(case), case["class"])

    def test_the_fixture_covers_every_class(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertEqual(sorted({c["class"] for c in cases}), sorted(CLASSES))

    def test_the_reads_are_the_only_cases_the_browser_answered_otherwise(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        differ = sorted(c["action"] for c in cases if "browser" in c)
        self.assertEqual(differ, ["CAPTURE_DOWNLOAD_ISSUED", "CREDENTIAL_SHOWN", "EXPORTED", "SERVICE_LOGS_READ"])
        self.assertTrue(all(c["class"] == "read" for c in cases if "browser" in c))

    def test_a_read_in_the_security_lane_is_still_a_read(self):
        self.assertEqual(self.classify({
            "action": "SERVICE_LOGS_READ", "entity_type": "service_logs", "audit_domain": "security",
            "old_data": None, "new_data": {"name": "ingestion"}}), "read")

    def test_it_inlines(self):
        """IMMUTABLE, SQL, SECURITY INVOKER and no SET clause: what lets an index be built on it."""
        self.cur.execute(
            "SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig"
            "  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang"
            " WHERE p.oid = 'public.audit_event_class(text, text, text, jsonb, jsonb)'::regprocedure;"
        )
        self.assertEqual(self.cur.fetchone(), ("sql", "i", False, None))

    def test_who_may_run_it(self):
        self.cur.execute(
            "SELECT has_function_privilege('authenticated', f, 'EXECUTE'),"
            "       has_function_privilege('service_role', f, 'EXECUTE'),"
            "       has_function_privilege('anon', f, 'EXECUTE')"
            "  FROM (SELECT 'public.audit_event_class(text, text, text, jsonb, jsonb)'::regprocedure AS f) x;"
        )
        self.assertEqual(self.cur.fetchone(), (True, True, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
