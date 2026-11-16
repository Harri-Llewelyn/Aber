# suite:
#   lanes: db
#   why: 0291's two CHECKs: an empty name and a name of spaces are refused on an insert and an
#     update of an area and of a cell, by an Administrator through the API role, by the service
#     role and by an approved proposal, which aborts and leaves the row named. The file is run in
#     the transaction over a database holding blank rows: it names each with its id, renames none,
#     scans only the table whose CHECK is missing, and passes once they are named. A replay keeps
#     every constraint's oid, 0001's two topic CHECKs among them. Each writer reaches the table
#     without the dashboard's dialogs, which is why the CHECK is the rule and the dialogs are not.

"""
An area's name and a cell's name cannot be blank (0291).

    python supabase/migrations/test_an_area_or_a_cell_cannot_have_a_blank_name.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * areas_name_not_blank and cells_name_not_blank refuse an empty name and a name of spaces, on an
    INSERT and on an UPDATE, and accept a real name (spaces around it, a number, another script).
    The refusal names the constraint. 0001's areas_name_topic_safe and cells_name_topic_safe are as
    they were: they still refuse / + and #, and cells_name_topic_safe is still NOT VALID.
  * It binds every way in: an Administrator writing through the API's role, the service role, and
    an approved proposal, which aborts the approval and leaves the row named.
  * A database that holds a blank name stops at 0291 with every such row named (table, id, when it
    was made and what the name holds), changes nothing, and passes once the rows are named. Running
    the file again with both CHECKs in place scans nothing and keeps every constraint (same oid).

EVERY TEST ROLLS BACK. The migration's own file is run inside the transaction, with the CHECKs
dropped first where a test needs the database as 1.8.0 left it.
"""
import json
import os
import re
import unittest
from pathlib import Path

import psycopg2
import psycopg2.errors
from psycopg2 import sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = Path(__file__).resolve().parents[2]
MIGRATION = Path(__file__).with_name("0291_an_area_or_a_cell_cannot_have_a_blank_name.sql")
WANT = "CHECK ((btrim(name) <> ''::text))"
TOPIC_SAFE = "CHECK (((name <> ''::text) AND (name !~ '[/+#]'::text)))"

ADMIN_ID = "a0d17291-0000-4000-8000-0000000291a1"
OPERATOR_ID = "a0d17291-0000-4000-8000-0000000291a2"
AREA_ID = "b1d17291-0000-4000-8000-0000000291b1"
CELL_ID = "c2d17291-0000-4000-8000-0000000291c1"

# (table, the new CHECK, the topic CHECK 0001 declares, a row's id, the name it starts with)
TABLES = (
    ("areas", "areas_name_not_blank", "areas_name_topic_safe", AREA_ID, "Test_0291_Area"),
    ("cells", "cells_name_not_blank", "cells_name_topic_safe", CELL_ID, "Test_0291_Cell"),
)
NEW_CHECKS = ("areas_name_not_blank", "cells_name_not_blank")
BLANKS = ("", " ", "     ", "  ")


def on(table, statement):
    """`statement` with {t} standing for public.<table>, composed rather than formatted."""
    return sql.SQL(statement).format(t=sql.Identifier("public", table))


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def upgrade_notes():
    """The guide as the release will leave it: the guide, then every note not yet folded into it."""
    parts = [(REPO / "help" / "site" / "upgrading.md").read_text(encoding="utf-8")]
    for note in sorted((REPO / "unreleased" / "upgrading").glob("*.md")):
        if note.name != "README.md":
            parts.append("\n" + note.read_text(encoding="utf-8"))
    return "\n".join(parts)


class BlankNameBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT count(*) FROM pg_constraint WHERE conname IN %s;", (NEW_CHECKS,))
        if self.cur.fetchone()[0] != 2:
            self.skipTest("0291 is not applied to this database")
        self.cur.execute("SELECT name, id FROM public.roles;")
        roles = dict(self.cur.fetchall())
        for user_id, role in ((ADMIN_ID, "Administrator"), (OPERATOR_ID, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id[-4:]}@blank-name.test"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        self.cur.execute("INSERT INTO public.areas (id, name) VALUES (%s, 'Test_0291_Area');", (AREA_ID,))
        self.cur.execute("INSERT INTO public.cells (id, name, area_id) VALUES (%s, 'Test_0291_Cell', %s);",
                         (CELL_ID, AREA_ID))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- helpers ---------------------------------------------------------------------------------
    def as_user(self, user, role="authenticated"):
        self.cur.execute("SELECT set_config('role', %s, true);", (role,))
        claims = {"sub": user, "role": role, "aal": "aal1", "email": f"{user[-4:]}@blank-name.test"}
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))

    def as_owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    def refused(self, sql, args=(), role=None, user=None):
        """Run `sql` and return the CheckViolation it raised, as PostgREST would run it for `user`
        under `role`. The transaction goes on after it."""
        self.cur.execute("SAVEPOINT blank_name;")
        try:
            if user:
                self.as_user(user, role or "authenticated")
            elif role:
                self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            with self.assertRaises(psycopg2.errors.CheckViolation) as caught:
                self.cur.execute(sql, args)
            return caught.exception
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT blank_name;")
            self.as_owner()
            self.cur.execute("RELEASE SAVEPOINT blank_name;")

    def name_of(self, table, row_id):
        self.cur.execute(on(table, "SELECT name FROM {t} WHERE id = %s;"), (row_id,))
        return self.cur.fetchone()[0]

    def oids(self, names=None):
        names = names or (*NEW_CHECKS, "areas_name_topic_safe", "cells_name_topic_safe")
        self.cur.execute("SELECT conname, oid FROM pg_constraint WHERE conname IN %s ORDER BY conname;",
                         (tuple(names),))
        return self.cur.fetchall()

    def insert_sql(self, table):
        return on(table, "INSERT INTO {t} (name) VALUES (%s);")


class TestTheTwoChecks(BlankNameBase):
    def test_each_is_declared_as_btrim_of_the_name_not_empty_and_validated(self):
        for table, constraint, _, _, _ in TABLES:
            with self.subTest(constraint=constraint):
                self.cur.execute("SELECT public.live_constraint_definition(conrelid, conname), convalidated"
                                 " FROM pg_constraint WHERE conname = %s AND conrelid = %s::regclass;",
                                 (constraint, f"public.{table}"))
                self.assertEqual(self.cur.fetchall(), [(WANT, True)])

    def test_0001s_topic_checks_are_as_they_were(self):
        # 0001 puts back a CHECK that reads otherwise, on every boot, so these two are not redefined:
        # a new CHECK beside each holds the new rule.
        self.cur.execute("SELECT conname, public.live_constraint_definition(conrelid, conname), convalidated"
                         " FROM pg_constraint WHERE conname IN ('areas_name_topic_safe', 'cells_name_topic_safe')"
                         " ORDER BY conname;")
        self.assertEqual(self.cur.fetchall(), [("areas_name_topic_safe", TOPIC_SAFE, True),
                                               ("cells_name_topic_safe", TOPIC_SAFE + " NOT VALID", False)])

    def test_a_blank_name_is_refused_on_an_insert(self):
        for table, constraint, _, _, _ in TABLES:
            for name in BLANKS:
                with self.subTest(table=table, name=name):
                    error = self.refused(self.insert_sql(table), (name,))
                    self.assertEqual(error.diag.constraint_name, constraint)
                    self.assertEqual(error.diag.table_name, table)

    def test_a_blank_name_is_refused_on_an_update_and_the_row_keeps_its_name(self):
        for table, constraint, _, row_id, _ in TABLES:
            before = self.name_of(table, row_id)
            for name in BLANKS:
                with self.subTest(table=table, name=name):
                    error = self.refused(on(table, "UPDATE {t} SET name = %s WHERE id = %s;"), (name, row_id))
                    self.assertEqual(error.diag.constraint_name, constraint)
                    self.assertEqual(self.name_of(table, row_id), before)

    def test_a_real_name_is_accepted_and_kept_as_given(self):
        # The CHECK refuses nothing but a blank: spaces around a name, a number and another script
        # are a name, and nothing trims it.
        for table, _, _, row_id, _ in TABLES:
            for name in ("Press 1", " Press 2 ", "7", "Gwasg 3", "Gwasg âêîôû", "A"):
                with self.subTest(table=table, name=name):
                    self.cur.execute(on(table, "UPDATE {t} SET name = %s WHERE id = %s;"), (name, row_id))
                    self.assertEqual(self.name_of(table, row_id), name)
                    self.cur.execute(self.insert_sql(table), (name + " (new)",))

    def test_the_topic_checks_still_refuse_a_separator_and_name_themselves(self):
        for table, _, topic_safe, row_id, _ in TABLES:
            for name in ("North/Campus", "North+Campus", "North#Campus", " / "):
                with self.subTest(table=table, name=name):
                    error = self.refused(on(table, "UPDATE {t} SET name = %s WHERE id = %s;"), (name, row_id))
                    self.assertEqual(error.diag.constraint_name, topic_safe)

    def test_the_name_alone_is_held_so_an_update_of_another_column_is_not_refused(self):
        for table, _, _, row_id, _ in TABLES:
            with self.subTest(table=table):
                self.cur.execute(on(table, "UPDATE {t} SET description = 'kept' WHERE id = %s;"), (row_id,))
                self.assertEqual(self.cur.rowcount, 1)


class TestEveryWayIn(BlankNameBase):
    def test_an_administrator_through_the_api_role_is_refused_on_an_update_and_an_insert(self):
        for table, constraint, _, row_id, name in TABLES:
            with self.subTest(table=table, write="update"):
                error = self.refused(on(table, "UPDATE {t} SET name = '' WHERE id = %s;"), (row_id,),
                                     role="authenticated", user=ADMIN_ID)
                self.assertEqual(error.diag.constraint_name, constraint)
                self.assertEqual(self.name_of(table, row_id), name)
            with self.subTest(table=table, write="insert"):
                error = self.refused(self.insert_sql(table), ("   ",), role="authenticated", user=ADMIN_ID)
                self.assertEqual(error.diag.constraint_name, constraint)

    def test_an_administrator_through_the_api_role_may_still_rename(self):
        for table, _, _, row_id, _ in TABLES:
            with self.subTest(table=table):
                self.as_user(ADMIN_ID)
                self.cur.execute(on(table, "UPDATE {t} SET name = 'Renamed' WHERE id = %s;"), (row_id,))
                self.assertEqual(self.cur.rowcount, 1)
                self.as_owner()
                self.assertEqual(self.name_of(table, row_id), "Renamed")

    def test_the_service_role_is_refused(self):
        # A machine identity that may write and a script run as the service role reach the table
        # without the dashboard's dialog.
        for table, constraint, _, row_id, _ in TABLES:
            with self.subTest(table=table):
                error = self.refused(on(table, "UPDATE {t} SET name = '  ' WHERE id = %s;"), (row_id,),
                                     role="service_role")
                self.assertEqual(error.diag.constraint_name, constraint)

    def test_an_approved_proposal_with_a_blank_name_aborts_the_approval(self):
        # Approving is applying, so the CHECK runs inside the approver's transaction: the approval
        # fails with the database's sentence, the proposal stays open and the row keeps its name.
        for table, constraint, _, row_id, name in TABLES:
            with self.subTest(table=table):
                self.as_user(OPERATOR_ID)
                self.cur.execute("INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
                                 " VALUES (%s, %s, %s::jsonb, 'the label is worn off') RETURNING id;",
                                 (table, row_id, json.dumps({"name": " "})))
                proposal = self.cur.fetchone()[0]
                self.as_owner()
                error = self.refused("SELECT public.approve_proposal(%s);", (proposal,),
                                     role="authenticated", user=ADMIN_ID)
                self.assertEqual(error.diag.constraint_name, constraint)
                self.cur.execute("SELECT status FROM public.change_proposals WHERE id = %s;", (proposal,))
                self.assertEqual(self.cur.fetchone()[0], "open")
                self.assertEqual(self.name_of(table, row_id), name)

    def test_an_approved_proposal_with_a_real_name_still_applies(self):
        for table, _, _, row_id, _ in TABLES:
            with self.subTest(table=table):
                self.as_user(OPERATOR_ID)
                self.cur.execute("INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
                                 " VALUES (%s, %s, %s::jsonb, 'the plan was renamed') RETURNING id;",
                                 (table, row_id, json.dumps({"name": "Proposed Name"})))
                proposal = self.cur.fetchone()[0]
                self.as_user(ADMIN_ID)
                self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
                self.as_owner()
                self.assertEqual(self.name_of(table, row_id), "Proposed Name")


class TestTheFile(BlankNameBase):
    """The migration's file, run inside the transaction against the database as 1.8.0 left it."""

    def drop_both(self):
        self.cur.execute("ALTER TABLE public.areas DROP CONSTRAINT areas_name_not_blank;"
                         "ALTER TABLE public.cells DROP CONSTRAINT cells_name_not_blank;")

    def run_file(self):
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))

    def run_file_refused(self):
        self.cur.execute("SAVEPOINT run_file;")
        try:
            with self.assertRaises(psycopg2.Error) as caught:
                self.run_file()
            return caught.exception
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT run_file;")
            self.cur.execute("RELEASE SAVEPOINT run_file;")

    def blank_rows(self):
        """Two areas and a cell of spaces, as an older database may hold. Neither topic CHECK admits
        an empty name, so spaces are the blank an old row can hold."""
        self.cur.execute("INSERT INTO public.areas (id, name) VALUES"
                         " ('d1d17291-0000-4000-8000-0000000291d1', '   '),"
                         " ('d2d17291-0000-4000-8000-0000000291d2', '  ');")
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES"
                         " ('e1d17291-0000-4000-8000-0000000291e1', ' ');")

    def test_a_replay_with_both_checks_in_place_keeps_every_constraint(self):
        before = self.oids()
        self.assertEqual(len(before), 4)
        self.run_file()
        self.assertEqual(self.oids(), before)

    def test_a_blank_row_stops_the_file_and_every_one_is_named(self):
        self.drop_both()
        self.blank_rows()
        error = self.run_file_refused()
        self.assertIn("0291: 3 area(s) or cell(s) have a blank name", error.diag.message_primary)
        detail = error.diag.message_detail
        self.assertEqual(len(detail.splitlines()), 3, detail)
        for kind, row_id, shown in (("area", "d1d17291-0000-4000-8000-0000000291d1", "'   '"),
                                    ("area", "d2d17291-0000-4000-8000-0000000291d2", "'  '"),
                                    ("cell", "e1d17291-0000-4000-8000-0000000291e1", "' '")):
            self.assertRegex(detail, rf"{kind} {row_id} \(made \d{{4}}-\d\d-\d\d\) holds {re.escape(shown)}")
        hint = error.diag.message_hint
        self.assertIn('help/site/upgrading.md, "From 1.9.0, an area or a cell cannot have a blank name"', hint)

    def test_a_refused_run_adds_no_check_and_renames_nothing(self):
        self.drop_both()
        self.blank_rows()
        self.run_file_refused()
        self.assertEqual(self.oids(NEW_CHECKS), [])
        self.cur.execute("SELECT count(*) FROM public.areas WHERE btrim(name) = '';")
        self.assertEqual(self.cur.fetchone()[0], 2)
        self.cur.execute("SELECT count(*) FROM public.cells WHERE btrim(name) = '';")
        self.assertEqual(self.cur.fetchone()[0], 1)

    def test_only_the_table_without_its_check_is_scanned(self):
        # With the cells' CHECK in place no cell can be blank, so a replay that finds the areas'
        # CHECK missing names areas alone.
        self.cur.execute("ALTER TABLE public.areas DROP CONSTRAINT areas_name_not_blank;")
        self.cur.execute("INSERT INTO public.areas (id, name) VALUES ('d3d17291-0000-4000-8000-0000000291d3', '  ');")
        error = self.run_file_refused()
        self.assertIn("0291: 1 area(s) or cell(s)", error.diag.message_primary)
        self.assertTrue(error.diag.message_detail.startswith("area d3d17291-"), error.diag.message_detail)

    def test_the_file_passes_once_the_rows_are_named_and_the_checks_hold(self):
        self.drop_both()
        self.blank_rows()
        self.cur.execute("UPDATE public.areas SET name = 'Area ' || id WHERE btrim(name) = '';")
        self.cur.execute("UPDATE public.cells SET name = 'Cell ' || id WHERE btrim(name) = '';")
        self.run_file()
        self.assertEqual([name for name, _ in self.oids(NEW_CHECKS)], list(NEW_CHECKS))
        for table, constraint, _, _, _ in TABLES:
            error = self.refused(on(table, "UPDATE {t} SET name = '   ' WHERE true;"))
            self.assertEqual(error.diag.constraint_name, constraint)

    def test_a_cell_holding_a_separator_does_not_stop_the_file(self):
        # cells_name_topic_safe is NOT VALID, so a cell named before it existed may hold a /: the new
        # CHECK is blankness alone, and the file neither stops on such a row nor validates the old one.
        self.drop_both()
        self.cur.execute("ALTER TABLE public.cells DROP CONSTRAINT cells_name_topic_safe;")
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES ('e2d17291-0000-4000-8000-0000000291e2', 'Old/Cell');")
        self.run_file()
        self.cur.execute("SELECT convalidated FROM pg_constraint WHERE conname = 'cells_name_not_blank';")
        self.assertEqual(self.cur.fetchone()[0], True)

    def test_a_different_definition_under_the_name_is_put_back(self):
        # The guard drops a constraint that reads otherwise and adds the right one.
        self.cur.execute("ALTER TABLE public.areas DROP CONSTRAINT areas_name_not_blank;"
                         "ALTER TABLE public.areas ADD CONSTRAINT areas_name_not_blank CHECK (name <> '');")
        self.cur.execute("ALTER TABLE public.cells DROP CONSTRAINT cells_name_not_blank;"
                         "ALTER TABLE public.cells ADD CONSTRAINT cells_name_not_blank CHECK (name <> '') NOT VALID;")
        self.run_file()
        self.cur.execute("SELECT public.live_constraint_definition(conrelid, conname), convalidated FROM pg_constraint"
                         " WHERE conname IN %s ORDER BY conname;", (NEW_CHECKS,))
        self.assertEqual(self.cur.fetchall(), [(WANT, True), (WANT, True)])

    def test_the_hint_names_a_heading_the_upgrade_guide_will_have(self):
        text = MIGRATION.read_text(encoding="utf-8")
        heading = re.search(r'help/site/upgrading\.md, "([^"]+)"', text).group(1)
        self.assertTrue(f"\n### {heading}\n" in upgrade_notes(), f'the upgrade guide has no section "{heading}"')


if __name__ == "__main__":
    unittest.main(verbosity=2)
