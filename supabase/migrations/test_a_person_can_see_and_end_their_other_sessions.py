"""
A person can see and end their other sessions (0206).

    python supabase/migrations/test_a_person_can_see_and_end_their_other_sessions.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: list_my_sessions() returns the caller's sessions and nobody else's, the one
their token names first and the rest by when they were last active, a service's session by the
service's name, and no address or token column; refreshed_at is read as UTC whatever the
connection's time zone; end_my_session() ends one of the caller's sessions, after which
auth_pre_request() refuses its token while the caller's own is still served; it refuses the
session the caller is using, and answers another person's session exactly as one that does not
exist; every person role may call both, and a machine identity, an account with no role, anon and
service_role may not; and ending a session writes no Audit Trail row.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "a0d17070-0000-4000-8000-0000000206a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000206a2"
PERSON_ID = "a0d17070-0000-4000-8000-0000000206a3"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000206a4"
OTHER_PERSON_ID = "a0d17070-0000-4000-8000-0000000206b1"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000206c1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000206d1"

GRAFANA_CLIENT = "a0d17070-0000-4000-8000-0000000206e1"

THIS_BROWSER = "a0d17070-0000-4000-8000-0000000206f1"
OTHER_BROWSER = "a0d17070-0000-4000-8000-0000000206f2"
GRAFANA = "a0d17070-0000-4000-8000-0000000206f3"
SCRIPT = "a0d17070-0000-4000-8000-0000000206f4"
OTHER_PERSONS = "a0d17070-0000-4000-8000-0000000206f5"

CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
    " Chrome/141.0.0.0 Safari/537.36"
)
FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0"

COLUMNS = [
    "id", "service_name", "user_agent", "created_at", "last_active_at", "not_after", "is_current",
]

NOW = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def utc(dt):
    """A naive UTC timestamp, as GoTrue writes refreshed_at."""
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


class SessionsBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.list_my_sessions()');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0206 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        people = [
            (ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"),
            (PERSON_ID, "Operator"), (AUDITOR_ID, "Auditor"), (OTHER_PERSON_ID, "Operator"),
            (NO_ROLE_ID, None),
        ]
        for user_id, role in people:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@sessions.test"),
            )
            if role:
                self.cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (user_id, roles[role]),
                )
        # A machine identity: no email, no password, no identity provider, and so no role.
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, NULL, NULL, now()) ON CONFLICT (id) DO NOTHING;",
            (MACHINE_ID,),
        )
        self.cur.execute(
            "INSERT INTO auth.oauth_clients (id, registration_type, client_name)"
            " VALUES (%s, 'manual', 'Aber Grafana') ON CONFLICT (id) DO NOTHING;",
            (GRAFANA_CLIENT,),
        )
        # (id, user, user agent, client, created, last refreshed)
        sessions = [
            (THIS_BROWSER, PERSON_ID, CHROME, None, NOW - timedelta(days=3), NOW - timedelta(hours=1)),
            (OTHER_BROWSER, PERSON_ID, FIREFOX, None, NOW - timedelta(days=5), NOW - timedelta(days=2)),
            (GRAFANA, PERSON_ID, "Node-oauth", GRAFANA_CLIENT, NOW - timedelta(days=1), NOW - timedelta(minutes=5)),
            (SCRIPT, PERSON_ID, "Python-urllib/3.14", None, NOW - timedelta(days=4), None),
            (OTHER_PERSONS, OTHER_PERSON_ID, CHROME, None, NOW - timedelta(days=1), NOW - timedelta(minutes=1)),
        ]
        for session_id, user_id, agent, client, created, refreshed in sessions:
            self.cur.execute(
                "INSERT INTO auth.sessions"
                " (id, user_id, user_agent, oauth_client_id, created_at, updated_at, refreshed_at)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s);",
                (session_id, user_id, agent, client, created, created, refreshed and utc(refreshed)),
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def call(self, user_id, sql, args=(), session_id=THIS_BROWSER, role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id` and `session_id`. A refusal
        rolls back to the savepoint, so the test can go on, and is raised."""
        claims = {"sub": user_id, "role": role}
        if session_id is not None:
            claims["session_id"] = session_id
        self.cur.execute("SAVEPOINT sessions_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
            columns = [d.name for d in self.cur.description] if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT sessions_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT sessions_call;")
        self.columns = columns
        return rows

    def listed(self, user_id=PERSON_ID, session_id=THIS_BROWSER):
        rows = self.call(user_id, "SELECT * FROM public.list_my_sessions();", session_id=session_id)
        return [dict(zip(self.columns, r)) for r in rows]

    def end(self, target, user_id=PERSON_ID, session_id=THIS_BROWSER):
        return self.call(user_id, "SELECT public.end_my_session(%s);", (target,), session_id=session_id)

    def exists(self, session_id):
        self.cur.execute("SELECT 1 FROM auth.sessions WHERE id = %s;", (session_id,))
        return self.cur.fetchone() is not None

    def pre_request(self, session_id, user_id=PERSON_ID):
        """auth_pre_request() for a token naming `session_id`: None when served, else the error."""
        claims = {"sub": user_id, "role": "authenticated", "session_id": session_id}
        self.cur.execute("SAVEPOINT pre_request;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute("SELECT public.auth_pre_request();")
        except psycopg2.Error as refused:
            self.cur.execute("ROLLBACK TO SAVEPOINT pre_request;")
            return refused
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT pre_request;")
        return None

    def not_found(self, refused):
        """raise_not_found()'s 404 (0165): SQLSTATE PGRST, the body in the message."""
        self.assertEqual(refused.pgcode, "PGRST", refused)
        self.assertEqual(json.loads(refused.diag.message_detail)["status"], 404)
        return json.loads(refused.diag.message_primary)


class ListingYourSessions(SessionsBase):
    def test_lists_the_callers_sessions_and_nobody_elses(self):
        ids = {r["id"] for r in self.listed()}
        self.assertEqual(ids, {THIS_BROWSER, OTHER_BROWSER, GRAFANA, SCRIPT})
        self.assertEqual({r["id"] for r in self.listed(OTHER_PERSON_ID, OTHER_PERSONS)}, {OTHER_PERSONS})

    def test_the_session_in_use_comes_first_then_the_most_recently_active(self):
        rows = self.listed()
        self.assertEqual([r["id"] for r in rows], [THIS_BROWSER, GRAFANA, OTHER_BROWSER, SCRIPT])
        self.assertEqual([r["is_current"] for r in rows], [True, False, False, False])

    def test_the_session_in_use_is_the_one_the_token_names(self):
        rows = self.listed(session_id=OTHER_BROWSER)
        self.assertEqual(rows[0]["id"], OTHER_BROWSER)
        self.assertEqual([r["id"] for r in rows if r["is_current"]], [OTHER_BROWSER])

    def test_a_token_naming_no_session_marks_none_as_in_use(self):
        for session_id in (None, "not-a-uuid", str(uuid.uuid4())):
            with self.subTest(session_id=session_id):
                rows = self.listed(session_id=session_id)
                self.assertEqual(len(rows), 4)
                self.assertFalse(any(r["is_current"] for r in rows))

    def test_a_service_session_is_named_by_its_service_and_a_dashboard_one_by_nothing(self):
        rows = {r["id"]: r for r in self.listed()}
        self.assertEqual(rows[GRAFANA]["service_name"], "Aber Grafana")
        self.assertEqual(rows[GRAFANA]["user_agent"], "Node-oauth")
        for session_id in (THIS_BROWSER, OTHER_BROWSER, SCRIPT):
            self.assertIsNone(rows[session_id]["service_name"])
        self.assertEqual(rows[THIS_BROWSER]["user_agent"], CHROME)

    def test_returns_no_address_tag_or_token_column(self):
        self.listed()
        self.assertEqual(self.columns, COLUMNS)

    def test_last_active_is_the_latest_refresh_read_as_utc(self):
        # The connection's zone must not shift a timestamp GoTrue wrote without one.
        self.cur.execute("SELECT set_config('TimeZone', 'America/New_York', true);")
        rows = {r["id"]: r for r in self.listed()}
        self.assertEqual(rows[THIS_BROWSER]["last_active_at"], NOW - timedelta(hours=1))
        self.assertEqual(rows[THIS_BROWSER]["created_at"], NOW - timedelta(days=3))
        # Never refreshed: when it was last updated, which is when it started.
        self.assertEqual(rows[SCRIPT]["last_active_at"], NOW - timedelta(days=4))

    def test_a_later_update_counts_as_activity(self):
        later = NOW - timedelta(minutes=10)
        updated = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO auth.sessions (id, user_id, created_at, updated_at, refreshed_at)"
            " VALUES (%s, %s, %s, %s, %s);",
            (updated, PERSON_ID, NOW - timedelta(days=6), later, utc(NOW - timedelta(days=6))),
        )
        rows = {r["id"]: r for r in self.listed()}
        self.assertEqual(rows[updated]["last_active_at"], later)

    def test_not_after_is_returned(self):
        ends = NOW + timedelta(days=1)
        timeboxed = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO auth.sessions (id, user_id, not_after) VALUES (%s, %s, %s);",
            (timeboxed, PERSON_ID, ends),
        )
        rows = {r["id"]: r for r in self.listed()}
        self.assertEqual(rows[timeboxed]["not_after"], ends)
        self.assertIsNone(rows[THIS_BROWSER]["not_after"])


class EndingASession(SessionsBase):
    def test_ending_another_session_refuses_its_token_and_serves_yours(self):
        self.assertIsNone(self.pre_request(OTHER_BROWSER))
        self.end(OTHER_BROWSER)
        self.assertFalse(self.exists(OTHER_BROWSER))
        refused = self.pre_request(OTHER_BROWSER)
        self.assertIsNotNone(refused, "the ended session's token was served")
        self.assertEqual(json.loads(refused.diag.message_primary)["code"], "session_not_found")
        self.assertIsNone(self.pre_request(THIS_BROWSER))
        self.assertEqual({r["id"] for r in self.listed()}, {THIS_BROWSER, GRAFANA, SCRIPT})

    def test_a_service_session_can_be_ended(self):
        self.end(GRAFANA)
        self.assertFalse(self.exists(GRAFANA))

    def test_the_session_in_use_is_refused(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as refused:
            self.end(THIS_BROWSER)
        self.assertIn("Sign Out ends this one", refused.exception.diag.message_primary)
        self.assertTrue(self.exists(THIS_BROWSER))

    def test_the_session_in_use_is_refused_whatever_the_case_of_its_id(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.end(THIS_BROWSER, session_id=THIS_BROWSER.upper())
        self.assertTrue(self.exists(THIS_BROWSER))

    def test_another_persons_session_is_answered_as_one_that_does_not_exist(self):
        missing = str(uuid.uuid4())
        with self.assertRaises(psycopg2.Error) as theirs:
            self.end(OTHER_PERSONS)
        with self.assertRaises(psycopg2.Error) as nobodys:
            self.end(missing)
        theirs_body = self.not_found(theirs.exception)
        nobodys_body = self.not_found(nobodys.exception)
        self.assertEqual(theirs_body["message"], f"session {OTHER_PERSONS} not found")
        self.assertEqual(
            {k: v for k, v in theirs_body.items() if k != "message"},
            {k: v for k, v in nobodys_body.items() if k != "message"},
        )
        self.assertEqual(nobodys_body["message"], f"session {missing} not found")
        self.assertTrue(self.exists(OTHER_PERSONS))

    def test_ending_a_session_writes_no_audit_row(self):
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail;")
        before = self.cur.fetchone()[0]
        self.end(OTHER_BROWSER)
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE id > %s;", (before,))
        self.assertEqual(self.cur.fetchone()[0], 0)


class WhoMayCallThem(SessionsBase):
    def test_every_person_role_may_list_and_end_their_own(self):
        for user_id in (ADMIN_ID, MANAGER_ID, PERSON_ID, AUDITOR_ID):
            with self.subTest(user_id=user_id):
                own = str(uuid.uuid4())
                self.cur.execute(
                    "INSERT INTO auth.sessions (id, user_id) VALUES (%s, %s);", (own, user_id)
                )
                self.assertIn(own, {r["id"] for r in self.listed(user_id, session_id=None)})
                self.end(own, user_id=user_id, session_id=None)
                self.assertFalse(self.exists(own))

    def test_a_machine_identity_and_an_account_with_no_role_are_refused(self):
        for user_id in (MACHINE_ID, NO_ROLE_ID):
            self.cur.execute(
                "INSERT INTO auth.sessions (id, user_id) VALUES (%s, %s);",
                (str(uuid.uuid4()), user_id),
            )
            with self.subTest(user_id=user_id):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.listed(user_id, session_id=None)
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.end(OTHER_BROWSER, user_id=user_id, session_id=None)
        self.assertTrue(self.exists(OTHER_BROWSER))

    def test_anon_and_service_role_may_not_execute_either(self):
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.call(PERSON_ID, "SELECT * FROM public.list_my_sessions();", role=role)
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.call(PERSON_ID, "SELECT public.end_my_session(%s);", (OTHER_BROWSER,), role=role)
        self.assertTrue(self.exists(OTHER_BROWSER))

    def test_a_request_with_no_claims_is_refused(self):
        self.cur.execute("SAVEPOINT no_claims;")
        self.cur.execute("SELECT set_config('role', 'authenticated', true);")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT * FROM public.list_my_sessions();")
        self.cur.execute("ROLLBACK TO SAVEPOINT no_claims;")


if __name__ == "__main__":
    unittest.main()
