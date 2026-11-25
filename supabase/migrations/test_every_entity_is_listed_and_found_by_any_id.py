# suite:
#   lanes: db
#   why: 0321 -- entity_directory lists each kind with its ids, its state and what its page opens it by;
#     each role reads through it exactly the rows it may read from the tables beneath, and never a person;
#     and find_entities() finds a row by a whole id of any kind, by the start of one from 8 characters and by
#     a name, a whole id first. A view that ran as its owner, or a reader of people inside it, would show a
#     role what its own policies do not.

"""
Every entity is listed and found by any id (0321).

    python supabase/migrations/test_every_entity_is_listed_and_found_by_any_id.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: `entity_directory` answers a row for each area, cell, gateway, device, schema version,
metric, capture, backup, automation and made machine identity, and for each tombstone, with the ids it goes
by, its state in the archive lifecycle, what sets it apart within its kind, where it is and what its own page
opens it by. A live replay lane is not listed and an archived one is. It runs as its caller: for each of the
four roles and an identity with no role, the rows of each kind are the rows that caller reads from the
table itself. No row is a person. `find_entities()` finds a row by its whole key or any whole further id,
by the start of one from 8 characters, and by any part of a name, whatever the case; it treats `%`, `_` and
`#` as themselves; a whole id comes first; and it answers no more than it is asked for.

EVERY TEST ROLLS BACK. Writes to areas, cells, gateways and devices fire the audit-trail trigger.
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

ROLES = {
    "Administrator": "a0d17070-0000-4000-8000-0000000321a1",
    "Shopfloor_Manager": "a0d17070-0000-4000-8000-0000000321a2",
    "Operator": "a0d17070-0000-4000-8000-0000000321a3",
    "Auditor": "a0d17070-0000-4000-8000-0000000321a4",
}
# A signed-in account that holds no role.
NOBODY = "a0d17070-0000-4000-8000-0000000321a5"

COLUMNS = ["kind", "id", "name", "description", "state", "variant", "second_ids", "area_id", "cell_id",
           "gateway_id", "device_id", "page_id"]

# Each kind's rows in the table they come from, as each caller reads them there.
LIVE_ROWS = {
    "areas": "SELECT id::text AS id FROM public.areas;",
    "cells": "SELECT id::text AS id FROM public.cells;",
    "gateways": "SELECT id::text AS id FROM public.gateways;",
    "devices": "SELECT id::text AS id FROM public.devices WHERE shadow_of IS NULL OR is_archived;",
    "schemas": "SELECT id::text AS id FROM public.schemas;",
    "metric_catalog": "SELECT id::text AS id FROM public.metric_catalog;",
    "captures": "SELECT id::text AS id FROM public.captures;",
    "backups": "SELECT id::text AS id FROM public.backups;",
    "automations": "SELECT id::text AS id FROM public.automations;",
    "service_principals": "SELECT principal_id::text AS id FROM public.machine_principals;",
}

EVERY_ROLE = {"areas", "cells", "gateways", "devices", "schemas", "metric_catalog", "automations"}
# What each role reads beside those, and whether it reads the tombstones.
KINDS_OF = {
    "Administrator": (EVERY_ROLE | {"captures", "backups", "service_principals"}, True),
    "Shopfloor_Manager": (EVERY_ROLE | {"captures"}, True),
    "Operator": (EVERY_ROLE, False),
    "Auditor": (EVERY_ROLE | {"captures", "service_principals"}, True),
}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: one row of each kind as the owner, reads as a caller, a rollback."""

    def setUp(self):
        self.conn = get_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regclass('public.entity_directory');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0321 is not applied to this database")
        self.tag = uuid.uuid4().hex[:8]
        for role, user_id in ROLES.items():
            self.make_person(user_id, role)
        self.make_person(NOBODY, None)
        self.plant()

    # -- fixtures, as the owner ----------------------------------------------------------------

    def make_person(self, user_id, role):
        self.cur.execute(
            "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
            (user_id, f"entities-0321-{user_id[-2:]}@test.local"),
        )
        if role:
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    def one(self, sql, args=()):
        self.cur.execute(sql, args)
        return self.cur.fetchone()[0]

    def plant(self):
        t = self.tag
        self.area = self.one(
            "INSERT INTO public.areas (name, description) VALUES (%s, 'The hall by the yard') RETURNING id::text;",
            (f"Hall {t}",))
        self.cell = self.one(
            "INSERT INTO public.cells (name, area_id) VALUES (%s, %s) RETURNING id::text;", (f"Bay {t}", self.area))
        self.gateway = self.make_gateway(f"Edge {t}", self.cell)
        self.device = self.make_device(f"Lathe {t}", self.gateway, reported=f"plc-{t}")
        self.schema = self.one(
            "INSERT INTO public.schemas (schema_name, schema_definition, status, semantic_id) "
            "VALUES (%s, '{}', 'draft', %s) RETURNING id::text;", (f"Lathe_Schema_{t}", f"urn:test:schema:{t}"))
        self.metric = self.one(
            "INSERT INTO public.metric_catalog (name, datatype, semantic_id, semantic_id_type) "
            "VALUES (%s, 10, %s, 'IRDI') RETURNING id::text;", (f"Entities0321/TEMP_{t}", f"0112/2///61987#{t}#001"))
        self.cur.execute(
            "INSERT INTO public.metric_semantic_ids (metric_id, semantic_id, semantic_id_type) VALUES (%s, %s, 'IRI');",
            (self.metric, f"https://example.org/100%25/{t}"))
        self.capture = self.one(
            "INSERT INTO public.captures (subject_kind, gateway_id, device_id, subject_sparkplug_id, storage_path, "
            "                             size_bytes, message_count, note) "
            "VALUES ('device', %s, %s, %s, %s, 10, 1, 'Before the overhaul') RETURNING id::text;",
            (self.gateway, self.device, self.sparkplug(self.device), f"{self.sparkplug(self.device)}/{uuid.uuid4()}.json"))
        self.job = self.one(
            "INSERT INTO public.backup_jobs (origin, status) VALUES ('scheduled', 'COMPLETED') RETURNING id::text;")
        self.stamp = f"0321{self.one('SELECT lpad((floor(random() * 10000))::int::text, 4, %s);', ('0',))}T000000Z"
        self.backup = self.one(
            "INSERT INTO public.backups (stamp, origin, location, job_id) "
            "VALUES (%s, 'scheduled', 'volume://entities', %s) RETURNING id::text;", (self.stamp, self.job))
        self.automation = self.one(
            "INSERT INTO public.automations (key, alias, description, enabled) "
            "VALUES (%s, 'Coolant is low', 'Tells the cell', false) RETURNING id::text;", (f"coolant-{t}",))
        self.identity = str(uuid.uuid4())
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s);", (self.identity,))
        self.cur.execute(
            "INSERT INTO public.machine_principals (principal_id, name, purpose) VALUES (%s, %s, 'Reads the plant');",
            (self.identity, f"Historian bridge {t}"))
        self.tombstone = self.make_device(f"Old press {t}", self.gateway, reported=f"press-{t}")
        self.cur.execute("UPDATE public.devices SET is_archived = true WHERE id = %s;", (self.tombstone,))
        self.retired_sparkplug = self.sparkplug(self.tombstone)
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (self.tombstone,))

    def make_gateway(self, name, cell_id=None):
        return self.one(
            "INSERT INTO public.gateways (name, cell_id, deployment) VALUES (%s, %s, 'remote') RETURNING id::text;",
            (name, cell_id))

    def make_device(self, name, gateway_id, reported=None, quarantined=False, shadow_of=None):
        return self.one(
            "INSERT INTO public.devices (name, gateway_id, location_scope, reported_identity, is_quarantined, shadow_of) "
            "VALUES (%s, %s, 'gateway', %s, %s, %s) RETURNING id::text;",
            (name, gateway_id, reported, quarantined, shadow_of))

    def sparkplug(self, device_id):
        return self.one("SELECT sparkplug_id FROM public.devices WHERE id = %s;", (device_id,))

    # -- reads ---------------------------------------------------------------------------------

    def select(self, sql, args=(), caller=None):
        self.cur.execute("SAVEPOINT entities_read;")
        try:
            if caller:
                self.cur.execute("SELECT set_config('role', 'authenticated', true);")
                self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                                 (json.dumps({"sub": caller, "role": "authenticated"}),))
            self.cur.execute(sql, args)
            columns = [d.name for d in self.cur.description]
            rows = [dict(zip(columns, r)) for r in self.cur.fetchall()]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT entities_read;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT entities_read;")
        return rows

    def row(self, entity_id, caller=None):
        rows = self.select("SELECT * FROM public.entity_directory WHERE id = %s;", (entity_id,),
                           caller or ROLES["Administrator"])
        self.assertLessEqual(len(rows), 1, rows)
        return rows[0] if rows else None

    def find(self, text, limit=None, role="Administrator"):
        if limit is None:
            return self.select("SELECT * FROM public.find_entities(%s);", (text,), ROLES[role])
        return self.select("SELECT * FROM public.find_entities(%s, %s);", (text, limit), ROLES[role])

    def found(self, text, role="Administrator"):
        return [r["id"] for r in self.find(text, role=role)]


class EachKindIsListed(Base):
    def test_an_area_a_cell_and_a_gateway_say_where_they_are(self):
        area, cell, gateway = self.row(self.area), self.row(self.cell), self.row(self.gateway)
        self.assertEqual((area["kind"], area["state"], area["description"], area["second_ids"]),
                         ("areas", "active", "The hall by the yard", []))
        self.assertEqual((cell["kind"], cell["area_id"]), ("cells", self.area))
        self.assertEqual((gateway["kind"], gateway["area_id"], gateway["cell_id"]), ("gateways", self.area, self.cell))
        self.assertEqual(gateway["second_ids"],
                         [self.one("SELECT sparkplug_id FROM public.gateways WHERE id = %s;", (self.gateway,))])

    def test_a_device_has_its_sparkplug_id_and_the_id_it_reports(self):
        row = self.row(self.device)
        self.assertEqual(row["second_ids"], [self.sparkplug(self.device), f"plc-{self.tag}"])
        self.assertEqual((row["gateway_id"], row["cell_id"], row["area_id"]), (self.gateway, self.cell, self.area))
        self.assertIsNone(row["variant"])
        # One that reports the id it was given has it once, and one that reports nothing has no second.
        same = self.make_device(f"Mill {self.tag}", self.gateway)
        self.assertEqual(self.row(same)["second_ids"], [self.sparkplug(same)])
        self.cur.execute("UPDATE public.devices SET reported_identity = sparkplug_id WHERE id = %s;", (same,))
        self.assertEqual(self.row(same)["second_ids"], [self.sparkplug(same)])

    def test_a_quarantined_device_is_in_service_and_says_so(self):
        held = self.make_device(f"Unknown {self.tag}", self.gateway, quarantined=True)
        row = self.row(held)
        self.assertEqual((row["state"], row["variant"]), ("active", "quarantined"))

    def test_a_schema_version_is_active_whatever_its_status_which_is_its_variant(self):
        row = self.row(self.schema)
        self.assertEqual((row["kind"], row["state"], row["variant"]), ("schemas", "active", "draft"))
        self.assertEqual(row["second_ids"], [f"urn:test:schema:{self.tag}"])
        # Published, then superseded: an archived version is still not a thing the archive holds.
        for status in ("active", "archived"):
            self.cur.execute("UPDATE public.schemas SET status = %s WHERE id = %s;", (status, self.schema))
            row = self.row(self.schema)
            self.assertEqual((row["state"], row["variant"]), ("active", status))

    def test_a_metric_has_every_semantic_id_its_own_first(self):
        row = self.row(self.metric)
        self.assertEqual(row["second_ids"], [f"0112/2///61987#{self.tag}#001", f"https://example.org/100%25/{self.tag}"])
        self.assertIsNone(row["variant"])
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE id = %s;", (self.metric,))
        row = self.row(self.metric)
        self.assertEqual((row["state"], row["variant"]), ("active", "deprecated"))

    def test_a_derived_metric_is_a_metric_and_says_it_is_derived(self):
        derived = self.one(
            "INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s::jsonb) RETURNING id::text;",
            (f"Entities0321/RATE_{self.tag}",
             json.dumps({"kind": "counter_rate", "input": f"Entities0321/TEMP_{self.tag}"})))
        row = self.row(derived)
        self.assertEqual((row["kind"], row["variant"], row["second_ids"]), ("metric_catalog", "derived", []))
        # Deprecated outranks derived: that is the tab its page lists it on.
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE id = %s;", (derived,))
        self.assertEqual(self.row(derived)["variant"], "deprecated")

    def test_a_capture_is_its_subject_s_and_not_found_by_its_subject_s_id(self):
        row = self.row(self.capture)
        self.assertEqual((row["name"], row["variant"], row["description"]),
                         (f"Lathe {self.tag}", "device", "Before the overhaul"))
        self.assertEqual((row["device_id"], row["gateway_id"], row["page_id"]), (self.device, self.gateway, self.device))
        self.assertEqual(len(row["second_ids"]), 1)
        self.assertNotIn(self.sparkplug(self.device), row["second_ids"])
        of_a_gateway = self.one(
            "INSERT INTO public.captures (subject_kind, gateway_id, subject_sparkplug_id, storage_path, size_bytes, message_count) "
            "SELECT 'gateway', id, sparkplug_id, sparkplug_id || '/' || gen_random_uuid() || '.json', 1, 1 "
            "  FROM public.gateways WHERE id = %s RETURNING id::text;", (self.gateway,))
        row = self.row(of_a_gateway)
        self.assertEqual((row["name"], row["variant"], row["page_id"]), (f"Edge {self.tag}", "gateway", self.gateway))

    def test_a_backup_is_opened_by_its_job(self):
        row = self.row(self.backup)
        self.assertEqual((row["name"], row["second_ids"], row["page_id"], row["variant"]),
                         (self.stamp, [self.stamp], self.job, "scheduled"))

    def test_an_automation_is_opened_by_its_key(self):
        row = self.row(self.automation)
        self.assertEqual((row["name"], row["second_ids"], row["page_id"], row["variant"], row["description"]),
                         ("Coolant is low", [f"coolant-{self.tag}"], f"coolant-{self.tag}", "disabled", "Tells the cell"))

    def test_a_machine_identity_says_when_it_is_withdrawn(self):
        row = self.row(self.identity)
        self.assertEqual((row["kind"], row["description"], row["variant"]), ("service_principals", "Reads the plant", None))
        self.cur.execute("INSERT INTO public.revoked_service_principals (principal_id) VALUES (%s);", (self.identity,))
        self.assertEqual(self.row(self.identity)["variant"], "withdrawn")

    def test_an_archived_entity_is_archived_and_a_deleted_one_is_retired(self):
        self.cur.execute("UPDATE public.devices SET is_archived = true WHERE id = %s;", (self.device,))
        self.assertEqual(self.row(self.device)["state"], "archived")
        row = self.row(self.tombstone)
        self.assertEqual((row["kind"], row["state"], row["name"], row["page_id"]),
                         ("devices", "retired", f"Old press {self.tag}", None))
        self.assertEqual(row["second_ids"], [self.retired_sparkplug, f"press-{self.tag}"])

    def test_a_live_replay_lane_is_not_listed_and_an_archived_one_is(self):
        playback = self.one("SELECT (SELECT id::text FROM public.gateways WHERE is_shadow AND NOT is_archived LIMIT 1);")
        if playback is None:
            self.skipTest("no live shadow gateway is seeded")
        lane = self.make_device(f"Lathe replay {self.tag}", playback, shadow_of=self.device)
        self.assertIsNone(self.row(lane))
        self.assertNotIn(lane, self.found(lane))
        self.cur.execute("UPDATE public.devices SET is_archived = true WHERE id = %s;", (self.device,))
        row = self.row(lane)
        self.assertEqual((row["state"], row["variant"]), ("archived", "replay_lane"))
        self.assertEqual(self.row(playback)["variant"], "playback")

    def test_every_id_and_second_id_is_there_and_each_id_is_in_one_row_of_its_kind(self):
        rows = self.select("SELECT * FROM public.entity_directory;", (), ROLES["Administrator"])
        self.assertTrue(rows)
        for row in rows:
            self.assertTrue(row["id"], row)
            self.assertIn(row["state"], ("active", "archived", "retired"), row)
            self.assertNotIn(None, row["second_ids"], row)
        keys = [(r["kind"], r["id"], r["state"]) for r in rows]
        self.assertEqual(len(keys), len(set(keys)))


class EachRoleReadsItsOwnRows(Base):
    def test_the_rows_of_each_kind_are_the_rows_that_caller_reads_from_the_table(self):
        for name, caller in [*ROLES.items(), ("no role", NOBODY)]:
            listed = self.select("SELECT kind, id, state FROM public.entity_directory;", (), caller)
            for kind, rows_of_the_table in LIVE_ROWS.items():
                with self.subTest(caller=name, kind=kind):
                    direct = self.select(rows_of_the_table, (), caller)
                    self.assertEqual({r["id"] for r in listed if r["kind"] == kind and r["state"] != "retired"},
                                     {r["id"] for r in direct})
            with self.subTest(caller=name, kind="retired"):
                direct = self.select("SELECT entity_type, entity_id::text AS id FROM public.retired_entities;", (), caller)
                self.assertEqual({(r["kind"], r["id"]) for r in listed if r["state"] == "retired"},
                                 {(r["entity_type"], r["id"]) for r in direct})

    def test_each_role_reads_the_kinds_it_is_meant_to(self):
        planted = {"areas": self.area, "cells": self.cell, "gateways": self.gateway, "devices": self.device,
                   "schemas": self.schema, "metric_catalog": self.metric, "captures": self.capture,
                   "backups": self.backup, "automations": self.automation, "service_principals": self.identity}
        for role, caller in ROLES.items():
            kinds, tombstones = KINDS_OF[role]
            for kind, entity_id in planted.items():
                with self.subTest(role=role, kind=kind):
                    self.assertEqual(self.row(entity_id, caller) is not None, kind in kinds)
                    self.assertEqual(entity_id in self.found(entity_id, role), kind in kinds)
            with self.subTest(role=role, kind="retired"):
                self.assertEqual(self.row(self.tombstone, caller) is not None, tombstones)
                self.assertEqual(self.tombstone in self.found(self.retired_sparkplug, role), tombstones)

    def test_nobody_is_listed_to_anybody(self):
        # Not a person's id, and not an address: the People page's read is a function of its own.
        for role, caller in ROLES.items():
            with self.subTest(role=role):
                rows = self.select("SELECT * FROM public.entity_directory;", (), caller)
                self.assertFalse({r["id"] for r in rows} & (set(ROLES.values()) | {NOBODY}))
                self.assertFalse({r["kind"] for r in rows} & {"user_roles", "users"})
                self.assertEqual(self.found(ROLES["Operator"], role), [])
                self.assertEqual(self.found("entities-0321-", role), [])

    def test_anon_reads_neither(self):
        for sql in ("SELECT * FROM public.entity_directory LIMIT 1;", "SELECT * FROM public.find_entities('x');"):
            self.cur.execute("SAVEPOINT anon_read;")
            self.cur.execute("SET LOCAL ROLE anon;")
            with self.subTest(sql=sql), self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                self.cur.execute(sql)
            self.cur.execute("ROLLBACK TO SAVEPOINT anon_read;")

    def test_nobody_writes_through_it(self):
        self.cur.execute(
            "SELECT has_table_privilege(r, 'public.entity_directory', 'INSERT, UPDATE, DELETE') "
            "  FROM unnest(ARRAY['authenticated', 'anon', 'service_role']) r;")
        self.assertEqual([r[0] for r in self.cur.fetchall()], [False, False, False])

    def test_the_columns_are_the_ones_the_page_reads(self):
        self.cur.execute("SELECT * FROM public.entity_directory LIMIT 0;")
        self.assertEqual([d.name for d in self.cur.description], COLUMNS)
        self.cur.execute("SELECT * FROM public.find_entities('x') LIMIT 0;")
        self.assertEqual([d.name for d in self.cur.description], COLUMNS)


class AnIdFindsItsRow(Base):
    def test_a_whole_id_of_each_kind_finds_its_row_alone(self):
        for name, text, expected in (
            ("an area's uuid", self.area, self.area),
            ("a cell's uuid", self.cell, self.cell),
            ("a gateway's uuid", self.gateway, self.gateway),
            ("a device's uuid", self.device, self.device),
            ("a schema version's uuid", self.schema, self.schema),
            ("a metric's uuid", self.metric, self.metric),
            ("a capture's uuid", self.capture, self.capture),
            ("a backup's uuid", self.backup, self.backup),
            ("an automation's uuid", self.automation, self.automation),
            ("a machine identity's uuid", self.identity, self.identity),
            ("a deleted device's uuid", self.tombstone, self.tombstone),
            ("a reported identity", f"plc-{self.tag}", self.device),
            ("a schema's semantic id", f"urn:test:schema:{self.tag}", self.schema),
            ("a metric's semantic id", f"0112/2///61987#{self.tag}#001", self.metric),
            ("a metric's further semantic id", f"https://example.org/100%25/{self.tag}", self.metric),
            ("a backup's stamp", self.stamp, self.backup),
            ("an automation's key", f"coolant-{self.tag}", self.automation),
            ("a deleted device's Sparkplug id", self.retired_sparkplug, self.tombstone),
            ("a deleted device's reported identity", f"press-{self.tag}", self.tombstone),
        ):
            with self.subTest(name):
                self.assertEqual(self.found(text), [expected])

    def test_a_sparkplug_id_finds_its_device_first_and_the_files_that_start_with_it_after(self):
        rows = self.find(self.sparkplug(self.device))
        self.assertEqual([r["id"] for r in rows], [self.device, self.capture])

    def test_case_and_the_spaces_round_a_pasted_id_do_not_matter(self):
        self.assertEqual(self.found(f"  {self.device.upper()}\n"), [self.device])
        self.assertEqual(self.found(f"PLC-{self.tag.upper()}"), [self.device])

    def test_the_start_of_an_id_counts_from_eight_characters(self):
        self.assertIn(self.device, self.found(self.device[:8]))
        self.assertNotIn(self.device, self.found(self.device[:7]))
        self.assertIn(self.device, self.found(self.sparkplug(self.device)[:8]))
        self.assertNotIn(self.device, self.found(self.sparkplug(self.device)[:7]))
        self.assertIn(self.metric, self.found(f"0112/2///61987#{self.tag}"))
        # The middle of one does not.
        self.assertNotIn(self.device, self.found(self.device[1:24]))

    def test_any_part_of_a_name_finds_it(self):
        self.assertEqual(set(self.found(f"lathe {self.tag}")), {self.device, self.capture})
        self.assertIn(self.device, self.found(self.tag[:6]))
        self.assertIn(self.tombstone, self.found(f"PRESS {self.tag}"))

    def test_a_percent_an_underscore_and_a_hash_are_themselves(self):
        self.assertIn(self.metric, self.found(f"https://example.org/100%25/{self.tag}"))
        self.assertNotIn(self.metric, self.found(f"https://example.org/%/{self.tag}"))
        self.assertIn(self.metric, self.found(f"TEMP_{self.tag}"))
        self.assertEqual(self.found(f"TEMP%{self.tag}"), [])

    def test_blank_text_finds_nothing(self):
        for text in (None, "", "   ", "\n\t"):
            with self.subTest(text=text):
                self.assertEqual(self.found(text), [])

    def test_a_whole_id_is_first_however_many_names_hold_it(self):
        key = f"zz{self.tag}"
        owner = self.one("INSERT INTO public.automations (key, alias) VALUES (%s, 'Zebra') RETURNING id::text;", (key,))
        for i in range(5):
            self.make_device(f"A {key} {i}", self.gateway)
        rows = self.found(key)
        self.assertEqual((rows[0], len(rows)), (owner, 6))

    def test_it_answers_no_more_than_it_is_asked_for_and_never_more_than_500(self):
        self.cur.execute(
            "INSERT INTO public.devices (name, gateway_id, location_scope) "
            "SELECT %s || i, %s, 'gateway' FROM generate_series(1, 520) i;", (f"Many {self.tag} ", self.gateway))
        text = f"many {self.tag}"
        self.assertEqual(len(self.find(text)), 200)
        self.assertEqual(len(self.find(text, 5)), 5)
        self.assertEqual(len(self.find(text, 0)), 1)
        self.assertEqual(len(self.find(text, 100000)), 500)


if __name__ == "__main__":
    unittest.main(verbosity=2)
