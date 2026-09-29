"""
Archiving a gateway asks the forge to follow (0114), and asking is gated where it should be.

    python supabase/migrations/test_forge_follows_the_archive.py

Requires the Supabase database (54322 by default) and 0114 applied.

---------------------------------------------------------------------------------------------
WHAT IS UNDER TEST, AND WHAT IS NOT. forge-sweep is what archives the repository; this is the
trigger that asks it to do so NOW rather than at the next quarter hour, and the three conditions
that decide whether it asks at all. The sweep's own half -- that the repository really does end up
read-only in Gitea, and comes back out -- needs a forge, and is asserted against one in
supabase/functions/forge-sweep/test_forge_sweep.py.

WHY THE QUEUE AND NOT THE STAMP. `net.http_post()` queues into `net.http_request_queue` inside the
caller's transaction, so a suite that rolls back un-queues its own requests: nothing is sent and no
sweep runs. It is also the stronger claim. `forge_archived_at` is deliberately NOT written here --
the sweep writes it once the forge has answered -- so the queue row is the only evidence the ask
happened, and asserting on it is asserting on the thing itself.

THE GUARD THAT IS EASIEST TO LOSE is the transition. `UPDATE OF is_archived` fires whenever the
column appears in a SET list, including when it is set to the value it already held, and the
dashboard writes archived gateways in the ordinary course of editing them. Without the guard every
such write would walk the whole forge; 0001 carries the same guard on two other triggers for the
same reason, and each was written after the version without it.
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


class ForgeFollowsTheArchive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SELECT to_regprocedure('public.sweep_forge_on_archive_change()');")
            if not cur.fetchone()[0]:
                raise unittest.SkipTest("0114 has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        # Un-queues every request this test made, as well as undoing its rows.
        self.conn.rollback()
        self.conn.close()

    def sweeps_queued(self):
        """
        Requests for a forge sweep, and not the depth of the whole queue: the same transition
        fires 0038's credential revocation, which queues a request of its own. Counting both
        would make this suite fail on a change to the other trigger, and pass on a sweep that
        was never asked for.
        """
        self.cur.execute(
            "SELECT count(*) FROM net.http_request_queue WHERE url LIKE %s;", ("%/forge-sweep",)
        )
        return self.cur.fetchone()[0]

    def a_gateway(self, with_repository=True, archived=False):
        """
        An enrolled remote gateway, with or without the column that says it has a repository.

        Born archived where the test wants one: the trigger is AFTER UPDATE, so an INSERT asks for
        nothing however the row arrives, and the restore case needs a row that is already archived.
        """
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways "
            "  (id, name, description, deployment, enrolled_at, forge_repository_at, is_archived, archived_at) "
            "VALUES (%s, %s, 'forge archive suite', 'remote', now(), "
            "        CASE WHEN %s THEN now() END, %s, CASE WHEN %s THEN now() END);",
            (gid, f"Test_Forge_{gid[:8]}", with_repository, archived, archived),
        )
        return gid

    def archive(self, gid, archived=True):
        self.cur.execute(
            "UPDATE public.gateways SET is_archived = %s WHERE id = %s;", (archived, gid)
        )

    def test_archiving_a_gateway_with_a_repository_asks_for_a_sweep(self):
        gid = self.a_gateway()
        before = self.sweeps_queued()

        self.archive(gid)

        self.assertEqual(
            self.sweeps_queued(), before + 1,
            "archiving queued no sweep, so the repository stays live in the forge until the "
            "quarter-hour timer -- which is the delay 0114 exists to remove",
        )

    def test_restoring_it_asks_again(self):
        # The other direction, and the one a test written from the issue title would miss:
        # restoring is what takes the repository back OUT of the forge's archive.
        gid = self.a_gateway(archived=True)
        before = self.sweeps_queued()

        self.archive(gid, archived=False)

        self.assertEqual(self.sweeps_queued(), before + 1)

    def test_a_gateway_with_no_repository_asks_for_nothing(self):
        # A host-run, simulated or shadow gateway never gets a repository, and neither does one
        # enrolled on a deployment with no forge. Sweeping the forge for it would be a walk of
        # somebody else's API to reconcile a repository that does not exist.
        gid = self.a_gateway(with_repository=False)
        before = self.sweeps_queued()

        self.archive(gid)

        self.assertEqual(self.sweeps_queued(), before)

    def test_an_ordinary_edit_to_an_archived_gateway_asks_for_nothing(self):
        # THE GUARD MOST EASILY LOST. `UPDATE OF is_archived` fires on the column appearing in a
        # SET list, not on its value changing, so a form that posts every field would sweep the
        # forge on every save.
        gid = self.a_gateway(archived=True)
        before = self.sweeps_queued()

        self.cur.execute(
            "UPDATE public.gateways SET is_archived = true, description = 'edited' WHERE id = %s;",
            (gid,),
        )

        self.assertEqual(self.sweeps_queued(), before)

    def test_the_trigger_stamps_nothing(self):
        # forge_archived_at is the sweep's to write, once the forge has answered. Stamped here it
        # would claim a repository was archived on a deployment that has no forge at all.
        gid = self.a_gateway()

        self.archive(gid)

        self.cur.execute("SELECT forge_archived_at FROM public.gateways WHERE id = %s;", (gid,))
        self.assertIsNone(self.cur.fetchone()[0])

    def test_the_key_the_ask_carries_is_stored_under_its_current_name(self):
        # sweep_forge() reads the publishable key from the vault by name, and 0002 rewrites it on
        # every boot. The retired name must be gone, or a reader of the old name would still work
        # on this database and fail on a fresh one.
        self.cur.execute(
            "SELECT name FROM vault.secrets WHERE name IN ('supabase_publishable_key', 'supabase_anon_key');"
        )
        self.assertEqual([r[0] for r in self.cur.fetchall()], ["supabase_publishable_key"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
