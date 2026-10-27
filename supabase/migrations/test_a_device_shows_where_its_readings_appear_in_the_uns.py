"""
Each device shows its place in the Unified Namespace, or why it has none (0214).

    python supabase/migrations/test_a_device_shows_where_its_readings_appear_in_the_uns.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: `device_uns_paths` answers every device with exactly one of a path below the
root and a skip reason. The path is `<enterprise>/<site>/<area>/<cell>/<device>` at the levels the
device occupies: a cell's device (its own cell or its gateway's) under area and cell, an Area-Wide
one under its area, a Site-Wide one under the site alone. The enterprise is the group the gateway
last published under, else its configured one, else the site's group for a device with no gateway.
Each reason the view can know is given, in the bridge's order: site_unset (an empty or blank site
name), lane (Simulated and Shadow), unassigned, cell_unfiled and unsafe_name (a / + or # in the
device's or the site's name). The view runs as its caller: a setting the caller may not read is
not set for them. anon reads nothing; a person and the ingestion principal read it. A rename moves
the path at once.

EVERY TEST ROLLS BACK. Writes to areas, cells, gateways and devices fire the audit-trail trigger.
"""
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# The Service_Ingestor machine principal (0046): the identity the daemon's token names.
INGESTION_PRINCIPAL = "b0000000-0000-4000-8000-000000000002"
OPERATOR_ID = "a0d17070-0000-4000-8000-0000000214a1"
ADMIN_ID = "a0d17070-0000-4000-8000-0000000214a2"

SITE = "Cardiff"
GROUP = "Aber_0214"

# The reasons the view gives, in the order it tests them.
VIEW_REASONS = ("site_unset", "lane", "unassigned", "cell_unfiled", "unsafe_name")
COLUMNS = ["device_id", "area_id", "cell_id", "enterprise", "uns_path", "skip_reason"]


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, reads as a caller, a rollback."""

    def setUp(self):
        self.conn = get_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regclass('public.device_uns_paths');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0214 is not applied to this database")
        self.tag = uuid.uuid4().hex[:8]
        self.set_site(SITE)
        for user_id, role in ((OPERATOR_ID, "Operator"), (ADMIN_ID, "Administrator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"uns-0214-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )
        # The plant: Bay 1 in Machine Shop, with a gateway filed in it; a cell in no area.
        self.area = self.make_area(f"Machine Shop {self.tag}")
        self.cell = self.make_cell(f"Bay 1 {self.tag}", self.area)
        self.unfiled_cell = self.make_cell(f"Loose End {self.tag}", None)
        self.gateway = self.make_gateway(self.cell)
        self.loose_gateway = self.make_gateway(None)

    # -- fixtures, as the owner ----------------------------------------------------------------

    def set_site(self, value):
        self.cur.execute(
            "UPDATE public.system_settings SET value = %s::jsonb WHERE key = 'site.name';",
            (json.dumps(value),),
        )

    def make_area(self, name):
        area_id = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.areas (id, name) VALUES (%s, %s);", (area_id, name))
        return area_id

    def make_cell(self, name, area_id):
        cell_id = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.cells (id, name, area_id) VALUES (%s, %s, %s);",
                         (cell_id, name, area_id))
        return cell_id

    def make_gateway(self, cell_id, simulated=False, group=GROUP):
        gateway_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, cell_id, deployment, is_simulated, sparkplug_group) "
            "VALUES (%s, %s, %s, %s, %s, %s);",
            (gateway_id, f"Test_0214_GW_{gateway_id[:8]}", cell_id, "host" if simulated else "remote",
             simulated, group),
        )
        return gateway_id

    def make_device(self, name, gateway_id, cell_id=None, scope="cell", area_id=None, shadow_of=None):
        device_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, cell_id, location_scope, area_id, shadow_of) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s);",
            (device_id, name, gateway_id, cell_id, scope, area_id, shadow_of),
        )
        return device_id

    def name_of(self, table, row_id):
        self.cur.execute(f"SELECT name FROM public.{table} WHERE id = %s;", (row_id,))
        return self.cur.fetchone()[0]

    # -- reads ---------------------------------------------------------------------------------

    def read(self, device_id, caller=None):
        """The device's row as a dict, read as the owner or as `caller` (a user id)."""
        rows = self.select("SELECT * FROM public.device_uns_paths WHERE device_id = %s;",
                           (device_id,), caller)
        self.assertLessEqual(len(rows), 1)
        return rows[0] if rows else None

    def select(self, sql, args=(), caller=None):
        self.cur.execute("SAVEPOINT uns_read;")
        try:
            if caller:
                self.cur.execute("SELECT set_config('role', 'authenticated', true);")
                self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                                 (json.dumps({"sub": caller, "role": "authenticated"}),))
            self.cur.execute(sql, args)
            columns = [d.name for d in self.cur.description]
            rows = [dict(zip(columns, r)) for r in self.cur.fetchall()]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT uns_read;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT uns_read;")
        return rows

    def path(self, device_id):
        row = self.read(device_id)
        self.assertIsNone(row["skip_reason"], row)
        return row["uns_path"]

    def reason(self, device_id):
        row = self.read(device_id)
        self.assertIsNone(row["uns_path"], row)
        return row["skip_reason"]


class ThePath(Base):
    def test_a_device_in_its_gateway_s_cell_is_under_area_and_cell(self):
        dev = self.make_device("CNC_01", self.gateway)
        row = self.read(dev)
        self.assertEqual(row["uns_path"], f"{GROUP}/{SITE}/Machine Shop {self.tag}/Bay 1 {self.tag}/CNC_01")
        self.assertEqual((row["enterprise"], row["area_id"], row["cell_id"]), (GROUP, self.area, self.cell))

    def test_a_device_in_a_cell_of_its_own_is_under_that_cell(self):
        other = self.make_cell(f"Bay 2 {self.tag}", self.area)
        dev = self.make_device("Press_02", self.gateway, cell_id=other)
        self.assertEqual(self.path(dev), f"{GROUP}/{SITE}/Machine Shop {self.tag}/Bay 2 {self.tag}/Press_02")

    def test_an_area_wide_device_has_no_cell_level(self):
        dev = self.make_device("BMS", self.loose_gateway, scope="area_wide", area_id=self.area)
        self.assertEqual(self.path(dev), f"{GROUP}/{SITE}/Machine Shop {self.tag}/BMS")

    def test_a_site_wide_device_sits_directly_under_the_site(self):
        dev = self.make_device("Weather", self.loose_gateway, scope="site_wide")
        self.assertEqual(self.path(dev), f"{GROUP}/{SITE}/Weather")

    def test_the_group_the_gateway_publishes_under_is_the_enterprise(self):
        dev = self.make_device("CNC_01", self.gateway)
        self.cur.execute("UPDATE public.gateways SET observed_sparkplug_group = 'Observed_0214' WHERE id = %s;",
                         (self.gateway,))
        row = self.read(dev)
        self.assertEqual(row["enterprise"], "Observed_0214")
        self.assertTrue(row["uns_path"].startswith("Observed_0214/"))

    def test_a_device_with_no_gateway_takes_the_site_s_group(self):
        self.cur.execute("SELECT value #>> '{}' FROM public.system_settings WHERE key = 'sparkplug.group_id';")
        site_group = self.cur.fetchone()[0]
        dev = self.make_device("Orphan", None, scope="site_wide")
        self.assertEqual(self.path(dev), f"{site_group}/{SITE}/Orphan")

    def test_the_site_name_is_trimmed(self):
        self.set_site("  Cardiff\t")
        dev = self.make_device("Weather", self.loose_gateway, scope="site_wide")
        self.assertEqual(self.path(dev), f"{GROUP}/Cardiff/Weather")

    def test_a_rename_moves_the_path_at_once(self):
        dev = self.make_device("CNC_01", self.gateway)
        self.cur.execute("UPDATE public.areas SET name = %s WHERE id = %s;", (f"Hall {self.tag}", self.area))
        self.cur.execute("UPDATE public.devices SET name = 'CNC_99' WHERE id = %s;", (dev,))
        self.assertEqual(self.path(dev), f"{GROUP}/{SITE}/Hall {self.tag}/Bay 1 {self.tag}/CNC_99")


class TheReasons(Base):
    def test_no_site_name_comes_before_every_other_reason(self):
        dev = self.make_device("CNC_01", self.gateway)
        lane = self.make_device("Sim_01", self.make_gateway(None, simulated=True))
        loose = self.make_device("Loose", self.loose_gateway)
        for unset in ("", "   ", "\t\n"):
            with self.subTest(site=unset):
                self.set_site(unset)
                for device_id in (dev, lane, loose):
                    self.assertEqual(self.reason(device_id), "site_unset")

    def test_simulated_and_shadow_devices_are_lanes_not_places(self):
        sim = self.make_device("Sim_01", self.make_gateway(None, simulated=True))
        self.assertEqual(self.reason(sim), "lane")
        self.cur.execute("SELECT id FROM public.gateways WHERE is_shadow AND NOT is_archived LIMIT 1;")
        playback = self.cur.fetchone()
        if playback is None:
            self.skipTest("no live shadow gateway is seeded")
        original = self.make_device("CNC_01", self.gateway)
        replay = self.make_device(f"CNC_01 replay {self.tag}", playback[0], shadow_of=original)
        self.assertEqual(self.reason(replay), "lane")

    def test_a_device_nothing_places_is_unassigned(self):
        self.assertEqual(self.reason(self.make_device("Loose", self.loose_gateway)), "unassigned")

    def test_a_cell_in_no_area_leaves_a_hole(self):
        dev = self.make_device("CNC_01", self.make_gateway(self.unfiled_cell))
        row = self.read(dev)
        self.assertEqual(row["skip_reason"], "cell_unfiled")
        self.assertEqual((row["cell_id"], row["area_id"]), (self.unfiled_cell, None))

    def test_a_name_a_topic_cannot_carry_is_refused(self):
        for name in ("CNC/01", "CNC+01", "CNC#01"):
            with self.subTest(device=name):
                self.assertEqual(self.reason(self.make_device(name, self.gateway)), "unsafe_name")
        dev = self.make_device("Weather", self.loose_gateway, scope="site_wide")
        self.set_site("Card#iff")
        self.assertEqual(self.reason(dev), "unsafe_name")

    def test_a_lane_or_an_unplaced_device_is_that_before_its_name_is_checked(self):
        sim = self.make_device("Sim/01", self.make_gateway(None, simulated=True))
        loose = self.make_device("Loose/01", self.loose_gateway)
        self.assertEqual((self.reason(sim), self.reason(loose)), ("lane", "unassigned"))

    def test_every_row_has_a_path_or_a_reason_from_the_set(self):
        self.make_device("CNC_01", self.gateway)
        self.make_device("Loose", self.loose_gateway)
        for row in self.select("SELECT * FROM public.device_uns_paths;"):
            self.assertNotEqual(row["uns_path"] is None, row["skip_reason"] is None, row)
            if row["skip_reason"] is not None:
                self.assertIn(row["skip_reason"], VIEW_REASONS)
            else:
                self.assertTrue(row["uns_path"].startswith(row["enterprise"] + "/"), row)


class WhoReadsIt(Base):
    def test_the_columns_are_the_ones_the_bridge_and_the_dashboard_read(self):
        self.cur.execute("SELECT * FROM public.device_uns_paths LIMIT 0;")
        self.assertEqual([d.name for d in self.cur.description], COLUMNS)

    def test_a_person_and_the_ingestion_principal_read_it(self):
        dev = self.make_device("CNC_01", self.gateway)
        for caller in (OPERATOR_ID, INGESTION_PRINCIPAL):
            with self.subTest(caller=caller):
                self.assertIsNotNone(self.read(dev, caller=caller)["uns_path"])

    def test_it_runs_as_its_caller(self):
        # A setting only an Administrator may read is not set for anyone else.
        dev = self.make_device("CNC_01", self.gateway)
        self.cur.execute("UPDATE public.system_settings SET sensitive = true WHERE key = 'site.name';")
        self.assertEqual(self.read(dev, caller=OPERATOR_ID)["skip_reason"], "site_unset")
        self.assertIsNotNone(self.read(dev, caller=ADMIN_ID)["uns_path"])

    def test_anon_reads_nothing(self):
        self.cur.execute("SAVEPOINT anon_read;")
        self.cur.execute("SET LOCAL ROLE anon;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT * FROM public.device_uns_paths LIMIT 1;")
        self.cur.execute("ROLLBACK TO SAVEPOINT anon_read;")

    def test_nobody_writes_through_it(self):
        self.cur.execute(
            "SELECT has_table_privilege('authenticated', 'public.device_uns_paths', 'INSERT, UPDATE, DELETE');")
        self.assertFalse(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
