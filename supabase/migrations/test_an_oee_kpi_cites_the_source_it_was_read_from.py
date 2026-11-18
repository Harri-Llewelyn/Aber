# suite:
#   lanes: db
#   why: The four OEE KPIs cite OPC 40501-1 Annex C (0305), concept_sources names where a definition
#     comes from, and the four KPIs no free source publishes are deprecated with their reason. A source
#     dropped, a description that quotes an ISO name the annex does not use, a view that lost an arm or a
#     deprecation that reached an OEE row breaks nothing at runtime: the panel shows no source, an
#     export defines the concept without saying where the definition came from, and the tab calls a
#     live KPI deprecated.

"""
`iso22400_vocabulary.source` and `.deprecated_reason`, the corrected descriptions and the `concept_sources`
view, as 0305 leaves them on a migrated database. Each probe runs in a transaction that is rolled back.

    python supabase/migrations/test_an_oee_kpi_cites_the_source_it_was_read_from.py
"""
import os
import pathlib
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("POSTGRES_PASSWORD", "postgres"))

HERE = pathlib.Path(__file__).resolve().parent
MIGRATION = next(HERE.glob("0305_*.sql"))
SEED = HERE / "0002_seed_data.sql"
ISO = "https://aber.local/semantics/iso22400/"
KIND = "http://qudt.org/vocab/quantitykind/"
QUDT_SOURCE = "QUDT 3.5.2, QUDT.org, CC BY 4.0"
OEE = ["AVAILABILITY", "EFFECTIVENESS", "QUALITY", "OEE"]
OTHERS = ["MTBF", "MTTR", "SCRAP_RATIO", "UTILIZATION"]
CITATION = "OPC 40501-1 v1.02.0, Annex C.2.4 (informative)"


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class SourceTestCase(unittest.TestCase):
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


class TestTheOeeRows(SourceTestCase):
    def rows(self):
        return {r[0]: r[1:] for r in self.fetch(
            "SELECT name, description, formula, source FROM public.iso22400_vocabulary")}

    def test_the_four_oee_kpis_cite_the_annex_and_the_others_cite_nothing(self):
        rows = self.rows()
        for name in OEE:
            with self.subTest(name=name):
                self.assertTrue(rows[name][2].startswith(CITATION + ': "'), rows[name][2])
                self.assertIn("takes its KPI definitions from ISO 22400-2", rows[name][2])
        for name in OTHERS:
            with self.subTest(name=name):
                self.assertIsNone(rows[name][2])

    def test_each_source_gives_the_formula_the_annex_gives_in_its_words(self):
        rows = self.rows()
        self.assertIn('"Availability = APT / PBT"', rows["AVAILABILITY"][2])
        self.assertIn('"Effectiveness = PRI x PQ / APT"', rows["EFFECTIVENESS"][2])
        self.assertIn('"Quality rate = GQ / PQ"', rows["QUALITY"][2])
        self.assertIn("is the product of Availability, Effectiveness and Quality Rate", rows["OEE"][2])

    def test_the_formulas_are_the_annexs_with_the_kpis_symbol_in_front(self):
        rows = self.rows()
        self.assertEqual({n: rows[n][1] for n in OEE}, {
            "AVAILABILITY": "A = APT / PBT", "EFFECTIVENESS": "E = (PRI x PQ) / APT",
            "QUALITY": "Q = GQ / PQ", "OEE": "OEE = A x E x Q"})

    def test_a_description_uses_the_annexs_words_and_quotes_no_iso_name_the_annex_does_not_give(self):
        rows = self.rows()
        for name in OEE:
            with self.subTest(name=name):
                self.assertNotIn("ISO 22400-2", rows[name][0])
                self.assertNotIn("Quality ratio", rows[name][0])
                self.assertNotIn("OEE index", rows[name][0])
                self.assertNotIn("\n", rows[name][0])
        self.assertIn("actual production time (APT) as a share of planned busy time (PBT)", rows["AVAILABILITY"][0])
        self.assertIn("planned run time per item (PRI)", rows["EFFECTIVENESS"][0])
        self.assertTrue(rows["QUALITY"][0].startswith("Quality rate: good quantity (GQ)"))
        # The disambiguation from MTConnect's own AVAILABILITY is kept.
        self.assertIn("NOT MTConnect AVAILABILITY", rows["AVAILABILITY"][0])

    def test_the_column_is_documented(self):
        comment = self.fetch("SELECT col_description('public.iso22400_vocabulary'::regclass,"
                             " (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.iso22400_vocabulary'::regclass"
                             "   AND attname = 'source'))")[0][0]
        self.assertIn("OPC 40501-1", comment)
        self.assertIn("sourceOfDefinition", comment)


class TestTheDeprecation(SourceTestCase):
    def rows(self):
        return {r[0]: r[1:] for r in self.fetch(
            "SELECT name, description, deprecated_reason FROM public.iso22400_vocabulary")}

    def test_the_four_kpis_no_free_source_publishes_are_deprecated_with_a_reason_and_the_oee_four_are_live(self):
        rows = self.rows()
        for name in OTHERS:
            with self.subTest(name=name):
                self.assertTrue(rows[name][1].strip())
                self.assertIn("removed no sooner than 1.10.0", rows[name][1])
        for name in OEE:
            with self.subTest(name=name):
                self.assertIsNone(rows[name][1])

    def test_utilization_says_it_is_not_an_iso_22400_kpi_and_the_others_say_no_free_source_publishes_them(self):
        rows = self.rows()
        self.assertTrue(rows["UTILIZATION"][1].startswith("Not an ISO 22400 KPI"))
        for name in ("SCRAP_RATIO", "MTBF", "MTTR"):
            with self.subTest(name=name):
                self.assertTrue(rows[name][1].startswith("No free source publishes this KPI's formula"))
                self.assertIn("A site that owns ISO 22400-2 can import it on the Vocabulary page.", rows[name][1])

    def test_utilization_no_longer_asks_a_reader_to_verify_it_against_the_standard(self):
        text = self.rows()["UTILIZATION"][0]
        self.assertNotIn("Verify against the standard", text)
        self.assertIn("not a KPI of ISO 22400-2 itself", text)

    def test_the_rows_their_groups_and_their_example_metrics_stay_in_1_9(self):
        self.assertEqual(set(OTHERS) | set(OEE), set(self.rows()))
        groups = {r[0] for r in self.fetch("SELECT name FROM public.metric_groups WHERE standard = 'ISO 22400'")}
        self.assertTrue({"OEE", "Quality", "Utilization", "Maintenance"} <= groups)

    def test_a_deprecated_kpi_still_defines_its_concept(self):
        rows = self.fetch("SELECT c.standard FROM public.concept_definitions c WHERE c.semantic_id = %s", (ISO + "MTBF",))
        self.assertEqual(rows, [("ISO 22400",)])

    def test_the_column_is_documented(self):
        comment = self.fetch("SELECT col_description('public.iso22400_vocabulary'::regclass,"
                             " (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.iso22400_vocabulary'::regclass"
                             "   AND attname = 'deprecated_reason'))")[0][0]
        self.assertIn("NULL for a live row", comment)


class TestTheView(SourceTestCase):
    def test_its_columns_are_the_two_it_is_fixed_to(self):
        self.assertEqual([r[0] for r in self.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'"
            " AND table_name = 'concept_sources' ORDER BY ordinal_position")], ["semantic_id", "source"])

    def test_an_oee_kpi_is_in_it_with_its_own_source(self):
        rows = dict(self.fetch("SELECT semantic_id, source FROM public.concept_sources WHERE semantic_id LIKE %s", (ISO + "%",)))
        sources = dict(self.fetch("SELECT semantic_id, source FROM public.iso22400_vocabulary WHERE source IS NOT NULL"))
        self.assertEqual(rows, sources)
        self.assertEqual(set(rows), {ISO + name for name in OEE})

    def test_a_quantity_kind_is_in_it_credited_to_qudt_even_where_it_has_no_description(self):
        rows = dict(self.fetch("SELECT semantic_id, source FROM public.concept_sources WHERE semantic_id LIKE %s", (KIND + "%",)))
        self.assertEqual(rows[KIND + "Temperature"], QUDT_SOURCE)
        self.assertEqual(rows[KIND + "ActionTime"], QUDT_SOURCE)
        self.assertEqual({s for s in rows.values()}, {QUDT_SOURCE})
        self.assertEqual(len(rows), self.fetch("SELECT count(*) FROM public.qudt_quantity_kinds")[0][0])

    def test_a_kpi_with_no_source_and_a_blank_one_are_left_out(self):
        def probe(cur):
            cur.execute("UPDATE public.iso22400_vocabulary SET source = '   ' WHERE name = 'OEE'")
            cur.execute("SELECT semantic_id FROM public.concept_sources WHERE semantic_id IN (%s, %s)",
                        (ISO + "OEE", ISO + "MTBF"))
            return cur.fetchall()
        self.assertEqual(self.in_transaction(probe), [])

    def test_an_id_both_arms_hold_takes_qudts(self):
        temperature = KIND + "Temperature"

        def probe(cur):
            cur.execute("INSERT INTO public.iso22400_vocabulary (name, kpi_id, description, semantic_id, source)"
                        " VALUES ('FIXTURE_0305', 'F', 'x', %s, 'ISO fixture source')", (temperature,))
            cur.execute("SELECT source FROM public.concept_sources WHERE semantic_id = %s", (temperature,))
            return cur.fetchall()
        self.assertEqual(self.in_transaction(probe), [(QUDT_SOURCE,)])

    def test_each_semantic_id_appears_once_and_the_grants_are_the_views_own(self):
        self.assertEqual(self.fetch("SELECT semantic_id FROM public.concept_sources"
                                    " GROUP BY semantic_id HAVING count(*) > 1"), [])
        self.assertEqual(
            self.fetch("SELECT has_table_privilege('authenticated', 'public.concept_sources', 'SELECT'),"
                       "       has_table_privilege('anon', 'public.concept_sources', 'SELECT'),"
                       "       has_table_privilege('authenticated', 'public.concept_sources', 'INSERT'),"
                       "       has_table_privilege('service_role', 'public.concept_sources', 'SELECT'),"
                       "       (SELECT reloptions FROM pg_class WHERE oid = 'public.concept_sources'::regclass)"),
            [(True, False, False, True, ["security_invoker=true"])])

    def test_a_signed_in_person_reads_it_and_anon_cannot(self):
        def signed_in(cur):
            cur.execute("SET LOCAL ROLE authenticated")
            cur.execute("SELECT count(*) FROM public.concept_sources WHERE semantic_id LIKE %s", (ISO + "%",))
            return cur.fetchone()[0]
        self.assertEqual(self.in_transaction(signed_in), len(OEE))

        def anon(cur):
            cur.execute("SET LOCAL ROLE anon")
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT 1 FROM public.concept_sources")
        self.in_transaction(anon)

    def test_concept_definitions_still_has_its_four_columns(self):
        self.assertEqual([r[0] for r in self.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'"
            " AND table_name = 'concept_definitions' ORDER BY ordinal_position")],
            ["semantic_id", "name", "definition", "standard"])


class TestReplay(SourceTestCase):
    def test_replaying_the_migration_rewrites_no_row(self):
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            read = "SELECT name, xmin::text, description, source, deprecated_reason FROM public.iso22400_vocabulary ORDER BY name"
            cur.execute(read)
            before = cur.fetchall()
            cur.execute(sql)
            cur.execute(read)
            return before, cur.fetchall()
        before, after = self.in_transaction(probe)
        self.assertEqual(after, before)

    def test_replay_puts_back_a_source_or_a_description_that_was_changed(self):
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            read = "SELECT name, description, source, deprecated_reason FROM public.iso22400_vocabulary ORDER BY name"
            cur.execute(read)
            before = cur.fetchall()
            cur.execute("UPDATE public.iso22400_vocabulary SET source = 'edited', description = 'edited' WHERE name = 'QUALITY'")
            cur.execute("UPDATE public.iso22400_vocabulary SET source = NULL WHERE name = 'OEE'")
            cur.execute("UPDATE public.iso22400_vocabulary SET deprecated_reason = NULL WHERE name = 'MTBF'")
            cur.execute("UPDATE public.iso22400_vocabulary SET deprecated_reason = 'edited' WHERE name = 'AVAILABILITY'")
            cur.execute(sql)
            cur.execute(read)
            return before, cur.fetchall()
        before, after = self.in_transaction(probe)
        self.assertEqual(after, before)

    def test_the_chain_ends_a_boot_as_0305_leaves_it_though_0002_puts_the_released_text_back(self):
        """db-init replays 0002 first: its upsert restores the old descriptions, and 0305 corrects them again."""
        seed = SEED.read_text(encoding="utf-8")
        sql = MIGRATION.read_text(encoding="utf-8")
        # The eight upserts 0002 holds, from the first to the end of the last.
        start = seed.index("INSERT INTO public.iso22400_vocabulary VALUES ('AVAILABILITY'")
        last = seed.index("INSERT INTO public.iso22400_vocabulary VALUES ('MTTR'")
        closing = "semantic_id = EXCLUDED.semantic_id;"
        block = seed[start:seed.index(closing, last) + len(closing)]

        def probe(cur):
            read = "SELECT name, description, source, deprecated_reason FROM public.iso22400_vocabulary ORDER BY name"
            cur.execute(read)
            before = cur.fetchall()
            cur.execute(block)
            cur.execute("SELECT description FROM public.iso22400_vocabulary WHERE name = 'QUALITY'")
            restored = cur.fetchone()[0]
            cur.execute(sql)
            cur.execute(read)
            return before, restored, cur.fetchall()
        before, restored, after = self.in_transaction(probe)
        self.assertIn('ISO 22400-2 "Quality ratio"', restored)
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
