# suite:
#   lanes: db
#   why: 0331 -- the Audit Trail's search finds an entity by every further id entity_directory lists for it, in
#     either snapshot, and a metric by an id no row of its own holds; and it still finds everything 0228's
#     body found, for each role. An id the search does not read is a history that reads as nothing happened.

"""
The Audit Trail's search finds every id (0331).

    python supabase/migrations/test_the_audit_trails_search_finds_every_id.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * audit_trail_page()'s p_search finds an entity's rows by each of the further ids entity_directory lists
    for it: a Sparkplug ID, the id a device publishes under, a semantic id, a capture's file, a backup's
    stamp, an automation's key. The ids are read out of the view, so a kind added to it is asked for here.
  * Such an id is found in either snapshot, whatever its case, and by any part of it. `%`, `_` and `#` are
    themselves.
  * A row of metric_semantic_ids is filed under its metric. A further semantic id finds that row, and every
    row of the metric beside it, for each metric that has the id. One that was removed finds the rows that
    hold it.
  * What 0228's body found is found still, for each role, with nothing beside it but rows that hold the term
    in a field 0331 added or that name a metric with it. That body is read out of 0228 and run beside it.
  * Without a search the plan reads neither a snapshot nor metric_semantic_ids.

EVERY TEST ROLLS BACK, and the trail is append-only, so nothing here may be committed.
"""
import json
import os
import unittest
import uuid
from pathlib import Path

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ROLES = {
    "Administrator": "a0d17070-0000-4000-8000-0000000331a1",
    "Shopfloor_Manager": "a0d17070-0000-4000-8000-0000000331a2",
    "Operator": "a0d17070-0000-4000-8000-0000000331a3",
    "Auditor": "a0d17070-0000-4000-8000-0000000331a4",
}
READERS = ("Administrator", "Shopfloor_Manager", "Auditor")

HERE = Path(__file__).resolve().parent
OWNER = HERE / "0228_the_audit_trail_sorts_events_into_classes_in_the_database.sql"
ADDED = ("semantic_id", "reported_identity", "storage_path")
ARGUMENTS = ("text, text[], text[], uuid[], timestamp with time zone, timestamp with time zone, uuid[], uuid[], text,"
             " bigint, uuid[], timestamp with time zone, bigint")


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: one entity of each kind as the owner, reads as a caller, a rollback."""

    def setUp(self):
        self.conn = get_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT position('semantic_id' IN prosrc) > 0 FROM pg_proc"
                         " WHERE oid = to_regprocedure(%s);", (f"public.audit_trail_matching({ARGUMENTS})",))
        if self.cur.fetchone() != (True,):
            self.skipTest("0331 is not applied to this database")
        self.tag = uuid.uuid4().hex[:8]
        for role, user_id in ROLES.items():
            self.cur.execute("INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                             (user_id, f"trail-0331-{user_id[-2:]}@test.local"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) "
                             "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;", (user_id, role))
        self.plant()

    # -- fixtures, as the owner ----------------------------------------------------------------

    def one(self, sql, args=()):
        self.cur.execute(sql, args)
        return self.cur.fetchone()[0]

    def record(self, entity_type, entity_id, action, new=None, old=None):
        """An audit row as its own writer makes it, for the kinds no trigger on their table records."""
        return self.one(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, old_data, new_data, actor_source, recorded_at,"
            " audit_domain) VALUES (%s, %s, %s, %s, %s, 'service', now(), public.audit_domain_for(%s, %s)) RETURNING id;",
            (entity_type, entity_id, action, old and json.dumps(old), new and json.dumps(new), entity_type, action))

    def plant(self):
        t = self.tag
        self.gateway = self.one(
            "INSERT INTO public.gateways (name, deployment) VALUES (%s, 'remote') RETURNING id::text;", (f"Edge {t}",))
        self.device = self.one(
            "INSERT INTO public.devices (name, gateway_id, location_scope, reported_identity) "
            "VALUES (%s, %s, 'gateway', %s) RETURNING id::text;", (f"Lathe {t}", self.gateway, f"plc-{t}"))
        self.schema = self.one(
            "INSERT INTO public.schemas (schema_name, schema_definition, status, semantic_id) "
            "VALUES (%s, '{}', 'draft', %s) RETURNING id::text;", (f"Lathe_Schema_{t}", f"urn:test:schema:{t}"))
        self.metric = self.make_metric("TEMP", f"0112/2///61987#{t}#001")
        self.further = f"https://example.org/100%25/{t}"
        self.add_further(self.metric, self.further)
        path = f"dev{t}/{uuid.uuid4()}.json"
        self.capture = self.one(
            "INSERT INTO public.captures (subject_kind, device_id, subject_sparkplug_id, storage_path, size_bytes, message_count) "
            "SELECT 'device', id, sparkplug_id, %s, 10, 1 FROM public.devices WHERE id = %s RETURNING id::text;", (path, self.device))
        self.record("captures", self.capture, "CAPTURE_RECORDED", {"name": f"Lathe {t}", "storage_path": path, "size_bytes": 10})
        stamp = f"0331{uuid.uuid4().int % 10000:04d}T000000Z"
        self.backup = self.one("INSERT INTO public.backups (stamp, origin, location) "
                               "VALUES (%s, 'scheduled', 'volume://trail') RETURNING id::text;", (stamp,))
        self.record("backups", self.backup, "BACKUP_TAKEN", {"stamp": stamp, "origin": "scheduled"})
        self.automation = self.one("INSERT INTO public.automations (key, alias) VALUES (%s, 'Coolant is low') RETURNING id::text;",
                                   (f"coolant-{t}",))
        self.record("automations", self.automation, "AUTOMATION_CREATED", {"key": f"coolant-{t}", "alias": "Coolant is low"})

    def make_metric(self, name, semantic_id):
        return self.one(
            "INSERT INTO public.metric_catalog (name, datatype, semantic_id, semantic_id_type) "
            "VALUES (%s, 10, %s, 'IRDI') RETURNING id::text;", (f"Trail0331/{name}_{self.tag}", semantic_id))

    def add_further(self, metric, semantic_id):
        self.cur.execute("INSERT INTO public.metric_semantic_ids (metric_id, semantic_id, semantic_id_type) VALUES (%s, %s, 'IRI');",
                         (metric, semantic_id))

    # -- reads ---------------------------------------------------------------------------------

    def read_as(self, role, sql, args=()):
        self.cur.execute("SAVEPOINT trail_read;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": ROLES[role], "role": "authenticated"}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall()
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT trail_read;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT trail_read;")
        return rows

    def search(self, text, role="Administrator"):
        """The events a search answers, deleted entities' with them."""
        rows = self.read_as(role, "SELECT public.audit_trail_page(p_limit => 1000, p_include_purged => true, p_search => %s);", (text,))
        return rows[0][0]["events"]

    def found(self, text, role="Administrator"):
        """What a search finds: each row's kind and entity."""
        return {(e["entity_type"], e["entity_id"]) for e in self.search(text, role)}


class EveryFurtherIdIsFound(Base):
    def test_each_id_the_view_lists_finds_its_entity(self):
        ids = [self.gateway, self.device, self.schema, self.metric, self.capture, self.backup, self.automation]
        rows = self.read_as("Administrator",
                            "SELECT kind, id, second_ids FROM public.entity_directory WHERE id = ANY (%s) ORDER BY kind;", (ids,))
        self.assertEqual(len(rows), len(ids), rows)
        asked = 0
        for kind, entity_id, second_ids in rows:
            self.assertTrue(second_ids, kind)
            for further in second_ids:
                with self.subTest(kind=kind, further=further):
                    self.assertIn((kind, entity_id), self.found(further))
                    asked += 1
        # Two for the device and two for the metric.
        self.assertEqual(asked, 9)

    def test_an_id_is_found_whatever_its_case_and_by_a_part_of_it(self):
        for further, entity in ((f"plc-{self.tag}", ("devices", self.device)),
                                (f"urn:test:schema:{self.tag}", ("schemas", self.schema)),
                                (self.further, ("metric_semantic_ids", self.metric))):
            with self.subTest(further=further):
                self.assertIn(entity, self.found(further.upper()))
                self.assertIn(entity, self.found(f"  {further[3:]} "))

    def test_a_percent_and_an_underscore_are_themselves(self):
        self.assertEqual(self.found(f"https://example.org/%/{self.tag}"), set())
        self.assertEqual(self.found(f"plc_{self.tag}"), set())

    def test_it_is_found_in_either_snapshot(self):
        for field in ADDED:
            for snapshot in ("old", "new"):
                with self.subTest(field=field, snapshot=snapshot):
                    entity_id = str(uuid.uuid4())
                    value = f"{snapshot}/{field}/{self.tag}"
                    self.record("devices", entity_id, "UPDATE", **{snapshot: {field: value}})
                    self.assertEqual(self.found(value), {("devices", entity_id)})

    def test_a_deleted_device_is_found_by_the_id_it_published_under(self):
        self.cur.execute("UPDATE public.devices SET is_archived = true WHERE id = %s;", (self.device,))
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (self.device,))
        events = [e for e in self.search(f"plc-{self.tag}") if e["entity_type"] == "devices"]
        self.assertEqual({e["action"] for e in events}, {"INSERT", "UPDATE", "DELETE"})

    def test_a_changed_semantic_id_is_found_by_the_one_it_had(self):
        self.cur.execute("UPDATE public.metric_catalog SET semantic_id = %s WHERE id = %s;",
                         (f"0112/2///61987#{self.tag}#002", self.metric))
        self.assertIn(("metric_catalog", self.metric), self.found(f"0112/2///61987#{self.tag}#001"))
        self.assertIn(("metric_catalog", self.metric), self.found(f"0112/2///61987#{self.tag}#002"))


class AMetricsFurtherId(Base):
    def test_its_row_is_filed_under_the_metric(self):
        self.cur.execute("SELECT entity_type, entity_id::text, action, new_data ->> 'semantic_id' FROM public.audit_trail"
                         " WHERE entity_type = 'metric_semantic_ids' AND entity_id = %s;", (self.metric,))
        self.assertEqual(self.cur.fetchall(), [("metric_semantic_ids", self.metric, "INSERT", self.further)])

    def test_it_finds_the_metrics_whole_history(self):
        # None of these rows holds the further id.
        self.cur.execute("UPDATE public.metric_catalog SET description = 'Where the spindle runs' WHERE id = %s;", (self.metric,))
        self.add_further(self.metric, f"urn:other:{self.tag}")
        self.assertEqual(self.found(self.further), {("metric_catalog", self.metric), ("metric_semantic_ids", self.metric)})
        self.assertEqual(sorted((e["entity_type"], e["action"]) for e in self.search(self.further)),
                         [("metric_catalog", "INSERT"), ("metric_catalog", "UPDATE"),
                          ("metric_semantic_ids", "INSERT"), ("metric_semantic_ids", "INSERT")])

    def test_one_that_two_metrics_share_finds_both(self):
        other = self.make_metric("PRESSURE", f"0112/2///61987#{self.tag}#009")
        self.add_further(other, self.further)
        self.assertEqual({entity_id for _, entity_id in self.found(self.further)}, {self.metric, other})

    def test_one_that_was_removed_finds_the_rows_that_hold_it(self):
        self.cur.execute("DELETE FROM public.metric_semantic_ids WHERE metric_id = %s AND semantic_id = %s;", (self.metric, self.further))
        self.assertEqual(sorted((e["entity_type"], e["action"]) for e in self.search(self.further)),
                         [("metric_semantic_ids", "DELETE"), ("metric_semantic_ids", "INSERT")])

    def test_its_own_is_still_found_beside_a_further_one(self):
        self.assertIn(("metric_catalog", self.metric), self.found(f"0112/2///61987#{self.tag}#001"))


class WhatTheSearchFound(Base):
    """0228's body answers beside the one this file declares."""

    BEFORE = "audit_trail_matching_of_0228"

    def setUp(self):
        super().setUp()
        text = OWNER.read_text(encoding="utf-8")
        at = text.index("CREATE OR REPLACE FUNCTION public.audit_trail_matching(")
        body = text[at:text.index("$$;", at) + 3].replace("public.audit_trail_matching(", f"public.{self.BEFORE}(")
        self.assertNotIn("semantic_id", body)
        self.cur.execute(body)
        for field in ("name", "sparkplug_id", "schema_name", "label", "key", "role", "stamp", "origin"):
            for snapshot in ("old", "new"):
                self.record("devices", str(uuid.uuid4()), "UPDATE", **{snapshot: {field: f"Before {self.tag} {field}"}})

    def matching(self, name, role, pattern, id_term=None, also=(), types=None):
        """The rows of every class one term selects, with every other argument at no constraint."""
        sql = " UNION ALL ".join(
            f"SELECT m.id, m.entity_id::text, m.entity_type, m.class, m.is_purged FROM public.{name}('{cls}', %(types)s, NULL,"
            " NULL, '-infinity', 'infinity', NULL, '{}', %(pattern)s, %(id_term)s, %(also)s::uuid[], NULL, NULL) m"
            for cls in ("created", "operational", "configuration", "lifecycle", "read"))
        return set(self.read_as(role, sql, {"pattern": pattern, "id_term": id_term, "also": list(also), "types": types}))

    def test_a_term_in_no_field_of_0331_finds_what_it_did(self):
        row_id = self.record("devices", str(uuid.uuid4()), "UPDATE", new={"status": "ONLINE"})
        somebody = self.one("SELECT entity_id::text FROM public.audit_trail WHERE id = %s;", (row_id,))
        answered = 0
        for role in ROLES:
            for term, extra in ((f"before {self.tag}", {}), (f"Edge {self.tag}", {}), (self.device, {}), (self.device[:13], {}),
                                (f"coolant-{self.tag}", {}), ("no such thing at all", {}),
                                ("no such thing at all", {"id_term": row_id}), ("no such thing at all", {"also": [somebody]}),
                                (f"before {self.tag}", {"types": ["devices"]}), (f"before {self.tag}", {"types": []})):
                with self.subTest(role=role, term=term, **extra):
                    before = self.matching(self.BEFORE, role, f"%{term}%", **extra)
                    self.assertEqual(self.matching("audit_trail_matching", role, f"%{term}%", **extra), before)
                    answered += len(before)
        self.assertGreater(answered, 50)

    def test_a_term_in_one_adds_rows_that_hold_it_and_no_other(self):
        for role in ROLES:
            for term in (f"plc-{self.tag}", self.further, f"urn:test:schema:{self.tag}", f"dev{self.tag}/", self.tag):
                with self.subTest(role=role, term=term):
                    before = self.matching(self.BEFORE, role, f"%{term}%")
                    now = self.matching("audit_trail_matching", role, f"%{term}%")
                    self.assertLessEqual(before, now)
                    for row_id, entity_id, entity_type, _, _ in now - before:
                        # `?` is jsonb's, so each field is asked for by name.
                        held = self.one(
                            "SELECT EXISTS (SELECT 1 FROM unnest(%s) f WHERE position(lower(%s) IN lower(concat(t.old_data ->> f, '|', t.new_data ->> f))) > 0)"
                            "  FROM public.audit_trail t WHERE t.id = %s;", (list(ADDED), term, row_id))
                        metric = entity_type in ("metric_catalog", "metric_semantic_ids") and entity_id == self.metric
                        self.assertTrue(held or metric, (row_id, entity_type))
                    if role in READERS:
                        self.assertTrue(now, term)

    def test_each_role_still_reads_its_own_lanes_alone(self):
        self.assertEqual(self.found(f"plc-{self.tag}", "Operator"), set())
        self.assertEqual(self.found(self.further, "Operator"), set())
        for role in READERS:
            with self.subTest(role=role):
                self.assertIn(("devices", self.device), self.found(f"plc-{self.tag}", role))
        # The security lane is not a Shopfloor Manager's.
        secret = str(uuid.uuid4())
        self.record("user_roles", secret, "ROLE_GRANTED", new={"semantic_id": f"urn:security:{self.tag}"})
        self.assertEqual(self.found(f"urn:security:{self.tag}", "Shopfloor_Manager"), set())
        self.assertEqual(self.found(f"urn:security:{self.tag}", "Auditor"), {("user_roles", secret)})


class WithNoSearch(Base):
    def test_the_plan_reads_no_snapshot_and_no_further_id(self):
        self.cur.execute("SET LOCAL enable_seqscan = off;")
        rows = self.read_as("Administrator", (
            "EXPLAIN (COSTS OFF, VERBOSE) SELECT m.id FROM public.audit_trail_matching('lifecycle', NULL, NULL, NULL, '-infinity',"
            " 'infinity', NULL, '{}', NULL, NULL, '{}', NULL, NULL) m;"))
        plan = "\n".join(line for (line,) in rows)
        self.assertIn("Index", plan)
        for word in ("Function Scan", "metric_semantic_ids", "->>"):
            self.assertNotIn(word, plan)

    def test_it_is_inlined_with_a_search_too(self):
        rows = self.read_as("Administrator", (
            "EXPLAIN (COSTS OFF) SELECT m.id FROM public.audit_trail_matching('lifecycle', NULL, NULL, NULL, '-infinity',"
            " 'infinity', NULL, '{}', '%%x%%', NULL, '{}', NULL, NULL) m;"), ())
        plan = "\n".join(line for (line,) in rows)
        self.assertNotIn("Function Scan", plan)
        # The metrics are looked up once for the read, not for each row.
        self.assertIn("hashed SubPlan", plan)


if __name__ == "__main__":
    unittest.main(verbosity=2)
