"""
An Administrator resets a person's second factor, recorded in their lane (0216).

    python supabase/migrations/test_an_administrator_resets_a_person_s_second_factor.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: record_person_mfa_reset() is the database half of Reset MFA, which manage-people
calls around GoTrue's deletion of the factors. With p_check_only true (or NULL) it decides and
writes nothing. With false it writes one MFA_RESET row in the person's lane naming the
Administrator, with the person's email and how many factors went, none included. Only an
Administrator may call it; your own account, an unknown person, a machine identity and a missing or
negative count are refused with no row; a removed person's factors may be reset. It ends no session.

EVERY TEST ROLLS BACK. The acts write Audit Trail rows, and the audit table cannot be pruned.
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

ADMIN_ID = "a0d17070-0000-4000-8000-0000000216a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000216a2"
PERSON_ID = "a0d17070-0000-4000-8000-0000000216a3"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000216a4"
REMOVED_ID = "a0d17070-0000-4000-8000-0000000216b1"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000216c1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000216d1"

ADMIN_SESSION = "a0d17070-0000-4000-8000-0000000216f0"
PERSONS_SESSION = "a0d17070-0000-4000-8000-0000000216f1"

RESET = "SELECT public.record_person_mfa_reset(%s, %s, %s);"


def email_of(user_id):
    return f"{user_id}@second-factor.test"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class SecondFactorResetBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.record_person_mfa_reset(uuid, boolean, integer)');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0216 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        people = [
            (ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"), (PERSON_ID, "Operator"),
            (AUDITOR_ID, "Auditor"), (REMOVED_ID, None), (NO_ROLE_ID, None),
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
        for session_id, user_id in ((ADMIN_SESSION, ADMIN_ID), (PERSONS_SESSION, PERSON_ID)):
            self.cur.execute(
                "INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (%s, %s, now(), now());",
                (session_id, user_id),
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def call(self, user_id, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id`. A refusal rolls back to the
        savepoint, so the test can go on, and is raised."""
        claims = {"sub": user_id, "role": role, "session_id": ADMIN_SESSION}
        self.cur.execute("SAVEPOINT mfa_reset_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT mfa_reset_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT mfa_reset_call;")

    def reset(self, target=PERSON_ID, check_only=False, removed=1, caller=ADMIN_ID):
        self.call(caller, RESET, (target, check_only, removed))

    def rows(self, user_id=PERSON_ID):
        self.cur.execute(
            "SELECT entity_type, old_data, new_data, changed_by::text, actor_source, audit_domain, causation_id"
            "  FROM public.audit_trail WHERE entity_id = %s AND action = 'MFA_RESET' ORDER BY id;",
            (user_id,),
        )
        return self.cur.fetchall()

    def txid(self):
        self.cur.execute("SELECT txid_current();")
        return self.cur.fetchone()[0]


class Deciding(SecondFactorResetBase):
    def test_a_check_writes_nothing(self):
        for check_only in (True, None):
            with self.subTest(check_only=check_only):
                self.reset(check_only=check_only, removed=None)
                self.assertEqual(self.rows(), [])

    def test_only_an_administrator_may_call_it(self):
        for caller in (MANAGER_ID, PERSON_ID, AUDITOR_ID, NO_ROLE_ID, MACHINE_ID):
            for check_only in (True, False):
                with self.subTest(caller=caller, check_only=check_only):
                    with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                        self.reset(AUDITOR_ID if caller == PERSON_ID else PERSON_ID, check_only, caller=caller)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.rows(AUDITOR_ID), [])

    def test_your_own_account_is_refused_and_points_at_your_profile(self):
        for check_only in (True, False):
            with self.subTest(check_only=check_only):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as refused:
                    self.reset(ADMIN_ID, check_only)
                self.assertIn("Profile page's Security tab", refused.exception.diag.message_primary)
        self.assertEqual(self.rows(ADMIN_ID), [])

    def test_an_unknown_person_is_not_found(self):
        # raise_not_found() answers as PostgREST's 404, with P0002 in the body.
        with self.assertRaises(psycopg2.Error) as refused:
            self.reset(str(uuid.uuid4()), True)
        self.assertEqual(refused.exception.pgcode, "PGRST")
        self.assertEqual(json.loads(refused.exception.diag.message_primary)["code"], "P0002")

    def test_a_machine_identity_is_not_a_person(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.reset(MACHINE_ID, False)
        self.assertEqual(self.rows(MACHINE_ID), [])

    def test_a_record_with_no_count_or_a_negative_one_is_refused(self):
        for removed in (None, -1):
            with self.subTest(removed=removed):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.reset(removed=removed)
        self.assertEqual(self.rows(), [])

    def test_anon_and_service_role_may_not_execute_it(self):
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.call(ADMIN_ID, RESET, (PERSON_ID, True, None), role=role)


class Recording(SecondFactorResetBase):
    def test_one_row_in_the_persons_lane_names_the_administrator_and_the_count(self):
        self.reset(removed=2)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        entity_type, old, new, changed_by, actor_source, domain, causation = rows[0]
        self.assertEqual(entity_type, "user_roles")
        self.assertIsNone(old)
        self.assertEqual(new, {"email": email_of(PERSON_ID), "factors_removed": 2})
        self.assertEqual(changed_by, ADMIN_ID)
        self.assertEqual(actor_source, "user")
        self.assertEqual(domain, "security")
        self.assertEqual(causation, self.txid())
        self.assertEqual(self.rows(ADMIN_ID), [])

    def test_a_reset_of_none_is_recorded(self):
        self.reset(removed=0)
        self.assertEqual([r[2]["factors_removed"] for r in self.rows()], [0])

    def test_a_removed_persons_factors_may_be_reset(self):
        self.reset(REMOVED_ID, True, None)
        self.reset(REMOVED_ID, False, 1)
        self.assertEqual(len(self.rows(REMOVED_ID)), 1)

    def test_it_ends_no_session(self):
        self.reset(removed=1)
        self.cur.execute("SELECT id::text FROM auth.sessions WHERE user_id = %s;", (PERSON_ID,))
        self.assertEqual([r[0] for r in self.cur.fetchall()], [PERSONS_SESSION])
        self.cur.execute(
            "SELECT count(*) FROM public.audit_trail WHERE entity_id = %s AND action = 'SESSIONS_ENDED';",
            (PERSON_ID,),
        )
        self.assertEqual(self.cur.fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
