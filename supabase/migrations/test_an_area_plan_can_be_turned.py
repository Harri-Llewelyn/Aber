"""
An area's plan can be turned in quarter turns, and the file stays as it was uploaded (0221).

    python supabase/migrations/test_an_area_plan_can_be_turned.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: areas.plan_rotation is a smallint, NOT NULL, defaulting to 0. It holds 0, 90,
180 or 270 and nothing else, and it is 0 whenever the area has no plan, so removing a plan resets
the turn for any client. A turn writes the areas row alone: every cell keeps its plan_x and plan_y,
and the spacing between places is refused at every rotation as at none. Replacing the plan keeps
the turn. A Shopfloor Manager turns a plan and the audit trail records it; an Operator's turn
changes nothing and anon may not try. The file replays: a second boot drops nothing, a drifted
CHECK is put back, and a database from before 0221 gets the column with every area unturned and no
audit row.

EVERY TEST ROLLS BACK. areas is in the realtime publication, and an audit row is permanent.
"""
import json
import os
import unittest
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MANAGER_ID = "a0d17070-0000-4000-8000-0000000221a1"
OPERATOR_ID = "a0d17070-0000-4000-8000-0000000221a2"
AREA = "a0d17070-0000-4000-8000-0000000221b1"
BARE_AREA = "a0d17070-0000-4000-8000-0000000221b2"
CELL = "a0d17070-0000-4000-8000-0000000221c1"
CELL_TWO = "a0d17070-0000-4000-8000-0000000221c2"
CELL_NEAR = "a0d17070-0000-4000-8000-0000000221c3"

MIGRATION = Path(__file__).resolve().parent / "0221_an_area_plan_can_be_turned.sql"

QUARTER_TURN = "CHECK ((plan_rotation = ANY (ARRAY[0, 90, 180, 270])))"
NEEDS_A_PLAN = "CHECK (((plan_path IS NOT NULL) OR (plan_rotation = 0)))"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class TurnBase(unittest.TestCase):
    """A 2:1 plan with two cells placed on it, an area with no plan, and two people."""

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'"
            " AND table_name = 'areas' AND column_name = 'plan_rotation';"
        )
        if self.cur.fetchone()[0] == 0:
            self.skipTest("0221 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in ((MANAGER_ID, "Shopfloor_Manager"), (OPERATOR_ID, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@plan-turn.test"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )
        self.cur.execute(
            "INSERT INTO public.areas (id, name, plan_path, plan_aspect) VALUES"
            " (%s, 'Turn Test Hall', %s, 2), (%s, 'Turn Test Yard', NULL, NULL);",
            (AREA, f"{AREA}/plan-1.svg", BARE_AREA),
        )
        self.cur.execute(
            "INSERT INTO public.cells (id, name, area_id, plan_x, plan_y) VALUES"
            " (%s, 'Turn Test Press', %s, 0.25, 0.1), (%s, 'Turn Test Lathe', %s, 0.8, 0.7);",
            (CELL, AREA, CELL_TWO, AREA),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def rotation(self, area=AREA):
        self.cur.execute("SELECT plan_rotation FROM public.areas WHERE id = %s;", (area,))
        return self.cur.fetchone()[0]

    def places(self):
        self.cur.execute(
            "SELECT id::text, plan_x::float8, plan_y::float8 FROM public.cells"
            " WHERE id IN (%s, %s) ORDER BY id;", (CELL, CELL_TWO),
        )
        return self.cur.fetchall()

    def constraint(self, name):
        self.cur.execute("SELECT public.live_constraint_definition('public.areas'::regclass, %s);", (name,))
        return self.cur.fetchone()[0]

    def replay(self):
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))

    def as_person(self, user_id, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id`. A refusal rolls back to the
        savepoint, so the test can go on, and is raised. Returns the rows and the row count."""
        self.cur.execute("SAVEPOINT plan_turn_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
            count = self.cur.rowcount
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT plan_turn_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT plan_turn_call;")
        return rows, count


class TheColumn(TurnBase):
    def test_a_smallint_not_null_defaulting_to_0(self):
        self.cur.execute(
            "SELECT data_type, is_nullable, column_default FROM information_schema.columns"
            " WHERE table_schema = 'public' AND table_name = 'areas' AND column_name = 'plan_rotation';"
        )
        self.assertEqual(self.cur.fetchone(), ("smallint", "NO", "0"))

    def test_a_new_area_and_a_new_plan_are_drawn_unturned(self):
        self.assertEqual(self.rotation(AREA), 0)
        self.assertEqual(self.rotation(BARE_AREA), 0)

    def test_it_is_described(self):
        self.cur.execute(
            "SELECT col_description('public.areas'::regclass, attnum) FROM pg_attribute"
            " WHERE attrelid = 'public.areas'::regclass AND attname = 'plan_rotation';"
        )
        comment = self.cur.fetchone()[0] or ""
        self.assertIn("(0221)", comment)
        self.assertIn("clockwise", comment)


class TheTwoChecks(TurnBase):
    def test_a_plan_takes_each_quarter_turn(self):
        for turn in (90, 180, 270, 0):
            with self.subTest(turn=turn):
                self.cur.execute("UPDATE public.areas SET plan_rotation = %s WHERE id = %s;", (turn, AREA))
                self.assertEqual(self.rotation(), turn)

    def test_any_other_angle_is_refused(self):
        for turn in (45, -90, 360, 1):
            with self.subTest(turn=turn):
                self.cur.execute("SAVEPOINT angle;")
                with self.assertRaises(psycopg2.errors.CheckViolation) as raised:
                    self.cur.execute("UPDATE public.areas SET plan_rotation = %s WHERE id = %s;", (turn, AREA))
                self.assertIn("areas_plan_rotation_quarter_turn", str(raised.exception))
                self.cur.execute("ROLLBACK TO SAVEPOINT angle;")
        self.assertEqual(self.rotation(), 0)

    def test_an_area_with_no_plan_is_not_turned(self):
        with self.assertRaises(psycopg2.errors.CheckViolation) as raised:
            self.cur.execute("UPDATE public.areas SET plan_rotation = 90 WHERE id = %s;", (BARE_AREA,))
        self.assertIn("areas_plan_rotation_needs_a_plan", str(raised.exception))

    def test_removing_a_turned_plan_resets_the_turn_in_the_same_write(self):
        self.cur.execute("UPDATE public.areas SET plan_rotation = 270 WHERE id = %s;", (AREA,))
        # A client that clears the plan and leaves the turn is refused, so the outline is never turned.
        self.cur.execute("SAVEPOINT remove;")
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("UPDATE public.areas SET plan_path = NULL, plan_aspect = NULL WHERE id = %s;", (AREA,))
        self.cur.execute("ROLLBACK TO SAVEPOINT remove;")
        # The dashboard's Remove plan writes all three.
        self.cur.execute(
            "UPDATE public.areas SET plan_path = NULL, plan_aspect = NULL, plan_rotation = 0 WHERE id = %s;", (AREA,)
        )
        self.assertEqual(self.rotation(), 0)

    def test_an_area_is_created_with_a_turned_plan_only_when_it_has_one(self):
        self.cur.execute("SAVEPOINT new_area;")
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("INSERT INTO public.areas (name, plan_rotation) VALUES ('Turn Test Annexe', 180);")
        self.cur.execute("ROLLBACK TO SAVEPOINT new_area;")
        self.cur.execute(
            "INSERT INTO public.areas (name, plan_path, plan_aspect, plan_rotation)"
            " VALUES ('Turn Test Annexe', 'x/plan-1.svg', 0.75, 180) RETURNING plan_rotation;"
        )
        self.assertEqual(self.cur.fetchone()[0], 180)


class ATurnMovesNoPlace(TurnBase):
    def test_every_cell_keeps_its_fractions(self):
        before = self.places()
        for turn in (90, 180, 270, 0):
            with self.subTest(turn=turn):
                self.cur.execute("UPDATE public.areas SET plan_rotation = %s WHERE id = %s;", (turn, AREA))
                self.assertEqual(self.places(), before)

    def test_the_spacing_is_refused_alike_at_every_rotation(self):
        # 0.03 across a 2:1 plan is 0.06 of its shorter side, inside the 0.08 default; 0.05 is 0.1.
        for turn in (0, 90, 180, 270):
            with self.subTest(turn=turn):
                self.cur.execute("UPDATE public.areas SET plan_rotation = %s WHERE id = %s;", (turn, AREA))
                self.cur.execute("SAVEPOINT near;")
                with self.assertRaises(psycopg2.errors.CheckViolation) as raised:
                    self.cur.execute(
                        "INSERT INTO public.cells (id, name, area_id, plan_x, plan_y)"
                        " VALUES (%s, 'Turn Test Drill', %s, 0.28, 0.1);", (CELL_NEAR, AREA),
                    )
                self.assertIn("Turn Test Press", str(raised.exception))
                self.cur.execute("ROLLBACK TO SAVEPOINT near;")
                self.cur.execute(
                    "INSERT INTO public.cells (id, name, area_id, plan_x, plan_y)"
                    " VALUES (%s, 'Turn Test Drill', %s, 0.30, 0.1);", (CELL_NEAR, AREA),
                )
                self.cur.execute("DELETE FROM public.cells WHERE id = %s;", (CELL_NEAR,))

    def test_replacing_the_plan_keeps_the_turn(self):
        self.cur.execute("UPDATE public.areas SET plan_rotation = 90 WHERE id = %s;", (AREA,))
        # What the dashboard's Replace plan writes: the new object and its aspect, nothing else.
        self.cur.execute(
            "UPDATE public.areas SET plan_path = %s, plan_aspect = 2.1 WHERE id = %s;", (f"{AREA}/plan-2.svg", AREA)
        )
        self.assertEqual(self.rotation(), 90)


class WhoTurnsAPlan(TurnBase):
    def test_a_shopfloor_manager_turns_it_and_the_audit_trail_records_it(self):
        _, count = self.as_person(
            MANAGER_ID, "UPDATE public.areas SET plan_rotation = 90 WHERE id = %s;", (AREA,)
        )
        self.assertEqual(count, 1)
        self.assertEqual(self.rotation(), 90)
        self.cur.execute(
            "SELECT action, actor_source, changed_by::text, (old_data->>'plan_rotation')::int,"
            "       (new_data->>'plan_rotation')::int, new_data->>'plan_path'"
            "  FROM public.audit_trail WHERE entity_type = 'areas' AND entity_id = %s AND action = 'UPDATE';",
            (AREA,),
        )
        self.assertEqual(self.cur.fetchall(), [("UPDATE", "user", MANAGER_ID, 0, 90, f"{AREA}/plan-1.svg")])

    def test_an_operator_s_turn_changes_nothing(self):
        _, count = self.as_person(
            OPERATOR_ID, "UPDATE public.areas SET plan_rotation = 90 WHERE id = %s;", (AREA,)
        )
        self.assertEqual(count, 0)
        self.assertEqual(self.rotation(), 0)

    def test_a_signed_in_reader_reads_it_and_anon_does_not(self):
        rows, _ = self.as_person(OPERATOR_ID, "SELECT plan_rotation FROM public.areas WHERE id = %s;", (AREA,))
        self.assertEqual(rows, [(0,)])
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.as_person(None, "SELECT plan_rotation FROM public.areas;", role="anon")


class TheFileReplays(TurnBase):
    def constraint_oids(self):
        self.cur.execute(
            "SELECT conname::text, oid::int8 FROM pg_constraint WHERE conrelid = 'public.areas'::regclass"
            "   AND conname IN ('areas_plan_rotation_quarter_turn', 'areas_plan_rotation_needs_a_plan')"
            " ORDER BY conname;"
        )
        return self.cur.fetchall()

    def test_a_second_boot_drops_nothing(self):
        self.cur.execute("UPDATE public.areas SET plan_rotation = 180 WHERE id = %s;", (AREA,))
        before = self.constraint_oids()
        self.assertEqual(len(before), 2)
        self.replay()
        self.assertEqual(self.constraint_oids(), before)
        self.assertEqual(self.rotation(), 180)
        self.assertEqual(self.constraint("areas_plan_rotation_quarter_turn"), QUARTER_TURN)
        self.assertEqual(self.constraint("areas_plan_rotation_needs_a_plan"), NEEDS_A_PLAN)

    def test_a_drifted_check_is_put_back(self):
        self.cur.execute(
            "ALTER TABLE public.areas DROP CONSTRAINT areas_plan_rotation_quarter_turn;"
            "ALTER TABLE public.areas ADD CONSTRAINT areas_plan_rotation_quarter_turn CHECK (plan_rotation >= 0);"
        )
        self.replay()
        self.assertEqual(self.constraint("areas_plan_rotation_quarter_turn"), QUARTER_TURN)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("UPDATE public.areas SET plan_rotation = 45 WHERE id = %s;", (AREA,))

    def test_a_database_from_before_gets_the_column_unturned_and_no_audit_row(self):
        # 1.7.0's areas: no column, so neither CHECK.
        self.cur.execute("ALTER TABLE public.areas DROP COLUMN plan_rotation;")
        self.assertIsNone(self.constraint("areas_plan_rotation_needs_a_plan"))
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_id IN (%s, %s);", (AREA, BARE_AREA))
        audited = self.cur.fetchone()[0]

        self.replay()
        self.assertEqual((self.rotation(AREA), self.rotation(BARE_AREA)), (0, 0))
        self.assertEqual(self.constraint("areas_plan_rotation_quarter_turn"), QUARTER_TURN)
        self.assertEqual(self.constraint("areas_plan_rotation_needs_a_plan"), NEEDS_A_PLAN)
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_id IN (%s, %s);", (AREA, BARE_AREA))
        self.assertEqual(self.cur.fetchone()[0], audited)


if __name__ == "__main__":
    unittest.main(verbosity=2)
