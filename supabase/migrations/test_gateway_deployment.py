"""
`gateways.deployment`, and the rules that outlived the column it replaced (0064, 0066).

    python supabase/migrations/test_gateway_deployment.py

Requires the Supabase database (54322 by default) and migration 0066 applied.

---------------------------------------------------------------------------------------------
WHAT THIS COLUMN IS FOR. `is_virtual` carried three incompatible definitions -- "no appliance
exists", "runs on the app host", "(Cloud / Server-Simulated)" -- while every behaviour branching on
it was about a fourth thing, remoteness. Roadmap 15 argued that at length; the evidence arrived
anyway, as `gateway_holds_a_credential()` being the wrong predicate three times: 0056 (playback
targets), 0062 (the credential inventory), 0063 (revocation never firing for a host-run gateway).

HALF THIS SUITE WAS DELETED WHEN 0066 LANDED, AND THAT IS THE INTENDED END OF IT. It began by
pinning the agreement between `deployment` and `is_virtual` -- the property that made the rename
possible, asserted in both directions for both generations of writer. 0066 dropped the old column
and the trigger that kept them in step, so those tests now describe machinery that does not exist.
Keeping them alive against a mock of a removed trigger would be testing the scaffolding after the
building is up.

What survives is what is still true: the constraints, and the read path through a view that must be
rebuilt whenever the table's columns change.

EVERY TEST ROLLS BACK. Writes to `gateways` fire the digital-thread trigger, and that table is
append-only and cannot be pruned.
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


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class DeploymentBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_schema='public' "
                "AND table_name='gateways' AND column_name='deployment';"
            )
            if not cur.fetchone():
                raise unittest.SkipTest("0064_gateway_deployment.sql has not been applied")
            cur.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_schema='public' "
                "AND table_name='gateways' AND column_name='is_virtual';"
            )
            if cur.fetchone():
                raise unittest.SkipTest(
                    "0066_retire_is_virtual.sql has not been applied -- this suite describes the "
                    "state after the old column is gone"
                )
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def insert(self, **columns):
        gid = str(uuid.uuid4())
        cols = {"id": gid, "name": f"Test_Deploy_{gid[:8]}", "location_scope": "site_wide"}
        cols.update(columns)
        names = ", ".join(cols)
        placeholders = ", ".join(["%s"] * len(cols))
        self.cur.execute(
            f"INSERT INTO public.gateways ({names}) VALUES ({placeholders}) "
            "RETURNING id, deployment;",
            tuple(cols.values()),
        )
        return self.cur.fetchone()

    def read(self, gid):
        self.cur.execute("SELECT deployment FROM public.gateways WHERE id = %s;", (gid,))
        return self.cur.fetchone()[0]


class TestTheConstraints(DeploymentBase):

    def test_only_host_and_remote_are_sayable(self):
        with self.assertRaises(psycopg2.Error):
            self.insert(deployment="cloud")

    def test_a_simulated_gateway_cannot_be_remote(self):
        # A "remote simulator" would be a box on the plant network pretending to be a machine --
        # nothing here can provision, observe or reason about one. Stated as a cross-column CHECK
        # rather than designed away, so relaxing it later is one line.
        with self.assertRaises(psycopg2.Error) as caught:
            self.insert(deployment="remote", is_simulated=True)
        self.assertIn("gateways_simulated_is_host", str(caught.exception))

    def test_a_simulated_gateway_on_the_host_is_fine(self):
        _, deployment = self.insert(deployment="host", is_simulated=True)
        self.assertEqual(deployment, "host")

    def test_the_column_cannot_be_null(self):
        # Nothing fills it in any more -- 0066 removed the trigger with the column it synced -- so
        # this is now simply NOT NULL doing its job. Every gateway answers this question.
        gid, _ = self.insert(deployment="host")
        with self.assertRaises(psycopg2.Error):
            self.cur.execute(
                "UPDATE public.gateways SET deployment=NULL WHERE id=%s;", (gid,)
            )


class TestTheViewWasRebuilt(DeploymentBase):
    """
    `gateway_status` is `SELECT g.*`, frozen at creation. A column added without rebuilding it is
    invisible through the view and NOTHING ERRORS -- which is why check-docs-drift.mjs enforces the
    rebuild, and why the read path is asserted here rather than assumed.
    """

    def test_gateway_status_exposes_deployment(self):
        self.cur.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_schema='public' "
            "AND table_name='gateway_status' AND column_name='deployment';"
        )
        self.assertIsNotNone(self.cur.fetchone())

    def test_the_view_agrees_with_the_table(self):
        gid, _ = self.insert(deployment="remote")
        self.cur.execute("SELECT deployment FROM public.gateway_status WHERE id=%s;", (gid,))
        self.assertEqual(self.cur.fetchone()[0], "remote")


if __name__ == "__main__":
    unittest.main(verbosity=2)
