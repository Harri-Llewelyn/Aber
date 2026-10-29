"""
What the capture and playback gates do when called, rather than what their source says.

    python supabase/migrations/test_capture_playback_behaviour.py

Requires the Supabase database (54322 by default) and the schema the chain declares, with the
seeded Playback gateway (0002).

  * ensure_shadow_devices() refuses a caller who may not manage captures, a capture that does not
    exist and a capture of a replay lane; it mints each lane on the Playback gateway with the
    origin's policy and schemas, and a later capture of the same device reuses the lane.
  * A device recorded under its own id or its UUID, in any letter case, gets its lane, and the job
    takes that map (0201). An own id names the device behind the capture's own gateway, the
    capture's own device first, or a device bound to none, never one behind another gateway alone.
  * start_playback_job() refuses, by SQLSTATE, a missing capture or gateway, a gateway that is not
    simulated, one that is simulated but not the Playback gateway, an archived one, one holding no
    broker credential, and a second playback onto a target already busy. It clamps the speed.
  * capped_capture_manifest() keeps the first 50 metric names with the true count, and the
    recorder's finalise stores what it returns.
  * ingest_reconcile_capture_jobs() and playback_reconcile_jobs() fail only what is in flight,
    leave finished jobs and stored captures alone, sweep nothing the second time, and answer only
    their own worker. The capture sweep spares a job that went quiet less than 45 s ago.
  * Row-level security and grants on captures, capture_jobs, playback_jobs,
    playback_worker_status and capture_uploads, for each role, both machine principals and anon,
    and which of them the Realtime publication carries.

The refusals are matched on SQLSTATE and the subject they name, not on their wording, which the
Audit Trail work may reword. Every test rolls back.
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

PEOPLE = {
    "Administrator": "00000000-0000-4000-8000-00000000e928",
    "Shopfloor_Manager": "00000000-0000-4000-8000-00000000e929",
    "Auditor": "00000000-0000-4000-8000-00000000e92a",
    "Operator": "00000000-0000-4000-8000-00000000e92b",
}
INGESTION = "b0000000-0000-4000-8000-000000000002"
PLAYBACK = "b0000000-0000-4000-8000-000000000003"
PLAYBACK_GATEWAY = "16000000-0000-4000-8000-000000000001"

MANAGERS = ("Administrator", "Shopfloor_Manager")
READERS = MANAGERS + ("Auditor",)
NOT_MANAGERS = ("Auditor", "Operator", "ingestion", "playback")

# The five tables the capture and playback feature keeps.
TABLES = ("captures", "capture_jobs", "playback_jobs", "playback_worker_status", "capture_uploads")


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, each call as a caller, then a rollback."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT is_shadow FROM public.gateways WHERE id = %s;", (PLAYBACK_GATEWAY,))
            row = cur.fetchone()
        finally:
            conn.rollback()
            conn.close()
        if not row or not row[0]:
            raise unittest.SkipTest("the seeded Playback gateway is missing (0002_seed_data.sql)")

    def setUp(self):
        self.conn = get_connection()
        # Cleanups, not tearDown: they also run when a fixture below fails.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"behaviour-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )
        # Nothing else in flight: one capture per stack and one playback per target.
        self.cur.execute("UPDATE public.capture_jobs SET status = 'FAILED', finished_at = now() "
                         "WHERE status IN ('PENDING', 'RECORDING');")
        self.cur.execute("UPDATE public.playback_jobs SET status = 'FAILED', finished_at = now() "
                         "WHERE status IN ('PENDING', 'RUNNING');")
        # No worker report, so no credential reads as re-issued since the worker picked it up.
        self.cur.execute("DELETE FROM public.playback_worker_status;")

    # -- fixtures, as the owner -----------------------------------------------------------------

    def _gateway(self, simulated=False, shadow=False, credential=False, name=None):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, "
            "is_shadow) VALUES (%s, %s, 'cell', %s, %s, %s) RETURNING sparkplug_id;",
            (gid, name or f"Test_Behaviour_GW_{gid[:8]}",
             "host" if simulated else "remote", simulated, shadow),
        )
        wire = self.cur.fetchone()[0]
        if credential:
            self.cur.execute("SELECT public.record_gateway_credential_issued_by_service(%s);", (gid,))
        return gid, wire

    def _device(self, gateway_id, name=None, policy="audit", shadow_of=None):
        did = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, status, conformance_policy, shadow_of) "
            "VALUES (%s, %s, %s, 'OFFLINE', %s, %s) RETURNING sparkplug_id;",
            (did, name or f"Test_Behaviour_Dev_{did[:8]}", gateway_id, policy, shadow_of),
        )
        return did, self.cur.fetchone()[0]

    def _capture(self, device_ids=()):
        """A stored capture naming `device_ids`, of a gateway of its own: one capture per subject."""
        gateway_id, wire = self._gateway()
        self.cur.execute(
            "INSERT INTO public.captures (subject_kind, gateway_id, subject_sparkplug_id, "
            "storage_path, size_bytes, message_count, manifest) "
            "VALUES ('gateway', %s, %s, %s, 1, 1, %s::jsonb) RETURNING id;",
            (gateway_id, wire, f"{wire}/{uuid.uuid4()}.json",
             json.dumps({"device_ids": list(device_ids)})),
        )
        return str(self.cur.fetchone()[0])

    def _capture_job(self, gateway_id, wire, status, error=None):
        jid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.capture_jobs (id, subject_kind, gateway_id, sparkplug_group, "
            "edge_node_id, subject_sparkplug_id, storage_path, status, error, created_at, started_at, "
            "finished_at) VALUES (%s, 'gateway', %s, 'Aber', %s, %s, %s, %s, %s, "
            "now() - interval '2 minutes', "
            "CASE WHEN %s = 'PENDING' THEN NULL ELSE now() - interval '1 minute' END, "
            "CASE WHEN %s IN ('PENDING', 'RECORDING') THEN NULL ELSE now() - interval '30 seconds' END);",
            (jid, gateway_id, wire, wire, f"{wire}/{jid}.json", status, error, status, status),
        )
        return jid

    def _playback_job(self, target, wire, status, sent=0, total=0, error=None):
        jid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.playback_jobs (id, capture_storage_path, target_gateway_id, "
            "target_edge_node_id, sparkplug_group, status, messages_sent, messages_total, error, "
            "started_at, finished_at) VALUES (%s, 'behaviour/capture.json', %s, %s, 'Aber', %s, %s, "
            "%s, %s, CASE WHEN %s = 'PENDING' THEN NULL ELSE now() - interval '1 minute' END, "
            "CASE WHEN %s IN ('PENDING', 'RUNNING') THEN NULL ELSE now() - interval '30 seconds' END);",
            (jid, target, wire, status, sent, total, error, status, status),
        )
        return jid

    def _one(self, sql, args=()):
        self.cur.execute(sql, args)
        return self.cur.fetchone()

    # -- callers --------------------------------------------------------------------------------

    def _as(self, caller):
        """Become `caller` for what follows, as PostgREST does: role, then claims."""
        if caller == "anon":
            self.cur.execute("SET LOCAL ROLE anon;")
            claims = '{"role": "anon"}'
        elif caller == "service_role":
            self.cur.execute("SET LOCAL ROLE service_role;")
            claims = '{"role": "service_role"}'
        else:
            sub = {"ingestion": INGESTION, "playback": PLAYBACK}.get(caller) or PEOPLE[caller]
            self.cur.execute("SET LOCAL ROLE authenticated;")
            claims = '{"sub": "%s", "role": "authenticated"}' % sub
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (claims,))

    def _call(self, caller, sql, args=(), keep=False):
        """
        One statement as `caller`, in a savepoint. Rolled back unless `keep`, so each caller meets
        the same fixture; a refusal always leaves the fixture standing.
        """
        self.cur.execute("SAVEPOINT call;")
        try:
            self._as(caller)
            self.cur.execute(sql, args)
            result = self.cur.fetchall() if self.cur.description else self.cur.rowcount
        except Exception:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")
            raise
        if keep:
            self.cur.execute("RESET ROLE;")
            self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
            self.cur.execute("RELEASE SAVEPOINT call;")
        else:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")
        return result


# =================================================================================================
# ensure_shadow_devices()
# =================================================================================================
class EnsureShadowDevices(Base):

    ENSURE = "SELECT public.ensure_shadow_devices(%s);"

    def setUp(self):
        super().setUp()
        self.source_gw, self.source_wire = self._gateway()
        self.device, self.device_wire = self._device(self.source_gw, policy="enforce")

    def _ensure(self, capture, caller="Shopfloor_Manager", keep=True):
        return self._call(caller, self.ENSURE, (capture,), keep=keep)[0][0]

    def test_only_a_manager_may_make_lanes(self):
        capture = self._capture([self.device_wire])
        for caller in NOT_MANAGERS + ("service_role",):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._call(caller, self.ENSURE, (capture,))
        self.assertEqual(self._one("SELECT count(*) FROM public.devices WHERE shadow_of = %s;",
                                   (self.device,))[0], 0, "a refused call left a lane behind")

    def test_anon_may_not_call_it(self):
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._call("anon", self.ENSURE, (str(uuid.uuid4()),))

    def test_a_capture_that_does_not_exist_is_refused(self):
        missing = str(uuid.uuid4())
        with self.assertRaises(pg_errors.ForeignKeyViolation) as ctx:
            self._ensure(missing)
        self.assertIn(missing, str(ctx.exception))

    def test_a_capture_of_a_replay_lane_is_refused(self):
        """A replay of a replay is played onto the lane itself, never shadowed again."""
        lane, lane_wire = self._device(PLAYBACK_GATEWAY, name="Behaviour lane", shadow_of=self.device)
        capture = self._capture([lane_wire])
        with self.assertRaises(pg_errors.CheckViolation) as ctx:
            self._ensure(capture)
        self.assertIn("Behaviour lane", str(ctx.exception))
        self.assertEqual(self._one("SELECT count(*) FROM public.devices WHERE shadow_of = %s;",
                                   (lane,))[0], 0)

    def test_one_unknown_device_refuses_the_whole_capture(self):
        """No lane is minted for the known device either: the call is one statement."""
        capture = self._capture([self.device_wire, "dev" + "e" * 21])
        with self.assertRaises(pg_errors.ForeignKeyViolation):
            self._ensure(capture)
        self.assertEqual(self._one("SELECT count(*) FROM public.devices WHERE shadow_of = %s;",
                                   (self.device,))[0], 0)

    def test_a_lane_is_minted_on_the_playback_gateway_with_the_origins_contract(self):
        self.cur.execute("INSERT INTO public.schemas (schema_name, schema_definition) "
                         "VALUES (%s, '{}'::jsonb) RETURNING id;", (f"Behaviour_{uuid.uuid4().hex[:8]}",))
        schema = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.device_submodels (device_id, schema_id, submodel_key) "
                         "VALUES (%s, %s, 'Spindle');", (self.device, schema))
        long_name = "Behaviour_" + "x" * 110
        self.cur.execute("UPDATE public.devices SET name = %s WHERE id = %s;", (long_name, self.device))

        mapping = self._ensure(self._capture([self.device_wire]))
        self.assertEqual(set(mapping), {self.device_wire})
        lane = self._one(
            "SELECT id, name, gateway_id, shadow_of, status, conformance_policy "
            "FROM public.devices WHERE sparkplug_id = %s;", (mapping[self.device_wire],))
        self.assertEqual(lane[1], long_name[:96] + " (replay)")
        self.assertEqual(str(lane[2]), PLAYBACK_GATEWAY)
        self.assertEqual(str(lane[3]), self.device)
        self.assertEqual(lane[4], "OFFLINE")
        self.assertEqual(lane[5], "enforce", "the lane is not judged as its origin is")
        self.assertEqual(
            self._one("SELECT schema_id, submodel_key FROM public.device_submodels "
                      "WHERE device_id = %s;", (lane[0],)),
            (schema, "Spindle"), "the lane did not copy the origin's schemas")

    def test_a_later_capture_of_the_same_device_reuses_its_lane(self):
        first = self._ensure(self._capture([self.device_wire]))
        second = self._ensure(self._capture([self.device_wire]))
        self.assertEqual(first, second)
        self.assertEqual(self._one("SELECT count(*) FROM public.devices WHERE shadow_of = %s;",
                                   (self.device,))[0], 1)

    def test_lanes_go_to_the_oldest_playback_gateway(self):
        """A second shadow gateway, made later, does not take the lanes from the seeded one."""
        self._gateway(simulated=True, shadow=True)
        mapping = self._ensure(self._capture([self.device_wire]))
        self.assertEqual(
            str(self._one("SELECT gateway_id FROM public.devices WHERE sparkplug_id = %s;",
                          (mapping[self.device_wire],))[0]), PLAYBACK_GATEWAY)


# =================================================================================================
# A recorded device id, resolved as ingestion resolves the wire id (0201)
# =================================================================================================
class ARecordedIdIsResolvedAsIngestionResolvesIt(Base):
    """
    A capture keeps each device under the id on the wire, which for a device admitted from
    Quarantine is its own (reported_identity) and for one addressed by its Instance_UUID is its UUID.
    An own id is unique only behind one edge node (Sparkplug 3.0.0
    tck-id-topic-structure-namespace-unique-device-id,
    tck-id-topic-structure-namespace-duplicate-device-id-across-edge-node).
    """

    ENSURE = "SELECT public.ensure_shadow_devices(%s);"
    START = "SELECT public.start_playback_job(%s, %s, %s::jsonb, 1.0);"

    def setUp(self):
        super().setUp()
        self.own = f"Press_{uuid.uuid4().hex[:8]}"
        self.gw, _ = self._gateway()
        self.device, self.device_wire = self._device(self.gw, name="Behaviour own id")
        self.by_uuid, _ = self._device(self.gw, name="Behaviour by uuid")
        # The same own id behind another edge node.
        self.other_gw, _ = self._gateway()
        self.twin, _ = self._device(self.other_gw, name="Behaviour twin")
        for device in (self.device, self.twin):
            self.cur.execute("UPDATE public.devices SET reported_identity = %s, "
                             "identity_source = 'reported_identity' WHERE id = %s;",
                             (self.own, device))
        self.cur.execute("UPDATE public.devices SET identity_source = 'instance_uuid' "
                         "WHERE id = %s;", (self.by_uuid,))

    def _capture_of(self, gateway_id, device_ids, device_id=None):
        """A stored capture of a gateway, or of `device_id` recorded through `gateway_id`."""
        self.cur.execute(
            "INSERT INTO public.captures (subject_kind, gateway_id, device_id, subject_sparkplug_id, "
            "storage_path, size_bytes, message_count, manifest) "
            "VALUES (%s, %s, %s, 'behaviour', %s, 1, 1, %s::jsonb) RETURNING id;",
            ("device" if device_id else "gateway", gateway_id, device_id,
             f"behaviour/{uuid.uuid4()}.json", json.dumps({"device_ids": list(device_ids)})),
        )
        return str(self.cur.fetchone()[0])

    def _lanes(self, capture):
        """The map ensure_shadow_devices() answers, as {recorded id: the device its lane stands for}."""
        mapping = self._call("Shopfloor_Manager", self.ENSURE, (capture,), keep=True)[0][0]
        return mapping, {
            key: str(self._one("SELECT shadow_of FROM public.devices WHERE sparkplug_id = %s;",
                               (lane,))[0])
            for key, lane in mapping.items()}

    def test_a_device_recorded_under_its_own_id_gets_its_lane(self):
        _, stands_for = self._lanes(self._capture_of(self.gw, [self.own]))
        self.assertEqual(stands_for, {self.own: self.device})

    def test_a_device_recorded_under_its_uuid_gets_its_lane_in_any_letter_case(self):
        for recorded in (self.by_uuid, self.by_uuid.upper()):
            with self.subTest(recorded=recorded):
                self.cur.execute("SAVEPOINT letter_case;")
                try:
                    _, stands_for = self._lanes(self._capture_of(self.gw, [recorded]))
                    self.assertEqual(stands_for, {recorded: self.by_uuid})
                finally:
                    self.cur.execute("ROLLBACK TO SAVEPOINT letter_case;")

    def test_every_id_of_one_device_shares_its_lane(self):
        mapping, stands_for = self._lanes(
            self._capture_of(self.gw, [self.device_wire, self.own, self.device.upper()]))
        self.assertEqual(set(stands_for.values()), {self.device})
        self.assertEqual(len(set(mapping.values())), 1)

    def test_an_own_id_names_the_device_behind_the_captures_gateway(self):
        _, here = self._lanes(self._capture_of(self.gw, [self.own]))
        _, there = self._lanes(self._capture_of(self.other_gw, [self.own]))
        self.assertEqual((here, there), ({self.own: self.device}, {self.own: self.twin}))

    def test_a_device_capture_names_its_own_device_first(self):
        """Recorded through the twin's gateway, as after the device moved: the subject still wins."""
        _, stands_for = self._lanes(self._capture_of(self.other_gw, [self.own], device_id=self.device))
        self.assertEqual(stands_for, {self.own: self.device})

    def test_an_own_id_behind_another_gateway_alone_is_not_known(self):
        stranger, _ = self._gateway()
        with self.assertRaises(pg_errors.ForeignKeyViolation) as ctx:
            self._lanes(self._capture_of(stranger, [self.own]))
        self.assertIn(self.own, str(ctx.exception))

    def test_a_device_bound_to_no_gateway_is_found_by_its_own_id(self):
        loose = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.devices (id, name, status, reported_identity) "
                         "VALUES (%s, 'Behaviour unbound', 'OFFLINE', 'Loose_01');", (loose,))
        _, stands_for = self._lanes(self._capture_of(self.gw, ["Loose_01"]))
        self.assertEqual(stands_for, {"Loose_01": loose})

    def test_an_id_shaped_like_a_uuid_that_names_nothing_is_unknown_not_an_error(self):
        for recorded in (str(uuid.uuid4()).upper(), "00000000-0000-4000-8000-00000000000g"):
            with self.subTest(recorded=recorded):
                self.cur.execute("SAVEPOINT shape;")
                try:
                    with self.assertRaises(pg_errors.ForeignKeyViolation):
                        self._lanes(self._capture_of(self.gw, [recorded]))
                finally:
                    self.cur.execute("ROLLBACK TO SAVEPOINT shape;")

    def test_the_job_takes_the_map_and_checks_each_lane_against_the_device_it_resolves(self):
        capture = self._capture_of(self.gw, [self.own, self.by_uuid.upper()])
        mapping, _ = self._lanes(capture)
        self.cur.execute("SELECT public.record_gateway_credential_issued_by_service(%s);",
                         (PLAYBACK_GATEWAY,))
        for role in MANAGERS:
            with self.subTest(role=role):
                self.assertIsNotNone(
                    self._call(role, self.START, (capture, PLAYBACK_GATEWAY, json.dumps(mapping)))[0][0])
        swapped = {self.own: mapping[self.by_uuid.upper()],
                   self.by_uuid.upper(): mapping[self.own]}
        with self.assertRaisesRegex(pg_errors.CheckViolation, "not the device the recording names"):
            self._call("Shopfloor_Manager", self.START,
                       (capture, PLAYBACK_GATEWAY, json.dumps(swapped)))

    def test_only_the_gates_may_call_the_resolver(self):
        for role in ("anon", "authenticated", "service_role"):
            with self.subTest(role=role):
                self.assertFalse(self._one(
                    "SELECT has_function_privilege(%s, "
                    "'public.captured_device_id(uuid, uuid, text)', 'EXECUTE');", (role,))[0])


# =================================================================================================
# start_playback_job()
# =================================================================================================
class StartPlaybackJob(Base):

    START = "SELECT public.start_playback_job(%s, %s, '{}'::jsonb, %s);"

    def setUp(self):
        super().setUp()
        self.capture = self._capture()
        self.target, self.target_wire = self._gateway(simulated=True, shadow=True, credential=True)

    def _start(self, target=None, capture=None, speed=1.0, caller="Shopfloor_Manager", keep=False):
        return self._call(caller, self.START, (capture or self.capture, target or self.target, speed),
                          keep=keep)[0][0]

    def _jobs_on(self, target):
        return self._one("SELECT count(*) FROM public.playback_jobs WHERE target_gateway_id = %s;",
                         (target,))[0]

    def test_a_ready_target_is_accepted_and_queued_for_each_manager(self):
        for role in MANAGERS:
            with self.subTest(role=role):
                job = self._start(caller=role, keep=True)
                row = self._one(
                    "SELECT status, target_edge_node_id, capture_storage_path, requested_by "
                    "FROM public.playback_jobs WHERE id = %s;", (job,))
                self.assertEqual(row[:2], ("PENDING", self.target_wire))
                self.assertEqual(row[2], self._one(
                    "SELECT storage_path FROM public.captures WHERE id = %s;", (self.capture,))[0])
                self.assertEqual(str(row[3]), PEOPLE[role])
                self.cur.execute("DELETE FROM public.playback_jobs WHERE id = %s;", (job,))

    def test_a_capture_that_does_not_exist_is_refused(self):
        with self.assertRaises(pg_errors.ForeignKeyViolation):
            self._start(capture=str(uuid.uuid4()))

    def test_a_gateway_that_does_not_exist_is_refused(self):
        with self.assertRaises(pg_errors.ForeignKeyViolation):
            self._start(target=str(uuid.uuid4()))

    def test_a_gateway_that_is_not_simulated_is_refused(self):
        real, _ = self._gateway(credential=True, name="Behaviour real machine")
        with self.assertRaises(pg_errors.CheckViolation) as ctx:
            self._start(target=real)
        self.assertIn("Behaviour real machine", str(ctx.exception))
        self.assertEqual(self._jobs_on(real), 0)

    def test_a_simulator_that_is_not_the_playback_gateway_is_refused(self):
        """Node-RED publishes as a simulator, and two publishers on one edge node share one seq."""
        simulator, _ = self._gateway(simulated=True, credential=True, name="Behaviour simulator")
        with self.assertRaises(pg_errors.CheckViolation) as ctx:
            self._start(target=simulator)
        self.assertIn("Behaviour simulator", str(ctx.exception))
        self.assertEqual(self._jobs_on(simulator), 0)

    def test_an_archived_playback_gateway_is_refused(self):
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (self.target,))
        with self.assertRaises(pg_errors.InvalidParameterValue):
            self._start()

    def test_a_playback_gateway_holding_no_credential_is_refused(self):
        bare, _ = self._gateway(simulated=True, shadow=True, name="Behaviour no credential")
        with self.assertRaises(pg_errors.CheckViolation) as ctx:
            self._start(target=bare)
        self.assertIn("Behaviour no credential", str(ctx.exception))
        self.assertEqual(self._jobs_on(bare), 0)

    def test_a_second_playback_onto_a_busy_target_is_refused(self):
        for status in ("PENDING", "RUNNING"):
            with self.subTest(status=status):
                self.cur.execute("SAVEPOINT busy;")
                self._playback_job(self.target, self.target_wire, status)
                with self.assertRaises(pg_errors.UniqueViolation):
                    self._start()
                self.assertEqual(self._jobs_on(self.target), 1)
                self.cur.execute("ROLLBACK TO SAVEPOINT busy;")

    def test_a_busy_target_does_not_hold_up_another(self):
        """One playback per target, not one per stack."""
        self._playback_job(self.target, self.target_wire, "RUNNING")
        other, _ = self._gateway(simulated=True, shadow=True, credential=True)
        self.assertIsNotNone(self._start(target=other))

    def test_a_finished_playback_does_not_make_a_target_busy(self):
        for status in ("COMPLETED", "FAILED", "CANCELLED"):
            self._playback_job(self.target, self.target_wire, status)
        self.assertIsNotNone(self._start())

    def test_the_speed_is_clamped_rather_than_refused(self):
        for asked, stored in ((0, "0.01"), (-3, "0.01"), (1000, "60"), (None, "1.0"), (2.5, "2.5")):
            with self.subTest(asked=asked):
                job = self._start(speed=asked, keep=True)
                self.assertEqual(
                    str(self._one("SELECT speed FROM public.playback_jobs WHERE id = %s;", (job,))[0]),
                    stored)
                self.cur.execute("DELETE FROM public.playback_jobs WHERE id = %s;", (job,))

    def test_no_api_role_writes_the_table_directly(self):
        """The function is the only way a job is made, so its refusals are the control."""
        for caller in MANAGERS + ("playback",):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._call(caller,
                               "INSERT INTO public.playback_jobs (capture_storage_path, "
                               "target_gateway_id, target_edge_node_id, sparkplug_group) "
                               "VALUES ('x/capture.json', %s, %s, 'Aber');",
                               (self.target, self.target_wire))


# =================================================================================================
# capped_capture_manifest()
# =================================================================================================
class CappedCaptureManifest(Base):

    def _capped(self, manifest):
        self.cur.execute("SELECT public.capped_capture_manifest(%s::jsonb);",
                         (None if manifest is None else json.dumps(manifest),))
        return self.cur.fetchone()[0]

    def test_anything_but_an_object_becomes_empty(self):
        for manifest in (None, [], "names", 7):
            with self.subTest(manifest=manifest):
                self.assertEqual(self._capped(manifest), {})

    def test_a_manifest_without_a_list_of_names_is_returned_as_it_is(self):
        for manifest in ({"birth_captured": True}, {"metric_names": "Temp", "topic_count": 2},
                         {"metric_names": None}):
            with self.subTest(manifest=manifest):
                self.assertEqual(self._capped(manifest), manifest)

    def test_fifty_names_or_fewer_are_kept_and_counted(self):
        for n in (0, 1, 50):
            with self.subTest(names=n):
                names = [f"M{i:03d}" for i in range(n)]
                self.assertEqual(self._capped({"metric_names": names, "birth_captured": True}),
                                 {"metric_names": names, "metric_name_count": n,
                                  "birth_captured": True})

    def test_more_than_fifty_keeps_the_first_fifty_in_order_and_the_true_count(self):
        names = [f"M{i:03d}" for i in range(137)]
        capped = self._capped({"metric_names": names, "device_ids": ["dev1"], "uses_aliases": False})
        self.assertEqual(capped["metric_names"], names[:50])
        self.assertEqual(capped["metric_name_count"], 137)
        self.assertEqual((capped["device_ids"], capped["uses_aliases"]), (["dev1"], False),
                         "capping the names dropped the rest of the manifest")

    def test_a_recorded_capture_is_stored_capped(self):
        gw, wire = self._gateway()
        job = self._capture_job(gw, wire, "RECORDING")
        names = [f"M{i:03d}" for i in range(75)]
        capture = self._call("ingestion",
                             "SELECT public.ingest_finalise_capture(%s, 4096, 12, %s::jsonb);",
                             (job, json.dumps({"metric_names": names, "device_ids": []})),
                             keep=True)[0][0]
        manifest = self._one("SELECT manifest FROM public.captures WHERE id = %s;", (capture,))[0]
        self.assertEqual((manifest["metric_names"], manifest["metric_name_count"]), (names[:50], 75))

    def test_it_is_plpgsql_and_immutable_and_anon_may_not_call_it(self):
        self.assertEqual(
            self._one("SELECT l.lanname, p.provolatile FROM pg_proc p "
                      "JOIN pg_language l ON l.oid = p.prolang "
                      "WHERE p.oid = 'public.capped_capture_manifest(jsonb)'::regprocedure;"),
            ("plpgsql", "i"))
        self.assertFalse(self._one("SELECT has_function_privilege('anon', "
                                   "'public.capped_capture_manifest(jsonb)', 'EXECUTE');")[0])


# =================================================================================================
# The two startup sweeps
# =================================================================================================
class ReconcileCaptureJobs(Base):

    SWEEP = "SELECT public.ingest_reconcile_capture_jobs();"

    def setUp(self):
        super().setUp()
        self.gw, self.wire = self._gateway()
        self.cur.execute(
            "INSERT INTO public.captures (subject_kind, gateway_id, subject_sparkplug_id, "
            "storage_path, size_bytes, message_count, note) VALUES ('gateway', %s, %s, %s, 10, 2, "
            "'keep me') RETURNING id;", (self.gw, self.wire, f"{self.wire}/stored.json"))
        self.stored = self.cur.fetchone()[0]
        self.finished = {
            status: self._capture_job(self.gw, self.wire, status, error)
            for status, error in (("COMPLETED", None), ("FAILED", "an earlier failure"),
                                  ("CANCELLED", None))
        }

    def _sweep(self):
        return self._call("ingestion", self.SWEEP, keep=True)[0][0]

    def _job(self, jid):
        return self._one("SELECT status, error, finished_at FROM public.capture_jobs WHERE id = %s;",
                         (jid,))

    def test_a_job_in_flight_is_failed_and_finished_ones_are_left_alone(self):
        for status in ("PENDING", "RECORDING"):
            with self.subTest(status=status):
                self.cur.execute("SAVEPOINT sweep;")
                before = {s: self._job(j) for s, j in self.finished.items()}
                live = self._capture_job(self.gw, self.wire, status)
                self.assertEqual(self._sweep(), 1)
                swept = self._job(live)
                self.assertEqual(swept[0], "FAILED")
                self.assertTrue(swept[1], "a swept job says nothing about what happened to it")
                self.assertIsNotNone(swept[2], "a swept job has no finish time")
                self.assertEqual({s: self._job(j) for s, j in self.finished.items()}, before,
                                 "the sweep rewrote a job that had already finished")
                self.cur.execute("ROLLBACK TO SAVEPOINT sweep;")

    def test_the_stored_capture_of_the_subject_is_kept(self):
        self._capture_job(self.gw, self.wire, "RECORDING")
        self._sweep()
        self.assertEqual(
            self._one("SELECT id, storage_path, note FROM public.captures "
                      "WHERE subject_kind = 'gateway' AND gateway_id = %s;", (self.gw,)),
            (self.stored, f"{self.wire}/stored.json", "keep me"))

    def test_a_job_another_daemon_may_still_be_storing_is_spared(self):
        """
        A deleted or evicted pod is replaced at once, and the new daemon sweeps while the old one may
        still be storing its recording in the 30 s grace period. A job that reported, or was queued,
        within the last 45 s is left for it; one quiet longer is failed.
        """
        # One job at a time (capture_jobs_single_flight), so the recording first, then the queued one.
        recording = self._capture_job(self.gw, self.wire, "RECORDING")
        self.cur.execute("UPDATE public.capture_jobs SET elapsed_seconds = 50 WHERE id = %s;",
                         (recording,))
        self.assertEqual(self._sweep(), 0)
        self.assertEqual(self._job(recording)[0], "RECORDING")
        # Quiet for 46 s: past the spare, so the second sweep fails it.
        self.cur.execute("UPDATE public.capture_jobs SET elapsed_seconds = 14 WHERE id = %s;",
                         (recording,))
        self.assertEqual(self._sweep(), 1)
        self.assertEqual(self._job(recording)[0], "FAILED")

        queued = self._capture_job(self.gw, self.wire, "PENDING")
        self.cur.execute("UPDATE public.capture_jobs SET created_at = now() - interval '10 seconds' "
                         "WHERE id = %s;", (queued,))
        self.assertEqual(self._sweep(), 0)
        self.assertEqual(self._job(queued)[0], "PENDING")
        self.cur.execute("UPDATE public.capture_jobs SET created_at = now() - interval '46 seconds' "
                         "WHERE id = %s;", (queued,))
        self.assertEqual(self._sweep(), 1)
        self.assertEqual(self._job(queued)[0], "FAILED")

    def test_a_second_sweep_finds_nothing_and_a_new_capture_may_start(self):
        self._capture_job(self.gw, self.wire, "RECORDING")
        self.assertEqual(self._sweep(), 1)
        self.assertEqual(self._sweep(), 0)
        # The single-flight index no longer holds a swept job.
        other_gw, _ = self._gateway()
        self.assertIsNotNone(self._call(
            "Shopfloor_Manager", "SELECT public.start_capture_job('gateway', %s, NULL, 30, false);",
            (other_gw,))[0][0])

    def test_only_the_ingestion_daemon_may_sweep(self):
        self._capture_job(self.gw, self.wire, "RECORDING")
        for caller in READERS + ("Operator", "playback", "service_role"):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._call(caller, self.SWEEP)
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._call("anon", self.SWEEP)


class ReconcilePlaybackJobs(Base):

    SWEEP = "SELECT public.playback_reconcile_jobs();"

    def setUp(self):
        super().setUp()
        self.target, self.wire = self._gateway(simulated=True, shadow=True)
        # Another Playback gateway, because only one job per gateway may be in flight.
        self.other, self.other_wire = self._gateway(simulated=True, shadow=True)
        self.finished = {
            status: self._playback_job(self.target, self.wire, status, sent=3, total=3)
            for status in ("COMPLETED", "FAILED", "CANCELLED")
        }

    def _sweep(self):
        return self._call("playback", self.SWEEP, keep=True)[0][0]

    def _job(self, jid):
        return self._one("SELECT status, error, finished_at, messages_sent FROM public.playback_jobs "
                         "WHERE id = %s;", (jid,))

    def test_every_job_in_flight_is_failed_and_finished_ones_are_left_alone(self):
        before = {s: self._job(j) for s, j in self.finished.items()}
        pending = self._playback_job(self.target, self.wire, "PENDING")
        running = self._playback_job(self.other, self.other_wire, "RUNNING", sent=7, total=41)
        self.assertEqual(self._sweep(), 2)
        for jid in (pending, running):
            status, error, finished, _ = self._job(jid)
            self.assertEqual(status, "FAILED")
            self.assertTrue(error)
            self.assertIsNotNone(finished)
        self.assertEqual(self._job(running)[3], 7, "the sweep rewrote the count the job reported")
        self.assertEqual({s: self._job(j) for s, j in self.finished.items()}, before,
                         "the sweep rewrote a playback that had already finished")

    def test_a_second_sweep_finds_nothing_and_the_target_is_free_again(self):
        self._playback_job(self.target, self.wire, "RUNNING", sent=1, total=5)
        self.assertEqual(self._sweep(), 1)
        self.assertEqual(self._sweep(), 0)
        self.cur.execute("SELECT public.record_gateway_credential_issued_by_service(%s);", (self.target,))
        self.assertIsNotNone(self._call(
            "Shopfloor_Manager", "SELECT public.start_playback_job(%s, %s);",
            (self._capture(), self.target))[0][0])

    def test_only_the_playback_worker_may_sweep(self):
        self._playback_job(self.target, self.wire, "RUNNING")
        for caller in READERS + ("Operator", "ingestion", "service_role"):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._call(caller, self.SWEEP)
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._call("anon", self.SWEEP)


# =================================================================================================
# Row-level security and grants on the five tables
# =================================================================================================
class TheTablesAdmitWhatTheyShould(Base):

    def setUp(self):
        super().setUp()
        gw, wire = self._gateway()
        target, target_wire = self._gateway(simulated=True, shadow=True)
        self.ids = {
            "captures": self._capture(),
            "capture_jobs": self._capture_job(gw, wire, "COMPLETED"),
            "playback_jobs": self._playback_job(target, target_wire, "COMPLETED"),
        }
        self.cur.execute(
            "INSERT INTO public.playback_worker_status (id, held_edge_nodes, reported_at) "
            "VALUES (true, %s, now());", ([target_wire],))
        self.cur.execute(
            "INSERT INTO public.capture_uploads (subject_kind, gateway_id, subject_sparkplug_id, "
            "storage_path, created_by) VALUES ('gateway', %s, %s, %s, %s) RETURNING id;",
            (gw, wire, f"{wire}/{uuid.uuid4()}.json", PEOPLE["Shopfloor_Manager"]))
        self.ids["capture_uploads"] = str(self.cur.fetchone()[0])

    def _where(self, table):
        return "id = true" if table == "playback_worker_status" else "id = '%s'" % self.ids[table]

    def _sees(self, caller, table):
        return self._call(caller, f"SELECT count(*) FROM public.{table} WHERE {self._where(table)};")[0][0]

    def test_row_level_security_is_on_for_all_five(self):
        self.cur.execute("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace "
                         "AND relname = ANY(%s) AND relrowsecurity;", (list(TABLES),))
        self.assertEqual(sorted(r[0] for r in self.cur.fetchall()), sorted(TABLES))

    def test_the_three_reader_roles_see_the_four_feature_tables_and_nobody_else_does(self):
        for table in TABLES[:4]:
            for caller in READERS:
                with self.subTest(table=table, caller=caller):
                    self.assertEqual(self._sees(caller, table), 1)
            for caller in ("Operator", "ingestion", "playback"):
                with self.subTest(table=table, caller=caller):
                    self.assertEqual(self._sees(caller, table), 0,
                                     f"{caller} reads {table}, which only the gates hand it")

    def test_capture_uploads_takes_nothing_from_any_api_role(self):
        """Only begin_capture_upload() and register_uploaded_capture() touch it."""
        for caller in READERS + ("Operator", "service_role"):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._sees(caller, "capture_uploads")

    def test_anon_holds_nothing_on_any_of_them(self):
        for table in TABLES:
            with self.subTest(table=table):
                self.assertFalse(self._one(
                    "SELECT has_table_privilege('anon', %s, 'SELECT, INSERT, UPDATE, DELETE, "
                    "TRUNCATE, REFERENCES, TRIGGER');", (f"public.{table}",))[0])
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._call("anon", f"SELECT 1 FROM public.{table} LIMIT 1;")

    def test_no_role_writes_a_row_directly(self):
        """Every write goes through a gate. The one exception is deleting a stored capture."""
        writes = {
            "captures": ("UPDATE public.captures SET note = 'x' WHERE {w};",),
            "capture_jobs": ("UPDATE public.capture_jobs SET stop_requested = true WHERE {w};",
                             "DELETE FROM public.capture_jobs WHERE {w};"),
            "playback_jobs": ("UPDATE public.playback_jobs SET stop_requested = true WHERE {w};",
                              "DELETE FROM public.playback_jobs WHERE {w};"),
            "playback_worker_status": ("UPDATE public.playback_worker_status SET reported_at = now() "
                                       "WHERE {w};",
                                       "DELETE FROM public.playback_worker_status WHERE {w};"),
        }
        for table, statements in writes.items():
            for sql in statements:
                for caller in MANAGERS + ("ingestion", "playback"):
                    with self.subTest(table=table, sql=sql.split()[0], caller=caller):
                        with self.assertRaises(pg_errors.InsufficientPrivilege):
                            self._call(caller, sql.format(w=self._where(table)))
        for caller in MANAGERS:
            with self.subTest(table="captures", sql="INSERT", caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._call(caller, "INSERT INTO public.captures (subject_kind, gateway_id, "
                                       "subject_sparkplug_id, storage_path, size_bytes, message_count) "
                                       "SELECT 'gateway', gateway_id, 'gwyx', 'x/y.json', 1, 1 "
                                       "FROM public.captures WHERE " + self._where("captures") + ";")

    def test_only_the_two_writer_roles_delete_a_stored_capture(self):
        for caller in ("Auditor", "Operator", "ingestion", "playback"):
            with self.subTest(caller=caller):
                self.assertEqual(self._call(
                    caller, f"DELETE FROM public.captures WHERE {self._where('captures')};"), 0)
        for caller in MANAGERS:
            with self.subTest(caller=caller):
                self.assertEqual(self._call(
                    caller, f"DELETE FROM public.captures WHERE {self._where('captures')};"), 1)

    def test_realtime_carries_the_two_job_tables_and_not_the_others(self):
        """
        Realtime tells even an unauthenticated subscriber that a published row changed, so a table
        is published only when the page needs it live. docs/security-model.md names these.
        """
        self.cur.execute("SELECT tablename FROM pg_publication_tables WHERE pubname = "
                         "'supabase_realtime' AND schemaname = 'public' AND tablename = ANY(%s);",
                         (list(TABLES),))
        self.assertEqual(sorted(r[0] for r in self.cur.fetchall()), ["capture_jobs", "playback_jobs"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
