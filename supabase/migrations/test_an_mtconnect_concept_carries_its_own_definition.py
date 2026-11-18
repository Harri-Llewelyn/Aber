# suite:
#   lanes: db
#   why: An MTConnect data item type is defined by the text MTConnect publishes (0301). Nothing
#     else notices a type that lost its definition: the export falls back to a metric's own words
#     or to a sentence naming the concept, and both read as a definition.

"""
`mtconnect_vocabulary.description` and the MTConnect arm of `concept_definitions`, as 0301 leaves
them on a migrated database. Each probe runs in a transaction that is rolled back.

    python supabase/migrations/test_an_mtconnect_concept_carries_its_own_definition.py

The text is checked against the XSD it was read from (scripts/vocabularies/), so a regenerated block
that drifts from the source, or a row the UPDATE missed, fails here as well as in
scripts/check-mtconnect-seed-sync.mjs.
"""
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

MIGRATION = pathlib.Path(__file__).resolve().parent / "0301_an_mtconnect_concept_carries_its_own_definition.sql"
MTC = "https://aber.local/semantics/mtconnect/v2.0/"
# What MTConnect's own text says of three types, as the issue quotes the XSD.
KNOWN = {
    "POSITION": "point along an axis in a cartesian coordinate system.",
    "EXECUTION": "operating state of a Component.",
    "TEMPERATURE": "degree of hotness or coldness measured on a definite scale.",
}
# What the markup would leave behind if it were not rendered out.
MARKUP = re.compile(r"\{\{|\}\}|[*`<>]|&[a-z#0-9]+;")


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class MtconnectDefinitionTestCase(unittest.TestCase):
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


class TestTheColumn(MtconnectDefinitionTestCase):
    def test_description_is_a_nullable_text_column(self):
        rows = self.fetch("SELECT data_type, is_nullable FROM information_schema.columns"
                          " WHERE table_schema = 'public' AND table_name = 'mtconnect_vocabulary'"
                          "   AND column_name = 'description'")
        self.assertEqual(rows, [("text", "YES")])

    def test_the_known_types_carry_the_text_mtconnect_publishes(self):
        for name, text in KNOWN.items():
            with self.subTest(name=name):
                self.assertEqual(
                    self.fetch("SELECT description FROM public.mtconnect_vocabulary"
                               " WHERE kind = 'DATA_ITEM_TYPE' AND name = %s", (name,)),
                    [(text,)])

    def test_a_type_the_xsd_does_not_document_has_none(self):
        # ELEVATION arrived in 2.8, and the 2.7 XSD is the newest published.
        self.assertEqual(
            self.fetch("SELECT description FROM public.mtconnect_vocabulary"
                       " WHERE kind = 'DATA_ITEM_TYPE' AND name = 'ELEVATION'"), [(None,)])

    def test_only_a_data_item_type_has_one(self):
        self.assertEqual(
            self.fetch("SELECT kind, name FROM public.mtconnect_vocabulary"
                       " WHERE description IS NOT NULL AND kind <> 'DATA_ITEM_TYPE'"), [])

    def test_no_description_still_carries_the_models_markup(self):
        rows = self.fetch("SELECT name, description FROM public.mtconnect_vocabulary"
                          " WHERE description IS NOT NULL")
        self.assertTrue(rows)
        self.assertEqual([name for name, text in rows if MARKUP.search(text) or text != text.strip()
                          or text == "" or "\n" in text], [])


class TestTheView(MtconnectDefinitionTestCase):
    def test_a_data_item_type_is_defined_by_mtconnects_text(self):
        for name, text in KNOWN.items():
            with self.subTest(name=name):
                self.assertEqual(
                    self.fetch("SELECT name, definition, standard FROM public.concept_definitions"
                               " WHERE semantic_id = %s", (f"{MTC}DataItemType/{name}",)),
                    [(name, text, "MTConnect")])

    def test_a_type_with_no_text_defines_nothing(self):
        self.assertEqual(
            self.fetch("SELECT 1 FROM public.concept_definitions WHERE semantic_id = %s",
                       (f"{MTC}DataItemType/ELEVATION",)), [])

    def test_every_described_row_is_in_the_view_and_nothing_else_of_mtconnect_is(self):
        self.assertEqual(self.fetch(
            "SELECT v.semantic_id FROM public.mtconnect_vocabulary v"
            "  LEFT JOIN public.concept_definitions c ON c.semantic_id = v.semantic_id"
            " WHERE (NULLIF(btrim(v.description), '') IS NOT NULL"
            "        AND (c.standard IS DISTINCT FROM 'MTConnect' OR c.definition IS DISTINCT FROM v.description))"
            "    OR (NULLIF(btrim(v.description), '') IS NULL AND c.standard = 'MTConnect')"), [])

    def test_mtconnect_comes_after_iso_22400_in_precedence(self):
        """An id both hold takes ISO 22400's text: MTConnect is the last arm of the view."""
        position = f"{MTC}DataItemType/POSITION"

        def probe(cur):
            cur.execute("INSERT INTO public.iso22400_vocabulary (name, kpi_id, description, semantic_id)"
                        " VALUES ('FIXTURE_0301', 'F', 'ISO 22400 text', %s)", (position,))
            cur.execute("SELECT definition, standard FROM public.concept_definitions WHERE semantic_id = %s",
                        (position,))
            return cur.fetchall()
        self.assertEqual(self.in_transaction(probe), [("ISO 22400 text", "ISO 22400")])

    def test_the_view_still_applies_the_callers_policies_and_withholds_anon(self):
        self.assertEqual(
            self.fetch("SELECT has_table_privilege('authenticated', 'public.concept_definitions', 'SELECT'),"
                       "       has_table_privilege('anon', 'public.concept_definitions', 'SELECT'),"
                       "       has_table_privilege('authenticated', 'public.concept_definitions', 'INSERT'),"
                       "       (SELECT reloptions FROM pg_class WHERE oid = 'public.concept_definitions'::regclass)"),
            [(True, False, False, ["security_invoker=true"])])


class TestReplay(MtconnectDefinitionTestCase):
    def test_replaying_the_migration_rewrites_no_row(self):
        """db-init replays the file on every boot. A row whose text is unchanged is not touched."""
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            cur.execute("SELECT kind, name, xmin::text, description FROM public.mtconnect_vocabulary"
                        " ORDER BY kind, name")
            before = cur.fetchall()
            cur.execute(sql)
            cur.execute("SELECT kind, name, xmin::text, description FROM public.mtconnect_vocabulary"
                        " ORDER BY kind, name")
            return before, cur.fetchall()
        before, after = self.in_transaction(probe)
        self.assertTrue(before)
        self.assertEqual(after, before)

    def test_replay_restores_a_text_that_was_changed(self):
        """The text is upstream's, so a change by hand does not outlive the next boot."""
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            cur.execute("UPDATE public.mtconnect_vocabulary SET description = 'edited by hand'"
                        " WHERE kind = 'DATA_ITEM_TYPE' AND name = 'POSITION'")
            cur.execute(sql)
            cur.execute("SELECT description FROM public.mtconnect_vocabulary"
                        " WHERE kind = 'DATA_ITEM_TYPE' AND name = 'POSITION'")
            return cur.fetchall()
        self.assertEqual(self.in_transaction(probe), [(KNOWN["POSITION"],)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
