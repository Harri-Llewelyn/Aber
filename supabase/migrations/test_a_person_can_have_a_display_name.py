"""
A person can have a display name; the email stays the identifier (0203).

    python supabase/migrations/test_a_person_can_have_a_display_name.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: a person sets only their own name and an Administrator sets anyone's; the table's
CHECKs refuse a name that is too long or holds a control character, with a sentence; an empty or
whitespace-only name clears it; each change writes exactly one audit row in the person's lane, and
setting the same name writes none; nobody writes the table but set_display_name(); a person reads
only their own row; display_names_for() answers only for people the caller can already see on
Approvals and Archived Entities; list_people() and list_user_accounts() carry the name, and a
database holding their older shapes is brought forward by replaying 0001 and 0166.

EVERY TEST ROLLS BACK. The acts write Audit Trail rows, and the audit table cannot be pruned.
"""
import json
import os
import re
import unittest
import uuid
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATIONS = Path(__file__).resolve().parent

ADMIN_ID = "a0d17070-0000-4000-8000-0000000203a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000203b1"
OPERATOR_ID = "a0d17070-0000-4000-8000-0000000203c1"
SECOND_OPERATOR_ID = "a0d17070-0000-4000-8000-0000000203c2"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000203d1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000203f1"

LONGEST = "N" * 80


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class DisplayNameBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regclass('public.person_profiles');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0203 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        people = [
            (ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"),
            (OPERATOR_ID, "Operator"), (SECOND_OPERATOR_ID, "Operator"), (AUDITOR_ID, "Auditor"),
        ]
        for user_id, role in people:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at, last_sign_in_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now(), now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@names.test"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )
        # A machine identity: no email, no password, no identity provider.
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
        self.cur.execute("SAVEPOINT names_call;")
        try:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', (json.dumps({"sub": user_id}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT names_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT names_call;")
        return rows

    def set_name(self, actor, target, name):
        return self.call(actor, "SELECT public.set_display_name(%s, %s);", (target, name))[0][0]

    def stored(self, user_id):
        self.cur.execute("SELECT display_name FROM public.person_profiles WHERE user_id = %s;", (user_id,))
        row = self.cur.fetchone()
        return row[0] if row else None

    def name_rows(self, user_id):
        self.cur.execute(
            "SELECT entity_type, action, old_data, new_data, changed_by::text, actor_source, audit_domain"
            "  FROM public.audit_trail"
            " WHERE entity_id = %s AND action = 'DISPLAY_NAME_CHANGED' ORDER BY id;",
            (user_id,),
        )
        return self.cur.fetchall()


class WhoMaySetAName(DisplayNameBase):
    def test_a_person_sets_their_own_name(self):
        self.assertEqual(self.set_name(OPERATOR_ID, OPERATOR_ID, "Siân Ó Dálaigh"), "Siân Ó Dálaigh")
        self.assertEqual(self.stored(OPERATOR_ID), "Siân Ó Dálaigh")
        self.cur.execute("SELECT updated_by::text FROM public.person_profiles WHERE user_id = %s;", (OPERATOR_ID,))
        self.assertEqual(self.cur.fetchone()[0], OPERATOR_ID)

    def test_a_person_cannot_name_anyone_else(self):
        for actor in (OPERATOR_ID, MANAGER_ID, AUDITOR_ID):
            with self.subTest(actor=actor):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.set_name(actor, SECOND_OPERATOR_ID, "Somebody Else")
        self.assertIsNone(self.stored(SECOND_OPERATOR_ID))
        self.assertEqual(self.name_rows(SECOND_OPERATOR_ID), [])

    def test_an_administrator_names_anyone(self):
        self.assertEqual(self.set_name(ADMIN_ID, SECOND_OPERATOR_ID, "Line Two Operator"), "Line Two Operator")
        self.assertEqual(self.stored(SECOND_OPERATOR_ID), "Line Two Operator")
        self.cur.execute("SELECT updated_by::text FROM public.person_profiles WHERE user_id = %s;", (SECOND_OPERATOR_ID,))
        self.assertEqual(self.cur.fetchone()[0], ADMIN_ID)

    def test_a_machine_identity_has_no_display_name(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as refused:
            self.set_name(ADMIN_ID, MACHINE_ID, "Planner")
        self.assertIn("machine identity", str(refused.exception))
        # Nor may a machine identity set one, its own or anybody's.
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.set_name(MACHINE_ID, MACHINE_ID, "Planner")

    def test_nobody_signed_in_is_refused(self):
        self.cur.execute("SAVEPOINT anon;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute("SELECT public.set_display_name(%s, 'Nobody');", (OPERATOR_ID,))
        self.cur.execute("ROLLBACK TO SAVEPOINT anon;")
        self.cur.execute("SELECT has_function_privilege('anon', 'public.set_display_name(uuid, text)', 'EXECUTE');")
        self.assertFalse(self.cur.fetchone()[0])

    def test_an_unknown_person_is_a_404(self):
        unknown = str(uuid.uuid4())
        with self.assertRaises(psycopg2.Error) as refused:
            self.set_name(ADMIN_ID, unknown, "Ghost")
        self.assertEqual(refused.exception.pgcode, "PGRST")
        body = json.loads(refused.exception.diag.message_primary)
        self.assertEqual(body["code"], "P0002")
        self.assertIn(unknown, body["message"])

    def test_the_table_is_written_only_through_the_function(self):
        self.set_name(OPERATOR_ID, OPERATOR_ID, "Own Name")
        for sql in (
            "INSERT INTO public.person_profiles (user_id, display_name) VALUES ('%s', 'Direct')" % OPERATOR_ID,
            "UPDATE public.person_profiles SET display_name = 'Direct' WHERE user_id = '%s'" % OPERATOR_ID,
            "DELETE FROM public.person_profiles WHERE user_id = '%s'" % OPERATOR_ID,
        ):
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.call(OPERATOR_ID, sql)
        self.assertEqual(self.stored(OPERATOR_ID), "Own Name")

    def test_a_person_reads_only_their_own_row(self):
        self.set_name(ADMIN_ID, OPERATOR_ID, "First Operator")
        self.set_name(ADMIN_ID, SECOND_OPERATOR_ID, "Second Operator")
        self.set_name(ADMIN_ID, ADMIN_ID, "The Administrator")
        for actor, expected in ((OPERATOR_ID, ["First Operator"]), (ADMIN_ID, ["The Administrator"])):
            with self.subTest(actor=actor):
                rows = self.call(actor, "SELECT display_name FROM public.person_profiles ORDER BY 1;")
                self.assertEqual([r[0] for r in rows], expected)


class WhatANameMayBe(DisplayNameBase):
    def test_a_name_is_trimmed(self):
        self.assertEqual(self.set_name(OPERATOR_ID, OPERATOR_ID, "   Jane Smith  "), "Jane Smith")
        self.assertEqual(self.stored(OPERATOR_ID), "Jane Smith")

    def test_eighty_characters_is_the_longest(self):
        self.assertEqual(self.set_name(OPERATOR_ID, OPERATOR_ID, LONGEST), LONGEST)
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as refused:
            self.set_name(OPERATOR_ID, OPERATOR_ID, LONGEST + "N")
        self.assertIn("80 characters", str(refused.exception))
        self.assertEqual(self.stored(OPERATOR_ID), LONGEST)

    def test_a_control_character_is_refused(self):
        for name in ("Jane\tSmith", "Jane\nSmith", "Jane\u0085Smith", "Jane\u202eSmith", "Jane\u2066Smith"):
            with self.subTest(name=repr(name)):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue) as refused:
                    self.set_name(OPERATOR_ID, OPERATOR_ID, name)
                self.assertIn("control character", str(refused.exception))
        self.assertIsNone(self.stored(OPERATOR_ID))

    def test_letters_from_any_script_are_accepted(self):
        # A joiner is part of some scripts and of emoji sequences; it is not a control character.
        for name in ("Ffion ap Rhys", "李小龍", "Zoë Ångström", "👩\u200d🔧 Engineer"):
            with self.subTest(name=name):
                self.assertEqual(self.set_name(OPERATOR_ID, OPERATOR_ID, name), name)

    def test_the_checks_hold_for_the_owner_too(self):
        for name in (" padded", "", LONGEST + "N", "tab\there"):
            with self.subTest(name=repr(name)):
                self.cur.execute("SAVEPOINT owner_write;")
                with self.assertRaises(psycopg2.errors.CheckViolation):
                    self.cur.execute(
                        "INSERT INTO public.person_profiles (user_id, display_name) VALUES (%s, %s);",
                        (OPERATOR_ID, name),
                    )
                self.cur.execute("ROLLBACK TO SAVEPOINT owner_write;")

    def test_empty_whitespace_or_null_clears_it(self):
        for cleared in ("", "    ", None):
            with self.subTest(cleared=repr(cleared)):
                self.set_name(OPERATOR_ID, OPERATOR_ID, "Jane Smith")
                self.assertIsNone(self.set_name(OPERATOR_ID, OPERATOR_ID, cleared))
                self.assertIsNone(self.stored(OPERATOR_ID))


class EachChangeIsRecorded(DisplayNameBase):
    def test_a_change_writes_one_row_in_the_persons_lane(self):
        self.set_name(OPERATOR_ID, OPERATOR_ID, "Jane Smith")
        self.set_name(ADMIN_ID, OPERATOR_ID, "Jane Jones")
        rows = self.name_rows(OPERATOR_ID)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], ("user_roles", "DISPLAY_NAME_CHANGED", {"display_name": None},
                                   {"display_name": "Jane Smith"}, OPERATOR_ID, "user", "security"))
        self.assertEqual(rows[1], ("user_roles", "DISPLAY_NAME_CHANGED", {"display_name": "Jane Smith"},
                                   {"display_name": "Jane Jones"}, ADMIN_ID, "user", "security"))

    def test_the_same_name_again_writes_nothing(self):
        self.set_name(OPERATOR_ID, OPERATOR_ID, "Jane Smith")
        self.set_name(OPERATOR_ID, OPERATOR_ID, "Jane Smith")
        self.set_name(OPERATOR_ID, OPERATOR_ID, "  Jane Smith ")
        self.assertEqual(len(self.name_rows(OPERATOR_ID)), 1)

    def test_clearing_writes_one_row_and_clearing_nothing_writes_none(self):
        self.set_name(OPERATOR_ID, OPERATOR_ID, "")
        self.assertEqual(self.name_rows(OPERATOR_ID), [])
        self.set_name(OPERATOR_ID, OPERATOR_ID, "Jane Smith")
        self.set_name(OPERATOR_ID, OPERATOR_ID, "  ")
        rows = self.name_rows(OPERATOR_ID)
        self.assertEqual(len(rows), 2)
        self.assertEqual((rows[1][2], rows[1][3]), ({"display_name": "Jane Smith"}, {"display_name": None}))

    def test_a_refused_name_writes_nothing(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.set_name(OPERATOR_ID, OPERATOR_ID, LONGEST + "N")
        self.assertEqual(self.name_rows(OPERATOR_ID), [])

    def test_an_account_deleted_with_its_name_writes_no_rename(self):
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, 'leaving@names.test', 'not-a-real-hash', now());",
            (str(uuid.uuid4()),),
        )
        self.cur.execute("SELECT id::text FROM auth.users WHERE email = 'leaving@names.test';")
        leaving = self.cur.fetchone()[0]
        # Written as the owner, so the account has no audit row of its own to keep it.
        self.cur.execute(
            "INSERT INTO public.person_profiles (user_id, display_name) VALUES (%s, 'Leaving Soon');",
            (leaving,),
        )
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_id = %s;", (leaving,))
        before = self.cur.fetchone()[0]
        self.cur.execute("DELETE FROM auth.users WHERE id = %s;", (leaving,))
        self.assertIsNone(self.stored(leaving))
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_id = %s;", (leaving,))
        self.assertEqual(self.cur.fetchone()[0], before)

    def test_the_audit_trail_search_finds_a_person_by_name(self):
        self.set_name(ADMIN_ID, OPERATOR_ID, "Gwenllian Morgan")
        rows = self.call(AUDITOR_ID, "SELECT public.audit_trail_user_ids_matching('%%gwenllian%%')::text[];")
        self.assertEqual(rows[0][0], [OPERATOR_ID])
        # The email still finds them, and a role that cannot read the lane is told nothing.
        rows = self.call(AUDITOR_ID, "SELECT public.audit_trail_user_ids_matching(%s)::text[];",
                         (f"%{OPERATOR_ID}@names.test%",))
        self.assertEqual(rows[0][0], [OPERATOR_ID])
        rows = self.call(OPERATOR_ID, "SELECT public.audit_trail_user_ids_matching('%%gwenllian%%')::text[];")
        self.assertEqual(rows[0][0], [])


class WhoReadsAName(DisplayNameBase):
    def setUp(self):
        super().setUp()
        for user_id, name in ((ADMIN_ID, "Ada Admin"), (MANAGER_ID, "Morgan Manager"),
                              (OPERATOR_ID, "Owain Operator"), (SECOND_OPERATOR_ID, "Olwen Operator"),
                              (AUDITOR_ID, "Aled Auditor")):
            self.set_name(ADMIN_ID, user_id, name)
        # A proposal Owain filed, and an asset Morgan deleted.
        self.cell = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES (%s, %s);",
                         (self.cell, f"Names_{self.cell[:8]}"))
        self.cur.execute(
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch, proposed_by)"
            " VALUES ('cells', %s, '{\"description\": \"renamed\"}'::jsonb, %s);",
            (self.cell, OPERATOR_ID),
        )
        self.cur.execute(
            "INSERT INTO public.retired_entities (entity_type, entity_id, name, old_data, retired_by)"
            " VALUES ('devices', %s, 'Retired press', '{}'::jsonb, %s);",
            (str(uuid.uuid4()), MANAGER_ID),
        )

    def names_for(self, actor, ids):
        rows = self.call(actor, "SELECT user_id::text, display_name FROM public.display_names_for(%s::uuid[]);",
                         (ids,))
        return dict(rows)

    def test_everyone_is_answered_for_their_own_id(self):
        for actor, name in ((OPERATOR_ID, "Owain Operator"), (AUDITOR_ID, "Aled Auditor")):
            with self.subTest(actor=actor):
                self.assertEqual(self.names_for(actor, [actor]), {actor: name})

    def test_an_operator_is_answered_for_their_own_proposal_and_nothing_else(self):
        # Owain may read his own proposal, so he sees its proposer, himself. Olwen may not read it,
        # nor the tombstone, nor anybody else.
        self.assertEqual(self.names_for(OPERATOR_ID, [OPERATOR_ID]), {OPERATOR_ID: "Owain Operator"})
        self.assertEqual(self.names_for(SECOND_OPERATOR_ID, [OPERATOR_ID, MANAGER_ID, ADMIN_ID]), {})

    def test_a_manager_is_answered_for_a_proposer_and_a_retirer(self):
        self.assertEqual(self.names_for(MANAGER_ID, [OPERATOR_ID, MANAGER_ID, SECOND_OPERATOR_ID]),
                         {OPERATOR_ID: "Owain Operator", MANAGER_ID: "Morgan Manager"})

    def test_an_auditor_reads_the_retirer_but_not_the_proposer(self):
        # Auditor holds audit_trail:read, which retired_entities admits, and no role
        # change_proposals admits.
        self.assertEqual(self.names_for(AUDITOR_ID, [OPERATOR_ID, MANAGER_ID]), {MANAGER_ID: "Morgan Manager"})

    def test_an_id_nobody_can_see_here_is_left_out_even_for_an_administrator(self):
        self.assertEqual(self.names_for(ADMIN_ID, [SECOND_OPERATOR_ID, str(uuid.uuid4())]), {})

    def test_a_person_with_no_name_has_no_row(self):
        self.set_name(OPERATOR_ID, OPERATOR_ID, "")
        self.assertEqual(self.names_for(MANAGER_ID, [OPERATOR_ID]), {})

    def test_a_rename_shows_at_once_where_the_email_was_stamped(self):
        self.set_name(OPERATOR_ID, OPERATOR_ID, "Owain ap Rhys")
        self.assertEqual(self.names_for(MANAGER_ID, [OPERATOR_ID]), {OPERATOR_ID: "Owain ap Rhys"})

    def test_list_people_carries_the_name_for_an_administrator(self):
        rows = self.call(ADMIN_ID, "SELECT user_id::text, email, display_name FROM public.list_people();")
        by_id = {r[0]: r for r in rows}
        self.assertEqual(by_id[OPERATOR_ID][2], "Owain Operator")
        self.assertEqual(by_id[OPERATOR_ID][1], f"{OPERATOR_ID}@names.test")
        self.assertNotIn(MACHINE_ID, by_id)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.call(AUDITOR_ID, "SELECT * FROM public.list_people();")

    def test_a_removed_person_keeps_their_name(self):
        self.call(ADMIN_ID, "SELECT public.remove_person_access(%s);", (SECOND_OPERATOR_ID,))
        rows = self.call(ADMIN_ID, "SELECT user_id::text, status, display_name FROM public.list_people();")
        self.assertIn((SECOND_OPERATOR_ID, "removed", "Olwen Operator"), rows)

    def test_list_user_accounts_carries_the_name_for_an_administrator_and_an_auditor(self):
        for actor in (ADMIN_ID, AUDITOR_ID):
            with self.subTest(actor=actor):
                rows = self.call(actor, "SELECT user_id::text, email, display_name FROM public.list_user_accounts();")
                self.assertIn((MANAGER_ID, f"{MANAGER_ID}@names.test", "Morgan Manager"), rows)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.call(MANAGER_ID, "SELECT * FROM public.list_user_accounts();")


class AnOlderDatabaseIsBroughtForward(DisplayNameBase):
    """
    0001 and 0166 replay first on every boot, so they declare the new shapes, and each drops the
    older shape a database already holds before declaring its own. Replayed here over the shape
    1.6 left, inside the test's transaction.
    """

    def replay(self, path, pattern):
        source = (MIGRATIONS / path).read_text(encoding="utf-8")
        block = re.search(pattern, source, re.S)
        self.assertIsNotNone(block, f"{path} no longer has the block this replays")
        self.cur.execute(block.group(0))

    def result_of(self, signature):
        self.cur.execute("SELECT pg_get_function_result(%s::regprocedure);", (signature,))
        return self.cur.fetchone()[0]

    def test_0001_replaces_the_two_column_list_user_accounts(self):
        self.cur.execute("DROP FUNCTION public.list_user_accounts();")
        self.cur.execute(
            "CREATE FUNCTION public.list_user_accounts() RETURNS TABLE(user_id uuid, email text)"
            " LANGUAGE sql AS $$ SELECT id, email::text FROM auth.users $$;"
        )
        self.replay("0001_baseline_schema.sql",
                    r"DO \$shape\$\nBEGIN\n    IF to_regprocedure\('public\.list_user_accounts\(\)'\).*?\$\$;")
        self.assertEqual(self.result_of("public.list_user_accounts()"),
                         "TABLE(user_id uuid, email text, display_name text)")
        # A second replay over the new shape keeps the function: nothing depending on it is lost.
        self.cur.execute("SELECT 'public.list_user_accounts()'::regprocedure::oid;")
        oid = self.cur.fetchone()[0]
        self.replay("0001_baseline_schema.sql",
                    r"DO \$shape\$\nBEGIN\n    IF to_regprocedure\('public\.list_user_accounts\(\)'\).*?\$\$;")
        self.cur.execute("SELECT 'public.list_user_accounts()'::regprocedure::oid;")
        self.assertEqual(self.cur.fetchone()[0], oid)

    def test_0166_replaces_list_people_without_a_name(self):
        self.cur.execute("DROP FUNCTION public.list_people();")
        self.cur.execute(
            "CREATE FUNCTION public.list_people() RETURNS TABLE(user_id uuid, email text, role text,"
            " status text, sign_in_blocked boolean, role_on_restore text, invited_at timestamptz,"
            " last_sign_in_at timestamptz, created_at timestamptz)"
            " LANGUAGE sql AS $$ SELECT NULL::uuid, NULL, NULL, NULL, NULL::boolean, NULL,"
            " NULL::timestamptz, NULL::timestamptz, NULL::timestamptz $$;"
        )
        self.replay("0166_an_administrator_adds_people_and_sets_their_roles.sql",
                    r"DO \$shape\$\nBEGIN\n  IF to_regprocedure\('public\.list_people\(\)'\).*?GRANT EXECUTE ON FUNCTION public\.list_people\(\) TO authenticated;")
        self.assertTrue(self.result_of("public.list_people()").endswith(", display_name text)"))
        rows = self.call(ADMIN_ID, "SELECT count(*) FROM public.list_people() WHERE user_id = %s;", (OPERATOR_ID,))
        self.assertEqual(rows[0][0], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
