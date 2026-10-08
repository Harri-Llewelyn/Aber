"""
An Administrator adds people, sets their roles and passwords, and removes their access (0166, 0167,
0170).

    python supabase/migrations/test_people_management.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: that only an Administrator may list people or change one, that a machine
identity is never a person, that an unknown person is a 404, that a person keeps exactly one role
row however often it is set, that nobody changes their own role, access or password here, that the
last Administrator who can sign in cannot be demoted or removed, that a removed person's password
is not set, that the API refuses a removed person's token until their access is restored (0170),
that the acts serialise on one lock, that each act is in the Audit Trail's security lane,
attributed, with no password in it, and that nothing gives a self-registered account a role.

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

ADMIN_ID = "a0d17070-0000-4000-8000-0000000166a1"
SECOND_ADMIN_ID = "a0d17070-0000-4000-8000-0000000166a2"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000166b1"
OPERATOR_ID = "a0d17070-0000-4000-8000-0000000166c1"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000166d1"
NEWCOMER_ID = "a0d17070-0000-4000-8000-0000000166e1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000166f1"

PUBLIC_FUNCTIONS = [
    "public.list_people()",
    "public.set_person_role(uuid, text)",
    "public.record_person_added(uuid, text, boolean)",
    "public.remove_person_access(uuid)",
    "public.restore_person_access(uuid)",
    "public.record_person_password_set(uuid, boolean)",
]
INTERNAL_FUNCTIONS = [
    "public.person_access_is_removed(uuid)",
    "public.check_person_act(uuid, text)",
    "public.check_an_administrator_remains(uuid)",
    "public.write_person_role(uuid, integer)",
    "public.person_role_id(text)",
]


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class PeopleManagement(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.set_person_role(uuid, text)');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0166 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        self.roles = {name: rid for rid, name in self.cur.fetchall()}
        self.make_fixtures()

    def make_fixtures(self):
        # A person has an email; the machine identity has neither email, password nor identity.
        people = [
            (ADMIN_ID, "Administrator", True), (SECOND_ADMIN_ID, "Administrator", True),
            (MANAGER_ID, "Shopfloor_Manager", True), (OPERATOR_ID, "Operator", True),
            (AUDITOR_ID, "Auditor", True), (NEWCOMER_ID, None, False),
        ]
        for user_id, role, signed_in in people:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at, last_sign_in_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now(), CASE WHEN %s THEN now() END)"
                " ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@people.test", signed_in),
            )
            if role:
                self.cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (user_id, self.roles[role]),
                )
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, NULL, NULL, now()) ON CONFLICT (id) DO NOTHING;",
            (MACHINE_ID,),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def call(self, user_id, sql, args=()):
        """Run `sql` as `user_id` through the API role. A refusal rolls back to the savepoint, so
        the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT people_call;")
        try:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', (json.dumps({"sub": user_id}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT people_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT people_call;")
        return rows

    def set_role(self, actor, target, role):
        return self.call(actor, "SELECT public.set_person_role(%s, %s);", (target, role))[0][0]

    def remove(self, actor, target):
        return self.call(actor, "SELECT public.remove_person_access(%s);", (target,))[0][0]

    def restore(self, actor, target):
        return self.call(actor, "SELECT public.restore_person_access(%s);", (target,))[0][0]

    def set_password(self, actor, target, check_only=False):
        return self.call(actor, "SELECT public.record_person_password_set(%s, %s);", (target, check_only))

    def people(self, actor=ADMIN_ID):
        rows = self.call(actor, "SELECT * FROM public.list_people();")
        names = ["user_id", "email", "role", "status", "sign_in_blocked", "role_on_restore",
                 "invited_at", "last_sign_in_at", "created_at"]
        return {str(r[0]): dict(zip(names, r)) for r in rows}

    def role_rows(self, user_id):
        self.cur.execute(
            "SELECT r.name FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id"
            " WHERE ur.user_id = %s ORDER BY r.name;",
            (user_id,),
        )
        return [r[0] for r in self.cur.fetchall()]

    def audit(self, user_id, action):
        """The rows a person's act wrote. setUp's own role rows are written with no session, so
        they carry no changed_by and are left out."""
        self.cur.execute(
            "SELECT changed_by::text, audit_domain, old_data, new_data FROM public.audit_trail"
            " WHERE entity_type = 'user_roles' AND entity_id = %s AND action = %s"
            "   AND changed_by IS NOT NULL"
            " ORDER BY id;",
            (user_id, action),
        )
        return self.cur.fetchall()

    def user_roles_locks(self):
        self.cur.execute(
            "SELECT mode FROM pg_locks WHERE pid = pg_backend_pid() AND granted"
            " AND relation = 'public.user_roles'::regclass;"
        )
        return {r[0] for r in self.cur.fetchall()}

    def only_these_administrators_can_sign_in(self, *user_ids):
        """Bans every other Administrator in this database for the test's transaction, so the
        last-Administrator rule is decided by the fixtures alone."""
        self.cur.execute(
            "UPDATE auth.users SET banned_until = now() + interval '1 day'"
            " WHERE id::text IN (SELECT ur.user_id FROM public.user_roles ur"
            "                     JOIN public.roles r ON r.id = ur.role_id"
            "                    WHERE r.name = 'Administrator')"
            "   AND NOT (id = ANY (%s::uuid[]));",
            (list(user_ids),),
        )

    # -- the grants -------------------------------------------------------------------------------

    def test_the_api_roles_reach_only_the_entry_points(self):
        for fn in PUBLIC_FUNCTIONS:
            self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                             " has_function_privilege('authenticated', %s, 'EXECUTE');", (fn, fn))
            self.assertEqual(self.cur.fetchone(), (False, True), fn)
        for fn in INTERNAL_FUNCTIONS:
            self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                             " has_function_privilege('authenticated', %s, 'EXECUTE');", (fn, fn))
            self.assertEqual(self.cur.fetchone(), (False, False), fn)
        self.cur.execute("SELECT has_table_privilege('authenticated', 'public.access_removals', 'SELECT');")
        self.assertFalse(self.cur.fetchone()[0])

    # -- who may act ------------------------------------------------------------------------------

    def test_only_an_administrator_may_list_or_change_people(self):
        calls = [
            ("SELECT * FROM public.list_people();", ()),
            ("SELECT public.set_person_role(%s, 'Auditor');", (OPERATOR_ID,)),
            ("SELECT public.record_person_added(%s, 'Operator', false);", (NEWCOMER_ID,)),
            ("SELECT public.remove_person_access(%s);", (OPERATOR_ID,)),
            ("SELECT public.restore_person_access(%s);", (OPERATOR_ID,)),
            ("SELECT public.record_person_password_set(%s, true);", (OPERATOR_ID,)),
            ("SELECT public.record_person_password_set(%s, false);", (OPERATOR_ID,)),
        ]
        for actor in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID):
            for sql, args in calls:
                with self.subTest(actor=actor, sql=sql):
                    with self.assertRaises(psycopg2.Error) as refused:
                        self.call(actor, sql, args)
                    self.assertEqual(refused.exception.pgcode, "42501")
        self.assertEqual(self.role_rows(OPERATOR_ID), ["Operator"])

    def test_a_machine_identity_is_never_a_person(self):
        self.assertNotIn(MACHINE_ID, self.people())
        for sql in ("SELECT public.set_person_role(%s, 'Operator');",
                    "SELECT public.remove_person_access(%s);",
                    "SELECT public.record_person_added(%s, 'Operator', false);",
                    "SELECT public.record_person_password_set(%s, false);"):
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.Error) as refused:
                    self.call(ADMIN_ID, sql, (MACHINE_ID,))
                self.assertEqual(refused.exception.pgcode, "22023")
                self.assertIn("machine identity", refused.exception.diag.message_primary)
        self.assertEqual(self.role_rows(MACHINE_ID), [])

    def test_an_unknown_person_is_a_404(self):
        unknown = str(uuid.uuid4())
        for sql in ("SELECT public.set_person_role(%s, 'Operator');",
                    "SELECT public.remove_person_access(%s);",
                    "SELECT public.restore_person_access(%s);",
                    "SELECT public.record_person_password_set(%s, true);",
                    "SELECT public.record_person_password_set(%s, false);"):
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.Error) as refused:
                    self.call(ADMIN_ID, sql, (unknown,))
                self.assertEqual(refused.exception.pgcode, "PGRST")
                body = json.loads(refused.exception.diag.message_primary)
                self.assertEqual(body["code"], "P0002")
                self.assertIn(unknown, body["message"])

    def test_an_unknown_role_is_refused(self):
        for role in ("Superuser", "administrator", ""):
            with self.subTest(role=role):
                with self.assertRaises(psycopg2.Error) as refused:
                    self.set_role(ADMIN_ID, OPERATOR_ID, role)
                self.assertEqual(refused.exception.pgcode, "22023")
        self.assertEqual(self.role_rows(OPERATOR_ID), ["Operator"])

    # -- setting a role ---------------------------------------------------------------------------

    def test_a_person_keeps_one_role_row_however_often_it_is_set(self):
        self.assertTrue(self.set_role(ADMIN_ID, OPERATOR_ID, "Auditor"))
        self.assertFalse(self.set_role(ADMIN_ID, OPERATOR_ID, "Auditor"))
        self.assertTrue(self.set_role(ADMIN_ID, OPERATOR_ID, "Shopfloor_Manager"))
        self.assertEqual(self.role_rows(OPERATOR_ID), ["Shopfloor_Manager"])
        # A person with no role gets one row, and one written by hand twice is folded to one.
        self.assertTrue(self.set_role(ADMIN_ID, NEWCOMER_ID, "Operator"))
        self.assertEqual(self.role_rows(NEWCOMER_ID), ["Operator"])
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s);",
                         (NEWCOMER_ID, self.roles["Auditor"]))
        self.assertTrue(self.set_role(ADMIN_ID, NEWCOMER_ID, "Auditor"))
        self.assertEqual(self.role_rows(NEWCOMER_ID), ["Auditor"])

    def test_a_role_change_is_recorded_and_attributed(self):
        self.set_role(ADMIN_ID, OPERATOR_ID, "Auditor")
        self.set_role(ADMIN_ID, NEWCOMER_ID, "Operator")
        for target, role in ((OPERATOR_ID, "Auditor"), (NEWCOMER_ID, "Operator")):
            rows = self.audit(target, "ROLE_GRANTED")
            self.assertEqual(len(rows), 1, target)
            changed_by, domain, _, new_data = rows[0]
            self.assertEqual((changed_by, domain, new_data["role"]), (ADMIN_ID, "security", role))

    def test_nobody_changes_their_own_role_or_access(self):
        for sql in ("SELECT public.set_person_role(%s, 'Operator');",
                    "SELECT public.remove_person_access(%s);"):
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.Error) as refused:
                    self.call(ADMIN_ID, sql, (ADMIN_ID,))
                self.assertEqual(refused.exception.pgcode, "42501")
                self.assertIn("your own", refused.exception.diag.message_primary)
        self.assertEqual(self.role_rows(ADMIN_ID), ["Administrator"])

    def test_the_last_administrator_who_can_sign_in_stays(self):
        # SECOND_ADMIN is banned with the rest, outside the dashboard, but holds a live token, so it
        # still passes has_role(); ADMIN is the only Administrator who can sign in.
        self.only_these_administrators_can_sign_in(ADMIN_ID)
        for sql in ("SELECT public.set_person_role(%s, 'Operator');",
                    "SELECT public.remove_person_access(%s);"):
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.Error) as refused:
                    self.call(SECOND_ADMIN_ID, sql, (ADMIN_ID,))
                self.assertEqual(refused.exception.pgcode, "P0001")
                self.assertIn("no Administrator", refused.exception.diag.message_primary)
        self.assertEqual(self.role_rows(ADMIN_ID), ["Administrator"])

    def test_one_administrator_may_demote_another_while_one_remains(self):
        self.only_these_administrators_can_sign_in(ADMIN_ID, SECOND_ADMIN_ID)
        self.assertTrue(self.set_role(ADMIN_ID, SECOND_ADMIN_ID, "Operator"))
        # The demoted one can no longer act, so the two cannot demote each other.
        with self.assertRaises(psycopg2.Error) as refused:
            self.set_role(SECOND_ADMIN_ID, ADMIN_ID, "Operator")
        self.assertEqual(refused.exception.pgcode, "42501")

    def test_every_act_on_a_person_takes_the_same_lock(self):
        """The lock that queues two Administrators acting at once, which is what keeps them from
        both passing the last-Administrator rule. Taken by every act, held to the end of it.
        Each act runs in a transaction of its own, so a lock the one before took cannot pass it."""
        acts = {
            "set": lambda: self.set_role(ADMIN_ID, OPERATOR_ID, "Auditor"),
            "remove": lambda: self.remove(ADMIN_ID, MANAGER_ID),
            "restore": lambda: self.restore(ADMIN_ID, AUDITOR_ID),
            "add": lambda: self.call(
                ADMIN_ID, "SELECT public.record_person_added(%s, 'Operator', false);", (NEWCOMER_ID,)),
            "check a password": lambda: self.set_password(ADMIN_ID, OPERATOR_ID, check_only=True),
            "record a password": lambda: self.set_password(ADMIN_ID, OPERATOR_ID),
        }
        for name, act in acts.items():
            with self.subTest(act=name):
                self.conn.rollback()
                self.make_fixtures()
                # A ban, written as the owner, is a removal that took no lock.
                self.cur.execute("UPDATE auth.users SET banned_until = now() + interval '1 day'"
                                 " WHERE id = %s;", (AUDITOR_ID,))
                self.assertNotIn("ShareRowExclusiveLock", self.user_roles_locks())
                act()
                self.assertIn("ShareRowExclusiveLock", self.user_roles_locks())

    # -- adding a person --------------------------------------------------------------------------

    def test_adding_a_person_gives_the_role_and_records_no_password(self):
        self.call(ADMIN_ID, "SELECT public.record_person_added(%s, 'Shopfloor_Manager', false);",
                  (NEWCOMER_ID,))
        self.assertEqual(self.role_rows(NEWCOMER_ID), ["Shopfloor_Manager"])
        rows = self.audit(NEWCOMER_ID, "PERSON_ADDED")
        self.assertEqual(len(rows), 1)
        changed_by, domain, old_data, new_data = rows[0]
        self.assertEqual((changed_by, domain, old_data), (ADMIN_ID, "security", None))
        self.assertEqual(new_data, {"email": f"{NEWCOMER_ID}@people.test",
                                    "role": "Shopfloor_Manager", "method": "initial password"})
        self.assertNotIn("not-a-real-hash", json.dumps(new_data))
        self.assertEqual(len(self.audit(NEWCOMER_ID, "ROLE_GRANTED")), 1)

    def test_an_older_account_cannot_be_recorded_as_added(self):
        # OPERATOR has signed in; the newcomer, aged two hours, has not.
        self.cur.execute("UPDATE auth.users SET created_at = now() - interval '2 hours' WHERE id = %s;",
                         (NEWCOMER_ID,))
        for target in (OPERATOR_ID, NEWCOMER_ID):
            with self.subTest(target=target):
                with self.assertRaises(psycopg2.Error) as refused:
                    self.call(ADMIN_ID, "SELECT public.record_person_added(%s, 'Operator', true);",
                              (target,))
                self.assertEqual(refused.exception.pgcode, "22023")
        self.assertEqual(self.audit(NEWCOMER_ID, "PERSON_ADDED"), [])

    # -- removing and restoring access ------------------------------------------------------------

    def test_removing_access_stops_every_role_check_at_once(self):
        self.assertTrue(self.remove(ADMIN_ID, MANAGER_ID))
        self.assertEqual(self.role_rows(MANAGER_ID), [])
        allowed = self.call(MANAGER_ID, "SELECT public.has_role(ARRAY['Shopfloor_Manager']);")[0][0]
        self.assertFalse(allowed)
        person = self.people()[MANAGER_ID]
        self.assertEqual((person["status"], person["role"], person["role_on_restore"]),
                         ("removed", None, "Shopfloor_Manager"))

    def test_removing_twice_changes_nothing_the_second_time(self):
        self.assertTrue(self.remove(ADMIN_ID, MANAGER_ID))
        self.assertFalse(self.remove(ADMIN_ID, MANAGER_ID))
        self.assertEqual(len(self.audit(MANAGER_ID, "ACCESS_REMOVED")), 1)
        self.assertEqual(len(self.audit(MANAGER_ID, "ROLE_REVOKED")), 1)

    def test_a_removed_person_gets_a_role_only_by_restoring_access(self):
        self.remove(ADMIN_ID, MANAGER_ID)
        with self.assertRaises(psycopg2.Error) as refused:
            self.set_role(ADMIN_ID, MANAGER_ID, "Operator")
        self.assertEqual(refused.exception.pgcode, "P0001")
        self.assertEqual(self.restore(ADMIN_ID, MANAGER_ID), "Shopfloor_Manager")
        self.assertEqual(self.role_rows(MANAGER_ID), ["Shopfloor_Manager"])
        self.assertEqual(self.people()[MANAGER_ID]["status"], "active")
        self.assertTrue(self.set_role(ADMIN_ID, MANAGER_ID, "Operator"))

    def pre_request_refusal(self, sub):
        """What PostgREST's db-pre-request hook says to a request whose token names `sub`: the
        refusal's message, or None when the request is served."""
        try:
            self.call(sub, "SELECT public.auth_pre_request();")
        except psycopg2.errors.InsufficientPrivilege as refused:
            return refused.diag.message_primary
        return None

    def test_a_removed_persons_token_is_refused_until_access_is_restored(self):
        self.assertIsNone(self.pre_request_refusal(MANAGER_ID))
        self.remove(ADMIN_ID, MANAGER_ID)
        removed = "this person's access has been removed"
        self.assertEqual(self.pre_request_refusal(MANAGER_ID), removed)
        self.assertEqual(self.pre_request_refusal(MANAGER_ID.upper()), removed)
        # Nobody else: the Administrator who acted, a person with no role, a subject that is no uuid.
        for other in (ADMIN_ID, NEWCOMER_ID, "not-a-uuid"):
            self.assertIsNone(self.pre_request_refusal(other), other)
        self.restore(ADMIN_ID, MANAGER_ID)
        self.assertIsNone(self.pre_request_refusal(MANAGER_ID))

    def test_restoring_access_that_was_not_removed_is_refused(self):
        with self.assertRaises(psycopg2.Error) as refused:
            self.restore(ADMIN_ID, MANAGER_ID)
        self.assertEqual(refused.exception.pgcode, "P0001")
        self.assertEqual(self.audit(MANAGER_ID, "ACCESS_RESTORED"), [])

    def test_a_ban_made_elsewhere_reads_as_removed_and_can_be_restored(self):
        self.cur.execute("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = %s;",
                         (AUDITOR_ID,))
        person = self.people()[AUDITOR_ID]
        self.assertEqual((person["status"], person["sign_in_blocked"], person["role"]),
                         ("removed", True, "Auditor"))
        self.assertEqual(self.restore(ADMIN_ID, AUDITOR_ID), "Auditor")

    def test_removal_and_restoration_are_recorded_and_attributed(self):
        self.remove(ADMIN_ID, MANAGER_ID)
        self.restore(ADMIN_ID, MANAGER_ID)
        expected = {
            "ACCESS_REMOVED": ({"access": "active", "role": "Shopfloor_Manager"},
                               {"access": "removed", "email": f"{MANAGER_ID}@people.test"}),
            "ACCESS_RESTORED": ({"access": "removed"},
                                {"access": "active", "role": "Shopfloor_Manager",
                                 "email": f"{MANAGER_ID}@people.test"}),
        }
        for action, (old_data, new_data) in expected.items():
            rows = self.audit(MANAGER_ID, action)
            self.assertEqual(len(rows), 1, action)
            self.assertEqual(rows[0], (ADMIN_ID, "security", old_data, new_data), action)
        # The role row went and came back, each recorded by log_role_assignment().
        self.assertEqual(len(self.audit(MANAGER_ID, "ROLE_REVOKED")), 1)
        self.assertEqual(len(self.audit(MANAGER_ID, "ROLE_GRANTED")), 1)

    def test_list_people_reports_each_state(self):
        self.remove(ADMIN_ID, AUDITOR_ID)
        listed = self.people()
        self.assertEqual(listed[OPERATOR_ID]["status"], "active")
        self.assertEqual(listed[NEWCOMER_ID]["status"], "invited")
        self.assertIsNone(listed[NEWCOMER_ID]["role"])
        self.assertEqual(listed[AUDITOR_ID]["status"], "removed")
        # The ban is GoTrue's, made by the edge function after this; the database alone has not
        # blocked sign-in, and says so.
        self.assertFalse(listed[AUDITOR_ID]["sign_in_blocked"])

    # -- setting a password -----------------------------------------------------------------------

    def test_checking_writes_nothing_and_recording_holds_no_password(self):
        self.set_password(ADMIN_ID, OPERATOR_ID, check_only=True)
        self.call(ADMIN_ID, "SELECT public.record_person_password_set(%s, NULL);", (OPERATOR_ID,))
        self.assertEqual(self.audit(OPERATOR_ID, "PASSWORD_SET"), [], "a check is not a change")

        self.set_password(ADMIN_ID, OPERATOR_ID)
        rows = self.audit(OPERATOR_ID, "PASSWORD_SET")
        self.assertEqual(rows, [(ADMIN_ID, "security", None,
                                 {"email": f"{OPERATOR_ID}@people.test",
                                  "method": "new password shown once"})])
        self.assertNotIn("not-a-real-hash", json.dumps(rows[0][3]))
        # A password is not a role: the role rows are untouched.
        self.assertEqual(self.role_rows(OPERATOR_ID), ["Operator"])
        self.assertEqual(self.audit(OPERATOR_ID, "ROLE_GRANTED"), [])

    def test_an_invited_person_and_an_administrator_can_be_given_a_password(self):
        for target in (NEWCOMER_ID, SECOND_ADMIN_ID):
            with self.subTest(target=target):
                self.set_password(ADMIN_ID, target)
                self.assertEqual(len(self.audit(target, "PASSWORD_SET")), 1)

    def test_nobody_sets_their_own_password_here(self):
        for check_only in (True, False):
            with self.subTest(check_only=check_only):
                with self.assertRaises(psycopg2.Error) as refused:
                    self.set_password(ADMIN_ID, ADMIN_ID, check_only)
                self.assertEqual(refused.exception.pgcode, "42501")
                self.assertIn("Change Password", refused.exception.diag.message_primary)
        self.assertEqual(self.audit(ADMIN_ID, "PASSWORD_SET"), [])

    def test_a_removed_person_is_restored_before_their_password_is_set(self):
        # Removed here, and banned outside the dashboard: both read as removed.
        self.remove(ADMIN_ID, MANAGER_ID)
        self.cur.execute("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = %s;",
                         (AUDITOR_ID,))
        for target in (MANAGER_ID, AUDITOR_ID):
            for check_only in (True, False):
                with self.subTest(target=target, check_only=check_only):
                    with self.assertRaises(psycopg2.Error) as refused:
                        self.set_password(ADMIN_ID, target, check_only)
                    self.assertEqual(refused.exception.pgcode, "P0001")
                    self.assertIn("Restore it first", refused.exception.diag.message_primary)
            self.assertEqual(self.audit(target, "PASSWORD_SET"), [])
        self.restore(ADMIN_ID, MANAGER_ID)
        self.set_password(ADMIN_ID, MANAGER_ID)
        self.assertEqual(len(self.audit(MANAGER_ID, "PASSWORD_SET")), 1)

    # -- sign-up ----------------------------------------------------------------------------------

    def test_nothing_gives_a_self_registered_account_a_role(self):
        self.cur.execute("SELECT to_regprocedure('public.handle_new_user()');")
        self.assertIsNone(self.cur.fetchone()[0], "handle_new_user() is back")
        self.cur.execute("SELECT tgname FROM pg_trigger"
                         " WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal;")
        self.assertEqual(self.cur.fetchall(), [], "a trigger on auth.users runs for every sign-up")
        # The row GoTrue's sign-up writes: an address, a password hash, and no role declared.
        signed_up = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', '{\"provider\": \"email\"}', now());",
            (signed_up, f"{signed_up}@people.test"),
        )
        self.assertEqual(self.role_rows(signed_up), [])
        self.assertIsNone(self.people()[signed_up]["role"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
