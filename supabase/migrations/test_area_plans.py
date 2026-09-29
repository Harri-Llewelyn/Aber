"""
Plans and places (`0098`, `0113`): an area carries one plan, a cell takes a place on it, and the
places on one plan keep their distance.

Run against the migrated Supabase Postgres -- `npm run test:db` gives it a throwaway one.

The properties a reasonable person would simplify away, each asserted here:

  * A PLACE BELONGS TO ONE AREA'S PLAN. Moving a cell to another area drops the place it had,
    because the same two fractions mean somewhere else on a different drawing -- unless the same
    write names a new place, which is how the Cells page files and places at once.

  * THE SPACING IS ENFORCED BY THE DATABASE, not by the picker that refuses the click: an approved
    proposal writes the same columns and would otherwise land two cells on one spot.

  * THE FLOOR IS GONE, AND STAYS GONE. `0098` recreated `area_floors` on every boot before `0113`
    was written; db-init replays the whole chain in filename order with no ledger, so a floor
    table that came back would be dropped and recreated forever. Asserted as an end state, which
    is the same on the first boot and the fiftieth.
"""
import os
import unittest

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Pinned so a run that dies before teardown leaves nothing a later run collides with. The block
# is distinct from every other suite's.
AREA = "8a000000-0000-4000-8000-000000000001"
AREA_TWO = "8a000000-0000-4000-8000-000000000002"
CELL = "8c000000-0000-4000-8000-000000000001"
CELL_TWO = "8cf00000-0000-4000-8000-000000000001"


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
                            user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def cleanup(cur):
    cur.execute("DELETE FROM public.cells WHERE id IN (%s, %s);", (CELL, CELL_TWO))
    cur.execute("DELETE FROM public.areas WHERE id IN (%s, %s);", (AREA, AREA_TWO))


class PlansBase(unittest.TestCase):
    """Two areas and no cells at the start of every test; everything rolled back at the end."""

    def setUp(self):
        self.conn = connect()
        self.cur = self.conn.cursor()
        cleanup(self.cur)
        self.cur.execute(
            "INSERT INTO public.areas (id, name) VALUES (%s, 'Plan Test Area'), (%s, 'Plan Test Annexe');",
            (AREA, AREA_TWO),
        )
        self.conn.commit()

    def tearDown(self):
        self.conn.rollback()
        cleanup(self.cur)
        self.conn.commit()
        self.conn.close()

    def add_cell(self, cell_id, name, area=None, x=None, y=None):
        self.cur.execute(
            "INSERT INTO public.cells (id, name, area_id, plan_x, plan_y) VALUES (%s, %s, %s, %s, %s);",
            (cell_id, name, area, x, y),
        )

    def cell_place(self, cell_id):
        """(area_id, plan_x, plan_y) as plain strings and floats, for equality."""
        self.cur.execute("SELECT area_id::text, plan_x, plan_y FROM public.cells WHERE id = %s;", (cell_id,))
        area, x, y = self.cur.fetchone()
        return (area, None if x is None else float(x), None if y is None else float(y))


class TestTheFloorIsRetired(PlansBase):
    def test_the_floor_table_and_column_are_gone(self):
        self.cur.execute("SELECT to_regclass('public.area_floors');")
        self.assertIsNone(self.cur.fetchone()[0])
        self.cur.execute(
            "SELECT 1 FROM information_schema.columns "
            " WHERE table_schema = 'public' AND table_name = 'cells' AND column_name IN ('floor', 'floor_id');"
        )
        self.assertIsNone(self.cur.fetchone())

    def test_the_floor_functions_are_gone(self):
        self.cur.execute(
            "SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace "
            "   AND proname IN ('floor_level_name', 'area_gets_a_ground_floor', 'guard_floor_delete', "
            "                   'place_cell_on_its_floor') ORDER BY proname;"
        )
        self.assertEqual(self.cur.fetchall(), [])

    def test_an_area_is_created_with_nothing_under_it(self):
        # The ground-floor trigger is gone with the table it wrote to; an area is just a row.
        self.cur.execute("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_areas_ground_floor';")
        self.assertEqual(self.cur.fetchone()[0], 0)


class TestAPlaceBelongsToOneAreasPlan(PlansBase):
    def test_a_place_needs_an_area(self):
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.add_cell(CELL, "Plan Test Cell", None, 0.5, 0.5)

    def test_a_place_is_a_pair_within_the_plan(self):
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.add_cell(CELL, "Plan Test Cell", AREA, 0.5, None)
        self.conn.rollback()
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.add_cell(CELL, "Plan Test Cell", AREA, 1.5, 0.5)

    def test_moving_the_area_drops_a_place_that_means_somewhere_else(self):
        self.add_cell(CELL, "Plan Test Cell", AREA, 0.25, 0.25)
        self.cur.execute("UPDATE public.cells SET area_id = %s WHERE id = %s;", (AREA_TWO, CELL))
        self.assertEqual(self.cell_place(CELL), (AREA_TWO, None, None))

    def test_a_move_that_names_a_place_keeps_it(self):
        # One write from the Cells page files the cell and places it; the trigger must not undo
        # the half it was given.
        self.add_cell(CELL, "Plan Test Cell", AREA, 0.25, 0.25)
        self.cur.execute(
            "UPDATE public.cells SET area_id = %s, plan_x = 0.6, plan_y = 0.7 WHERE id = %s;",
            (AREA_TWO, CELL),
        )
        self.assertEqual(self.cell_place(CELL), (AREA_TWO, 0.6, 0.7))

    def test_unfiling_clears_the_place(self):
        self.add_cell(CELL, "Plan Test Cell", AREA, 0.25, 0.25)
        self.cur.execute("UPDATE public.cells SET area_id = NULL WHERE id = %s;", (CELL,))
        self.assertEqual(self.cell_place(CELL), (None, None, None))

    def test_deleting_the_area_unfiles_its_cells_and_takes_the_place_with_it(self):
        self.add_cell(CELL, "Plan Test Cell", AREA, 0.5, 0.5)
        self.cur.execute("DELETE FROM public.areas WHERE id = %s;", (AREA,))
        self.assertEqual(self.cell_place(CELL), (None, None, None))


class TestCellsKeepTheirDistance(PlansBase):
    def setUp(self):
        super().setUp()
        self.add_cell(CELL, "Plan Test Cell", AREA, 0.50, 0.50)

    def test_a_second_cell_too_close_is_refused_and_the_neighbour_is_named(self):
        with self.assertRaises(psycopg2.errors.CheckViolation) as raised:
            self.add_cell(CELL_TWO, "Plan Test Cell Two", AREA, 0.52, 0.50)
        self.assertIn("Plan Test Cell", str(raised.exception))

    def test_a_second_cell_far_enough_away_is_accepted(self):
        self.add_cell(CELL_TWO, "Plan Test Cell Two", AREA, 0.70, 0.50)
        self.assertEqual(self.cell_place(CELL_TWO)[1:], (0.7, 0.5))

    def test_the_distance_is_measured_in_the_plan_shorter_side(self):
        # On the default 4:3 outline a horizontal step counts 4/3 as much as a vertical one, so a
        # gap that is too close vertically is far enough horizontally.
        self.cur.execute("SELECT public.plan_distance(0.5, 0.5, 0.56, 0.5, NULL), public.plan_distance(0.5, 0.5, 0.5, 0.56, NULL);")
        across, down = self.cur.fetchone()
        self.assertGreater(across, down)
        self.assertAlmostEqual(float(across), 0.08, places=3)

    def test_an_archived_neighbour_does_not_hold_its_ground(self):
        self.cur.execute("UPDATE public.cells SET is_archived = true WHERE id = %s;", (CELL,))
        self.add_cell(CELL_TWO, "Plan Test Cell Two", AREA, 0.52, 0.50)

    def test_another_area_is_another_plan(self):
        self.add_cell(CELL_TWO, "Plan Test Cell Two", AREA_TWO, 0.50, 0.50)

    def test_the_spacing_is_the_setting(self):
        self.cur.execute("UPDATE public.system_settings SET value = to_jsonb(0.01) WHERE key = 'site_map.min_pin_spacing';")
        self.add_cell(CELL_TWO, "Plan Test Cell Two", AREA, 0.52, 0.50)


class TestTheAreaCarriesThePlan(PlansBase):
    def test_the_cell_lane_admits_the_place_and_neither_floor_column(self):
        self.cur.execute("SELECT public.proposable_columns('cells');")
        columns = self.cur.fetchone()[0]
        for column in ("plan_x", "plan_y", "area_id"):
            self.assertIn(column, columns)
        self.assertNotIn("floor", columns)
        self.assertNotIn("floor_id", columns)

    def test_the_retired_floor_table_is_no_longer_in_the_asset_lane(self):
        # Fail-closed is the rule for an entity_type nobody classified.
        self.cur.execute("SELECT public.audit_domain_for('area_floors', 'INSERT');")
        self.assertEqual(self.cur.fetchone()[0], "security")
        self.cur.execute("SELECT public.audit_domain_for('areas', 'INSERT');")
        self.assertEqual(self.cur.fetchone()[0], "asset")

    def test_the_plan_path_is_confined_to_an_existing_area(self):
        ok = f"{AREA}/plan-1.svg"
        no_such_area = "8a000000-0000-4000-8000-0000000000ff/plan-1.svg"
        not_svg = f"{AREA}/plan-1.png"
        too_deep = f"{AREA}/x/plan-1.svg"
        self.cur.execute(
            "SELECT public.is_area_plan_path(%s), public.is_area_plan_path(%s), "
            "public.is_area_plan_path(%s), public.is_area_plan_path(%s), public.is_area_plan_path('nonsense');",
            (ok, no_such_area, not_svg, too_deep),
        )
        self.assertEqual(self.cur.fetchone(), (True, False, False, False, False))

    def test_a_plan_records_its_aspect_or_nothing(self):
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("UPDATE public.areas SET plan_path = 'a/c.svg' WHERE id = %s;", (AREA,))
        self.conn.rollback()
        self.cur.execute("UPDATE public.areas SET plan_path = 'a/c.svg', plan_aspect = 1.5 WHERE id = %s;", (AREA,))


class TestTheSiteMapHearsAboutAreas(PlansBase):
    def test_areas_are_published_to_realtime_with_full_identity(self):
        self.cur.execute(
            "SELECT tablename FROM pg_publication_tables "
            " WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'areas';"
        )
        self.assertEqual([r[0] for r in self.cur.fetchall()], ["areas"])
        self.cur.execute(
            "SELECT relreplident FROM pg_class "
            " WHERE relnamespace = 'public'::regnamespace AND relname = 'areas';"
        )
        self.assertEqual(self.cur.fetchone()[0], "f")


if __name__ == "__main__":
    unittest.main(verbosity=2)
