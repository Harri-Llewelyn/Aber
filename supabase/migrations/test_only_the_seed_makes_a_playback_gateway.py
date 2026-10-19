"""
Only the seed makes a playback gateway, and a playback maps only onto replay lanes (0187).

    python supabase/migrations/test_only_the_seed_makes_a_playback_gateway.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

What makes a gateway a playback target is `gateways.is_shadow`. `gateways_update_privileged` admits
a Shopfloor_Manager, so before 0187 one could mark a Host gateway is_shadow, and
`start_playback_job()` then accepted a map of a real device onto itself: a replay wrote recorded
readings into that device's history, and the Audit Trail showed a gateways UPDATE.

Five things are held here, for an Administrator and a Shopfloor_Manager alike:

  * the flag cannot be set (an UPDATE, an INSERT, an upsert) or cleared through the API, and
    service_role is held too;
  * an ordinary edit of a gateway, including one whose PATCH mentions the flag without changing
    it, still works;
  * the database owner is not held, because the seed creates the Playback gateway and reconciles
    its flags on every boot. 0002 replays BEFORE the migration that adds the trigger, so from the
    second boot on the trigger is in place when it runs: the seed's own statement is executed here;
  * `start_playback_job()` accepts a map only onto the lane of the device the key names, and
    `ensure_shadow_devices()` still produces exactly such a map;
  * what makes a device a lane, `devices.shadow_of`, is as closed as the flag: it cannot be set,
    changed or cleared through the API, a lane cannot be moved to another gateway, and
    `ensure_shadow_devices()` (which runs as the owner) still mints, reuses and archives lanes.

Every test rolls back. Writes to `gateways` and `devices` fire the audit-trail trigger.
"""
import json
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors as pg_errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEED = os.path.join(REPO, "supabase", "migrations", "0002_seed_data.sql")

PLAYBACK_GATEWAY = "16000000-0000-4000-8000-000000000001"

PEOPLE = {
    "Administrator": "00000000-0000-4000-8000-00000000e918",
    "Shopfloor_Manager": "00000000-0000-4000-8000-00000000e919",
}
ROLES = tuple(PEOPLE)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: the fixture as the owner, each call as a caller, a rollback."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT 1 FROM pg_trigger WHERE tgname = 'trg_gateways_playback_flag_is_seeded' "
                "AND tgrelid = 'public.gateways'::regclass AND NOT tgisinternal;"
            )
            if not cur.fetchone():
                raise unittest.SkipTest(
                    "0187_a_gateway_cannot_be_made_a_playback_target.sql has not been applied"
                )
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # Cleanups, not tearDown: they also run when the fixture below fails.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"playback-flag-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    # -- fixtures, written as the owner, which the trigger does not hold ---------------------

    def _gateway(self, deployment="host", simulated=False, shadow=False):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, "
            "is_shadow) VALUES (%s, %s, 'cell', %s, %s, %s) RETURNING sparkplug_id;",
            (gid, f"Test_Flag_GW_{gid[:8]}", deployment, simulated, shadow),
        )
        return gid, self.cur.fetchone()[0]

    def _device(self, gateway_id, shadow_of=None, name=None):
        did = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, shadow_of, status) "
            "VALUES (%s, %s, %s, %s, 'OFFLINE') RETURNING sparkplug_id;",
            (did, name or f"Test_Flag_Dev_{did[:8]}", gateway_id, shadow_of),
        )
        return did, self.cur.fetchone()[0]

    def _capture(self, gateway_id, device_ids=()):
        self.cur.execute(
            "INSERT INTO public.captures (subject_kind, gateway_id, subject_sparkplug_id, "
            "storage_path, size_bytes, message_count, manifest) "
            "VALUES ('gateway', %s, %s, %s, 1, 1, %s::jsonb) RETURNING id;",
            (gateway_id, f"gwy{uuid.uuid4().hex[:21]}", f"flag-{uuid.uuid4()}/capture.json",
             json.dumps({"device_ids": list(device_ids)})),
        )
        return self.cur.fetchone()[0]

    def _credential(self, gateway_id):
        """What start_playback_job() asks of its target: a broker credential on record."""
        self.cur.execute("SELECT public.record_gateway_credential_issued_by_service(%s);",
                         (gateway_id,))

    # -- callers ----------------------------------------------------------------------------

    def _as(self, caller):
        """Become `caller` for what follows, as PostgREST does: role, then claims."""
        if caller == "service_role":
            self.cur.execute("SET LOCAL ROLE service_role;")
            claims = '{"role": "service_role"}'
        else:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            claims = '{"sub": "%s", "role": "authenticated"}' % PEOPLE[caller]
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (claims,))

    def _call(self, caller, sql, args=()):
        """One statement as `caller`, in a savepoint, so a refusal leaves the fixture standing."""
        self.cur.execute("SAVEPOINT call;")
        try:
            self._as(caller)
            self.cur.execute(sql, args)
            return self.cur.fetchall() if self.cur.description else self.cur.rowcount
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")

    def _flag(self, gateway_id):
        self.cur.execute("SELECT is_shadow FROM public.gateways WHERE id = %s;", (gateway_id,))
        return self.cur.fetchone()[0]


class TheFlagCannotBeChangedThroughTheApi(Base):

    def test_a_host_gateway_cannot_be_made_a_playback_target(self):
        """THE BUG. Measured before 0187: this succeeded, and its credential became deliverable."""
        gateway, _ = self._gateway()
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation, "cannot be made a playback"):
                    self._call(role, "UPDATE public.gateways SET is_simulated = true, "
                                     "is_shadow = true WHERE id = %s;", (gateway,))
                self.assertFalse(self._flag(gateway))

    def test_a_simulated_gateway_needs_only_the_flag_and_is_held_too(self):
        gateway, _ = self._gateway(simulated=True)
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation, "cannot be made a playback"):
                    self._call(role, "UPDATE public.gateways SET is_shadow = true WHERE id = %s;",
                               (gateway,))
                self.assertFalse(self._flag(gateway))

    def test_the_playback_gateway_cannot_stop_being_one(self):
        """The other direction: a delivered password must not outlive the flag it was given for."""
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation, "cannot stop being"):
                    self._call(role, "UPDATE public.gateways SET is_shadow = false WHERE id = %s;",
                               (PLAYBACK_GATEWAY,))
                self.assertTrue(self._flag(PLAYBACK_GATEWAY))

    def test_a_gateway_cannot_be_created_as_a_playback_target(self):
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation, "cannot be created"):
                    self._call(role, "INSERT INTO public.gateways (name, location_scope, "
                                     "deployment, is_simulated, is_shadow) VALUES "
                                     "(%s, 'cell', 'host', true, true);",
                               (f"Test_Flag_New_{uuid.uuid4().hex[:8]}",))

    def test_an_upsert_cannot_set_it_either(self):
        """PostgREST's merge-duplicates is INSERT ... ON CONFLICT DO UPDATE, a second way in."""
        gateway, _ = self._gateway(simulated=True)
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaises(pg_errors.CheckViolation):
                    self._call(role, "INSERT INTO public.gateways (id, name, location_scope, "
                                     "deployment, is_simulated, is_shadow) "
                                     "VALUES (%s, 'Test_Flag_Upsert', 'cell', 'host', true, false) "
                                     "ON CONFLICT (id) DO UPDATE SET is_shadow = true;",
                               (gateway,))
                self.assertFalse(self._flag(gateway))

    def test_service_role_is_held_too(self):
        gateway, _ = self._gateway(simulated=True)
        with self.assertRaises(pg_errors.CheckViolation):
            self._call("service_role",
                       "UPDATE public.gateways SET is_shadow = true WHERE id = %s;", (gateway,))
        with self.assertRaises(pg_errors.CheckViolation):
            self._call("service_role",
                       "UPDATE public.gateways SET is_shadow = false WHERE id = %s;",
                       (PLAYBACK_GATEWAY,))

    def test_the_refusal_says_what_to_do(self):
        gateway, _ = self._gateway()
        with self.assertRaises(pg_errors.CheckViolation) as ctx:
            self._call("Shopfloor_Manager",
                       "UPDATE public.gateways SET is_simulated = true, is_shadow = true "
                       "WHERE id = %s;", (gateway,))
        message = str(ctx.exception)
        self.assertIn("Only the Playback gateway that Aber seeds is a playback target", message)
        self.assertIn("play it back onto the Playback gateway", message)


class OrdinaryEditsStillWork(Base):

    def test_a_playback_gateway_can_be_renamed(self):
        gateway, _ = self._gateway(simulated=True, shadow=True)
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(
                    self._call(role, "UPDATE public.gateways SET name = %s WHERE id = %s;",
                               ("Test_Flag_Renamed", gateway)), 1)

    def test_a_patch_that_mentions_the_flag_without_changing_it_passes(self):
        """PostgREST sends the whole row, so every edit mentions the column."""
        shadow, _ = self._gateway(simulated=True, shadow=True)
        ordinary, _ = self._gateway()
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(
                    self._call(role, "UPDATE public.gateways SET is_shadow = true, name = %s "
                                     "WHERE id = %s;", ("Test_Flag_Same", shadow)), 1)
                self.assertEqual(
                    self._call(role, "UPDATE public.gateways SET is_shadow = false, name = %s "
                                     "WHERE id = %s;", ("Test_Flag_Same", ordinary)), 1)

    def test_an_ordinary_gateway_is_created_and_edited_as_before(self):
        for role in ROLES:
            with self.subTest(role=role):
                rows = self._call(role, "INSERT INTO public.gateways (name, location_scope, "
                                        "deployment, is_simulated) "
                                        "VALUES (%s, 'cell', 'host', true) RETURNING is_shadow;",
                                  (f"Test_Flag_Ordinary_{uuid.uuid4().hex[:8]}",))
                self.assertEqual(rows, [(False,)])


class TheOwnerIsNotHeld(Base):
    """The seed, and every SECURITY DEFINER function, run as the owner."""

    def test_the_owner_may_set_and_clear_the_flag(self):
        gateway, _ = self._gateway(simulated=True)
        self.cur.execute("UPDATE public.gateways SET is_shadow = true WHERE id = %s;", (gateway,))
        self.assertTrue(self._flag(gateway))
        self.cur.execute("UPDATE public.gateways SET is_shadow = false WHERE id = %s;", (gateway,))
        self.assertFalse(self._flag(gateway))

    def test_the_seeds_own_statement_still_reconciles_the_playback_gateway(self):
        """
        0002 replays on every boot, before 0187, so on the second boot it meets the trigger. This
        runs the statement out of the file, against a Playback gateway that has lost its flags.
        """
        with open(SEED, encoding="utf-8") as f:
            text = f.read()
        start = text.index("INSERT INTO public.gateways (id, name, description, deployment, "
                           "is_simulated, is_shadow, location_scope)")
        statement = text[start:text.index("cell_id = NULL;", start) + len("cell_id = NULL;")]
        self.assertIn("is_shadow = true", statement)
        self.assertNotIn("%", statement)

        self.cur.execute(
            "UPDATE public.gateways SET is_shadow = false, is_simulated = false WHERE id = %s;",
            (PLAYBACK_GATEWAY,))
        self.assertFalse(self._flag(PLAYBACK_GATEWAY))
        self.cur.execute(statement)
        self.cur.execute("SELECT is_shadow, is_simulated, deployment FROM public.gateways "
                         "WHERE id = %s;", (PLAYBACK_GATEWAY,))
        self.assertEqual(self.cur.fetchone(), (True, True, "host"))

    def test_the_seed_creates_the_gateway_when_it_is_missing(self):
        """
        The INSERT arm: a stack whose Playback gateway was deleted gets it back at the boot. Since
        0193 the last one cannot be deleted, so the guard is set aside for the fixture: the arm
        serves a stack that lost it before then.
        """
        with open(SEED, encoding="utf-8") as f:
            text = f.read()
        start = text.index("INSERT INTO public.gateways (id, name, description, deployment, "
                           "is_simulated, is_shadow, location_scope)")
        statement = text[start:text.index("cell_id = NULL;", start) + len("cell_id = NULL;")]
        self.cur.execute("ALTER TABLE public.gateways DISABLE TRIGGER trg_gateways_keep_playback_history;")
        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (PLAYBACK_GATEWAY,))
        self.cur.execute(statement)
        self.assertTrue(self._flag(PLAYBACK_GATEWAY))


class ThePlaybackJobMapsOnlyOntoLanes(Base):

    def setUp(self):
        super().setUp()
        self.real_gw, _ = self._gateway()
        self.dev_a, self.wire_a = self._device(self.real_gw, name="Test_Flag_Press_A")
        self.dev_b, self.wire_b = self._device(self.real_gw, name="Test_Flag_Press_B")

        self.target, _ = self._gateway(simulated=True, shadow=True)
        self.lane_a, self.lane_wire_a = self._device(self.target, shadow_of=self.dev_a,
                                                     name="Test_Flag_Press_A (replay)")
        self.lane_b, self.lane_wire_b = self._device(self.target, shadow_of=self.dev_b,
                                                     name="Test_Flag_Press_B (replay)")
        self._credential(self.target)
        self.capture = self._capture(self.real_gw, [self.wire_a, self.wire_b])

    START = "SELECT public.start_playback_job(%s, %s, %s::jsonb);"

    def _start(self, role, mapping, target=None):
        return self._call(role, self.START, (self.capture, target or self.target,
                                             json.dumps(mapping)))

    def test_the_lane_of_each_named_device_is_accepted(self):
        mapping = {self.wire_a: self.lane_wire_a, self.wire_b: self.lane_wire_b}
        for role in ROLES:
            with self.subTest(role=role):
                self.assertIsNotNone(self._start(role, mapping)[0][0])

    def test_a_map_onto_a_real_device_is_refused(self):
        """
        The attack: a gateway somebody flagged (as a site upgraded from before 0187 can have),
        with a real device on it, and a map of that device onto itself.
        """
        flagged, _ = self._gateway(simulated=True)
        real, real_wire = self._device(flagged, name="Test_Flag_Real_Press")
        self.cur.execute("UPDATE public.gateways SET is_shadow = true WHERE id = %s;", (flagged,))
        self._credential(flagged)
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation,
                                            "Test_Flag_Real_Press.*a real device and not a replay "
                                            "lane"):
                    self._start(role, {real_wire: real_wire}, target=flagged)

    def test_a_map_onto_another_devices_lane_is_refused_and_names_both(self):
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaises(pg_errors.CheckViolation) as ctx:
                    self._start(role, {self.wire_a: self.lane_wire_b})
                message = str(ctx.exception)
                self.assertIn("Test_Flag_Press_A", message)
                self.assertIn("the replay lane of Test_Flag_Press_B", message)

    def test_one_wrong_entry_refuses_the_whole_map(self):
        with self.assertRaises(pg_errors.CheckViolation):
            self._start("Shopfloor_Manager", {self.wire_a: self.lane_wire_a,
                                              self.wire_b: self.lane_wire_a})

    def test_a_key_that_names_no_device_is_refused(self):
        unknown = "dev" + uuid.uuid4().hex[:21]
        with self.assertRaisesRegex(pg_errors.CheckViolation, "not the device the recording names"):
            self._start("Shopfloor_Manager", {unknown: self.lane_wire_a})

    def test_a_device_of_another_gateway_is_still_refused_as_before(self):
        with self.assertRaisesRegex(pg_errors.ForeignKeyViolation,
                                    "not an active device of gateway"):
            self._start("Shopfloor_Manager", {self.wire_a: self.wire_b})

    def test_an_archived_lane_is_still_refused_as_before(self):
        self.cur.execute("UPDATE public.devices SET is_archived = true WHERE id = %s;",
                         (self.lane_a,))
        with self.assertRaisesRegex(pg_errors.ForeignKeyViolation,
                                    "not an active device of gateway"):
            self._start("Shopfloor_Manager", {self.wire_a: self.lane_wire_a})

    def test_an_empty_map_is_unchanged(self):
        """A capture with no device traffic plays only the edge node's own messages."""
        self.assertIsNotNone(self._start("Shopfloor_Manager", {})[0][0])

    def test_the_caller_check_is_still_first(self):
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._call("service_role", self.START,
                       (self.capture, self.target, json.dumps({self.wire_a: self.lane_wire_b})))

    def test_ensure_shadow_devices_makes_a_map_the_job_accepts(self):
        """The dashboard's path: prepare the lanes, then start with what came back."""
        capture = self._capture(self._gateway()[0], [self.wire_a, self.wire_b])
        for role in ROLES:
            with self.subTest(role=role):
                self.cur.execute("SAVEPOINT prepare;")
                try:
                    self._as(role)
                    self.cur.execute("SELECT public.ensure_shadow_devices(%s);", (capture,))
                    mapping = self.cur.fetchone()[0]
                    self.assertEqual(set(mapping), {self.wire_a, self.wire_b})
                    self.cur.execute("SELECT gateway_id FROM public.devices "
                                     "WHERE sparkplug_id = %s;", (mapping[self.wire_a],))
                    gateway = self.cur.fetchone()[0]
                    self.cur.execute("RESET ROLE;")
                    self._credential(gateway)
                    self._as(role)
                    self.cur.execute(self.START, (capture, gateway, json.dumps(mapping)))
                    self.assertIsNotNone(self.cur.fetchone()[0])
                finally:
                    self.cur.execute("ROLLBACK TO SAVEPOINT prepare;")


class ALaneIsMadeByEnsureShadowDevicesAlone(Base):
    """
    `devices.shadow_of` is what makes a device a lane, and the lane check above trusts it. Before
    this guard a manager could move a real device onto the Playback gateway and set it in the same
    UPDATE; measured, it returned UPDATE 1.
    """

    def setUp(self):
        super().setUp()
        self.real_gw, _ = self._gateway()
        self.other_gw, _ = self._gateway()
        self.dev_a, self.wire_a = self._device(self.real_gw, name="Test_Lane_Press_A")
        self.dev_b, self.wire_b = self._device(self.real_gw, name="Test_Lane_Press_B")
        self.target, _ = self._gateway(simulated=True, shadow=True)
        self.lane, self.lane_wire = self._device(self.target, shadow_of=self.dev_a,
                                                 name="Test_Lane_Press_A (replay)")

    def _act(self, role, sql, args=(), then=None, then_args=()):
        """`sql` as `role`, then `then` as the owner, then back out: (rowcount, what `then` read)."""
        self.cur.execute("SAVEPOINT act;")
        try:
            self._as(role)
            self.cur.execute(sql, args)
            rowcount = self.cur.rowcount
            self.cur.execute("RESET ROLE;")
            rows = None
            if then:
                self.cur.execute(then, then_args)
                rows = self.cur.fetchall()
            return rowcount, rows
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT act;")

    def _lane_of(self, device_id):
        self.cur.execute("SELECT shadow_of, gateway_id FROM public.devices WHERE id = %s;",
                         (device_id,))
        return self.cur.fetchone()

    # -- refused ---------------------------------------------------------------------------

    def test_a_real_device_cannot_be_moved_onto_the_playback_gateway_as_a_lane(self):
        """THE MEASURED CASE. It returned UPDATE 1 before this guard."""
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation,
                                            "Test_Lane_Press_B cannot be made a replay lane"):
                    self._call(role, "UPDATE public.devices SET gateway_id = %s, shadow_of = %s "
                                     "WHERE id = %s;", (PLAYBACK_GATEWAY, self.dev_a, self.dev_b))
                self.assertEqual(self._lane_of(self.dev_b), (None, self.real_gw))

    def test_shadow_of_alone_is_refused_on_a_device_that_stays_where_it_is(self):
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation, "cannot be made a replay lane"):
                    self._call(role, "UPDATE public.devices SET shadow_of = %s WHERE id = %s;",
                               (self.dev_a, self.dev_b))

    def test_a_device_cannot_be_created_as_a_lane(self):
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation,
                                            "cannot be created as a replay lane"):
                    self._call(role, "INSERT INTO public.devices (name, gateway_id, shadow_of) "
                                     "VALUES (%s, %s, %s);",
                               (f"Test_Lane_New_{uuid.uuid4().hex[:8]}", self.target, self.dev_a))

    def test_an_upsert_cannot_set_it_either(self):
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaises(pg_errors.CheckViolation):
                    self._call(role, "INSERT INTO public.devices (id, name, gateway_id) "
                                     "VALUES (%s, 'Test_Lane_Upsert', %s) "
                                     "ON CONFLICT (id) DO UPDATE SET shadow_of = %s;",
                               (self.dev_b, self.real_gw, self.dev_a))

    def test_a_lane_cannot_be_pointed_at_another_device(self):
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation,
                                            "cannot be made the lane of another device"):
                    self._call(role, "UPDATE public.devices SET shadow_of = %s WHERE id = %s;",
                               (self.dev_b, self.lane))
                self.assertEqual(self._lane_of(self.lane)[0], self.dev_a)

    def test_a_lane_cannot_stop_being_one(self):
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation, "cannot stop being a replay lane"):
                    self._call(role, "UPDATE public.devices SET shadow_of = NULL WHERE id = %s;",
                               (self.lane,))
                self.assertEqual(self._lane_of(self.lane)[0], self.dev_a)

    def test_a_lane_cannot_be_moved_to_another_gateway_or_unassigned(self):
        for role in ROLES:
            for destination in (self.other_gw, None):
                with self.subTest(role=role, destination=destination):
                    with self.assertRaisesRegex(pg_errors.CheckViolation,
                                                "cannot be moved to another gateway"):
                        self._call(role, "UPDATE public.devices SET gateway_id = %s WHERE id = %s;",
                                   (destination, self.lane))
                    self.assertEqual(self._lane_of(self.lane)[1], self.target)

    def test_service_role_is_held_too(self):
        with self.assertRaises(pg_errors.CheckViolation):
            self._call("service_role", "UPDATE public.devices SET gateway_id = %s, shadow_of = %s "
                                       "WHERE id = %s;", (PLAYBACK_GATEWAY, self.dev_a, self.dev_b))
        with self.assertRaises(pg_errors.CheckViolation):
            self._call("service_role", "UPDATE public.devices SET shadow_of = NULL WHERE id = %s;",
                       (self.lane,))

    def test_the_old_gate_still_refuses_a_device_arriving_without_provenance(self):
        """0083's half is unchanged: the two read as one rule, and neither leaves the other's case."""
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation, "playback gateway"):
                    self._call(role, "UPDATE public.devices SET gateway_id = %s WHERE id = %s;",
                               (self.target, self.dev_b))

    def test_the_refusal_says_what_to_do(self):
        with self.assertRaises(pg_errors.CheckViolation) as ctx:
            self._call("Shopfloor_Manager", "UPDATE public.devices SET shadow_of = %s "
                                            "WHERE id = %s;", (self.dev_a, self.dev_b))
        self.assertIn("Prepare replay lanes", str(ctx.exception))

    # -- still allowed ---------------------------------------------------------------------

    def test_an_ordinary_edit_of_a_lane_still_works(self):
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(
                    self._call(role, "UPDATE public.devices SET name = %s, description = %s "
                                     "WHERE id = %s;", ("Test_Lane_Renamed", "edited", self.lane)), 1)

    def test_a_whole_row_patch_that_changes_neither_column_passes(self):
        """The Edit Details form sends gateway_id with every save, and PostgREST sends the row."""
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(
                    self._call(role, "UPDATE public.devices SET name = %s, gateway_id = %s, "
                                     "shadow_of = %s WHERE id = %s;",
                               ("Test_Lane_Same", self.target, self.dev_a, self.lane)), 1)
                self.assertEqual(
                    self._call(role, "UPDATE public.devices SET name = %s, gateway_id = %s, "
                                     "shadow_of = NULL WHERE id = %s;",
                               ("Test_Lane_Same", self.real_gw, self.dev_b)), 1)

    def test_an_ordinary_device_still_moves_between_ordinary_gateways(self):
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(
                    self._call(role, "UPDATE public.devices SET gateway_id = %s WHERE id = %s;",
                               (self.other_gw, self.dev_b)), 1)
                self.assertEqual(
                    self._call(role, "UPDATE public.devices SET gateway_id = NULL WHERE id = %s;",
                               (self.dev_b,)), 1)
                self.assertEqual(
                    self._call(role, "INSERT INTO public.devices (name, gateway_id) VALUES (%s, %s);",
                               (f"Test_Lane_Plain_{uuid.uuid4().hex[:8]}", self.real_gw)), 1)

    def test_a_row_with_no_provenance_can_still_leave_the_playback_gateway(self):
        """0083's recovery path: a row with no shadow_of is not a lane, and can be moved off."""
        orphan, _ = self._device(self.target, shadow_of=self.dev_b, name="Test_Lane_Orphan")
        self.cur.execute("UPDATE public.devices SET shadow_of = NULL WHERE id = %s;", (orphan,))
        for role in ROLES:
            with self.subTest(role=role):
                self.assertEqual(
                    self._call(role, "UPDATE public.devices SET gateway_id = %s WHERE id = %s;",
                               (self.real_gw, orphan)), 1)

    def test_archiving_a_lane_works(self):
        for role in ROLES:
            with self.subTest(role=role):
                count, rows = self._act(
                    role, "UPDATE public.devices SET is_archived = true, archived_at = now() "
                          "WHERE id = %s;", (self.lane,),
                    "SELECT is_archived, shadow_of, gateway_id FROM public.devices WHERE id = %s;",
                    (self.lane,))
                self.assertEqual((count, rows[0][0]), (1, True))
                self.assertEqual(rows[0][1:], (self.dev_a, self.target))

    def test_archiving_and_deleting_the_original_carry_its_lane_with_it(self):
        for role in ROLES:
            with self.subTest(role=role):
                count, rows = self._act(
                    role, "UPDATE public.devices SET is_archived = true, archived_at = now() "
                          "WHERE id = %s;", (self.dev_a,),
                    "SELECT is_archived FROM public.devices WHERE id = %s;", (self.lane,))
                self.assertEqual((count, rows), (1, [(True,)]))
                count, rows = self._act(
                    role, "DELETE FROM public.devices WHERE id = %s;", (self.dev_a,),
                    "SELECT count(*) FROM public.devices WHERE id = %s;", (self.lane,))
                self.assertEqual((count, rows), (1, [(0,)]))

    def test_the_foreign_key_still_clears_shadow_of_when_an_original_is_deleted(self):
        """
        devices_shadow_of_fkey is ON DELETE SET NULL, and the action runs as the table's owner, so
        the guard lets it through. The BEFORE DELETE trigger that removes lanes first is off here
        so the action itself is what runs.
        """
        self.cur.execute("ALTER TABLE public.devices DISABLE TRIGGER trg_devices_shadow_follows_delete;")
        for role in ROLES:
            with self.subTest(role=role):
                count, rows = self._act(
                    role, "DELETE FROM public.devices WHERE id = %s;", (self.dev_a,),
                    "SELECT shadow_of FROM public.devices WHERE id = %s;", (self.lane,))
                self.assertEqual((count, rows), (1, [(None,)]))

    def test_deleting_the_playback_gateway_still_unassigns_its_lanes(self):
        """devices_gateway_id_fkey is ON DELETE SET NULL; the action is the owner's, so it passes."""
        for role in ROLES:
            with self.subTest(role=role):
                count, rows = self._act(
                    role, "DELETE FROM public.gateways WHERE id = %s;", (self.target,),
                    "SELECT gateway_id, shadow_of FROM public.devices WHERE id = %s;", (self.lane,))
                self.assertEqual((count, rows), (1, [(None, self.dev_a)]))

    def test_ensure_shadow_devices_mints_and_reuses_lanes(self):
        capture = self._capture(self.other_gw, [self.wire_a, self.wire_b])
        for role in ROLES:
            with self.subTest(role=role):
                self.cur.execute("SAVEPOINT mint;")
                try:
                    self._as(role)
                    self.cur.execute("SELECT public.ensure_shadow_devices(%s);", (capture,))
                    first = self.cur.fetchone()[0]
                    self.cur.execute("SELECT public.ensure_shadow_devices(%s);", (capture,))
                    second = self.cur.fetchone()[0]
                    self.cur.execute("RESET ROLE;")
                    self.assertEqual(first, second)
                    self.assertEqual(set(first), {self.wire_a, self.wire_b})
                    self.cur.execute(
                        "SELECT count(*) FROM public.devices WHERE shadow_of = %s "
                        "AND sparkplug_id = %s;", (self.dev_b, first[self.wire_b]))
                    self.assertEqual(self.cur.fetchone()[0], 1)
                finally:
                    self.cur.execute("ROLLBACK TO SAVEPOINT mint;")

    def test_the_trigger_is_stated_once_through_replay_trigger(self):
        self.cur.execute("SELECT public.live_trigger_statement('public.devices', "
                         "'trg_devices_replay_lane_stays_as_minted');")
        self.assertRegex(
            self.cur.fetchone()[0],
            r"^CREATE TRIGGER trg_devices_replay_lane_stays_as_minted BEFORE INSERT OR UPDATE OF "
            r"gateway_id, shadow_of ON public\.devices FOR EACH ROW EXECUTE FUNCTION "
            r"public\.refuse_hand_making_a_replay_lane\(\);$")
        self.cur.execute("SELECT has_function_privilege(%s, "
                         "'public.refuse_hand_making_a_replay_lane()', 'EXECUTE');", ("authenticated",))
        self.assertFalse(self.cur.fetchone()[0])


class TheRefusalsNoLongerPointAtAnotherGateway(Base):

    def _only_the_playback_gateway_is_a_target(self):
        self.cur.execute("UPDATE public.gateways SET is_shadow = false "
                         "WHERE is_shadow AND id <> %s;", (PLAYBACK_GATEWAY,))

    def test_archiving_the_only_playback_gateway_is_still_refused(self):
        self._only_the_playback_gateway_is_a_target()
        for role in ROLES:
            with self.subTest(role=role):
                with self.assertRaises(pg_errors.RestrictViolation) as ctx:
                    self._call(role, "UPDATE public.gateways SET is_archived = true "
                                     "WHERE id = %s;", (PLAYBACK_GATEWAY,))
                message = str(ctx.exception)
                self.assertIn("is the Playback gateway", message)
                self.assertIn("No other gateway can be made a playback target", message)
                self.assertNotIn("Mark another", message)

    def test_a_stack_with_no_playback_gateway_is_told_to_restore_it(self):
        self.cur.execute("UPDATE public.gateways SET is_shadow = false WHERE is_shadow;")
        capture = self._capture(self._gateway()[0], [])
        with self.assertRaises(psycopg2.Error) as ctx:
            self._call("Shopfloor_Manager", "SELECT public.ensure_shadow_devices(%s);", (capture,))
        message = str(ctx.exception)
        self.assertIn("restore it from Archived Entities", message)
        self.assertNotIn("another gateway", message)


class TheShape(Base):

    def test_the_trigger_function_is_not_callable_by_the_api_roles(self):
        for role in ("anon", "authenticated"):
            with self.subTest(role=role):
                self.cur.execute(
                    "SELECT has_function_privilege(%s, "
                    "'public.refuse_hand_marking_a_playback_gateway()', 'EXECUTE');", (role,))
                self.assertFalse(self.cur.fetchone()[0])

    def test_start_playback_job_keeps_its_declared_shape(self):
        self.cur.execute(
            "SELECT l.lanname, p.prosecdef, pg_get_function_result(p.oid), p.proconfig, "
            "       has_function_privilege('anon', p.oid, 'EXECUTE'), "
            "       has_function_privilege('authenticated', p.oid, 'EXECUTE'), "
            "       has_function_privilege('service_role', p.oid, 'EXECUTE') "
            "  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang "
            " WHERE p.oid = 'public.start_playback_job(uuid, uuid, jsonb, numeric)'::regprocedure;")
        lang, definer, result, config, anon, authenticated, service = self.cur.fetchone()
        self.assertEqual((lang, definer, result), ("plpgsql", True, "uuid"))
        self.assertIn("search_path=public", config)
        self.assertEqual((anon, authenticated, service), (False, True, True))

    def test_the_trigger_is_stated_once_through_replay_trigger(self):
        """Check 59 holds the text; this holds that the live trigger is the statement's own."""
        self.cur.execute(
            "SELECT public.live_trigger_statement('public.gateways', "
            "'trg_gateways_playback_flag_is_seeded');")
        live = self.cur.fetchone()[0]
        self.assertRegex(
            live, r"^CREATE TRIGGER trg_gateways_playback_flag_is_seeded BEFORE INSERT OR UPDATE "
                  r"OF is_shadow ON public\.gateways FOR EACH ROW EXECUTE FUNCTION "
                  r"public\.refuse_hand_marking_a_playback_gateway\(\);$")


if __name__ == "__main__":
    unittest.main()
