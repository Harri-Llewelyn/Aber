"""
The API refuses a token whose session has ended (0205).

    python supabase/migrations/test_the_api_refuses_a_token_whose_session_has_ended.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: that auth_pre_request(), PostgREST's db-pre-request hook, serves a token whose
GoTrue session still exists and refuses one whose session has gone, with the 401 and the code
PostgREST passes on; that ending one session leaves the person's others served; that a token naming
no session, or a `session_id` that is no uuid, is served as before; that every API role meets the
arm; and that a removed person is told their access was removed, not that their session ended.

EVERY TEST ROLLS BACK.
"""
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

PERSON_ID = "a0d17070-0000-4000-8000-0000000205a1"
THIS_BROWSER = "a0d17070-0000-4000-8000-0000000205b1"
OTHER_BROWSER = "a0d17070-0000-4000-8000-0000000205b2"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class EndedSessionRefusal(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute(
            "SELECT position('auth.sessions' IN prosrc) > 0 FROM pg_proc"
            " WHERE oid = 'public.auth_pre_request()'::regprocedure;"
        )
        if not self.cur.fetchone()[0]:
            self.skipTest("0205 is not applied to this database")
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (PERSON_ID, f"{PERSON_ID}@sessions.test"),
        )
        for session_id in (THIS_BROWSER, OTHER_BROWSER):
            self.cur.execute(
                "INSERT INTO auth.sessions (id, user_id) VALUES (%s, %s);", (session_id, PERSON_ID)
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def end_session(self, session_id):
        """What GoTrue does at a Sign Out: the session's row goes."""
        self.cur.execute("DELETE FROM auth.sessions WHERE id = %s;", (session_id,))

    def pre_request(self, claims, role="authenticated"):
        """Run the hook as PostgREST would for a token carrying `claims`. Returns None when the
        request is served, or the error it is refused with."""
        self.cur.execute("SAVEPOINT pre_request;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', (json.dumps(claims),))
            self.cur.execute("SELECT public.auth_pre_request();")
        except psycopg2.Error as refused:
            self.cur.execute("ROLLBACK TO SAVEPOINT pre_request;")
            return refused
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT pre_request;")
        return None

    def token(self, session_id):
        return {"sub": PERSON_ID, "role": "authenticated", "session_id": session_id}

    def assert_session_ended(self, refused, session_id):
        """The refusal is PostgREST's custom error: SQLSTATE PGRST, the body in the message and the
        status in the detail, as raise_not_found() (0165) raises its 404."""
        self.assertIsNotNone(refused, "a token whose session has gone was served")
        self.assertEqual(refused.pgcode, "PGRST", refused)
        body = json.loads(refused.diag.message_primary)
        self.assertEqual(body["code"], "session_not_found")
        self.assertEqual(body["message"], "this session has ended")
        self.assertEqual(body["details"], f"session {session_id}")
        response = json.loads(refused.diag.message_detail)
        self.assertEqual(response["status"], 401)
        self.assertIn('error="invalid_token"', response["headers"]["WWW-Authenticate"])

    # -- the arm ----------------------------------------------------------------------------------

    def test_a_token_whose_session_exists_is_served(self):
        self.assertIsNone(self.pre_request(self.token(THIS_BROWSER)))

    def test_a_token_whose_session_has_ended_is_refused_with_401(self):
        self.end_session(THIS_BROWSER)
        self.assert_session_ended(self.pre_request(self.token(THIS_BROWSER)), THIS_BROWSER)

    def test_ending_one_session_leaves_the_persons_others_served(self):
        self.end_session(THIS_BROWSER)
        self.assertIsNotNone(self.pre_request(self.token(THIS_BROWSER)))
        self.assertIsNone(self.pre_request(self.token(OTHER_BROWSER)))

    def test_the_session_id_is_matched_whatever_its_case(self):
        self.assertIsNone(self.pre_request(self.token(THIS_BROWSER.upper())))
        self.end_session(THIS_BROWSER)
        self.assert_session_ended(
            self.pre_request(self.token(THIS_BROWSER.upper())), THIS_BROWSER.upper()
        )

    def test_a_token_naming_no_session_is_served(self):
        # A minted service token carries a jti and no session; so do the publishable and service
        # keys, which name a role alone.
        for claims in (
            {"sub": PERSON_ID, "role": "authenticated"},
            {"sub": str(uuid.uuid4()), "role": "authenticated", "jti": str(uuid.uuid4())},
            {"role": "anon"},
            {"role": "service_role"},
        ):
            self.assertIsNone(self.pre_request(claims), claims)

    def test_a_session_id_that_is_no_uuid_is_served(self):
        for session_id in ("", "not-a-uuid", None, 42):
            self.assertIsNone(self.pre_request(self.token(session_id)), session_id)

    def test_every_api_role_meets_the_arm(self):
        self.end_session(THIS_BROWSER)
        for role in ("anon", "authenticated", "service_role"):
            self.assert_session_ended(
                self.pre_request(self.token(THIS_BROWSER), role=role), THIS_BROWSER
            )

    def test_a_removed_person_is_told_their_access_was_removed(self):
        # Both arms match; the removal is the fact that explains both, so it answers first.
        self.cur.execute("SELECT id FROM public.roles WHERE name = 'Operator';")
        operator = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO public.access_removals (user_id, role_id) VALUES (%s, %s);",
            (PERSON_ID, operator),
        )
        self.end_session(THIS_BROWSER)
        refused = self.pre_request(self.token(THIS_BROWSER))
        self.assertIsInstance(refused, psycopg2.errors.InsufficientPrivilege)
        self.assertEqual(refused.diag.message_primary, "this person's access has been removed")


if __name__ == "__main__":
    unittest.main()
