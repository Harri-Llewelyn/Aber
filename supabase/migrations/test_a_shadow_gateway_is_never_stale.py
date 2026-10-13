"""
A shadow gateway is never reported as gateway_stale; any other gateway still is (0182).

    python supabase/migrations/test_a_shadow_gateway_is_never_stale.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

`platform_health`'s gateway_stale arm is what Grafana's Gateway Stale rule fires on, and it reads
`gateway_status.is_stale`: heartbeat age alone, whatever the stored status. The Playback gateway
ends every replay with an NDEATH, which leaves it OFFLINE with a heartbeat that ages, so without the
shadow exclusion the rule fired after every replay. The exclusion has been lost once already, in a
redeclaration, so this pins both directions: a shadow gateway is never listed, and an ordinary one
that died the same way still is.

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


class GatewayStaleArm(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
