"""
A shadow gateway is never reported as gateway_stale; any other gateway still is (0182). Its devices,
the replay lanes, are never counted in expected_publishers; any other device still is (0185).

    python supabase/migrations/test_a_shadow_gateway_is_never_stale.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

`platform_health`'s gateway_stale arm is what Grafana's Gateway Stale rule fires on, and it reads
`gateway_status.is_stale`: heartbeat age alone, whatever the stored status. The Playback gateway
ends every replay with an NDEATH, which leaves it OFFLINE with a heartbeat that ages, so without the
shadow exclusion the rule fired after every replay. The exclusion has been lost once already, in a
redeclaration, so this pins both directions: a shadow gateway is never listed, and an ordinary one
that died the same way still is. The expected_publishers arm gates Ingestion Consuming Nothing, and
is pinned the same way.

Every test rolls back: writes to `gateways` fire the audit-trail trigger, and that table is
append-only to every application role.
"""
import os
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Past gateway_status's 90 s threshold by a wide margin, as a gateway quiet since its NDEATH is.
QUIET = "10 minutes"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class ShadowFixtures(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- fixtures ---------------------------------------------------------------------------

    def _gateway(self, is_shadow):
        """A gateway of our own: the arm keys on the flag, not on the seeded Playback row's id."""
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, "
            "is_shadow) VALUES (%s, %s, 'cell', %s, %s, %s) RETURNING sparkplug_id;",
            (gid, f"Test_Stale_GW_{gid[:8]}", "host" if is_shadow else "remote", is_shadow,
             is_shadow),
        )
        return gid, self.cur.fetchone()[0]


class GatewayStaleArm(ShadowFixtures):
    def _quiet(self, gid, status):
        """What an NDEATH (OFFLINE) or a silent gateway (ONLINE) leaves once QUIET has passed."""
        self.cur.execute(
            "UPDATE public.gateways SET status = %s, last_heartbeat = now() - interval %s "
            "WHERE id = %s;",
            (status, QUIET, gid),
        )

    def _is_stale(self, gid):
        self.cur.execute("SELECT is_stale FROM public.gateway_status WHERE id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def _reported(self, sparkplug_id):
        """Whether the view Grafana reads lists this gateway under gateway_stale."""
        self.cur.execute(
            "SELECT 1 FROM public.platform_health "
            "WHERE condition = 'gateway_stale' AND sparkplug_id = %s;",
            (sparkplug_id,),
        )
        return self.cur.fetchone() is not None

    # -- the arm ----------------------------------------------------------------------------

    def test_a_shadow_gateway_offline_after_its_ndeath_is_not_reported(self):
        gid, wire = self._gateway(is_shadow=True)
        self._quiet(gid, "OFFLINE")
        self.assertTrue(self._is_stale(gid), "the fixture is not stale, so this would prove nothing")
        self.assertFalse(self._reported(wire),
                         "a shadow gateway is reported as gateway_stale; Gateway Stale fires after "
                         "every replay")

    def test_the_seeded_playback_gateway_is_not_reported(self):
        self.cur.execute(
            "SELECT id, sparkplug_id FROM public.gateways WHERE is_shadow AND NOT is_archived "
            "LIMIT 1;")
        row = self.cur.fetchone()
        if row is None:
            self.skipTest("no live shadow gateway is seeded")
        self._quiet(row[0], "OFFLINE")
        self.assertFalse(self._reported(row[1]))

    def test_an_ordinary_gateway_offline_and_quiet_is_still_reported(self):
        """The other direction: a real appliance that died is the case the rule exists for."""
        gid, wire = self._gateway(is_shadow=False)
        self._quiet(gid, "OFFLINE")
        self.assertTrue(self._reported(wire),
                        "an ordinary gateway quiet since its NDEATH is no longer reported")

    def test_an_ordinary_gateway_gone_silent_is_still_reported(self):
        gid, wire = self._gateway(is_shadow=False)
        self._quiet(gid, "ONLINE")
        self.assertTrue(self._reported(wire))

    def test_grafana_still_reads_it(self):
        """CREATE OR REPLACE kept 0001's grants: the rule queries the view as grafana_reader."""
        self.cur.execute(
            "SELECT has_function_privilege('grafana_reader', 'public.platform_health_rows()', "
            "'EXECUTE'), has_table_privilege('grafana_reader', 'public.platform_health', 'SELECT');")
        self.assertEqual(self.cur.fetchone(), (True, True))


class ExpectedPublishersArm(ShadowFixtures):
    """
    Replay lanes are not devices that should be publishing (0185).

    Ingestion Consuming Nothing fires on silence while `expected_publishers` is above zero. A replay
    leaves the Playback gateway with a heartbeat and its lanes with a first DBIRTH, so without the
    exclusion a stack whose only devices were lanes raised the critical alert after every replay.
    Each test reads the count before and after its fixture, since the database may hold others.
    """

    def _expected(self):
        self.cur.execute(
            "SELECT value FROM public.platform_health WHERE condition = 'expected_publishers';")
        return self.cur.fetchone()[0]

    def _device(self, gateway_id, shadow_of=None, published=False):
        did = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, shadow_of, status, first_dbirth_at) "
            "VALUES (%s, %s, %s, %s, 'OFFLINE', CASE WHEN %s THEN now() END);",
            (did, f"Test_Expected_Dev_{did[:8]}", gateway_id, shadow_of, published),
        )
        return did

    def _heard_from(self, gid):
        """What a replay's NBIRTH, or any heartbeat, leaves on the gateway row."""
        self.cur.execute("UPDATE public.gateways SET last_heartbeat = now() WHERE id = %s;", (gid,))

    def test_a_replay_lane_behind_a_reporting_playback_gateway_does_not_count(self):
        real_gw, _ = self._gateway(is_shadow=False)
        original = self._device(real_gw)
        playback_gw, _ = self._gateway(is_shadow=True)
        self._heard_from(playback_gw)
        before = self._expected()
        self._device(playback_gw, shadow_of=original, published=True)
        self.assertEqual(self._expected(), before,
                         "a replay lane counts as a device that should be publishing; Ingestion "
                         "Consuming Nothing fires after every replay")

    def test_a_lane_on_the_seeded_playback_gateway_does_not_count(self):
        self.cur.execute(
            "SELECT id FROM public.gateways WHERE is_shadow AND NOT is_archived LIMIT 1;")
        row = self.cur.fetchone()
        if row is None:
            self.skipTest("no live shadow gateway is seeded")
        real_gw, _ = self._gateway(is_shadow=False)
        original = self._device(real_gw)
        self._heard_from(row[0])
        before = self._expected()
        self._device(row[0], shadow_of=original, published=True)
        self.assertEqual(self._expected(), before)

    def test_a_real_device_that_has_published_still_counts(self):
        """The other direction: the device whose silence the rule exists for."""
        real_gw, _ = self._gateway(is_shadow=False)
        before = self._expected()
        self._device(real_gw, published=True)
        self.assertEqual(self._expected(), before + 1)

    def test_a_real_device_behind_a_reporting_gateway_still_counts(self):
        real_gw, _ = self._gateway(is_shadow=False)
        self._heard_from(real_gw)
        before = self._expected()
        self._device(real_gw)
        self.assertEqual(self._expected(), before + 1)

    def test_a_device_behind_a_gateway_never_heard_from_still_does_not_count(self):
        """0092's exclusion, which 0185 rewrote as a join, holds."""
        real_gw, _ = self._gateway(is_shadow=False)
        before = self._expected()
        self._device(real_gw)
        self.assertEqual(self._expected(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
