# suite:
#   lanes: db
#   why: 0334 -- that a Digital Nameplate row's text says what the element is. Each is exported as the
#     definition of the element's ConceptDescription, and ten were not definitions: two said an element is
#     mandatory that the template does not ask for, and eight held a note on the seed, the template's layout
#     or this platform. 0002 proposes the old texts on every boot, so a correction alone would be undone and
#     made again on every boot. Nothing fails when that happens: a wrong text is exported.

"""
The Nameplate's texts say what each element is (0334).

    python supabase/migrations/test_the_nameplates_texts_say_what_each_element_is.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).
0002's statement, 0323 and 0334 are run again as db-init runs them. EVERY TEST ROLLS BACK.
"""
import os
import pathlib
import re
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = pathlib.Path(__file__).resolve().parent
NAMEPLATE = "https://admin-shell.io/idta/nameplate/3/0/Nameplate"
MANDATORY = next(HERE.glob("0323_*.sql")).read_text(encoding="utf-8")
MIGRATION = next(HERE.glob("0334_*.sql")).read_text(encoding="utf-8")
# The one statement of 0002 that writes the table, up to its semicolon at the end of a line.
RELEASED = re.search(r"^INSERT INTO public\.idta_submodel_templates\n.*?;$",
                     (HERE / "0002_seed_data.sql").read_text(encoding="utf-8"), re.M | re.S).group(0)
# What 0002 proposes: each element's own text, as the row states it between its id's type and is_mandatory.
PROPOSED = {id_short: text.replace("''", "'") for id_short, text in re.findall(
    r"^  \('[^']+', '[^']+', '[^']+', '(\w+)', '[^']+', '(?:IRI|IRDI)', '((?:[^']|'')*)', (?:true|false), \d+\)",
    RELEASED, re.M)}
TEXTS = {
    "URIOfTheProduct": "URI the manufacturer gives this one unit, which no other product has.",
    "AddressInformation": "Contact address of the manufacturer, such as its street, postal code, town and country. "
                          "A nested collection.",
    "ManufacturerProductFamily": "Family of products the manufacturer places this product in, one level below its "
                                 "product root.",
    "ManufacturerProductType": "Type or variant of the product as the manufacturer names it, which tells it from the "
                               "others of its family.",
    "SerialNumber": "Serial number uniquely identifying this instance for its manufacturer.",
    "YearOfConstruction": "Year the product was built.",
    "FirmwareVersion": "Firmware version of the product.",
    "UniqueFacilityIdentifier": "Unique identifier of the facility the product was made in.",
    "CompanyLogo": "Manufacturer logo, as a file.",
    "AssetSpecificProperties": "Manufacturer-specific properties that are not part of the standard set. A nested "
                               "collection.",
}
# What a definition may not hold: a claim on the cardinality, or a note on the seed, the template or Aber.
NOTE = re.compile(r"mandatory|optional|todo|fixme|template|seeded|this platform|aber|sparkplug|globalAssetId|"
                  r"exported|\bhere\b|\bnamespace\b|IRDI|\bIRI\b", re.IGNORECASE)
# The row version as well as the row, so a row rewritten with the same values shows.
TUPLES = "SELECT ctid::text, xmin::text, t.* FROM public.idta_submodel_templates t ORDER BY template_id, ordinal"


class TextsCase(unittest.TestCase):
    def setUp(self):
        try:
            self.conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?") from exc
        self.cur = self.conn.cursor()

    def tearDown(self):
        if hasattr(self, "conn"):
            self.conn.rollback()
            self.conn.close()

    def fetch(self, sql, params=None):
        self.cur.execute(sql, params or ())
        return self.cur.fetchall()

    def texts(self):
        return dict(self.fetch("SELECT id_short, description FROM public.idta_submodel_templates"
                               " WHERE template_id = %s", (NAMEPLATE,)))


class TestTheTexts(TextsCase):
    def test_ten_have_their_own_and_the_other_ten_have_0002s(self):
        self.assertEqual(len(PROPOSED), 20, "0002's statement was not read")
        self.assertEqual(self.texts(), {**PROPOSED, **TEXTS})

    def test_0002_still_proposes_the_old_ones(self):
        """The reason there is a trigger. If 0002 ever agrees, its texts and this suite can go."""
        self.assertIn("Mandatory unless", PROPOSED["ManufacturerProductFamily"])
        self.assertIn("Mandatory unless", PROPOSED["ManufacturerProductType"])
        self.assertIn("the template still points", PROPOSED["AddressInformation"])
        self.assertEqual({k for k, v in PROPOSED.items() if NOTE.search(v)}, set(TEXTS))

    def test_no_text_holds_a_claim_on_the_cardinality_or_a_note_to_ourselves(self):
        self.assertEqual({k: v for k, v in self.texts().items() if NOTE.search(v)}, {})

    def test_no_definition_an_export_reads_from_the_view_holds_one_either(self):
        rows = self.fetch("SELECT name, definition FROM public.concept_definitions WHERE standard = 'IDTA'")
        self.assertGreaterEqual(len(rows), 20)
        self.assertEqual([r for r in rows if NOTE.search(r[1])], [])
        self.assertEqual({n: d for n, d in rows if n in TEXTS}, TEXTS)

    def test_each_is_a_sentence_of_ours_and_not_the_template_s(self):
        theirs = dict(self.fetch("SELECT path, definition FROM public.idta_template_elements"
                                 " WHERE template_id = %s AND parent_path IS NULL AND definition IS NOT NULL", (NAMEPLATE,)))
        self.assertIn("UniqueFacilityIdentifier", theirs)
        for id_short, text in TEXTS.items():
            with self.subTest(id_short=id_short):
                self.assertTrue(text.endswith("."))
                for sentence in text.rstrip(".").split(". "):
                    self.assertNotIn(sentence, theirs.get(id_short, ""))

    def test_the_rest_of_each_row_is_0002s_or_0323s(self):
        """The ids, their types, the order and the versions."""
        rows = self.fetch("SELECT template_name, template_version, id_short, semantic_id, semantic_id_type, ordinal"
                          " FROM public.idta_submodel_templates WHERE template_id = %s ORDER BY ordinal", (NAMEPLATE,))
        proposed = re.findall(r"^  \('[^']+', '([^']+)', '([^']+)', '(\w+)', '([^']+)', '(IRI|IRDI)', '(?:[^']|'')*',"
                              r" (?:true|false), (\d+)\)", RELEASED, re.M)
        self.assertEqual([tuple(map(str, row)) for row in rows], proposed)


class TestABoot(TextsCase):
    def test_a_second_boot_writes_no_row(self):
        """0002's upsert, 0323 and 0334, in the order db-init runs them."""
        before = self.fetch(TUPLES)
        for statement in (RELEASED, MANDATORY, MIGRATION):
            self.cur.execute(statement)
            self.assertEqual(self.fetch(TUPLES), before)

    def test_the_first_boot_of_an_upgrade_corrects_the_ten_and_the_next_boot_keeps_them(self):
        """A site on 1.9: 0002's rows as it released them, and no trigger yet."""
        self.cur.execute("DROP TRIGGER idta_submodel_template_as_generated ON public.idta_submodel_templates")
        self.cur.execute(RELEASED)
        self.assertEqual(self.texts(), PROPOSED)
        self.cur.execute(MANDATORY)
        before = {row[5]: row for row in self.fetch(TUPLES)}
        self.cur.execute(MIGRATION)
        moved = {row[5] for row in self.fetch(TUPLES) if row != before[row[5]]}
        self.assertEqual(moved, set(TEXTS))
        self.assertEqual(self.texts(), {**PROPOSED, **TEXTS})
        # And the next boot's upsert leaves them.
        corrected = self.fetch(TUPLES)
        self.cur.execute(RELEASED)
        self.assertEqual(self.fetch(TUPLES), corrected)

    def test_0323_run_alone_puts_no_text_back(self):
        """Between 0323 and 0334 a boot has 0323's body of the function, which decides no text."""
        self.cur.execute(MANDATORY)
        self.assertEqual(self.texts(), {**PROPOSED, **TEXTS})


class TestTheTrigger(TextsCase):
    def test_a_write_cannot_put_an_old_text_back(self):
        before = self.fetch(TUPLES)
        for role in ("postgres", "service_role"):
            with self.subTest(role=role):
                if role != "postgres":
                    self.cur.execute("SET LOCAL ROLE service_role")
                self.cur.execute("UPDATE public.idta_submodel_templates SET description = 'Mandatory unless.'"
                                 " WHERE template_id = %s AND id_short = ANY (%s)", (NAMEPLATE, list(TEXTS)))
                self.cur.execute("RESET ROLE")
                self.assertEqual(self.fetch(TUPLES), before)

    def test_a_text_it_does_not_give_is_written(self):
        self.cur.execute("UPDATE public.idta_submodel_templates SET description = 'Edited.'"
                         " WHERE template_id = %s AND id_short = 'ManufacturerName'", (NAMEPLATE,))
        self.assertEqual(self.texts()["ManufacturerName"], "Edited.")

    def test_another_template_s_element_of_the_same_name_keeps_its_own(self):
        self.cur.execute("INSERT INTO public.idta_submodel_templates (template_id, template_name, template_version,"
                         " id_short, semantic_id, semantic_id_type, description, is_mandatory, ordinal)"
                         " VALUES ('https://example.test/T', 'T', '1.0', 'SerialNumber', 'https://example.test/Serial',"
                         " 'IRI', 'Its own.', true, 1)")
        self.assertEqual(self.fetch("SELECT description, is_mandatory FROM public.idta_submodel_templates"
                                    " WHERE template_id = 'https://example.test/T'"), [("Its own.", True)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
