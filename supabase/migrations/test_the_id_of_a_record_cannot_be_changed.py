# suite:
#   lanes: db
#   why: 0325. An UPDATE that changes a row's id is refused, for every role, on the tables whose id a
#     site or another row holds. Without it a PATCH by a Shopfloor Manager moved a device's sparkplug_id
#     off its readings. A write that leaves id as it was passes, and so does an upsert. A new table
#     whose key a person may change fails it until it has the trigger or a reason. Also 0326: a
#     refused cell archive names the drawer action.

"""
The id of a record cannot be changed (0325), and a refused cell archive names the drawer action (0326).

    python supabase/migrations/test_the_id_of_a_record_cannot_be_changed.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

  * Each table's id is refused to the person its UPDATE policy admits, to an Administrator, to the
    service-role key and to the owner: check_violation, naming the kind and the record.
  * A device's and a gateway's sparkplug_id stay as they were.
  * Another column of the same row is accepted from the same person. So is an UPDATE that sets id to its
    own value, and an upsert on id, which is what a whole-row PATCH and a merge-duplicates POST send.
  * The primary-key columns a person's session may write are these tables' ids, the ones KEPT names, each
    with its reason, and the ones another function holds.
  * No function in public sets an id, and a second boot changes nothing.

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
KEYS = glob.glob(os.path.join(HERE, "0325_*.sql"))[0]
HINT = glob.glob(os.path.join(HERE, "0326_*.sql"))[0]

MANAGER = "Shopfloor_Manager"
ADMINISTRATOR = "Administrator"
PEOPLE = {
    ADMINISTRATOR: "00000000-0000-4000-8000-00000001a325",
    MANAGER: "00000000-0000-4000-8000-00000001b325",
}

# Table: the kind in the message, the column that names the record, who its UPDATE policy admits besides
# an Administrator, and a write of another column that person may make. `automations` admits nobody.
TABLES = {
    "areas": ("area", "name", MANAGER, "description = 'edited'"),
    "cells": ("cell", "name", MANAGER, "description = 'edited'"),
    "gateways": ("gateway", "name", MANAGER, "description = 'edited'"),
    "devices": ("device", "name", MANAGER, "description = 'edited'"),
    "schemas": ("schema", "schema_name", ADMINISTRATOR, "description = 'edited'"),
    "metric_catalog": ("metric", "name", ADMINISTRATOR, "description = 'edited'"),
    "metric_groups": ("metric group", "name", ADMINISTRATOR, "description = 'edited'"),
    "links": ("link", "display_name", MANAGER, "link_tag = 'edited'"),
    "directory_services": ("Directory service", "service_name", MANAGER, "endpoint_url = 'http://edited:1'"),
    "change_proposals": ("change proposal", "id", MANAGER, "rationale = 'edited'"),
    "automations": ("automation", "alias", None, "description = 'edited'"),
}

# The other primary-key columns a person's session may write, and why 0325 leaves them.
KEPT = {
    ("asset_config", "id"): "nothing outside the row holds it: a parameter is read by asset_id and metric_name",
    ("device_submodels", "id"): "nothing outside the row holds it: an attachment is read by its device and its schema",
    ("metric_semantic_ids", "metric_id"): "enforce_metric_semantic_id() refuses a change of it",
    ("metric_semantic_ids", "semantic_id"): "enforce_metric_semantic_id() refuses a change of it",
    ("user_settings", "user_id"): "the policy's WITH CHECK keeps it the caller's own",
}

# Held by a trigger of another function: test_a_nameplate_and_an_attachment_stay_with_their_device.py.
HELD_BY_ANOTHER = {("device_nameplate", "device_id"): "refuse_device_change()"}


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
            cur.execute("SELECT to_regprocedure('public.refuse_key_change()');")
            if cur.fetchone()[0] is None:
                raise unittest.SkipTest(f"{os.path.basename(KEYS)} has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # Cleanups, not tearDown: they also run when a fixture fails.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"key-0325-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    # -- fixtures, written as the owner ------------------------------------------------------

    def _one(self, statement, args):
        """The first column of the first row a statement composed by psycopg2.sql returns."""
        self.cur.execute(statement, args)
        return self.cur.fetchone()[0]

    def _row(self, table, **columns):
        """One row of `table` with `columns`, and its id."""
        statement = sql.SQL("INSERT INTO public.{} ({}) VALUES ({}) RETURNING id;").format(
            sql.Identifier(table),
            sql.SQL(", ").join(map(sql.Identifier, columns)),
            sql.SQL(", ").join(sql.Placeholder() * len(columns)),
        )
        return str(self._one(statement, tuple(columns.values())))

    def _plant(self, table):
        """One record of `table` that no foreign key points at: its id."""
        tag = uuid.uuid4().hex[:8]
        if table in ("areas", "cells", "devices"):
            return self._row(table, name=f"Test_0325_{tag}")
        if table == "gateways":
            return self._row(table, name=f"Test_0325_{tag}", deployment="remote")
        if table == "schemas":
            return self._row(table, schema_name=f"Test_0325_{tag}", status="draft",
                             schema_definition=json.dumps({"type": "object", "properties": {}}))
        if table == "metric_catalog":
            return self._row(table, name=f"Test_0325/{tag}", datatype=10)
        if table == "metric_groups":
            return self._row(table, name=f"Test 0325 {tag}")
        if table == "links":
            return self._row(table, entity_type="device", entity_id=str(uuid.uuid4()),
                             display_name=f"Test 0325 {tag}", url="https://test.local/")
        if table == "directory_services":
            return self._row(table, service_name=f"test-0325-{tag}", service_type="test",
                             endpoint_url="http://test:1")
        if table == "change_proposals":
            cell = self._plant("cells")
            # trg_change_proposals_author stamps the author from the claims.
            self._claims({"sub": PEOPLE[MANAGER], "role": "authenticated"})
            try:
                return self._row(table, entity_type="cells", entity_id=cell,
                                 patch=json.dumps({"description": "proposed"}),
                                 proposed_by=PEOPLE[MANAGER])
            finally:
                self._claims({})
        if table == "automations":
            return self._row(table, key=f"test_0325_{tag}", alias=f"Test 0325 {tag}")
        raise AssertionError(f"no fixture for {table}")

    # -- callers ----------------------------------------------------------------------------

    def _claims(self, claims):
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps(claims) if claims else "",))

    def _as(self, caller):
        """Become `caller`, as PostgREST does: role, then claims. None is the owner."""
        if caller is None:
            return
        if caller == "service_role":
            self.cur.execute("SET LOCAL ROLE service_role;")
            self._claims({"role": "service_role"})
        else:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self._claims({"sub": PEOPLE[caller], "role": "authenticated", "aal": "aal2"})

    def _call(self, caller, statement, args=()):
        """One statement as `caller`, in a savepoint, so a refusal leaves the fixture standing."""
        self.cur.execute("SAVEPOINT call;")
        try:
            self._as(caller)
            self.cur.execute(statement, args)
            return self.cur.rowcount
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")

    def _named(self, table, row_id):
        """How the message names the record."""
        return self._one(sql.SQL("SELECT {}::text FROM public.{} WHERE id = %s;").format(
            sql.Identifier(TABLES[table][1]), sql.Identifier(table)), (row_id,))

    def _change_id(self, table):
        return sql.SQL("UPDATE public.{} SET id = %s WHERE id = %s;").format(sql.Identifier(table))

    def _refused(self, caller, table, row_id):
        kind = TABLES[table][0]
        with self.assertRaises(pg_errors.CheckViolation) as raised:
            self._call(caller, self._change_id(table), (str(uuid.uuid4()), row_id))
        self.assertEqual(
            raised.exception.diag.message_primary,
            f'the id of {kind} "{self._named(table, row_id)}" cannot be changed. '
            "Other records and other systems find it by this id.")
        self.assertEqual(raised.exception.diag.message_hint,
                         "Leave id out of the change, or send the id the record has.")


class AnIdIsNotChanged(Base):

    def test_by_the_person_the_table_admits(self):
        for table, (_, _, person, _) in TABLES.items():
            if person is None:
                continue
            with self.subTest(table=table, person=person):
                self._refused(person, table, self._plant(table))

    def test_by_an_administrator(self):
        for table in TABLES:
            # A proposal is its own author's to edit, and no session may write an automation.
            if table in ("change_proposals", "automations"):
                continue
            with self.subTest(table=table):
                self._refused(ADMINISTRATOR, table, self._plant(table))

    def test_by_the_service_role_key(self):
        for table in TABLES:
            if table == "automations":
                continue
            with self.subTest(table=table):
                self._refused("service_role", table, self._plant(table))

    def test_by_the_owner(self):
        for table in TABLES:
            with self.subTest(table=table):
                self._refused(None, table, self._plant(table))

    def test_an_automation_is_not_written_by_a_session_at_all(self):
        automation = self._plant("automations")
        for caller in (ADMINISTRATOR, MANAGER, "service_role"):
            with self.subTest(caller=caller), self.assertRaises(pg_errors.InsufficientPrivilege):
                self._call(caller, self._change_id("automations"), (str(uuid.uuid4()), automation))

    def test_the_published_schema_is_refused_too(self):
        schema = self._row("schemas", schema_name=f"Test_0325_{uuid.uuid4().hex[:8]}", status="active",
                           schema_definition=json.dumps({"type": "object", "properties": {}}))
        for caller in (ADMINISTRATOR, "service_role", None):
            with self.subTest(caller=caller), self.assertRaises(pg_errors.CheckViolation):
                self._call(caller, self._change_id("schemas"), (str(uuid.uuid4()), schema))

    def test_an_upsert_on_another_key_does_not_bring_its_own_id(self):
        """POST with on_conflict=schema_name and an id sets every column it sends, id included."""
        schema = self._plant("schemas")
        name = self._named("schemas", schema)
        with self.assertRaisesRegex(pg_errors.CheckViolation, f'the id of schema "{name}" cannot be changed'):
            self._call(ADMINISTRATOR,
                       "INSERT INTO public.schemas (id, schema_name, schema_definition) "
                       "VALUES (gen_random_uuid(), %s, '{\"type\": \"object\", \"properties\": {}}') "
                       "ON CONFLICT (schema_name) DO UPDATE SET id = EXCLUDED.id, "
                       "schema_definition = EXCLUDED.schema_definition;", (name,))

    def test_the_sparkplug_id_does_not_move(self):
        for table in ("devices", "gateways"):
            with self.subTest(table=table):
                row_id = self._plant(table)
                read = sql.SQL("SELECT sparkplug_id FROM public.{} WHERE id = %s;").format(sql.Identifier(table))
                before = self._one(read, (row_id,))
                self._refused(MANAGER, table, row_id)
                self.assertEqual(self._one(read, (row_id,)), before)


class EverythingElsePasses(Base):

    def test_another_column(self):
        for table, (_, _, person, edit) in TABLES.items():
            with self.subTest(table=table, person=person):
                row_id = self._plant(table)
                statement = sql.SQL("UPDATE public.{} SET {} WHERE id = %s;").format(
                    sql.Identifier(table), sql.SQL(edit))
                self.assertEqual(self._call(person, statement, (row_id,)), 1)

    def test_an_id_set_to_its_own_value(self):
        """A client that PATCHes the whole row it read sends the id back."""
        for table, (_, _, person, edit) in TABLES.items():
            with self.subTest(table=table, person=person):
                row_id = self._plant(table)
                statement = sql.SQL("UPDATE public.{} SET id = %s, {} WHERE id = %s;").format(
                    sql.Identifier(table), sql.SQL(edit))
                self.assertEqual(self._call(person, statement, (row_id, row_id)), 1)

    def test_an_upsert_on_id(self):
        """POST with on_conflict=id and resolution=merge-duplicates, as the stack suites send it."""
        for table in ("gateways", "devices"):
            with self.subTest(table=table):
                row_id = self._plant(table)
                self.assertEqual(self._call(MANAGER, sql.SQL(
                    "INSERT INTO public.{} (id, name) VALUES (%s, %s) "
                    "ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id, name = EXCLUDED.name;").format(
                        sql.Identifier(table)), (row_id, f"Test_0325_{uuid.uuid4().hex[:8]}")), 1)


class EveryKeyAPersonCouldChangeIsHeld(Base):

    def test_the_tables_with_the_trigger(self):
        self.cur.execute(
            "SELECT t.tgrelid::regclass::text, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) "
            "  FROM pg_trigger t "
            " WHERE t.tgfoid = 'public.refuse_key_change()'::regprocedure AND NOT t.tgisinternal;")
        rows = {r[0].removeprefix("public."): r[1:] for r in self.cur.fetchall()}
        self.assertEqual(set(rows), set(TABLES))
        for table, (name, enabled, definition) in rows.items():
            kind, label = TABLES[table][:2]
            with self.subTest(table=table):
                self.assertEqual((name, enabled), (f"trg_{table}_id_cannot_change", "O"))
                self.assertTrue(definition.endswith(f"refuse_key_change('{kind}', '{label}')"), definition)

    def test_a_key_column_a_person_may_write_has_it_or_a_reason(self):
        """A privilege on the column and a policy that admits an UPDATE: what RLS lets a session write."""
        self.cur.execute("""
            SELECT c.relname, a.attname
              FROM pg_class c
              JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
             WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
               AND NOT c.relispartition
               AND (has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE')
                    OR has_column_privilege('anon', c.oid, a.attnum, 'UPDATE'))
               AND (NOT c.relrowsecurity
                    OR EXISTS (SELECT 1 FROM pg_policy p
                                WHERE p.polrelid = c.oid AND p.polcmd IN ('w', '*')
                                  AND p.polpermissive
                                  AND (0 = ANY (p.polroles)
                                       OR 'authenticated'::regrole = ANY (p.polroles)
                                       OR 'anon'::regrole = ANY (p.polroles))))
             ORDER BY 1, 2;""")
        writable = set(self.cur.fetchall())
        held = {(table, "id") for table in TABLES if table != "automations"}
        self.assertEqual(
            writable, held | set(KEPT) | set(HELD_BY_ANOTHER),
            "a person's session may write the key of a table 0325 does not hold, or one it named is no "
            "longer writable. Give the table refuse_key_change()'s trigger and a line in TABLES, or name it "
            "in KEPT with the reason")

    def test_no_function_sets_an_id(self):
        """So no role needs to be exempt: none that runs as the owner writes one."""
        self.cur.execute(
            "SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang "
            "WHERE p.pronamespace = 'public'::regnamespace AND l.lanname IN ('plpgsql', 'sql');")
        # A SET list runs to the first word that ends it, and an id in it follows SET or a comma.
        lists = re.compile(r"\bSET\b(.*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|;|$)", re.IGNORECASE | re.DOTALL)
        found = []
        for name, body in self.cur.fetchall():
            for m in lists.finditer(re.sub(r"--[^\n]*", "", body)):
                if re.search(r"(?:^|,)\s*id\s*=", m.group(1)):
                    found.append(f"{name}(): SET{' '.join(m.group(1).split())[:120]}")
        self.assertEqual(found, [], "a function sets an id, which refuse_key_change() refuses")


class ARefusedCellArchiveNamesTheAction(Base):

    def test_the_hint(self):
        cell = self._plant("cells")
        self._row("devices", name=f"Test_0325_{uuid.uuid4().hex[:8]}", cell_id=cell, location_scope="cell")
        with self.assertRaises(pg_errors.RestrictViolation) as raised:
            self._call(MANAGER, "UPDATE public.cells SET is_archived = true WHERE id = %s;", (cell,))
        self.assertEqual(
            raised.exception.diag.message_hint,
            "View in Devices, in the cell's panel on the Cells page, lists them on the Devices page. An "
            "archived device or gateway is restored, moved and archived again. A quarantined device is "
            "approved into another place, or rejected.")

    def test_the_owner_the_grants_and_the_comment_are_0198s(self):
        self.cur.execute(
            "SELECT p.proowner::regrole::text, p.prosecdef, p.proconfig, "
            "       has_function_privilege('anon', p.oid, 'EXECUTE'), "
            "       has_function_privilege('authenticated', p.oid, 'EXECUTE'), "
            "       obj_description(p.oid, 'pg_proc') "
            "  FROM pg_proc p WHERE p.oid = 'public.refuse_archiving_an_occupied_cell()'::regprocedure;")
        owner, definer, config, anon, signed_in, comment = self.cur.fetchone()
        self.assertEqual((owner, definer, config, anon, signed_in),
                         ("postgres", True, ["search_path=public"], False, False))
        self.assertTrue(comment.startswith("Refuses archiving a cell while any device resolves to it"), comment)


class ASecondBootChangesNothing(Base):

    def _state(self, ids):
        self.cur.execute(
            "SELECT t.tgname, t.oid, t.xmin::text, p.oid FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid "
            "WHERE p.oid IN ('public.refuse_key_change()'::regprocedure, "
            "                'public.refuse_archiving_an_occupied_cell()'::regprocedure) ORDER BY t.tgname;")
        catalog = self.cur.fetchall()
        self.cur.execute(
            "SELECT count(*) FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[]);", (ids,))
        return catalog, self.cur.fetchone()[0]

    def test_a_replay_over_a_used_database(self):
        ids = [self._plant(table) for table in TABLES]
        before = self._state(ids)
        self.assertEqual(len(before[0]), len(TABLES) + 1, "a trigger is missing before the replay")
        self.conn.notices.clear()
        for path in (KEYS, HINT):
            with open(path, encoding="utf-8", newline="") as f:
                self.cur.execute(f.read())
        self.assertEqual(self._state(ids), before, "the replay re-created a trigger, or wrote a row")
        self.assertEqual(list(self.conn.notices), [], "the replay said it changed something")


if __name__ == "__main__":
    unittest.main(verbosity=2)
