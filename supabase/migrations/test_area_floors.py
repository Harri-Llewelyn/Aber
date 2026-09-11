"""
Floors and places (0098): an area's floors are rows, a cell files onto one of its own area's
floors, and its place on that floor's plan keeps its distance from the others.

Run against the migrated Supabase Postgres -- `npm run test:db` gives it a throwaway one.

The properties a reasonable person would simplify away, each asserted here:

  * A NEW AREA HAS A GROUND FLOOR before anybody adds one, so a cell can always be filed onto a
    floor and the Site Map always has something to draw.

  * A FLOOR THAT HOLDS CELLS CANNOT BE DELETED, and neither can an area's last floor -- except by
    deleting the area, which cascades through the floors and unfiles the cells as it always did.
    The guard has to tell the two apart, and does so by asking whether the area still exists.

  * THE SPACING IS ENFORCED BY THE DATABASE, not by the picker that refuses the click: an approved
    proposal writes the same columns and would otherwise land two cells on one spot.
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


class FloorsBase(unittest.TestCase):
    """Two areas and no cells at the start of every test; everything rolled back at the end."""

    def setUp(self):
        self.conn = connect()
        self.cur = self.conn.cursor()
        cleanup(self.cur)
        self.cur.execute(
            "INSERT INTO public.areas (id, name) VALUES (%s, 'Floor Test Area'), (%s, 'Floor Test Annexe');",
            (AREA, AREA_TWO),
        )
        self.conn.commit()

    def tearDown(self):
        self.conn.rollback()
        cleanup(self.cur)
        self.conn.commit()
        self.conn.close()

    def floors_of(self, area):
        self.cur.execute("SELECT id, level, name FROM public.area_floors WHERE area_id = %s ORDER BY level;", (area,))
        return self.cur.fetchall()

    def add_floor(self, area, level, name):
        self.cur.execute(
            "INSERT INTO public.area_floors (area_id, level, name) VALUES (%s, %s, %s) RETURNING id;",
            (area, level, name),
        )
        return self.cur.fetchone()[0]

    def add_cell(self, cell_id, name, area=None, floor=None, x=None, y=None):
        self.cur.execute(
            "INSERT INTO public.cells (id, name, area_id, floor_id, plan_x, plan_y) "
            "VALUES (%s, %s, %s, %s, %s, %s);",
            (cell_id, name, area, floor, x, y),
        )

    def cell_place(self, cell_id):
        """(area_id, floor_id, plan_x, plan_y) as plain strings and floats, for equality."""
        self.cur.execute("SELECT area_id::text, floor_id::text, plan_x, plan_y FROM public.cells WHERE id = %s;", (cell_id,))
        area, floor, x, y = self.cur.fetchone()
        return (area, floor, None if x is None else float(x), None if y is None else float(y))


class TestAnAreaHasAGroundFloor(FloorsBase):
    def test_a_new_area_starts_with_level_zero(self):
        floors = self.floors_of(AREA)
        self.assertEqual([(f[1], f[2]) for f in floors], [(0, "Ground floor")])

    def test_levels_are_unique_within_an_area_and_names_too(self):
        self.add_floor(AREA, 1, "Floor 1")
        with self.assertRaises(psycopg2.errors.UniqueViolation):
            self.add_floor(AREA, 1, "Mezzanine")
        self.conn.rollback()
        with self.assertRaises(psycopg2.errors.UniqueViolation):
            self.add_floor(AREA, 2, "Ground floor")

    def test_the_other_area_may_reuse_the_level(self):
        self.add_floor(AREA, -1, "Basement")
        self.add_floor(AREA_TWO, -1, "Basement")
        self.assertEqual(len(self.floors_of(AREA_TWO)), 2)

    def test_the_level_name_matches_the_dashboard(self):
        self.cur.execute("SELECT public.floor_level_name(0), public.floor_level_name(-1), "
                         "public.floor_level_name(-2), public.floor_level_name(3);")
        self.assertEqual(self.cur.fetchone(), ("Ground floor", "Basement", "Basement 2", "Floor 3"))


class TestAFloorCannotBeDeletedFromUnderItsCells(FloorsBase):
    def test_the_last_floor_stays(self):
        ground = self.floors_of(AREA)[0][0]
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("DELETE FROM public.area_floors WHERE id = %s;", (ground,))

    def test_a_floor_holding_a_cell_stays(self):
        first = self.add_floor(AREA, 1, "Floor 1")
        self.add_cell(CELL, "Floor Test Cell", AREA, first)
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.cur.execute("DELETE FROM public.area_floors WHERE id = %s;", (first,))

    def test_an_empty_upper_floor_goes(self):
        first = self.add_floor(AREA, 1, "Floor 1")
        self.cur.execute("DELETE FROM public.area_floors WHERE id = %s;", (first,))
        self.assertEqual(len(self.floors_of(AREA)), 1)

    def test_deleting_the_area_takes_its_floors_and_unfiles_its_cells(self):
        # The one path through which a floor holding cells disappears. The cells survive, in no
        # area, on no floor, with no place.
        first = self.add_floor(AREA, 1, "Floor 1")
        self.add_cell(CELL, "Floor Test Cell", AREA, first, 0.5, 0.5)
        self.cur.execute("DELETE FROM public.areas WHERE id = %s;", (AREA,))
        self.assertEqual(self.floors_of(AREA), [])
        self.assertEqual(self.cell_place(CELL), (None, None, None, None))


class TestACellFilesOntoAFloorOfItsOwnArea(FloorsBase):
    def test_a_floor_of_another_area_is_refused_outright(self):
        other = self.floors_of(AREA_TWO)[0][0]
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.add_cell(CELL, "Floor Test Cell", AREA, other)

    def test_a_floor_with_no_area_is_refused(self):
        ground = self.floors_of(AREA)[0][0]
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.add_cell(CELL, "Floor Test Cell", None, ground)

    def test_moving_the_area_clears_a_floor_that_no_longer_applies(self):
        ground = self.floors_of(AREA)[0][0]
        self.add_cell(CELL, "Floor Test Cell", AREA, ground, 0.25, 0.25)
        self.cur.execute("UPDATE public.cells SET area_id = %s WHERE id = %s;", (AREA_TWO, CELL))
        self.assertEqual(self.cell_place(CELL), (AREA_TWO, None, None, None))

    def test_unfiling_clears_the_floor_and_the_place(self):
        ground = self.floors_of(AREA)[0][0]
        self.add_cell(CELL, "Floor Test Cell", AREA, ground, 0.25, 0.25)
        self.cur.execute("UPDATE public.cells SET area_id = NULL WHERE id = %s;", (CELL,))
        self.assertEqual(self.cell_place(CELL), (None, None, None, None))

    def test_a_place_needs_a_floor(self):
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.add_cell(CELL, "Floor Test Cell", AREA, None, 0.5, 0.5)

    def test_a_place_is_a_pair_within_the_plan(self):
        ground = self.floors_of(AREA)[0][0]
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.add_cell(CELL, "Floor Test Cell", AREA, ground, 0.5, None)
        self.conn.rollback()
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.add_cell(CELL, "Floor Test Cell", AREA, ground, 1.5, 0.5)


class TestCellsKeepTheirDistance(FloorsBase):
    def setUp(self):
        super().setUp()
        self.ground = self.floors_of(AREA)[0][0]
        self.add_cell(CELL, "Floor Test Cell", AREA, self.ground, 0.50, 0.50)

    def test_a_second_cell_too_close_is_refused_and_the_neighbour_is_named(self):
        with self.assertRaises(psycopg2.errors.CheckViolation) as raised:
            self.add_cell(CELL_TWO, "Floor Test Cell Two", AREA, self.ground, 0.52, 0.50)
        self.assertIn("Floor Test Cell", str(raised.exception))

    def test_a_second_cell_far_enough_away_is_accepted(self):
        self.add_cell(CELL_TWO, "Floor Test Cell Two", AREA, self.ground, 0.70, 0.50)
        self.assertEqual(self.cell_place(CELL_TWO)[2:], (0.7, 0.5))

    def test_the_distance_is_measured_in_the_plan_shorter_side(self):
        # On the default 4:3 outline a horizontal step counts 4/3 as much as a vertical one, so a
        # gap that is too close vertically is far enough horizontally.
        self.cur.execute("SELECT public.plan_distance(0.5, 0.5, 0.56, 0.5, NULL), public.plan_distance(0.5, 0.5, 0.5, 0.56, NULL);")
        across, down = self.cur.fetchone()
        self.assertGreater(across, down)
        self.assertAlmostEqual(float(across), 0.08, places=3)

    def test_an_archived_neighbour_does_not_hold_its_ground(self):
        self.cur.execute("UPDATE public.cells SET is_archived = true WHERE id = %s;", (CELL,))
        self.add_cell(CELL_TWO, "Floor Test Cell Two", AREA, self.ground, 0.52, 0.50)

    def test_another_floor_is_another_plan(self):
        first = self.add_floor(AREA, 1, "Floor 1")
        self.add_cell(CELL_TWO, "Floor Test Cell Two", AREA, first, 0.50, 0.50)

    def test_the_spacing_is_the_setting(self):
        self.cur.execute("UPDATE public.system_settings SET value = to_jsonb(0.01) WHERE key = 'site_map.min_pin_spacing';")
        self.add_cell(CELL_TWO, "Floor Test Cell Two", AREA, self.ground, 0.52, 0.50)


class TestTheProposalLaneCarriesThePlace(FloorsBase):
    def test_the_cell_lane_admits_the_floor_and_the_place_and_not_the_old_column(self):
        self.cur.execute("SELECT public.proposable_columns('cells');")
        columns = self.cur.fetchone()[0]
        for column in ("floor_id", "plan_x", "plan_y", "area_id"):
            self.assertIn(column, columns)
        self.assertNotIn("floor", columns)

    def test_the_floor_table_is_in_the_asset_lane(self):
        self.cur.execute("SELECT public.audit_domain_for('area_floors', 'INSERT');")
        self.assertEqual(self.cur.fetchone()[0], "asset")

    def test_the_plan_path_is_confined_to_an_existing_floor(self):
        ground = self.floors_of(AREA)[0][0]
        ok = f"{AREA}/{ground}/plan-1.svg"
        wrong_area = f"{AREA_TWO}/{ground}/plan-1.svg"
        not_svg = f"{AREA}/{ground}/plan-1.png"
        too_deep = f"{AREA}/{ground}/x/plan-1.svg"
        self.cur.execute(
            "SELECT public.is_floor_plan_path(%s), public.is_floor_plan_path(%s), "
            "public.is_floor_plan_path(%s), public.is_floor_plan_path(%s), public.is_floor_plan_path('nonsense');",
            (ok, wrong_area, not_svg, too_deep),
        )
        self.assertEqual(self.cur.fetchone(), (True, False, False, False, False))

    def test_a_plan_records_its_aspect_or_nothing(self):
        ground = self.floors_of(AREA)[0][0]
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("UPDATE public.area_floors SET plan_path = 'a/b/c.svg' WHERE id = %s;", (ground,))
        self.conn.rollback()
        self.cur.execute("UPDATE public.area_floors SET plan_path = 'a/b/c.svg', plan_aspect = 1.5 WHERE id = %s;", (ground,))


class TestTheSiteMapHearsAboutFloors(FloorsBase):
    def test_areas_and_floors_are_published_to_realtime_with_full_identity(self):
        self.cur.execute(
            "SELECT tablename FROM pg_publication_tables "
            " WHERE pubname = 'supabase_realtime' AND schemaname = 'public' "
            "   AND tablename IN ('areas', 'area_floors') ORDER BY tablename;"
        )
        self.assertEqual([r[0] for r in self.cur.fetchall()], ["area_floors", "areas"])
        self.cur.execute(
            "SELECT relname, relreplident FROM pg_class "
            " WHERE relnamespace = 'public'::regnamespace AND relname IN ('areas', 'area_floors') ORDER BY relname;"
        )
        self.assertEqual(self.cur.fetchall(), [("area_floors", "f"), ("areas", "f")])


if __name__ == "__main__":
    unittest.main(verbosity=2)
