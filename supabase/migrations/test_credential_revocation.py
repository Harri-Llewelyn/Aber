"""
Revocation reaches a virtual gateway (0063), and still cannot invent an account (0040's guarantee).

    python supabase/migrations/test_credential_revocation.py

Requires the Supabase database (54322 by default) and archived migration 0063 applied.

---------------------------------------------------------------------------------------------
THE REGRESSION THIS EXISTS FOR, demonstrated end to end before it was fixed: create a virtual
gateway, give it a broker account with a known password, publish, DELETE the gateway row, and the
credential went on publishing. `revoke_credential_on_decommission()` gated on
`gateway_holds_a_credential()` -- `NOT is_virtual AND enrolled_at IS NOT NULL` -- which is false for
every gateway a provisioned stack has, so the revocation path was dead code in practice.

BOTH DIRECTIONS ARE ASSERTED, and the second is the one that keeps 0040's guarantee alive.
Revocation is a rotation through an ADD-ONLY credential service, so asking it to rotate an account
that does not exist CREATES one, with a password nobody records. `0040` gated on `is_virtual`
precisely to prevent that, and the fix must not undo it: a gateway with no recorded credential must
still be passed over.

WHY THE REQUESTS NEVER LEAVE. `net.http_post()` queues into `net.http_request_queue` inside the
caller's transaction, so a test that rolls back un-queues its own requests -- nothing is sent, and
no junk account appears at the broker. That is the trap `0038`'s self-check records paying for: an
end-to-end check that COMMITTED had the credential service create an account per boot. Asserting on
the queue is also a stronger claim than asserting on a stamp, because the stamp is written
optimistically and the queue row is the request itself.
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


class RevocationBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute(
                "SELECT to_regprocedure('public.revoke_credential_on_decommission()');"
            )
            if not cur.fetchone()[0]:
                raise unittest.SkipTest("0038 has not been applied")
            cur.execute(
                "SELECT prosrc FROM pg_proc "
                "WHERE oid = 'public.revoke_credential_on_decommission()'::regprocedure;"
            )
            if "gateway_has_broker_credential" not in cur.fetchone()[0]:
                raise unittest.SkipTest(
                    "0063_virtual_gateways_get_revoked.sql has not been applied"
                )
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

    def queue_depth(self):
        self.cur.execute("SELECT count(*) FROM net.http_request_queue;")
        return self.cur.fetchone()[0]

    def a_gateway(self, host_run=True, enrolled=False, with_credential=False):
        """A gateway of this suite's own, plus optionally the record of a credential."""
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, enrolled_at) "
            "VALUES (%s, %s, 'revocation suite', %s, %s) RETURNING id, sparkplug_id;",
            (gid, f"Test_Revoke_{gid[:8]}", "host" if host_run else "remote",
             "now()" if enrolled else None),
        )
        row = self.cur.fetchone()
        if enrolled:
            self.cur.execute(
                "UPDATE public.gateways SET enrolled_at = now() WHERE id = %s;", (gid,)
            )
        if with_credential:
            self.cur.execute(
                "SELECT public.record_gateway_credential_issued_by_service(%s, '{}'::jsonb);",
                (gid,),
            )
        return row


class TestTheGatewaysItReaches(RevocationBase):

    def test_deleting_a_virtual_gateway_asks_for_its_credential_back(self):
        """The exact case that failed: a virtual gateway, deleted, credential left working."""
        gid, _ = self.a_gateway(host_run=True, with_credential=True)
        before = self.queue_depth()

        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (gid,))

        self.assertEqual(
            self.queue_depth(),
            before + 1,
            "deleting a host-run gateway queued no revocation. Before 0063 this was the behaviour "
            "for EVERY gateway a provisioned stack has, and the credential went on publishing "
            "after its row was gone.",
        )

    def test_archiving_a_virtual_gateway_asks_and_stamps(self):
        gid, _ = self.a_gateway(host_run=True, with_credential=True)
        before = self.queue_depth()

        self.cur.execute(
            "UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,)
        )

        self.assertEqual(self.queue_depth(), before + 1)
        self.cur.execute(
            "SELECT credential_revoked_at FROM public.gateways WHERE id = %s;", (gid,)
        )
        # Stamped OPTIMISTICALLY -- the request is queued, not answered. The sweep clears this if
        # pg_net never recorded a 2xx, which is what makes the optimism eventually correct.
        self.assertIsNotNone(self.cur.fetchone()[0])

    def test_a_physical_enrolled_gateway_still_works(self):
        """The case that was never broken, asserted so the fix is not a swap of one gap for another."""
        gid, _ = self.a_gateway(host_run=False, enrolled=True)
        before = self.queue_depth()

        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (gid,))
        self.assertEqual(self.queue_depth(), before + 1)


class TestWhatItStillPassesOver(RevocationBase):
    """
    0040's guarantee: revocation must never CREATE an account.

    The credential service is add-only, so rotating an account that does not exist provisions one
    with a password nobody records. A fix that revoked unconditionally would close the leak and
    litter the password file, one junk account per gateway ever deleted.
    """

    def test_a_virtual_gateway_with_no_recorded_credential_is_passed_over(self):
        gid, _ = self.a_gateway(host_run=True, with_credential=False)
        before = self.queue_depth()

        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (gid,))

        self.assertEqual(
            self.queue_depth(),
            before,
            "a gateway with no credential on record had one revoked. The service would CREATE the "
            "account being 'revoked' -- which is what 0040's is_virtual guard was protecting, and "
            "0063 keeps that protection by reading the record rather than the flag.",
        )

    def test_a_physical_gateway_that_never_enrolled_is_passed_over(self):
        gid, _ = self.a_gateway(host_run=False, enrolled=False)
        before = self.queue_depth()

        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (gid,))
        self.assertEqual(self.queue_depth(), before)

    def test_an_already_archived_gateway_is_not_re_revoked_by_an_ordinary_edit(self):
        gid, _ = self.a_gateway(host_run=True, with_credential=True)
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        before = self.queue_depth()

        # The trigger fires on the TRANSITION, so editing an archived gateway must not rotate a
        # credential that was revoked weeks ago and re-stamp when it happened.
        self.cur.execute(
            "UPDATE public.gateways SET description = 'edited' WHERE id = %s;", (gid,)
        )
        self.assertEqual(self.queue_depth(), before)


class TestTheSweepAgrees(RevocationBase):
    """
    The retry path has to be for the same gateways as the fast path.

    The sweep exists for the case where the trigger's asynchronous call did not land. Left asking
    the old question, it would never retry a host-run gateway -- so the safety net would have had a
    hole in exactly the shape of the bug.
    """

    def test_the_sweep_retries_a_virtual_gateway(self):
        gid, _ = self.a_gateway(host_run=True, with_credential=True)
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        # CLEARED IN A SECOND STATEMENT, and the first attempt at this test got it wrong in a way
        # worth recording: setting `credential_revoked_at = NULL` in the SAME update as
        # `is_archived = true` does nothing, because the AFTER trigger stamps it again once the
        # statement's own value is written. The sweep then found no work and the test failed
        # against correct code.
        #
        # Archived with no stamp is the state the sweep exists to repair -- the trigger asked, pg_net
        # never answered, and the sweep's first statement cleared the optimistic stamp.
        self.cur.execute(
            "UPDATE public.gateways SET credential_revoked_at = NULL WHERE id = %s;", (gid,)
        )
        before = self.queue_depth()

        self.cur.execute("SELECT public.sweep_gateway_credential_revocations();")
        asked = self.cur.fetchone()[0]

        self.assertGreaterEqual(asked, 1)
        self.assertGreater(self.queue_depth(), before)
        self.cur.execute(
            "SELECT credential_revoked_at FROM public.gateways WHERE id = %s;", (gid,)
        )
        self.assertIsNotNone(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
