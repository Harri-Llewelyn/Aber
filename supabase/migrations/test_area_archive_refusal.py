"""
An area is archived only when nothing is Area-Wide in it, and nothing is made Area-Wide in an
archived area (0199).

    python supabase/migrations/test_area_archive_refusal.py

Requires the Supabase database (54322 by default) with the chain applied; `npm run test:db` gives
it a throwaway one.

Why it matters: `devices.area_id` and `gateways.area_id` have no ON DELETE action, so the nightly
purge skips an area either still names. An archived area an asset names would keep its Auto-purge
date for ever and never be deleted, with nothing saying why. So the archive is refused instead:

  * with a live, an archived or a quarantined device Area-Wide in the area, or a gateway, and the
    refusal gives the counts, the gateways' names and the way out;
  * not with cells filed in the area, which archiving keeps where they are; a restore and an edit
    of an archived area pass;
  * a device or gateway made Area-Wide in an archived area is refused, by insert or update; a write
    that leaves area_id as it was passes, and so does moving one out;
  * the file replays without re-creating its triggers.

Every test rolls back.
"""
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors as pg_errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATIONS = os.path.dirname(os.path.abspath(__file__))
MIGRATION = next(n for n in sorted(os.listdir(MIGRATIONS)) if n.startswith("0199_"))
TRIGGERS = (
    ("public.areas", "trg_areas_archived_only_when_nothing_is_area_wide"),
    ("public.devices", "trg_devices_not_area_wide_in_an_archived_area"),
    ("public.gateways", "trg_gateways_not_area_wide_in_an_archived_area"),
)


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        conn = connect()
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regprocedure('public.refuse_archiving_an_area_with_area_wide_assets()');")
            if not cur.fetchone()[0]:
                raise unittest.SkipTest("0199 has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = connect()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.area = self._area()

    # -- fixtures, as the owner ---------------------------------------------------------------

    def _area(self, archived=False):
        area_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.areas (id, name, is_archived, archived_at) VALUES (%s, %s, %s, %s);",
            (area_id, f"Archive_Guard_{area_id[:8]}", archived, "2026-01-01T00:00:00Z" if archived else None),
        )
        return area_id

    def _device(self, area_id=None, name=None, **cols):
        device_id = str(uuid.uuid4())
        cols = {"id": device_id, "name": name or f"Archive_Guard_Dev_{device_id[:8]}", "status": "OFFLINE",
                **({"location_scope": "area_wide", "area_id": area_id} if area_id else {}), **cols}
        names = ", ".join(cols)
        marks = ", ".join(["%s"] * len(cols))
        self.cur.execute(f"INSERT INTO public.devices ({names}) VALUES ({marks});", list(cols.values()))
        return device_id

    def _gateway(self, area_id=None, cell_id=None, name=None):
        gateway_id = str(uuid.uuid4())
        scope = "area_wide" if area_id else "cell"
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, area_id, cell_id, deployment) "
            "VALUES (%s, %s, %s, %s, %s, 'remote');",
            (gateway_id, name or f"Archive_Guard_GW_{gateway_id[:8]}", scope, area_id, cell_id),
        )
        return gateway_id

    def _archive(self, area_id):
        self.cur.execute("SAVEPOINT archive;")
        try:
            self.cur.execute("UPDATE public.areas SET is_archived = true, archived_at = now(), "
                             "auto_delete_at = now() + interval '30 days' WHERE id = %s;", (area_id,))
        except Exception:
            self.cur.execute("ROLLBACK TO SAVEPOINT archive;")
            raise
        self.cur.execute("RELEASE SAVEPOINT archive;")

    def _archived(self, area_id):
        self.cur.execute("SELECT is_archived FROM public.areas WHERE id = %s;", (area_id,))
        return self.cur.fetchone()[0]


class TheArchiveIsRefusedWhileAnythingIsAreaWide(Base):

    def test_a_live_device_refuses_it_and_the_refusal_says_what_to_do(self):
        self._device(self.area)
        with self.assertRaises(pg_errors.RestrictViolation) as raised:
            self._archive(self.area)
        message = str(raised.exception)
        self.assertIn("still holds 1 Area-Wide device.", message)
        self.assertIn("Site-Wide", message)
        self.assertIn("put it in a cell", message)
        self.assertFalse(self._archived(self.area))

    def test_an_archived_or_quarantined_device_refuses_it_too(self):
        """Either one's area_id would hold the purge off as surely as a live one's."""
        for label, cols in (("archived", {"is_archived": True, "archived_at": "2026-01-01T00:00:00Z"}),
                            ("quarantined", {"is_quarantined": True})):
            with self.subTest(device=label):
                area = self._area()
                self._device(area, **cols)
                with self.assertRaises(pg_errors.RestrictViolation):
                    self._archive(area)

    def test_a_gateway_refuses_it_and_is_named(self):
        self._gateway(self.area, name="Archive_Guard_BMS_Gateway")
        with self.assertRaises(pg_errors.RestrictViolation) as raised:
            self._archive(self.area)
        self.assertIn("1 Area-Wide gateway.", str(raised.exception))
        self.assertIn("Gateways: Archive_Guard_BMS_Gateway.", str(raised.exception))

    def test_the_refusal_counts_each_kind(self):
        self._device(self.area)
        self._device(self.area)
        self._gateway(self.area)
        with self.assertRaises(pg_errors.RestrictViolation) as raised:
            self._archive(self.area)
        self.assertIn("still holds 2 Area-Wide devices and 1 Area-Wide gateway.", str(raised.exception))

    def test_cells_filed_in_the_area_do_not_refuse_it(self):
        """Archiving an area keeps its cells, and what is in them, where they are."""
        cell = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.cells (id, name, area_id) VALUES (%s, %s, %s);",
                         (cell, f"Archive_Guard_Cell_{cell[:8]}", self.area))
        gateway = self._gateway(cell_id=cell)
        self._device(gateway_id=gateway)
        self._archive(self.area)
        self.assertTrue(self._archived(self.area))

    def test_a_restore_and_an_edit_of_an_archived_area_pass(self):
        self._archive(self.area)
        self.cur.execute("UPDATE public.areas SET description = 'kept' WHERE id = %s;", (self.area,))
        self.cur.execute("UPDATE public.areas SET is_archived = true WHERE id = %s;", (self.area,))
        self.cur.execute("UPDATE public.areas SET is_archived = false, archived_at = NULL, "
                         "auto_delete_at = NULL WHERE id = %s;", (self.area,))
        self.assertFalse(self._archived(self.area))


class NothingIsMadeAreaWideInAnArchivedArea(Base):

    def setUp(self):
        super().setUp()
        self.archived = self._area(archived=True)

    def _refused(self, write):
        self.cur.execute("SAVEPOINT write;")
        try:
            with self.assertRaises(pg_errors.RestrictViolation) as raised:
                write()
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT write;")
        return str(raised.exception)

    def test_a_device_or_gateway_made_area_wide_in_it_is_refused(self):
        device = self._device()
        gateway = self._gateway(cell_id=None)
        moved = self._refused(lambda: self.cur.execute(
            "UPDATE public.devices SET location_scope = 'area_wide', area_id = %s WHERE id = %s;",
            (self.archived, device)))
        self.assertIn("is archived", moved)
        self.assertIn("Restore the area first", moved)
        self._refused(lambda: self.cur.execute(
            "UPDATE public.gateways SET location_scope = 'area_wide', area_id = %s WHERE id = %s;",
            (self.archived, gateway)))
        self._refused(lambda: self._device(self.archived))
        self._refused(lambda: self._gateway(self.archived))

    def test_a_live_area_takes_one(self):
        self._device(self.area)
        self._gateway(self.area)

    def test_a_write_that_leaves_area_id_alone_passes_and_so_does_moving_out(self):
        """The state no write reaches now, built with the rule off: an asset already there."""
        self.cur.execute("ALTER TABLE public.devices DISABLE TRIGGER trg_devices_not_area_wide_in_an_archived_area;")
        device = self._device(self.archived)
        self.cur.execute("ALTER TABLE public.devices ENABLE TRIGGER trg_devices_not_area_wide_in_an_archived_area;")

        self.cur.execute("UPDATE public.devices SET name = 'Archive_Guard_Renamed', area_id = %s "
                         "WHERE id = %s;", (self.archived, device))
        self.cur.execute("UPDATE public.devices SET location_scope = 'site_wide', area_id = NULL "
                         "WHERE id = %s;", (device,))
        self.cur.execute("SELECT area_id FROM public.devices WHERE id = %s;", (device,))
        self.assertIsNone(self.cur.fetchone()[0])


class TheFileReplays(Base):

    def _trigger_oids(self):
        oids = []
        for table, name in TRIGGERS:
            self.cur.execute("SELECT oid FROM pg_trigger WHERE tgrelid = %s::regclass AND tgname = %s;",
                             (table, name))
            row = self.cur.fetchone()
            oids.append(row and row[0])
        return oids

    def test_a_second_boot_re_creates_nothing(self):
        before = self._trigger_oids()
        self.assertNotIn(None, before)
        with open(os.path.join(MIGRATIONS, MIGRATION), encoding="utf-8") as f:
            self.cur.execute(f.read())
        self.assertEqual(self._trigger_oids(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
