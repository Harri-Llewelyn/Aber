"""
An Administrator sees which sessions a person holds, and ends one of them (0212).

    python supabase/migrations/test_an_administrator_ends_one_of_a_person_s_sessions.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: person_sessions() returns a person's sessions as list_my_sessions() returns
them to the person, but is_current, newest activity first, and no address or token; only an
Administrator may call it. end_person_session() ends that one session with its refresh tokens,
leaves the person's other sessions and another person's alone, and the API then refuses the ended
token; it writes one SESSIONS_ENDED row in the person's lane naming the Administrator, with a count
of 1 and the session as the list showed it, the shape end_my_session() writes. A session that is
not that person's, or does not exist, your own session, an unknown person and a machine identity
are refused with no row; a removed person's session may be ended. end_person_sessions() refuses
your own by naming Sign Out of All Other Sessions.

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

ADMIN_ID = "a0d17070-0000-4000-8000-0000000212a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000212a2"
PERSON_ID = "a0d17070-0000-4000-8000-0000000212a3"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000212a4"
OTHER_PERSON_ID = "a0d17070-0000-4000-8000-0000000212b1"
REMOVED_ID = "a0d17070-0000-4000-8000-0000000212b2"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000212c1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000212d1"

GRAFANA_CLIENT = "c0ffee00-0000-4000-8000-000000000001"

ADMIN_SESSION = "a0d17070-0000-4000-8000-0000000212f0"
LAPTOP = "a0d17070-0000-4000-8000-0000000212f1"
WALL_DISPLAY = "a0d17070-0000-4000-8000-0000000212f2"
SCRIPT = "a0d17070-0000-4000-8000-0000000212f3"
GRAFANA = "a0d17070-0000-4000-8000-0000000212f4"
OTHER_PERSONS_BROWSER = "a0d17070-0000-4000-8000-0000000212e1"
REMOVED_PERSONS_BROWSER = "a0d17070-0000-4000-8000-0000000212e2"

PERSONS_SESSIONS = [LAPTOP, WALL_DISPLAY, SCRIPT, GRAFANA]

CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
    " Chrome/141.0.0.0 Safari/537.36"
)
FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0"

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)

# list_my_sessions()'s columns, in its order, but is_current.
LIST_COLUMNS = ["id", "service_name", "user_agent", "created_at", "last_active_at", "not_after"]
# The facts an ended session's row records, and nothing else.
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


class PersonSessionsBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.end_person_session(uuid, uuid)');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0212 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        people = [
            (ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"),
            (PERSON_ID, "Operator"), (AUDITOR_ID, "Auditor"), (OTHER_PERSON_ID, "Operator"),
            (REMOVED_ID, None), (NO_ROLE_ID, None),
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
        # Removed as remove_person_access() leaves a person: no role, a row to restore from.
        self.cur.execute(
            "INSERT INTO public.access_removals (user_id, role_id) VALUES (%s, %s)"
            " ON CONFLICT (user_id) DO NOTHING;",
            (REMOVED_ID, roles["Operator"]),
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
            (ADMIN_SESSION, ADMIN_ID, FIREFOX, None, NOW - timedelta(days=1), NOW - timedelta(minutes=2)),
            (LAPTOP, PERSON_ID, CHROME, None, NOW - timedelta(days=5), NOW - timedelta(days=2)),
            (WALL_DISPLAY, PERSON_ID, FIREFOX, None, NOW - timedelta(days=9), NOW - timedelta(minutes=30)),
            (SCRIPT, PERSON_ID, "Python-urllib/3.14", None, NOW - timedelta(days=4), None),
            (GRAFANA, PERSON_ID, "Node-oauth", GRAFANA_CLIENT, NOW - timedelta(days=1), NOW - timedelta(hours=1)),
            (OTHER_PERSONS_BROWSER, OTHER_PERSON_ID, CHROME, None, NOW - timedelta(days=1), NOW - timedelta(minutes=1)),
            (REMOVED_PERSONS_BROWSER, REMOVED_ID, CHROME, None, NOW - timedelta(days=3), None),
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

    def call(self, user_id, sql, args=(), session_id=ADMIN_SESSION, role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id` and `session_id`. A refusal
        rolls back to the savepoint, so the test can go on, and is raised."""
        claims = {"sub": user_id, "role": role, "session_id": session_id}
        self.cur.execute("SAVEPOINT person_sessions_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
            columns = [d.name for d in self.cur.description] if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT person_sessions_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT person_sessions_call;")
        self.columns = columns
        return rows

    def listed(self, target=PERSON_ID, caller=ADMIN_ID):
        """person_sessions() as dicts, in the order it returns them."""
        rows = self.call(caller, "SELECT * FROM public.person_sessions(%s);", (target,))
        return [dict(zip(self.columns, r)) for r in rows]

    def end(self, session_id, target=PERSON_ID, caller=ADMIN_ID):
        return self.call(caller, "SELECT public.end_person_session(%s, %s);", (target, session_id))

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

    def last_audit_id(self):
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail;")
        return self.cur.fetchone()[0]

    def new_rows(self, since):
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE id > %s;", (since,))
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


class ListingAPersonsSessions(PersonSessionsBase):
    def test_the_columns_are_the_persons_own_lists_but_which_one_is_in_use(self):
        self.listed()
        self.assertEqual(self.columns, LIST_COLUMNS)

    def test_it_lists_what_the_persons_own_list_shows_them(self):
        theirs = self.call(PERSON_ID, "SELECT * FROM public.list_my_sessions();", session_id=WALL_DISPLAY)
        self.assertEqual(self.columns, LIST_COLUMNS + ["is_current"])
        expected = sorted((dict(zip(LIST_COLUMNS, r[:-1])) for r in theirs), key=lambda s: str(s["id"]))
        self.assertEqual(sorted(self.listed(), key=lambda s: str(s["id"])), expected)

    def test_newest_activity_first_and_only_that_persons(self):
        self.assertEqual([str(s["id"]) for s in self.listed()], [WALL_DISPLAY, GRAFANA, LAPTOP, SCRIPT])

    def test_a_service_is_named_and_refreshed_at_is_read_as_utc(self):
        by_id = {str(s["id"]): s for s in self.listed()}
        self.assertEqual(by_id[GRAFANA]["service_name"], "Aber Grafana")
        self.assertIsNone(by_id[LAPTOP]["service_name"])
        self.assertEqual(by_id[LAPTOP]["last_active_at"], NOW - timedelta(days=2))
        # Never refreshed: last active is when it started.
        self.assertEqual(by_id[SCRIPT]["last_active_at"], NOW - timedelta(days=4))

    def test_one_who_holds_none_lists_nothing(self):
        self.assertEqual(self.listed(NO_ROLE_ID), [])
        self.assertEqual(self.listed(str(uuid.uuid4())), [])

    def test_a_removed_persons_sessions_are_listed(self):
        self.assertEqual([str(s["id"]) for s in self.listed(REMOVED_ID)], [REMOVED_PERSONS_BROWSER])

    def test_only_an_administrator_may_list_them(self):
        for caller in (MANAGER_ID, PERSON_ID, AUDITOR_ID, NO_ROLE_ID, MACHINE_ID):
            with self.subTest(caller=caller):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.listed(PERSON_ID, caller=caller)

    def test_anon_and_service_role_may_not_execute_it(self):
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.call(ADMIN_ID, "SELECT * FROM public.person_sessions(%s);", (PERSON_ID,), role=role)


class EndingOneOfThem(PersonSessionsBase):
    def test_that_session_ends_with_its_refresh_tokens_and_the_others_stay(self):
        self.end(LAPTOP)
        self.assertEqual(self.sessions_of(PERSON_ID), sorted([WALL_DISPLAY, SCRIPT, GRAFANA]))
        self.assertEqual(self.refresh_tokens_of(LAPTOP), 0)
        for session_id in (WALL_DISPLAY, SCRIPT, GRAFANA):
            with self.subTest(session=session_id):
                self.assertEqual(self.refresh_tokens_of(session_id), 2)

    def test_another_persons_sessions_are_untouched(self):
        self.end(LAPTOP)
        self.assertEqual(self.sessions_of(OTHER_PERSON_ID), [OTHER_PERSONS_BROWSER])
        self.assertEqual(self.refresh_tokens_of(OTHER_PERSONS_BROWSER), 2)
        self.assertEqual(self.sessions_of(ADMIN_ID), [ADMIN_SESSION])
        self.assertEqual(self.rows(OTHER_PERSON_ID), [])

    def test_the_api_refuses_the_ended_token_and_serves_the_others(self):
        self.assertFalse(self.refused_by_api(LAPTOP))
        self.end(LAPTOP)
        self.assertTrue(self.refused_by_api(LAPTOP))
        self.assertFalse(self.refused_by_api(WALL_DISPLAY))
        self.assertFalse(self.refused_by_api(ADMIN_SESSION, ADMIN_ID))

    def test_one_row_in_the_persons_lane_names_the_administrator_and_the_session(self):
        self.end(LAPTOP)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        entity_type, old, new, changed_by, actor_source, domain, causation = rows[0]
        self.assertEqual(entity_type, "user_roles")
        self.assertIsNone(old)
        self.assertEqual(changed_by, ADMIN_ID)
        self.assertEqual(actor_source, "user")
        self.assertEqual(domain, "security")
        self.assertEqual(causation, self.txid(), "the row is not the delete's transaction")
        self.assertEqual(new["email"], email_of(PERSON_ID))
        self.assertEqual(new["sessions_ended"], 1)
        session = new["session"]
        self.assertIsNone(session["service_name"])
        self.assertEqual(session["user_agent"], CHROME)
        self.assertEqual(datetime.fromisoformat(session["created_at"]), NOW - timedelta(days=5))
        self.assertEqual(datetime.fromisoformat(session["last_active_at"]), NOW - timedelta(days=2))
        self.assertEqual(self.rows(ADMIN_ID), [])

    def test_the_row_records_what_the_list_showed_and_no_address_or_token(self):
        shown = next(s for s in self.listed() if str(s["id"]) == GRAFANA)
        self.end(GRAFANA)
        new = self.rows()[0][2]
        self.assertEqual(set(new), {"email", "sessions_ended", "session"})
        self.assertEqual(set(new["session"]), SESSION_KEYS)
        self.assertEqual(new["session"]["service_name"], shown["service_name"])
        self.assertEqual(new["session"]["user_agent"], shown["user_agent"])
        self.assertEqual(datetime.fromisoformat(new["session"]["last_active_at"]), shown["last_active_at"])

    def test_the_row_has_the_shape_the_persons_own_end_writes(self):
        self.end(LAPTOP)
        self.call(PERSON_ID, "SELECT public.end_my_session(%s);", (SCRIPT,), session_id=WALL_DISPLAY)
        by_admin, by_person = (r[2] for r in self.rows())
        self.assertEqual(set(by_admin), set(by_person))
        self.assertEqual(set(by_admin["session"]), set(by_person["session"]))
        self.assertEqual(by_admin["sessions_ended"], by_person["sessions_ended"])

    def test_a_removed_persons_session_may_be_ended(self):
        self.end(REMOVED_PERSONS_BROWSER, target=REMOVED_ID)
        self.assertEqual(self.sessions_of(REMOVED_ID), [])
        self.assertEqual(len(self.rows(REMOVED_ID)), 1)


class WhatIsRefused(PersonSessionsBase):
    def assert_not_found(self, session_id, target=PERSON_ID):
        with self.assertRaises(psycopg2.Error) as refused:
            self.end(session_id, target=target)
        self.assertEqual(refused.exception.pgcode, "PGRST")
        self.assertEqual(json.loads(refused.exception.diag.message_primary)["code"], "P0002")

    def test_a_session_that_is_not_that_persons_is_refused_and_survives(self):
        before = self.last_audit_id()
        self.assert_not_found(OTHER_PERSONS_BROWSER)
        self.assertEqual(self.sessions_of(OTHER_PERSON_ID), [OTHER_PERSONS_BROWSER])
        self.assertEqual(self.refresh_tokens_of(OTHER_PERSONS_BROWSER), 2)
        self.assertEqual(self.new_rows(before), 0)

    def test_a_session_that_does_not_exist_is_refused(self):
        before = self.last_audit_id()
        self.assert_not_found(str(uuid.uuid4()))
        self.end(LAPTOP)
        self.assert_not_found(LAPTOP)
        self.assertEqual(self.new_rows(before), 1)

    def test_your_own_session_is_refused(self):
        before = self.last_audit_id()
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as refused:
            self.end(ADMIN_SESSION, target=ADMIN_ID)
        self.assertIn("Profile page's Security tab", refused.exception.diag.message_primary)
        self.assertEqual(self.sessions_of(ADMIN_ID), [ADMIN_SESSION])
        self.assertEqual(self.new_rows(before), 0)

    def test_only_an_administrator_may_end_one(self):
        before = self.last_audit_id()
        for caller in (MANAGER_ID, PERSON_ID, AUDITOR_ID, NO_ROLE_ID, MACHINE_ID):
            with self.subTest(caller=caller):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.end(LAPTOP, caller=caller)
        self.assertIn(LAPTOP, self.sessions_of(PERSON_ID))
        self.assertEqual(self.new_rows(before), 0)

    def test_an_unknown_person_and_a_machine_identity_are_refused(self):
        before = self.last_audit_id()
        self.assert_not_found(LAPTOP, target=str(uuid.uuid4()))
        machine_session = str(uuid.uuid4())
        self.start_session(machine_session, MACHINE_ID)
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.end(machine_session, target=MACHINE_ID)
        self.assertEqual(self.sessions_of(MACHINE_ID), [machine_session])
        self.assertEqual(self.new_rows(before), 0)

    def test_anon_and_service_role_may_not_execute_it(self):
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.call(ADMIN_ID, "SELECT public.end_person_session(%s, %s);", (PERSON_ID, LAPTOP), role=role)
        self.assertIn(LAPTOP, self.sessions_of(PERSON_ID))


class EndingThemAll(PersonSessionsBase):
    def test_your_own_are_refused_naming_sign_out_of_all_other_sessions(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as refused:
            self.call(ADMIN_ID, "SELECT public.end_person_sessions(%s);", (ADMIN_ID,))
        message = refused.exception.diag.message_primary
        self.assertIn("your own sessions", message)
        self.assertIn("Sign Out of All Other Sessions", message)
        self.assertNotIn("account menu", message)
        self.assertEqual(self.sessions_of(ADMIN_ID), [ADMIN_SESSION])

    def test_another_persons_still_end_all_at_once(self):
        self.assertEqual(self.call(ADMIN_ID, "SELECT public.end_person_sessions(%s);", (PERSON_ID,))[0][0],
                         len(PERSONS_SESSIONS))
        self.assertEqual(self.sessions_of(PERSON_ID), [])
        self.assertEqual(self.rows()[-1][2], {"email": email_of(PERSON_ID), "sessions_ended": len(PERSONS_SESSIONS)})


class TheFunctions(PersonSessionsBase):
    def test_each_runs_as_its_owner_with_a_pinned_search_path(self):
        for fn in ("public.person_sessions(uuid)", "public.end_person_session(uuid, uuid)",
                   "public.end_person_sessions(uuid)"):
            with self.subTest(fn=fn):
                self.cur.execute("SELECT prosecdef, proconfig FROM pg_proc WHERE oid = %s::regprocedure;", (fn,))
                secdef, config = self.cur.fetchone()
                self.assertTrue(secdef)
                self.assertIn("search_path=public", config)


if __name__ == "__main__":
    unittest.main()
