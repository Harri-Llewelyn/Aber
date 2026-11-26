# suite:
#   lanes: db
#   why: 0332. An UPDATE that moves a nameplate or an attached schema to another device is refused, for
#     every role. Without it a PATCH by a Shopfloor Manager moved one, and the Audit Trail filed the move
#     under the new device alone. Every writer that Aber has of the two tables still works: the merge from
#     Quarantine, a proposal, a relocation, the schema picker and a publish. A new table whose device_id a
#     person may change fails it until it has the trigger.

"""
A nameplate and an attached schema stay with their device (0332).

    python supabase/migrations/test_a_nameplate_and_an_attachment_stay_with_their_device.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

  * A change of device_id is refused to the person the UPDATE policy admits, to an Administrator, to the
    service-role key and to the owner: check_violation, naming the device. The row stays where it was.
  * Another column of the same row is accepted. So is an UPDATE that sets device_id to its own value, and an
    upsert on it, which is what a whole-row PATCH and a merge-duplicates POST send.
  * A removal and a new row is how a person moves one, and the Audit Trail files it under both devices.
  * The merge from Quarantine, a straight approval, a nameplate proposal, a relocation,
    set_device_schemas() and publish_schema_version() each still write the two tables as they did.
  * The two tables are every table whose device_id a person's session may UPDATE, no function sets one, and
    a second boot changes nothing.

Every test rolls back.
"""
import glob
import json
import os
import re
import unittest
import uuid

import psycopg2
from psycopg2 import errors as pg_errors, sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION = glob.glob(os.path.join(HERE, "0332_*.sql"))[0]

ADMINISTRATOR, MANAGER = "Administrator", "Shopfloor_Manager"
PEOPLE = {
    ADMINISTRATOR: "00000000-0000-4000-8000-00000001a332",
    MANAGER: "00000000-0000-4000-8000-00000001b332",
}
INGESTOR = "b0000000-0000-4000-8000-000000000002"
CALLERS = (MANAGER, ADMINISTRATOR, "service_role", None)

# Table: what its trigger calls the row, and a write of another column.
TABLES = {
    "device_nameplate": ("the nameplate of", "serial_number = 'edited'"),
    "device_submodels": ("a schema attached to", "submodel_key = 'edited'"),
}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, each call as a caller, a rollback."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regprocedure('public.refuse_device_change()');")
            if cur.fetchone()[0] is None:
                raise unittest.SkipTest(f"{os.path.basename(MIGRATION)} has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # Cleanups, not tearDown: they also run when a fixture fails.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.tag = uuid.uuid4().hex[:8]
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"device-0332-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    # -- callers ----------------------------------------------------------------------------

    def _claims(self, claims):
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps(claims) if claims else "",))

    def as_caller(self, caller):
        """Become `caller`, as PostgREST does: role, then claims. None is the owner."""
        self.cur.execute("RESET ROLE;")
        if caller is None:
            self._claims({})
        elif caller == "service_role":
            self.cur.execute("SET LOCAL ROLE service_role;")
            self._claims({"role": "service_role"})
        else:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self._claims({"sub": PEOPLE.get(caller, caller), "role": "authenticated", "aal": "aal2"})

    def run_as(self, caller, statement, args=()):
        """One statement as `caller`: the first column of its row, or its count. What it wrote stays, and a
        refusal leaves everything before it standing."""
        self.cur.execute("SAVEPOINT call;")
        try:
            self.as_caller(caller)
            self.cur.execute(statement, args)
            return self.cur.fetchone()[0] if self.cur.description else self.cur.rowcount
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")
            raise
        finally:
            self.as_caller(None)

    # -- fixtures and reads, as the owner ------------------------------------------------------

    def one(self, statement, args=()):
        self.cur.execute(statement, args)
        row = self.cur.fetchone()
        return row[0] if row else None

    def rows(self, statement, args=()):
        self.cur.execute(statement, args)
        return self.cur.fetchall()

    def device(self, name="Device", **columns):
        columns = {"name": f"{name} {self.tag} {uuid.uuid4().hex[:4]}", **columns}
        return str(self.one(sql.SQL("INSERT INTO public.devices ({}) VALUES ({}) RETURNING id;").format(
            sql.SQL(", ").join(map(sql.Identifier, columns)),
            sql.SQL(", ").join(sql.Placeholder() * len(columns))), tuple(columns.values())))

    def name_of(self, device):
        return self.one("SELECT name FROM public.devices WHERE id = %s;", (device,))

    def schema(self):
        return str(self.one(
            "INSERT INTO public.schemas (schema_name, status, schema_definition)"
            " VALUES (%s, 'active', '{\"type\": \"object\", \"properties\": {}}') RETURNING id;",
            (f"Test_0332_{uuid.uuid4().hex[:8]}",)))

    def nameplate(self, device, serial="S-1"):
        self.cur.execute("INSERT INTO public.device_nameplate (device_id, serial_number) VALUES (%s, %s);",
                         (device, serial))

    def attach(self, device, schema=None):
        return str(self.one("INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s) RETURNING id;",
                            (device, schema or self.schema())))

    def plant(self, table, device):
        if table == "device_nameplate":
            self.nameplate(device)
        else:
            self.attach(device)

    def held(self, device):
        """What the device has: its nameplate's serial number, and its schemas."""
        return (self.one("SELECT serial_number FROM public.device_nameplate WHERE device_id = %s;", (device,)),
                [str(r[0]) for r in self.rows(
                    "SELECT schema_id FROM public.device_submodels WHERE device_id = %s ORDER BY schema_id;", (device,))])

    def trail(self, table, device):
        return [r[0] for r in self.rows(
            "SELECT action FROM public.audit_trail WHERE entity_type = %s AND entity_id = %s ORDER BY id;", (table, device))]


class ADeviceIsNotChanged(Base):

    def test_by_anyone(self):
        for table, (what, _) in TABLES.items():
            for caller in CALLERS:
                with self.subTest(table=table, caller=caller):
                    here, there = self.device("Here"), self.device("There")
                    self.plant(table, here)
                    before = self.held(here), self.held(there), self.trail(table, here), self.trail(table, there)
                    with self.assertRaises(pg_errors.CheckViolation) as raised:
                        self.run_as(caller, sql.SQL("UPDATE public.{} SET device_id = %s WHERE device_id = %s;").format(
                            sql.Identifier(table)), (there, here))
                    self.assertEqual(raised.exception.pgcode, "23514")
                    self.assertEqual(
                        raised.exception.diag.message_primary,
                        f'the device_id of {what} "{self.name_of(here)}" cannot be changed. '
                        "Other records and other systems find it by this id.")
                    self.assertEqual(
                        raised.exception.diag.message_hint,
                        "Leave device_id out of the change, or send the device_id the record has. "
                        "To move it, remove it and make it again on the other device.")
                    self.assertEqual(
                        (self.held(here), self.held(there), self.trail(table, here), self.trail(table, there)), before)

    def test_an_upsert_on_another_key_does_not_bring_its_own_device(self):
        """POST with on_conflict=id and a device_id sets every column it sends, device_id included."""
        here, there, schema = self.device(), self.device(), self.schema()
        attachment = self.attach(here, schema)
        with self.assertRaisesRegex(pg_errors.CheckViolation, "^the device_id of a schema attached to "):
            self.run_as(MANAGER,
                        "INSERT INTO public.device_submodels (id, device_id, schema_id) VALUES (%s, %s, %s)"
                        " ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id, device_id = EXCLUDED.device_id,"
                        " schema_id = EXCLUDED.schema_id;", (attachment, there, schema))

    def test_many_rows_at_once_are_refused_together(self):
        here, there = self.device(), self.device()
        self.attach(here)
        self.attach(here)
        with self.assertRaises(pg_errors.CheckViolation):
            self.run_as(MANAGER, "UPDATE public.device_submodels SET device_id = %s WHERE device_id = %s;", (there, here))
        self.assertEqual((len(self.held(here)[1]), self.held(there)[1]), (2, []))


class EverythingElsePasses(Base):

    def test_another_column(self):
        for table, (_, edit) in TABLES.items():
            for caller in CALLERS:
                with self.subTest(table=table, caller=caller):
                    device = self.device()
                    self.plant(table, device)
                    self.assertEqual(self.run_as(caller, sql.SQL(
                        "UPDATE public.{} SET {} WHERE device_id = %s;").format(
                            sql.Identifier(table), sql.SQL(edit)), (device,)), 1)

    def test_a_device_id_set_to_its_own_value(self):
        """A client that PATCHes the whole row it read sends the device_id back."""
        for table, (_, edit) in TABLES.items():
            with self.subTest(table=table):
                device = self.device()
                self.plant(table, device)
                self.assertEqual(self.run_as(MANAGER, sql.SQL(
                    "UPDATE public.{} SET device_id = %s, {} WHERE device_id = %s;").format(
                        sql.Identifier(table), sql.SQL(edit)), (device, device)), 1)

    def test_an_upsert_on_it(self):
        """The Nameplate dialog's save, which is an upsert on device_id, and an attachment posted again."""
        device, schema = self.device(), self.schema()
        for serial in ("S-1", "S-2"):
            self.assertEqual(self.run_as(
                MANAGER,
                "INSERT INTO public.device_nameplate (device_id, serial_number) VALUES (%s, %s)"
                " ON CONFLICT (device_id) DO UPDATE SET device_id = EXCLUDED.device_id,"
                " serial_number = EXCLUDED.serial_number;", (device, serial)), 1)
            self.assertEqual(self.run_as(
                MANAGER,
                "INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s)"
                " ON CONFLICT (device_id, schema_id) DO UPDATE SET device_id = EXCLUDED.device_id,"
                " schema_id = EXCLUDED.schema_id;", (device, schema)), 1)
        self.assertEqual(self.held(device), ("S-2", [schema]))

    def test_a_removal_and_a_new_row_is_filed_under_both_devices(self):
        for table in TABLES:
            with self.subTest(table=table):
                here, there, schema = self.device("Here"), self.device("There"), self.schema()
                column, value = ("serial_number", "S-1") if table == "device_nameplate" else ("schema_id", schema)
                add = sql.SQL("INSERT INTO public.{} (device_id, {}) VALUES (%s, %s);").format(
                    sql.Identifier(table), sql.Identifier(column))
                self.run_as(MANAGER, add, (here, value))
                self.assertEqual((self.trail(table, here), self.trail(table, there)), (["INSERT"], []))
                self.assertEqual(self.run_as(MANAGER, sql.SQL("DELETE FROM public.{} WHERE device_id = %s;").format(
                    sql.Identifier(table)), (here,)), 1)
                self.run_as(MANAGER, add, (there, value))
                self.assertEqual((self.trail(table, here), self.trail(table, there)), (["INSERT", "DELETE"], ["INSERT"]))


class AberSOwnWritersStillWork(Base):

    def discovered(self):
        """A device nobody registered, as its first birth makes it: the ingestion gate's own row."""
        return str(self.run_as(
            INGESTOR, "SELECT id FROM public.ingest_register_quarantined_device(%s, NULL, %s, 'UNKNOWN_DEVICE: test',"
                      " 'reported_identity');", (f"Discovered {self.tag}", f"wire-{self.tag}")))

    def approve(self, device, into=None):
        return self.one("SELECT public.approve_quarantined_device(p_device_id => %s, p_actor_id => %s,"
                        " p_merge_into_device_id => %s);", (device, PEOPLE[MANAGER], into))

    def test_a_merge_leaves_the_target_s_own_and_drops_the_discovered_device_s(self):
        source, into = self.discovered(), self.device("Candidate")
        kept = self.schema()
        self.nameplate(into, "S-kept")
        self.attach(into, kept)
        self.nameplate(source, "S-discovered")
        self.attach(source)
        # What the merge does move: the birth values, which are found by the wire id and not by device_id.
        self.cur.execute("INSERT INTO public.asset_config (asset_id, metric_name, val_string)"
                         " SELECT sparkplug_id, 'Properties/Serial', 'x' FROM public.devices WHERE id = %s;", (source,))
        answer = self.approve(source, into)
        self.assertTrue(answer["merged"])
        self.assertEqual(self.held(into), ("S-kept", [kept]))
        self.assertEqual(self.held(source), (None, []))
        self.assertIsNone(self.name_of(source))
        self.assertEqual(self.one("SELECT count(*) FROM public.asset_config a JOIN public.devices d"
                                  " ON d.sparkplug_id = a.asset_id WHERE d.id = %s;", (into,)), 1)

    def test_a_merge_into_a_device_that_has_neither(self):
        source, into = self.discovered(), self.device("Candidate")
        self.nameplate(source)
        self.attach(source)
        self.assertTrue(self.approve(source, into)["merged"])
        self.assertEqual(self.held(into), (None, []))

    def test_a_straight_approval_keeps_both(self):
        device, schema = self.discovered(), self.schema()
        self.nameplate(device)
        self.attach(device, schema)
        self.assertFalse(self.approve(device)["merged"])
        self.assertEqual(self.held(device), ("S-1", [schema]))

    def test_a_nameplate_proposal_is_applied_to_a_device_with_and_without_one(self):
        for has_one in (True, False):
            with self.subTest(has_one=has_one):
                device = self.device()
                if has_one:
                    self.nameplate(device, "S-1")
                proposal = self.run_as(
                    MANAGER, "INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
                             " VALUES ('device_nameplate', %s, '{\"serial_number\": \"S-2\"}', 'test') RETURNING id;",
                    (device,))
                applied = self.run_as(ADMINISTRATOR, "SELECT public.approve_proposal(%s);", (proposal,))
                self.assertEqual(applied["status"], "applied")
                self.assertEqual(self.held(device)[0], "S-2")

    def test_a_relocation_an_archive_and_a_restore_leave_both(self):
        device, schema = self.device(), self.schema()
        self.nameplate(device)
        self.attach(device, schema)
        cell = str(self.one("INSERT INTO public.cells (name) VALUES (%s) RETURNING id;", (f"Cell {self.tag}",)))
        self.run_as(MANAGER, "SELECT public.relocate_devices(%s);", (json.dumps(
            [{"device_id": device, "cell_id": cell, "location_scope": "cell"}]),))
        self.assertEqual(str(self.one("SELECT cell_id FROM public.devices WHERE id = %s;", (device,))), cell)
        for archived in (True, False):
            self.assertEqual(self.run_as(MANAGER, "UPDATE public.devices SET is_archived = %s WHERE id = %s;",
                                         (archived, device)), 1)
            self.assertEqual(self.held(device), ("S-1", [schema]))

    def test_the_schema_picker_s_save(self):
        device, first, second = self.device(), self.schema(), self.schema()
        self.attach(device, first)
        answer = self.run_as(MANAGER, "SELECT public.set_device_schemas(%s, %s::uuid[]);", (device, [second]))
        self.assertEqual((answer["attached"], answer["detached"]), (1, 1))
        self.assertEqual(self.held(device)[1], [second])

    def test_a_publish_moves_an_attachment_to_the_new_version_on_the_same_device(self):
        device, parent = self.device(), self.schema()
        attachment = self.attach(device, parent)
        draft = str(self.run_as(ADMINISTRATOR, "SELECT public.fork_schema(%s, 'test');", (parent,))["id"])
        self.run_as(ADMINISTRATOR, "SELECT public.publish_schema_version(%s);", (draft,))
        self.assertEqual(self.rows("SELECT id::text, device_id::text, schema_id::text FROM public.device_submodels"
                                   " WHERE device_id = %s;", (device,)), [(attachment, device, draft)])

    def test_deleting_a_device_deletes_both(self):
        device = self.device(is_archived=True)
        self.nameplate(device)
        self.attach(device)
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (device,))
        self.assertEqual(self.held(device), (None, []))


class EveryDeviceAPersonCouldChangeIsHeld(Base):

    def test_the_tables_with_the_trigger(self):
        rows = {r[0]: r[1:] for r in self.rows(
            "SELECT t.tgrelid::regclass::text, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) FROM pg_trigger t"
            " WHERE t.tgfoid = 'public.refuse_device_change()'::regprocedure AND NOT t.tgisinternal;")}
        rows = {name.removeprefix("public."): row for name, row in rows.items()}
        self.assertEqual(set(rows), set(TABLES))
        for table, (name, enabled, definition) in rows.items():
            with self.subTest(table=table):
                self.assertEqual((name, enabled), (f"trg_{table}_device_cannot_change", "O"))
                self.assertIn(" BEFORE UPDATE OF device_id ON ", definition)
                self.assertTrue(definition.endswith(f"refuse_device_change('{TABLES[table][0]}')"), definition)

    def test_a_device_id_a_person_may_write_has_it(self):
        """A privilege on the column and a policy that admits an UPDATE: what RLS lets a session write."""
        writable = {r[0] for r in self.rows("""
            SELECT c.relname
              FROM pg_class c
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'device_id' AND NOT a.attisdropped
             WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
               AND (has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE')
                    OR has_column_privilege('anon', c.oid, a.attnum, 'UPDATE'))
               AND (NOT c.relrowsecurity
                    OR EXISTS (SELECT 1 FROM pg_policy p
                                WHERE p.polrelid = c.oid AND p.polcmd IN ('w', '*') AND p.polpermissive
                                  AND (0 = ANY (p.polroles)
                                       OR 'authenticated'::regrole = ANY (p.polroles)
                                       OR 'anon'::regrole = ANY (p.polroles))));""")}
        self.assertEqual(writable, set(TABLES),
                         "a person's session may change which device a row is for. Give the table "
                         "refuse_device_change()'s trigger and a line in TABLES, or say here why it needs none")

    def test_no_function_sets_a_device(self):
        """So no role needs to be exempt: none that runs as the owner writes one."""
        # A SET list runs to the first word that ends it, and a device_id in it follows SET or a comma.
        lists = re.compile(r"\bSET\b(.*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|;|$)", re.IGNORECASE | re.DOTALL)
        found = []
        for name, body in self.rows(
                "SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang"
                " WHERE p.pronamespace = 'public'::regnamespace AND l.lanname IN ('plpgsql', 'sql');"):
            for m in lists.finditer(re.sub(r"--[^\n]*", "", body)):
                if re.search(r"(?:^|,)\s*device_id\s*=", m.group(1)):
                    found.append(f"{name}(): SET{' '.join(m.group(1).split())[:120]}")
        self.assertEqual(found, [], "a function sets a device_id, which refuse_device_change() refuses")

    def test_the_function_runs_as_its_caller_and_no_api_role_may_call_it(self):
        self.assertEqual(self.rows(
            "SELECT p.proowner::regrole::text, p.prosecdef, p.proconfig, "
            "       has_function_privilege('anon', p.oid, 'EXECUTE'), "
            "       has_function_privilege('authenticated', p.oid, 'EXECUTE') "
            "  FROM pg_proc p WHERE p.oid = 'public.refuse_device_change()'::regprocedure;"),
            [("postgres", False, ["search_path=public"], False, False)])


class ASecondBootChangesNothing(Base):

    def test_a_replay_over_a_used_database(self):
        device = self.device()
        self.nameplate(device)
        self.attach(device)

        def state():
            return (
                self.rows("SELECT t.tgname, t.oid, t.xmin::text FROM pg_trigger t"
                          " WHERE t.tgfoid = 'public.refuse_device_change()'::regprocedure ORDER BY t.tgname;"),
                self.rows("SELECT ctid::text, xmin::text FROM public.device_nameplate WHERE device_id = %s;", (device,)),
                self.rows("SELECT ctid::text, xmin::text FROM public.device_submodels WHERE device_id = %s;", (device,)),
                self.trail("device_nameplate", device), self.trail("device_submodels", device))

        before = state()
        self.assertEqual(len(before[0]), len(TABLES), "a trigger is missing before the replay")
        self.conn.notices.clear()
        with open(MIGRATION, encoding="utf-8", newline="") as f:
            self.cur.execute(f.read())
        self.assertEqual(state(), before, "the replay re-created a trigger, or wrote a row")
        self.assertEqual(list(self.conn.notices), [], "the replay said it changed something")


if __name__ == "__main__":
    unittest.main(verbosity=2)
