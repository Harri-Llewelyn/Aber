# suite:
#   lanes: db
#   why: 0323 -- that the released Digital Nameplate rows say what version 3.0 of the template asks for,
#     and go on saying it. 0002 is replayed on every boot and proposes version 2.0's answer for two of
#     them, so a correction alone would be undone and made again on every boot, with the old answer on
#     the Nameplate dialog in between. Nothing fails when that happens: a field is asked for that is not
#     needed, and one that is needed is not.

"""
A released template row is mandatory as the template has it (0323).

    python supabase/migrations/test_a_released_template_row_is_mandatory_as_the_template_has_it.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).
0002's statement and 0323 are run again as db-init runs them. EVERY TEST ROLLS BACK.
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
MIGRATION = next(HERE.glob("0323_*.sql")).read_text(encoding="utf-8")
# The one statement of 0002 that writes the table, up to its semicolon at the end of a line.
RELEASED = re.search(r"^INSERT INTO public\.idta_submodel_templates\n.*?;$",
                     (HERE / "0002_seed_data.sql").read_text(encoding="utf-8"), re.M | re.S).group(0)
SWAPPED = {"OrderCodeOfManufacturer": True, "YearOfConstruction": False}
# The row version as well as the row, so a row rewritten with the same values shows.
TUPLES = "SELECT ctid::text, xmin::text, t.* FROM public.idta_submodel_templates t ORDER BY template_id, ordinal"


class ReleasedRowsCase(unittest.TestCase):
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

    def mandatory(self):
        return dict(self.fetch("SELECT id_short, is_mandatory FROM public.idta_submodel_templates"
                               " WHERE template_id = %s AND id_short = ANY (%s)", (NAMEPLATE, list(SWAPPED))))


class TestTheRows(ReleasedRowsCase):
    def test_the_year_is_optional_and_the_order_code_is_mandatory(self):
        self.assertEqual(self.mandatory(), SWAPPED)

    def test_every_one_of_the_20_rows_is_mandatory_as_its_cardinality_has_it(self):
        rows = self.fetch(
            "SELECT t.id_short, t.is_mandatory, e.cardinality IN ('One', 'OneToMany')"
            "  FROM public.idta_submodel_templates t"
            "  JOIN public.idta_template_elements e ON e.template_id = t.template_id AND e.path = t.id_short"
            " WHERE t.template_id = %s AND e.cardinality IS NOT NULL", (NAMEPLATE,))
        self.assertEqual(len(rows), 20)
        self.assertEqual([r[0] for r in rows if r[1] is not r[2]], [])

    def test_0002_still_proposes_version_2s_answer(self):
        """The reason there is a trigger. If 0002 ever agrees, the trigger and this suite can go."""
        self.assertRegex(RELEASED, r"'OrderCodeOfManufacturer'[^\n]*, false, 8\)")
        self.assertRegex(RELEASED, r"'YearOfConstruction'[^\n]*, true, 11\)")


class TestABoot(ReleasedRowsCase):
    def test_a_second_boot_writes_no_row(self):
        """0002's upsert and 0323, in the order db-init runs them."""
        before = self.fetch(TUPLES)
        self.assertGreaterEqual(len(before), 20)
        self.cur.execute(RELEASED)
        self.assertEqual(self.fetch(TUPLES), before)
        self.cur.execute(MIGRATION)
        self.assertEqual(self.fetch(TUPLES), before)

    def test_the_two_rows_are_corrected_where_an_earlier_release_left_them(self):
        """A site on 1.9: 0002's rows as it released them, and no trigger yet."""
        self.cur.execute("DROP TRIGGER idta_submodel_template_as_generated ON public.idta_submodel_templates")
        self.cur.execute(RELEASED)
        self.assertEqual(self.mandatory(), {k: not v for k, v in SWAPPED.items()})
        self.cur.execute(MIGRATION)
        self.assertEqual(self.mandatory(), SWAPPED)
        # And the next boot's upsert leaves them.
        self.cur.execute(RELEASED)
        self.assertEqual(self.mandatory(), SWAPPED)

    def test_only_the_rows_that_differ_are_written_by_the_correction(self):
        self.cur.execute("DROP TRIGGER idta_submodel_template_as_generated ON public.idta_submodel_templates")
        self.cur.execute("UPDATE public.idta_submodel_templates SET is_mandatory = NOT is_mandatory"
                         " WHERE template_id = %s AND id_short = ANY (%s)", (NAMEPLATE, list(SWAPPED)))
        before = {row[5]: row for row in self.fetch(TUPLES)}
        self.cur.execute(MIGRATION)
        moved = {row[5] for row in self.fetch(TUPLES) if row != before[row[5]]}
        self.assertEqual(moved, set(SWAPPED))

    def test_a_corrected_text_still_reaches_the_table(self):
        """The trigger decides is_mandatory and nothing else: 0002 may still correct a description."""
        self.cur.execute(RELEASED.replace("Legal name of the manufacturer.", "The manufacturer's legal name."
                                          .replace("'", "''")))
        self.assertEqual(
            self.fetch("SELECT description, is_mandatory FROM public.idta_submodel_templates"
                       " WHERE template_id = %s AND id_short = 'ManufacturerName'", (NAMEPLATE,)),
            [("The manufacturer's legal name.", True)])


class TestTheTrigger(ReleasedRowsCase):
    def test_a_write_cannot_make_a_row_disagree_with_its_template(self):
        self.cur.execute("UPDATE public.idta_submodel_templates SET is_mandatory = NOT is_mandatory"
                         " WHERE template_id = %s", (NAMEPLATE,))
        self.assertEqual(self.cur.rowcount, 0)
        self.assertEqual(self.mandatory(), SWAPPED)
        # Nor the service key's, the one API role that may write the table.
        self.cur.execute("SET LOCAL ROLE service_role")
        self.cur.execute("UPDATE public.idta_submodel_templates SET is_mandatory = true WHERE id_short = 'YearOfConstruction'")
        self.cur.execute("RESET ROLE")
        self.assertEqual(self.mandatory(), SWAPPED)

    def test_a_row_the_generated_table_does_not_hold_keeps_what_it_says(self):
        insert = ("INSERT INTO public.idta_submodel_templates (template_id, template_name, template_version, id_short,"
                  " semantic_id, semantic_id_type, is_mandatory, ordinal)"
                  " VALUES ('https://example.test/T', 'T', '1.0', 'Sample', 'https://example.test/Sample', 'IRI', %s, 1)")
        for stated in (True, False):
            with self.subTest(is_mandatory=stated):
                self.cur.execute("SAVEPOINT one")
                self.cur.execute(insert, (stated,))
                self.assertEqual(self.fetch("SELECT is_mandatory FROM public.idta_submodel_templates"
                                            " WHERE template_id = 'https://example.test/T'"), [(stated,)])
                self.cur.execute("ROLLBACK TO SAVEPOINT one")

    def test_its_function_is_pinned_and_no_api_role_may_run_it(self):
        self.assertEqual(
            self.fetch("SELECT prosecdef, proconfig FROM pg_proc"
                       " WHERE oid = 'public.idta_submodel_template_as_generated()'::regprocedure"),
            [(False, ["search_path=public, pg_catalog"])])
        self.assertEqual(
            self.fetch("SELECT r FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r"
                       " WHERE has_function_privilege(r, 'public.idta_submodel_template_as_generated()', 'EXECUTE')"), [])

    def test_who_may_write_the_table_has_not_changed(self):
        self.assertEqual(
            self.fetch("SELECT r, p FROM unnest(ARRAY['anon', 'authenticated']) r,"
                       " unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) p"
                       " WHERE has_table_privilege(r, 'public.idta_submodel_templates', p)"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
