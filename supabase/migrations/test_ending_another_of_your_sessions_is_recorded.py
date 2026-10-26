"""
Ending another of your own sessions is recorded (0211).

    python supabase/migrations/test_ending_another_of_your_sessions_is_recorded.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: end_my_session() writes one SESSIONS_ENDED row in the caller's lane, naming them
as the actor, with a count of 1 and the session as list_my_sessions() returned it, and no address
or token; a refused End writes none. end_my_other_sessions() ends every session the caller holds
but the one their token names, services' and the Studio and forge doors' among them, takes their
refresh tokens with them, leaves another person's sessions alone, and the API then refuses the
ended tokens and serves the kept one; it writes one row with how many ended, none when nothing
ended, and refuses a token naming no session of the caller's without ending any. Every person role
may call it; a machine identity, an account with no role, anon and service_role may not. Sign
Out's own call, end_my_door_sessions(), still writes nothing.

EVERY TEST ROLLS BACK. The acts write Audit Trail rows, and the audit table cannot be pruned.
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

ADMIN_ID = "a0d17070-0000-4000-8000-0000000211a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000211a2"
PERSON_ID = "a0d17070-0000-4000-8000-0000000211a3"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000211a4"
OTHER_PERSON_ID = "a0d17070-0000-4000-8000-0000000211b1"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000211c1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000211d1"

# The OAuth clients 0002 registers, by the ids it gives them.
CLIENTS = {
    "c0ffee00-0000-4000-8000-000000000001": "Aber Grafana",
    "c0ffee00-0000-4000-8000-000000000002": "Aber Node-RED",
    "c0ffee00-0000-4000-8000-000000000003": "Aber Supabase Studio",
    "c0ffee00-0000-4000-8000-000000000004": "Aber Forge",
}
GRAFANA_CLIENT, NODE_RED_CLIENT, STUDIO_CLIENT, FORGE_CLIENT = CLIENTS

THIS_BROWSER = "a0d17070-0000-4000-8000-0000000211f1"
OTHER_BROWSER = "a0d17070-0000-4000-8000-0000000211f2"
SCRIPT = "a0d17070-0000-4000-8000-0000000211f3"
GRAFANA = "a0d17070-0000-4000-8000-0000000211f4"
NODE_RED = "a0d17070-0000-4000-8000-0000000211f5"
STUDIO = "a0d17070-0000-4000-8000-0000000211f6"
FORGE = "a0d17070-0000-4000-8000-0000000211f7"
OTHER_PERSONS_BROWSER = "a0d17070-0000-4000-8000-0000000211e1"
OTHER_PERSONS_GRAFANA = "a0d17070-0000-4000-8000-0000000211e2"

PERSONS_OTHERS = [OTHER_BROWSER, SCRIPT, GRAFANA, NODE_RED, STUDIO, FORGE]
SERVICE_SESSIONS = [GRAFANA, NODE_RED, STUDIO, FORGE]

CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
    " Chrome/141.0.0.0 Safari/537.36"
)
FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0"

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)

# The facts a person-ended session row records, and nothing else.
SESSION_KEYS = {"service_name", "user_agent", "created_at", "last_active_at"}


def email_of(user_id):
    return f"{user_id}@sessions.test"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def utc(dt):
    """A naive UTC timestamp, as GoTrue writes refreshed_at."""
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


class RecordedBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.end_my_other_sessions()');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0211 is not applied to this database")
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
                (user_id, email_of(user_id)),
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
        for client_id, name in CLIENTS.items():
            self.cur.execute(
                "INSERT INTO auth.oauth_clients (id, registration_type, client_name)"
                " VALUES (%s, 'manual', %s) ON CONFLICT (id) DO NOTHING;",
                (client_id, name),
            )
        # (id, user, user agent, client, created, last refreshed)
        sessions = [
            (THIS_BROWSER, PERSON_ID, CHROME, None, NOW - timedelta(days=3), NOW - timedelta(hours=1)),
            (OTHER_BROWSER, PERSON_ID, FIREFOX, None, NOW - timedelta(days=5), NOW - timedelta(days=2)),
            (SCRIPT, PERSON_ID, "Python-urllib/3.14", None, NOW - timedelta(days=4), None),
            (GRAFANA, PERSON_ID, "Node-oauth", GRAFANA_CLIENT, NOW - timedelta(days=1), NOW - timedelta(minutes=5)),
            (NODE_RED, PERSON_ID, "Node-oauth", NODE_RED_CLIENT, NOW - timedelta(days=1), NOW - timedelta(minutes=7)),
            (STUDIO, PERSON_ID, "Go-http-client/1.1", STUDIO_CLIENT, NOW - timedelta(hours=6), None),
            (FORGE, PERSON_ID, "Go-http-client/1.1", FORGE_CLIENT, NOW - timedelta(hours=5), None),
            (OTHER_PERSONS_BROWSER, OTHER_PERSON_ID, CHROME, None, NOW - timedelta(days=1), NOW - timedelta(minutes=1)),
            (OTHER_PERSONS_GRAFANA, OTHER_PERSON_ID, "Node-oauth", GRAFANA_CLIENT, NOW - timedelta(days=1), None),
        ]
        for session_id, user_id, agent, client, created, refreshed in sessions:
            self.start_session(session_id, user_id, agent, client, created, refreshed)

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def start_session(self, session_id, user_id, agent=None, client=None, created=NOW, refreshed=None):
        """What GoTrue does at a sign-in: one session row and its refresh tokens, two here."""
        self.cur.execute(
            "INSERT INTO auth.sessions"
            " (id, user_id, user_agent, oauth_client_id, created_at, updated_at, refreshed_at)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s);",
            (session_id, user_id, agent, client, created, created, refreshed and utc(refreshed)),
        )
        for n in range(2):
            self.cur.execute(
                "INSERT INTO auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id)"
                " VALUES (%s, %s, false, now(), now(), %s);",
                (f"{session_id}-{n}", user_id, session_id),
            )

    def call(self, user_id, sql, args=(), session_id=THIS_BROWSER, role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id` and `session_id`. A refusal
        rolls back to the savepoint, so the test can go on, and is raised."""
        claims = {"sub": user_id, "role": role}
        if session_id is not None:
            claims["session_id"] = session_id
        self.cur.execute("SAVEPOINT recorded_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT recorded_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT recorded_call;")
        return rows

    def end(self, target, user_id=PERSON_ID, session_id=THIS_BROWSER):
        return self.call(user_id, "SELECT public.end_my_session(%s);", (target,), session_id=session_id)

    def end_others(self, user_id=PERSON_ID, session_id=THIS_BROWSER):
        return self.call(user_id, "SELECT public.end_my_other_sessions();", session_id=session_id)[0][0]

    def sessions_of(self, user_id):
        self.cur.execute("SELECT id::text FROM auth.sessions WHERE user_id = %s ORDER BY id;", (user_id,))
        return [r[0] for r in self.cur.fetchall()]

    def refresh_tokens_of(self, session_id):
        self.cur.execute("SELECT count(*) FROM auth.refresh_tokens WHERE session_id = %s;", (session_id,))
        return self.cur.fetchone()[0]

    def rows(self, user_id=PERSON_ID):
        self.cur.execute(
            "SELECT entity_type, old_data, new_data, changed_by::text, actor_source, audit_domain, causation_id"
            "  FROM public.audit_trail WHERE entity_id = %s AND action = 'SESSIONS_ENDED' ORDER BY id;",
            (user_id,),
        )
        return self.cur.fetchall()

    def new_rows(self, since):
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE id > %s;", (since,))
        return self.cur.fetchone()[0]

    def last_audit_id(self):
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail;")
        return self.cur.fetchone()[0]

    def txid(self):
        self.cur.execute("SELECT txid_current();")
        return self.cur.fetchone()[0]

    def refused_by_api(self, session_id, user_id=PERSON_ID):
        """Whether auth_pre_request() refuses a token naming this session, as PostgREST runs it."""
        claims = {"sub": user_id, "role": "authenticated", "session_id": session_id}
        self.cur.execute("SAVEPOINT pre_request;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute("SELECT public.auth_pre_request();")
        except psycopg2.Error as error:
            self.cur.execute("ROLLBACK TO SAVEPOINT pre_request;")
            return error.pgcode == "PGRST" and json.loads(error.diag.message_primary)["code"] == "session_not_found"
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT pre_request;")
        return False


class EndingOneSessionIsRecorded(RecordedBase):
    def test_one_row_names_the_person_and_the_session_the_list_showed(self):
        self.end(OTHER_BROWSER)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        entity_type, old, new, changed_by, actor_source, domain, causation = rows[0]
        self.assertEqual(entity_type, "user_roles")
        self.assertIsNone(old)
        self.assertEqual(changed_by, PERSON_ID)
        self.assertEqual(actor_source, "user")
        self.assertEqual(domain, "security")
        self.assertEqual(causation, self.txid(), "the row is not the delete's transaction")
        self.assertEqual(new["email"], email_of(PERSON_ID))
        self.assertEqual(new["sessions_ended"], 1)
        session = new["session"]
        self.assertIsNone(session["service_name"])
        self.assertEqual(session["user_agent"], FIREFOX)
        self.assertEqual(datetime.fromisoformat(session["created_at"]), NOW - timedelta(days=5))
        self.assertEqual(datetime.fromisoformat(session["last_active_at"]), NOW - timedelta(days=2))

    def test_a_service_session_is_recorded_by_its_service(self):
        self.end(GRAFANA)
        session = self.rows()[0][2]["session"]
        self.assertEqual(session["service_name"], "Aber Grafana")
        self.assertEqual(session["user_agent"], "Node-oauth")

    def test_the_row_holds_the_lists_facts_and_no_address_or_token(self):
        self.end(SCRIPT)
        new = self.rows()[0][2]
        self.assertEqual(set(new), {"email", "sessions_ended", "session"})
        self.assertEqual(set(new["session"]), SESSION_KEYS)
        # Never refreshed: last active is when it started, as the list says.
        self.assertEqual(new["session"]["last_active_at"], new["session"]["created_at"])

    def test_the_session_ends_with_its_refresh_tokens(self):
        self.end(OTHER_BROWSER)
        self.assertNotIn(OTHER_BROWSER, self.sessions_of(PERSON_ID))
        self.assertEqual(self.refresh_tokens_of(OTHER_BROWSER), 0)
        self.assertEqual(self.refresh_tokens_of(THIS_BROWSER), 2)

    def test_a_refused_end_writes_no_row(self):
        before = self.last_audit_id()
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.end(THIS_BROWSER)
        for target in (OTHER_PERSONS_BROWSER, str(uuid.uuid4())):
            with self.subTest(target=target):
                with self.assertRaises(psycopg2.Error) as refused:
                    self.end(target)
                self.assertEqual(refused.exception.pgcode, "PGRST")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.end(OTHER_BROWSER, user_id=MACHINE_ID, session_id=None)
        self.assertEqual(self.new_rows(before), 0)
        self.assertIn(OTHER_PERSONS_BROWSER, self.sessions_of(OTHER_PERSON_ID))

    def test_each_end_is_its_own_row(self):
        self.end(OTHER_BROWSER)
        self.end(GRAFANA)
        ended = self.rows()
        self.assertEqual([r[2]["session"]["user_agent"] for r in ended], [FIREFOX, "Node-oauth"])
        self.assertEqual([r[2]["sessions_ended"] for r in ended], [1, 1])


class EndingEveryOtherSession(RecordedBase):
    def test_every_other_session_ends_and_this_one_stays(self):
        self.assertEqual(self.end_others(), len(PERSONS_OTHERS))
        self.assertEqual(self.sessions_of(PERSON_ID), [THIS_BROWSER])

    def test_services_and_the_studio_and_forge_doors_are_among_those_ended(self):
        self.end_others()
        for session_id in SERVICE_SESSIONS:
            with self.subTest(session=session_id):
                self.assertNotIn(session_id, self.sessions_of(PERSON_ID))

    def test_the_ended_sessions_refresh_tokens_go_and_this_ones_stay(self):
        self.end_others()
        for session_id in PERSONS_OTHERS:
            with self.subTest(session=session_id):
                self.assertEqual(self.refresh_tokens_of(session_id), 0)
        self.assertEqual(self.refresh_tokens_of(THIS_BROWSER), 2)

    def test_another_persons_sessions_are_untouched(self):
        self.end_others()
        self.assertEqual(self.sessions_of(OTHER_PERSON_ID), sorted([OTHER_PERSONS_BROWSER, OTHER_PERSONS_GRAFANA]))
        self.assertEqual(self.refresh_tokens_of(OTHER_PERSONS_BROWSER), 2)
        self.assertEqual(self.rows(OTHER_PERSON_ID), [])

    def test_the_api_refuses_the_ended_tokens_and_serves_this_one(self):
        self.assertFalse(self.refused_by_api(OTHER_BROWSER))
        self.end_others()
        for session_id in PERSONS_OTHERS:
            with self.subTest(session=session_id):
                self.assertTrue(self.refused_by_api(session_id))
        self.assertFalse(self.refused_by_api(THIS_BROWSER))
        self.assertFalse(self.refused_by_api(OTHER_PERSONS_BROWSER, OTHER_PERSON_ID))

    def test_one_row_says_who_and_how_many(self):
        self.end_others()
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        entity_type, old, new, changed_by, actor_source, domain, causation = rows[0]
        self.assertEqual(entity_type, "user_roles")
        self.assertIsNone(old)
        self.assertEqual(new, {"email": email_of(PERSON_ID), "sessions_ended": len(PERSONS_OTHERS)})
        self.assertEqual(changed_by, PERSON_ID)
        self.assertEqual(actor_source, "user")
        self.assertEqual(domain, "security")
        self.assertEqual(causation, self.txid())

    def test_nothing_left_to_end_writes_no_row(self):
        self.end_others()
        before = self.last_audit_id()
        self.assertEqual(self.end_others(), 0)
        self.assertEqual(self.new_rows(before), 0)
        self.assertEqual(len(self.rows()), 1)

    def test_a_token_naming_no_session_of_the_callers_is_refused_and_ends_nothing(self):
        before = self.last_audit_id()
        for session_id in (None, "", "not-a-uuid", str(uuid.uuid4()), OTHER_PERSONS_BROWSER):
            with self.subTest(session_id=session_id):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue) as refused:
                    self.end_others(session_id=session_id)
                self.assertIn("none was ended", refused.exception.diag.message_primary)
        self.assertEqual(len(self.sessions_of(PERSON_ID)), 1 + len(PERSONS_OTHERS))
        self.assertEqual(len(self.sessions_of(OTHER_PERSON_ID)), 2)
        self.assertEqual(self.new_rows(before), 0)

    def test_the_session_kept_is_the_tokens_whatever_the_case_of_its_id(self):
        self.end_others(session_id=THIS_BROWSER.upper())
        self.assertEqual(self.sessions_of(PERSON_ID), [THIS_BROWSER])

    def test_the_session_kept_is_whichever_the_token_names(self):
        self.end_others(session_id=GRAFANA)
        self.assertEqual(self.sessions_of(PERSON_ID), [GRAFANA])


class WhoMayEndThem(RecordedBase):
    def test_every_person_role_may_end_their_other_sessions(self):
        for user_id in (ADMIN_ID, MANAGER_ID, PERSON_ID, AUDITOR_ID):
            with self.subTest(user_id=user_id):
                kept, other = str(uuid.uuid4()), str(uuid.uuid4())
                self.start_session(kept, user_id)
                self.start_session(other, user_id)
                self.assertGreaterEqual(self.end_others(user_id, session_id=kept), 1)
                self.assertEqual(self.sessions_of(user_id), [kept])
                self.assertEqual(self.rows(user_id)[-1][3], user_id)

    def test_a_machine_identity_and_an_account_with_no_role_are_refused(self):
        for user_id in (MACHINE_ID, NO_ROLE_ID):
            kept, other = str(uuid.uuid4()), str(uuid.uuid4())
            self.start_session(kept, user_id)
            self.start_session(other, user_id)
            with self.subTest(user_id=user_id):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.end_others(user_id, session_id=kept)
                self.assertEqual(len(self.sessions_of(user_id)), 2)

    def test_anon_and_service_role_may_not_execute_it(self):
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.call(PERSON_ID, "SELECT public.end_my_other_sessions();", role=role)
        self.assertEqual(len(self.sessions_of(PERSON_ID)), 1 + len(PERSONS_OTHERS))

    def test_a_request_with_no_claims_is_refused(self):
        self.cur.execute("SAVEPOINT no_claims;")
        self.cur.execute("SELECT set_config('role', 'authenticated', true);")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.end_my_other_sessions();")
        self.cur.execute("ROLLBACK TO SAVEPOINT no_claims;")
        self.assertEqual(len(self.sessions_of(PERSON_ID)), 1 + len(PERSONS_OTHERS))

    def test_both_run_as_their_owner_with_a_pinned_search_path(self):
        for fn in ("public.end_my_session(uuid)", "public.end_my_other_sessions()"):
            with self.subTest(fn=fn):
                self.cur.execute(
                    "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = %s::regprocedure;", (fn,)
                )
                secdef, config = self.cur.fetchone()
                self.assertTrue(secdef)
                self.assertIn("search_path=public", config)


class SignOutWritesNothing(RecordedBase):
    def test_sign_outs_door_sessions_call_writes_no_row(self):
        before = self.last_audit_id()
        self.assertEqual(self.call(PERSON_ID, "SELECT public.end_my_door_sessions();")[0][0], 2)
        self.assertEqual(self.new_rows(before), 0)


if __name__ == "__main__":
    unittest.main()
