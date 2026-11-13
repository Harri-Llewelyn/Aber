# suite:
#   lanes: db
#   why: 0235 -- that a token GoTrue issued to an app, which carries a client_id, is refused by
#     auth_pre_request() before any other arm and holds no role or permission in has_role() and
#     has_authority(), so a row a role gates is closed to it; and that a token with no client_id is
#     served and answered as before: a false refusal here is the whole API down.

"""
A token GoTrue issued to an app reaches no role and no part of the API (0235).

    python supabase/migrations/test_an_app_s_token_reaches_only_its_own_routes.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: that auth_pre_request(), PostgREST's db-pre-request hook, refuses a token whose
claims carry a client_id, for every app and every API role, before any other arm; that has_role()
and has_authority() answer false for one, a person's and a machine's arm alike, so a row a role
gates is not read with it; that the rows any signed-in account reads stay readable with it, the
gap Realtime keeps; and that a token with no client_id, or an empty or null one, is served and
answered as before. The gateway's half is the stack lane's
(supabase/test_each_app_s_token_reaches_only_its_own_routes.py).

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

ADMIN_ID = "a0d17070-0000-4000-8000-0000000235a1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000235d1"
ADMIN_BROWSER = "a0d17070-0000-4000-8000-0000000235f0"
ADMIN_GRAFANA = "a0d17070-0000-4000-8000-0000000235f1"

GRAFANA = "c0ffee00-0000-4000-8000-000000000001"
NODE_RED = "c0ffee00-0000-4000-8000-000000000002"
STUDIO = "c0ffee00-0000-4000-8000-000000000003"
FORGE = "c0ffee00-0000-4000-8000-000000000004"
# An app #1036 lets an Administrator register: no route of its own anywhere.
OUTSIDE = "a0d17070-0000-4000-8000-0000000235e1"
APPS = [GRAFANA, NODE_RED, STUDIO, FORGE, OUTSIDE]

REFUSAL = "this token was issued to an app, and reaches only that app's own routes"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class AppTokenBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute(
            "SELECT position('client_id' IN prosrc) > 0 FROM pg_proc"
            " WHERE oid = 'public.auth_pre_request()'::regprocedure;"
        )
        if not self.cur.fetchone()[0]:
            self.skipTest("0235 is not applied to this database")
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (ADMIN_ID, f"{ADMIN_ID}@apps.test"),
        )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id)"
            " SELECT %s, id FROM public.roles WHERE name = 'Administrator';",
            (ADMIN_ID,),
        )
        # A machine identity: no email, no password, no identity provider, and a grant of its own.
        self.cur.execute("INSERT INTO auth.users (id, created_at) VALUES (%s, now()) ON CONFLICT (id) DO NOTHING;", (MACHINE_ID,))
        self.cur.execute(
            "INSERT INTO public.principal_permissions (principal_id, permission_id)"
            " SELECT %s, id FROM public.permissions WHERE name = 'telemetry:read';",
            (MACHINE_ID,),
        )
        for session_id in (ADMIN_BROWSER, ADMIN_GRAFANA):
            self.cur.execute("INSERT INTO auth.sessions (id, user_id) VALUES (%s, %s);", (session_id, ADMIN_ID))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    @staticmethod
    def dashboard():
        return {"sub": ADMIN_ID, "role": "authenticated", "aud": "authenticated", "session_id": ADMIN_BROWSER}

    @staticmethod
    def app(client_id, sub=ADMIN_ID):
        """The claims GoTrue's OAuth server signs for an app: the person's, plus the app's."""
        return {"sub": sub, "role": "authenticated", "aud": "authenticated", "session_id": ADMIN_GRAFANA,
                "client_id": client_id, "scope": "openid email profile"}

    def pre_request(self, claims, role="authenticated"):
        """Run the hook as PostgREST would for a token carrying `claims`. None when the request is
        served, or the error it is refused with."""
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

    def as_token(self, claims, sql, args=()):
        """One statement as `authenticated` with these claims, as Storage and Realtime run a policy."""
        self.cur.execute("SAVEPOINT as_token;")
        try:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', (json.dumps(claims),))
            self.cur.execute(sql, args)
            return self.cur.fetchone()[0]
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT as_token;")

    def assert_issued_to_an_app(self, refused, client_id):
        self.assertIsNotNone(refused, f"a token issued to {client_id} was served")
        self.assertIsInstance(refused, psycopg2.errors.InsufficientPrivilege, refused)
        self.assertEqual(refused.diag.message_primary, REFUSAL)
        self.assertEqual(refused.diag.message_detail, f"client {client_id}")
        self.assertIn("never the API", refused.diag.message_hint)


class TheHookRefusesAnAppsToken(AppTokenBase):
    def test_every_app_is_refused_with_403s_code(self):
        # insufficient_privilege is what PostgREST answers 403 for a signed-in role.
        for client_id in APPS:
            self.assert_issued_to_an_app(self.pre_request(self.app(client_id)), client_id)

    def test_every_api_role_meets_the_arm(self):
        for role in ("anon", "authenticated", "service_role"):
            self.assert_issued_to_an_app(self.pre_request(self.app(GRAFANA), role=role), GRAFANA)

    def test_it_answers_before_every_other_arm(self):
        # No other state lifts it, so it is the refusal that explains the request: a removed person,
        # an ended session, a withdrawn principal or a revoked token are each refused as an app's.
        self.cur.execute(
            "INSERT INTO public.access_removals (user_id, role_id)"
            " SELECT %s, id FROM public.roles WHERE name = 'Administrator';",
            (ADMIN_ID,),
        )
        self.assert_issued_to_an_app(self.pre_request(self.app(NODE_RED)), NODE_RED)
        self.cur.execute("DELETE FROM public.access_removals WHERE user_id = %s;", (ADMIN_ID,))
        self.cur.execute("DELETE FROM auth.sessions WHERE id = %s;", (ADMIN_GRAFANA,))
        self.assert_issued_to_an_app(self.pre_request(self.app(STUDIO)), STUDIO)
        jti = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
            " VALUES (%s, %s, now() + interval '1 hour');",
            (jti, ADMIN_ID),
        )
        self.assert_issued_to_an_app(self.pre_request({**self.app(FORGE), "jti": jti}), FORGE)

    def test_a_token_with_no_client_id_is_served_as_before(self):
        for claims in (
            self.dashboard(),
            {"sub": MACHINE_ID, "role": "authenticated", "jti": str(uuid.uuid4())},
            {"role": "anon"},
            {"role": "service_role"},
            {**self.dashboard(), "client_id": ""},
            {**self.dashboard(), "client_id": None},
        ):
            self.assertIsNone(self.pre_request(claims), claims)

    def test_the_other_arms_still_answer_a_token_with_no_client_id(self):
        self.cur.execute("DELETE FROM auth.sessions WHERE id = %s;", (ADMIN_BROWSER,))
        refused = self.pre_request(self.dashboard())
        self.assertIsNotNone(refused)
        self.assertEqual(refused.pgcode, "PGRST", refused)
        self.assertEqual(json.loads(refused.diag.message_primary)["code"], "session_not_found")


class TheRoleChecksAnswerFalse(AppTokenBase):
    def test_a_person_holds_their_role_with_their_own_token_and_none_with_an_apps(self):
        has_role = "SELECT public.has_role(ARRAY['Administrator'])"
        self.assertTrue(self.as_token(self.dashboard(), has_role))
        for client_id in APPS:
            self.assertFalse(self.as_token(self.app(client_id), has_role), client_id)

    def test_a_person_holds_their_permissions_with_their_own_token_and_none_with_an_apps(self):
        has_authority = "SELECT public.has_authority(ARRAY['audit_trail:read'])"
        self.assertTrue(self.as_token(self.dashboard(), has_authority))
        for client_id in APPS:
            self.assertFalse(self.as_token(self.app(client_id), has_authority), client_id)

    def test_a_machine_arm_is_closed_to_a_client_id_too(self):
        # GoTrue never issues a machine identity's token; the claim test sits before both arms.
        machine = {"sub": MACHINE_ID, "role": "authenticated", "jti": str(uuid.uuid4())}
        has_authority = "SELECT public.has_authority(ARRAY['telemetry:read'])"
        self.assertTrue(self.as_token(machine, has_authority))
        self.assertFalse(self.as_token({**machine, "client_id": GRAFANA}, has_authority))

    def test_an_empty_or_null_client_id_is_no_app(self):
        for value in ("", None):
            claims = {**self.dashboard(), "client_id": value}
            self.assertTrue(self.as_token(claims, "SELECT public.has_role(ARRAY['Administrator'])"), value)
            self.assertTrue(self.as_token(claims, "SELECT public.has_authority(ARRAY['audit_trail:read'])"), value)

    def test_the_other_roles_answer_as_before(self):
        self.assertFalse(self.as_token(self.dashboard(), "SELECT public.has_role(ARRAY['Auditor'])"))
        self.assertFalse(self.as_token({"role": "anon"}, "SELECT public.has_role(ARRAY['Administrator'])"))

    def test_a_row_a_role_gates_is_not_read_with_an_apps_token(self):
        # The Audit Trail's security lane admits Administrator and Auditor through has_role(): the
        # role this fixture's insert just recorded is in it. Storage's and Realtime's policies read
        # the same way, without the hook.
        count = ("SELECT count(*) FROM public.audit_trail"
                 " WHERE audit_domain = 'security' AND entity_id = %s")
        self.assertGreater(self.as_token(self.dashboard(), count, (ADMIN_ID,)), 0)
        self.assertEqual(self.as_token(self.app(GRAFANA), count, (ADMIN_ID,)), 0)

    def test_rows_any_signed_in_account_reads_stay_readable_the_gap_realtime_keeps(self):
        # areas is read TO authenticated USING (true). Realtime delivers its changes to any
        # subscriber the policy admits, and an app's token is one (docs/security-model.md).
        self.cur.execute("INSERT INTO public.areas (name) VALUES (%s) RETURNING id;", (f"App token area {uuid.uuid4().hex[:8]}",))
        area = self.cur.fetchone()[0]
        read = "SELECT count(*) FROM public.areas WHERE id = %s"
        self.assertEqual(self.as_token(self.app(GRAFANA), read, (area,)), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
