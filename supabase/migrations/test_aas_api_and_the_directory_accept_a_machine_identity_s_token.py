# suite:
#   lanes: db
#   why: 0224. auth_probe(), called as PostgREST calls it, answers a machine identity's token, which
#     carries no aud, and a person's session. The hook refuses a revoked token, a withdrawn
#     identity, a removed person and an ended session first. anon and service_role may not run it,
#     even through a plan prepared for authenticated, and a replay keeps its grants.

"""
aas-api and the Factory+ Directory accept a machine identity's token (0224).

    python supabase/migrations/test_aas_api_and_the_directory_accept_a_machine_identity_s_token.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: auth_probe(), called as PostgREST calls it (the pre-request hook, then the probe,
as `authenticated` with the token's claims), answers true to a machine identity's token, which
carries no `aud`, and to a person's session token. The hook refuses a revoked token, a withdrawn
identity, a person whose access was removed and an ended session before the probe runs. anon and
service_role may not run it, not even through a plan prepared for `authenticated`. It takes no
argument, is plpgsql and not IMMUTABLE, and a replay of 0224 keeps its grants.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
import uuid
from pathlib import Path

import psycopg2
from psycopg2 import errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = Path(__file__).resolve().parent / "0224_aas_api_and_the_directory_accept_a_machine_identity_s_token.sql"

PERSON_ID = "5e000000-0224-4000-8000-0000000000a1"
IDENTITY_ID = "5e000000-0224-4000-8000-0000000000e2"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class ProbeBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.auth_probe()') IS NOT NULL;")
                if not cur.fetchone()[0]:
                    raise unittest.SkipTest("0224 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        # A person has an email and a password; a machine identity has neither.
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, %s)"
            " ON CONFLICT (id) DO NOTHING;",
            (PERSON_ID, f"{PERSON_ID}@auth-probe.test", "not-a-real-hash"),
        )
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING;", (IDENTITY_ID,))
        self.session = str(uuid.uuid4())
        self.cur.execute("INSERT INTO auth.sessions (id, user_id) VALUES (%s, %s);", (self.session, PERSON_ID))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def machine_token(self, jti=None):
        """The claims mint-service-token signs: no `aud`."""
        return {"sub": IDENTITY_ID, "role": "authenticated", "jti": jti or str(uuid.uuid4())}

    def person_token(self):
        """A GoTrue session token's claims, `aud` included."""
        return {"sub": PERSON_ID, "role": "authenticated", "aud": "authenticated",
                "session_id": self.session, "aal": "aal1"}

    def probe(self, claims, role="authenticated"):
        """One GET /rpc/auth_probe as PostgREST runs it: the hook, then the call. A refusal is re-raised."""
        self.cur.execute("SAVEPOINT probe;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute("SELECT public.auth_pre_request();")
            self.cur.execute("SELECT public.auth_probe();")
            answer = self.cur.fetchone()[0]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT probe;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT probe;")
        return answer


class WhatPasses(ProbeBase):

    def test_a_machine_identity_s_token_with_no_aud(self):
        self.assertIs(self.probe(self.machine_token()), True)

    def test_a_person_s_session_token(self):
        self.assertIs(self.probe(self.person_token()), True)


class TheHookRefusesFirst(ProbeBase):
    """PostgREST runs auth_pre_request() before the call, so a withdrawn token never reaches it."""

    def test_a_revoked_token(self):
        jti = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
                         " VALUES (%s, %s, now() + interval '1 day');", (jti, IDENTITY_ID))
        with self.assertRaises(errors.InsufficientPrivilege):
            self.probe(self.machine_token(jti))

    def test_a_withdrawn_identity(self):
        self.cur.execute("INSERT INTO public.revoked_service_principals (principal_id) VALUES (%s);", (IDENTITY_ID,))
        with self.assertRaises(errors.InsufficientPrivilege):
            self.probe(self.machine_token())

    def test_a_person_whose_access_was_removed(self):
        self.cur.execute("INSERT INTO public.access_removals (user_id) VALUES (%s);", (PERSON_ID,))
        with self.assertRaises(errors.InsufficientPrivilege):
            self.probe(self.person_token())

    def test_an_ended_session(self):
        self.cur.execute("DELETE FROM auth.sessions WHERE id = %s;", (self.session,))
        with self.assertRaises(psycopg2.Error) as raised:
            self.probe(self.person_token())
        self.assertIn("session_not_found", str(raised.exception))


class WhoMayRunIt(ProbeBase):

    def test_anon_and_the_service_role_are_refused(self):
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                with self.assertRaises(errors.InsufficientPrivilege):
                    self.probe({"role": role}, role)

    def test_a_plan_made_for_authenticated_refuses_anon(self):
        # PostgREST runs prepared statements from their generic plan on pooled connections, so the
        # call must stay in the plan for its EXECUTE check to run for whichever role executes it.
        try:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute("PREPARE auth_probe_plan AS SELECT public.auth_probe();")
            self.cur.execute("EXECUTE auth_probe_plan;")
            self.assertIs(self.cur.fetchone()[0], True)
            self.cur.execute("SET LOCAL ROLE anon;")
            with self.assertRaises(errors.InsufficientPrivilege):
                self.cur.execute("EXECUTE auth_probe_plan;")
        finally:
            self.conn.rollback()
            self.cur.execute("DEALLOCATE ALL;")

    def test_it_takes_no_argument_and_is_plpgsql_and_not_immutable(self):
        self.cur.execute(
            "SELECT p.pronargs, l.lanname, p.provolatile FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang"
            " WHERE p.proname = 'auth_probe' AND p.pronamespace = 'public'::regnamespace;"
        )
        self.assertEqual(self.cur.fetchall(), [(0, "plpgsql", "s")])

    def test_a_replay_of_0224_keeps_its_grants(self):
        grants = ("SELECT has_function_privilege(r, 'public.auth_probe()', 'EXECUTE')"
                  "  FROM unnest(ARRAY['authenticated', 'anon', 'service_role']) AS r;")
        self.cur.execute(grants)
        before = self.cur.fetchall()
        self.assertEqual(before, [(True,), (False,), (False,)])
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.cur.execute(grants)
        self.assertEqual(self.cur.fetchall(), before)


if __name__ == "__main__":
    unittest.main()
