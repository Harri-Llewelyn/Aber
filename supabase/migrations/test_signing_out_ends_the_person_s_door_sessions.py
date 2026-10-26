"""
Signing out ends the person's Studio and forge door sessions (0208).

    python supabase/migrations/test_signing_out_ends_the_person_s_door_sessions.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: end_my_door_sessions() ends the caller's sessions issued to the Studio and forge
doors and says how many; the caller's other sessions (the dashboard's, Grafana's, Node-RED's) and
other people's door sessions are left alone; the caller's dashboard token is still served by the
API afterwards; a machine identity, a token naming nobody, anon and service_role are refused.

EVERY TEST ROLLS BACK.
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

# The OAuth clients 0002 seeds.
GRAFANA = "c0ffee00-0000-4000-8000-000000000001"
NODERED = "c0ffee00-0000-4000-8000-000000000002"
STUDIO_DOOR = "c0ffee00-0000-4000-8000-000000000003"
FORGE_DOOR = "c0ffee00-0000-4000-8000-000000000004"

PERSON_ID = "a0d17070-0000-4000-8000-0000000208a1"
OTHER_PERSON_ID = "a0d17070-0000-4000-8000-0000000208b1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000208f1"

# The person's sessions: the dashboard in two browsers, both doors in each, Grafana and Node-RED.
DASHBOARD = "a0d17070-0000-4000-8000-0000000208c1"
DASHBOARD_ELSEWHERE = "a0d17070-0000-4000-8000-0000000208c2"
STUDIO_HERE = "a0d17070-0000-4000-8000-0000000208d1"
FORGE_HERE = "a0d17070-0000-4000-8000-0000000208d2"
STUDIO_ELSEWHERE = "a0d17070-0000-4000-8000-0000000208d3"
FORGE_ELSEWHERE = "a0d17070-0000-4000-8000-0000000208d4"
GRAFANA_SESSION = "a0d17070-0000-4000-8000-0000000208e1"
NODERED_SESSION = "a0d17070-0000-4000-8000-0000000208e2"
DOORS = (STUDIO_HERE, FORGE_HERE, STUDIO_ELSEWHERE, FORGE_ELSEWHERE)
NOT_DOORS = (DASHBOARD, DASHBOARD_ELSEWHERE, GRAFANA_SESSION, NODERED_SESSION)

# Another person's door sessions, and a door session under the machine identity's id.
OTHER_STUDIO = "a0d17070-0000-4000-8000-0000000208f2"
OTHER_FORGE = "a0d17070-0000-4000-8000-0000000208f3"
MACHINE_FORGE = "a0d17070-0000-4000-8000-0000000208f4"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class EndMyDoorSessions(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.end_my_door_sessions()');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0208 is not applied to this database")
        for user_id in (PERSON_ID, OTHER_PERSON_ID):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@doors.test"),
            )
        # A machine identity: no email, no password, no identity provider.
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, NULL, NULL, now()) ON CONFLICT (id) DO NOTHING;",
            (MACHINE_ID,),
        )
        sessions = [
            (DASHBOARD, PERSON_ID, None), (DASHBOARD_ELSEWHERE, PERSON_ID, None),
            (STUDIO_HERE, PERSON_ID, STUDIO_DOOR), (FORGE_HERE, PERSON_ID, FORGE_DOOR),
            (STUDIO_ELSEWHERE, PERSON_ID, STUDIO_DOOR), (FORGE_ELSEWHERE, PERSON_ID, FORGE_DOOR),
            (GRAFANA_SESSION, PERSON_ID, GRAFANA), (NODERED_SESSION, PERSON_ID, NODERED),
            (OTHER_STUDIO, OTHER_PERSON_ID, STUDIO_DOOR), (OTHER_FORGE, OTHER_PERSON_ID, FORGE_DOOR),
            (MACHINE_FORGE, MACHINE_ID, FORGE_DOOR),
        ]
        for session_id, user_id, client in sessions:
            self.cur.execute(
                "INSERT INTO auth.sessions (id, user_id, oauth_client_id) VALUES (%s, %s, %s);",
                (session_id, user_id, client),
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def end_door_sessions(self, claims, role="authenticated"):
        """Call end_my_door_sessions() as PostgREST would for a token carrying `claims`. Returns how
        many it ended; a refusal rolls back to the savepoint and is raised."""
        self.cur.execute("SAVEPOINT doors_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute("SELECT public.end_my_door_sessions();")
            ended = self.cur.fetchone()[0]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT doors_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT doors_call;")
        return ended

    def as_person(self, user_id=PERSON_ID, session_id=DASHBOARD):
        return {"sub": user_id, "role": "authenticated", "session_id": session_id}

    def alive(self, *session_ids):
        """The ids among `session_ids` that still have a row."""
        self.cur.execute("SELECT id::text FROM auth.sessions WHERE id = ANY(%s::uuid[]);", (list(session_ids),))
        return {row[0] for row in self.cur.fetchall()}

    # -- what it ends -----------------------------------------------------------------------------

    def test_it_ends_every_door_session_the_caller_holds_and_says_how_many(self):
        self.assertEqual(self.end_door_sessions(self.as_person()), len(DOORS))
        self.assertEqual(self.alive(*DOORS), set())

    def test_the_callers_other_sessions_are_left_alone(self):
        self.end_door_sessions(self.as_person())
        self.assertEqual(self.alive(*NOT_DOORS), set(NOT_DOORS))

    def test_other_peoples_door_sessions_are_left_alone(self):
        self.end_door_sessions(self.as_person())
        self.assertEqual(self.alive(OTHER_STUDIO, OTHER_FORGE, MACHINE_FORGE), {OTHER_STUDIO, OTHER_FORGE, MACHINE_FORGE})

    def test_a_second_call_ends_nothing(self):
        self.end_door_sessions(self.as_person())
        self.assertEqual(self.end_door_sessions(self.as_person()), 0)

    def test_the_callers_dashboard_token_is_still_served_afterwards(self):
        # The dashboard calls this before signing itself out: its own session must survive it, or
        # the sign-out that follows would be refused (0205).
        self.end_door_sessions(self.as_person())
        self.cur.execute("SAVEPOINT pre_request;")
        self.cur.execute("SELECT set_config('role', 'authenticated', true);")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(self.as_person()),))
        self.cur.execute("SELECT public.auth_pre_request();")
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT pre_request;")

    # -- who may call it --------------------------------------------------------------------------

    def test_a_machine_identity_is_refused(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.end_door_sessions({"sub": MACHINE_ID, "role": "authenticated"})
        self.assertEqual(self.alive(MACHINE_FORGE), {MACHINE_FORGE})

    def test_a_token_naming_nobody_is_refused(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.end_door_sessions({"role": "authenticated"})
        self.assertEqual(self.alive(*DOORS), set(DOORS))

    def test_anon_and_service_role_may_not_call_it(self):
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.end_door_sessions(self.as_person(), role=role)
        self.assertEqual(self.alive(*DOORS), set(DOORS))

    def test_it_runs_as_its_owner_with_a_pinned_search_path(self):
        self.cur.execute(
            "SELECT prosecdef, proconfig, pg_get_userbyid(proowner) FROM pg_proc"
            " WHERE oid = 'public.end_my_door_sessions()'::regprocedure;"
        )
        definer, config, owner = self.cur.fetchone()
        self.assertTrue(definer)
        self.assertIn("search_path=public", config)
        self.assertEqual(owner, "postgres")


if __name__ == "__main__":
    unittest.main()
