# suite:
#   lanes: db
#   why: 0316 -- a document of device schemas names a schema by its lineage: a lineage whose version
#     in force was numbered further (X_v2_2) exports under X, from the id of any of its versions, and
#     a file naming X finds it; a file written before 0316, which named it X_v2_2, still finds it; two
#     names that find one lineage are one schema twice; a lineage's name wins over a version's stem; a
#     new version is still named as fork_schema() names one.

"""
A document of device schemas names a schema by its lineage (0316).

    python supabase/migrations/test_a_document_of_device_schemas_names_a_schema_by_its_lineage.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here, on the lineage the issue names: a first version X, a stray schema already named
X_v2, so the next version is numbered further as X_v2_2, and that version published.

  * The export names it X: device_schemas_document() for every schema, for the id of the version in
    force and for the id of the archived first version.
  * A file naming X finds it: unchanged when it says what the version in force says, and a new draft
    otherwise, named X_v2_2_v3 as fork_schema() names the next version of X_v2_2.
  * A file written before 0316 named it X_v2_2. That file still finds it, unchanged or as a draft.
  * X and X_v2_2 in one file are one schema twice, refused at the second.
  * An export applied back reports the lineage unchanged.
  * A lineage's name wins: where a lineage is named Y and another lineage's first version is named
    Y_v7, a file naming Y finds Y. A name no lineage has still finds lineages by its stem, and is
    refused where that stem is two lineages'.
  * A refusal for a draft names the lineage.

test_a_device_schema_is_applied_from_a_document.py holds the rest of 0295's rules.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest

import psycopg2
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "b1e60316-0000-4000-8000-0000000316a1"
SWITCH = "security.require_mfa_for_managers"

SPINDLE = "Test_0316/Spindle_Load"
MODE = "Test_0316/Mode"
BEARING = "Test_0316/Bearing_Temperature"
NAME = "Test_0316_Robot_Arm"
PUMP = "Test_0316_Pump"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def schema(name=NAME, metrics=(SPINDLE,)):
    return {"name": name, "metrics": [{"name": m} for m in metrics]}


class LineageNamesTheDocument(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT position('lineage_name' IN prosrc) > 0 FROM pg_proc"
                         " WHERE oid = to_regprocedure('public.device_schema_stored_document(uuid)');")
        row = self.cur.fetchone()
        if not row or not row[0]:
            self.skipTest("0316 is not applied to this database")
        self.cur.execute("SELECT id FROM public.roles WHERE name = 'Administrator';")
        role = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, 'admin@lineage-names.test', 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (ADMIN_ID,))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                         " ON CONFLICT (user_id, role_id) DO NOTHING;", (ADMIN_ID, role))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))
        self.cur.execute(
            "INSERT INTO public.metric_catalog (name, datatype, description, permitted_values)"
            " VALUES (%s, 10, 'Spindle load', NULL), (%s, 12, 'Mode', ARRAY['AUTO', 'MANUAL']), (%s, 10, NULL, NULL);",
            (SPINDLE, MODE, BEARING))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- calls, as PostgREST makes them ---------------------------------------------------------

    def as_admin(self, sql, args=()):
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(
            {"sub": ADMIN_ID, "role": "authenticated", "aal": "aal1", "email": "admin@lineage-names.test"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")
        try:
            self.cur.execute(sql, args)
            return self.cur.fetchone()[0]
        finally:
            self.cur.execute("RESET ROLE;")
            self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    def apply(self, document, dry_run=False):
        return self.as_admin("SELECT public.apply_device_schemas(%s::jsonb, %s);", (Json(document), dry_run))

    def document(self, ids=None):
        return self.as_admin("SELECT public.device_schemas_document(%s::uuid[]);", (ids,))

    def publish(self, schema_id):
        return self.as_admin("SELECT public.publish_schema_version(%s::uuid);", (schema_id,))

    @staticmethod
    def reasons(results):
        return [(r["path"], r["message"]) for item in results for r in item["reasons"]]

    def mine(self, document):
        return [d for d in document if d["name"].startswith("Test_0316_")]

    # -- the lineage the issue names ------------------------------------------------------------

    def numbered_further(self):
        """X, then a version numbered X_v2_2 because a stray schema already holds X_v2, published.
        Returns the ids of the first version and of the version in force."""
        first = self.apply([schema()])[0]
        self.assertEqual(first["status"], "new")
        self.cur.execute("INSERT INTO public.schemas (schema_name, schema_definition, status)"
                         " VALUES (%s, '{\"type\": \"object\"}'::jsonb, 'archived');", (f"{NAME}_v2",))
        draft = self.apply([schema(metrics=(SPINDLE, MODE))])[0]
        self.assertEqual((draft["status"], draft["version"], draft["schema_name"]), ("changed", 2, f"{NAME}_v2_2"))
        self.publish(draft["id"])
        self.cur.execute("SELECT status, lineage_name FROM public.schemas WHERE id = %s;", (draft["id"],))
        self.assertEqual(self.cur.fetchone(), ("active", NAME))
        return first["id"], draft["id"]

    def test_a_version_numbered_further_exports_under_its_lineages_name(self):
        first, head = self.numbered_further()
        for ids in (None, [head], [first]):
            with self.subTest(ids=ids):
                docs = self.mine(self.document(ids))
                self.assertEqual([d["name"] for d in docs], [NAME])
                self.assertEqual([m["name"] for m in docs[0]["metrics"]], [MODE, SPINDLE])

    def test_a_file_naming_the_lineage_finds_its_version_in_force(self):
        _, head = self.numbered_further()
        same = self.apply([schema(metrics=(SPINDLE, MODE))], dry_run=True)[0]
        self.assertEqual((same["status"], same["id"], same["version"], same["schema_name"], same["reasons"]),
                         ("unchanged", head, 2, f"{NAME}_v2_2", []))
        changed = self.apply([schema(metrics=(SPINDLE, MODE, BEARING))], dry_run=True)[0]
        self.assertEqual((changed["status"], changed["version"], changed["schema_name"], changed["metrics"]["added"]),
                         ("changed", 3, f"{NAME}_v2_2_v3", [BEARING]))
        # The name fork_schema() gives the next version of the same head.
        forked = self.as_admin("SELECT public.fork_schema(%s::uuid, 'why');", (head,))
        self.assertEqual((forked["schema_name"], forked["version"]), (changed["schema_name"], changed["version"]))

    def test_a_file_written_before_0316_still_finds_it_by_the_versions_name(self):
        _, head = self.numbered_further()
        old = f"{NAME}_v2_2"
        same = self.apply([schema(old, metrics=(SPINDLE, MODE))], dry_run=True)[0]
        self.assertEqual((same["name"], same["status"], same["id"], same["reasons"]), (old, "unchanged", head, []))
        made = self.apply([schema(old, metrics=(MODE,))])[0]
        self.assertEqual((made["status"], made["version"], made["schema_name"]), ("changed", 3, f"{NAME}_v2_2_v3"))
        self.cur.execute("SELECT parent_schema_id, status, lineage_name FROM public.schemas WHERE id = %s;", (made["id"],))
        self.assertEqual(self.cur.fetchone(), (head, "draft", NAME))

    def test_two_names_that_find_one_lineage_are_one_schema_twice(self):
        self.numbered_further()
        results = self.apply([schema(metrics=(SPINDLE, MODE)), schema(f"{NAME}_v2_2", metrics=(SPINDLE, MODE))],
                             dry_run=True)
        self.assertEqual([r["status"] for r in results], ["unchanged", "refused"])
        self.assertEqual(self.reasons(results), [
            ("$[1].name", f"`{NAME}` is already the name of the schema at $[0]. Give each schema its own name.")])

    def test_an_export_applied_back_is_unchanged(self):
        self.numbered_further()
        self.apply([schema("Test_0316_Conveyor", metrics=(BEARING,))])
        results = self.apply(self.mine(self.document()), dry_run=True)
        self.assertEqual([(r["name"], r["status"]) for r in results],
                         [("Test_0316_Conveyor", "unchanged"), (NAME, "unchanged")])
        self.assertEqual(self.reasons(results), [])

    def test_a_draft_is_refused_by_its_lineages_name(self):
        self.numbered_further()
        self.apply([schema(metrics=(MODE,))])
        refused = self.apply([schema(metrics=(BEARING,))], dry_run=True)
        self.assertEqual(refused[0]["status"], "refused")
        self.assertEqual([p for p, _ in self.reasons(refused)], ["$[0]"])
        self.assertTrue(self.reasons(refused)[0][1].startswith(f"`{NAME}` has a draft already."), self.reasons(refused))

    def test_a_lineages_name_wins_over_a_versions_stem(self):
        pump = self.apply([schema(PUMP)])[0]["id"]
        # A first version whose own name ends in a version: a lineage of its own, whose stem is PUMP.
        self.cur.execute("INSERT INTO public.schemas (schema_name, schema_definition)"
                         " VALUES (%s, '{\"type\": \"object\", \"properties\": {}}'::jsonb) RETURNING id;", (f"{PUMP}_v7",))
        other = self.cur.fetchone()[0]
        found = self.apply([schema(PUMP)], dry_run=True)[0]
        self.assertEqual((found["status"], found["id"], found["reasons"]), ("unchanged", pump, []))
        # The other lineage exports under its own name, and that file finds it.
        (doc,) = self.document([other])
        self.assertEqual(doc["name"], f"{PUMP}_v7")
        doc["metrics"] = [{"name": SPINDLE}]
        theirs = self.apply([doc], dry_run=True)[0]
        self.assertEqual((theirs["status"], theirs["id"], theirs["version"]), ("changed", other, 2))
        # A name no lineage has is found by its stem, which here is two lineages'.
        stem = self.apply([schema(f"{PUMP}_v3")], dry_run=True)[0]
        self.assertEqual(stem["status"], "refused")
        self.assertEqual(self.reasons([stem]), [
            ("$[0].name", f"More than one schema here is called `{PUMP}`, so Aber cannot tell which the file means.")])


if __name__ == "__main__":
    unittest.main(verbosity=2)
