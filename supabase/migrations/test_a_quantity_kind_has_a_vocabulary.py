# suite:
#   lanes: db
#   why: The QUDT vocabulary (0304): two tables of generated rows that anyone signed in reads and nobody
#     writes, and an arm of concept_definitions. A kind dropped by the generator, a deprecated one let
#     in, a write policy added by habit or a view that lost its QUDT arm breaks nothing at runtime: the
#     picker is shorter, an export still defines its concept, by "Temperature, as QUDT defines it."
#     instead of QUDT's own text, and its unitId is empty.

"""
`qudt_quantity_kinds`, `qudt_units` and the QUDT arm of `concept_definitions`, as 0304 leaves them on a
migrated database. Each probe runs in a transaction that is rolled back.

    python supabase/migrations/test_a_quantity_kind_has_a_vocabulary.py
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
MIGRATION = next(HERE.glob("0304_*.sql"))
CROSSWALK = HERE.parents[1] / "scripts" / "vocabularies" / "mtconnect-units-to-qudt.json"
KIND = "http://qudt.org/vocab/quantitykind/"
UNIT = "http://qudt.org/vocab/unit/"

# The kinds the five BMS example readings cite (supabase/example-metrics.sql).
EXAMPLE_KINDS = ["Temperature", "RelativeHumidity", "MoleFraction", "Pressure", "VolumeFlowRate"]


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def stamped_rows(table):
    """The row count the generated block's header declares, from the migration's own text."""
    text = MIGRATION.read_text(encoding="utf-8")
    return int(re.search(r"BEGIN GENERATED %s -- QUDT \S+, (\d+) rows" % table, text).group(1))


class QudtTestCase(unittest.TestCase):
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


class TestTheKinds(QudtTestCase):
    def test_every_kind_the_block_declares_is_a_row(self):
        count = self.fetch("SELECT count(*) FROM public.qudt_quantity_kinds")[0][0]
        self.assertEqual(count, stamped_rows("qudt_quantity_kinds"))
        self.assertGreater(count, 1000)

    def test_the_kinds_the_example_readings_cite_are_rows(self):
        ids = {r[0] for r in self.fetch("SELECT semantic_id FROM public.qudt_quantity_kinds")}
        self.assertEqual({KIND + k for k in EXAMPLE_KINDS} - ids, set())

    def test_an_id_is_qudts_own_and_a_label_is_english(self):
        rows = dict(self.fetch("SELECT semantic_id, name FROM public.qudt_quantity_kinds"))
        self.assertEqual(rows[KIND + "Temperature"], "Temperature")
        self.assertEqual(rows[KIND + "VolumeFlowRate"], "Volume Flow Rate")
        self.assertTrue(all(i.startswith(KIND) for i in rows))

    def test_a_deprecated_kind_is_not_a_row_and_what_replaces_it_is(self):
        ids = {r[0] for r in self.fetch("SELECT semantic_id FROM public.qudt_quantity_kinds")}
        self.assertNotIn(KIND + "BinaryLogarithmicMedianInformationFlow", ids)
        self.assertIn(KIND + "InformationFlowRate", ids)

    def test_a_description_is_plain_english_on_one_line(self):
        described = dict(self.fetch("SELECT semantic_id, description FROM public.qudt_quantity_kinds"))
        self.assertTrue(described[KIND + "Temperature"].startswith("Temperature is a physical property of matter"))
        for iri, text in described.items():
            if text is not None:
                with self.subTest(kind=iri):
                    self.assertEqual(text, " ".join(text.split()))
                    self.assertNotIn("\\", text)
                    self.assertNotIn("$", text)

    def test_latex_is_written_out_and_a_german_plain_text_description_is_passed_over(self):
        described = dict(self.fetch("SELECT semantic_id, description FROM public.qudt_quantity_kinds"))
        # `$\textit{Absolute Humidity}$ is an amount of water vapour ...` in QUDT's file.
        self.assertTrue(described[KIND + "AbsoluteHumidity"].startswith("Absolute Humidity is an amount of water vapour"))
        # Its plain-text description is German, so its English dcterms:description is the one taken.
        self.assertTrue(described[KIND + "AreicTorque"].startswith("ratio of a torque acting on a surface"))

    def test_a_kind_with_no_description_in_english_has_none(self):
        described = dict(self.fetch("SELECT semantic_id, description FROM public.qudt_quantity_kinds"))
        self.assertIn(KIND + "ActionTime", described)
        self.assertIsNone(described[KIND + "ActionTime"])


class TestTheUnits(QudtTestCase):
    def crosswalk(self):
        return json.loads(CROSSWALK.read_text(encoding="utf-8"))["units"]

    def test_the_units_are_the_ones_the_crosswalk_reaches_and_no_others(self):
        reached = {e["unit"] for e in self.crosswalk().values() if e["unit"]}
        held = {r[0] for r in self.fetch("SELECT semantic_id FROM public.qudt_units")}
        self.assertEqual(held, reached)
        self.assertEqual(len(held), stamped_rows("qudt_units"))

    def test_a_unit_has_its_label_its_symbol_and_its_unece_code(self):
        rows = {r[0]: r[1:] for r in self.fetch("SELECT semantic_id, name, symbol, unece_code FROM public.qudt_units")}
        self.assertEqual(rows[UNIT + "DEG_C"], ("Degree Celsius", "°C", "CEL"))
        self.assertEqual(rows[UNIT + "MilliM"], ("Millimetre", "mm", "MMT"))

    def test_a_unit_with_no_unece_code_has_none(self):
        rows = {r[0]: r[1:] for r in self.fetch("SELECT semantic_id, name, symbol, unece_code FROM public.qudt_units")}
        self.assertIsNone(rows[UNIT + "DEG-PER-MIN"][2])

    def test_a_deprecated_unit_is_not_what_a_name_maps_to(self):
        held = {r[0] for r in self.fetch("SELECT semantic_id FROM public.qudt_units")}
        self.assertNotIn(UNIT + "V-A", held)
        self.assertIn(UNIT + "VA", held)

    def test_a_name_that_maps_to_nothing_says_why(self):
        for name, entry in self.crosswalk().items():
            if entry["unit"] is None:
                with self.subTest(name=name):
                    self.assertTrue(entry["reason"].strip())


class TestTheTablesAreReferenceData(QudtTestCase):
    TABLES = {
        "qudt_quantity_kinds": ("qudt_quantity_kinds_select_authenticated", KIND),
        "qudt_units": ("qudt_units_select_authenticated", UNIT),
    }

    def test_each_has_row_security_and_one_select_policy_for_authenticated(self):
        for table, (policy, _) in self.TABLES.items():
            with self.subTest(table=table):
                self.assertEqual(
                    self.fetch("SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = %s::regclass", (f"public.{table}",)),
                    [(True,)])
                self.assertEqual(
                    self.fetch("SELECT policyname, cmd, roles::text FROM pg_policies"
                               " WHERE schemaname = 'public' AND tablename = %s", (table,)),
                    [(policy, "SELECT", "{authenticated}")])

    def test_authenticated_reads_each_and_anon_does_not_and_nobody_writes(self):
        for table in self.TABLES:
            with self.subTest(table=table):
                grants = self.fetch(
                    "SELECT has_table_privilege('authenticated', %(t)s, 'SELECT'),"
                    "       has_table_privilege('anon', %(t)s, 'SELECT'),"
                    "       has_table_privilege('authenticated', %(t)s, 'INSERT'),"
                    "       has_table_privilege('authenticated', %(t)s, 'UPDATE'),"
                    "       has_table_privilege('authenticated', %(t)s, 'DELETE'),"
                    "       has_table_privilege('service_role', %(t)s, 'SELECT'),"
                    "       has_table_privilege('service_role', %(t)s, 'INSERT')", {"t": f"public.{table}"})
                self.assertEqual(grants, [(True, False, False, False, False, True, False)])

    def test_a_signed_in_person_reads_every_row_through_the_policy(self):
        for table in self.TABLES:
            with self.subTest(table=table):
                def probe(cur, table=table):
                    cur.execute("SET LOCAL ROLE authenticated")
                    cur.execute(f"SELECT count(*) FROM public.{table}")
                    return cur.fetchone()[0]
                self.assertEqual(self.in_transaction(probe), stamped_rows(table))

    def test_a_signed_in_person_cannot_write_a_row_and_anon_cannot_read_one(self):
        for table, (_, base) in self.TABLES.items():
            with self.subTest(table=table):
                def write(cur, table=table, base=base):
                    cur.execute("SET LOCAL ROLE authenticated")
                    with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                        cur.execute(f"INSERT INTO public.{table} (semantic_id, name) VALUES (%s, 'x')", (base + "x",))
                self.in_transaction(write)

                def read(cur, table=table):
                    cur.execute("SET LOCAL ROLE anon")
                    with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                        cur.execute(f"SELECT 1 FROM public.{table}")
                self.in_transaction(read)

    def test_the_checks_refuse_an_id_qudt_did_not_issue_and_a_key_twice(self):
        bad = {
            "qudt_quantity_kinds": {
                "an id minted here": "https://aber.local/semantics/qudt/Temperature",
                "a unit's id": UNIT + "A",
                "a kind twice": KIND + "Temperature",
            },
            "qudt_units": {
                "an id minted here": "https://aber.local/semantics/qudt/A",
                "a kind's id": KIND + "Temperature",
                "a unit twice": UNIT + "A",
            },
        }
        for table, cases in bad.items():
            for what, iri in cases.items():
                with self.subTest(table=table, what=what):
                    def probe(cur, table=table, iri=iri):
                        with self.assertRaises((psycopg2.errors.CheckViolation, psycopg2.errors.UniqueViolation)):
                            cur.execute(f"INSERT INTO public.{table} (semantic_id, name) VALUES (%s, 'x')", (iri,))
                    self.in_transaction(probe)


class TestTheView(QudtTestCase):
    def defined(self, cur, semantic_id):
        cur.execute("SELECT name, definition, standard FROM public.concept_definitions WHERE semantic_id = %s",
                    (semantic_id,))
        return cur.fetchall()

    def test_a_kind_is_defined_by_qudts_text(self):
        def probe(cur):
            cur.execute("SELECT name, description FROM public.qudt_quantity_kinds WHERE semantic_id = %s",
                        (KIND + "Temperature",))
            name, text = cur.fetchone()
            return name, text, self.defined(cur, KIND + "Temperature")
        name, text, rows = self.in_transaction(probe)
        self.assertEqual(rows, [(name, text, "QUDT")])

    def test_a_kind_qudt_does_not_describe_defines_nothing(self):
        self.assertEqual(self.in_transaction(lambda cur: self.defined(cur, KIND + "ActionTime")), [])

    def test_every_described_kind_is_in_the_view_with_its_own_text(self):
        self.assertEqual(self.fetch(
            "SELECT v.semantic_id FROM public.qudt_quantity_kinds v"
            "  LEFT JOIN public.concept_definitions c ON c.semantic_id = v.semantic_id"
            " WHERE NULLIF(btrim(v.description), '') IS NOT NULL"
            "   AND (c.standard IS DISTINCT FROM 'QUDT' OR c.definition IS DISTINCT FROM v.description)"), [])

    def test_qudt_comes_after_ashrae_223p_and_before_opc_ua_and_the_minted_vocabularies(self):
        """An id QUDT and a later vocabulary both hold takes QUDT's text."""
        temperature = KIND + "Temperature"

        def probe(cur):
            cur.execute("INSERT INTO public.opcua_vocabulary (name, companion_spec, description, semantic_id)"
                        " VALUES ('Fixture0304', 'OPC 0304 Fixture', 'OPC UA text', %s)", (temperature,))
            seen = [self.defined(cur, temperature)[0][2]]
            cur.execute("INSERT INTO public.iso22400_vocabulary (name, kpi_id, description, semantic_id)"
                        " VALUES ('FIXTURE_0304', 'F', 'ISO 22400 text', %s)", (temperature,))
            cur.execute("INSERT INTO public.mtconnect_vocabulary (kind, name, category, semantic_id, description)"
                        " VALUES ('DATA_ITEM_TYPE', 'FIXTURE_0304', 'EVENT', %s, 'MTConnect text')", (temperature,))
            seen.append(self.defined(cur, temperature)[0][2])
            cur.execute("INSERT INTO public.idta_submodel_templates (template_id, template_name,"
                        " template_version, id_short, semantic_id, semantic_id_type, description, ordinal)"
                        " VALUES ('urn:example:fixture-0304', 'Fixture', '1.0', 'Fixture0304', %s, 'IRI',"
                        " 'IDTA text', 1)", (temperature,))
            seen.append(self.defined(cur, temperature)[0][2])
            return seen
        self.assertEqual(self.in_transaction(probe), ["QUDT", "QUDT", "IDTA"])

    def test_each_semantic_id_appears_once_and_the_grants_are_the_views_own(self):
        self.assertEqual(self.fetch("SELECT semantic_id FROM public.concept_definitions"
                                    " GROUP BY semantic_id HAVING count(*) > 1"), [])
        self.assertEqual(
            self.fetch("SELECT has_table_privilege('authenticated', 'public.concept_definitions', 'SELECT'),"
                       "       has_table_privilege('anon', 'public.concept_definitions', 'SELECT'),"
                       "       (SELECT reloptions FROM pg_class WHERE oid = 'public.concept_definitions'::regclass)"),
            [(True, False, ["security_invoker=true"])])


class TestReplay(QudtTestCase):
    def test_replaying_the_migration_rewrites_no_row(self):
        """db-init replays the file on every boot. A row whose text is unchanged is not touched."""
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            read = ("SELECT 'k', semantic_id, xmin::text, name, description FROM public.qudt_quantity_kinds"
                    " UNION ALL SELECT 'u', semantic_id, xmin::text, name, symbol FROM public.qudt_units ORDER BY 1, 2")
            cur.execute(read)
            before = cur.fetchall()
            cur.execute(sql)
            cur.execute(read)
            return before, cur.fetchall()
        before, after = self.in_transaction(probe)
        self.assertGreater(len(before), 1000)
        self.assertEqual(after, before)

    def test_replay_puts_back_a_row_that_was_changed_or_removed(self):
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            read = ("SELECT 'k', semantic_id, name, description FROM public.qudt_quantity_kinds"
                    " UNION ALL SELECT 'u', semantic_id, name, unece_code FROM public.qudt_units ORDER BY 1, 2")
            cur.execute(read)
            before = cur.fetchall()
            cur.execute("UPDATE public.qudt_quantity_kinds SET description = 'edited by hand' WHERE semantic_id = %s",
                        (KIND + "Temperature",))
            cur.execute("DELETE FROM public.qudt_quantity_kinds WHERE semantic_id = %s", (KIND + "Pressure",))
            cur.execute("UPDATE public.qudt_units SET unece_code = 'XXX' WHERE semantic_id = %s", (UNIT + "DEG_C",))
            cur.execute("DELETE FROM public.qudt_units WHERE semantic_id = %s", (UNIT + "A",))
            cur.execute(sql)
            cur.execute(read)
            return before, cur.fetchall()
        before, after = self.in_transaction(probe)
        self.assertEqual(after, before)

    def test_the_blocks_are_the_generators_and_hold_no_table_definition(self):
        text = MIGRATION.read_text(encoding="utf-8")
        for table in ("qudt_quantity_kinds", "qudt_units"):
            block = text[text.index(f"-- >>> BEGIN GENERATED {table}"):text.index(f"-- <<< END GENERATED {table}")]
            with self.subTest(table=table):
                self.assertEqual(len(re.findall(r"^INSERT INTO ", block, re.M)), 1)
                self.assertNotIn("CREATE", block)


if __name__ == "__main__":
    unittest.main(verbosity=2)
