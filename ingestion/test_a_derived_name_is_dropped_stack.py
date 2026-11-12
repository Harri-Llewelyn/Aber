"""
A reading under a derived metric's name never reaches the historian, and leaves a finding.

    python ingestion/test_a_derived_name_is_dropped_stack.py

test_a_derived_name_is_dropped.py holds the rule with a fake catalogue. This suite holds it through
the real chain: the catalogue row, the daemon's cached read of it, a real broker, the historian and
the Audit Trail. It walks five steps:

  1. a fixture Host gateway and device, and a derived metric (a counter rate) with the measured
     counter it is built on, added to the catalogue as the database's owner;
  2. a Sparkplug 3.0.0 edge node in this process publishes as the gateway, with the credential the
     Gateways page issues (`gateway-credential`): an NBIRTH, then a DBIRTH of the device declaring
     the measured counter and the derived name;
  3. it publishes two DDATA, each carrying both names;
  4. the measured counter must be in the historian twice and the derived name not at all, nor in the
     device's parameters;
  5. the Audit Trail must hold a `derived_name` finding for the birth and one for the readings, not
     one for every message, and the device must be ONLINE and not quarantined.

The derived row is added BEFORE the device declares the name: the save refuses a name a device has
declared, so the reverse order cannot be built. Everything the suite made is removed afterwards, the
catalogue rows and the audit rows they and the fixtures wrote included.

Needs the stack up, the environment test_playback_replay.py reads (its helpers are reused) and
`SUPABASE_DB_*` for the owner connection. `REQUIRE_PLAYBACK_REPLAY=1` makes every skip a failure.
The daemon reads the catalogue once per `UNS_CONTEXT_TTL_SECONDS` (60), so the derived row is added
a full interval before the first message: the suite waits for it rather than racing it.
"""

import json
import os
import secrets
import sys
import threading
import time
import traceback
import unittest
from pathlib import Path

import psycopg2

INGESTION = Path(__file__).resolve().parent
sys.path.insert(0, str(INGESTION))
sys.path.insert(0, str(INGESTION.parent / "test-harness"))

from test_playback_replay import (  # noqa: E402
    PUBLISHABLE_KEY, SUPABASE_URL, Session, _request, historian, sign_in, skip_or_fail,
)
from test_playback_replay import setUpModule as stack_is_up  # noqa: E402
from test_recorded_capture_replay import (  # noqa: E402
    BROKER_ACCEPT_TIMEOUT, MQTT_HOST, MQTT_PORT, delete_broker_account, owner_connection, poll,
)

try:
    import paho.mqtt.client as mqtt
    import load_generator as payloads
except ImportError as exc:  # reported by setUpModule
    mqtt = payloads = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None

# Pinned, so a run killed before its cleanup leaves rows the next run reclaims. They differ in the
# first hex block from each other and from every other fixture: `sparkplug_id` is the first 21 hex
# characters of the uuid, so ids sharing a long prefix collide.
GATEWAY_ID = "7a000000-0000-4000-8000-000000000001"
DEVICE_ID = "7b000000-0000-4000-8000-000000000001"

DOUBLE = 10

# The daemon reads the catalogue through a cache of this many seconds (UNS_CONTEXT_TTL_SECONDS).
# Read from the environment the stack lane shares with the daemon's chart value, with the default.
CATALOGUE_FRESHNESS = int(os.getenv("UNS_CONTEXT_TTL_SECONDS", "60"))

BIRTH_TIMEOUT = 45
HISTORIAN_TIMEOUT = 60
AUDIT_TIMEOUT = 60
# A read for a row that must NOT arrive. The daemon's writer has no flush interval.
ABSENCE_WINDOW = 15

STAGES = ("the fixture", "the birth", "the readings")


def setUpModule():
    stack_is_up()
    if IMPORT_ERROR is not None:
        skip_or_fail(f"paho-mqtt or the Sparkplug binding is unavailable ({IMPORT_ERROR}); "
                     f"npm run proto generates ingestion/sparkplug_b_pb2.py")


class SmallEdgeNode:
    """
    A Sparkplug 3.0.0 edge node with one device, publishing as the fixture gateway: an NDEATH will,
    the NCMD subscription before the NBIRTH, and one `seq` across births and data. Every send is
    made on the caller's thread, in order, so `seq` reaches the wire in order.
    """

    def __init__(self, group, node_id, password):
        self.group = group
        self.node_id = node_id
        self.sequence = payloads.SequenceCounter()
        self.client = mqtt.Client(client_id=f"aber-test-{node_id}")
        self.client.username_pw_set(node_id, password)
        self.client.will_set(self.topic("NDEATH"), payloads.node_death(0), qos=1, retain=False)
        self.client.on_connect = self._on_connect
        self.client.on_subscribe = self._on_subscribe
        self.connack = []
        self.subscribed = threading.Event()
        self.failures = 0
        self.stopped = False
        self._last_ms = 0

    def topic(self, kind, device=None):
        return "/".join(["spBv1.0", self.group, kind, self.node_id] + ([device] if device else []))

    def connect(self, timeout=15):
        """CONNECT and subscribe; the CONNACK code, or None when the broker said nothing."""
        self.client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
        self.client.loop_start()
        deadline = time.monotonic() + timeout
        while not self.connack and time.monotonic() < deadline:
            time.sleep(0.05)
        if self.connack and self.connack[0] == 0:
            self.subscribed.wait(max(deadline - time.monotonic(), 1.0))
        return self.connack[0] if self.connack else None

    def stop(self):
        """An intentional disconnect: NDEATH, then DISCONNECT."""
        if self.stopped:
            return
        self.stopped = True
        try:
            if self.connack and self.connack[0] == 0:
                self.client.publish(self.topic("NDEATH"), payloads.node_death(0),
                                    qos=1).wait_for_publish(5)
            self.client.disconnect()
        except Exception:  # noqa: BLE001 -- the will covers a death that never left
            pass
        self.client.loop_stop()

    def _on_connect(self, client, _userdata, _flags, rc):
        self.connack.append(rc)
        if rc == 0:
            client.subscribe(self.topic("NCMD"), qos=1)

    def _on_subscribe(self, _client, _userdata, _mid, granted_qos):
        if granted_qos and granted_qos[0] != 0x80:
            self.subscribed.set()

    def _stamp(self):
        """Milliseconds that never repeat: telemetry is keyed on (time, asset, metric)."""
        self._last_ms = max(int(time.time() * 1000), self._last_ms + 1)
        return self._last_ms

    def _send(self, kind, topic, build):
        seq = self.sequence.peek(kind)
        if self.client.publish(topic, build(seq), qos=0, retain=False).rc != mqtt.MQTT_ERR_SUCCESS:
            self.failures += 1
            return False
        self.sequence.commit(seq)
        return True

    def birth(self, device_id, device_name, metrics):
        """An NBIRTH, then the device's DBIRTH declaring `metrics`."""
        node_stamp, device_stamp = self._stamp(), self._stamp()
        self._send("NBIRTH", self.topic("NBIRTH"),
                   lambda seq: payloads.node_birth(node_stamp, seq, 0))
        self._send("DBIRTH", self.topic("DBIRTH", device_id),
                   lambda seq: payloads.device_birth(device_id, device_name, metrics, device_stamp, seq))

    def data(self, device_id, metrics, values):
        stamp = self._stamp()
        return self._send("DDATA", self.topic("DDATA", device_id),
                          lambda seq: payloads.device_data(metrics, stamp, values, seq))


class ADerivedNameIsDropped(unittest.TestCase):
    """One run, walked in setUpClass in three stages; each test asserts one fact about it."""

    @classmethod
    def setUpClass(cls):
        cls.reached = []
        cls.broken = None
        cls.session = cls.edge = cls.gateway = cls.device = cls.owner = None
        cls.catalogue_ids = []
        group = "T324" + secrets.token_hex(5)
        cls.measured = f"{group}/PART_COUNT"
        cls.derived = f"{group}/PARTS_PER_HOUR"
        cls.addClassCleanup(cls._clean_up)
        for stage, step in zip(STAGES, (cls._fixture, cls._birth, cls._readings)):
            try:
                step()
            except Exception as err:  # noqa: BLE001 -- every test needing the stage reports it
                traceback.print_exc()
                cls.broken = f"{stage} did not complete: {err}"
                return
            cls.reached.append(stage)

    def _needs(self, stage):
        if stage not in self.reached:
            self.fail(self.broken or f"{stage} was not reached")

    # ------------------------------------------------------------------------------------------
    # Stage 1: the catalogue rows, the fixture and its edge node
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _fixture(cls):
        cls.owner = owner_connection()
        cls.owner.autocommit = True
        cls._add_to_catalogue()
        cls.session = Session(sign_in())
        cls.gateway = cls.session.upsert("gateways", {
            "id": GATEWAY_ID,
            "name": "DERIVED_NAME_Gateway",
            "description": "Fixture for ingestion/test_a_derived_name_is_dropped_stack.py. Safe to delete.",
            "deployment": "host",
        })
        cls.device = cls.session.upsert("devices", {
            "id": DEVICE_ID,
            "name": "DERIVED_NAME_Device",
            "gateway_id": cls.gateway["id"],
            "description": "Fixture for ingestion/test_a_derived_name_is_dropped_stack.py. Safe to delete.",
        })
        # The default is audit, and it is what the rule must hold under without help.
        if cls.device["conformance_policy"] != "audit":
            raise AssertionError(f"the fixture device is {cls.device['conformance_policy']}, not audit")
        password = cls._issue_gateway_credential()
        cls.edge = cls._connect_edge_node(password)

    @classmethod
    def _add_to_catalogue(cls):
        """
        The counter and the rate built on it, as the owner: the Metrics page's writers need a
        signed-in Administrator and the second factor where it is required, and the trigger and the
        CHECK that guard the page run for the owner too.
        """
        with cls.owner.cursor() as cur:
            cur.execute(
                "INSERT INTO public.metric_catalog (name, datatype, units) VALUES (%s, %s, 'COUNT')"
                " ON CONFLICT (name) DO NOTHING RETURNING id",
                (cls.measured, DOUBLE),
            )
            cls.catalogue_ids += [row[0] for row in cur.fetchall()]
            cur.execute(
                "INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, %s)"
                " ON CONFLICT (name) DO NOTHING RETURNING id",
                (cls.derived, DOUBLE, json.dumps({"kind": "counter_rate", "input": cls.measured})),
            )
            cls.catalogue_ids += [row[0] for row in cur.fetchall()]
            cur.execute("SELECT count(*) FROM public.metric_catalog WHERE name = ANY(%s)"
                        " AND (derivation IS NOT NULL) = (name = %s)",
                        ([cls.measured, cls.derived], cls.derived))
            if cur.fetchone()[0] != 2:
                raise AssertionError("the catalogue does not hold the measured counter and the "
                                     "derived rate this run added")

    @classmethod
    def _issue_gateway_credential(cls):
        status, body = _request(
            f"{SUPABASE_URL}/functions/v1/gateway-credential", method="POST",
            body={"gateway_id": cls.gateway["id"]},
            headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {cls.session.token}",
                     "Content-Type": "application/json"},
        )
        if status != 200 or not (body or {}).get("password"):
            raise AssertionError(
                f"could not issue the fixture gateway's broker credential: {status} "
                f"{(body or {}).get('error')} {(body or {}).get('details')}")
        if body.get("mqtt_username") != cls.gateway["sparkplug_id"]:
            raise AssertionError(f"the credential is for {body.get('mqtt_username')!r}, not the "
                                 f"gateway's sparkplug_id {cls.gateway['sparkplug_id']!r}")
        return body["password"]

    @classmethod
    def _connect_edge_node(cls, password):
        """A new credential can take a moment to reach the running broker, so a refusal is retried."""
        deadline = time.monotonic() + BROKER_ACCEPT_TIMEOUT
        while True:
            edge = SmallEdgeNode(cls.gateway["sparkplug_group"], cls.gateway["sparkplug_id"], password)
            try:
                rc = edge.connect()
            except OSError as err:
                edge.stop()
                raise AssertionError(f"cannot reach the broker at {MQTT_HOST}:{MQTT_PORT} ({err})")
            if rc == 0 and edge.subscribed.is_set():
                return edge
            edge.stop()
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"the broker did not accept the fixture gateway within {BROKER_ACCEPT_TIMEOUT}s "
                    f"(CONNACK {rc}, NCMD subscription granted: {edge.subscribed.is_set()})")
            time.sleep(2)

    # ------------------------------------------------------------------------------------------
    # Stage 2: the device declares both names
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _birth(cls):
        # The daemon has cached the catalogue for at most this long, so a row added just now may
        # not be in the names it holds; wait out the interval rather than race it.
        time.sleep(CATALOGUE_FRESHNESS + 2)
        cls.edge.birth(cls.device["sparkplug_id"], cls.device["name"], [cls.measured, cls.derived])

        def read():
            with cls.owner.cursor() as cur:
                cur.execute("SELECT last_birth_metrics, status, is_quarantined FROM public.devices"
                            " WHERE id = %s", (DEVICE_ID,))
                row = cur.fetchone()
            return row or ([], None, None)
        row = poll(read, lambda r: cls.derived in (r[0] or []), BIRTH_TIMEOUT, 2)
        if cls.derived not in (row[0] or []):
            raise AssertionError(
                f"the daemon did not record the fixture device's DBIRTH within {BIRTH_TIMEOUT}s "
                f"(last row {row}). The broker accepted the connection, so its publishes were "
                f"refused or the daemon dropped them.")

    # ------------------------------------------------------------------------------------------
    # Stage 3: two DDATA, each carrying both names
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _readings(cls):
        cls.sent = [(5.0, 99.0), (6.0, 98.0)]
        for measured, derived in cls.sent:
            if not cls.edge.data(cls.device["sparkplug_id"], [cls.measured, cls.derived],
                                 [measured, derived]):
                raise AssertionError("a DDATA could not be handed to the broker")
            time.sleep(1)
        cls.stored = poll(cls._stored_rows, lambda rows: len([r for r in rows if r[0] == cls.measured]) >= 2,
                          HISTORIAN_TIMEOUT, 2)
        if len([r for r in cls.stored if r[0] == cls.measured]) < 2:
            raise AssertionError(f"the measured counter reached the historian {cls.stored} times "
                                 f"in {HISTORIAN_TIMEOUT}s, not twice")
        # Once more, so a derived reading that would be stored late has arrived too.
        time.sleep(ABSENCE_WINDOW)
        cls.stored = cls._stored_rows()
        cls.findings = poll(cls._finding_rows, lambda rows: len(rows) >= 2, AUDIT_TIMEOUT, 2)
        time.sleep(3)
        cls.findings = cls._finding_rows()

    @classmethod
    def _stored_rows(cls):
        """(metric_name, value) of every historian row of the fixture device, in time order."""
        try:
            conn = historian()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT metric_name, val_double FROM telemetry WHERE asset_id = %s"
                                " ORDER BY time", (cls.device["sparkplug_id"],))
                    return [(name, float(value)) for name, value in cur.fetchall()]
            finally:
                conn.close()
        except psycopg2.Error as err:
            # A dev-loop port-forward dies on a TLS disconnect; the next poll reconnects.
            print(f"historian poll retrying: {err}")
            return []

    @classmethod
    def _finding_rows(cls):
        """The violations of every SCHEMA_REJECTION row the device has, one list per row, oldest first."""
        with cls.owner.cursor() as cur:
            cur.execute("SELECT new_data -> 'violations' FROM public.audit_trail"
                        " WHERE entity_id = %s AND action = 'SCHEMA_REJECTION' ORDER BY id", (DEVICE_ID,))
            return [row[0] for row in cur.fetchall()]

    # ------------------------------------------------------------------------------------------
    # What the run showed
    # ------------------------------------------------------------------------------------------
    def test_the_derived_reading_is_not_in_the_historian(self):
        self._needs("the readings")
        names = {name for name, _ in self.stored}
        self.assertNotIn(self.derived, names, f"the historian holds a reading under {self.derived}")

    def test_its_measured_sibling_in_the_same_messages_is_stored(self):
        self._needs("the readings")
        self.assertEqual([value for name, value in self.stored if name == self.measured],
                         [measured for measured, _ in self.sent])

    def test_the_birth_s_value_is_not_kept_as_a_parameter(self):
        self._needs("the readings")
        with self.owner.cursor() as cur:
            cur.execute("SELECT metric_name FROM public.asset_config WHERE asset_id = %s",
                        (self.device["sparkplug_id"],))
            kept = {row[0] for row in cur.fetchall()}
        self.assertIn(self.measured, kept)
        self.assertNotIn(self.derived, kept)

    def test_a_derived_name_finding_is_recorded_as_a_dropped_metric(self):
        self._needs("the readings")
        violations = [v for row in self.findings for v in row]
        self.assertTrue(violations, "no SCHEMA_REJECTION row was recorded for the device")
        for v in violations:
            self.assertEqual((v["metric"], v["code"], v["dropped"]), (self.derived, "derived_name", True))
        self.assertIn("Aber computes", violations[0]["detail"])
        self.assertIn("another name", violations[0]["detail"])

    def test_it_is_recorded_once_for_the_birth_and_once_for_the_readings(self):
        # Two DDATA carried the name, and the DBIRTH declared it: a row for each stream's change,
        # not a row for each message.
        self._needs("the readings")
        self.assertEqual(len(self.findings), 2, self.findings)

    def test_the_device_is_still_heard_and_not_quarantined(self):
        self._needs("the readings")
        with self.owner.cursor() as cur:
            cur.execute("SELECT status, is_quarantined FROM public.devices WHERE id = %s", (DEVICE_ID,))
            status, quarantined = cur.fetchone()
        self.assertEqual(status, "ONLINE")
        self.assertFalse(quarantined)

    def test_the_catalogue_still_holds_the_derived_row_the_daemon_judged_by(self):
        self._needs("the readings")
        with self.owner.cursor() as cur:
            cur.execute("SELECT derivation ->> 'kind' FROM public.metric_catalog WHERE name = %s",
                        (self.derived,))
            self.assertEqual(cur.fetchone()[0], "counter_rate")

    # ------------------------------------------------------------------------------------------
    # Everything the suite made
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _clean_up(cls):
        if cls.edge is not None:
            cls.edge.stop()

        def attempt(what, action):
            try:
                action()
            except Exception as err:  # noqa: BLE001 -- cleanup must not mask a real failure
                print(f"cleanup warning: {what}: {err}")

        if cls.session is not None:
            # The device explicitly: deleting a gateway leaves its devices unassigned rather than gone.
            attempt("the device", lambda: cls.session.rest(f"/devices?id=eq.{DEVICE_ID}", method="DELETE"))
            attempt("the gateway", lambda: cls.session.rest(f"/gateways?id=eq.{GATEWAY_ID}", method="DELETE"))
        if cls.gateway:
            def drop_account():
                result = delete_broker_account(cls.gateway["sparkplug_id"])
                if result.returncode != 0:
                    raise RuntimeError(result.stderr.strip() or result.stdout.strip())
            attempt("the broker account", drop_account)
        if cls.device:
            attempt("the historian rows", cls._delete_telemetry)
        if cls.owner is not None:
            attempt("the catalogue and audit rows", cls._delete_owned_rows)
            attempt("the owner connection", cls.owner.close)

    @classmethod
    def _delete_telemetry(cls):
        conn = historian()
        conn.autocommit = True
        with conn.cursor() as cur:
            # The id a literal, so only this asset's compressed batches are opened.
            cur.execute("DELETE FROM telemetry WHERE asset_id = %s", (cls.device["sparkplug_id"],))
            cur.execute("DELETE FROM assets WHERE asset_id = %s", (cls.device["sparkplug_id"],))
        conn.close()

    @classmethod
    def _delete_owned_rows(cls):
        with cls.owner.cursor() as cur:
            if cls.device:
                cur.execute("DELETE FROM public.asset_config WHERE asset_id = %s",
                            (cls.device["sparkplug_id"],))
            # The derived row first: it names the counter it is built on.
            cur.execute("DELETE FROM public.metric_catalog WHERE name = %s", (cls.derived,))
            cur.execute("DELETE FROM public.metric_catalog WHERE name = %s", (cls.measured,))
            # audit_trail takes no DELETE from any application role, so what the fixtures and the
            # catalogue rows wrote needs the owner.
            cur.execute("DELETE FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[])",
                        ([GATEWAY_ID, DEVICE_ID, *cls.catalogue_ids],))


if __name__ == "__main__":
    unittest.main(verbosity=2)
