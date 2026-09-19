"""
A device cannot be posted onto the replay lane by hand (0083, issue #144).

    python supabase/migrations/test_shadow_lane_is_not_assignable.py

Requires the Supabase database (54322 by default) and migration 0083 applied.

---------------------------------------------------------------------------------------------
WHAT THE BUG WAS. The dashboard offered the Playback gateway in its device gateway pickers. Picking
it wrote `devices.gateway_id` and produced a device on the shadow lane with no `shadow_of` -- which
archived migration 0060 names exactly, in the course of explaining why it refuses to mint one:
"a shadow with no `shadow_of` is an asset with no provenance, which is the thing this design exists
to avoid creating." Nothing raised. The badge was even correct.

WHAT THIS SUITE IS ACTUALLY GUARDING, WHICH IS THE NARROWNESS. Writing the gate is easy; writing it
without breaking a deletion is the part worth pinning. `devices_shadow_of_fkey` is ON DELETE SET
NULL, so a lane whose original went before 0124 sits on the shadow gateway with `shadow_of IS
NULL`, and that is LEGAL; a lane may also reach that state by a direct UPDATE. Since 0124 a lane
follows its original (shadow_follows_its_original(): archived, restored and deleted with it), so an
ordinary delete no longer produces the orphan -- but the gate must still tolerate the ones that
exist, and must still let the original go.

So the two failures this suite exists to catch pull in opposite directions:

  * too loose -- the gate stops refusing hand assignment, and #144 is back;
  * too tight -- the gate refuses a write it should not see, and deleting a device that has ever
    been replayed, or editing a lane the old FK orphaned, starts failing with an error about
    provenance. That one would be found by an operator, in production, on an act that looks
    unrelated to playback.

test_deleting_the_original_still_works is the second half and is the reason this file exists rather
than a single negative assertion.

EVERY TEST ROLLS BACK. Writes to `devices` fire the digital-thread trigger, and that table is
append-only to every application role and cannot be pruned by the application at all.
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

CHECK_VIOLATION = "23514"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class ReplayLaneBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute(
                "SELECT 1 FROM pg_trigger WHERE tgname = 'trg_devices_replay_lane_is_minted' "
                "AND tgrelid = 'public.devices'::regclass AND NOT tgisinternal;"
            )
            if not cur.fetchone():
                raise unittest.SkipTest(
                    "0083_a_replay_lane_is_minted_not_assigned.sql has not been applied"
                )
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.shadow_gateway = self._gateway(is_virtual=True, is_simulated=True, is_shadow=True)
        self.real_gateway = self._gateway()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- fixtures ---------------------------------------------------------------------------

    def _gateway(self, **flags):
        """
        A gateway of our own rather than the seeded Playback one.

        THE SEEDED GATEWAY IS NOT USED ON PURPOSE. ensure_shadow_devices() finds the shadow gateway
        by its FLAG and not by 0060's pinned id -- "an operator may legitimately want a second one"
        -- so a suite that only ever tested the seeded row would pass against a gate hard-coded to
        that one uuid, which is a gate that stops working the moment anybody adds a second.
        """
        gid = str(uuid.uuid4())
        cols = {
            "id": gid,
            "name": f"Test_Lane_GW_{gid[:8]}",
            "location_scope": "cell",
            "is_virtual": flags.get("is_virtual", False),
            "is_simulated": flags.get("is_simulated", False),
            "is_shadow": flags.get("is_shadow", False),
        }
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, is_virtual, is_simulated, "
            "is_shadow) VALUES (%(id)s, %(name)s, %(location_scope)s, %(is_virtual)s, "
            "%(is_simulated)s, %(is_shadow)s);",
            cols,
        )
        return gid

    def _device(self, gateway_id=None, shadow_of=None, name=None):
        did = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, shadow_of, status) "
            "VALUES (%s, %s, %s, %s, 'OFFLINE');",
            (did, name or f"Test_Lane_Dev_{did[:8]}", gateway_id, shadow_of),
        )
        return did

    def assertRefused(self, context):
        """The refusal must be the gate's, not an incidental error that happens to raise."""
        self.assertEqual(context.exception.pgcode, CHECK_VIOLATION)
        self.assertIn("playback gateway", str(context.exception))


class InsertIsRefused(ReplayLaneBase):
    def test_a_new_device_cannot_be_created_on_a_shadow_gateway(self):
        """The schema builder's and quarantine modal's path: a device born on the replay lane."""
        with self.assertRaises(psycopg2.errors.CheckViolation) as ctx:
            self._device(gateway_id=self.shadow_gateway)
        self.assertRefused(ctx)

    def test_a_lane_with_provenance_is_created_normally(self):
        """
        What ensure_shadow_devices() does, and the gate must not be in its way.

        It sets gateway_id and shadow_of in ONE INSERT, so a BEFORE INSERT gate sees both. A gate
        written to check them in separate statements would refuse the only legitimate writer there
        is, and playback would stop working entirely.
        """
        origin = self._device(gateway_id=self.real_gateway)
        lane = self._device(gateway_id=self.shadow_gateway, shadow_of=origin)
        self.cur.execute("SELECT shadow_of FROM public.devices WHERE id = %s;", (lane,))
        self.assertEqual(str(self.cur.fetchone()[0]), origin)

    def test_an_ordinary_gateway_is_unaffected(self):
        self._device(gateway_id=self.real_gateway)

    def test_an_unassigned_device_is_unaffected(self):
        """gateway_id NULL is the Unassigned queue, not a lane."""
        self._device(gateway_id=None)


class ReassignmentIsRefused(ReplayLaneBase):
    def test_an_existing_device_cannot_be_moved_onto_a_shadow_gateway(self):
        """
        THE ACTUAL BUG IN #144. The Devices tab's picker issues an UPDATE, not an INSERT -- so a
        gate written only for INSERT would have left the reported path open while every
        creation test passed.
        """
        device = self._device(gateway_id=self.real_gateway)
        with self.assertRaises(psycopg2.errors.CheckViolation) as ctx:
            self.cur.execute(
                "UPDATE public.devices SET gateway_id = %s WHERE id = %s;",
                (self.shadow_gateway, device),
            )
        self.assertRefused(ctx)

    def test_a_device_can_still_be_moved_between_ordinary_gateways(self):
        other = self._gateway()
        device = self._device(gateway_id=self.real_gateway)
        self.cur.execute(
            "UPDATE public.devices SET gateway_id = %s WHERE id = %s;", (other, device)
        )
        self.assertEqual(self.cur.rowcount, 1)

    def test_a_lane_can_be_moved_off_the_replay_gateway(self):
        """
        Not the direction the gate guards. Recovering a lane that should never have existed means
        moving it somewhere real, and a gate that also blocked the exit would leave an operator
        with a row they could neither fix nor explain.
        """
        origin = self._device(gateway_id=self.real_gateway)
        lane = self._device(gateway_id=self.shadow_gateway, shadow_of=origin)
        self.cur.execute(
            "UPDATE public.devices SET gateway_id = %s WHERE id = %s;", (self.real_gateway, lane)
        )
        self.assertEqual(self.cur.rowcount, 1)


class TheGateIsNarrowEnough(ReplayLaneBase):
    """
    The half that stops the fix being worse than the bug. See this file's header.
    """

    def test_deleting_the_original_still_works(self):
        """
        THE REGRESSION THIS SUITE EXISTS TO CATCH. Deleting a replayed machine must not fail with
        an error about playback provenance on an operation that mentions neither.

        Since 0124 the lane goes with its original (shadow_follows_its_original() deletes it
        BEFORE the original's row goes), so the FK's SET NULL is never reached on this path. The
        assertion is that the delete succeeds and takes the lane -- the outcome
        test_archiving_is_a_lifecycle.py pins from the lifecycle's side.
        """
        origin = self._device(gateway_id=self.real_gateway)
        lane = self._device(gateway_id=self.shadow_gateway, shadow_of=origin)

        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (origin,))
        self.assertEqual(self.cur.rowcount, 1)

        self.cur.execute("SELECT 1 FROM public.devices WHERE id = %s;", (lane,))
        self.assertIsNone(self.cur.fetchone(), "the lane outlived its original")

    def test_an_orphaned_lane_can_still_be_edited(self):
        """
        A lane whose shadow_of is NULL is still a row somebody may need to rename or retire: the
        FK orphaned lanes before 0124, and nothing refuses the direct UPDATE that makes one now.
        PostgREST sends the whole row on a PATCH, so gateway_id is MENTIONED in that UPDATE even
        though it does not change -- which is why the gate compares old and new rather than trusting
        `UPDATE OF gateway_id` to mean "moved".
        """
        origin = self._device(gateway_id=self.real_gateway)
        lane = self._device(gateway_id=self.shadow_gateway, shadow_of=origin)
        self.cur.execute("UPDATE public.devices SET shadow_of = NULL WHERE id = %s;", (lane,))

        self.cur.execute(
            "UPDATE public.devices SET name = %s, gateway_id = %s WHERE id = %s;",
            ("Test_Lane_Renamed", self.shadow_gateway, lane),
        )
        self.assertEqual(self.cur.rowcount, 1)

    def test_a_lane_may_be_edited_without_restating_its_provenance(self):
        """A rename that mentions gateway_id unchanged is not an arrival."""
        origin = self._device(gateway_id=self.real_gateway)
        lane = self._device(gateway_id=self.shadow_gateway, shadow_of=origin)
        self.cur.execute(
            "UPDATE public.devices SET name = %s, gateway_id = %s WHERE id = %s;",
            ("Test_Lane_Renamed_2", self.shadow_gateway, lane),
        )
        self.assertEqual(self.cur.rowcount, 1)


class TheGateFindsTheGatewayByItsFlag(ReplayLaneBase):
    def test_a_second_shadow_gateway_is_also_closed(self):
        """
        ensure_shadow_devices() looks the gateway up by `is_shadow` precisely so that a second one
        works without it being edited. A gate pinned to 0060's seeded uuid would pass every other
        test here and be open on that second gateway.
        """
        second = self._gateway(is_virtual=True, is_simulated=True, is_shadow=True)
        with self.assertRaises(psycopg2.errors.CheckViolation) as ctx:
            self._device(gateway_id=second)
        self.assertRefused(ctx)

    def test_the_seeded_playback_gateway_is_closed(self):
        """
        The one an operator actually meets. Skips rather than fails where the seed is absent: the
        no-stack CI job applies migrations without seed.sql, and 0060's gateway is seeded by the
        migration chain rather than by seed.sql -- so this normally runs, but a stack that has
        archived it is not a broken gate.
        """
        self.cur.execute(
            "SELECT id, name FROM public.gateways WHERE is_shadow AND NOT is_archived "
            "ORDER BY created_at LIMIT 1;"
        )
        row = self.cur.fetchone()
        if not row:
            self.skipTest("this stack has no un-archived shadow gateway")

        with self.assertRaises(psycopg2.errors.CheckViolation) as ctx:
            self._device(gateway_id=str(row[0]))
        self.assertRefused(ctx)


class TheRefusalExplainsItself(ReplayLaneBase):
    def test_the_error_names_the_gateway_and_the_way_out(self):
        """
        An operator meeting this has just been told "no" about something the dashboard let them
        try. The message is the whole of what they get, so it carries the gateway's name, the
        reason (a lane stands in for a machine), and the actual route: start a playback.
        """
        # READ BEFORE THE RAISE. Once a statement fails the transaction is aborted, and every
        # query after it -- including this lookup -- fails with InFailedSqlTransaction instead.
        self.cur.execute(
            "SELECT name FROM public.gateways WHERE id = %s;", (self.shadow_gateway,)
        )
        name = self.cur.fetchone()[0]

        with self.assertRaises(psycopg2.errors.CheckViolation) as ctx:
            self._device(gateway_id=self.shadow_gateway)

        message = str(ctx.exception)
        self.assertIn(name, message)
        self.assertIn("shadow_of", message)
        self.assertIn("ensure_shadow_devices()", message)
        self.assertIn("playback", message.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
