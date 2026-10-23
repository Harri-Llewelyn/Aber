"""
A cell is archived only when nothing is in it (0198).

    python supabase/migrations/test_a_cell_is_archived_only_when_nothing_is_in_it.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

Archiving a cell checked nothing, and its devices stayed in it: the UNS kept publishing them under
the archived cell's name, i3X moved them up to the area, and the Site Map showed them nowhere. Three
refusals hold the state from both sides, for every role:

  * a cell is not archived while any device resolves to it, whatever the device's lifecycle (live,
    offline, archived, quarantined, or in it through its gateway), or while any gateway is filed in
    it, archived ones included. Restore, an edit of an archived cell and an empty cell's archive pass;
  * no device or gateway is filed in an archived cell, by any writer;
  * no device is assigned to an archived gateway, approval from Quarantine included.

A write that leaves `cell_id` or `gateway_id` as it was passes, and a second boot changes nothing.

Every test rolls back. Writes to `cells`, `gateways` and `devices` fire the audit-trail trigger.
"""
import glob
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
MIGRATION = glob.glob(os.path.join(HERE, "0198_*.sql"))[0]

TRIGGERS = (
    ("public.cells", "trg_cells_archived_only_when_empty"),
    ("public.devices", "trg_devices_not_filed_in_an_archived_cell"),
    ("public.gateways", "trg_gateways_not_filed_in_an_archived_cell"),
    ("public.devices", "trg_devices_not_assigned_to_an_archived_gateway"),
)

PEOPLE = {
    "Administrator": "00000000-0000-4000-8000-00000001a198",
    "Shopfloor_Manager": "00000000-0000-4000-8000-00000001b198",
}
ROLES = tuple(PEOPLE)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, each call as a caller, a rollback."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cells_archived_only_when_empty' "
                "AND tgrelid = 'public.cells'::regclass AND NOT tgisinternal;"
            )
            if not cur.fetchone():
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
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"archive-0198-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    # -- fixtures, written as the owner, in an order the refusals allow ----------------------

    def _cell(self, archived=False):
        cid = str(uuid.uuid4())
        name = f"Test_0198_Cell_{cid[:8]}"
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES (%s, %s);", (cid, name))
        if archived:
            self._archive_cell(cid)
        return cid, name

    def _gateway(self, cell_id=None, archived=False, simulated=False):
        gid = str(uuid.uuid4())
        name = f"Test_0198_GW_{gid[:8]}"
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, cell_id, deployment, is_simulated) "
            "VALUES (%s, %s, %s, %s, %s);",
            (gid, name, cell_id, "host" if simulated else "remote", simulated),
        )
        if archived:
            self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        return gid, name

    def _device(self, gateway_id=None, cell_id=None, archived=False, quarantined=False, status="OFFLINE"):
        did = str(uuid.uuid4())
        name = f"Test_0198_Dev_{did[:8]}"
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, cell_id, status, is_quarantined, "
            "quarantine_reason, first_dbirth_at) VALUES (%s, %s, %s, %s, %s, %s, %s, now());",
            (did, name, gateway_id, cell_id, status, quarantined, "test" if quarantined else None),
        )
        if archived:
            self.cur.execute("UPDATE public.devices SET is_archived = true WHERE id = %s;", (did,))
        return did, name

    def _archive_cell(self, cell_id):
        self.cur.execute(
            "UPDATE public.cells SET is_archived = true, archived_at = now() WHERE id = %s;", (cell_id,))

    # -- callers ----------------------------------------------------------------------------

    def _as(self, caller):
        """Become `caller` for what follows, as PostgREST does: role, then claims."""
        self.cur.execute("SET LOCAL ROLE authenticated;")
        claims = '{"sub": "%s", "role": "authenticated"}' % PEOPLE[caller]
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (claims,))

    def _call(self, caller, sql, args=()):
        """One statement as `caller` (None is the owner), in a savepoint, so a refusal leaves the
        fixture standing."""
        self.cur.execute("SAVEPOINT call;")
        try:
            if caller:
                self._as(caller)
            self.cur.execute(sql, args)
            return self.cur.rowcount
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")

    def _refused(self, error, pattern, caller, sql, args=()):
        with self.assertRaisesRegex(error, pattern):
            self._call(caller, sql, args)

    def _archive_refused(self, cell_id, pattern, caller=None):
        self._refused(pg_errors.RestrictViolation, pattern, caller,
                      "UPDATE public.cells SET is_archived = true, archived_at = now() WHERE id = %s;",
                      (cell_id,))

    def _cell_is_archived(self, cell_id):
        self.cur.execute("SELECT is_archived FROM public.cells WHERE id = %s;", (cell_id,))
        return self.cur.fetchone()[0]


class ACellThatHoldsAnythingIsNotArchived(Base):

    def test_a_live_device_filed_in_the_cell(self):
        cell, name = self._cell()
        self._device(cell_id=cell, status="ONLINE")
        for role in ROLES:
            with self.subTest(role=role):
                self._archive_refused(
                    cell, rf'^cell "{name}" still holds 1 device\. Move it to another cell, or delete it, '
                          r'then archive the cell\.', role)
        self.assertFalse(self._cell_is_archived(cell))

    def test_an_offline_an_archived_and_a_quarantined_device(self):
        for kind in ("offline", "archived", "quarantined"):
            with self.subTest(device=kind):
                cell, name = self._cell()
                self._device(cell_id=cell, archived=kind == "archived", quarantined=kind == "quarantined")
                self._archive_refused(cell, rf'cell "{name}" still holds 1 device\.')

    def test_a_device_in_it_through_its_gateway(self):
        """No cell of its own: it resolves to the gateway's, as device_locations says."""
        cell, name = self._cell()
        gateway, gateway_name = self._gateway(cell_id=cell)
        self._device(gateway_id=gateway)
        self._archive_refused(cell, rf'cell "{name}" still holds 1 device and 1 gateway \({gateway_name}\)\. '
                                    r'Move them to another cell, or delete them')

    def test_a_gateway_alone_and_an_archived_one(self):
        for archived in (False, True):
            with self.subTest(archived_gateway=archived):
                cell, name = self._cell()
                _, gateway_name = self._gateway(cell_id=cell, archived=archived)
                self._archive_refused(cell, rf'cell "{name}" still holds 1 gateway \({gateway_name}\)\.')

    def test_the_counts_and_every_gateways_name(self):
        cell, name = self._cell()
        first, first_name = self._gateway(cell_id=cell)
        _, second_name = self._gateway(cell_id=cell, archived=True)
        self._device(gateway_id=first)
        self._device(cell_id=cell, archived=True)
        self._device(gateway_id=first, quarantined=True)
        names = ", ".join(sorted([first_name, second_name]))
        self._archive_refused(cell, rf'cell "{name}" still holds 3 devices and 2 gateways \({names}\)\.')

    def test_a_device_that_resolves_to_no_cell_does_not_count(self):
        """Behind a simulated gateway a device resolves to no cell, whatever its own cell_id says."""
        cell, _ = self._cell()
        simulated, _ = self._gateway(simulated=True)
        self._device(gateway_id=simulated, cell_id=cell)
        self.assertEqual(self._call("Shopfloor_Manager",
                                    "UPDATE public.cells SET is_archived = true WHERE id = %s;", (cell,)), 1)


class WhatStillPasses(Base):

    def test_an_empty_cell_is_archived(self):
        cell, _ = self._cell()
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(self._call(role, "UPDATE public.cells SET is_archived = true, "
                                                  "archived_at = now() WHERE id = %s;", (cell,)), 1)

    def test_an_archived_cell_is_restored_and_edited(self):
        cell, _ = self._cell(archived=True)
        self.assertEqual(self._call("Shopfloor_Manager",
                                    "UPDATE public.cells SET description = 'kept' WHERE id = %s;", (cell,)), 1)
        # A whole-row PATCH re-sends is_archived = true: not a transition.
        self.assertEqual(self._call("Shopfloor_Manager",
                                    "UPDATE public.cells SET is_archived = true WHERE id = %s;", (cell,)), 1)
        self.assertEqual(self._call("Shopfloor_Manager",
                                    "UPDATE public.cells SET is_archived = false, archived_at = NULL, "
                                    "auto_delete_at = NULL WHERE id = %s;", (cell,)), 1)

    def test_a_restored_cell_takes_devices_again(self):
        cell, _ = self._cell(archived=True)
        self.cur.execute("UPDATE public.cells SET is_archived = false WHERE id = %s;", (cell,))
        self._device(cell_id=cell)

    def test_unchanged_cell_and_gateway_ids_pass(self):
        # The one row that can still name an archived cell: a device whose own cell_id is set but
        # resolves to none, behind a simulated gateway.
        cell, _ = self._cell()
        simulated, _ = self._gateway(simulated=True)
        device, _ = self._device(gateway_id=simulated, cell_id=cell)
        self._archive_cell(cell)
        # Archiving a gateway leaves its devices as they are.
        gateway, _ = self._gateway()
        served, _ = self._device(gateway_id=gateway)
        self.assertEqual(self._call("Shopfloor_Manager",
                                    "UPDATE public.gateways SET is_archived = true WHERE id = %s;",
                                    (gateway,)), 1)
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gateway,))
        for role in ROLES:
            with self.subTest(role=role):
                # Whole-row PATCHes, as the dashboard sends them.
                self.assertEqual(self._call(role, "UPDATE public.devices SET name = name || ' (edited)', "
                                                  "cell_id = %s, gateway_id = %s WHERE id = %s;",
                                            (cell, simulated, device)), 1)
                self.assertEqual(self._call(role, "UPDATE public.devices SET name = name || ' (edited)', "
                                                  "gateway_id = %s, cell_id = NULL WHERE id = %s;",
                                            (gateway, served)), 1)


class NothingMovesIntoAnArchivedCell(Base):

    def setUp(self):
        super().setUp()
        self.archived, self.archived_name = self._cell(archived=True)
        self.live, _ = self._cell()

    def test_a_device_is_not_moved_in(self):
        device, name = self._device(cell_id=self.live)
        pattern = rf'^device "{name}" cannot be put in cell "{self.archived_name}", which is archived\.'
        for role in ROLES:
            with self.subTest(role=role):
                self._refused(pg_errors.CheckViolation, pattern, role,
                              "UPDATE public.devices SET cell_id = %s WHERE id = %s;", (self.archived, device))
        with self.subTest(writer="relocate_devices()"):
            self._refused(pg_errors.CheckViolation, pattern, "Shopfloor_Manager",
                          "SELECT public.relocate_devices(jsonb_build_array(jsonb_build_object("
                          "'device_id', %s::text, 'location_scope', 'cell', 'cell_id', %s::text)));",
                          (device, self.archived))

    def test_a_device_is_not_created_in_it(self):
        self._refused(pg_errors.CheckViolation, "which is archived", "Shopfloor_Manager",
                      "INSERT INTO public.devices (name, cell_id) VALUES ('Test_0198_New', %s);",
                      (self.archived,))

    def test_a_gateway_is_not_moved_in_or_created_in_it(self):
        gateway, name = self._gateway(cell_id=self.live)
        for role in ROLES:
            with self.subTest(role=role):
                self._refused(pg_errors.CheckViolation,
                              rf'^gateway "{name}" cannot be put in cell "{self.archived_name}", which is archived\.',
                              role, "UPDATE public.gateways SET cell_id = %s WHERE id = %s;",
                              (self.archived, gateway))
        self._refused(pg_errors.CheckViolation, "which is archived", "Shopfloor_Manager",
                      "INSERT INTO public.gateways (name, cell_id) VALUES ('Test_0198_New_GW', %s);",
                      (self.archived,))

    def test_an_approval_from_quarantine_is_not_filed_in_it(self):
        held, _ = self._device(quarantined=True)
        self._refused(pg_errors.CheckViolation, "which is archived", None,
                      "SELECT public.approve_quarantined_device(%s, %s, p_cell_id => %s, "
                      "p_set_cell => true, p_location_scope => 'cell', p_set_location_scope => true);",
                      (held, PEOPLE["Administrator"], self.archived))

    def test_un_filing_still_works(self):
        device, _ = self._device(cell_id=self.live)
        self.assertEqual(self._call("Shopfloor_Manager",
                                    "UPDATE public.devices SET cell_id = NULL WHERE id = %s;", (device,)), 1)


class NoDeviceIsAssignedToAnArchivedGateway(Base):

    def setUp(self):
        super().setUp()
        self.archived, self.archived_name = self._gateway(archived=True)

    def test_a_device_is_not_reassigned_to_it(self):
        live, _ = self._gateway()
        device, name = self._device(gateway_id=live)
        for role in ROLES:
            with self.subTest(role=role):
                self._refused(pg_errors.CheckViolation,
                              rf'^device "{name}" cannot be assigned to gateway "{self.archived_name}", '
                              r'which is archived\.',
                              role, "UPDATE public.devices SET gateway_id = %s WHERE id = %s;",
                              (self.archived, device))

    def test_a_device_is_not_created_on_it(self):
        self._refused(pg_errors.CheckViolation, "which is archived", "Shopfloor_Manager",
                      "INSERT INTO public.devices (name, gateway_id) VALUES ('Test_0198_New', %s);",
                      (self.archived,))

    def test_an_approval_from_quarantine_is_not_assigned_to_it(self):
        held, _ = self._device(quarantined=True)
        self._refused(pg_errors.CheckViolation, "which is archived", None,
                      "SELECT public.approve_quarantined_device(%s, %s, p_gateway_id => %s);",
                      (held, PEOPLE["Administrator"], self.archived))


class ASecondBootChangesNothing(Base):

    def _state(self, ids):
        self.cur.execute(
            "SELECT t.tgname, t.oid, p.oid FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid "
            "WHERE t.tgname = ANY(%s) ORDER BY t.tgname;", ([name for _, name in TRIGGERS],))
        catalog = self.cur.fetchall()
        self.cur.execute(
            "SELECT count(*) FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[]);", (list(ids),))
        return catalog, self.cur.fetchone()[0]

    def test_a_replay_over_a_used_database(self):
        archived_cell, _ = self._cell(archived=True)
        live_cell, _ = self._cell()
        archived_gateway, _ = self._gateway(cell_id=live_cell)
        device, _ = self._device(gateway_id=archived_gateway)
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (archived_gateway,))
        before = self._state([archived_cell, live_cell, archived_gateway, device])
        self.assertEqual(len(before[0]), len(TRIGGERS), "a trigger is missing before the replay")

        with open(MIGRATION, encoding="utf-8", newline="") as f:
            self.cur.execute(f.read())

        self.assertEqual(self._state([archived_cell, live_cell, archived_gateway, device]), before,
                         "the replay re-created a trigger or a function, or wrote a row")


if __name__ == "__main__":
    unittest.main(verbosity=2)
