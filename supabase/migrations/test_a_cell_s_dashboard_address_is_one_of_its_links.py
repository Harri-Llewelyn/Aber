"""
A cell's dashboard address is one of its links (0202).

    python supabase/migrations/test_a_cell_s_dashboard_address_is_one_of_its_links.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

`cells.grafana_url` was deprecated in 1.7.0, and 0219 drops it. While it exists, 0202 moves each
cell's http:// or https:// address into Attached Links (`links`) as a link named Dashboard, tagged
other, and clears the column:

  * an address moves, trimmed, archived cells included, and the column reads NULL after;
  * NULL and blank are skipped, and a value that is not a web address is named in a NOTICE and
    kept;
  * a cell already linked to the same address gets no second link, and its column still clears;
  * the clear leaves one audit row per cell, as the migration;
  * a second boot moves nothing, a Dashboard link somebody deleted stays deleted, and an address
    written after the move reaches Attached Links at the next boot;
  * grafana_url is not proposable, and approve_proposal() refuses an open proposal naming it.

Each test rebuilds the column as 1.7.0 left it, inside its own transaction, replays the file as
db-init does on every boot, and rolls back. Writes to `cells` fire the audit-trail trigger.
test_a_cell_has_no_grafana_url_column.py holds the drop.
"""
import glob
import json
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors as pg_errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION = glob.glob(os.path.join(HERE, "0202_*.sql"))[0]

ADMIN = "00000000-0000-4000-8000-00000002a202"
OPERATOR = "00000000-0000-4000-8000-00000002b202"

CELL_COLUMNS = ["name", "icon", "area_id", "plan_x", "plan_y", "description"]


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, the file replayed, a rollback."""

    @classmethod
    def setUpClass(cls):
        with open(MIGRATION, encoding="utf-8") as f:
            cls.sql = f.read()
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT 'grafana_url' = ANY (public.proposable_columns('cells'));")
            if cur.fetchone()[0]:
                raise unittest.SkipTest(f"{os.path.basename(MIGRATION)} has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # Cleanups, not tearDown: they also run when a fixture fails.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        # 1.7.0's column, which 0219 drops; the rollback drops it again.
        self.cur.execute("ALTER TABLE public.cells ADD COLUMN IF NOT EXISTS grafana_url text;")

    # -- fixtures ---------------------------------------------------------------------------

    def _cell(self, grafana_url=None, archived=False):
        cid = str(uuid.uuid4())
        name = f"Test_0202_Cell_{cid[:8]}"
        self.cur.execute(
            "INSERT INTO public.cells (id, name, grafana_url) VALUES (%s, %s, %s);",
            (cid, name, grafana_url),
        )
        if archived:
            self.cur.execute(
                "UPDATE public.cells SET is_archived = true, archived_at = now() WHERE id = %s;",
                (cid,),
            )
        return cid, name

    def _link(self, cell_id, url, name="Grafana", tag="other"):
        self.cur.execute(
            "INSERT INTO public.links (entity_type, entity_id, display_name, url, link_tag) "
            "VALUES ('cell', %s, %s, %s, %s) RETURNING id;",
            (cell_id, name, url, tag),
        )
        return self.cur.fetchone()[0]

    def _boot(self):
        """Replay the file, as db-init does on every boot; returns the NOTICEs it raised."""
        del self.conn.notices[:]
        self.cur.execute(self.sql)
        return [n.strip() for n in self.conn.notices]

    # -- reads ------------------------------------------------------------------------------

    def _grafana_url(self, cell_id):
        self.cur.execute("SELECT grafana_url FROM public.cells WHERE id = %s;", (cell_id,))
        return self.cur.fetchone()[0]

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
            "       new_data->>'grafana_url' "
            "  FROM public.audit_trail WHERE entity_type = 'cells' AND entity_id = %s "
            " ORDER BY id;",
            (cell_id,),
        )
        return self.cur.fetchall()


class AWebAddressMoves(Base):

    def test_it_becomes_a_dashboard_link_and_the_column_clears(self):
        cell, _ = self._cell("https://grafana.test/d/cell-1")
        self._boot()
        self.assertEqual(self._links(cell), [("Dashboard", "https://grafana.test/d/cell-1", "other")])
        self.assertIsNone(self._grafana_url(cell))

    def test_it_is_written_as_the_cells_page_writes_a_cells_link(self):
        """entity_type 'cell' and the id as text, or the drawer's Attached Links never finds it."""
        cell, _ = self._cell("http://grafana.test/d/cell-2")
        self._boot()
        self.cur.execute(
            "SELECT entity_type, entity_id FROM public.links WHERE url = 'http://grafana.test/d/cell-2';"
        )
        self.assertEqual(self.cur.fetchall(), [("cell", cell)])

    def test_the_blank_around_an_address_is_not_part_of_it(self):
        cell, _ = self._cell("  https://grafana.test/d/cell-3 ")
        self._boot()
        self.assertEqual(self._links(cell), [("Dashboard", "https://grafana.test/d/cell-3", "other")])
        self.assertIsNone(self._grafana_url(cell))

    def test_an_archived_cells_address_moves_so_a_restored_cell_has_it(self):
        cell, _ = self._cell("https://grafana.test/d/archived", archived=True)
        self._boot()
        self.assertEqual(self._links(cell), [("Dashboard", "https://grafana.test/d/archived", "other")])
        self.assertIsNone(self._grafana_url(cell))

    def test_the_clear_leaves_one_audit_row_as_the_migration(self):
        cell, _ = self._cell("https://grafana.test/d/audited")
        before = len(self._audit_rows(cell))
        self._boot()
        rows = self._audit_rows(cell)[before:]
        self.assertEqual(rows, [("UPDATE", "migration", None, "https://grafana.test/d/audited", None)])

    def test_the_log_says_how_many_moved(self):
        self._cell("https://grafana.test/d/counted")
        notices = self._boot()
        self.assertTrue(
            any("cell dashboard address(es) moved to Attached Links, as links named Dashboard" in n
                for n in notices),
            notices,
        )


class WhatDoesNotMove(Base):

    def test_null_and_blank_are_skipped_and_left_as_they_are(self):
        for value in (None, "", "   "):
            with self.subTest(value=value):
                cell, _ = self._cell(value)
                self._boot()
                self.assertEqual(self._links(cell), [])
                self.assertEqual(self._grafana_url(cell), value)

    def test_a_value_that_is_not_a_web_address_is_named_and_kept(self):
        for value in ("localhost:3002/d/cell-1", "ftp://files.test/cell", "javascript:alert(1)",
                      "HTTPS://grafana.test/d/upper"):
            with self.subTest(value=value):
                cell, name = self._cell(value)
                notices = self._boot()
                self.assertEqual(self._links(cell), [])
                self.assertEqual(self._grafana_url(cell), value)
                named = [n for n in notices if f'cell "{name}" ({cell}) keeps grafana_url' in n]
                self.assertEqual(len(named), 1, notices)
                self.assertIn(value, named[0])
                self.assertIn("it is not an http:// or https:// address", named[0])

    def test_an_address_already_linked_is_not_linked_twice(self):
        """The column still clears: the address is in Attached Links already."""
        cell, _ = self._cell("https://grafana.test/d/known")
        self._link(cell, "https://grafana.test/d/known", name="Line dashboard", tag="docs")
        self._boot()
        self.assertEqual(self._links(cell), [("Line dashboard", "https://grafana.test/d/known", "docs")])
        self.assertIsNone(self._grafana_url(cell))

    def test_another_cells_link_to_the_same_address_does_not_count(self):
        cell, _ = self._cell("https://grafana.test/d/shared")
        other, _ = self._cell()
        self._link(other, "https://grafana.test/d/shared")
        self._boot()
        self.assertEqual(self._links(cell), [("Dashboard", "https://grafana.test/d/shared", "other")])

    def test_a_different_address_already_linked_does_not_stop_the_move(self):
        cell, _ = self._cell("https://grafana.test/d/new")
        self._link(cell, "https://wiki.test/cell", name="Wiki")
        self._boot()
        self.assertEqual(self._links(cell), [
            ("Dashboard", "https://grafana.test/d/new", "other"),
            ("Wiki", "https://wiki.test/cell", "other"),
        ])


class ASecondBoot(Base):

    def test_moves_nothing_and_writes_no_audit_row(self):
        cell, _ = self._cell("https://grafana.test/d/twice")
        self._boot()
        after_first = self._audit_rows(cell)
        notices = self._boot()
        self.assertEqual(self._links(cell), [("Dashboard", "https://grafana.test/d/twice", "other")])
        self.assertEqual(self._audit_rows(cell), after_first)
        self.assertFalse(any(f"{cell}" in n for n in notices), notices)

    def test_a_deleted_dashboard_link_stays_deleted(self):
        cell, _ = self._cell("https://grafana.test/d/deleted")
        self._boot()
        self.cur.execute(
            "DELETE FROM public.links WHERE entity_type = 'cell' AND entity_id = %s;", (cell,))
        self._boot()
        self.assertEqual(self._links(cell), [])
        self.assertIsNone(self._grafana_url(cell))

    def test_an_address_written_after_the_move_moves_at_the_next_boot(self):
        """A client that still writes the column reaches Attached Links at the next restart."""
        cell, _ = self._cell("https://grafana.test/d/first")
        self._boot()
        self.cur.execute(
            "UPDATE public.cells SET grafana_url = 'https://grafana.test/d/second' WHERE id = %s;",
            (cell,))
        self._boot()
        self.assertEqual(self._links(cell), [
            ("Dashboard", "https://grafana.test/d/first", "other"),
            ("Dashboard", "https://grafana.test/d/second", "other"),
        ])
        self.assertIsNone(self._grafana_url(cell))

    def test_a_kept_value_is_named_again(self):
        cell, name = self._cell("grafana/d/cell-1")
        self._boot()
        notices = self._boot()
        self.assertTrue(any(f'cell "{name}" ({cell}) keeps grafana_url' in n for n in notices), notices)
        self.assertEqual(self._grafana_url(cell), "grafana/d/cell-1")


class GrafanaUrlIsNotProposable(Base):

    def setUp(self):
        super().setUp()
        for user_id, role in ((ADMIN, "Administrator"), (OPERATOR, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"links-0202-{role.lower()}@test.local"),
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

    def test_the_cell_lane_admits_every_other_column(self):
        self.cur.execute("SELECT public.proposable_columns('cells');")
        self.assertEqual(sorted(self.cur.fetchone()[0]), sorted(CELL_COLUMNS))

    def test_a_proposal_naming_it_is_refused_and_names_it(self):
        cell, _ = self._cell()
        self._as(OPERATOR)
        with self.assertRaisesRegex(pg_errors.InvalidParameterValue,
                                    r"column grafana_url is not proposable on cells"):
            self.cur.execute(
                "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
                "VALUES ('cells', %s, %s::jsonb);",
                (cell, json.dumps({"grafana_url": "https://grafana.test/d/proposed"})),
            )

    def test_an_open_proposal_that_names_it_is_not_approved(self):
        """One filed before the upgrade: approve_proposal() re-checks the allowlist and names the key."""
        cell, _ = self._cell()
        self.cur.execute("ALTER TABLE public.change_proposals DISABLE TRIGGER trg_change_proposals_validate;")
        self.cur.execute(
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch, proposed_by) "
            "VALUES ('cells', %s, %s::jsonb, %s) RETURNING id;",
            (cell, json.dumps({"grafana_url": "https://grafana.test/d/old"}), OPERATOR),
        )
        proposal = self.cur.fetchone()[0]
        self.cur.execute("ALTER TABLE public.change_proposals ENABLE TRIGGER trg_change_proposals_validate;")
        self._as(ADMIN)
        with self.assertRaisesRegex(pg_errors.InvalidParameterValue,
                                    rf"proposal {proposal} names grafana_url , which is not proposable on cells"):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))


if __name__ == "__main__":
    unittest.main(verbosity=2)
