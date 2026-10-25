"""
An Administrator ends a person's sessions, and changes their email address (0207).

    python supabase/migrations/test_an_administrator_ends_a_person_s_sessions.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: only an Administrator ends a person's sessions or reads how many they hold;
nobody ends their own here; every session the person holds ends, and nobody else's; the API then
refuses the ended sessions' tokens; one SESSIONS_ENDED row names who, whose and how many; a removed
person's sessions may be ended; the summary counts sessions and takes the latest of their times,
reading GoTrue's zone-less refreshed_at as UTC. For an email change: the check refuses your own
address, a removed person, an address another account holds, the same address and a non-address,
and returns the address held; the record refuses a change the account does not show, writes one
EMAIL_CHANGED row with both addresses, and ends the person's sessions in the same transaction.

EVERY TEST ROLLS BACK. The acts write Audit Trail rows, and the audit table cannot be pruned.
"""
import datetime
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

ADMIN_ID = "a0d17070-0000-4000-8000-0000000207a1"
SECOND_ADMIN_ID = "a0d17070-0000-4000-8000-0000000207a2"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000207b1"
OPERATOR_ID = "a0d17070-0000-4000-8000-0000000207c1"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000207d1"
REMOVED_ID = "a0d17070-0000-4000-8000-0000000207e1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000207f1"

# The operator's sessions: a dashboard in two browsers and two services' sign-ins.
OPERATOR_SESSIONS = [
    "a0d17070-0000-4000-8000-0000000207c5",
    "a0d17070-0000-4000-8000-0000000207c6",
    "a0d17070-0000-4000-8000-0000000207c7",
    "a0d17070-0000-4000-8000-0000000207c8",
]
MANAGER_SESSION = "a0d17070-0000-4000-8000-0000000207b5"
ADMIN_SESSION = "a0d17070-0000-4000-8000-0000000207a5"
REMOVED_SESSION = "a0d17070-0000-4000-8000-0000000207e5"

FUNCTIONS = [
    "public.end_person_sessions(uuid)",
    "public.person_session_summary(uuid)",
    "public.check_person_email_change(uuid, text)",
    "public.record_person_email_change(uuid, text, text)",
]


def email_of(user_id):
    return f"{user_id}@sessions.test"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class PersonActsBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.end_person_sessions(uuid)');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0207 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        people = [
            (ADMIN_ID, "Administrator"), (SECOND_ADMIN_ID, "Administrator"),
            (MANAGER_ID, "Shopfloor_Manager"), (OPERATOR_ID, "Operator"), (AUDITOR_ID, "Auditor"),
            (REMOVED_ID, None),
        ]
        for user_id, role in people:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at, last_sign_in_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now(), now()) ON CONFLICT (id) DO NOTHING;",
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
        # A machine identity: no email, no password, no identity provider.
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, NULL, NULL, now()) ON CONFLICT (id) DO NOTHING;",
            (MACHINE_ID,),
        )
        for session_id in OPERATOR_SESSIONS:
            self.start_session(session_id, OPERATOR_ID)
        self.start_session(MANAGER_SESSION, MANAGER_ID)
        self.start_session(ADMIN_SESSION, ADMIN_ID)
        self.start_session(REMOVED_SESSION, REMOVED_ID)

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def start_session(self, session_id, user_id, created=None, updated=None, refreshed=None):
        """What GoTrue does at a sign-in: one row. `refreshed` is zone-less, as GoTrue writes it."""
        self.cur.execute(
            "INSERT INTO auth.sessions (id, user_id, created_at, updated_at, refreshed_at)"
            " VALUES (%s, %s, coalesce(%s, now()), coalesce(%s, now()), %s);",
            (session_id, user_id, created, updated, refreshed),
        )

    def call(self, user_id, sql, args=()):
        """Run `sql` as `user_id` through the API role. A refusal rolls back to the savepoint, so
        the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT acts_call;")
        try:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', (json.dumps({"sub": user_id}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT acts_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT acts_call;")
        return rows

    def end(self, actor, target):
        return self.call(actor, "SELECT public.end_person_sessions(%s);", (target,))[0][0]

    def summary(self, actor, target):
        return self.call(actor, "SELECT open_sessions, last_active_at FROM public.person_session_summary(%s);", (target,))[0]

    def sessions_of(self, user_id):
        self.cur.execute("SELECT id::text FROM auth.sessions WHERE user_id = %s ORDER BY id;", (user_id,))
        return [r[0] for r in self.cur.fetchall()]

    def rows(self, user_id, action):
        self.cur.execute(
            "SELECT entity_type, old_data, new_data, changed_by::text, actor_source, audit_domain, causation_id"
            "  FROM public.audit_trail WHERE entity_id = %s AND action = %s ORDER BY id;",
            (user_id, action),
        )
        return self.cur.fetchall()

    def refused_by_api(self, user_id, session_id):
        """Whether auth_pre_request() refuses a token naming this session, as PostgREST runs it."""
        self.cur.execute("SAVEPOINT pre_request;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute('SET LOCAL "request.jwt.claims" = %s;',
                             (json.dumps({"sub": user_id, "session_id": session_id}),))
            self.cur.execute("SELECT public.auth_pre_request();")
        except psycopg2.Error as error:
            self.cur.execute("ROLLBACK TO SAVEPOINT pre_request;")
            return error.pgcode == "PGRST" and json.loads(error.diag.message_primary)["code"] == "session_not_found"
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT pre_request;")
        return False


class EndingAPersonsSessions(PersonActsBase):
    def test_every_session_the_person_holds_ends_and_nobody_elses(self):
        self.assertEqual(self.end(ADMIN_ID, OPERATOR_ID), len(OPERATOR_SESSIONS))
        self.assertEqual(self.sessions_of(OPERATOR_ID), [])
        self.assertEqual(self.sessions_of(MANAGER_ID), [MANAGER_SESSION])
        self.assertEqual(self.sessions_of(ADMIN_ID), [ADMIN_SESSION])

    def test_the_api_refuses_an_ended_sessions_token_at_once(self):
        self.assertFalse(self.refused_by_api(OPERATOR_ID, OPERATOR_SESSIONS[0]))
        self.end(ADMIN_ID, OPERATOR_ID)
        for session_id in OPERATOR_SESSIONS:
            with self.subTest(session=session_id):
                self.assertTrue(self.refused_by_api(OPERATOR_ID, session_id))
        self.assertFalse(self.refused_by_api(MANAGER_ID, MANAGER_SESSION))

    def test_one_audit_row_says_who_ended_whose_sessions_and_how_many(self):
        self.end(ADMIN_ID, OPERATOR_ID)
        rows = self.rows(OPERATOR_ID, "SESSIONS_ENDED")
        self.assertEqual(len(rows), 1)
        entity_type, old, new, changed_by, actor_source, domain, _ = rows[0]
        self.assertEqual(entity_type, "user_roles")
        self.assertIsNone(old)
        self.assertEqual(new, {"email": email_of(OPERATOR_ID), "sessions_ended": len(OPERATOR_SESSIONS)})
        self.assertEqual(changed_by, ADMIN_ID)
        self.assertEqual(actor_source, "user")
        self.assertEqual(domain, "security")

    def test_a_person_with_no_session_ends_none_and_it_is_recorded(self):
        self.end(ADMIN_ID, OPERATOR_ID)
        self.assertEqual(self.end(SECOND_ADMIN_ID, OPERATOR_ID), 0)
        self.assertEqual([r[2]["sessions_ended"] for r in self.rows(OPERATOR_ID, "SESSIONS_ENDED")],
                         [len(OPERATOR_SESSIONS), 0])

    def test_a_removed_persons_sessions_may_be_ended(self):
        self.assertEqual(self.end(ADMIN_ID, REMOVED_ID), 1)
        self.assertEqual(self.sessions_of(REMOVED_ID), [])

    def test_only_an_administrator_ends_a_persons_sessions(self):
        for actor in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID):
            with self.subTest(actor=actor):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.end(actor, OPERATOR_ID if actor != OPERATOR_ID else MANAGER_ID)
        self.assertEqual(len(self.sessions_of(OPERATOR_ID)), len(OPERATOR_SESSIONS))
        self.assertEqual(self.sessions_of(MANAGER_ID), [MANAGER_SESSION])
        self.assertEqual(self.rows(OPERATOR_ID, "SESSIONS_ENDED"), [])

    def test_nobody_ends_their_own_sessions_here(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as refused:
            self.end(ADMIN_ID, ADMIN_ID)
        self.assertIn("your own sessions", str(refused.exception))
        self.assertIn("Sign Out", str(refused.exception))
        self.assertEqual(self.sessions_of(ADMIN_ID), [ADMIN_SESSION])

    def test_a_machine_identity_is_refused_and_an_unknown_person_is_a_404(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.end(ADMIN_ID, MACHINE_ID)
        unknown = str(uuid.uuid4())
        with self.assertRaises(psycopg2.Error) as refused:
            self.end(ADMIN_ID, unknown)
        self.assertEqual(refused.exception.pgcode, "PGRST")
        self.assertEqual(json.loads(refused.exception.diag.message_primary)["code"], "P0002")


class HowManySessionsAPersonHolds(PersonActsBase):
    def test_the_count_and_the_latest_time_any_was_active(self):
        person = OPERATOR_ID
        self.cur.execute("DELETE FROM auth.sessions WHERE user_id = %s;", (person,))
        utc = datetime.timezone.utc
        # Refreshed latest, written zone-less in UTC as GoTrue writes it.
        self.start_session(str(uuid.uuid4()), person,
                           created="2026-10-20T08:00:00Z", updated="2026-10-21T08:00:00Z",
                           refreshed="2026-10-24 23:30:00")
        # Updated latest of its own times, never refreshed.
        self.start_session(str(uuid.uuid4()), person,
                           created="2026-10-22T08:00:00Z", updated="2026-10-23T09:15:00Z")
        count, last = self.summary(ADMIN_ID, person)
        self.assertEqual(count, 2)
        self.assertEqual(last, datetime.datetime(2026, 10, 24, 23, 30, tzinfo=utc))

    def test_none_is_zero_and_no_time(self):
        self.end(ADMIN_ID, OPERATOR_ID)
        self.assertEqual(self.summary(ADMIN_ID, OPERATOR_ID), (0, None))

    def test_only_an_administrator_reads_it(self):
        for actor in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID):
            with self.subTest(actor=actor):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.summary(actor, OPERATOR_ID)
        self.assertEqual(self.summary(ADMIN_ID, OPERATOR_ID)[0], len(OPERATOR_SESSIONS))


class ChangingAPersonsEmailAddress(PersonActsBase):
    def check(self, actor, target, email):
        return self.call(actor, "SELECT public.check_person_email_change(%s, %s);", (target, email))[0][0]

    def record(self, actor, target, old, new):
        return self.call(actor, "SELECT public.record_person_email_change(%s, %s, %s);", (target, old, new))[0][0]

    def gotrue_changes(self, user_id, email):
        """What GoTrue's admin API does with the address."""
        self.cur.execute("UPDATE auth.users SET email = %s WHERE id = %s;", (email, user_id))

    def test_the_check_returns_the_address_held_and_writes_nothing(self):
        self.assertEqual(self.check(ADMIN_ID, OPERATOR_ID, "  New.Address@Sessions.Test "), email_of(OPERATOR_ID))
        self.assertEqual(self.rows(OPERATOR_ID, "EMAIL_CHANGED"), [])
        self.assertEqual(len(self.sessions_of(OPERATOR_ID)), len(OPERATOR_SESSIONS))

    def test_the_check_refuses_what_people_refuses(self):
        cases = [
            (ADMIN_ID, ADMIN_ID, "new@sessions.test", psycopg2.errors.InsufficientPrivilege, "your own email address"),
            (MANAGER_ID, OPERATOR_ID, "new@sessions.test", psycopg2.errors.InsufficientPrivilege, "insufficient privileges"),
            (ADMIN_ID, REMOVED_ID, "new@sessions.test", psycopg2.errors.RaiseException, "Restore it first"),
            (ADMIN_ID, OPERATOR_ID, email_of(MANAGER_ID).upper(), psycopg2.errors.RaiseException, "already belongs to another account"),
            (ADMIN_ID, OPERATOR_ID, email_of(OPERATOR_ID), psycopg2.errors.InvalidParameterValue, "already their email address"),
            (ADMIN_ID, OPERATOR_ID, "not-an-address", psycopg2.errors.InvalidParameterValue, "not an email address"),
            (ADMIN_ID, OPERATOR_ID, "two words@sessions.test", psycopg2.errors.InvalidParameterValue, "not an email address"),
            (ADMIN_ID, MACHINE_ID, "machine@sessions.test", psycopg2.errors.InvalidParameterValue, "machine identity"),
        ]
        for actor, target, email, error, words in cases:
            with self.subTest(target=target, email=email):
                with self.assertRaises(error) as refused:
                    self.check(actor, target, email)
                self.assertIn(words, str(refused.exception))

    def test_a_taken_address_names_no_role(self):
        with self.assertRaises(psycopg2.errors.RaiseException) as refused:
            self.check(ADMIN_ID, OPERATOR_ID, email_of(SECOND_ADMIN_ID))
        self.assertNotIn("Administrator", str(refused.exception).split("\n")[0])

    def test_the_record_writes_both_addresses_and_ends_the_persons_sessions(self):
        old = self.check(ADMIN_ID, OPERATOR_ID, "renamed@sessions.test")
        self.gotrue_changes(OPERATOR_ID, "renamed@sessions.test")
        self.assertEqual(self.record(ADMIN_ID, OPERATOR_ID, old, "renamed@sessions.test"), len(OPERATOR_SESSIONS))
        changed = self.rows(OPERATOR_ID, "EMAIL_CHANGED")
        self.assertEqual(len(changed), 1)
        entity_type, before, after, changed_by, actor_source, domain, causation = changed[0]
        self.assertEqual((entity_type, changed_by, actor_source, domain), ("user_roles", ADMIN_ID, "user", "security"))
        self.assertEqual(before, {"email": email_of(OPERATOR_ID)})
        self.assertEqual(after, {"email": "renamed@sessions.test"})
        # Sessions end in one place: end_person_sessions()'s row, in the same transaction.
        ended = self.rows(OPERATOR_ID, "SESSIONS_ENDED")
        self.assertEqual(len(ended), 1)
        self.assertEqual(ended[0][2], {"email": "renamed@sessions.test", "sessions_ended": len(OPERATOR_SESSIONS)})
        self.assertEqual(ended[0][6], causation)
        self.assertEqual(self.sessions_of(OPERATOR_ID), [])
        self.assertTrue(self.refused_by_api(OPERATOR_ID, OPERATOR_SESSIONS[0]))

    def test_the_record_refuses_a_change_the_account_does_not_show(self):
        with self.assertRaises(psycopg2.errors.RaiseException) as refused:
            self.record(ADMIN_ID, OPERATOR_ID, email_of(OPERATOR_ID), "never-made@sessions.test")
        self.assertIn("after the sign-in service has made it", str(refused.exception))
        self.assertEqual(self.rows(OPERATOR_ID, "EMAIL_CHANGED"), [])
        self.assertEqual(len(self.sessions_of(OPERATOR_ID)), len(OPERATOR_SESSIONS))

    def test_the_record_needs_the_old_address(self):
        self.gotrue_changes(OPERATOR_ID, "renamed@sessions.test")
        for old in (None, "renamed@sessions.test"):
            with self.subTest(old=old):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.record(ADMIN_ID, OPERATOR_ID, old, "renamed@sessions.test")

    def test_only_an_administrator_records_one_and_never_their_own(self):
        self.gotrue_changes(OPERATOR_ID, "renamed@sessions.test")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.record(MANAGER_ID, OPERATOR_ID, email_of(OPERATOR_ID), "renamed@sessions.test")
        self.gotrue_changes(ADMIN_ID, "admin-renamed@sessions.test")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.record(ADMIN_ID, ADMIN_ID, email_of(ADMIN_ID), "admin-renamed@sessions.test")
        self.assertEqual(self.rows(OPERATOR_ID, "EMAIL_CHANGED"), [])


class WhoMayCallThem(PersonActsBase):
    def test_anon_may_call_none_and_authenticated_all(self):
        for f in FUNCTIONS:
            with self.subTest(function=f):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE');", (f,))
                self.assertFalse(self.cur.fetchone()[0])
                self.cur.execute("SELECT has_function_privilege('authenticated', %s, 'EXECUTE');", (f,))
                self.assertTrue(self.cur.fetchone()[0])

    def test_each_is_a_definer_with_its_search_path_pinned(self):
        for f in FUNCTIONS:
            with self.subTest(function=f):
                self.cur.execute(
                    "SELECT prosecdef, 'search_path=public' = ANY (proconfig) FROM pg_proc WHERE oid = %s::regprocedure;",
                    (f,),
                )
                self.assertEqual(self.cur.fetchone(), (True, True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
