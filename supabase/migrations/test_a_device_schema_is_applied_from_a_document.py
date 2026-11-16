# suite:
#   lanes: db
#   why: 0295 -- who applies a document of device schemas (an Administrator, with the second factor,
#     and no machine identity); apply_device_schemas() (a dry run and a refusal write nothing, new,
#     changed and unchanged are told apart, a changed schema becomes a draft and a published version
#     is never touched, a metric the catalogue lacks or a derived one is refused by name, a range, a
#     semantic id); the definition it writes held to the schema builders' contract fixture; the
#     Audit Trail rows; and the round trip through device_schemas_document().

"""
A device schema is applied from a document (0295).

    python supabase/migrations/test_a_device_schema_is_applied_from_a_document.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * Who applies: an Administrator, who holds schema:manage, as fork_schema() asks. A Shopfloor
    Manager, an Operator, an Auditor and a machine identity that holds schema:manage are refused, and
    so is anon. With security.require_mfa_for_managers on, an Administrator needs a session that gave
    its code. Every signed-in role reads device_schemas_document().
  * apply_device_schemas(): a dry run writes nothing; one refusal writes nothing at all; a new
    schema is version 1 and in force; an unchanged one is reported unchanged and writes nothing; a
    changed one becomes a new DRAFT, named, numbered and linked as fork_schema() does, with the
    document's change description, and the published version is never edited. A lineage with a draft
    refuses a different change, and a second upload of the draft's own content is unchanged. A schema
    is found by its name across its versions. A document never deletes what it leaves out.
  * What a document may say: a metric the catalogue lacks or a derived one is refused by name, a
    deprecated one only where the schema already models it, a range only on a number, a metric's
    semantic id only as the catalogue gives it, a name once in a file.
  * The definition it writes is what the dashboard's builders write: the catalogue rows and ranges of
    test-harness/fixtures/schema-builder-output.json give that fixture's definition. A changed schema
    keeps what a document cannot say (a metric's pattern, a `required` list).
  * The Audit Trail: one INSERT row for each schema written, naming the person, and none for a dry
    run, an unchanged schema or a refusal.
  * device_schemas_document(): the schemas in force in name order, a draft not among them, every
    schema of the lineage an id belongs to; apply_device_schemas() of it reports every schema unchanged.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
from pathlib import Path

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = Path(__file__).resolve().parents[2]
BUILDER_FIXTURE = REPO / "test-harness" / "fixtures" / "schema-builder-output.json"

ADMIN_ID = "a0d17295-0000-4000-8000-0000000295a1"
MANAGER_ID = "a0d17295-0000-4000-8000-0000000295a2"
OPERATOR_ID = "a0d17295-0000-4000-8000-0000000295a3"
AUDITOR_ID = "a0d17295-0000-4000-8000-0000000295a4"
MACHINE_ID = "a0d17295-0000-4000-8000-0000000295a5"
PEOPLE = ((ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"), (OPERATOR_ID, "Operator"),
          (AUDITOR_ID, "Auditor"))
SWITCH = "security.require_mfa_for_managers"

SPINDLE = "Test_0295/Spindle_Load"
SPINDLE_ID = "https://example.test/0295/spindle-load"
BEARING = "Test_0295/Bearing_Temperature"
MODE = "Test_0295/Mode"
DOOR = "Test_0295/Door_Open"
OLD = "Test_0295/Old_Gauge"
PARTS = "Test_0295/Part_Count"
RATE = "Test_0295/Parts_Per_Hour"
NOTHING = "Test_0295/Nothing_Publishes_This"
NAME = "Test_0295_Robot_Arm"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def schema(name=NAME, metrics=None, **over):
    s = {"name": name, "metrics": [{"name": SPINDLE, "minimum": 0, "maximum": 100}] if metrics is None else metrics}
    s.update(over)
    return s


class DeviceSchemasBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.apply_device_schemas(jsonb, boolean)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0295 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, self.email(user_id)))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        # A machine identity that holds schema:manage: has_authority() admits it, so only the function's
        # own refusal of a machine stands between it and a schema.
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, NULL, '', now()) ON CONFLICT (id) DO NOTHING;", (MACHINE_ID,))
        self.cur.execute("INSERT INTO public.principal_permissions (principal_id, permission_id)"
                         " SELECT %s, id FROM public.permissions WHERE name = 'schema:manage';", (MACHINE_ID,))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))

        self.cur.execute(
            "INSERT INTO public.metric_catalog (name, datatype, description, semantic_id, semantic_id_type)"
            " VALUES (%s, 10, 'Spindle load', %s, 'IRI'), (%s, 10, NULL, NULL, NULL);",
            (SPINDLE, SPINDLE_ID, BEARING))
        self.cur.execute(
            "INSERT INTO public.metric_catalog (name, datatype, description, permitted_values)"
            " VALUES (%s, 12, 'Mode', ARRAY['AUTO', 'MANUAL']), (%s, 11, NULL, NULL), (%s, 10, NULL, NULL);",
            (MODE, DOOR, PARTS))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, deprecated) VALUES (%s, 10, true);", (OLD,))
        self.cur.execute(
            "INSERT INTO public.metric_catalog (name, datatype, units, derivation)"
            " VALUES (%s, 10, 'COUNT/HOUR', %s::jsonb);", (RATE, json.dumps({"kind": "counter_rate", "input": PARTS})))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    @staticmethod
    def email(user_id):
        return f"{user_id[-4:]}@device-schemas.test"

    def claims(self, user_id, aal="aal1"):
        self.cur.execute("RESET ROLE;")
        claims = {"sub": user_id, "role": "authenticated", "aal": aal}
        if user_id != MACHINE_ID:
            claims["email"] = self.email(user_id)
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
        self.cur.execute("SET LOCAL ROLE authenticated;")

    def owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    def as_person(self, user_id, sql, args=(), aal="aal1"):
        """Run `sql` as PostgREST would for a person's token. A refusal rolls back to the savepoint,
        so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT schemas_call;")
        try:
            self.claims(user_id, aal)
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT schemas_call;")
            raise
        finally:
            self.owner()
        self.cur.execute("RELEASE SAVEPOINT schemas_call;")
        return rows

    def apply(self, document, dry_run=False, user_id=ADMIN_ID, aal="aal1"):
        return self.as_person(user_id, "SELECT public.apply_device_schemas(%s::jsonb, %s);",
                              (Json(document), dry_run), aal)[0][0]

    def document(self, ids=None, user_id=OPERATOR_ID):
        return self.as_person(user_id, "SELECT public.device_schemas_document(%s::uuid[]);", (ids,))[0][0]

    def rows(self, stem=NAME):
        self.cur.execute(
            "SELECT id::text, schema_name, version, status, parent_schema_id::text, description, semantic_id,"
            "       semantic_id_type, change_description, schema_definition"
            "  FROM public.schemas WHERE schema_name = %s OR schema_name LIKE %s ORDER BY version, schema_name;",
            (stem, f"{stem}\\_v%"))
        return self.cur.fetchall()

    def counts(self):
        self.cur.execute("SELECT (SELECT count(*) FROM public.schemas),"
                         "       (SELECT count(*) FROM public.audit_trail WHERE entity_type = 'schemas');")
        return self.cur.fetchone()

    def audit(self):
        self.cur.execute(
            "SELECT action, entity_id::text, changed_by::text, actor_source, old_data, new_data"
            "  FROM public.audit_trail WHERE entity_type = 'schemas' ORDER BY id;")
        return self.cur.fetchall()

    def publish(self, schema_id):
        return self.as_person(ADMIN_ID, "SELECT public.publish_schema_version(%s::uuid);", (schema_id,))[0][0]

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, str(caught.exception))
        return caught.exception

    @staticmethod
    def reasons(results):
        return [(r["path"], r["message"]) for item in results for r in item["reasons"]]


class Access(DeviceSchemasBase):
    def test_anon_may_execute_neither_function_and_signed_in_roles_both(self):
        for signature in ("apply_device_schemas(jsonb, boolean)", "device_schemas_document(uuid[])"):
            with self.subTest(function=signature):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                                 "       has_function_privilege('authenticated', %s, 'EXECUTE');",
                                 (f"public.{signature}", f"public.{signature}"))
                self.assertEqual(self.cur.fetchone(), (False, True))

    def test_the_helpers_are_no_browsers(self):
        for signature in ("device_schemas_parse(jsonb)", "schema_property_entry(jsonb, integer, text, text[], jsonb, jsonb)",
                          "schema_property_enum(text[], text)", "schema_property_type(integer)",
                          "schema_bound_is_number(jsonb)"):
            with self.subTest(function=signature):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                                 "       has_function_privilege('authenticated', %s, 'EXECUTE');",
                                 (f"public.{signature}", f"public.{signature}"))
                self.assertEqual(self.cur.fetchone(), (False, False))

    def test_only_an_administrator_applies(self):
        before = self.counts()
        for user_id in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, MACHINE_ID):
            for dry_run in (True, False):
                with self.subTest(user=user_id, dry_run=dry_run):
                    self.assertRefused("42501", self.apply, [schema()], dry_run, user_id)
        self.assertEqual(self.counts(), before)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.apply([schema()], user_id=ADMIN_ID)[0]["status"], "new")

    def test_anon_is_refused(self):
        self.cur.execute("SAVEPOINT anon_call;")
        self.cur.execute("SET LOCAL ROLE anon;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.apply_device_schemas('[]'::jsonb, true);")
        self.cur.execute("ROLLBACK TO SAVEPOINT anon_call;")

    def test_with_the_switch_on_an_administrator_needs_a_session_that_gave_its_code(self):
        self.owner()
        self.cur.execute("UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = %s;", (SWITCH,))
        for dry_run in (True, False):
            err = self.assertRefused("42501", self.apply, [schema()], dry_run, ADMIN_ID)
            self.assertEqual(err.diag.message_detail, "mfa_required")
        self.assertEqual(self.apply([schema()], user_id=ADMIN_ID, aal="aal2")[0]["status"], "new")
        # Reading is not a write.
        self.assertEqual(self.document(user_id=OPERATOR_ID)[0]["name"], NAME)

    def test_every_signed_in_role_reads_the_document(self):
        self.apply([schema()])
        for user_id in (ADMIN_ID, MANAGER_ID, OPERATOR_ID, AUDITOR_ID, MACHINE_ID):
            with self.subTest(user=user_id):
                self.assertEqual([s["name"] for s in self.document(user_id=user_id)], [NAME])

    def test_a_missing_dry_run_flag_is_refused(self):
        self.assertRefused("22023", self.as_person, ADMIN_ID, "SELECT public.apply_device_schemas('[]'::jsonb, NULL);")


class Applying(DeviceSchemasBase):
    def test_a_dry_run_writes_nothing_and_says_what_it_would_do(self):
        before = self.counts()
        results = self.apply([schema()], dry_run=True)
        self.assertEqual(self.counts(), before)
        self.assertEqual(self.rows(), [])
        self.assertEqual([(r["name"], r["status"], r["version"], r["schema_name"], r["id"]) for r in results],
                         [(NAME, "new", 1, NAME, None)])

        self.apply([schema()])
        before = self.counts()
        changed = self.apply([schema(metrics=[{"name": SPINDLE, "minimum": 0}, {"name": MODE}])], dry_run=True)
        self.assertEqual(self.counts(), before)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(changed[0]["status"], "changed")
        self.assertEqual((changed[0]["version"], changed[0]["schema_name"]), (2, f"{NAME}_v2"))
        self.assertEqual(changed[0]["metrics"], {"added": [MODE], "removed": [], "changed": [SPINDLE]})
        self.assertEqual(changed[0]["changes"], ["metrics"])

    def test_a_new_schema_is_version_one_and_in_force(self):
        results = self.apply([schema(description="A six-axis arm.", semantic_id="urn:example:arm",
                                     semantic_id_type="IRI")])
        self.assertEqual([(r["status"], r["version"], r["reasons"]) for r in results], [("new", 1, [])])
        (row,) = self.rows()
        sid, name, version, status, parent, description, semantic_id, semantic_type, change, definition = row
        self.assertEqual((name, version, status, parent), (NAME, 1, "active", None))
        self.assertEqual((description, semantic_id, semantic_type), ("A six-axis arm.", "urn:example:arm", "IRI"))
        self.assertEqual(change, "Initial release")
        self.assertEqual(sid, results[0]["id"])
        self.assertEqual(definition, {"type": "object", "properties": {
            SPINDLE: {"type": "number", "description": "Spindle load", "minimum": 0, "maximum": 100}}})

    def test_a_new_schema_keeps_the_change_description_it_is_given(self):
        self.apply([schema(change_description="Moved from the other site")])
        self.assertEqual(self.rows()[0][8], "Moved from the other site")

    def test_an_unchanged_schema_is_reported_so_and_writes_nothing(self):
        doc = [schema(description="A six-axis arm.", semantic_id="urn:example:arm", semantic_id_type="IRI",
                      metrics=[{"name": SPINDLE, "minimum": 0, "maximum": 100}, {"name": MODE}])]
        self.apply(doc)
        before = self.counts()
        again = self.apply(doc)
        self.assertEqual([(r["status"], r["version"], r["changes"]) for r in again], [("unchanged", 1, [])])
        self.assertEqual(self.counts(), before)
        # In another order, with the metrics' semantic id and a different change description: still the same schema.
        reordered = [schema(description="A six-axis arm.", semantic_id="urn:example:arm", semantic_id_type="IRI",
                            change_description="Written again",
                            metrics=[{"name": MODE}, {"name": SPINDLE, "maximum": 100, "minimum": 0,
                                                       "semantic_id": SPINDLE_ID}])]
        self.assertEqual(self.apply(reordered)[0]["status"], "unchanged")
        self.assertEqual(self.counts(), before)

    def test_a_changed_schema_becomes_a_draft_and_the_published_version_is_not_touched(self):
        first = self.apply([schema()])[0]
        (v1,) = self.rows()
        results = self.apply([schema(
            metrics=[{"name": SPINDLE, "minimum": 0, "maximum": 120}, {"name": BEARING, "minimum": -40}],
            description="Now with a temperature", semantic_id="urn:example:arm", semantic_id_type="IRDI",
            change_description="Added the bearing temperature")])
        result = results[0]
        self.assertEqual((result["status"], result["version"], result["schema_name"]), ("changed", 2, f"{NAME}_v2"))
        self.assertEqual(result["changes"], ["description", "metrics", "semantic_id", "semantic_id_type"])
        old, draft = self.rows()
        self.assertEqual(old, v1, "the published version is untouched")
        self.assertEqual(result["id"], draft[0])
        self.assertEqual(draft[1:5], (f"{NAME}_v2", 2, "draft", first["id"]))
        self.assertEqual(draft[5:9], ("Now with a temperature", "urn:example:arm", "IRDI", "Added the bearing temperature"))
        self.assertEqual(draft[9]["properties"][BEARING], {"type": "number", "minimum": -40})
        self.assertEqual(draft[9]["properties"][SPINDLE]["maximum"], 120)

    def test_a_draft_with_no_change_description_has_none(self):
        self.apply([schema()])
        self.apply([schema(metrics=[{"name": SPINDLE}])])
        self.assertIsNone(self.rows()[1][8])

    def test_the_draft_is_named_and_numbered_as_fork_schema_names_one(self):
        first = self.apply([schema()])[0]
        # A lineage the builder's own call versions, beside the one the upload versions.
        self.cur.execute("INSERT INTO public.schemas (schema_name, schema_definition)"
                         " VALUES ('Test_0295_Forked', '{\"type\": \"object\", \"properties\": {}}'::jsonb) RETURNING id;")
        forked = self.cur.fetchone()[0]
        draft = self.as_person(ADMIN_ID, "SELECT public.fork_schema(%s::uuid, 'why');", (forked,))[0][0]
        self.assertEqual((draft["schema_name"], draft["version"], draft["status"], draft["parent_schema_id"]),
                         ("Test_0295_Forked_v2", 2, "draft", forked))
        uploaded = self.apply([schema(metrics=[{"name": MODE}])])[0]
        row = [r for r in self.rows() if r[0] == uploaded["id"]][0]
        self.assertEqual((row[1], row[2], row[3], row[4]), ("Test_0295_Robot_Arm_v2", 2, "draft", first["id"]))

    def test_a_taken_name_is_skipped_as_fork_schema_skips_it(self):
        self.apply([schema()])
        self.owner()
        self.cur.execute("INSERT INTO public.schemas (schema_name, schema_definition, status)"
                         " VALUES (%s, '{\"type\": \"object\"}'::jsonb, 'archived');", (f"{NAME}_v2",))
        result = self.apply([schema(metrics=[{"name": MODE}])])[0]
        self.assertEqual((result["version"], result["schema_name"]), (2, f"{NAME}_v2_2"))

    def test_a_lineage_with_a_draft_refuses_a_different_change_and_accepts_the_drafts_own(self):
        self.apply([schema()])
        draft_doc = [schema(metrics=[{"name": SPINDLE}, {"name": MODE}])]
        made = self.apply(draft_doc)[0]
        before = self.counts()
        # The same file again: it is what the draft already says.
        again = self.apply(draft_doc)[0]
        self.assertEqual((again["status"], again["id"], again["version"], again["schema_name"]),
                         ("unchanged", made["id"], 2, f"{NAME}_v2"))
        # Another change is refused by the schema's name until the draft is published or discarded.
        other = self.apply([schema(metrics=[{"name": BEARING}])])
        self.assertEqual(other[0]["status"], "refused")
        self.assertEqual([p for p, _ in self.reasons(other)], ["$[0]"])
        self.assertIn(NAME, self.reasons(other)[0][1])
        self.assertEqual(self.counts(), before)
        # What the file says is what the published version says: nothing to do, a draft or no.
        self.assertEqual(self.apply([schema()])[0]["status"], "unchanged")

    def test_a_schema_is_found_by_its_name_across_its_versions(self):
        self.apply([schema()])
        v2_doc = [schema(metrics=[{"name": SPINDLE}, {"name": MODE}])]
        draft = self.apply(v2_doc)[0]
        self.publish(draft["id"])
        self.cur.execute("SELECT schema_name, version, status FROM public.schemas WHERE schema_name LIKE %s ORDER BY version;",
                         (f"{NAME}%",))
        self.assertEqual(self.cur.fetchall(), [(NAME, 1, "archived"), (f"{NAME}_v2", 2, "active")])
        # The name without the version, and the one a document exported at version 2 might carry.
        for name in (NAME, f"{NAME}_v2"):
            with self.subTest(name=name):
                result = self.apply([schema(name, metrics=[{"name": SPINDLE}, {"name": MODE}])])[0]
                self.assertEqual((result["status"], result["version"], result["schema_name"]),
                                 ("unchanged", 2, f"{NAME}_v2"))
        third = self.apply([schema(NAME, metrics=[{"name": MODE}])])[0]
        self.assertEqual((third["status"], third["version"], third["schema_name"]), ("changed", 3, f"{NAME}_v3"))

    def test_a_changed_schema_keeps_what_a_document_cannot_say(self):
        self.apply([schema(metrics=[{"name": SPINDLE, "minimum": 0}, {"name": MODE}, {"name": DOOR}])])
        self.owner()
        # What a person's own edit may have given the stored definition: a pattern, `required`, a closed set.
        self.cur.execute(
            "UPDATE public.schemas SET schema_definition = jsonb_set(jsonb_set(jsonb_set(schema_definition,"
            " '{required}', jsonb_build_array(%s, %s)), '{additionalProperties}', 'false'::jsonb),"
            " ARRAY['properties', %s, 'pattern'], '\"^[A-Z]+$\"'::jsonb) WHERE schema_name = %s;",
            (MODE, DOOR, MODE, NAME))
        result = self.apply([schema(metrics=[{"name": MODE}, {"name": BEARING}])])[0]
        self.assertEqual(result["status"], "changed")
        definition = self.rows()[1][9]
        self.assertEqual(definition["additionalProperties"], False)
        self.assertEqual(definition["required"], [MODE], "a metric the document drops leaves `required` too")
        self.assertEqual(definition["properties"][MODE]["pattern"], "^[A-Z]+$")
        self.assertEqual(definition["properties"][MODE]["enum"], ["AUTO", "MANUAL"])
        self.assertEqual(sorted(definition["properties"]), sorted([MODE, BEARING]))

    def test_a_removed_range_is_removed_and_a_range_is_changed(self):
        self.apply([schema(metrics=[{"name": SPINDLE, "minimum": 0, "maximum": 100}])])
        self.apply([schema(metrics=[{"name": SPINDLE, "maximum": 80}])])
        entry = self.rows()[1][9]["properties"][SPINDLE]
        self.assertEqual((entry.get("minimum"), entry.get("maximum")), (None, 80))

    def test_one_refusal_writes_nothing_at_all(self):
        before = self.counts()
        results = self.apply([schema(), schema("Test_0295_Other", metrics=[{"name": NOTHING}])])
        self.assertEqual([r["status"] for r in results], ["new", "refused"])
        self.assertEqual(self.counts(), before)
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.rows("Test_0295_Other"), [])

    def test_a_document_never_deletes(self):
        self.apply([schema(), schema("Test_0295_Other")])
        before = self.counts()
        self.apply([schema()])
        self.assertEqual(self.counts(), before)
        self.assertEqual(len(self.rows("Test_0295_Other")), 1)
        self.assertEqual(self.apply([]), [])
        self.assertEqual(self.counts(), before)

    def test_an_empty_file_applies_nothing(self):
        self.assertEqual(self.apply([]), [])
        self.assertEqual(self.apply([], dry_run=True), [])

    def test_a_file_is_bounded(self):
        results = self.apply([schema(f"Test_0295_Bulk_{i}") for i in range(201)], dry_run=True)
        self.assertEqual([r["status"] for r in results], ["refused"])
        self.assertEqual(self.reasons(results)[0][0], "$")
        many = schema(metrics=[{"name": f"Test_0295/Bulk_{i}"} for i in range(1001)])
        refused = self.apply([many], dry_run=True)
        self.assertEqual(self.reasons(refused)[0][0], "$[0].metrics")

    def test_a_document_that_is_not_a_list_is_refused_at_its_root(self):
        results = self.apply({"name": NAME}, dry_run=True)
        self.assertEqual([(r["status"], r["name"]) for r in results], [("refused", None)])
        self.assertEqual(self.reasons(results)[0][0], "$")


class WhatADocumentMaySay(DeviceSchemasBase):
    def refusal(self, document, path, fragment=None):
        results = self.apply(document, dry_run=True)
        found = {p: m for p, m in self.reasons(results)}
        self.assertIn(path, found, f"{found}")
        if fragment is not None:
            self.assertIn(fragment, found[path])
        self.assertIn("refused", [r["status"] for r in results])
        return found[path]

    def test_a_metric_the_catalogue_lacks_is_refused_by_name(self):
        self.refusal([schema(metrics=[{"name": NOTHING}])], "$[0].metrics[0].name", NOTHING)

    def test_a_derived_metric_is_refused_by_name(self):
        message = self.refusal([schema(metrics=[{"name": SPINDLE}, {"name": RATE}])], "$[0].metrics[1].name", RATE)
        self.assertIn("derived", message)

    def test_a_deprecated_metric_is_refused_unless_the_schema_already_models_it(self):
        self.refusal([schema(metrics=[{"name": OLD}])], "$[0].metrics[0].name", OLD)
        # The schema models it already: the builder can no longer add it, and the file keeps it.
        self.owner()
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = false WHERE name = %s;", (OLD,))
        self.apply([schema(metrics=[{"name": SPINDLE}, {"name": OLD}])])
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE name = %s;", (OLD,))
        results = self.apply([schema(metrics=[{"name": SPINDLE}, {"name": OLD}])])
        self.assertEqual(results[0]["status"], "unchanged")
        # And a draft of it keeps it too.
        again = self.apply([schema(metrics=[{"name": OLD}, {"name": MODE}])])
        self.assertEqual(again[0]["status"], "changed")

    def test_a_metric_twice_is_refused_at_its_second_place(self):
        self.refusal([schema(metrics=[{"name": SPINDLE}, {"name": SPINDLE}])], "$[0].metrics[1].name")

    def test_a_range_is_for_a_number(self):
        self.refusal([schema(metrics=[{"name": MODE, "minimum": 0}])], "$[0].metrics[0].minimum", MODE)
        self.refusal([schema(metrics=[{"name": DOOR, "maximum": 1}])], "$[0].metrics[0].maximum", DOOR)

    def test_a_range_is_a_number_with_no_unit_and_does_not_run_backwards(self):
        self.refusal([schema(metrics=[{"name": SPINDLE, "minimum": "-40 C"}])], "$[0].metrics[0].minimum")
        self.refusal([schema(metrics=[{"name": SPINDLE, "maximum": True}])], "$[0].metrics[0].maximum")
        self.refusal([schema(metrics=[{"name": SPINDLE, "minimum": 10 ** 400}])], "$[0].metrics[0].minimum")
        self.refusal([schema(metrics=[{"name": SPINDLE, "minimum": 10, "maximum": 5}])], "$[0].metrics[0].minimum")
        self.assertEqual(self.apply([schema(metrics=[{"name": SPINDLE, "minimum": 5, "maximum": 5}])],
                                    dry_run=True)[0]["status"], "new")

    def test_a_metrics_semantic_id_is_the_catalogues_and_never_written_to_it(self):
        self.refusal([schema(metrics=[{"name": SPINDLE, "semantic_id": "https://example.test/other"}])],
                     "$[0].metrics[0].semantic_id", SPINDLE_ID)
        self.refusal([schema(metrics=[{"name": BEARING, "semantic_id": "https://example.test/other"}])],
                     "$[0].metrics[0].semantic_id", "none")
        self.assertEqual(self.apply([schema(metrics=[{"name": SPINDLE, "semantic_id": SPINDLE_ID}])])[0]["status"], "new")
        self.cur.execute("SELECT semantic_id FROM public.metric_catalog WHERE name = %s;", (SPINDLE,))
        self.assertEqual(self.cur.fetchone(), (SPINDLE_ID,))

    def test_a_name_is_once_in_a_file_with_or_without_its_version(self):
        self.refusal([schema(), schema()], "$[1].name")
        self.refusal([schema(), schema(f"{NAME}_v2")], "$[1].name")

    def test_a_new_name_does_not_end_in_a_version(self):
        self.refusal([schema(f"{NAME}_v3")], "$[0].name", NAME)
        self.refusal([schema("_v2")], "$[0].name")

    def test_a_semantic_id_type_needs_an_id(self):
        self.refusal([schema(semantic_id_type="IRI")], "$[0].semantic_id_type")
        self.refusal([schema(semantic_id="urn:x", semantic_id_type="URL")], "$[0].semantic_id_type")

    def test_a_key_the_vocabulary_does_not_have_is_refused_never_ignored(self):
        self.refusal([schema(mode="single")], "$[0].mode")
        self.refusal([schema(metrics=[{"name": SPINDLE, "unit": "mm"}])], "$[0].metrics[0].unit")

    def test_every_reason_is_a_sentence_and_every_path_a_json_path(self):
        results = self.apply([{"colour": "red"}, schema(metrics=[{"name": NOTHING, "minimum": "x"}, {}])], dry_run=True)
        reasons = self.reasons(results)
        self.assertGreaterEqual(len(reasons), 4)
        for path, message in reasons:
            with self.subTest(path=path):
                self.assertRegex(path, r"^\$(\[\d+\])?(\.\w+(\[\d+\])?)*$")
                self.assertGreater(len(message), 20)
                self.assertLessEqual(len(message.split()), 45, message)


class TheDefinition(DeviceSchemasBase):
    """The builders' contract fixture, through the database: the catalogue rows and ranges give its definition."""

    def test_the_catalogue_and_the_ranges_give_the_builders_definition(self):
        fixture = json.loads(BUILDER_FIXTURE.read_text(encoding="utf-8"))
        prefix = "T0295/"
        for row in fixture["catalog"]:
            self.cur.execute(
                "INSERT INTO public.metric_catalog (name, datatype, description, permitted_values)"
                " VALUES (%s, %s, %s, %s);",
                (prefix + row["name"], row["datatype"], row["description"], row["permitted_values"]))
        metrics = []
        for row in fixture["catalog"]:
            metric = {"name": prefix + row["name"]}
            for key, value in fixture["ranges"].get(row["name"], {}).items():
                if value != "":
                    metric[key] = float(value) if "." in value else int(value)
            metrics.append(metric)
        self.apply([schema("Test_0295_Contract", metrics=metrics)])
        (row,) = self.rows("Test_0295_Contract")
        expected = {"type": "object", "properties": {
            prefix + name: entry for name, entry in fixture["schema_definition"]["properties"].items()}}
        self.assertEqual(row[9], expected)

    def test_a_number_property_takes_a_catalogue_description_and_permitted_values_as_numbers(self):
        self.owner()
        self.cur.execute("UPDATE public.metric_catalog SET permitted_values = ARRAY['2', '2.0', ' 3 ', 'x', '+1', '.5', '1e3']"
                         " WHERE name = %s;", (BEARING,))
        self.apply([schema(metrics=[{"name": BEARING}])])
        entry = self.rows()[0][9]["properties"][BEARING]
        self.assertEqual(entry, {"type": "number", "enum": [2, 3, 1, 0.5, 1000]})


class AuditTrail(DeviceSchemasBase):
    def test_one_row_for_each_schema_written_naming_the_person(self):
        before = len(self.audit())
        self.apply([schema(), schema("Test_0295_Other")])
        rows = self.audit()[before:]
        self.assertEqual([r[0] for r in rows], ["INSERT", "INSERT"])
        self.assertEqual({r[2] for r in rows}, {ADMIN_ID})
        self.assertEqual({r[3] for r in rows}, {"user"})
        self.assertEqual({r[5]["schema_name"] for r in rows}, {NAME, "Test_0295_Other"})
        self.assertTrue(all(r[4] is None for r in rows))

    def test_a_changed_schema_writes_the_drafts_one_row_and_leaves_the_published_one_alone(self):
        self.apply([schema()])
        before = len(self.audit())
        draft = self.apply([schema(metrics=[{"name": MODE}])])[0]
        rows = self.audit()[before:]
        self.assertEqual([(r[0], r[1]) for r in rows], [("INSERT", draft["id"])])
        self.assertEqual(rows[0][5]["status"], "draft")
        self.assertEqual(rows[0][5]["schema_name"], f"{NAME}_v2")

    def test_a_dry_run_an_unchanged_schema_and_a_refusal_write_none(self):
        self.apply([schema()])
        before = len(self.audit())
        self.apply([schema(metrics=[{"name": MODE}])], dry_run=True)
        self.apply([schema()])
        self.apply([schema(metrics=[{"name": NOTHING}])])
        self.assertEqual(len(self.audit()), before)


class ReadingThemBack(DeviceSchemasBase):
    def test_the_schemas_in_force_in_name_order_and_no_draft(self):
        self.apply([schema("Test_0295_B_Conveyor"), schema("Test_0295_A_Arm")])
        self.apply([schema("Test_0295_A_Arm", metrics=[{"name": MODE}])])
        docs = [d for d in self.document() if d["name"].startswith("Test_0295_")]
        self.assertEqual([d["name"] for d in docs], ["Test_0295_A_Arm", "Test_0295_B_Conveyor"])
        # The arm's draft is not there: what is exported is what is in force.
        self.assertEqual([m["name"] for m in docs[0]["metrics"]], [SPINDLE])

    def test_a_document_has_what_a_file_says_and_leaves_out_what_is_empty(self):
        self.apply([schema(description="  A six-axis arm.  ", semantic_id="urn:example:arm", semantic_id_type="IRI",
                           metrics=[{"name": SPINDLE, "minimum": 0}, {"name": BEARING}, {"name": MODE}])])
        (doc,) = [d for d in self.document() if d["name"] == NAME]
        self.assertEqual(doc, {
            "name": NAME, "description": "A six-axis arm.", "semantic_id": "urn:example:arm", "semantic_id_type": "IRI",
            "metrics": [{"name": BEARING}, {"name": MODE}, {"name": SPINDLE, "minimum": 0, "semantic_id": SPINDLE_ID}]})

    def test_the_ids_asked_for_pick_their_lineages_whatever_the_version(self):
        first = self.apply([schema(), schema("Test_0295_Other")])
        draft = self.apply([schema(metrics=[{"name": MODE}])])[0]
        self.publish(draft["id"])
        archived_id = first[0]["id"]
        self.assertEqual([d["name"] for d in self.document([archived_id])], [NAME])
        self.assertEqual([m["name"] for m in self.document([archived_id])[0]["metrics"]], [MODE])
        self.assertEqual([d["name"] for d in self.document([first[1]["id"]])], ["Test_0295_Other"])
        self.assertEqual(self.document(["00000000-0000-4000-8000-000000000000"]), [])

    def test_the_round_trip_reports_every_schema_unchanged(self):
        self.apply([
            schema(description="A six-axis arm.", metrics=[{"name": SPINDLE, "minimum": -1.5, "maximum": 100}, {"name": MODE}]),
            schema("Test_0295_Other", semantic_id="urn:example:other", metrics=[{"name": DOOR}, {"name": BEARING, "minimum": 0}]),
        ])
        document = self.document()
        mine = [d for d in document if d["name"].startswith("Test_0295_")]
        self.assertEqual(len(mine), 2)
        results = self.apply(document)
        self.assertEqual({r["status"] for r in results if r["name"].startswith("Test_0295_")}, {"unchanged"})
        self.assertEqual(self.reasons(results), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
