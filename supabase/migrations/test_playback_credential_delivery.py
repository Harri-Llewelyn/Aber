"""
The delivery gate on broker-credential issuance (archived migration 0078; 0183).

WHAT THIS PROTECTS, AND IT IS NOT THE HAPPY PATH. Issuing a credential now DELIVERS the password to
the playback worker by writing it into a file that worker reads. The security of that rests on one
predicate: only gateways the database calls playback targets may have their passwords delivered.
Since 0183 that is an unarchived `is_shadow` gateway, the only target a playback may have; before,
it was every `is_simulated` gateway, so each Node-RED simulator's password reached the worker.

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

    def _gateway(self, *, simulated, shadow=False, deployment="host", archived=False):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, deployment, is_simulated, is_shadow, is_archived) "
            "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (gid, f"T{gid[:8]}", deployment, simulated, shadow, archived),
        )
        return self.cur.fetchone()[0]

    def _sparkplug_id(self, gateway_id):
        self.cur.execute("SELECT sparkplug_id FROM public.gateways WHERE id = %s", (gateway_id,))
        return self.cur.fetchone()[0]

    def _targets(self):
        self.cur.execute("SELECT sparkplug_id FROM public.playback_delivery_targets()")
        return [r[0] for r in self.cur.fetchall()]

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
    def test_a_playback_gateway_is_a_delivery_target(self):
        gid = self._gateway(simulated=True, shadow=True)
        self.assertIsNotNone(self._authorize(gid), "the gate returned no row for a shadow gateway")
        self.assertTrue(self._deliverable(gid), "an is_shadow gateway must be a delivery target")

    def test_a_simulated_gateway_is_not_a_delivery_target(self):
        """
        A Node-RED simulator is never a playback target (playback_target_must_be_shadow() refuses
        it), so its password has no business in the worker's file. Its credential is issued as any
        host gateway's is, and typed into Node-RED.
        """
        gid = self._gateway(simulated=True)
        self.assertIsNotNone(self._authorize(gid), "the gate returned no row for a simulated host")
        self.assertFalse(self._deliverable(gid), "a simulated, non-shadow gateway must not be a target")

    def test_an_archived_playback_gateway_is_not_a_delivery_target(self):
        # Its broker account is disabled on archive. The gate refuses to issue for it anyway; the
        # predicate is asked on its own by playback_delivery_targets(), which prunes the file.
        gid = self._gateway(simulated=True, shadow=True, archived=True)
        self.assertFalse(self._deliverable(gid), "an archived shadow gateway must not be a target")

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

    def test_is_shadow_is_not_null_and_a_null_archived_flag_does_not_deliver(self):
        """
        `is_shadow` is NOT NULL, so the answer turns on it. `is_archived` is nullable, and a NULL
        there leaves `is_shadow AND NOT is_archived` NULL, which the coalesce turns into "do not
        deliver": the safe direction, and the one the playback dialog's `is_archived = false`
        filter takes too.
        """
        self.cur.execute(
            "SELECT attnotnull FROM pg_attribute "
            " WHERE attrelid = 'public.gateways'::regclass AND attname = 'is_shadow'"
        )
        self.assertTrue(self.cur.fetchone()[0], "gateways.is_shadow has become nullable")

        gid = self._gateway(simulated=True, shadow=True)
        self.cur.execute("UPDATE public.gateways SET is_archived = NULL WHERE id = %s", (gid,))
        self.assertIs(self._deliverable(gid), False)

    def test_the_flag_is_a_boolean_for_both_kinds_of_gateway(self):
        # NO ROLLBACK BETWEEN THE TWO. `set_config('request.jwt.claims', ..., true)` is
        # transaction-local, so rolling back mid-test would drop the caller's identity and the
        # second call would fail on the role check instead of answering the question.
        shadow = self._deliverable(self._gateway(simulated=True, shadow=True))
        real = self._deliverable(self._gateway(simulated=False))
        self.assertIsInstance(shadow, bool)
        self.assertIsInstance(real, bool)
        self.assertNotEqual(shadow, real)

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
        Delivery is scoped to `is_shadow` because that is what `playback_target_must_be_shadow()`,
        the trigger on `playback_jobs`, admits a target by. If one moved without the other, the
        worker would hold credentials for gateways it may not target -- and nothing would fail. It
        would simply hold more than it needs, which is what 0183 corrected.
        """
        for fn in ("playback_target_must_be_shadow", "gateway_is_playback_delivery_target"):
            self.assertIn("is_shadow", self._source(fn), f"{fn}() no longer reads is_shadow")
        self.assertNotIn(
            "is_simulated", self._source("gateway_is_playback_delivery_target"),
            "the delivery predicate reads is_simulated again, which delivers every simulator",
        )

    def _source(self, fn):
        self.cur.execute(
            "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname = 'public' AND p.proname = %s", (fn,)
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, f"{fn}() is missing")
        return row[0]

    # -----------------------------------------------------------------------------------------
    # The list the credential service prunes the delivered file by
    # -----------------------------------------------------------------------------------------
    def test_the_target_list_holds_playback_gateways_and_nothing_else(self):
        shadow = self._sparkplug_id(self._gateway(simulated=True, shadow=True))
        simulated = self._sparkplug_id(self._gateway(simulated=True))
        real = self._sparkplug_id(self._gateway(simulated=False))
        archived = self._sparkplug_id(self._gateway(simulated=True, shadow=True, archived=True))

        targets = self._targets()
        self.assertIn(shadow, targets)
        for other in (simulated, real, archived):
            self.assertNotIn(other, targets)

    def test_the_target_list_agrees_with_the_predicate_row_by_row(self):
        self._gateway(simulated=True, shadow=True)
        self._gateway(simulated=True)
        self.cur.execute(
            "SELECT sparkplug_id FROM public.gateways "
            " WHERE public.gateway_is_playback_delivery_target(id) ORDER BY sparkplug_id"
        )
        expected = [r[0] for r in self.cur.fetchall()]
        self.assertGreater(len(expected), 0)
        self.assertEqual(self._targets(), expected)

    def test_the_target_list_refuses_a_caller_without_the_role(self):
        self.cur.execute("DELETE FROM public.user_roles WHERE user_id = %s", (ADMIN,))
        with self.assertRaises(psycopg2.Error):
            self._targets()
        self.conn.rollback()

    def test_anon_cannot_list_the_targets(self):
        self.cur.execute(
            "SELECT has_function_privilege('anon', 'public.playback_delivery_targets()', 'EXECUTE')"
        )
        self.assertFalse(self.cur.fetchone()[0])

    def test_the_delivery_predicate_is_its_own_function_returning_a_boolean(self):
        """
        One overload, and NOT a column on the authorisation gate. 0183 redeclares it with 0001's
        signature and return type: a later file cannot change a return type 0001 declares -- see the
        test above, and archived migration 0078's header for the boot that proved it.
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
