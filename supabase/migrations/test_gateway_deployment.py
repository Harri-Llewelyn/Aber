"""
`gateways.deployment`, and the transitional agreement with `is_virtual` (0064).

    python supabase/migrations/test_gateway_deployment.py

Requires the Supabase database (54322 by default) and migration 0064 applied.

---------------------------------------------------------------------------------------------
WHAT THIS COLUMN IS FOR. `is_virtual` carries three incompatible definitions -- "no appliance
exists", "runs on the app host", "(Cloud / Server-Simulated)" -- while every behaviour branching on
it is about a fourth thing, remoteness. Roadmap 15 argues that at length; the evidence arrived
anyway, as `gateway_holds_a_credential()` being the wrong predicate three times: 0056 (playback
targets), 0062 (the credential inventory), 0063 (revocation never firing for a virtual gateway).

WHAT THIS SUITE PROTECTS, WHICH IS NARROWER. Not the rename -- `is_virtual` is still here and still
read by every consumer. It protects the property that makes the rename possible later: **the two
columns cannot disagree**, whichever generation of writer touched the row. Every writer in the
repository today names `is_virtual` and none names `deployment`, so if the trigger stopped agreeing
the two columns would describe different fleets and nobody would find out until a consumer moved.

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
            "RETURNING id, deployment, is_virtual;",
            tuple(cols.values()),
        )
        return self.cur.fetchone()

    def read(self, gid):
        self.cur.execute(
            "SELECT deployment, is_virtual FROM public.gateways WHERE id = %s;", (gid,)
        )
        return self.cur.fetchone()


class TestTheTwoColumnsAgree(DeploymentBase):
    """
    Both writer generations, in both directions. This is the whole safety property of 0064.
    """

    def test_an_old_writer_naming_is_virtual_gets_a_deployment(self):
        # Every writer in the repository today: provision-gateways.mjs, the create modal,
        # enroll-gateway, 0002's seed. None of them knows this column exists.
        _, deployment, _ = self.insert(is_virtual=True)
        self.assertEqual(deployment, "host")

        _, deployment, _ = self.insert(is_virtual=False)
        self.assertEqual(deployment, "remote")

    def test_a_new_writer_naming_deployment_gets_an_is_virtual(self):
        # What the rename will produce. Consumers still read is_virtual, so a row created this way
        # has to be indistinguishable to them from one created the old way.
        _, _, is_virtual = self.insert(deployment="remote")
        self.assertFalse(is_virtual)

        _, _, is_virtual = self.insert(deployment="host")
        self.assertTrue(is_virtual)

    def test_deployment_wins_when_a_caller_names_both_on_insert(self):
        # `is_virtual` defaults to false, so an insert naming only `deployment='host'` arrives with
        # both columns set and disagreeing. Refusing that would refuse the new writers this column
        # exists for, so on INSERT the explicit deployment is authoritative.
        _, deployment, is_virtual = self.insert(deployment="host", is_virtual=False)
        self.assertEqual(deployment, "host")
        self.assertTrue(is_virtual)

    def test_updating_one_moves_the_other(self):
        gid, _, _ = self.insert(is_virtual=True)

        self.cur.execute("UPDATE public.gateways SET deployment='remote' WHERE id=%s;", (gid,))
        self.assertEqual(self.read(gid), ("remote", False))

        self.cur.execute("UPDATE public.gateways SET is_virtual=true WHERE id=%s;", (gid,))
        self.assertEqual(self.read(gid), ("host", True))

    def test_restating_the_other_column_does_not_fight_the_change(self):
        """
        THE CASE THAT LOOKS LIKE A CONFLICT AND CANNOT BE ONE.

        `SET deployment='remote', is_virtual=true` on a host row reads as a caller asking for two
        contradictory things. It is not distinguishable from `SET deployment='remote'` alone: NEW
        carries the whole row, `is_virtual` is unchanged from OLD, and only a column that MOVED can
        be said to have been chosen.

        A guard against this was written first and could never fire -- both columns are two-valued
        and the row starts in agreement, so changing both flips both, which agrees. The behaviour
        pinned here is the arithmetic, not a policy.
        """
        gid, _, _ = self.insert(is_virtual=True)
        self.cur.execute(
            "UPDATE public.gateways SET deployment='remote', is_virtual=true WHERE id=%s;", (gid,)
        )
        self.assertEqual(self.read(gid), ("remote", False))

    def test_an_update_changing_both_to_agree_is_allowed(self):
        # The form a migration or a careful writer would use mid-transition.
        gid, _, _ = self.insert(is_virtual=True)
        self.cur.execute(
            "UPDATE public.gateways SET deployment='remote', is_virtual=false WHERE id=%s;", (gid,)
        )
        self.assertEqual(self.read(gid), ("remote", False))

    def test_an_unrelated_update_leaves_both_alone(self):
        gid, _, _ = self.insert(is_virtual=False)
        self.cur.execute("UPDATE public.gateways SET description='edited' WHERE id=%s;", (gid,))
        self.assertEqual(self.read(gid), ("remote", False))


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
        _, deployment, _ = self.insert(deployment="host", is_simulated=True)
        self.assertEqual(deployment, "host")

    def test_the_column_cannot_be_null(self):
        # The trigger fills it, so reaching NULL takes an explicit one -- which must still fail,
        # because the whole point is that every gateway answers this question.
        gid, _, _ = self.insert(is_virtual=True)
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
        gid, _, _ = self.insert(deployment="remote")
        self.cur.execute("SELECT deployment FROM public.gateway_status WHERE id=%s;", (gid,))
        self.assertEqual(self.cur.fetchone()[0], "remote")


if __name__ == "__main__":
    unittest.main(verbosity=2)
