# suite:
#   lanes: db
#   why: 0342 -- a schema version built from a submodel template says which, and which element each of its
#     metrics fills: the rule against the fixture the dashboard holds too, the elements a seeded template
#     requires, the refusals in words, that the elements are written by the database whatever a caller
#     sends, frozen with a published version, carried by Create Version and recorded as the schema's own
#     change, and that a schema built any other way is as it was. 0343 -- a file of device schemas names
#     the template, and a file without it builds none.

"""
A schema is built from a template (0342).

    python supabase/migrations/test_a_schema_is_built_from_a_template.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

  * The rule: test-harness/fixtures/schema-template-elements.json, whose made-up template is planted,
    through schema_template_elements() and template_required_paths(). utils/idtaTemplates.js is held to
    the same file by idtaTemplateFill.test.js.
  * The seeded templates: the Nameplate requires four elements a metric can fill, and Asset Interfaces
    Description none, since each of its interfaces may be left out.
  * The version: template_elements is written on every save that changes the definition, the semantic id
    or the template, and what a caller sends is replaced. A version that leaves out a required element,
    whose semantic id is not the template's, or whose template Aber does not hold, is refused in words.
  * Create Version carries both columns, unchecked; publishing freezes them; the Audit Trail has the
    INSERT in the schema's own lane, with the template.
  * A schema built any other way has neither column.
  * The document (0343): `template` there and back, a new schema built from the one its file names, a
    draft built from none where the file names none, and the refusals at their paths.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
from pathlib import Path

import psycopg2
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((REPO / "test-harness" / "fixtures" / "schema-template-elements.json").read_text(encoding="utf-8"))
TEMPLATE = FIXTURE["template"]
TEMPLATE_ID = TEMPLATE["template_id"]
TITLE = f"{TEMPLATE['template_name']} {TEMPLATE['template_version']}"

NAMEPLATE = "https://admin-shell.io/idta/nameplate/3/0/Nameplate"
INTERFACES = "https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Submodel"

ADMIN_ID = "b1e60342-0000-4000-8000-0000000342a1"
SWITCH = "security.require_mfa_for_managers"

NAME, LABEL, STREET, SERIAL, ELSEWHERE = ("Fixture_0342/NAME", "Fixture_0342/LABEL", "Fixture_0342/STREET",
                                          "Fixture_0342/SERIAL", "Fixture_0342/ELSEWHERE")
WHOLE = (NAME, LABEL, STREET)


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def definition(*names):
    return {"type": "object", "properties": {n: {"type": "string"} for n in names}}


class Base(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT 1 FROM pg_attribute WHERE attrelid = 'public.schemas'::regclass"
                         " AND attname = 'template_elements' AND NOT attisdropped;")
        if self.cur.fetchone() is None:
            self.skipTest("0342 is not applied to this database")
        self.plant()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def plant(self):
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                         (ADMIN_ID, f"{ADMIN_ID}@template-schema.test"))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id)"
                         " SELECT %s, id FROM public.roles WHERE name = 'Administrator'"
                         " ON CONFLICT (user_id, role_id) DO NOTHING;", (ADMIN_ID,))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))
        for e in FIXTURE["elements"]:
            self.cur.execute(
                "INSERT INTO public.idta_template_elements (template_id, template_name, template_number, template_version,"
                " path, parent_path, ordinal, id_short, model_type, value_type, semantic_id, semantic_id_type, cardinality)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);",
                (TEMPLATE_ID, TEMPLATE["template_name"], TEMPLATE["template_number"], TEMPLATE["template_version"],
                 e["path"], e["parent_path"], e["ordinal"], e["id_short"], e["model_type"], e["value_type"],
                 e["semantic_id"], "IRI" if e["semantic_id"] else None, e["cardinality"]))
        for m in FIXTURE["catalog"]:
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, semantic_id, semantic_id_type)"
                             " VALUES (%s, 12, %s, %s) RETURNING id;",
                             (m["name"], m["semantic_id"], "IRI" if m["semantic_id"] else None))
            (metric_id,) = self.cur.fetchone()
            for further in m["further"]:
                self.cur.execute("INSERT INTO public.metric_semantic_ids (metric_id, semantic_id, semantic_id_type)"
                                 " VALUES (%s, %s, 'IRI');", (metric_id, further))

    def as_person(self, sql, args=()):
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(
            {"sub": ADMIN_ID, "role": "authenticated", "aal": "aal1"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute(sql, args)
        answer = self.cur.fetchall() if self.cur.description else self.cur.rowcount
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        return answer

    def refused(self, call, *args, **kwargs):
        """What a call is refused with, contained so the transaction survives."""
        self.cur.execute("SAVEPOINT refused;")
        try:
            call(*args, **kwargs)
        except psycopg2.Error as exc:
            self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
            return exc
        return self.fail("nothing was refused")

    def build(self, name, metrics=WHOLE, template=TEMPLATE_ID, semantic_id=None, elements=None):
        """A first version as the dashboard's builder writes it, as the Administrator."""
        return self.as_person(
            "INSERT INTO public.schemas (schema_name, schema_definition, semantic_id, semantic_id_type,"
            " template_id, template_elements) VALUES (%s, %s, %s, 'IRI', %s, %s) RETURNING id::text;",
            (name, Json(definition(*metrics)), semantic_id or template, template,
             Json(elements) if elements is not None else None))[0][0]

    def row(self, schema_id):
        self.cur.execute("SELECT template_id, template_elements FROM public.schemas WHERE id = %s;", (schema_id,))
        return self.cur.fetchone()

    def fork(self, schema_id):
        return self.as_person("SELECT public.fork_schema(%s::uuid, 'why');", (schema_id,))[0][0]

    def case(self, key):
        return next(c for c in FIXTURE["cases"] if c["key"] == key)


class TheRule(Base):
    def test_each_case_of_the_fixture_fills_what_it_says(self):
        for case in FIXTURE["cases"]:
            with self.subTest(case=case["key"]):
                self.cur.execute("SELECT public.schema_template_elements(%s, %s);",
                                 (TEMPLATE_ID, Json(definition(*case["metrics"]))))
                self.assertEqual(self.cur.fetchone()[0], case["filled"])

    def test_the_required_elements_are_the_fixtures(self):
        self.cur.execute("SELECT public.template_required_paths(%s);", (TEMPLATE_ID,))
        self.assertEqual(self.cur.fetchone()[0], FIXTURE["required"])

    def test_what_a_case_misses_is_said_by_name(self):
        for case in FIXTURE["cases"]:
            with self.subTest(case=case["key"]):
                self.cur.execute("SELECT problem FROM public.schema_template_problems(%s, %s, %s);",
                                 (TEMPLATE_ID, TEMPLATE_ID, Json(case["filled"])))
                said = [r[0] for r in self.cur.fetchall()]
                if case["missing"]:
                    self.assertEqual(said, [f"No metric here fills {', '.join(case['missing'])}, which {TITLE} requires."
                                            " A metric fills an element when the element's semantic id is the metric's"
                                            " own or one of its further ids."])
                else:
                    self.assertEqual(said, [])

    def test_a_metric_in_required_alone_fills_too(self):
        self.cur.execute("SELECT public.schema_template_elements(%s, %s);",
                         (TEMPLATE_ID, Json({"type": "object", "properties": {}, "required": [NAME]})))
        self.assertEqual(list(self.cur.fetchone()[0]), [NAME])

    def test_the_nameplate_requires_four_elements_and_asset_interfaces_none(self):
        self.cur.execute("SELECT public.template_required_paths(%s), public.template_required_paths(%s);",
                         (NAMEPLATE, INTERFACES))
        nameplate, interfaces = self.cur.fetchone()
        self.assertEqual(nameplate, ["URIOfTheProduct", "ManufacturerName", "ManufacturerProductDesignation",
                                     "OrderCodeOfManufacturer"])
        self.assertEqual(interfaces, [])


class TheVersion(Base):
    def test_a_version_built_from_the_template_says_what_each_metric_fills(self):
        schema = self.build("Test_0342_Plate")
        self.assertEqual(self.row(schema), (TEMPLATE_ID, self.case("every-required-element-is-filled")["filled"]))

    def test_what_a_caller_sends_for_the_elements_is_replaced(self):
        schema = self.build("Test_0342_Plate", elements={NAME: {"path": "Serial", "semantic_id": "urn:somewhere"}})
        self.assertEqual(self.row(schema)[1][NAME], {"path": "Name", "semantic_id": "urn:aber:fixture:0342:name"})

    def test_a_required_element_nothing_fills_is_refused_by_name(self):
        exc = self.refused(self.build, "Test_0342_Plate", (NAME, SERIAL))
        self.assertEqual(exc.pgcode, "23514")
        self.assertIn(f"No metric here fills Label, Address.Street, which {TITLE} requires.", str(exc))

    def test_a_semantic_id_that_is_not_the_templates_is_refused(self):
        exc = self.refused(self.build, "Test_0342_Plate", semantic_id="urn:aber:fixture:elsewhere")
        self.assertIn(f"A schema built from {TITLE} carries the template's id as its semantic id: {TEMPLATE_ID}.", str(exc))

    def test_every_reason_is_said_at_once(self):
        exc = self.refused(self.build, "Test_0342_Plate", (ELSEWHERE,), semantic_id="urn:aber:fixture:elsewhere")
        self.assertIn("carries the template's id as its semantic id", str(exc))
        self.assertIn("No metric here fills Name, Label, Address.Street", str(exc))

    def test_a_template_aber_does_not_hold_is_refused(self):
        exc = self.refused(self.build, "Test_0342_Plate", template="https://example.com/aber/no-such-template")
        self.assertIn("https://example.com/aber/no-such-template is not a template Aber holds.", str(exc))

    def test_a_schema_built_any_other_way_has_neither_column(self):
        schema = self.as_person("INSERT INTO public.schemas (schema_name, schema_definition, semantic_id, semantic_id_type)"
                                " VALUES ('Test_0342_Typed', %s, %s, 'IRI') RETURNING id::text;",
                                (Json(definition(NAME)), TEMPLATE_ID))[0][0]
        self.assertEqual(self.row(schema), (None, None))
        # Elements sent without a template are none.
        schema = self.as_person("INSERT INTO public.schemas (schema_name, schema_definition, template_elements)"
                                " VALUES ('Test_0342_Typed_2', %s, '{}') RETURNING id::text;",
                                (Json(definition(NAME)),))[0][0]
        self.assertEqual(self.row(schema), (None, None))


class TheDraft(Base):
    def test_create_version_carries_the_template_and_its_elements(self):
        root = self.build("Test_0342_Plate")
        draft = self.fork(root)
        self.assertEqual((draft["template_id"], draft["template_elements"]), self.row(root))

    def test_a_copy_of_a_published_version_is_never_refused(self):
        root = self.build("Test_0342_Plate")
        # The catalogue moves on: the label is no longer a further id of the metric that filled it.
        self.cur.execute("DELETE FROM public.metric_semantic_ids WHERE semantic_id = 'urn:aber:fixture:0342:label';")
        draft = self.fork(root)["id"]
        self.assertEqual(self.row(draft), self.row(root))
        # An edit that changes none of what the elements follow from keeps them, and is not checked.
        self.as_person("UPDATE public.schemas SET description = 'edited', semantic_id = %s WHERE id = %s;",
                       (TEMPLATE_ID, draft))
        self.assertEqual(self.row(draft), self.row(root))
        # A change of the metrics is, and says what is now missing.
        exc = self.refused(self.as_person, "UPDATE public.schemas SET schema_definition = %s WHERE id = %s;",
                           (Json(definition(NAME, LABEL, STREET, SERIAL)), draft))
        self.assertIn("No metric here fills Label,", str(exc))

    def test_a_change_of_the_metrics_writes_the_elements_again(self):
        draft = self.fork(self.build("Test_0342_Plate"))["id"]
        self.as_person("UPDATE public.schemas SET schema_definition = %s WHERE id = %s;",
                       (Json(definition(*WHOLE, SERIAL)), draft))
        self.assertEqual(self.row(draft)[1][SERIAL], {"path": "Serial", "semantic_id": "urn:aber:fixture:0342:serial"})
        exc = self.refused(self.as_person, "UPDATE public.schemas SET schema_definition = %s WHERE id = %s;",
                           (Json(definition(NAME, LABEL)), draft))
        self.assertIn("No metric here fills Address.Street,", str(exc))

    def test_a_draft_may_stop_being_built_from_the_template(self):
        draft = self.fork(self.build("Test_0342_Plate"))["id"]
        self.as_person("UPDATE public.schemas SET template_id = NULL WHERE id = %s;", (draft,))
        self.assertEqual(self.row(draft), (None, None))

    def test_a_published_versions_template_is_frozen(self):
        root = self.build("Test_0342_Plate")
        for column, value in (("template_id", None), ("template_elements", Json({}))):
            with self.subTest(column=column):
                exc = self.refused(self.as_person, f"UPDATE public.schemas SET {column} = %s WHERE id = %s;", (value, root))
                self.assertIn("immutable", str(exc))
        self.assertEqual(self.row(root)[0], TEMPLATE_ID)

    def test_the_insert_is_the_schemas_own_row_in_the_audit_trail_with_its_template(self):
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail;")
        (before,) = self.cur.fetchone()
        self.build("Test_0342_Plate")
        self.cur.execute("SELECT entity_type, action, audit_domain, changed_by::text, new_data ->> 'template_id',"
                         " new_data -> 'template_elements' -> %s ->> 'path' FROM public.audit_trail WHERE id > %s;",
                         (NAME, before))
        self.assertEqual(self.cur.fetchall(), [("schemas", "INSERT", "asset", ADMIN_ID, TEMPLATE_ID, "Name")])


class TheDocument(Base):
    """0343: a file of device schemas names the template, and a file without it builds none."""

    def apply(self, document, dry_run=False):
        return self.as_person("SELECT public.apply_device_schemas(%s, %s);", (Json(document), dry_run))[0][0]

    def stored(self, schema_id):
        return self.as_person("SELECT public.device_schema_stored_document(%s::uuid);", (schema_id,))[0][0]

    def head(self, name):
        self.cur.execute("SELECT id::text FROM public.schemas WHERE lineage_name = %s AND status = 'draft';", (name,))
        row = self.cur.fetchone()
        return row[0] if row else None

    def doc(self, name, metrics=WHOLE, **keys):
        return {"name": name, "metrics": [{"name": m} for m in metrics], **keys}

    def test_a_version_built_from_a_template_is_written_with_it_and_reads_back_unchanged(self):
        schema = self.build("Test_0342_Plate")
        written = self.stored(schema)
        self.assertEqual((written["template"], written["semantic_id"]), (TEMPLATE_ID, TEMPLATE_ID))
        self.assertEqual([r["status"] for r in self.apply([written], dry_run=True)], ["unchanged"])
        typed = self.as_person("INSERT INTO public.schemas (schema_name, schema_definition) VALUES ('Test_0342_Typed', %s)"
                               " RETURNING id::text;", (Json(definition(NAME)),))[0][0]
        self.assertNotIn("template", self.stored(typed))

    def test_a_new_schema_is_built_from_the_template_its_file_names(self):
        [result] = self.apply([self.doc("Test_0342_From_A_File", template=TEMPLATE_ID)])
        self.assertEqual(result["status"], "new", result)
        self.cur.execute("SELECT semantic_id, semantic_id_type, template_id, template_elements FROM public.schemas"
                         " WHERE id = %s;", (result["id"],))
        self.assertEqual(self.cur.fetchone(), (TEMPLATE_ID, "IRI", TEMPLATE_ID,
                                               self.case("every-required-element-is-filled")["filled"]))

    def test_a_file_without_the_key_makes_a_draft_built_from_no_template(self):
        self.build("Test_0342_Plate")
        [result] = self.apply([self.doc("Test_0342_Plate", semantic_id=TEMPLATE_ID, semantic_id_type="IRI")])
        self.assertEqual((result["status"], result["changes"]), ("changed", ["template"]), result)
        draft = self.head("Test_0342_Plate")
        self.assertEqual(self.row(draft), (None, None))
        self.cur.execute("SELECT semantic_id FROM public.schemas WHERE id = %s;", (draft,))
        self.assertEqual(self.cur.fetchone()[0], TEMPLATE_ID, "the file kept the id, as a claim of its own")

    def test_a_file_that_adds_the_key_makes_a_draft_built_from_the_template(self):
        self.as_person("INSERT INTO public.schemas (schema_name, schema_definition) VALUES ('Test_0342_Typed', %s);",
                       (Json(definition(*WHOLE)),))
        [result] = self.apply([self.doc("Test_0342_Typed", template=TEMPLATE_ID)])
        self.assertEqual((result["status"], result["changes"]), ("changed", ["semantic_id", "semantic_id_type", "template"]))
        self.assertEqual(self.row(self.head("Test_0342_Typed"))[0], TEMPLATE_ID)

    def test_what_the_template_requires_is_said_at_the_key(self):
        [result] = self.apply([self.doc("Test_0342_Short", (NAME, SERIAL), template=TEMPLATE_ID)], dry_run=True)
        self.assertEqual(result["status"], "refused")
        self.assertEqual(result["reasons"], [{
            "path": "$[0].template",
            "message": f"No metric here fills Label, Address.Street, which {TITLE} requires. A metric fills an element"
                       " when the element's semantic id is the metric's own or one of its further ids."}])

    def test_another_semantic_id_and_a_template_aber_does_not_hold_are_refused_at_their_keys(self):
        results = self.apply([self.doc("Test_0342_Other_Id", template=TEMPLATE_ID, semantic_id="urn:aber:fixture:else"),
                              self.doc("Test_0342_No_Template", template="https://example.com/aber/none")], dry_run=True)
        self.assertEqual([[r["path"] for r in result["reasons"]] for result in results],
                         [["$[0].semantic_id"], ["$[1].template"]])
        self.assertIn(f"Leave `semantic_id` out, or make it `{TEMPLATE_ID}`.", results[0]["reasons"][0]["message"])


if __name__ == "__main__":
    unittest.main()
