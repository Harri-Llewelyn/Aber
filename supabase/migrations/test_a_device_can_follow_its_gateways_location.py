# suite:
#   lanes: db
#   why: 0293 -- that a device can follow its gateway's location (location_scope 'gateway'): that
#     every gateway location (a cell, Area-Wide, Site-Wide, none, no gateway) read through each of a
#     device's four choices resolves as the issue says in device_locations, and moves with the
#     gateway; that Cell requires a cell and Follow Gateway names no place, as CHECKs; that the file's
#     move changes only the cell-scoped devices that had no cell, records each in the Audit Trail,
#     and replays to nothing; that the two views that read location_source, the UNS path and the
#     automations document, place a followed device where its gateway is; that a proposal carries
#     the value; and that approve_quarantined_device() admits it. A wrong arm here files a device
#     under the wrong place on every page and publishes it under the wrong topic.

"""
A device can follow its gateway's location (0293).

    python supabase/migrations/test_a_device_can_follow_its_gateways_location.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * RESOLUTION. device_locations gives a device that follows its gateway the gateway's own place,
    read at the moment it is asked: followed_cell (the gateway's cell, and that cell's area),
    followed_area (the gateway's area, no cell), followed_site (neither), and unassigned when the
    gateway has no location or there is no gateway. A device with a place of its own (a cell,
    Area-Wide, Site-Wide) keeps it whatever its gateway is. A simulated gateway still puts every
    choice in the Simulated lane, ahead of the new arms.
  * THE CHECKS. Cell requires a cell (devices_cell_scope_names_a_cell), Follow Gateway names no
    cell and no area (devices_follow_gateway_has_no_place), a new device follows its gateway, and a
    gateway itself cannot follow one.
  * THE MOVE. The file adds the first CHECK after moving every cell-scoped device with no cell to
    Follow Gateway, and says how many moved. Run here over a database where the CHECK is dropped
    first, inside the test's transaction, so the rows it moves are the test's own. Nothing else
    moves, each move is an UPDATE in the Audit Trail by the actor `migration`, and a second run
    finds the CHECK and moves nothing, keeping the constraints' oids and the views' text.
  * THE READERS. device_uns_paths gives a followed device the topic of the place it follows, and
    automations_document() calls one behind a Site-Wide gateway Site-wide.
  * THE WRITERS. A proposal carries location_scope 'gateway' through the columns it already may
    name and approve_proposal() applies it; approve_quarantined_device() clears the cell and area
    of a device approved as Follow Gateway and refuses a cell scope with no cell.

EVERY TEST ROLLS BACK. Writes to areas, cells, gateways and devices fire the audit-trail trigger.
"""
import json
import os
import re
import unittest
import uuid

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION = os.path.join(HERE, "0293_a_device_can_follow_its_gateway_s_location.sql")

MANAGER_ID = "a0d17070-0000-4000-8000-000000000293"
OPERATOR_ID = "a0d17070-0000-4000-8000-000000000294"

SITE = "Cardiff"
GROUP = "Aber_0293"
METRIC = "Test_0293/Probe_Temperature"

# The five places a gateway can be, and the four things a device can choose.
GATEWAYS = ("cell", "area", "site", "none", "no_gateway")
CHOICES = ("gateway", "cell", "area_wide", "site_wide")


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, reads as the owner or a caller, a rollback."""

    def setUp(self):
        self.conn = get_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regclass('public.device_locations');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("device_locations does not exist")
        self.cur.execute("SELECT 1 FROM pg_constraint WHERE conname = 'devices_follow_gateway_has_no_place';")
        if self.cur.fetchone() is None:
            self.skipTest("0293 is not applied to this database")
        self.tag = uuid.uuid4().hex[:8]
        # The plant. Bay 1 is in the Assembly area; Bay 2 is in Finishing, so a device's own place can
        # differ from its gateway's in both its cell and its area.
        self.assembly = self.make_area(f"Assembly {self.tag}")
        self.finishing = self.make_area(f"Finishing {self.tag}")
        self.bay1 = self.make_cell(f"Bay 1 {self.tag}", self.assembly)
        self.bay2 = self.make_cell(f"Bay 2 {self.tag}", self.finishing)
        self.gateway = {
            "cell": self.make_gateway("cell", cell_id=self.bay1),
            "area": self.make_gateway("area_wide", area_id=self.assembly),
            "site": self.make_gateway("site_wide"),
            "none": self.make_gateway("cell"),
            "no_gateway": None,
        }
        self.cur.execute("SELECT set_config('app.test_tag', %s, true);", (self.tag,))

    # -- fixtures, as the owner ----------------------------------------------------------------

    def make_area(self, name):
        area_id = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.areas (id, name) VALUES (%s, %s);", (area_id, name))
        return area_id

    def make_cell(self, name, area_id):
        cell_id = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.cells (id, name, area_id) VALUES (%s, %s, %s);",
                         (cell_id, name, area_id))
        return cell_id

    def make_gateway(self, scope, cell_id=None, area_id=None, simulated=False):
        gateway_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, cell_id, area_id, location_scope, deployment,"
            " is_simulated, sparkplug_group) VALUES (%s, %s, %s, %s, %s, %s, %s, %s);",
            (gateway_id, f"Test_0293_GW_{gateway_id[:8]}", cell_id, area_id, scope,
             "host" if simulated else "remote", simulated, GROUP),
        )
        return gateway_id

    def make_device(self, name, gateway_id, scope="gateway", cell_id=None, area_id=None):
        device_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, cell_id, location_scope, area_id)"
            " VALUES (%s, %s, %s, %s, %s, %s);",
            (device_id, name, gateway_id, cell_id, scope, area_id),
        )
        return device_id

    def device_choosing(self, choice, gateway_id, name="Probe"):
        """A device with the given choice: its own cell is Bay 2, its own area Finishing."""
        if choice == "gateway":
            return self.make_device(name, gateway_id)
        if choice == "cell":
            return self.make_device(name, gateway_id, scope="cell", cell_id=self.bay2)
        if choice == "area_wide":
            return self.make_device(name, gateway_id, scope="area_wide", area_id=self.finishing)
        return self.make_device(name, gateway_id, scope="site_wide")

    # -- reads ---------------------------------------------------------------------------------

    def where(self, device_id):
        """(source, effective cell, effective area) of the device, as device_locations answers."""
        self.cur.execute(
            "SELECT location_source, effective_cell_id, effective_area_id"
            "  FROM public.device_locations WHERE device_id = %s;", (device_id,))
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "device_locations has no row for the device")
        return tuple(None if v is None else str(v) for v in row)

    def row(self, device_id):
        self.cur.execute("SELECT * FROM public.device_locations WHERE device_id = %s;", (device_id,))
        columns = [d.name for d in self.cur.description]
        return dict(zip(columns, self.cur.fetchone()))

    # -- people and sessions -------------------------------------------------------------------

    def person(self, user_id, role):
        self.cur.execute("INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                         (user_id, f"{user_id}@follow-gateway.test"))
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) SELECT %s, id FROM public.roles WHERE name = %s"
            " ON CONFLICT DO NOTHING;", (user_id, role))

    def as_user(self, user_id):
        self.cur.execute("SET ROLE authenticated;")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": user_id, "email": f"{user_id}@follow-gateway.test"}),))

    def as_owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")


class TheResolution(Base):
    def expected(self, choice, gateway_key):
        """What the issue says each of the twenty pairs resolves to: (source, cell, area)."""
        if choice == "gateway":
            return {
                "cell": ("followed_cell", self.bay1, self.assembly),
                "area": ("followed_area", None, self.assembly),
                "site": ("followed_site", None, None),
                "none": ("unassigned", None, None),
                "no_gateway": ("unassigned", None, None),
            }[gateway_key]
        # A place of its own is its own, whatever the gateway has.
        return {
            "cell": ("explicit", self.bay2, self.finishing),
            "area_wide": ("area_wide", None, self.finishing),
            "site_wide": ("site_wide", None, None),
        }[choice]

    def test_each_gateway_location_read_through_each_choice(self):
        for gateway_key in GATEWAYS:
            for choice in CHOICES:
                with self.subTest(gateway=gateway_key, choice=choice):
                    device = self.device_choosing(choice, self.gateway[gateway_key])
                    self.assertEqual(self.where(device), self.expected(choice, gateway_key))

    def test_a_followed_device_is_a_gateway_s_cell_when_the_gateway_is_in_one(self):
        device = self.make_device("Follower", self.gateway["cell"])
        row = self.row(device)
        self.assertEqual(row["location_source"], "followed_cell")
        self.assertEqual(str(row["effective_cell_id"]), self.bay1)
        self.assertEqual(str(row["gateway_cell_id"]), self.bay1)
        self.assertIsNone(row["explicit_cell_id"])
        self.assertFalse(row["cell_mismatch"])

    def test_the_issue_s_case_a_device_behind_an_area_wide_gateway_is_area_wide_not_unassigned(self):
        # AssemblyFlow is Area-Wide in Assembly. Assembly Device inherited from it and showed under
        # Unassigned; following it, the device is in Assembly and no cell.
        device = self.make_device("Assembly Device", self.gateway["area"])
        self.assertEqual(self.where(device), ("followed_area", None, self.assembly))

    def test_a_gateway_that_moves_takes_its_followers_with_it(self):
        follower = self.make_device("Follower", self.gateway["cell"])
        own = self.make_device("Own", self.gateway["cell"], scope="cell", cell_id=self.bay2)
        gateway = self.gateway["cell"]
        self.assertEqual(self.where(follower)[0], "followed_cell")

        # To another cell: the follower goes, the device with a cell of its own stays.
        other = self.make_cell(f"Bay 3 {self.tag}", self.finishing)
        self.cur.execute("UPDATE public.gateways SET cell_id = %s WHERE id = %s;", (other, gateway))
        self.assertEqual(self.where(follower), ("followed_cell", other, self.finishing))
        self.assertEqual(self.where(own), ("explicit", self.bay2, self.finishing))

        # To Area-Wide in Assembly.
        self.cur.execute(
            "UPDATE public.gateways SET cell_id = NULL, area_id = %s, location_scope = 'area_wide'"
            " WHERE id = %s;", (self.assembly, gateway))
        self.assertEqual(self.where(follower), ("followed_area", None, self.assembly))
        self.assertEqual(self.where(own), ("explicit", self.bay2, self.finishing))

        # To Site-Wide, then to nothing.
        self.cur.execute(
            "UPDATE public.gateways SET area_id = NULL, location_scope = 'site_wide' WHERE id = %s;",
            (gateway,))
        self.assertEqual(self.where(follower), ("followed_site", None, None))
        self.cur.execute(
            "UPDATE public.gateways SET location_scope = 'cell' WHERE id = %s;", (gateway,))
        self.assertEqual(self.where(follower), ("unassigned", None, None))

    def test_a_device_moved_to_another_gateway_follows_that_one(self):
        device = self.make_device("Mover", self.gateway["cell"])
        self.assertEqual(self.where(device)[0], "followed_cell")
        self.cur.execute("UPDATE public.devices SET gateway_id = %s WHERE id = %s;",
                         (self.gateway["site"], device))
        self.assertEqual(self.where(device)[0], "followed_site")
        self.cur.execute("UPDATE public.devices SET gateway_id = NULL WHERE id = %s;", (device,))
        self.assertEqual(self.where(device)[0], "unassigned")

    def test_a_cell_of_its_own_beside_a_gateway_elsewhere_still_flags_a_mismatch(self):
        device = self.make_device("Mismatch", self.gateway["cell"], scope="cell", cell_id=self.bay2)
        self.assertTrue(self.row(device)["cell_mismatch"])
        follower = self.make_device("Follower", self.gateway["cell"])
        self.assertFalse(self.row(follower)["cell_mismatch"])

    def test_a_simulated_gateway_puts_every_choice_in_the_simulated_lane(self):
        simulated = self.make_gateway("cell", simulated=True)
        for choice in CHOICES:
            with self.subTest(choice=choice):
                device = self.device_choosing(choice, simulated)
                self.assertEqual(self.where(device), ("simulated", None, None))

    def test_the_lanes_are_tested_before_the_new_arms_in_every_case_expression(self):
        self.cur.execute("SELECT pg_get_viewdef('public.device_locations'::regclass);")
        view = re.sub(r"\s+", " ", self.cur.fetchone()[0])
        for expression in re.findall(r"CASE (.*?) END AS (?:effective_cell_id|location_source|effective_area_id)", view):
            first_followed = min((expression.find(w) for w in ("gateway", "followed")
                                  if expression.find(w) >= 0), default=-1)
            for lane in ("is_shadow", "is_simulated"):
                self.assertGreaterEqual(expression.find(lane), 0, expression)
                self.assertLess(expression.find(lane), first_followed, expression)

    def test_every_column_and_every_earlier_source_is_still_there(self):
        self.cur.execute(
            "SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute"
            " WHERE attrelid = 'public.device_locations'::regclass AND attnum > 0 AND NOT attisdropped;")
        self.assertEqual(
            self.cur.fetchone()[0],
            "device_id,gateway_id,explicit_cell_id,gateway_cell_id,location_scope,effective_cell_id,"
            "location_source,cell_mismatch,explicit_area_id,effective_area_id")
        self.cur.execute("SELECT pg_get_viewdef('public.device_locations'::regclass);")
        view = self.cur.fetchone()[0]
        for source in ("shadow", "simulated", "site_wide", "area_wide", "explicit", "inherited", "unassigned",
                       "followed_cell", "followed_area", "followed_site"):
            self.assertIn(f"'{source}'::text", view)


class TheChecks(Base):
    def insert_device(self, location_scope, cell_id=None, area_id=None):
        self.cur.execute(
            "INSERT INTO public.devices (name, location_scope, cell_id, area_id) VALUES ('Probe', %s, %s, %s);",
            (location_scope, cell_id, area_id))

    def refused(self, constraint, **columns):
        self.cur.execute("SAVEPOINT probe;")
        with self.assertRaises(psycopg2.errors.CheckViolation) as raised:
            self.insert_device(**columns)
        self.assertEqual(raised.exception.diag.constraint_name, constraint)
        self.cur.execute("ROLLBACK TO SAVEPOINT probe;")

    def test_a_new_device_follows_its_gateway(self):
        self.cur.execute("INSERT INTO public.devices (name) VALUES ('Fresh') RETURNING location_scope;")
        self.assertEqual(self.cur.fetchone()[0], "gateway")

    def test_follow_gateway_names_no_cell(self):
        self.refused("devices_follow_gateway_has_no_place", location_scope="gateway", cell_id=self.bay1)

    def test_follow_gateway_names_no_area(self):
        self.cur.execute("SAVEPOINT probe;")
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.insert_device(location_scope="gateway", area_id=self.assembly)
        self.cur.execute("ROLLBACK TO SAVEPOINT probe;")

    def test_cell_requires_a_cell(self):
        self.refused("devices_cell_scope_names_a_cell", location_scope="cell")

    def test_a_cell_scope_with_a_cell_and_the_other_scopes_are_admitted(self):
        self.insert_device(location_scope="cell", cell_id=self.bay1)
        self.insert_device(location_scope="area_wide", area_id=self.assembly)
        self.insert_device(location_scope="site_wide")
        self.insert_device(location_scope="gateway")

    def test_clearing_the_cell_of_a_cell_device_is_refused_and_following_is_the_way(self):
        device = self.make_device("Mover", None, scope="cell", cell_id=self.bay1)
        self.cur.execute("SAVEPOINT probe;")
        with self.assertRaises(psycopg2.errors.CheckViolation) as raised:
            self.cur.execute("UPDATE public.devices SET cell_id = NULL WHERE id = %s;", (device,))
        self.assertEqual(raised.exception.diag.constraint_name, "devices_cell_scope_names_a_cell")
        self.cur.execute("ROLLBACK TO SAVEPOINT probe;")
        self.cur.execute(
            "UPDATE public.devices SET cell_id = NULL, location_scope = 'gateway' WHERE id = %s;", (device,))
        self.assertEqual(self.where(device)[0], "unassigned")

    def test_a_scope_nobody_defined_is_still_refused(self):
        self.refused("devices_location_scope_valid", location_scope="building")

    def test_a_gateway_cannot_follow_one(self):
        self.cur.execute("SAVEPOINT probe;")
        with self.assertRaises(psycopg2.errors.CheckViolation) as raised:
            self.cur.execute(
                "INSERT INTO public.gateways (name, deployment, location_scope) VALUES ('GW', 'remote', 'gateway');")
        self.assertEqual(raised.exception.diag.constraint_name, "gateways_location_scope_valid")
        self.cur.execute("ROLLBACK TO SAVEPOINT probe;")

    def test_both_new_checks_are_validated(self):
        self.cur.execute(
            "SELECT conname FROM pg_constraint WHERE conrelid = 'public.devices'::regclass"
            "   AND conname IN ('devices_cell_scope_names_a_cell', 'devices_follow_gateway_has_no_place')"
            "   AND convalidated ORDER BY conname;")
        self.assertEqual([r[0] for r in self.cur.fetchall()],
                         ["devices_cell_scope_names_a_cell", "devices_follow_gateway_has_no_place"])


class TheDeletedCell(Base):
    """
    devices.cell_id is ON DELETE SET NULL, which would write a cell scope with no cell and fail the
    CHECK. The BEFORE DELETE trigger moves the devices filed in the cell to Follow Gateway first, so
    deleting a cell (the nightly purge of an archived one, or a person) un-files them as it always did.
    """

    def test_deleting_a_cell_un_files_its_devices_and_they_follow_their_gateway(self):
        own = self.make_device("Filed", self.gateway["area"], scope="cell", cell_id=self.bay2)
        other = self.make_device("Elsewhere", self.gateway["area"], scope="cell", cell_id=self.bay1)
        follower = self.make_device("Follower", self.gateway["cell"])
        self.cur.execute("DELETE FROM public.cells WHERE id = %s;", (self.bay2,))
        self.assertEqual(self.where(own), ("followed_area", None, self.assembly))
        self.cur.execute("SELECT location_scope, cell_id FROM public.devices WHERE id = %s;", (own,))
        self.assertEqual(self.cur.fetchone(), ("gateway", None))
        # A device filed in another cell is untouched, and so is one that never named this one.
        self.assertEqual(self.where(other), ("explicit", self.bay1, self.assembly))
        self.assertEqual(self.where(follower)[0], "followed_cell")

    def test_each_device_is_an_audit_row_by_whoever_deleted_the_cell(self):
        self.person(MANAGER_ID, "Administrator")
        own = self.make_device("Filed", None, scope="cell", cell_id=self.bay2)
        self.as_user(MANAGER_ID)
        self.cur.execute("DELETE FROM public.cells WHERE id = %s;", (self.bay2,))
        self.as_owner()
        self.cur.execute(
            "SELECT changed_by::text, actor_source, old_data ->> 'location_scope', new_data ->> 'location_scope'"
            "  FROM public.audit_trail WHERE entity_type = 'devices' AND entity_id = %s AND action = 'UPDATE';",
            (own,))
        self.assertEqual(self.cur.fetchall(), [(MANAGER_ID, "user", "cell", "gateway")])

    def test_the_trigger_function_is_not_callable_by_a_signed_in_person(self):
        for role in ("anon", "authenticated", "service_role"):
            with self.subTest(role=role):
                self.cur.execute(
                    "SELECT has_function_privilege(%s, 'public.devices_follow_their_gateway_when_their_cell_is_deleted()', 'EXECUTE');",
                    (role,))
                self.assertFalse(self.cur.fetchone()[0])


class TheMove(Base):
    """
    The file run over a database where its first CHECK is dropped, so the devices the move acts on
    are the ones this test makes. DDL is transactional: the rollback restores the CHECK.
    """

    def run_file(self):
        with open(MIGRATION, "r", encoding="utf-8") as handle:
            sql = handle.read()
        del self.conn.notices[:]
        self.cur.execute(sql)
        return [n for n in self.conn.notices if "0293:" in n and "device(s)" in n]

    def make_old_world(self):
        """The devices an upgrade meets: every scope, with 'cell' and no cell where inheriting."""
        self.cur.execute("ALTER TABLE public.devices DROP CONSTRAINT devices_cell_scope_names_a_cell;")
        d = {}
        d["inherits_cell"] = self.make_device("Inherits cell", self.gateway["cell"], scope="cell")
        d["inherits_area"] = self.make_device("Inherits area", self.gateway["area"], scope="cell")
        d["inherits_site"] = self.make_device("Inherits site", self.gateway["site"], scope="cell")
        d["inherits_none"] = self.make_device("Inherits none", self.gateway["none"], scope="cell")
        d["no_gateway"] = self.make_device("No gateway", None, scope="cell")
        d["own_cell"] = self.make_device("Own cell", self.gateway["area"], scope="cell", cell_id=self.bay2)
        d["area_wide"] = self.make_device("Area wide", self.gateway["cell"], scope="area_wide", area_id=self.finishing)
        d["site_wide"] = self.make_device("Site wide", self.gateway["cell"], scope="site_wide")
        d["follows"] = self.make_device("Follows", self.gateway["cell"], scope="gateway")
        return d

    def scope_of(self, device_id):
        self.cur.execute("SELECT location_scope, cell_id, area_id FROM public.devices WHERE id = %s;", (device_id,))
        scope, cell, area = self.cur.fetchone()
        return scope, None if cell is None else str(cell), None if area is None else str(area)

    def test_only_a_cell_scoped_device_with_no_cell_moves(self):
        d = self.make_old_world()
        notices = self.run_file()
        for name in ("inherits_cell", "inherits_area", "inherits_site", "inherits_none", "no_gateway"):
            self.assertEqual(self.scope_of(d[name]), ("gateway", None, None), name)
        # Nothing else is touched.
        self.assertEqual(self.scope_of(d["own_cell"]), ("cell", self.bay2, None))
        self.assertEqual(self.scope_of(d["area_wide"]), ("area_wide", None, self.finishing))
        self.assertEqual(self.scope_of(d["site_wide"]), ("site_wide", None, None))
        self.assertEqual(self.scope_of(d["follows"]), ("gateway", None, None))
        self.assertEqual(len(notices), 1, notices)

    def test_where_the_gateway_has_a_place_nothing_visible_changes_and_where_it_is_wide_the_device_leaves_unassigned(self):
        d = self.make_old_world()
        before = {name: self.where(d[name]) for name in ("inherits_cell", "inherits_area", "inherits_site")}
        self.assertEqual(before["inherits_cell"], ("inherited", self.bay1, self.assembly))
        self.assertEqual(before["inherits_area"], ("unassigned", None, None))
        self.assertEqual(before["inherits_site"], ("unassigned", None, None))
        self.run_file()
        self.assertEqual(self.where(d["inherits_cell"]), ("followed_cell", self.bay1, self.assembly))
        self.assertEqual(self.where(d["inherits_area"]), ("followed_area", None, self.assembly))
        self.assertEqual(self.where(d["inherits_site"]), ("followed_site", None, None))
        self.assertEqual(self.where(d["inherits_none"])[0], "unassigned")
        self.assertEqual(self.where(d["no_gateway"])[0], "unassigned")

    def test_the_notice_says_how_many_moved_and_where_to(self):
        self.make_old_world()
        # Whatever the database held before is not in the count: no earlier row can be 'cell' with no
        # cell while the CHECK stood, so the five this test made are the whole count.
        notice = self.run_file()[0]
        self.assertIn("0293: 5 device(s) were In a cell with no cell and now follow their gateway", notice)
        self.assertIn("1 in its cell, 1 Area-Wide, 1 Site-Wide, 2 with no place to take", notice)

    def test_each_move_is_an_update_in_the_audit_trail_by_the_migration(self):
        d = self.make_old_world()
        self.run_file()
        self.cur.execute(
            "SELECT action, actor_source, old_data ->> 'location_scope', new_data ->> 'location_scope'"
            "  FROM public.audit_trail WHERE entity_type = 'devices' AND entity_id = %s"
            "   AND action = 'UPDATE';", (d["inherits_area"],))
        self.assertEqual(self.cur.fetchall(), [("UPDATE", "migration", "cell", "gateway")])
        # Not a device it did not move.
        self.cur.execute(
            "SELECT count(*) FROM public.audit_trail WHERE entity_type = 'devices' AND entity_id = %s"
            "   AND action = 'UPDATE';", (d["own_cell"],))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_the_check_is_back_and_validated_once_the_rows_have_moved(self):
        self.make_old_world()
        self.run_file()
        self.cur.execute(
            "SELECT convalidated, pg_get_constraintdef(oid) FROM pg_constraint"
            " WHERE conrelid = 'public.devices'::regclass AND conname = 'devices_cell_scope_names_a_cell';")
        validated, definition = self.cur.fetchone()
        self.assertTrue(validated)
        self.assertIn("location_scope <> 'cell'", definition)

    def test_a_replay_changes_nothing_and_keeps_the_oids(self):
        self.make_old_world()
        self.run_file()
        names = ("devices_cell_scope_names_a_cell", "devices_follow_gateway_has_no_place",
                 "devices_location_scope_valid")

        def snapshot():
            self.cur.execute(
                "SELECT conname, oid FROM pg_constraint WHERE conrelid = 'public.devices'::regclass"
                "   AND conname = ANY (%s) ORDER BY conname;", (list(names),))
            constraints = self.cur.fetchall()
            self.cur.execute("SELECT pg_get_viewdef('public.device_locations'::regclass), "
                             "pg_get_viewdef('public.device_uns_paths'::regclass);")
            views = self.cur.fetchone()
            self.cur.execute("SELECT count(*) FROM public.devices WHERE location_scope = 'gateway';")
            return constraints, views, self.cur.fetchone()[0]

        first = snapshot()
        notices = self.run_file()
        self.assertEqual(snapshot(), first)
        self.assertEqual(notices, [])

    def test_a_replay_over_a_database_with_nothing_to_move_says_nothing_and_moves_nothing(self):
        before = self.make_device("Follower", self.gateway["cell"])
        notices = self.run_file()
        self.assertEqual(notices, [])
        self.assertEqual(self.scope_of(before), ("gateway", None, None))


class TheReaders(Base):
    def set_site(self, name):
        self.cur.execute("UPDATE public.system_settings SET value = %s::jsonb WHERE key = 'site.name';",
                         (json.dumps(name),))

    def uns(self, device_id):
        self.cur.execute(
            "SELECT uns_path, skip_reason, area_id, cell_id FROM public.device_uns_paths WHERE device_id = %s;",
            (device_id,))
        return self.cur.fetchone()

    def test_a_followed_device_is_published_under_the_place_it_follows(self):
        self.set_site(SITE)
        cases = {
            "cell": f"{GROUP}/{SITE}/Assembly {self.tag}/Bay 1 {self.tag}/Probe",
            "area": f"{GROUP}/{SITE}/Assembly {self.tag}/Probe",
            "site": f"{GROUP}/{SITE}/Probe",
        }
        for gateway_key, path in cases.items():
            with self.subTest(gateway=gateway_key):
                device = self.make_device("Probe", self.gateway[gateway_key])
                row = self.uns(device)
                self.assertEqual((row[0], row[1]), (path, None))

    def test_a_followed_device_with_nothing_to_follow_is_unassigned(self):
        self.set_site(SITE)
        for gateway_key in ("none", "no_gateway"):
            with self.subTest(gateway=gateway_key):
                device = self.make_device("Probe", self.gateway[gateway_key])
                row = self.uns(device)
                self.assertEqual((row[0], row[1]), (None, "unassigned"))

    def test_a_followed_cell_that_is_in_no_area_is_cell_unfiled(self):
        self.set_site(SITE)
        loose = self.make_cell(f"Loose {self.tag}", None)
        gateway = self.make_gateway("cell", cell_id=loose)
        device = self.make_device("Probe", gateway)
        row = self.uns(device)
        self.assertEqual((row[0], row[1]), (None, "cell_unfiled"))

    def test_the_path_moves_with_the_gateway(self):
        self.set_site(SITE)
        device = self.make_device("Probe", self.gateway["cell"])
        self.assertEqual(self.uns(device)[0], f"{GROUP}/{SITE}/Assembly {self.tag}/Bay 1 {self.tag}/Probe")
        self.cur.execute("UPDATE public.gateways SET cell_id = NULL, location_scope = 'site_wide' WHERE id = %s;",
                         (self.gateway["cell"],))
        self.assertEqual(self.uns(device)[0], f"{GROUP}/{SITE}/Probe")

    def test_the_reasons_and_the_columns_are_0214s(self):
        self.cur.execute(
            "SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute"
            " WHERE attrelid = 'public.device_uns_paths'::regclass AND attnum > 0 AND NOT attisdropped;")
        self.assertEqual(self.cur.fetchone()[0], "device_id,area_id,cell_id,enterprise,uns_path,skip_reason")
        self.cur.execute("SELECT pg_get_viewdef('public.device_uns_paths'::regclass);")
        view = self.cur.fetchone()[0]
        reasons = set(re.findall(r"THEN '([a-z_]+)'::text", view))
        self.assertEqual(reasons, {"site_unset", "lane", "unassigned", "cell_unfiled", "unsafe_name"})

    def test_automations_document_says_site_wide_for_a_device_behind_a_site_wide_gateway(self):
        self.cur.execute("SELECT prosrc FROM pg_proc WHERE oid = 'public.automations_document(text[])'::regprocedure;")
        self.assertIn("IN ('site_wide', 'followed_site')", self.cur.fetchone()[0])

    def test_automations_document_names_each_followed_place(self):
        # Through the function: an automation whose trigger names the devices lists each one's place,
        # as the Devices page names it.
        self.person(MANAGER_ID, "Shopfloor_Manager")
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb"
                         " WHERE key = 'security.require_mfa_for_managers';")
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 10);", (METRIC,))
        devices = {key: self.make_device(f"Probe {key}", self.gateway[key]) for key in ("cell", "area", "site", "none")}
        document = [{
            "id": "follow-gateway-probe", "alias": "Probe", "description": "", "enabled": True,
            "triggers": [{"trigger": "threshold", "device": list(devices.values()), "metric": METRIC,
                          "above": 80, "for": "5m"}],
            "actions": [{"action": "alert", "severity": "warning"}],
        }]
        self.as_user(MANAGER_ID)
        self.cur.execute("SELECT public.apply_automations(%s::jsonb, false);", (Json(document),))
        self.cur.execute("SELECT public.automations_document(ARRAY['follow-gateway-probe']);")
        places = self.cur.fetchone()[0]["devices"]
        self.as_owner()
        self.assertEqual({key: places[device]["place"] for key, device in devices.items()}, {
            "cell": f"Bay 1 {self.tag} · Assembly {self.tag}",
            "area": f"Assembly {self.tag}",
            "site": "Site-wide",
            "none": None,
        })


class TheWriters(Base):
    def propose(self, device_id, patch):
        self.as_user(OPERATOR_ID)
        self.cur.execute(
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
            " VALUES ('devices', %s, %s::jsonb, 'follow the gateway') RETURNING id;",
            (device_id, json.dumps(patch)))
        proposal = self.cur.fetchone()[0]
        self.as_owner()
        return proposal

    def approve(self, proposal):
        self.as_user(MANAGER_ID)
        self.cur.execute("SELECT public.approve_proposal(%s) ->> 'status';", (proposal,))
        status = self.cur.fetchone()[0]
        self.as_owner()
        return status

    def test_a_proposal_carries_follow_gateway_and_approving_applies_it(self):
        self.person(OPERATOR_ID, "Operator")
        self.person(MANAGER_ID, "Shopfloor_Manager")
        device = self.make_device("Pinned", self.gateway["area"], scope="cell", cell_id=self.bay2)
        self.assertEqual(self.where(device)[0], "explicit")
        proposal = self.propose(device, {"location_scope": "gateway", "cell_id": None, "area_id": None})
        self.assertEqual(self.approve(proposal), "applied")
        self.assertEqual(self.where(device), ("followed_area", None, self.assembly))

    def test_a_proposal_may_also_say_follow_gateway_from_a_device_that_has_no_cell_to_clear(self):
        self.person(OPERATOR_ID, "Operator")
        self.person(MANAGER_ID, "Shopfloor_Manager")
        device = self.make_device("Site", self.gateway["site"], scope="site_wide")
        proposal = self.propose(device, {"location_scope": "gateway"})
        self.assertEqual(self.approve(proposal), "applied")
        self.assertEqual(self.where(device), ("followed_site", None, None))

    def test_a_proposal_that_leaves_a_cell_beside_follow_gateway_aborts_on_the_check(self):
        self.person(OPERATOR_ID, "Operator")
        self.person(MANAGER_ID, "Shopfloor_Manager")
        device = self.make_device("Pinned", self.gateway["area"], scope="cell", cell_id=self.bay2)
        proposal = self.propose(device, {"location_scope": "gateway"})
        self.as_user(MANAGER_ID)
        self.cur.execute("SAVEPOINT approve;")
        with self.assertRaises(psycopg2.errors.CheckViolation) as raised:
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        self.assertEqual(raised.exception.diag.constraint_name, "devices_follow_gateway_has_no_place")
        self.cur.execute("ROLLBACK TO SAVEPOINT approve;")

    def test_the_audit_row_of_an_applied_proposal_is_the_one_it_always_was(self):
        self.person(OPERATOR_ID, "Operator")
        self.person(MANAGER_ID, "Shopfloor_Manager")
        device = self.make_device("Pinned", self.gateway["cell"], scope="cell", cell_id=self.bay2)
        proposal = self.propose(device, {"location_scope": "gateway", "cell_id": None})
        self.approve(proposal)
        self.cur.execute(
            "SELECT array_agg(DISTINCT action ORDER BY action) FROM public.audit_trail"
            " WHERE entity_id = %s AND action <> 'INSERT';", (device,))
        self.assertEqual(self.cur.fetchone()[0], ["PROPOSAL_APPLIED", "UPDATE"])

    def approve_quarantined(self, device_id, **args):
        """The call with every argument named, the ones not given as the function's own defaults."""
        given = {"p_gateway_id": None, "p_cell_id": None, "p_location_scope": None, "p_set_cell": False,
                 "p_set_location_scope": False, "p_area_id": None, "p_set_area": False, **args}
        self.assertEqual(set(given), {"p_gateway_id", "p_cell_id", "p_location_scope", "p_set_cell",
                                      "p_set_location_scope", "p_area_id", "p_set_area"})
        self.cur.execute(
            "SELECT public.approve_quarantined_device(p_device_id => %s, p_actor_id => %s, p_gateway_id => %s,"
            " p_cell_id => %s, p_location_scope => %s, p_set_cell => %s, p_set_location_scope => %s,"
            " p_area_id => %s, p_set_area => %s);",
            (device_id, MANAGER_ID, given["p_gateway_id"], given["p_cell_id"], given["p_location_scope"],
             given["p_set_cell"], given["p_set_location_scope"], given["p_area_id"], given["p_set_area"]))
        return self.cur.fetchone()[0]

    def quarantined(self):
        device = self.make_device("Discovered", None)
        self.cur.execute("UPDATE public.devices SET is_quarantined = true, quarantine_reason = 'unknown_device'"
                         " WHERE id = %s;", (device,))
        return device

    def test_approving_as_follow_gateway_clears_a_cell_and_an_area_sent_with_it(self):
        self.person(MANAGER_ID, "Shopfloor_Manager")
        device = self.quarantined()
        self.approve_quarantined(device, p_gateway_id=self.gateway["area"], p_location_scope="gateway",
                                 p_set_location_scope=True, p_cell_id=self.bay2, p_set_cell=True,
                                 p_area_id=self.finishing, p_set_area=True)
        self.assertEqual(self.where(device), ("followed_area", None, self.assembly))

    def test_approving_with_no_location_answer_leaves_the_device_following_its_gateway(self):
        self.person(MANAGER_ID, "Shopfloor_Manager")
        device = self.quarantined()
        self.approve_quarantined(device, p_gateway_id=self.gateway["cell"])
        self.assertEqual(self.where(device), ("followed_cell", self.bay1, self.assembly))

    def test_approving_in_a_cell_stores_the_cell_and_follows_nothing(self):
        self.person(MANAGER_ID, "Shopfloor_Manager")
        device = self.quarantined()
        self.approve_quarantined(device, p_gateway_id=self.gateway["area"], p_location_scope="cell",
                                 p_set_location_scope=True, p_cell_id=self.bay2, p_set_cell=True)
        self.assertEqual(self.where(device), ("explicit", self.bay2, self.finishing))

    def test_approving_a_cell_scope_with_no_cell_is_refused_in_words(self):
        self.person(MANAGER_ID, "Shopfloor_Manager")
        device = self.quarantined()
        self.cur.execute("SAVEPOINT approve;")
        with self.assertRaises(psycopg2.Error) as raised:
            self.approve_quarantined(device, p_gateway_id=self.gateway["cell"], p_location_scope="cell",
                                     p_set_location_scope=True, p_cell_id=None, p_set_cell=True)
        self.assertEqual(raised.exception.pgcode, "22023")
        self.assertIn("a cell device must name its cell", str(raised.exception))
        self.cur.execute("ROLLBACK TO SAVEPOINT approve;")

    def test_approving_a_cell_scope_on_a_device_that_has_no_cell_and_names_none_is_refused_too(self):
        self.person(MANAGER_ID, "Shopfloor_Manager")
        device = self.quarantined()
        self.cur.execute("SAVEPOINT approve;")
        with self.assertRaises(psycopg2.Error) as raised:
            self.approve_quarantined(device, p_gateway_id=self.gateway["cell"], p_location_scope="cell",
                                     p_set_location_scope=True)
        self.assertEqual(raised.exception.pgcode, "22023")
        self.cur.execute("ROLLBACK TO SAVEPOINT approve;")


if __name__ == "__main__":
    unittest.main()
