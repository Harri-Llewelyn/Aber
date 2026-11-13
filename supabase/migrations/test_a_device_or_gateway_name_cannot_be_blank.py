# suite:
#   lanes: db
#   why: 0284's two CHECKs: an empty name and a name of spaces are refused on an insert and an
#     update of a device and of a gateway, by an Administrator through the API role, by the service
#     role and by an approved proposal, which aborts and leaves the row named. The file is run in
#     the transaction over a database holding blank rows: it names each with its Sparkplug id,
#     renames none, scans only the table whose CHECK is missing, and passes once they are named.
#     Each of those writers reaches the table without the dashboard's dialogs, which is why the
#     CHECK is the rule and the dialogs are not.

"""
A device's name and a gateway's name cannot be blank (0284).

    python supabase/migrations/test_a_device_or_gateway_name_cannot_be_blank.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * devices_name_not_blank and gateways_name_not_blank refuse an empty name and a name of spaces, on
    an INSERT and on an UPDATE, and accept a real name (spaces around it, a number, another script).
    The refusal names the constraint, which the dashboard turns into a sentence.
  * It binds every way in: an Administrator writing through the API's role, the service role, and an
    approved proposal, which aborts the approval and leaves the row named.
  * A database that holds a blank name stops at 0284 with every such row named (table, id, Sparkplug
    id and what the name holds), changes nothing, and passes once the rows are named. Running the
    file again with both CHECKs in place scans nothing and keeps each constraint (same oid).

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

MIGRATION = Path(__file__).with_name("0284_a_device_or_gateway_name_cannot_be_blank.sql")
WANT = "CHECK ((btrim(name) <> ''::text))"

ADMIN_ID = "a0d17284-0000-4000-8000-0000000284a1"
OPERATOR_ID = "a0d17284-0000-4000-8000-0000000284a2"
GATEWAY_ID = "b1d17284-0000-4000-8000-0000000284b1"
DEVICE_ID = "c2d17284-0000-4000-8000-0000000284c1"

TABLES = (
    ("devices", "devices_name_not_blank", DEVICE_ID),
    ("gateways", "gateways_name_not_blank", GATEWAY_ID),
)
BLANKS = ("", " ", "     ", "  ")


def on(table, statement):
    """`statement` with {t} standing for public.<table>, composed rather than formatted."""
    return sql.SQL(statement).format(t=sql.Identifier("public", table))


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class BlankNameBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT count(*) FROM pg_constraint WHERE conname IN"
                         " ('devices_name_not_blank', 'gateways_name_not_blank');")
        if self.cur.fetchone()[0] != 2:
            self.skipTest("0284 is not applied to this database")
        self.cur.execute("SELECT name, id FROM public.roles;")
        roles = dict(self.cur.fetchall())
        for user_id, role in ((ADMIN_ID, "Administrator"), (OPERATOR_ID, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id[-4:]}@blank-name.test"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        self.cur.execute("INSERT INTO public.gateways (id, name, deployment) VALUES (%s, 'Test_0284_Gateway', 'remote');",
                         (GATEWAY_ID,))
        self.cur.execute("INSERT INTO public.devices (id, name, gateway_id) VALUES (%s, 'Test_0284_Device', %s);",
                         (DEVICE_ID, GATEWAY_ID))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- helpers ---------------------------------------------------------------------------------
    def refused(self, sql, args=(), role=None, user=None):
        """Run `sql` and return the CheckViolation it raised, as PostgREST would run it for `user`
        under `role`. The transaction goes on after it."""
        self.cur.execute("SAVEPOINT blank_name;")
        try:
            if role:
                self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            if user:
                claims = {"sub": user, "role": role or "authenticated", "aal": "aal1",
                          "email": f"{user[-4:]}@blank-name.test"}
                self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            with self.assertRaises(psycopg2.errors.CheckViolation) as caught:
                self.cur.execute(sql, args)
            return caught.exception
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT blank_name;")
            self.cur.execute("RESET ROLE;")
            self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
            self.cur.execute("RELEASE SAVEPOINT blank_name;")

    def name_of(self, table, row_id):
        self.cur.execute(on(table, "SELECT name FROM {t} WHERE id = %s;"), (row_id,))
        return self.cur.fetchone()[0]

    def oids(self):
        self.cur.execute("SELECT conname, oid FROM pg_constraint WHERE conname IN"
                         " ('devices_name_not_blank', 'gateways_name_not_blank') ORDER BY conname;")
        return self.cur.fetchall()

    def insert_sql(self, table):
        return ("INSERT INTO public.devices (name, gateway_id) VALUES (%s, %s);" if table == "devices"
                else "INSERT INTO public.gateways (name, deployment) VALUES (%s, 'remote');")

    def insert_args(self, table, name):
        return (name, GATEWAY_ID) if table == "devices" else (name,)


class TestTheTwoChecks(BlankNameBase):
    def test_each_is_declared_as_btrim_of_the_name_not_empty_and_validated(self):
        for table, constraint, _ in TABLES:
            with self.subTest(constraint=constraint):
                self.cur.execute("SELECT public.live_constraint_definition(conrelid, conname), convalidated"
                                 " FROM pg_constraint WHERE conname = %s AND conrelid = %s::regclass;",
                                 (constraint, f"public.{table}"))
                self.assertEqual(self.cur.fetchall(), [(WANT, True)])

    def test_a_blank_name_is_refused_on_an_insert(self):
        for table, constraint, _ in TABLES:
            for name in BLANKS:
                with self.subTest(table=table, name=name):
                    error = self.refused(self.insert_sql(table), self.insert_args(table, name))
                    self.assertEqual(error.diag.constraint_name, constraint)
                    self.assertEqual(error.diag.table_name, table)

    def test_a_blank_name_is_refused_on_an_update_and_the_row_keeps_its_name(self):
        for table, constraint, row_id in TABLES:
            before = self.name_of(table, row_id)
            for name in BLANKS:
                with self.subTest(table=table, name=name):
                    error = self.refused(on(table, "UPDATE {t} SET name = %s WHERE id = %s;"), (name, row_id))
                    self.assertEqual(error.diag.constraint_name, constraint)
                    self.assertEqual(self.name_of(table, row_id), before)

    def test_a_real_name_is_accepted_and_kept_as_given(self):
        # The CHECK refuses nothing but a blank: spaces around a name, a number and another script
        # are a name, and nothing trims it.
        for table, _, row_id in TABLES:
            for name in ("Press 1", " Press 2 ", "7", "Gwasg 3", "Gwasg âêîôû", "A"):
                with self.subTest(table=table, name=name):
                    self.cur.execute(on(table, "UPDATE {t} SET name = %s WHERE id = %s;"), (name, row_id))
                    self.assertEqual(self.name_of(table, row_id), name)
                    self.cur.execute(self.insert_sql(table), self.insert_args(table, name + " (new)"))

    def test_a_row_is_named_when_it_is_made_and_a_device_is_still_made_without_a_gateway(self):
        self.cur.execute("INSERT INTO public.devices (name) VALUES ('Test_0284_Loose') RETURNING id;")
        self.assertIsNotNone(self.cur.fetchone()[0])

    def test_the_name_alone_is_held_so_an_update_of_another_column_is_not_refused(self):
        for table, _, row_id in TABLES:
            with self.subTest(table=table):
                self.cur.execute(on(table, "UPDATE {t} SET description = 'kept' WHERE id = %s;"), (row_id,))
                self.assertEqual(self.cur.rowcount, 1)


class TestEveryWayIn(BlankNameBase):
    def test_an_administrator_through_the_api_role_is_refused(self):
        for table, constraint, row_id in TABLES:
            with self.subTest(table=table):
                error = self.refused(on(table, "UPDATE {t} SET name = '' WHERE id = %s;"), (row_id,),
                                     role="authenticated", user=ADMIN_ID)
                self.assertEqual(error.diag.constraint_name, constraint)
                self.assertEqual(self.name_of(table, row_id), "Test_0284_Device" if table == "devices"
                                 else "Test_0284_Gateway")

    def test_an_administrator_through_the_api_role_may_still_rename(self):
        for table, _, row_id in TABLES:
            with self.subTest(table=table):
                self.cur.execute("SELECT set_config('role', 'authenticated', true);")
                self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                                 (json.dumps({"sub": ADMIN_ID, "role": "authenticated", "aal": "aal1"}),))
                self.cur.execute(on(table, "UPDATE {t} SET name = 'Renamed' WHERE id = %s;"), (row_id,))
                self.assertEqual(self.cur.rowcount, 1)
                self.cur.execute("RESET ROLE;")
                self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
                self.assertEqual(self.name_of(table, row_id), "Renamed")

    def test_the_service_role_is_refused(self):
        # A machine identity that may write and a script run as the service role reach the table
        # without the dashboard's dialog.
        for table, constraint, row_id in TABLES:
            with self.subTest(table=table):
                error = self.refused(on(table, "UPDATE {t} SET name = '  ' WHERE id = %s;"), (row_id,),
                                     role="service_role")
                self.assertEqual(error.diag.constraint_name, constraint)

    def test_an_approved_proposal_with_a_blank_name_aborts_the_approval(self):
        # Approving is applying, so the CHECK runs inside the approver's transaction: the approval
        # fails with the database's sentence, the proposal stays open and the row keeps its name.
        for table, constraint, row_id in TABLES:
            with self.subTest(table=table):
                self.cur.execute("SELECT set_config('role', 'authenticated', true);")
                self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                                 (json.dumps({"sub": OPERATOR_ID, "role": "authenticated", "aal": "aal1",
                                              "email": f"{OPERATOR_ID[-4:]}@blank-name.test"}),))
                self.cur.execute("INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
                                 " VALUES (%s, %s, %s::jsonb, 'the label is worn off') RETURNING id;",
                                 (table, row_id, json.dumps({"name": " "})))
                proposal = self.cur.fetchone()[0]
                self.cur.execute("RESET ROLE;")
                self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
                error = self.refused("SELECT public.approve_proposal(%s);", (proposal,),
                                     role="authenticated", user=ADMIN_ID)
                self.assertEqual(error.diag.constraint_name, constraint)
                self.cur.execute("SELECT status FROM public.change_proposals WHERE id = %s;", (proposal,))
                self.assertEqual(self.cur.fetchone()[0], "open")


class TestTheFile(BlankNameBase):
    """The migration's file, run inside the transaction against the database as 1.8.0 left it."""

    def drop_both(self):
        self.cur.execute("ALTER TABLE public.devices DROP CONSTRAINT devices_name_not_blank;"
                         "ALTER TABLE public.gateways DROP CONSTRAINT gateways_name_not_blank;")

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
        """A device and a gateway of spaces, and a device of nothing, as an older database may hold."""
        self.cur.execute("INSERT INTO public.devices (id, name, gateway_id) VALUES"
                         " ('d1d17284-0000-4000-8000-0000000284d1', '', %s),"
                         " ('d2d17284-0000-4000-8000-0000000284d2', '   ', NULL) RETURNING sparkplug_id;",
                         (GATEWAY_ID,))
        devices = [row[0] for row in self.cur.fetchall()]
        self.cur.execute("INSERT INTO public.gateways (id, name, deployment) VALUES"
                         " ('e1d17284-0000-4000-8000-0000000284e1', ' ', 'remote') RETURNING sparkplug_id;")
        return devices, self.cur.fetchone()[0]

    def test_a_replay_with_both_checks_in_place_keeps_them(self):
        before = self.oids()
        self.run_file()
        self.assertEqual(self.oids(), before)

    def test_a_blank_row_stops_the_file_and_every_one_is_named(self):
        self.drop_both()
        devices, gateway = self.blank_rows()
        error = self.run_file_refused()
        self.assertIn("0284: 3 device(s) or gateway(s) have a blank name", error.diag.message_primary)
        detail = error.diag.message_detail
        self.assertEqual(len(detail.splitlines()), 3, detail)
        for kind, row_id, sparkplug_id, shown in (
                ("device", "d1d17284-0000-4000-8000-0000000284d1", devices[0], "''"),
                ("device", "d2d17284-0000-4000-8000-0000000284d2", devices[1], "'   '"),
                ("gateway", "e1d17284-0000-4000-8000-0000000284e1", gateway, "' '")):
            self.assertIn(f"{kind} {row_id} (Sparkplug id {sparkplug_id}) holds {shown}", detail)
        hint = error.diag.message_hint
        self.assertIn('help/site/upgrading.md, "From 1.9.0, a device or a gateway cannot have a blank name"', hint)

    def test_a_refused_run_adds_no_check_and_renames_nothing(self):
        self.drop_both()
        self.blank_rows()
        self.run_file_refused()
        self.assertEqual(self.oids(), [])
        self.cur.execute("SELECT count(*) FROM public.devices WHERE btrim(name) = '';")
        self.assertEqual(self.cur.fetchone()[0], 2)
        self.cur.execute("SELECT count(*) FROM public.gateways WHERE btrim(name) = '';")
        self.assertEqual(self.cur.fetchone()[0], 1)

    def test_only_the_table_without_its_check_is_scanned(self):
        # With the gateways' CHECK in place no gateway can be blank, so a replay that finds the devices'
        # CHECK missing names devices alone.
        self.cur.execute("ALTER TABLE public.devices DROP CONSTRAINT devices_name_not_blank;")
        self.cur.execute("INSERT INTO public.devices (id, name) VALUES"
                         " ('d3d17284-0000-4000-8000-0000000284d3', '  ');")
        error = self.run_file_refused()
        self.assertIn("0284: 1 device(s) or gateway(s)", error.diag.message_primary)
        self.assertTrue(error.diag.message_detail.startswith("device d3d17284-"), error.diag.message_detail)

    def test_the_file_passes_once_the_rows_are_named_and_the_checks_hold(self):
        self.drop_both()
        self.blank_rows()
        self.cur.execute("UPDATE public.devices SET name = 'Device ' || sparkplug_id WHERE btrim(name) = '';")
        self.cur.execute("UPDATE public.gateways SET name = 'Gateway ' || sparkplug_id WHERE btrim(name) = '';")
        self.run_file()
        self.assertEqual([name for name, _ in self.oids()], ["devices_name_not_blank", "gateways_name_not_blank"])
        for table, constraint, _ in TABLES:
            error = self.refused(on(table, "UPDATE {t} SET name = '' WHERE true;"))
            self.assertEqual(error.diag.constraint_name, constraint)

    def test_a_different_definition_under_the_name_is_put_back(self):
        # The guard drops a constraint that reads otherwise and adds the right one.
        self.cur.execute("ALTER TABLE public.devices DROP CONSTRAINT devices_name_not_blank;"
                         "ALTER TABLE public.devices ADD CONSTRAINT devices_name_not_blank CHECK (name <> '');")
        self.run_file()
        self.cur.execute("SELECT public.live_constraint_definition(conrelid, conname) FROM pg_constraint"
                         " WHERE conname = 'devices_name_not_blank';")
        self.assertEqual(self.cur.fetchone()[0], WANT)

    def test_the_hint_names_a_heading_the_upgrade_guide_has(self):
        text = MIGRATION.read_text(encoding="utf-8")
        heading = re.search(r'help/site/upgrading\.md, "([^"]+)"', text).group(1)
        guide = (Path(__file__).resolve().parents[2] / "help" / "site" / "upgrading.md").read_text(encoding="utf-8")
        self.assertIn(f"\n### {heading}\n", guide)


if __name__ == "__main__":
    unittest.main(verbosity=2)
