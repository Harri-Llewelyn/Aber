"""
The delivery gate on broker-credential issuance (0078).

WHAT THIS PROTECTS, AND IT IS NOT THE HAPPY PATH. Issuing a credential now DELIVERS the password to
the playback worker by writing it into a file that worker reads. The security of that rests on one
predicate: only gateways the database calls playback targets may have their passwords delivered.

Get it wrong in the permissive direction and a real machine's broker password is written into a file
the replay worker reads -- and the broker's roles confine an account to `spBv1.0/+/+/<sparkplug_id>/#`, so that is
the ability to publish telemetry as that machine. Nothing fails, nothing logs, and the file looks
exactly the same as a correct one.

THE ALTERNATIVE WAS REJECTED ON THIS GROUND. Letting the worker mint its own credentials would have
needed no gate at all -- and `playback_worker._credentials()` calls itself "tier two of three"
precisely because the worker cannot authenticate as a gateway whose password it was not given. A
minting worker is a worker that can publish as any machine on the site.

Every test rolls back. Gateways are audited into the append-only `audit_trail`, so a committed
fixture leaves rows that cannot be removed.
"""

import os
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN = "00000000-0000-4000-8000-00000000d078"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class PlaybackCredentialDelivery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()
        # Self-seeded rather than the demo personas: CI's RLS job applies the migrations and
        # deliberately not seed.sql, so a suite depending on `admin@aber.local` fails there
        # with a failure that looks like the gate and is really the fixture.
        self.cur.execute(
            "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
            (ADMIN, "delivery-admin@test.local"),
        )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) "
            "SELECT %s, id FROM public.roles WHERE name = 'Administrator' "
            "ON CONFLICT DO NOTHING",
            (ADMIN,),
        )
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true)",
            ('{"sub": "%s", "role": "authenticated"}' % ADMIN,),
        )

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    def _gateway(self, *, simulated, deployment="host", archived=False):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, deployment, is_simulated, is_archived) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (gid, f"T{gid[:8]}", deployment, simulated, archived),
        )
        return self.cur.fetchone()[0]

    def _authorize(self, gateway_id):
        """The gate, unchanged by 0078 -- deliberately, see `_deliverable`."""
        self.cur.execute(
            "SELECT sparkplug_id, gateway_name "
            "  FROM public.authorize_host_gateway_credential(%s)", (gateway_id,)
        )
        return self.cur.fetchone()

    def _deliverable(self, gateway_id):
        self.cur.execute(
            "SELECT public.gateway_is_playback_delivery_target(%s)", (gateway_id,)
        )
        return self.cur.fetchone()[0]

    # -----------------------------------------------------------------------------------------
    # The gate itself
    # -----------------------------------------------------------------------------------------
    def test_a_simulated_gateway_is_a_delivery_target(self):
        gid = self._gateway(simulated=True)
        self.assertIsNotNone(self._authorize(gid), "the gate returned no row for a simulated host")
        self.assertTrue(self._deliverable(gid), "a simulated gateway must be a delivery target")

    def test_a_real_gateway_is_not(self):
        """
        THE ONE THAT MATTERS. A true here writes a real machine's broker password into a file the
        replay worker reads, and the broker's roles then lets that worker publish as the machine.
        """
        gid = self._gateway(simulated=False)
        self.assertIsNotNone(self._authorize(gid))
        self.assertFalse(self._deliverable(gid), "a real gateway must never be a delivery target")

    def test_a_gateway_that_vanished_is_not_a_delivery_target(self):
        """
        Asked immediately after an authorisation that already refused a missing gateway, so the
        only way to reach this is a row deleted in between. "Do not deliver" is the safe answer;
        raising would turn a vanished gateway into a failed credential issue for one still present.
        """
        self.assertFalse(self._deliverable("00000000-0000-4000-8000-0000000000ff"))

    def test_the_authorisation_gate_keeps_the_shape_0001_declares(self):
        """
        0078 DELIBERATELY DOES NOT TOUCH THIS FUNCTION, and the first version of it did.

        Adding a third column worked on the boot that applied it and killed the next one: 0001
        replays first, re-declares the two-column form with CREATE OR REPLACE, and that cannot
        change a return type -- so the chain aborted at file one, after 0001 had already dropped the
        FDW server with CASCADE. This is what says the gate must keep the shape 0001 gives it.
        """
        self.cur.execute(
            "SELECT count(*), max(pg_get_function_result(p.oid)) "
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname = 'public' AND p.proname = 'authorize_host_gateway_credential'"
        )
        count, result = self.cur.fetchone()
        self.assertEqual(count, 1)
        self.assertEqual(result, "TABLE(sparkplug_id text, gateway_name text)")

    def test_is_simulated_is_not_null_which_is_what_makes_the_coalesce_dead_code(self):
        """
        WRITTEN THE OTHER WAY ROUND ON PURPOSE, having first been written wrong. This started as a
        test that a NULL `is_simulated` yields false -- and the insert failed, because the column is
        NOT NULL. So 0078's `coalesce` is unreachable today, and the useful assertion is the
        constraint that makes it unreachable.

        If a later migration relaxes it, this fails and names the reason: the coalesce stops being
        defence in depth and becomes the thing deciding what gets delivered, which is a decision
        somebody should make deliberately rather than inherit.
        """
        self.cur.execute(
            "SELECT attnotnull FROM pg_attribute "
            " WHERE attrelid = 'public.gateways'::regclass AND attname = 'is_simulated'"
        )
        self.assertTrue(
            self.cur.fetchone()[0],
            "gateways.is_simulated has become nullable; 0078's coalesce now decides deliveries",
        )

    def test_the_flag_is_a_boolean_for_both_kinds_of_gateway(self):
        # NO ROLLBACK BETWEEN THE TWO. `set_config('request.jwt.claims', ..., true)` is
        # transaction-local, so rolling back mid-test would drop the caller's identity and the
        # second call would fail on the role check instead of answering the question.
        simulated = self._deliverable(self._gateway(simulated=True))
        real = self._deliverable(self._gateway(simulated=False))
        self.assertIsInstance(simulated, bool)
        self.assertIsInstance(real, bool)
        self.assertNotEqual(simulated, real)

    # -----------------------------------------------------------------------------------------
    # The refusals 0078 inherits and must not have dropped
    # -----------------------------------------------------------------------------------------
    def test_an_appliance_gateway_is_still_refused(self):
        # A remote appliance mints on the appliance; offering the browser path would be offering a
        # worse option beside a working one. Re-asserted because 0078 rewrote the whole body.
        with self.assertRaises(psycopg2.Error):
            self._authorize(self._gateway(simulated=True, deployment="remote"))
        self.conn.rollback()

    def test_an_archived_gateway_is_still_refused(self):
        with self.assertRaises(psycopg2.Error):
            self._authorize(self._gateway(simulated=True, archived=True))
        self.conn.rollback()

    def test_a_caller_without_the_role_is_still_refused(self):
        gid = self._gateway(simulated=True)
        self.cur.execute("DELETE FROM public.user_roles WHERE user_id = %s", (ADMIN,))
        with self.assertRaises(psycopg2.Error):
            self._authorize(gid)
        self.conn.rollback()

    # -----------------------------------------------------------------------------------------
    # The two predicates must not drift apart
    # -----------------------------------------------------------------------------------------
    def test_delivery_and_the_job_gate_agree(self):
        """
        Delivery is scoped to `is_simulated` because that is what `start_playback_job()` gates on.
        If one moved without the other, the worker would hold credentials for gateways it may not
        target -- and nothing would fail. It would simply hold more than it needs.

        0078 carries a boot-time self-check of the same property; this is the runtime half.
        """
        self.cur.execute(
            "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname = 'public' AND p.proname = 'start_playback_job'"
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "start_playback_job() is missing")
        self.assertIn(
            "is_simulated", row[0],
            "start_playback_job() no longer gates on is_simulated, but 0078 delivers on it",
        )

    def test_the_delivery_predicate_is_its_own_function_returning_a_boolean(self):
        """
        Declared once, by 0078 alone, and NOT a column on the authorisation gate. A function 0001
        also declares cannot have its return type changed by a later file -- see the test above and
        0078's header for the boot that proved it.
        """
        self.cur.execute(
            "SELECT count(*), max(pg_get_function_result(p.oid)) "
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname = 'public' AND p.proname = 'gateway_is_playback_delivery_target'"
        )
        count, result = self.cur.fetchone()
        self.assertEqual(count, 1, f"declared {count} times, not once")
        self.assertEqual(result, "boolean")


if __name__ == "__main__":
    unittest.main(verbosity=2)
