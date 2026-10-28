"""
A cell has no grafana_url column (0219).

    python supabase/migrations/test_a_cell_has_no_grafana_url_column.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

1.7.0 deprecated `cells.grafana_url`: 0202 moved each web address into Attached Links and kept
anything else. 0219 drops the column, guarded by its existence:

  * the column is gone, no function body or view names it, the cell lane does not admit it, and
    an approved cell proposal still applies;
  * on an upgrade, a web address an API client wrote since 0202 becomes a Dashboard link first,
    unless the cell already links to it;
  * a value that is not a web address is named in a NOTICE and cleared before the drop, so the
    cell's audit row keeps it, as the migration; a blank one goes without a row;
  * a second boot, and 0202 replayed after the drop, change nothing and do not fail.

An upgrade is 1.7.0's column rebuilt inside the test's transaction, as test_schema_versioning.py
rebuilds devices.schema_id for 0175. Every test rolls back.
"""
import glob
import json
import os
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION_0202 = glob.glob(os.path.join(HERE, "0202_*.sql"))[0]
MIGRATION_0219 = glob.glob(os.path.join(HERE, "0219_*.sql"))[0]

ADMIN = "00000000-0000-4000-8000-00000002a219"
OPERATOR = "00000000-0000-4000-8000-00000002b219"

HAS_COLUMN = (
    "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.cells'::regclass "
    "                  AND attname = 'grafana_url' AND NOT attisdropped);"
)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, the files replayed, a rollback."""

    @classmethod
    def setUpClass(cls):
        cls.sql_0202 = read(MIGRATION_0202)
        cls.sql_0219 = read(MIGRATION_0219)
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(HAS_COLUMN)
            if cur.fetchone()[0]:
                raise unittest.SkipTest(f"{os.path.basename(MIGRATION_0219)} has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # Cleanups, not tearDown: they also run when a fixture fails.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()

    def _has_column(self):
        self.cur.execute(HAS_COLUMN)
        return self.cur.fetchone()[0]

    def _cell(self, name=None):
        cid = str(uuid.uuid4())
        name = name or f"Test_0219_Cell_{cid[:8]}"
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES (%s, %s);", (cid, name))
        return cid, name

    def _links(self, cell_id):
        self.cur.execute(
            "SELECT display_name, url, link_tag FROM public.links "
            "WHERE entity_type = 'cell' AND entity_id = %s ORDER BY display_name, url;",
            (cell_id,),
        )
        return self.cur.fetchall()

    def _audit_rows(self, cell_id):
        self.cur.execute(
            "SELECT action, actor_source, changed_by, old_data->>'grafana_url', "
            "       new_data->>'grafana_url', new_data ? 'grafana_url' "
            "  FROM public.audit_trail WHERE entity_type = 'cells' AND entity_id = %s "
            " ORDER BY id;",
            (cell_id,),
        )
        return self.cur.fetchall()

    def _boot(self, *sqls):
        """Replay the files in order, as db-init does on every boot; returns the NOTICEs."""
        del self.conn.notices[:]
        for sql in sqls:
            self.cur.execute(sql)
        return [n.strip() for n in self.conn.notices]


class TheColumnIsGone(Base):

    def test_cells_has_no_grafana_url(self):
        self.assertFalse(self._has_column())

    def test_no_function_body_names_it(self):
        self.cur.execute(
            "SELECT p.oid::regprocedure::text FROM pg_proc p "
            "  JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname = 'public' AND p.prosrc ~ '\\mgrafana_url\\M' ORDER BY 1;"
        )
        self.assertEqual(self.cur.fetchall(), [])

    def test_no_view_names_it(self):
        self.cur.execute(
            "SELECT schemaname || '.' || viewname FROM pg_views "
            " WHERE schemaname = 'public' AND definition ~ '\\mgrafana_url\\M' ORDER BY 1;"
        )
        self.assertEqual(self.cur.fetchall(), [])

    def test_the_cell_lane_does_not_admit_it(self):
        self.cur.execute("SELECT public.proposable_columns('cells');")
        self.assertNotIn("grafana_url", self.cur.fetchone()[0])

    def test_a_replay_of_0202_finds_nothing_to_do(self):
        notices = self._boot(self.sql_0202)
        self.assertEqual([n for n in notices if "0202:" in n], [])
        self.assertFalse(self._has_column())

    def test_a_replay_of_0219_finds_nothing_to_do(self):
        notices = self._boot(self.sql_0219)
        self.assertEqual([n for n in notices if "0219:" in n], [])


class AnApprovedCellProposalStillApplies(Base):
    """approve_proposal()'s cells branch, redeclared without the column, writes what it names."""

    def setUp(self):
        super().setUp()
        for user_id, role in ((ADMIN, "Administrator"), (OPERATOR, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"cells-0219-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    def _as(self, user_id):
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true);",
            (json.dumps({"sub": user_id, "role": "authenticated", "email": f"{user_id}@test.local"}),),
        )

    def test_a_renamed_cell_is_renamed(self):
        cell, _ = self._cell()
        self._as(OPERATOR)
        self.cur.execute(
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
            "VALUES ('cells', %s, %s::jsonb) RETURNING id;",
            (cell, json.dumps({"name": f"Test_0219_Renamed_{cell[:8]}",
                               "description": "Two shifts"})),
        )
        proposal = self.cur.fetchone()[0]
        self.cur.execute("RESET ROLE;")
        self._as(ADMIN)
        self.cur.execute("SELECT public.approve_proposal(%s) ->> 'status';", (proposal,))
        self.assertEqual(self.cur.fetchone()[0], "applied")
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT name, description FROM public.cells WHERE id = %s;", (cell,))
        self.assertEqual(self.cur.fetchone(), (f"Test_0219_Renamed_{cell[:8]}", "Two shifts"))


class AnUpgrade(Base):
    """
    0219 on a database that still has the column, rebuilt here as 1.7.0 left it. Rolled back with
    the rest of the test.
    """

    def setUp(self):
        super().setUp()
        self.cur.execute("ALTER TABLE public.cells ADD COLUMN grafana_url text;")

    def _cell_with(self, value, archived=False):
        cid, name = self._cell()
        self.cur.execute("UPDATE public.cells SET grafana_url = %s WHERE id = %s;", (value, cid))
        if archived:
            self.cur.execute(
                "UPDATE public.cells SET is_archived = true, archived_at = now() WHERE id = %s;",
                (cid,),
            )
        return cid, name

    def test_the_column_goes_and_the_log_says_so(self):
        notices = self._boot(self.sql_0219)
        self.assertFalse(self._has_column())
        self.assertTrue(any("0219: cells.grafana_url dropped" in n for n in notices), notices)

    def test_a_web_address_written_since_0202_becomes_a_dashboard_link(self):
        cell, _ = self._cell_with(" https://grafana.test/d/window ")
        notices = self._boot(self.sql_0219)
        self.assertEqual(self._links(cell), [("Dashboard", "https://grafana.test/d/window", "other")])
        self.assertTrue(
            any("0219: 1 cell dashboard address(es) moved to Attached Links" in n for n in notices),
            notices,
        )
        # Cleared before the drop, so the trail holds the address beside the move.
        self.assertEqual(
            self._audit_rows(cell)[-1],
            ("UPDATE", "migration", None, " https://grafana.test/d/window ", None, True),
        )

    def test_an_archived_cells_address_moves_too(self):
        cell, _ = self._cell_with("https://grafana.test/d/archived", archived=True)
        self._boot(self.sql_0219)
        self.assertEqual(self._links(cell), [("Dashboard", "https://grafana.test/d/archived", "other")])

    def test_an_address_already_linked_is_not_linked_twice(self):
        cell, _ = self._cell_with("https://grafana.test/d/known")
        self.cur.execute(
            "INSERT INTO public.links (entity_type, entity_id, display_name, url, link_tag) "
            "VALUES ('cell', %s, 'Line dashboard', 'https://grafana.test/d/known', 'docs');",
            (cell,),
        )
        self._boot(self.sql_0219)
        self.assertEqual(self._links(cell), [("Line dashboard", "https://grafana.test/d/known", "docs")])

    def test_a_value_that_is_not_a_web_address_is_named_and_kept_in_the_audit_trail(self):
        for value in ("localhost:3002/d/cell-1", "ftp://files.test/cell", "HTTPS://grafana.test/d/upper"):
            with self.subTest(value=value):
                self.cur.execute("SAVEPOINT a_value;")
                cell, name = self._cell_with(value)
                notices = self._boot(self.sql_0219)
                self.assertEqual(self._links(cell), [])
                named = [n for n in notices if f'0219: cell "{name}" ({cell}) held grafana_url' in n]
                self.assertEqual(len(named), 1, notices)
                self.assertIn(value, named[0])
                self.assertIn("which is not a web address", named[0])
                self.assertEqual(self._audit_rows(cell)[-1],
                                 ("UPDATE", "migration", None, value, None, True))
                self.assertTrue(
                    any("1 value(s) that were not web addresses are named above" in n for n in notices),
                    notices,
                )
                self.cur.execute("ROLLBACK TO SAVEPOINT a_value;")

    def test_the_whole_value_is_in_the_trail_and_the_log_quotes_its_start(self):
        value = "dashboards/" + "x" * 400
        cell, name = self._cell_with(value)
        notices = self._boot(self.sql_0219)
        named = [n for n in notices if f'0219: cell "{name}" ({cell}) held grafana_url' in n]
        self.assertEqual(len(named), 1, notices)
        self.assertIn(value[:200], named[0])
        self.assertNotIn(value[:201], named[0])
        self.assertEqual(self._audit_rows(cell)[-1][3], value)

    def test_null_and_blank_go_without_a_word_or_a_row(self):
        for value in (None, "", "   "):
            with self.subTest(value=value):
                self.cur.execute("SAVEPOINT a_value;")
                cell, name = self._cell_with(value)
                before = self._audit_rows(cell)
                notices = self._boot(self.sql_0219)
                self.assertEqual(self._audit_rows(cell), before)
                self.assertFalse(any(cell in n for n in notices), notices)
                self.assertEqual(self._links(cell), [])
                self.cur.execute("ROLLBACK TO SAVEPOINT a_value;")

    def test_a_boot_runs_0202_then_0219_and_each_value_ends_where_it_belongs(self):
        """The first boot after the upgrade replays the whole chain: 0202 moves, 0219 drops."""
        web, _ = self._cell_with("https://grafana.test/d/boot")
        other, name = self._cell_with("grafana/d/boot")
        notices = self._boot(self.sql_0202, self.sql_0219)
        self.assertEqual(self._links(web), [("Dashboard", "https://grafana.test/d/boot", "other")])
        self.assertEqual(self._links(other), [])
        # 0202 names the value it keeps, and 0219 names it again as it removes it.
        self.assertTrue(any(f'0202: cell "{name}" ({other}) keeps grafana_url' in n for n in notices), notices)
        self.assertTrue(any(f'0219: cell "{name}" ({other}) held grafana_url' in n for n in notices), notices)
        self.assertEqual(self._audit_rows(web)[-1][:5], ("UPDATE", "migration", None, "https://grafana.test/d/boot", None))
        self.assertEqual(self._audit_rows(other)[-1][:5], ("UPDATE", "migration", None, "grafana/d/boot", None))
        self.assertFalse(self._has_column())

    def test_the_second_boot_moves_nothing_and_does_not_fail(self):
        web, _ = self._cell_with("https://grafana.test/d/twice")
        other, _ = self._cell_with("grafana/d/twice")
        self._boot(self.sql_0202, self.sql_0219)
        links, trail_web, trail_other = self._links(web), self._audit_rows(web), self._audit_rows(other)

        notices = self._boot(self.sql_0202, self.sql_0219)

        self.assertEqual([n for n in notices if "0202:" in n or "0219:" in n], [])
        self.assertEqual(self._links(web), links)
        self.assertEqual(self._audit_rows(web), trail_web)
        self.assertEqual(self._audit_rows(other), trail_other)
        self.assertFalse(self._has_column())

    def test_a_deleted_dashboard_link_stays_deleted(self):
        cell, _ = self._cell_with("https://grafana.test/d/deleted")
        self._boot(self.sql_0202, self.sql_0219)
        self.cur.execute("DELETE FROM public.links WHERE entity_type = 'cell' AND entity_id = %s;", (cell,))
        self._boot(self.sql_0202, self.sql_0219)
        self.assertEqual(self._links(cell), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
