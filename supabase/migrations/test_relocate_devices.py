"""
Tests for public.relocate_devices() (archived migration 0033).

WHAT THIS SUITE IS ACTUALLY DEFENDING. "An admin can move devices" is the easy half and almost
none of these tests are about it:

  1. ONE BATCH IS ONE CAUSATION. This is the entire reason the RPC exists. Six machines
     reassigned in one gesture must produce six `audit_trail` rows carrying ONE `causation_id`,
     because that is what the event drawer's "Same transaction" control reads. The property does
     not live in 0033 at all -- it emerges from `log_audit_trail_event()` (0005, re-declared by
     0026) stamping `txid_current()` while every UPDATE runs in one call. A later migration could
     re-declare that trigger without stamping causation and 0033 would still "work" in every
     visible way, silently going back to producing six unrelated rows.

  2. A REFUSED BATCH LEAVES NOTHING BEHIND. A half-applied rearrangement -- three machines moved,
     three not, no record the other three were ever intended -- is strictly worse than the
     immediate per-drop writes this replaced. So an unknown device or an unknown cell anywhere in
     the array must roll back the moves that already succeeded in the same call.

  3. AUTHORITY IS RE-DERIVED, NOT INHERITED. The function is SECURITY DEFINER, so RLS does not
     apply inside it and `devices_update_privileged` is never consulted. If the `has_role()` check
     at the top were ever dropped, ANY authenticated user -- an Operator, an Auditor -- could
     relocate the entire shopfloor, and no policy anywhere would stop them. That is a much larger
     hole than the per-row path ever had, and it is created by the very thing that buys atomicity.

  4. A MISSING location_scope IS AN ERROR, not a default. Defaulting to 'cell' would mean a caller
     that forgot the key silently clears `site_wide` off an asset an operator deliberately
     asserted has no cell.

FIXTURES ARE BUILT AND ROLLED BACK PER TEST, and they include `auth.users` rows, which no other
suite in this directory needs. `audit_trail.changed_by` is FK'd to `auth.users`, so a persona
that exists only in `public.user_roles` -- which is how the other RLS suites seed themselves,
because CI applies the migrations and deliberately never runs seed.sql -- makes the audit
trigger's own INSERT violate that key. The failure then surfaces from inside the audit path, as a
constraint name, and looks nothing like the fixture problem it is.
"""
import json
import os
import unittest
import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Self-seeded personas, distinct from both the demo users and the ids the other RLS suites use, so
# a fixture collision cannot make one suite depend on another having run.
ADMIN_ID = "4e10ca7e-0000-4000-8000-0000000000ad"
MANAGER_ID = "4e10ca7e-0000-4000-8000-0000000000a9"
OPERATOR_ID = "4e10ca7e-0000-4000-8000-00000000009e"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def as_user(cur, user_id):
    """
    Become `authenticated` with a JWT subject, THE WAY PostgREST 12.2 ACTUALLY DOES IT.

    ONLY `request.jwt.claims`. The legacy `request.jwt.claim.sub` is deliberately not set: nothing
    in the deployed stack sets it, and a fixture that sets both is exactly how 0031's `updated_by`
    bug survived a passing test suite.
    """
    cur.execute("SET LOCAL ROLE authenticated;")
    cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))


def as_superuser(cur):
    """Back to the migration role, to read the audit table the RPC's writes landed in."""
    cur.execute("RESET ROLE;")


class RelocateDevices(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.relocate_devices(jsonb)');")
                if cur.fetchone()[0] is None:
                    raise RuntimeError(
                        "public.relocate_devices(jsonb) does not exist -- run archived migration 0033 first."
                    )
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self._seed()

    def tearDown(self):
        # EVERY test is one transaction that is thrown away. That is what lets this suite build
        # cells, devices and auth users freely and still be safe to point at a running stack.
        self.conn.rollback()
        self.cur.close()
        self.conn.close()

    # -- fixture -------------------------------------------------------------------------------

    def _seed(self):
        cur = self.cur
        # BY NAME, not by a hardcoded id. `roles.id` is an integer assigned by 0001, and a suite
        # that hardcodes 1 == Administrator is asserting a fact about a sequence.
        cur.execute("SELECT id, name FROM public.roles WHERE name IN %s;",
                    (("Administrator", "Shopfloor_Manager", "Operator"),))
        by_name = {name: rid for rid, name in cur.fetchall()}
        for needed in ("Administrator", "Shopfloor_Manager", "Operator"):
            if needed not in by_name:
                raise RuntimeError(f"role {needed!r} is missing; 0001 did not run cleanly.")

        for uid, role in ((ADMIN_ID, "Administrator"),
                          (MANAGER_ID, "Shopfloor_Manager"),
                          (OPERATOR_ID, "Operator")):
            # `id` is the only column without a default on this image's auth.users, which is what
            # makes seeding one here viable at all -- but an id ALONE is the definition of a machine
            # principal ("no email, no password, no identity provider"), and 0080 refuses a role to
            # anything is_machine_principal() recognises. These three stand in for PEOPLE, so they
            # are given the email that says so.
            cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (uid, f"{uid}@relocate-devices.test"),
            )
            cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (uid, by_name[role]),
            )

        cur.execute("INSERT INTO public.cells (name) VALUES ('T_Cell_A') RETURNING id;")
        self.cell_a = cur.fetchone()[0]
        cur.execute("INSERT INTO public.cells (name) VALUES ('T_Cell_B') RETURNING id;")
        self.cell_b = cur.fetchone()[0]

        # Three devices, all starting in cell A, so any move to B is guaranteed to be a real
        # change rather than a no-op the audit trigger correctly suppresses.
        self.devices = []
        for n in range(3):
            cur.execute(
                "INSERT INTO public.devices (name, cell_id, location_scope)"
                " VALUES (%s, %s, 'cell') RETURNING id;",
                (f"T_Device_{n}", self.cell_a),
            )
            self.devices.append(cur.fetchone()[0])

        # Committed to nothing -- this is all inside the test's transaction. Asserted rather than
        # assumed: if has_role() cannot see these rows, every authority test below would pass by
        # being denied for entirely the wrong reason.
        cur.execute(
            "SELECT r.name FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id"
            " WHERE ur.user_id = %s;", (ADMIN_ID,))
        roles = [row[0] for row in cur.fetchall()]
        if "Administrator" not in roles:
            raise RuntimeError(f"fixture user {ADMIN_ID} is not an Administrator: {roles}")

    def _move(self, device_id, cell_id, scope="cell"):
        return {"device_id": str(device_id),
                "cell_id": None if cell_id is None else str(cell_id),
                "location_scope": scope}

    def _relocate(self, moves, user=ADMIN_ID):
        """
        Call the RPC INSIDE A SAVEPOINT, and that is not defensive plumbing -- it is what makes the
        atomicity tests mean anything.

        A failing statement aborts the whole transaction, and this suite's fixture lives in that
        transaction. Recovering with a plain `rollback()` therefore destroys the cells and devices
        the assertion was about, and "no device is in cell B" passes because no device exists at
        all. Rolling back to a savepoint instead unwinds exactly what the RPC did and leaves the
        fixture standing, so the test can assert the devices are still where they started -- which
        is the actual claim.
        """
        self.cur.execute("SAVEPOINT before_relocate;")
        try:
            as_user(self.cur, user)
            self.cur.execute("SELECT public.relocate_devices(%s::jsonb);", (json.dumps(moves),))
            result = self.cur.fetchone()[0]
        except Exception:
            self.cur.execute("ROLLBACK TO SAVEPOINT before_relocate;")
            as_superuser(self.cur)
            raise
        as_superuser(self.cur)
        return result

    def _trail_rows(self, device_ids):
        """
        The UPDATE rows only.

        `action = 'UPDATE'` IS NOT A TIDY-UP, it is the difference between reading the RPC's work
        and reading the fixture's. An INSERT is always an event -- 0005 suppresses no-op UPDATEs
        and nothing else -- so creating three devices in setUp writes three trail rows of its own,
        attributed to nobody because the fixture runs as `postgres` with no JWT. Without this
        filter the attribution test reads [None, <admin>] and the "refused batch leaves no rows"
        test reads the fixture's own INSERTs as evidence the rollback failed. Both did.
        """
        self.cur.execute(
            "SELECT entity_id, causation_id, changed_by FROM public.audit_trail"
            " WHERE entity_type = 'devices' AND action = 'UPDATE'"
            "   AND entity_id = ANY(%s::uuid[]);",
            ([str(d) for d in device_ids],),
        )
        return self.cur.fetchall()

    # -- the property this whole item exists for ----------------------------------------------

    def test_a_batch_shares_exactly_one_causation_id(self):
        """
        THE HEADLINE. Three devices moved in one call must produce three trail rows carrying ONE
        causation_id. Before 0033 this was three separate PUTs and therefore three transactions,
        three causations, and three rows that looked like three unrelated decisions.

        The causation is read back OUT OF THE AUDIT TABLE, not taken from the function's return
        value. The RPC could correctly report a single transaction while the trigger stamped
        nothing at all, which is precisely the regression a later re-declaration would cause.

        WHAT THIS TEST CANNOT PROVE, AND WHY IT IS STILL THE RIGHT TEST. The fixture and the RPC
        share this transaction, so `txid_current()` is the same number for both and "all three
        rows agree" would hold even if the RPC were not batching anything. Nothing available here
        fixes that: plpgsql has no autonomous transactions, so a single call CANNOT span more than
        one transaction, and demonstrating the contrast would mean committing relocations whose
        `audit_trail` rows are immutable by 0006 and could never be cleaned up again.

        So the assertions below are chosen to be the ones that still bite. A trigger re-declared
        without causation leaves NULLs, which `assertIsNotNone` catches; a trigger stamping
        something other than the transaction breaks the match against the id the RPC reported,
        which is the number an operator would follow into the drawer. The count catches a batch
        that silently dropped a move.
        """
        result = self._relocate([self._move(d, self.cell_b) for d in self.devices])
        self.assertEqual(result["applied"], 3, result)
        self.assertEqual(result["unchanged"], 0, result)

        rows = self._trail_rows(self.devices)
        self.assertEqual(len(rows), 3, f"expected one trail row per device, got {rows}")

        causations = {r[1] for r in rows}
        self.assertEqual(
            len(causations), 1,
            f"three devices moved in one batch produced {len(causations)} distinct causation_id(s): "
            f"{causations}. relocate_devices() is no longer one transaction, or "
            f"log_audit_trail_event() has stopped stamping causation -- see 0026."
        )
        causation = causations.pop()
        self.assertIsNotNone(
            causation,
            "the trail rows carry a NULL causation_id. log_audit_trail_event() has been "
            "re-declared without stamping txid_current() -- see the note at the top of 0026, "
            "which exists because that has happened before."
        )
        self.cur.execute("SELECT txid_current();")
        self.assertEqual(
            causation, self.cur.fetchone()[0],
            "causation_id is not this transaction's id. Whatever the trigger is stamping, it is "
            "not something the Audit Trail's 'Same transaction' grouping can be built on."
        )

    def test_the_reported_causation_is_the_one_in_the_trail(self):
        """
        The returned id is what a caller would follow into the Audit Trail. If it does not
        match the rows, it is a link to somebody else's transaction.
        """
        result = self._relocate([self._move(d, self.cell_b) for d in self.devices])
        rows = self._trail_rows(self.devices)
        self.assertEqual({r[1] for r in rows}, {result["causation_id"]})

    def test_the_batch_is_attributed_to_the_operator_who_applied_it(self):
        """
        SECURITY DEFINER does not change who `auth.uid()` resolves to -- the JWT claims are session
        state, not role state -- so the trail must still name the human. An audit trail that
        attributes a rearrangement to `postgres` records that it happened and loses who did it.
        """
        self._relocate([self._move(self.devices[0], self.cell_b)])
        rows = self._trail_rows([self.devices[0]])
        self.assertEqual([str(r[2]) for r in rows], [ADMIN_ID])

    # -- atomicity ------------------------------------------------------------------------------

    def test_an_unknown_device_rolls_back_the_whole_batch(self):
        """
        The first two moves are perfectly valid and are applied before the third is even read.
        They must not survive. This is the half-applied batch that deferring the commit exists to
        make impossible.
        """
        missing = "00000000-0000-4000-8000-00000000dead"
        with self.assertRaises(psycopg2.Error) as ctx:
            self._relocate([
                self._move(self.devices[0], self.cell_b),
                self._move(self.devices[1], self.cell_b),
                self._move(missing, self.cell_b),
            ])
        self.assertIn("not found", str(ctx.exception))
        # raise_not_found() (0165): SQLSTATE PGRST, with the body PostgREST answers 404 with.
        self.assertEqual(ctx.exception.pgcode, "PGRST")
        self.assertEqual(json.loads(ctx.exception.diag.message_primary)["message"],
                         f"device {missing} not found; no part of this batch was applied")
        self.assertEqual(json.loads(ctx.exception.diag.message_detail), {"status": 404, "headers": {}})

        # THE TWO VALID MOVES MUST BE GONE. They were applied -- the loop reached the third
        # element only after updating the first two -- so this is the rollback being read back,
        # not an absence of work.
        self.cur.execute(
            "SELECT count(*) FROM public.devices WHERE id = ANY(%s::uuid[]) AND cell_id = %s;",
            ([str(d) for d in self.devices], self.cell_b))
        self.assertEqual(self.cur.fetchone()[0], 0,
                         "a device stayed in the target cell after the batch was refused")

        self.cur.execute(
            "SELECT count(*) FROM public.devices WHERE id = ANY(%s::uuid[]) AND cell_id = %s;",
            ([str(d) for d in self.devices], self.cell_a))
        self.assertEqual(self.cur.fetchone()[0], 3,
                         "the devices did not all return to where they started")

    def test_an_unknown_cell_rolls_back_the_whole_batch(self):
        missing = "00000000-0000-4000-8000-0000000000ce"
        with self.assertRaises(psycopg2.Error) as ctx:
            self._relocate([
                self._move(self.devices[0], self.cell_b),
                self._move(self.devices[1], missing),
            ])
        self.assertIn("not found", str(ctx.exception))

    def test_a_partial_batch_leaves_no_trail_rows(self):
        """
        The audit consequence of the above, stated separately because it is the one that matters:
        a refused batch must not leave a record of the moves it did make before failing.
        """
        missing = "00000000-0000-4000-8000-00000000dead"
        with self.assertRaises(psycopg2.Error):
            self._relocate([
                self._move(self.devices[0], self.cell_b),
                self._move(missing, self.cell_b),
            ])
        self.assertEqual(self._trail_rows(self.devices), [])

    # -- authority ------------------------------------------------------------------------------

    def test_an_operator_cannot_relocate(self):
        """
        THE HOLE ATOMICITY OPENS. RLS is not consulted inside a SECURITY DEFINER function, so
        `devices_update_privileged` cannot refuse this call -- only the has_role() check at the top
        of 0033 can. Without it every authenticated user could rearrange the whole shopfloor.
        """
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self._relocate([self._move(self.devices[0], self.cell_b)], user=OPERATOR_ID)

    def test_a_shopfloor_manager_can_relocate(self):
        """
        The allow-list must match `devices_update_privileged` exactly. A batch that only an
        Administrator could apply would be a quiet privilege REDUCTION for the role that does this
        work daily, and the symptom would be a manager's rearrangement silently refusing.
        """
        result = self._relocate([self._move(self.devices[0], self.cell_b)], user=MANAGER_ID)
        self.assertEqual(result["applied"], 1, result)

    def test_anon_does_not_hold_execute(self):
        """
        Not redundant with the authority test. This database's `supabase_admin` DEFAULT ACL grants
        EXECUTE on every new public function to anon, authenticated and service_role, so 0033's
        GRANT is additive and only its REVOKE narrows anything. has_role() would still refuse the
        call, but an anon entry point leaks device and cell existence through distinct SQLSTATEs.
        """
        self.cur.execute(
            "SELECT has_function_privilege('anon', 'public.relocate_devices(jsonb)', 'EXECUTE');")
        self.assertFalse(self.cur.fetchone()[0])

    # -- input contract -------------------------------------------------------------------------

    def test_a_duplicate_device_is_refused(self):
        """
        Two destinations for one device is an ambiguous batch. "Last one wins" would silently
        discard an instruction the operator actually gave.
        """
        with self.assertRaises(psycopg2.Error) as ctx:
            self._relocate([
                self._move(self.devices[0], self.cell_b),
                self._move(self.devices[0], self.cell_a),
            ])
        self.assertIn("more than once", str(ctx.exception))

    def test_a_missing_location_scope_is_refused(self):
        """
        Absent is NOT 'cell'. Defaulting would let a caller that forgot the key silently clear
        `site_wide` off an asset an operator deliberately asserted has no single cell.
        """
        with self.assertRaises(psycopg2.Error) as ctx:
            self._relocate([{"device_id": str(self.devices[0]), "cell_id": str(self.cell_b)}])
        self.assertIn("location_scope", str(ctx.exception))

    def test_an_empty_batch_is_refused(self):
        """
        A caller bug, not a no-op. The page disables Apply at zero staged moves; a call arriving
        with none means that guard is gone, and "success, nothing done" would hide it.
        """
        with self.assertRaises(psycopg2.Error):
            self._relocate([])

    def test_an_invalid_scope_is_refused(self):
        with self.assertRaises(psycopg2.Error):
            self._relocate([self._move(self.devices[0], self.cell_b, scope="basement")])

    # -- the location model ---------------------------------------------------------------------

    def test_site_wide_clears_the_cell(self):
        """
        Mirrors devices_site_wide_has_no_cell, and mirrors locationFieldsFrom() on the
        single-device path. FORCED rather than refused: "site-wide, in cell B" is an incompletely
        cleared form, not something to reject with a constraint name.
        """
        result = self._relocate([self._move(self.devices[0], self.cell_b, scope="site_wide")])
        self.assertEqual(result["applied"], 1, result)
        self.cur.execute(
            "SELECT cell_id, location_scope FROM public.devices WHERE id = %s;",
            (self.devices[0],))
        cell_id, scope = self.cur.fetchone()
        self.assertIsNone(cell_id)
        self.assertEqual(scope, "site_wide")

    def test_clearing_the_cell_does_not_touch_the_gateway(self):
        """
        A drop says where the machine IS. It says nothing about which connector reaches it, and
        expressing a location by rewiring the data path is the coupling archived migration 0036
        removed. Unassigned is reached by clearing the explicit cell, never by detaching a gateway.
        """
        self.cur.execute("INSERT INTO public.gateways (name) VALUES ('T_GW') RETURNING id;")
        gw = self.cur.fetchone()[0]
        self.cur.execute("UPDATE public.devices SET gateway_id = %s WHERE id = %s;",
                         (gw, self.devices[0]))
        self._relocate([self._move(self.devices[0], None)])
        self.cur.execute("SELECT gateway_id, cell_id FROM public.devices WHERE id = %s;",
                         (self.devices[0],))
        gateway_id, cell_id = self.cur.fetchone()
        self.assertEqual(gateway_id, gw, "the batch detached the device's gateway")
        self.assertIsNone(cell_id)

    def test_a_no_op_move_is_reported_unchanged_and_writes_no_trail_row(self):
        """
        Dragging a device back where it started is an ordinary gesture. The audit trigger already
        suppresses the no-op UPDATE, so counting it as applied would promise a trail row that
        deliberately does not exist -- and the page would then offer a "Same transaction" link
        into an empty result.
        """
        result = self._relocate([self._move(self.devices[0], self.cell_a)])
        self.assertEqual(result["applied"], 0, result)
        self.assertEqual(result["unchanged"], 1, result)
        self.assertIsNone(result["causation_id"],
                          "a batch that changed nothing reported a causation_id, but the trigger "
                          "wrote no rows to point it at")
        self.assertEqual(self._trail_rows([self.devices[0]]), [])

    def test_a_mixed_batch_counts_both(self):
        """One real move and one no-op: the report must not round either away."""
        result = self._relocate([
            self._move(self.devices[0], self.cell_a),   # already there
            self._move(self.devices[1], self.cell_b),   # a real move
        ])
        self.assertEqual(result["requested"], 2, result)
        self.assertEqual(result["applied"], 1, result)
        self.assertEqual(result["unchanged"], 1, result)
        self.assertEqual(len(self._trail_rows(self.devices)), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
