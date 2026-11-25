# suite:
#   lanes: db
#   why: The IDTA submodel-template elements (0320): a table of generated rows that anyone signed in reads
#     and nobody writes. A nested element the generator dropped, a row under the wrong parent, a write
#     policy added by habit or an ECLASS text let in breaks nothing at runtime: the Templates tab is
#     shorter, and a schema built from a template would miss a mandatory element with no sign of it.

"""
`idta_template_elements`, as 0320 leaves it on a migrated database, against the template files kept in
scripts/vocabularies/ and against the released Nameplate rows of `idta_submodel_templates`. The files are
walked here again, apart from the generator. Each probe runs in a transaction that is rolled back.

    python supabase/migrations/test_an_idta_template_is_seeded_with_its_nested_elements.py
"""
import json
import os
import pathlib
import re
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("POSTGRES_PASSWORD", "postgres"))

HERE = pathlib.Path(__file__).resolve().parent
MIGRATION = next(HERE.glob("0320_*.sql"))
VOCABULARIES = HERE.parents[1] / "scripts" / "vocabularies"
NAMEPLATE = "https://admin-shell.io/idta/nameplate/3/0/Nameplate"
AID = "https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Submodel"

# (template_id, template_name, template_number, template_version), and the file each is read from.
TEMPLATES = {
    NAMEPLATE: ("Digital Nameplate", "IDTA 02006", "3.0.3", "idta-02006-3-0-3-digital-nameplate.json"),
    AID: ("Asset Interfaces Description", "IDTA 02017", "1.0.1", "idta-02017-1-0-1-asset-interfaces-description.json"),
}
READ_ALL = "SELECT * FROM public.idta_template_elements ORDER BY template_id, ordinal"
APP_ROLES = ("Administrator", "Shopfloor_Manager", "Operator", "Auditor")


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def walk(environment):
    """(path, parent, idShort, model type, semantic id, further ids, cardinality) of each element, in order."""
    out = []

    def visit(element, parent, index):
        if parent is None:
            path = element["idShort"]
        elif index is not None:
            path = f"{parent}[{index}]"
        else:
            path = f"{parent}.{element['idShort']}"
        stated = [q["value"] for q in element.get("qualifiers", []) if q["type"] in ("SMT/Cardinality", "Cardinality")]
        out.append((path, parent, element.get("idShort"), element["modelType"],
                    element["semanticId"]["keys"][0]["value"] if "semanticId" in element else None,
                    [r["keys"][0]["value"] for r in element.get("supplementalSemanticIds", [])],
                    stated[0] if stated else None))
        if element["modelType"] in ("SubmodelElementCollection", "SubmodelElementList"):
            in_list = element["modelType"] == "SubmodelElementList"
            for at, child in enumerate(element.get("value", [])):
                visit(child, path, at if in_list else None)

    for element in environment["submodels"][0]["submodelElements"]:
        visit(element, None, None)
    return out


class TemplateTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            connect().close()
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?")

    def in_transaction(self, work):
        """Run `work(cur)` on a fresh connection and roll everything back."""
        conn = connect()
        try:
            with conn.cursor() as cur:
                return work(cur)
        finally:
            conn.rollback()
            conn.close()

    def fetch(self, sql, params=None):
        def read(cur):
            cur.execute(sql, params or ())
            return cur.fetchall()
        return self.in_transaction(read)


class TestTheRows(TemplateTestCase):
    def test_each_template_is_named_and_numbered_as_its_file_is(self):
        rows = self.fetch("SELECT DISTINCT template_id, template_name, template_number, template_version"
                          " FROM public.idta_template_elements WHERE template_id = ANY (%s)", (list(TEMPLATES),))
        self.assertEqual({r[0]: r[1:] for r in rows}, {t: v[:3] for t, v in TEMPLATES.items()})

    def test_every_element_of_each_file_is_a_row_in_its_order_under_its_parent(self):
        for template_id, (name, _, _, file) in TEMPLATES.items():
            with self.subTest(template=name):
                environment = json.loads((VOCABULARIES / file).read_text(encoding="utf-8"))
                rows = self.fetch(
                    "SELECT path, parent_path, id_short, model_type, semantic_id, supplemental_semantic_ids, cardinality"
                    " FROM public.idta_template_elements WHERE template_id = %s ORDER BY ordinal", (template_id,))
                self.assertEqual([tuple(r) for r in rows], walk(environment))

    def test_an_idshort_that_repeats_is_a_row_in_each_place(self):
        paths = [r[0] for r in self.fetch(
            "SELECT path FROM public.idta_template_elements WHERE template_id = %s AND id_short = 'ArbitraryProperty'"
            " ORDER BY ordinal", (NAMEPLATE,))]
        self.assertEqual(paths, ["AssetSpecificProperties.ArbitraryProperty",
                                 "AssetSpecificProperties.GuidelineSpecificProperties[0].ArbitraryProperty"])

    def test_the_ordinals_run_from_one_and_every_element_follows_its_parent(self):
        for template_id in TEMPLATES:
            rows = self.fetch("SELECT ordinal, path, parent_path FROM public.idta_template_elements"
                              " WHERE template_id = %s ORDER BY ordinal", (template_id,))
            self.assertEqual([r[0] for r in rows], list(range(1, len(rows) + 1)))
            seen = set()
            for _, path, parent in rows:
                if parent is not None:
                    self.assertIn(parent, seen, path)
                seen.add(path)

    def test_a_value_type_an_example_and_a_definition_are_the_files(self):
        rows = {r[0]: r[1:] for r in self.fetch(
            "SELECT path, value_type, example_value, definition FROM public.idta_template_elements"
            " WHERE template_id = %s", (NAMEPLATE,))}
        self.assertEqual(rows["DateOfManufacture"], ("xs:date", "2022-01-01", None))
        self.assertEqual(rows["ManufacturerName"], (None, "Muster AG", None))
        self.assertEqual(rows["Markings"][0], "SubmodelElementCollection")
        self.assertEqual(rows["CountryOfOrigin"][2],
                         "Note: Country codes defined accord. to DIN EN ISO 3166-1 alpha-2 codes")
        self.assertTrue(rows["UniqueFacilityIdentifier"][2].startswith("unique string of characters"))

    def test_no_row_holds_a_dictionary_definition_or_a_filler(self):
        """What IEC CDD or ECLASS says of a concept is not taken: only the 14 the file says itself."""
        described = self.fetch("SELECT semantic_id, definition FROM public.idta_template_elements"
                               " WHERE template_id = %s AND definition IS NOT NULL", (NAMEPLATE,))
        self.assertEqual(len(described), 14)
        self.assertTrue(all(text.startswith("Note: ") or semantic_id.startswith("https://admin-shell.io/")
                            for semantic_id, text in described))
        self.assertEqual(self.fetch("SELECT path FROM public.idta_template_elements"
                                    " WHERE definition IN ('EMPTY', 'Current counter value', 'AID Template Sample')"), [])

    def test_no_text_is_on_two_lines(self):
        self.assertEqual(self.fetch("SELECT path FROM public.idta_template_elements"
                                    " WHERE definition ~ '[\\n\\r\\t]' OR example_value ~ '[\\n\\r\\t]'"), [])

    def test_an_id_has_the_shape_of_its_type(self):
        self.assertEqual(self.fetch(
            "SELECT path, semantic_id FROM public.idta_template_elements"
            " WHERE semantic_id IS NOT NULL AND public.semantic_id_shape(semantic_id) IS DISTINCT FROM semantic_id_type"), [])
        self.assertEqual(self.fetch(
            "SELECT e.path, s FROM public.idta_template_elements e, unnest(e.supplemental_semantic_ids) s"
            " WHERE public.semantic_id_shape(s) NOT IN ('IRI', 'IRDI')"), [])


class TestTheReleasedNameplateRows(TemplateTestCase):
    """idta_submodel_templates is released: its 20 rows are what they were, and agree with the generated ones."""

    def test_the_two_tables_name_the_same_elements_in_the_same_order_by_the_same_ids(self):
        released = self.fetch("SELECT id_short, semantic_id, semantic_id_type FROM public.idta_submodel_templates"
                              " WHERE template_id = %s ORDER BY ordinal", (NAMEPLATE,))
        generated = self.fetch("SELECT id_short, semantic_id, semantic_id_type FROM public.idta_template_elements"
                               " WHERE template_id = %s AND parent_path IS NULL ORDER BY ordinal", (NAMEPLATE,))
        self.assertEqual(len(released), 20)
        self.assertEqual(generated, released)

    def test_they_differ_in_two_elements_alone_which_version_3_swapped(self):
        rows = self.fetch(
            "SELECT t.id_short, t.is_mandatory, e.cardinality FROM public.idta_submodel_templates t"
            " JOIN public.idta_template_elements e ON e.template_id = t.template_id AND e.path = t.id_short"
            " WHERE t.is_mandatory IS DISTINCT FROM (e.cardinality IN ('One', 'OneToMany')) ORDER BY 1")
        self.assertEqual(rows, [("OrderCodeOfManufacturer", False, "One"), ("YearOfConstruction", True, "ZeroToOne")])

    def test_a_generated_definition_defines_no_concept(self):
        """concept_definitions reads the released rows alone, so an export's text does not move."""
        definition = self.fetch("SELECT pg_get_viewdef('public.concept_definitions'::regclass)")[0][0]
        self.assertIn("idta_submodel_templates", definition)
        self.assertNotIn("idta_template_elements", definition)


class TestTheTableIsReferenceData(TemplateTestCase):
    def test_it_has_row_security_and_one_select_policy_for_authenticated(self):
        self.assertEqual(
            self.fetch("SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.idta_template_elements'::regclass"),
            [(True,)])
        self.assertEqual(
            self.fetch("SELECT policyname, cmd, roles::text FROM pg_policies"
                       " WHERE schemaname = 'public' AND tablename = 'idta_template_elements'"),
            [("idta_template_elements_select_authenticated", "SELECT", "{authenticated}")])

    def test_authenticated_reads_it_and_anon_does_not_and_nobody_writes_it(self):
        writes = self.fetch(
            "SELECT r, p FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,"
            " unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p"
            " WHERE has_table_privilege(r, 'public.idta_template_elements', p)")
        self.assertEqual(writes, [])
        reads = self.fetch("SELECT r, has_table_privilege(r, 'public.idta_template_elements', 'SELECT')"
                           " FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r ORDER BY r")
        self.assertEqual(reads, [("anon", False), ("authenticated", True), ("service_role", True)])

    def test_each_application_role_reads_every_row_and_writes_none(self):
        total = self.fetch("SELECT count(*) FROM public.idta_template_elements")[0][0]
        for role in APP_ROLES:
            with self.subTest(role=role):
                def probe(cur, role=role):
                    cur.execute("SELECT set_config('request.jwt.claims', %s, true)", (json.dumps(
                        {"role": "authenticated", "sub": "00000000-0000-4000-8000-000000000489", "user_role": role, "aal": "aal2"}),))
                    cur.execute("SET LOCAL ROLE authenticated")
                    cur.execute("SELECT count(*) FROM public.idta_template_elements")
                    seen = cur.fetchone()[0]
                    with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                        cur.execute("UPDATE public.idta_template_elements SET definition = 'x'")
                    return seen
                self.assertEqual(self.in_transaction(probe), total)

    def test_anon_cannot_read_a_row(self):
        def probe(cur):
            cur.execute("SET LOCAL ROLE anon")
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT 1 FROM public.idta_template_elements")
        self.in_transaction(probe)

    def test_the_service_role_reads_and_cannot_write(self):
        def probe(cur):
            cur.execute("SET LOCAL ROLE service_role")
            cur.execute("SELECT count(*) FROM public.idta_template_elements")
            seen = cur.fetchone()[0]
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("DELETE FROM public.idta_template_elements")
            return seen
        self.assertGreater(self.in_transaction(probe), 0)

    def test_the_checks_refuse_a_row_that_is_not_what_the_generator_writes(self):
        good = {"template_id": "https://example.test/T", "template_name": "T", "template_number": "IDTA 99999",
                "template_version": "1.0.0", "path": "A", "parent_path": None, "ordinal": 1, "id_short": "A",
                "model_type": "Property", "semantic_id": "https://example.test/A", "semantic_id_type": "IRI",
                "supplemental_semantic_ids": [], "cardinality": "One"}
        insert = (f"INSERT INTO public.idta_template_elements ({', '.join(good)})"
                  f" VALUES ({', '.join('%(' + c + ')s' for c in good)})")

        def accepted(cur):
            cur.execute(insert, good)
            cur.execute(insert, {**good, "path": "A.B", "parent_path": "A", "id_short": "B", "ordinal": 2,
                                 "semantic_id": None, "semantic_id_type": None, "cardinality": None})
            cur.execute(insert, {**good, "path": "A.B[0]", "parent_path": "A.B", "id_short": None, "ordinal": 3})
            return True
        self.assertTrue(self.in_transaction(accepted))

        bad = {
            "a nested path with no parent": {"path": "A.B", "id_short": "B"},
            "an item of a list with no parent": {"path": "A[0]", "id_short": None},
            "a parent that is not the path's": {"path": "A.B", "parent_path": "C", "id_short": "B"},
            "a parent two levels up": {"path": "A.B.C", "parent_path": "A", "id_short": "C"},
            "a path that is its parent": {"path": "A", "parent_path": "A"},
            "an element of a collection with no idShort": {"path": "A.B", "parent_path": "A", "id_short": None},
            "a top-level element with no idShort": {"id_short": None},
            "an idShort that is not one": {"id_short": "{00}"},
            "an ordinal of nothing": {"ordinal": 0},
            "a model type AAS does not have": {"model_type": "Widget"},
            "an id with no type": {"semantic_id_type": None},
            "a type with no id": {"semantic_id": None},
            "a type that is neither": {"semantic_id_type": "ExpandedNodeId"},
            "a null among the further ids": {"supplemental_semantic_ids": ["https://example.test/B", None]},
            "a cardinality no template has": {"cardinality": "Some"},
        }
        for what, change in bad.items():
            with self.subTest(what=what):
                def probe(cur, change=change):
                    with self.assertRaises(psycopg2.errors.CheckViolation):
                        cur.execute(insert, {**good, **change})
                self.in_transaction(probe)

    def test_a_path_is_once_in_a_template(self):
        def probe(cur):
            with self.assertRaises(psycopg2.errors.UniqueViolation):
                cur.execute("INSERT INTO public.idta_template_elements (template_id, template_name, template_number,"
                            " template_version, path, ordinal, id_short, model_type)"
                            " VALUES (%s, 'x', 'x', 'x', 'SerialNumber', 99, 'SerialNumber', 'Property')", (NAMEPLATE,))
        self.in_transaction(probe)


class TestReplay(TemplateTestCase):
    def test_replaying_the_migration_rewrites_no_row(self):
        """db-init replays the file on every boot. A row that is unchanged is not touched."""
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            cur.execute("SELECT xmin::text, e.* FROM public.idta_template_elements e ORDER BY template_id, ordinal")
            before = cur.fetchall()
            cur.execute(sql)
            cur.execute("SELECT xmin::text, e.* FROM public.idta_template_elements e ORDER BY template_id, ordinal")
            return before, cur.fetchall()
        before, after = self.in_transaction(probe)
        self.assertGreater(len(before), 0)
        self.assertEqual(after, before)

    def test_replay_puts_back_a_row_that_was_changed_or_removed(self):
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            cur.execute(READ_ALL)
            before = cur.fetchall()
            cur.execute("UPDATE public.idta_template_elements SET definition = 'edited by hand', ordinal = 999,"
                        " supplemental_semantic_ids = '{}' WHERE template_id = %s AND path = 'SerialNumber'", (NAMEPLATE,))
            cur.execute("DELETE FROM public.idta_template_elements WHERE path = 'Markings[0].MarkingName'")
            cur.execute("DELETE FROM public.idta_template_elements WHERE template_id = %s", (AID,))
            cur.execute(sql)
            cur.execute(READ_ALL)
            return before, cur.fetchall()
        before, after = self.in_transaction(probe)
        self.assertEqual(after, before)

    def test_the_released_table_is_as_0002_leaves_it(self):
        """0320 reads nothing of it and writes nothing to it."""
        statements = "\n".join(line for line in MIGRATION.read_text(encoding="utf-8").splitlines()
                               if not line.lstrip().startswith("--"))
        self.assertEqual([line for line in statements.splitlines() if "idta_submodel_templates" in line
                          and "COMMENT" not in line and not line.lstrip().startswith("'")], [])

    def test_the_block_is_the_generators_and_holds_no_table_definition(self):
        text = MIGRATION.read_text(encoding="utf-8")
        block = text[text.index("-- >>> BEGIN GENERATED idta_template_elements"):
                     text.index("-- <<< END GENERATED idta_template_elements")]
        self.assertEqual(len(re.findall(r"^INSERT INTO ", block, re.M)), len(TEMPLATES))
        self.assertNotIn("CREATE", block)
        stamped = int(re.search(r"-- (\d+) rows, sha256:", block).group(1))
        held = self.fetch("SELECT count(*) FROM public.idta_template_elements WHERE template_id = ANY (%s)", (list(TEMPLATES),))
        self.assertEqual(held, [(stamped,)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
