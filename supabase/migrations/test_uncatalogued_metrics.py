"""
The metric names devices declare that no catalog row describes (0189).

    python supabase/migrations/test_uncatalogued_metrics.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

`uncatalogued_metrics` is what the Metrics page's Uncatalogued tab lists. Each test declares names
under a tag of its own and reads only those, so rows other suites left behind change nothing here.
Every test rolls back: writes to `devices` and `gateways` fire the audit-trail trigger, and that
table is append-only to every application role.
"""
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

DOUBLE, INT32, BOOLEAN = 10, 3, 11


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class UncataloguedFixtures(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        # A group of this test's own: valid as a catalog name, and unlike any other suite's.
        self.group = f"T807{uuid.uuid4().hex[:10]}"

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def name(self, leaf):
        return f"{self.group}/{leaf}"

    # -- fixtures ---------------------------------------------------------------------------

    def gateway(self, is_shadow=False):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, "
            "is_shadow) VALUES (%s, %s, 'cell', %s, %s, %s);",
            (gid, f"Test_Uncat_GW_{gid[:8]}", "host" if is_shadow else "remote", is_shadow,
             is_shadow),
        )
        return gid

    def device(self, gateway_id, declared, name=None, at="now()", shadow_of=None,
               quarantined=False):
        """A device whose last DBIRTH declared `declared`, as ingest_record_declared_metrics writes it."""
        did = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, shadow_of, is_quarantined, "
            f"last_birth_metrics, last_birth_metrics_at) VALUES (%s, %s, %s, %s, %s, %s, {at}) "
            "RETURNING sparkplug_id;",
            (did, name or f"Test_Uncat_Dev_{did[:8]}", gateway_id, shadow_of, quarantined,
             declared),
        )
        return did, self.cur.fetchone()[0]

    def catalogue(self, name, deprecated=False):
        self.cur.execute(
            "INSERT INTO public.metric_catalog (name, datatype, deprecated) VALUES (%s, %s, %s);",
            (name, DOUBLE, deprecated),
        )

    def birth_value(self, sparkplug_id, name, datatype):
        """What ingest_store_birth_parameters keeps for a metric its DBIRTH gave a value."""
        self.cur.execute(
            "INSERT INTO public.asset_config (asset_id, metric_name, val_double, datatype) "
            "VALUES (%s, %s, 1, %s);",
            (sparkplug_id, name, datatype),
        )

    def archive(self, device_id):
        self.cur.execute(
            "UPDATE public.devices SET is_archived = true, archived_at = now() WHERE id = %s;",
            (device_id,))

    def row(self, name):
        """The view's row for one name, or None: (device_count, devices, last_declared_at, datatypes)."""
        self.cur.execute(
            "SELECT device_count, devices, last_declared_at, datatypes "
            "FROM public.uncatalogued_metrics WHERE metric_name = %s;",
            (name,),
        )
        rows = self.cur.fetchall()
        self.assertLessEqual(len(rows), 1, f"{name!r} is listed more than once")
        return rows[0] if rows else None

    def listed(self, name):
        return self.row(name) is not None


class WhatIsListed(UncataloguedFixtures):
    def test_a_declared_name_no_catalog_row_has_is_listed_with_its_devices(self):
        gw = self.gateway()
        load = self.name("Load")
        a, _ = self.device(gw, [load, self.name("Other")], name="Press_B",
                           at="'2026-10-01T10:00:00Z'")
        b, _ = self.device(gw, [load], name="Press_A", at="'2026-10-02T10:00:00Z'")

        count, devices, last_declared_at, datatypes = self.row(load)
        self.assertEqual(count, 2)
        self.assertEqual(devices, [
            {"id": b, "name": "Press_A", "quarantined": False},
            {"id": a, "name": "Press_B", "quarantined": False},
        ], "each device with its id and name, by name")
        self.assertEqual(last_declared_at.isoformat(), "2026-10-02T10:00:00+00:00",
                         "the latest last_birth_metrics_at among the devices declaring it")
        self.assertEqual(datatypes, [], "no birth carried a value for it, so no datatype is known")

    def test_a_name_declared_twice_by_one_device_counts_that_device_once(self):
        gw = self.gateway()
        load = self.name("Load")
        self.device(gw, [load, load])
        self.assertEqual(self.row(load)[0], 1)

    def test_a_catalogued_name_is_not_listed(self):
        gw = self.gateway()
        self.catalogue(self.name("Load"))
        self.device(gw, [self.name("Load"), self.name("Speed")])
        self.assertFalse(self.listed(self.name("Load")))
        self.assertTrue(self.listed(self.name("Speed")), "the fixture lists nothing at all")

    def test_a_deprecated_catalog_row_still_counts_as_catalogued(self):
        gw = self.gateway()
        self.catalogue(self.name("Load"), deprecated=True)
        self.device(gw, [self.name("Load")])
        self.assertFalse(self.listed(self.name("Load")),
                         "a deprecated metric is listed as uncatalogued; Restore is its way back")

    def test_a_name_matches_a_catalog_row_exactly_case_included(self):
        """The catalog's unique key, i3X and the AAS export all match the name exactly."""
        gw = self.gateway()
        self.catalogue(self.name("Load"))
        self.device(gw, [self.name("LOAD")])
        self.assertTrue(self.listed(self.name("LOAD")))

    def test_the_datatypes_are_what_the_births_carried(self):
        gw = self.gateway()
        load = self.name("Load")
        _, wire_a = self.device(gw, [load])
        _, wire_b = self.device(gw, [load])
        _, wire_c = self.device(gw, [load])
        self.birth_value(wire_a, load, DOUBLE)
        self.birth_value(wire_b, load, INT32)
        self.birth_value(wire_c, load, DOUBLE)
        self.assertEqual(self.row(load)[3], [INT32, DOUBLE], "each code once, in order")

    def test_a_birth_value_for_a_name_the_device_no_longer_declares_is_not_used(self):
        gw = self.gateway()
        load = self.name("Load")
        _, wire = self.device(gw, [load])
        self.birth_value(wire, self.name("Gone"), BOOLEAN)
        self.assertEqual(self.row(load)[3], [])
        self.assertFalse(self.listed(self.name("Gone")))

    def test_a_device_property_is_listed(self):
        """`Properties/*` is a device's own data under a valid catalog name: catalogued with an OPC
        40001 Machinery identification id, it fills that Digital Nameplate field."""
        gw = self.gateway()
        prop = f"Properties/{self.group}"
        self.device(gw, [prop])
        self.assertTrue(self.listed(prop))


class WhatIsLeftOut(UncataloguedFixtures):
    def test_sparkplug_control_metrics_are_not_listed(self):
        gw = self.gateway()
        controls = [f"Device Control/{self.group}", f"Node Control/{self.group}", "bdSeq"]
        self.device(gw, controls + [self.name("Load")])
        for name in controls:
            self.assertFalse(self.listed(name), f"{name!r} is listed; it is a command, not a reading")
        self.assertTrue(self.listed(self.name("Load")))

    def test_an_archived_device_is_left_out(self):
        gw = self.gateway()
        load = self.name("Load")
        kept, _ = self.device(gw, [load])
        gone, _ = self.device(gw, [load])
        self.archive(gone)
        count, devices, _, _ = self.row(load)
        self.assertEqual(count, 1)
        self.assertEqual([d["id"] for d in devices], [kept])

    def test_a_name_only_an_archived_device_declares_is_not_listed(self):
        gw = self.gateway()
        did, _ = self.device(gw, [self.name("Load")])
        self.archive(did)
        self.assertFalse(self.listed(self.name("Load")))

    def test_a_replay_lane_is_left_out(self):
        gw = self.gateway()
        playback = self.gateway(is_shadow=True)
        load = self.name("Load")
        original, _ = self.device(gw, [self.name("Speed")])
        self.device(playback, [load], shadow_of=original)
        self.assertFalse(self.listed(load),
                         "a replay lane's declared metrics are listed; a replay is not a machine")

    def test_a_quarantined_device_is_listed_and_marked(self):
        gw = self.gateway()
        load = self.name("Load")
        did, _ = self.device(gw, [load], quarantined=True)
        devices = self.row(load)[1]
        self.assertEqual([(d["id"], d["quarantined"]) for d in devices], [(did, True)],
                         "a metric can be catalogued before its device is approved")

    def test_a_device_that_declared_nothing_adds_nothing(self):
        gw = self.gateway()
        did, _ = self.device(gw, None)
        self.cur.execute(
            "SELECT count(*) FROM public.uncatalogued_metrics u, jsonb_array_elements(u.devices) e "
            "WHERE e->>'id' = %s;", (did,))
        self.assertEqual(self.cur.fetchone()[0], 0)


class WhoMayRead(UncataloguedFixtures):
    def as_authenticated(self):
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;',
                         ('{"sub": "%s", "role": "authenticated"}' % uuid.uuid4(),))

    def test_the_view_runs_as_its_caller(self):
        self.cur.execute(
            "SELECT reloptions FROM pg_class WHERE oid = 'public.uncatalogued_metrics'::regclass;")
        self.assertIn("security_invoker=true", self.cur.fetchone()[0] or [])

    def test_a_signed_in_caller_reads_it(self):
        gw = self.gateway()
        load = self.name("Load")
        self.device(gw, [load])
        self.as_authenticated()
        self.assertEqual(self.row(load)[0], 1)

    def test_the_callers_rls_on_devices_applies_through_the_view(self):
        """No role is narrowed on `devices` today, so a restrictive policy stands in for one."""
        gw = self.gateway()
        load = self.name("Load")
        seen, _ = self.device(gw, [load])
        hidden, _ = self.device(gw, [load])
        self.cur.execute(
            "CREATE POLICY t807_hides_one_device ON public.devices AS RESTRICTIVE FOR SELECT "
            "TO authenticated USING (id <> %s::uuid);", (hidden,))
        self.assertEqual(self.row(load)[0], 2, "the owner sees both; the fixture proves nothing")
        self.as_authenticated()
        count, devices, _, _ = self.row(load)
        self.assertEqual(count, 1, "a device the caller cannot read is counted through the view")
        self.assertEqual([d["id"] for d in devices], [seen])

    def test_the_callers_rls_on_the_catalog_applies_through_the_view(self):
        gw = self.gateway()
        load = self.name("Load")
        self.catalogue(load)
        self.device(gw, [load])
        self.cur.execute(
            "CREATE POLICY t807_hides_one_metric ON public.metric_catalog AS RESTRICTIVE FOR SELECT "
            "TO authenticated USING (name <> %s);", (load,))
        self.assertFalse(self.listed(load))
        self.as_authenticated()
        self.assertTrue(self.listed(load), "the view read the catalog as its owner, not the caller")

    def test_anon_cannot_read_it(self):
        self.cur.execute(
            "SELECT has_table_privilege('anon', 'public.uncatalogued_metrics', 'SELECT');")
        self.assertFalse(self.cur.fetchone()[0])
        self.cur.execute("SET LOCAL ROLE anon;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT 1 FROM public.uncatalogued_metrics LIMIT 1;")

    def test_nobody_writes_through_it(self):
        for role in ("anon", "authenticated"):
            self.cur.execute(
                "SELECT has_table_privilege(%s, 'public.uncatalogued_metrics', "
                "'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');", (role,))
            self.assertFalse(self.cur.fetchone()[0], f"{role} holds a write privilege on the view")


if __name__ == "__main__":
    unittest.main(verbosity=2)
