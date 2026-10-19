"""
A capture recorded from the live broker reaches storage, and replays into the historian.

    python ingestion/test_recorded_capture_replay.py

test_playback_replay.py replays a file it uploaded itself. This suite records one the way the
Capture page does and replays that, so a recording that never reaches storage, or a file the daemon
writes that playback cannot read, fails a suite. It walks six steps:

  1. a Sparkplug 3.0.0 edge node in this process publishes live as a fixture Host gateway, with the
     broker credential the Gateways page issues (`gateway-credential`);
  2. it answers the rebirth request the daemon sends when the capture starts;
  3. an Administrator starts the capture with `start_capture_job()` and ends it with
     `request_capture_stop()`;
  4. the file in `broker-captures`, the `captures` row and its manifest are checked against what was
     published;
  5. that capture is replayed through the playback worker, and its readings must reach the
     historian under the replay lane and nowhere else;
  6. a capture of a second device the edge node never publishes must fail, and keep the capture
     already stored for that device.

AStoredCaptureIsNeverOverwritten holds the upload race against the real bucket: a page that had not
caught up is refused before it writes, a refused register leaves the row and its file agreeing, and
a deleted subject's capture file is claimed by nothing.

ACaptureAtTheCapFitsBothWorkers records a device to the 50 MiB size cap and replays it, reading
each worker's memory from its container's cgroup with kubectl: each peak must stay under 60% of the
container's limit.

The gateway is the suite's own rather than the validator's, so nothing else publishes under its edge
node. The daemon asks for the capture's rebirth with `force`, so the rebirth rate limit does not
apply to it.

Needs the stack up and `playback.enabled` (values-dev.yaml sets it), and the environment
test_playback_replay.py reads, whose helpers this reuses. REQUIRE_PLAYBACK_REPLAY=1 makes every skip
a failure.
"""

import base64
import json
import os
import secrets
import sys
import threading
import time
import traceback
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import psycopg2

INGESTION = Path(__file__).resolve().parent
sys.path.insert(0, str(INGESTION))
sys.path.insert(0, str(INGESTION.parent / "test-harness"))

import stack_exec  # noqa: E402  -- removes the fixture gateway's broker account
from test_playback_replay import (  # noqa: E402
    BUCKET, CONNECT_TIMEOUT, PUBLISHABLE_KEY, SUPABASE_DB_HOST, SUPABASE_DB_NAME, SUPABASE_DB_PASS,
    SUPABASE_DB_PORT, SUPABASE_DB_USER, SUPABASE_URL, Session, _epoch_seconds, _request,
    capture_version, historian, sign_in, skip_or_fail,
)
from test_playback_replay import setUpModule as stack_is_up  # noqa: E402

# The edge node's payloads are the load generator's, which test_load_generator_payloads.py reads
# back with the real protobuf module. All three need the generated binding (npm run proto).
try:
    import paho.mqtt.client as mqtt
    import load_generator as payloads
    import sparkplug_b_pb2
except ImportError as exc:  # reported by setUpModule
    mqtt = payloads = sparkplug_b_pb2 = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None

MQTT_HOST = os.getenv("MQTT_TEST_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_TEST_PORT", "1883"))

# Pinned, so a run killed before its cleanup leaves rows the next run reclaims. They differ in the
# first hex block from each other and from every other fixture: `sparkplug_id` is the first 21 hex
# characters of the uuid, so ids sharing a long prefix collide.
SOURCE_GATEWAY_ID = "6c000000-0000-4000-8000-000000000001"
SOURCE_DEVICE_ID = "6d000000-0000-4000-8000-000000000001"
# A second device of the fixture gateway, which its edge node never publishes.
SILENT_DEVICE_ID = "6e000000-0000-4000-8000-000000000001"
# The upload race's own subject: a gateway and device no edge node publishes as.
UPLOAD_GATEWAY_ID = "71000000-0000-4000-8000-000000000001"
UPLOAD_DEVICE_ID = "72000000-0000-4000-8000-000000000001"
# The memory case's own subject, recorded to the size cap.
CAP_GATEWAY_ID = "73000000-0000-4000-8000-000000000001"
CAP_DEVICE_ID = "74000000-0000-4000-8000-000000000001"

# One DDATA a second; the capture runs until DATA_AFTER_BIRTH have followed the rebirth.
DATA_INTERVAL = 1.0
DATA_AFTER_BIRTH = 3
# The daemon reports progress once a second, so this lets the last reading arrive before the stop.
STOP_GRACE = 2.0
# A backstop only: the suite stops the capture itself.
CAPTURE_MAX_SECONDS = 120

BROKER_ACCEPT_TIMEOUT = 30
LIVE_BIRTH_TIMEOUT = 45
# The daemon looks for queued jobs every three seconds.
CLAIM_TIMEOUT = 30
REBIRTH_TIMEOUT = 15
FINISH_TIMEOUT = 60
# The kubelet refreshes a projected Secret about once a minute (test_playback_replay.py).
CREDENTIAL_TIMEOUT = 240
WORKER_STALE_SECONDS = 120
JOB_TIMEOUT = 120
HISTORIAN_TIMEOUT = 60
HISTORIAN_SETTLE = 3

TERMINAL = ("COMPLETED", "FAILED", "CANCELLED")
STAGES = ("the fixture", "the recording", "what was stored", "the replay", "the silent device")

# Sparkplug plumbing and identity, which the manifest's metric names leave out (capture_worker).
NOT_MACHINE_METRICS = ("bdSeq", "Asset_ID", "Asset_Name", "Instance_UUID", "Schema_UUID")


def is_machine_metric(name):
    return name not in NOT_MACHINE_METRICS and not name.startswith(("Node Control/", "Device Control/"))


def small_capture(gateway, device, metric, epoch_ms):
    """A valid capture file of one device: an NBIRTH, a DBIRTH and two DDATA."""
    def message(offset, kind, device_segment, metrics):
        topic = "spBv1.0/Aber/%s/%s%s" % (kind, gateway, "/" + device_segment if device_segment else "")
        return {"offset_ms": offset, "topic": topic, "encoding": "json",
                "payload": {"timestamp": epoch_ms + offset, "seq": offset // 1000,
                            "metrics": metrics}}
    reading = lambda value: [{"name": metric, "datatype": 10, "double_value": value}]  # noqa: E731
    return {
        "aber_capture_version": capture_version(),
        "capture_epoch_ms": epoch_ms,
        "duration_ms": 3000,
        "identities": {"edge_nodes": [gateway], "devices": [device]},
        "messages": [
            message(0, "NBIRTH", None, [{"name": "bdSeq", "datatype": 8, "long_value": 0}]),
            message(1000, "DBIRTH", device, reading(1.0)),
            message(2000, "DDATA", device, reading(2.0)),
            message(3000, "DDATA", device, reading(3.0)),
        ],
    }


def store_upload(session, kind, subject_id, document, replace=True, expected=None, size=None):
    """Begin, upload and register, as the page does. Returns (status, capture id or error, path)."""
    status, issued = session.rpc("begin_capture_upload", {
        "p_subject_kind": kind, "p_subject_id": subject_id, "p_replace": replace,
        "p_expected_capture_id": expected,
    })
    if status != 200:
        return status, issued, None
    path = issued["storage_path"]
    up, body = session.upload(path, document)
    if up not in (200, 201):
        return up, body, path
    status, capture_id = session.rpc("register_uploaded_capture", {
        "p_subject_kind": kind, "p_subject_id": subject_id, "p_storage_path": path,
        "p_size_bytes": size if size is not None else len(json.dumps(document)),
        "p_message_count": len(document["messages"]),
        "p_manifest": {"device_ids": document["identities"]["devices"],
                       "edge_node_ids": document["identities"]["edge_nodes"]},
        "p_note": "test_recorded_capture_replay.py upload", "p_replace": replace,
    })
    return status, capture_id, path


def setUpModule():
    stack_is_up()
    if IMPORT_ERROR is not None:
        skip_or_fail(f"paho-mqtt or the Sparkplug binding is unavailable ({IMPORT_ERROR}); "
                     f"npm run proto generates ingestion/sparkplug_b_pb2.py")


def poll(read, done, timeout, interval):
    """`read()` until `done(value)` holds or `timeout` seconds pass; returns the last value."""
    deadline = time.monotonic() + timeout
    value = read()
    while not done(value) and time.monotonic() < deadline:
        time.sleep(interval)
        value = read()
    return value


def token_subject(token):
    """The signed-in person's id, from the access token's `sub` claim."""
    body = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))["sub"]


def download(session, path):
    """(status, bytes) of a stored capture, read as the Capture page's Download reads it."""
    request = urllib.request.Request(f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}",
                                     headers=session._headers())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def owner_connection():
    """The Supabase database as its owner: audit_trail takes no DELETE from any API role."""
    return psycopg2.connect(
        host=SUPABASE_DB_HOST, port=SUPABASE_DB_PORT, database=SUPABASE_DB_NAME,
        user=SUPABASE_DB_USER, password=SUPABASE_DB_PASS, connect_timeout=CONNECT_TIMEOUT,
    )


def delete_broker_account(username):
    """Removed through the credential service's admin credential; deleting the gateway row only
    disables it."""
    return stack_exec.run(
        "credential", "sh", "-c",
        'mosquitto_ctrl -h "${MQTT_HOST:-mosquitto}" -u "$MQTT_DYNSEC_ADMIN_USER" '
        f'-P "$MQTT_DYNSEC_ADMIN_PASSWORD" dynsec deleteClient {username}',
    )


def msg_type(message):
    return message["topic"].split("/")[2]


def reading(message, metric):
    """The value `message` carries for `metric`, or None."""
    for m in message["payload"].get("metrics", []):
        if m.get("name") == metric:
            return m.get("double_value")
    return None


def replayed(messages):
    """
    What capture.plan_playback() replays of a one-device recording: a session opens at an NBIRTH
    and a device's data follows its DBIRTH, so DDATA the recording caught before the birth it
    asked for is left out.
    """
    out, node_born, device_born = [], False, False
    for message in messages:
        kind = msg_type(message)
        if kind == "NBIRTH":
            node_born, device_born = True, False
        elif not node_born or (kind in ("DDATA", "DDEATH") and not device_born):
            continue
        elif kind in ("DBIRTH", "DDEATH"):
            device_born = kind == "DBIRTH"
        elif kind == "NDEATH":
            node_born = device_born = False
        out.append(message)
    return out


class FixtureEdgeNode:
    """
    A Sparkplug 3.0.0 edge node with one device, publishing as the fixture gateway.

    One MQTT 3.1.1 session: an NDEATH will carrying its bdSeq, the NCMD subscription at QoS 1 before
    the NBIRTH, and one `seq` across births and data. Every publish after the first birth happens on
    one thread, so `seq` reaches the wire in order. A rebirth request stops DATA, publishes NBIRTH
    (with the same bdSeq) and DBIRTH, and resumes DATA
    (tck-id-operational-behavior-data-commands-rebirth-action-1 to -3). Each DDATA carries the next
    whole number, so a reading in the historian names the message it came from.
    """

    def __init__(self, group, node_id, device, password, metric):
        self.group = group
        self.node_id = node_id
        self.device_id = device["sparkplug_id"]
        self.device_name = device["name"]
        self.metric = metric
        self.bdseq = 0
        self.sequence = payloads.SequenceCounter()
        self.client = mqtt.Client(client_id=f"aber-test-{node_id}")
        self.client.username_pw_set(node_id, password)
        self.client.will_set(self.topic("NDEATH"), payloads.node_death(self.bdseq),
                             qos=1, retain=False)
        self.client.on_connect = self._on_connect
        self.client.on_subscribe = self._on_subscribe
        self.client.on_message = self._on_message
        self.connack = []
        self.subscribed = threading.Event()
        # (monotonic time, topic, asks for a rebirth) for every NCMD received.
        self.commands = []
        # Monotonic time of each birth sequence published.
        self.births = []
        # (monotonic time, value) for every DDATA published.
        self.values = []
        self.publish_failures = 0
        self.stopped = False
        self._rebirth = threading.Event()
        self._data = threading.Event()
        self._halt = threading.Event()
        self._lock = threading.Lock()
        self._thread = None
        self._last_ms = 0

    def topic(self, kind, device=None):
        return "/".join(["spBv1.0", self.group, kind, self.node_id] + ([device] if device else []))

    @property
    def published(self):
        return [value for _, value in self.values]

    def births_since(self, moment):
        return [t for t in self.births if t >= moment]

    def values_since(self, moment):
        return [value for t, value in self.values if t >= moment]

    def connect(self, host, port, timeout=15):
        """CONNECT and subscribe; returns the CONNACK code, or None when the broker said nothing."""
        self.client.connect(host, port, keepalive=30)
        self.client.loop_start()
        deadline = time.monotonic() + timeout
        while not self.connack and time.monotonic() < deadline:
            time.sleep(0.05)
        if self.connack and self.connack[0] == 0:
            self.subscribed.wait(max(deadline - time.monotonic(), 1.0))
        return self.connack[0] if self.connack else None

    def start(self):
        """The first birth sequence, then DATA every DATA_INTERVAL seconds."""
        self._birth()
        self._data.set()
        self._thread = threading.Thread(target=self._run, name=f"edge-{self.node_id}", daemon=True)
        self._thread.start()

    def pause(self):
        """Stop DATA; returns once no DDATA is in flight. Rebirth requests are still answered."""
        self._data.clear()
        with self._lock:
            pass

    def stop(self):
        """An intentional disconnect: NDEATH, then DISCONNECT
        (tck-id-payloads-ndeath-will-message-publisher-disconnect-mqtt311)."""
        if self.stopped:
            return
        self.stopped = True
        self._halt.set()
        if self._thread is not None:
            self._thread.join(5)
        try:
            if self.connack and self.connack[0] == 0:
                self.client.publish(self.topic("NDEATH"), payloads.node_death(self.bdseq),
                                    qos=1).wait_for_publish(5)
            self.client.disconnect()
        except Exception:  # noqa: BLE001 -- the will covers a death that never left
            pass
        self.client.loop_stop()

    # paho's network thread -------------------------------------------------------------------
    def _on_connect(self, client, _userdata, _flags, rc):
        self.connack.append(rc)
        if rc == 0:
            client.subscribe(self.topic("NCMD"), qos=1)

    def _on_subscribe(self, _client, _userdata, _mid, granted_qos):
        if granted_qos and granted_qos[0] != 0x80:
            self.subscribed.set()

    def _on_message(self, _client, _userdata, message):
        payload = sparkplug_b_pb2.Payload()
        try:
            payload.ParseFromString(message.payload)
        except Exception:  # noqa: BLE001 -- not a Sparkplug payload, so not a request
            return
        asks = payloads.asks_for_rebirth(payload)
        self.commands.append((time.monotonic(), message.topic, asks))
        if asks:
            self._rebirth.set()

    # the publishing thread -------------------------------------------------------------------
    def _stamp(self):
        """Milliseconds that never repeat: telemetry is keyed on (time, asset, metric)."""
        self._last_ms = max(int(time.time() * 1000), self._last_ms + 1)
        return self._last_ms

    def _send(self, kind, topic, build):
        seq = self.sequence.peek(kind)
        if self.client.publish(topic, build(seq), qos=0, retain=False).rc != mqtt.MQTT_ERR_SUCCESS:
            self.publish_failures += 1
            return False
        self.sequence.commit(seq)
        return True

    def _birth(self):
        node_stamp, device_stamp = self._stamp(), self._stamp()
        self._send("NBIRTH", self.topic("NBIRTH"),
                   lambda seq: payloads.node_birth(node_stamp, seq, self.bdseq))
        self._send("DBIRTH", self.topic("DBIRTH", self.device_id),
                   lambda seq: payloads.device_birth(
                       self.device_id, self.device_name, [self.metric], device_stamp, seq))
        self.births.append(time.monotonic())

    def _run(self):
        due = time.monotonic() + DATA_INTERVAL
        while not self._halt.is_set():
            with self._lock:
                if self._rebirth.is_set():
                    self._rebirth.clear()
                    self._birth()
                elif self._data.is_set() and time.monotonic() >= due:
                    value = float(len(self.values) + 1)
                    stamp = self._stamp()
                    if self._send("DDATA", self.topic("DDATA", self.device_id),
                                  lambda seq: payloads.device_data(
                                      [self.metric], stamp, [value], seq)):
                        self.values.append((time.monotonic(), value))
                    due = time.monotonic() + DATA_INTERVAL
            time.sleep(0.02)


class RecordedCaptureReplays(unittest.TestCase):
    """
    One recording and one replay, walked in setUpClass in four stages. Each test asserts one step;
    a test whose stage was not reached fails naming the stage that broke and why.
    """

    @classmethod
    def setUpClass(cls):
        cls.reached = []
        cls.broken = None
        cls.session = cls.edge = cls.silent_edge = cls.gateway = cls.device = None
        cls.capture_job_id = cls.capture_id = cls.storage_path = None
        cls.lane = cls.lane_id = None
        cls.password = cls.silent = cls.silent_job = cls.silent_capture_id = cls.silent_path = None
        cls.metric = "CAPTURE/RECORDED_" + secrets.token_hex(8).upper()
        cls.note = "recorded capture conformance fixture"
        cls.addClassCleanup(cls._clean_up)
        steps = (cls._fixture, cls._record, cls._read_what_was_stored, cls._replay,
                 cls._record_the_silent_device)
        for stage, step in zip(STAGES, steps):
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
    # Stage 1: the fixture gateway, its device, its credential and its edge node
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _fixture(cls):
        cls.session = Session(sign_in())
        cls.user_id = token_subject(cls.session.token)
        # A Host gateway, because its credential is issued from the Gateways page.
        cls.gateway = cls.session.upsert("gateways", {
            "id": SOURCE_GATEWAY_ID,
            "name": "CAPTURE_RECORD_Source_Gateway",
            "description": "Fixture for ingestion/test_recorded_capture_replay.py. Safe to delete.",
            "deployment": "host",
        })
        cls.device = cls.session.upsert("devices", {
            "id": SOURCE_DEVICE_ID,
            "name": "CAPTURE_RECORD_Source_Device",
            "gateway_id": cls.gateway["id"],
            "description": "Fixture for ingestion/test_recorded_capture_replay.py. Safe to delete.",
        })
        # Under `enforce` the run's metric, which no schema declares, would be dropped on ingest; the
        # lane copies the policy.
        if cls.device["conformance_policy"] != "audit":
            raise AssertionError(
                f"the fixture device is {cls.device['conformance_policy']}, not audit")
        cls.silent = cls.session.upsert("devices", {
            "id": SILENT_DEVICE_ID,
            "name": "CAPTURE_RECORD_Silent_Device",
            "gateway_id": cls.gateway["id"],
            "description": "Fixture for ingestion/test_recorded_capture_replay.py. Never published. "
                           "Safe to delete.",
        })
        cls.password = cls._issue_gateway_credential()
        cls.edge = cls._connect_edge_node(cls.password)
        cls.edge.start()
        cls._await_live_birth()

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
        """A new credential can take a moment to reach the running broker, so a refusal is
        retried."""
        deadline = time.monotonic() + BROKER_ACCEPT_TIMEOUT
        while True:
            edge = FixtureEdgeNode(cls.gateway["sparkplug_group"], cls.gateway["sparkplug_id"],
                                   cls.device, password, cls.metric)
            try:
                rc = edge.connect(MQTT_HOST, MQTT_PORT)
            except OSError as err:
                edge.stop()
                raise AssertionError(f"cannot reach the broker at {MQTT_HOST}:{MQTT_PORT} ({err})")
            if rc == 0 and edge.subscribed.is_set():
                return edge
            edge.stop()
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"the broker did not accept the fixture gateway within "
                    f"{BROKER_ACCEPT_TIMEOUT}s "
                    f"(CONNACK {rc}, NCMD subscription granted: {edge.subscribed.is_set()})")
            time.sleep(2)

    @classmethod
    def _await_live_birth(cls):
        """The daemon has the fixture's DBIRTH, so it is subscribed and resolves the subject."""
        def read():
            status, rows = cls.session.rest(
                f"/devices?select=status,last_birth_metrics&id=eq.{SOURCE_DEVICE_ID}&limit=1")
            return rows[0] if status == 200 and rows else {}
        row = poll(read, lambda r: cls.metric in (r.get("last_birth_metrics") or []),
                   LIVE_BIRTH_TIMEOUT, 2)
        if cls.metric not in (row.get("last_birth_metrics") or []):
            raise AssertionError(
                f"the daemon did not record the fixture device's DBIRTH within "
                f"{LIVE_BIRTH_TIMEOUT}s "
                f"(last row {row}). The broker accepted the connection, so its publishes were "
                f"refused or the daemon dropped them.")

    # ------------------------------------------------------------------------------------------
    # Stage 2: the recording, started and stopped as the Capture page does
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _record(cls):
        cls.capture_started = time.monotonic()
        status, job_id = cls.session.rpc("start_capture_job", {
            "p_subject_kind": "device",
            "p_subject_id": SOURCE_DEVICE_ID,
            "p_note": cls.note,
            "p_max_seconds": CAPTURE_MAX_SECONDS,
            # The page's confirmed replace, for a capture an interrupted run left behind.
            "p_replace": True,
        })
        if status not in (200, 201) or not job_id:
            raise AssertionError(f"start_capture_job refused the fixture: {status} {job_id}")
        cls.capture_job_id = job_id

        job = cls._capture_job(lambda j: j.get("status") not in (None, "PENDING"), CLAIM_TIMEOUT)
        if job.get("status") != "RECORDING":
            raise AssertionError(
                f"the capture is {job.get('status')} after {CLAIM_TIMEOUT}s, not RECORDING "
                f"({job.get('error')}). PENDING means the daemon never claimed it.")

        births = poll(lambda: cls.edge.births_since(cls.capture_started), bool,
                      REBIRTH_TIMEOUT, 0.2)
        if not births:
            raise AssertionError(
                f"the daemon claimed the capture and the edge node answered no rebirth request "
                f"within {REBIRTH_TIMEOUT}s; NCMDs received: {cls.edge.commands}")
        poll(lambda: cls.edge.values_since(births[0]), lambda v: len(v) >= DATA_AFTER_BIRTH,
             DATA_AFTER_BIRTH * DATA_INTERVAL + 10, 0.2)
        cls.edge.pause()
        time.sleep(STOP_GRACE)

        status, stopped = cls.session.rpc("request_capture_stop", {"p_job_id": job_id})
        if status != 200 or stopped is not True:
            job = cls._capture_job(lambda j: True, 0)
            raise AssertionError(
                f"request_capture_stop answered {status} {stopped}; the job is "
                f"{job.get('status')}: {job.get('error')}")
        cls.capture_job = cls._capture_job(lambda j: j.get("status") in TERMINAL, FINISH_TIMEOUT)
        cls.edge.stop()
        if cls.capture_job.get("status") != "COMPLETED":
            raise AssertionError(f"the capture is {cls.capture_job.get('status')}, not COMPLETED: "
                                 f"{cls.capture_job.get('error')}")
        cls.capture_id = cls.capture_job["capture_id"]

    @classmethod
    def _capture_job(cls, done, timeout):
        def read():
            status, rows = cls.session.rest(
                f"/capture_jobs?select=*&id=eq.{cls.capture_job_id}&limit=1")
            return rows[0] if status == 200 and rows else {}
        return poll(read, done, timeout, 1)

    # ------------------------------------------------------------------------------------------
    # Stage 3: the row and the file
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _read_what_was_stored(cls):
        status, rows = cls.session.rest(f"/captures?select=*&id=eq.{cls.capture_id}&limit=1")
        if status != 200 or not rows:
            raise AssertionError(f"the job names capture {cls.capture_id}, which cannot be read: "
                                 f"{status} {rows}")
        cls.capture_row = rows[0]
        # The job's own path, deleted at clean-up once the row is.
        cls.storage_path = cls.capture_row["storage_path"]
        status, raw = download(cls.session, cls.capture_row["storage_path"])
        if status != 200:
            raise AssertionError(f"the row names {cls.capture_row['storage_path']}, and {BUCKET} "
                                 f"answered {status}: {raw[:300]!r}")
        cls.stored = raw
        try:
            cls.document = json.loads(raw.decode("utf-8"))
        except ValueError as err:
            raise AssertionError(f"the stored capture is not JSON: {err}")
        cls.messages = cls.document.get("messages") or []
        cls.recorded_values = [
            reading(m, cls.metric) for m in cls.messages if msg_type(m) == "DDATA"]
        cls.replayed = replayed(cls.messages)
        cls.replayed_values = [
            reading(m, cls.metric) for m in cls.replayed if msg_type(m) == "DDATA"]

    # ------------------------------------------------------------------------------------------
    # Stage 4: the replay, as the playback dialog starts it
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _replay(cls):
        status, rows = cls.session.rest(
            "/gateways?select=id,name,sparkplug_id,sparkplug_group"
            "&is_shadow=eq.true&is_archived=eq.false&limit=1")
        if status != 200 or not rows:
            raise AssertionError(f"no live playback gateway ({status})")
        cls.playback_gateway = rows[0]
        cls._ensure_worker_credential()

        status, mapping = cls.session.rpc("ensure_shadow_devices", {"p_capture_id": cls.capture_id})
        if status != 200 or not mapping:
            raise AssertionError(f"could not mint the replay lanes: {status} {mapping}")
        cls.lane_map = mapping
        cls.lane = mapping.get(cls.device["sparkplug_id"])
        if not cls.lane:
            raise AssertionError(f"the recorded device has no lane in {mapping}")
        status, rows = cls.session.rest(f"/devices?select=id&sparkplug_id=eq.{cls.lane}&limit=1")
        cls.lane_id = rows[0]["id"] if status == 200 and rows else None

        status, job_id = cls.session.rpc("start_playback_job", {
            "p_capture_id": cls.capture_id,
            "p_target_gateway_id": cls.playback_gateway["id"],
            "p_device_map": cls.lane_map,
            "p_speed": 1.0,
        })
        if status not in (200, 201) or not job_id:
            raise AssertionError(
                f"start_playback_job refused the recorded capture: {status} {job_id}")

        def read():
            got, rows = cls.session.rest(f"/playback_jobs?select=*&id=eq.{job_id}&limit=1")
            return rows[0] if got == 200 and rows else {}
        timeout = JOB_TIMEOUT + cls.document.get("duration_ms", 0) / 1000
        cls.playback_job = poll(read, lambda j: j.get("status") in TERMINAL, timeout, 2)
        if cls.playback_job.get("status") not in TERMINAL:
            raise AssertionError(
                f"the playback did not finish within {timeout:.0f}s (last seen: "
                f"{cls.playback_job}). PENDING means no worker claimed it.")
        cls.rows = cls._await_historian()

    @classmethod
    def _worker_holds(cls, wanted):
        """The worker reports, recently, the Playback gateway's current credential."""
        status, rows = cls.session.rest(
            "/playback_worker_status?select=held_edge_nodes,reported_at&limit=1")
        if status != 200 or not rows or wanted not in (rows[0].get("held_edge_nodes") or []):
            return False
        if time.time() - _epoch_seconds(rows[0]["reported_at"]) > WORKER_STALE_SECONDS:
            return False
        status, stale = cls.session.rest("/rpc/playback_stale_credentials", method="POST", body={})
        return status == 200 and not any(r.get("sparkplug_id") == wanted for r in (stale or []))

    @classmethod
    def _ensure_worker_credential(cls):
        """Issued only when the worker does not already hold a current one; test_playback_replay.py
        is the suite that exercises the delivery itself."""
        wanted = cls.playback_gateway["sparkplug_id"]
        if cls._worker_holds(wanted):
            return
        status, body = _request(
            f"{SUPABASE_URL}/functions/v1/gateway-credential", method="POST",
            body={"gateway_id": cls.playback_gateway["id"]},
            headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {cls.session.token}",
                     "Content-Type": "application/json"},
        )
        if status != 200 or (body or {}).get("playback_delivered") is not True:
            raise AssertionError(f"could not issue and deliver the playback credential: {status} "
                                 f"{(body or {}).get('error')} {(body or {}).get('details')} "
                                 f"playback_delivered={(body or {}).get('playback_delivered')}")
        if not poll(lambda: cls._worker_holds(wanted), bool, CREDENTIAL_TIMEOUT, 3):
            raise AssertionError(
                f"the playback worker did not report holding {wanted}'s current credential within "
                f"{CREDENTIAL_TIMEOUT}s. Is `playback.enabled` set (values-dev.yaml sets it)?")

    @classmethod
    def _await_historian(cls):
        """Every row carrying the run's metric, as (asset_id, value) in time order."""
        def read():
            try:
                conn = historian()
                try:
                    with conn.cursor() as cur:
                        cur.execute("SELECT asset_id, val_double FROM telemetry "
                                    "WHERE metric_name = %s ORDER BY time", (cls.metric,))
                        return [(a, float(v)) for a, v in cur.fetchall()]
                finally:
                    conn.close()
            except psycopg2.Error as err:
                # A dev-loop port-forward dies on a TLS disconnect; the next poll reconnects.
                print(f"historian poll retrying: {err}")
                return []
        expected = len(cls.replayed_values)
        poll(read, lambda rows: sum(1 for a, _ in rows if a == cls.lane) >= expected,
             HISTORIAN_TIMEOUT, 3)
        # Once more, so a replayed reading filed under another asset has had time to arrive too.
        time.sleep(HISTORIAN_SETTLE)
        return read()

    # ------------------------------------------------------------------------------------------
    # Stage 5: a device that publishes nothing keeps its stored capture
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _record_the_silent_device(cls):
        """
        The edge node answers the capture's rebirth with its NBIRTH, which a device capture keeps,
        and publishes nothing as the silent device. The job must fail as an empty capture does,
        and the capture stored for that device must stay as it was.
        """
        document = small_capture(cls.gateway["sparkplug_id"], cls.silent["sparkplug_id"], cls.metric,
                                 int(time.time() * 1000))
        status, capture_id, path = store_upload(cls.session, "device", SILENT_DEVICE_ID, document)
        if status != 200:
            raise AssertionError(f"could not store the silent device's capture: {status} {capture_id}")
        cls.silent_capture_id, cls.silent_path = capture_id, path
        cls.silent_stored = download(cls.session, path)[1]

        # Its own edge node: the stage 2 tests read what `cls.edge` published.
        cls.silent_edge = cls._connect_edge_node(cls.password)
        cls.silent_edge.start()
        status, job_id = cls.session.rpc("start_capture_job", {
            "p_subject_kind": "device", "p_subject_id": SILENT_DEVICE_ID,
            "p_note": "silent device", "p_max_seconds": 5, "p_replace": True,
        })
        if status not in (200, 201) or not job_id:
            raise AssertionError(f"start_capture_job refused the silent device: {status} {job_id}")

        def read():
            got, rows = cls.session.rest(f"/capture_jobs?select=*&id=eq.{job_id}&limit=1")
            return rows[0] if got == 200 and rows else {}
        cls.silent_job = poll(read, lambda j: j.get("status") in TERMINAL,
                              CLAIM_TIMEOUT + 5 + FINISH_TIMEOUT, 1)
        cls.silent_edge.stop()

    # ------------------------------------------------------------------------------------------
    # Cleanup, in the order the foreign keys want; also after a stage that broke
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _clean_up(cls):
        for edge in (cls.edge, cls.silent_edge):
            if edge is not None:
                edge.stop()
        session = cls.session
        if session is None:
            return

        def attempt(what, action):
            try:
                action()
            except Exception as err:  # noqa: BLE001 -- cleanup must not mask a real failure
                print(f"cleanup warning: {what}: {err}")

        def delete(path):
            return lambda: session.rest(path, method="DELETE")

        if cls.capture_job_id:
            attempt("stopping the capture", cls._settle_capture)
        if cls.lane:
            attempt("the lane", delete(f"/devices?sparkplug_id=eq.{cls.lane}"))
        if cls.capture_id:
            attempt("the capture row", delete(f"/captures?id=eq.{cls.capture_id}"))
        if cls.storage_path:
            attempt("the stored file", lambda: session.remove(cls.storage_path))
        if cls.silent_capture_id:
            attempt("the silent device's capture row", delete(f"/captures?id=eq.{cls.silent_capture_id}"))
        if cls.silent_path:
            attempt("the silent device's stored file", lambda: session.remove(cls.silent_path))
        attempt("the silent device", delete(f"/devices?id=eq.{SILENT_DEVICE_ID}"))
        # The device explicitly: deleting a gateway leaves its devices unassigned rather than gone.
        # Either delete also removes the capture job rows.
        attempt("the device", delete(f"/devices?id=eq.{SOURCE_DEVICE_ID}"))
        attempt("the gateway", delete(f"/gateways?id=eq.{SOURCE_GATEWAY_ID}"))
        if cls.gateway:
            attempt("the broker account", lambda: cls._delete_account(cls.gateway["sparkplug_id"]))
        attempt("the historian rows", cls._delete_telemetry)
        attempt("the audit rows", cls._delete_audit_rows)

    @classmethod
    def _settle_capture(cls):
        """A job left PENDING or RECORDING blocks every capture on the stack, so it is stopped."""
        status, rows = cls.session.rest(f"/capture_jobs?select=status&id=eq.{cls.capture_job_id}")
        if status == 200 and rows and rows[0]["status"] in ("PENDING", "RECORDING"):
            cls.session.rpc("request_capture_stop", {"p_job_id": cls.capture_job_id})
            cls._capture_job(lambda j: j.get("status") in TERMINAL or not j, FINISH_TIMEOUT)

    @classmethod
    def _delete_account(cls, username):
        result = delete_broker_account(username)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip())

    @classmethod
    def _delete_telemetry(cls):
        conn = historian()
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("DELETE FROM telemetry WHERE metric_name = %s", (cls.metric,))
        conn.close()

    @classmethod
    def _delete_audit_rows(cls):
        ids = [i for i in (SOURCE_GATEWAY_ID, SOURCE_DEVICE_ID, SILENT_DEVICE_ID, cls.lane_id) if i]
        conn = owner_connection()
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("DELETE FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[])", (ids,))
        conn.close()

    # ------------------------------------------------------------------------------------------
    # The recording
    # ------------------------------------------------------------------------------------------
    def test_the_daemon_asked_the_subject_to_rebirth_and_was_answered(self):
        """The capture opens by asking its edge node for a birth, which it cannot query."""
        self._needs("the recording")
        asked = [c for c in self.edge.commands if c[0] >= self.capture_started and c[2]]
        self.assertTrue(
            asked, f"no NCMD carrying 'Node Control/Rebirth' = true reached "
                   f"{self.edge.topic('NCMD')} after the capture started; received: "
                   f"{self.edge.commands}")
        self.assertTrue(self.edge.births_since(self.capture_started),
                        "the edge node published no birth sequence in answer")

    def test_the_job_completed_on_the_stop_and_names_its_capture(self):
        self._needs("the recording")
        job = self.capture_job
        self.assertEqual(job["status"], "COMPLETED", job.get("error"))
        self.assertIsNone(job.get("error"))
        self.assertTrue(job.get("stop_requested"), "the job ended without the stop it was sent")
        self.assertTrue(job.get("capture_id"), "a completed job names no capture")
        self.assertEqual(job["edge_node_id"], self.gateway["sparkplug_id"])
        self.assertEqual(job["device_sparkplug_id"], self.device["sparkplug_id"])

    def test_the_captures_row_is_a_recording_of_the_subject(self):
        self._needs("what was stored")
        row, job = self.capture_row, self.capture_job
        dev = self.device["sparkplug_id"]
        self.assertEqual(row["source"], "recorded")
        self.assertEqual(row["subject_kind"], "device")
        self.assertEqual(row["device_id"], SOURCE_DEVICE_ID)
        self.assertEqual(row["subject_sparkplug_id"], dev)
        self.assertEqual(row["storage_path"], f"{dev}/{job['id']}.json",
                         "a capture is filed under the subject recorded, at its job's own path")
        self.assertEqual(row["note"], self.note)
        self.assertEqual(row["created_by"], self.user_id,
                         "the capture does not name who recorded it")
        self.assertGreater(row["message_count"], 0)
        self.assertEqual(row["message_count"], job["messages"], "the row and the job disagree")
        self.assertEqual(row["size_bytes"], job["bytes"], "the row and the job disagree")

    def test_the_stored_file_is_the_one_the_row_describes(self):
        self._needs("what was stored")
        row, doc, messages = self.capture_row, self.document, self.messages
        gw, dev = self.gateway["sparkplug_id"], self.device["sparkplug_id"]
        self.assertEqual(len(self.stored), row["size_bytes"],
                         "the object in the bucket is not the size the row records")
        self.assertEqual(doc.get("aber_capture_version"), capture_version())
        self.assertEqual(len(messages), row["message_count"])
        self.assertEqual(doc.get("identities"), {"edge_nodes": [gw], "devices": [dev]})
        self.assertEqual(doc.get("capture_epoch_ms"), messages[0]["payload"].get("timestamp"),
                         "the capture's epoch is not its first message's timestamp")
        offsets = [m["offset_ms"] for m in messages]
        self.assertEqual(offsets[0], 0)
        self.assertEqual(offsets, sorted(offsets), "the messages are not in the order received")
        self.assertEqual(doc.get("duration_ms"), offsets[-1])

    def test_the_file_holds_the_birth_the_edge_node_sent_in_answer(self):
        """Without the NBIRTH a replay cannot announce the edge node, and without the DBIRTH the
        lane never comes online."""
        self._needs("what was stored")
        kinds = [msg_type(m) for m in self.messages]
        self.assertIn("NBIRTH", kinds, f"the recording holds no NBIRTH; it holds {kinds}")
        self.assertIn("DBIRTH", kinds, f"the recording holds no DBIRTH; it holds {kinds}")
        self.assertLess(kinds.index("NBIRTH"), kinds.index("DBIRTH"))

        nbirth = self.messages[kinds.index("NBIRTH")]["payload"]
        node_metrics = {m.get("name"): m for m in nbirth.get("metrics", [])}
        self.assertEqual(nbirth.get("seq"), 0, "an NBIRTH carries seq 0")
        self.assertEqual(node_metrics.get("bdSeq", {}).get("long_value"), self.edge.bdseq,
                         "the NBIRTH's bdSeq is not the session's")
        self.assertIs(node_metrics.get("Node Control/Rebirth", {}).get("boolean_value"), False)

        dbirth = self.messages[kinds.index("DBIRTH")]["payload"]
        device_metrics = {m.get("name"): m for m in dbirth.get("metrics", [])}
        self.assertEqual(device_metrics.get("Asset_ID", {}).get("string_value"),
                         self.device["sparkplug_id"])
        self.assertIn(self.metric, device_metrics, "the DBIRTH does not declare the run's metric")

    def test_the_file_holds_every_reading_and_only_the_subjects_traffic(self):
        self._needs("what was stored")
        group, gw = self.gateway["sparkplug_group"], self.gateway["sparkplug_id"]
        dev = self.device["sparkplug_id"]
        allowed = {f"spBv1.0/{group}/{kind}/{gw}" for kind in ("NBIRTH", "NDATA", "NDEATH")} | {
            f"spBv1.0/{group}/{kind}/{gw}/{dev}" for kind in ("DBIRTH", "DDATA", "DDEATH")}
        topics = {m["topic"] for m in self.messages}
        self.assertEqual(topics - allowed, set(),
                         "the recording holds traffic from outside its subject")
        self.assertEqual({m.get("encoding") for m in self.messages}, {"protobuf"},
                         "the edge node published protobuf; the file must say so to replay it "
                         "as such")

        recorded, published = self.recorded_values, self.edge.published
        self.assertTrue(recorded, "the recording holds no DDATA")
        self.assertNotIn(None, recorded, "a recorded DDATA lost the run's metric")
        self.assertIn(recorded[0], published, "the recording holds a reading nobody published")
        start = published.index(recorded[0])
        self.assertEqual(recorded, published[start:start + len(recorded)],
                         "the recording skipped or reordered readings the edge node published")
        self.assertEqual(recorded[-1], published[-1],
                         "the recording ended before the last reading published before the stop")

    def test_the_manifest_describes_the_file(self):
        """ensure_shadow_devices() mints lanes from `device_ids`, and the page shows the rest."""
        self._needs("what was stored")
        manifest, messages = self.capture_row["manifest"], self.messages
        names = []
        for m in messages:
            for metric in m["payload"].get("metrics", []):
                if metric.get("name") and metric["name"] not in names and is_machine_metric(metric["name"]):
                    names.append(metric["name"])
        self.assertEqual(manifest.get("device_ids"), [self.device["sparkplug_id"]])
        self.assertEqual(manifest.get("edge_node_ids"), [self.gateway["sparkplug_id"]])
        self.assertEqual(manifest.get("metric_names"), names)
        self.assertEqual(manifest.get("metric_name_count"), len(names))
        self.assertIn(self.metric, names)
        self.assertIs(manifest.get("birth_captured"), True)
        self.assertIs(manifest.get("rebirth_requested"), True)
        self.assertIs(manifest.get("uses_aliases"), False)
        self.assertEqual(manifest.get("topic_count"), len({m["topic"] for m in messages}))
        # Stopped from the page, well inside the length asked for.
        self.assertEqual(manifest.get("stop_reason"), "operator")
        self.assertEqual(manifest.get("requested_seconds"), CAPTURE_MAX_SECONDS)
        self.assertGreater(manifest.get("duration_ms"), 0)
        self.assertLess(manifest.get("duration_ms"), CAPTURE_MAX_SECONDS * 1000)

    # ------------------------------------------------------------------------------------------
    # The silent device
    # ------------------------------------------------------------------------------------------
    def test_a_device_that_published_nothing_fails_and_keeps_its_stored_capture(self):
        self._needs("the silent device")
        job, silent = self.silent_job, self.silent["sparkplug_id"]
        self.assertEqual(job.get("status"), "FAILED",
                         f"recording a silent device ended {job.get('status')}: {job.get('error')}")
        self.assertIn(f"recorded nothing from device {silent}", job.get("error") or "")
        self.assertIsNone(job.get("capture_id"))
        status, rows = self.session.rest(
            f"/captures?select=id,storage_path&subject_kind=eq.device&device_id=eq.{SILENT_DEVICE_ID}")
        self.assertEqual((status, rows), (200, [{"id": self.silent_capture_id,
                                                 "storage_path": self.silent_path}]),
                         "the stored capture of the silent device was replaced")
        self.assertEqual(download(self.session, self.silent_path)[1], self.silent_stored,
                         "the stored file of the silent device changed")

    # ------------------------------------------------------------------------------------------
    # The replay
    # ------------------------------------------------------------------------------------------
    def test_the_replay_published_every_recorded_message(self):
        self._needs("the replay")
        job = self.playback_job
        self.assertEqual(job["status"], "COMPLETED",
                         f"the playback did not complete: {job.get('error')}")
        self.assertEqual(job["messages_sent"], len(self.replayed))

    def test_the_recorded_readings_reached_the_historian_under_the_lane(self):
        self._needs("the replay")
        lane_values = [v for a, v in self.rows if a == self.lane]
        self.assertEqual(
            lane_values, self.replayed_values,
            f"the lane {self.lane} holds {lane_values}; the capture's DDATA in session carried "
            f"{self.replayed_values}. The job reported {self.playback_job.get('messages_sent')} "
            f"message(s) published, so the broker refused them or the daemon dropped them.")

    def test_no_replayed_reading_was_filed_under_anything_else(self):
        """
        Only the machine itself (live) and its lane (replayed) may carry the run's metric. Each live
        reading is a distinct number, so a replayed copy filed under the machine shows as a repeat.
        """
        self._needs("the replay")
        dev = self.device["sparkplug_id"]
        carriers = {a for a, _ in self.rows}
        self.assertEqual(carriers - {dev, self.lane}, set(),
                         f"{self.metric} was written under assets other than {dev} and its lane")
        machine = [v for a, v in self.rows if a == dev]
        self.assertEqual(len(machine), len(set(machine)),
                         f"{dev} holds a reading twice ({machine}): a replay reached the real "
                         f"machine")
        self.assertLessEqual(set(machine), set(self.edge.published))

    def test_the_replayed_birth_announced_the_lane(self):
        self._needs("the replay")
        status, rows = self.session.rest(
            f"/devices?select=shadow_of,gateway_id,last_birth_metrics"
            f"&sparkplug_id=eq.{self.lane}&limit=1")
        self.assertEqual(status, 200)
        self.assertTrue(rows, f"the lane {self.lane} does not exist")
        self.assertEqual(rows[0]["shadow_of"], SOURCE_DEVICE_ID,
                         "the lane does not name its machine")
        self.assertEqual(rows[0]["gateway_id"], self.playback_gateway["id"])
        self.assertIn(self.metric, rows[0].get("last_birth_metrics") or [],
                      "the replayed DBIRTH did not reach the daemon")


class AStoredCaptureIsNeverOverwritten(unittest.TestCase):
    """
    The upload race the audit saw, against the real bucket: a page that has not caught up uploads
    over a capture stored since. Before 0190 the upload overwrote the stored file and the register
    then refused, leaving the row describing other bytes. The tests run in order, on one subject no
    edge node publishes as.
    """

    @classmethod
    def setUpClass(cls):
        cls.session = Session(sign_in())
        cls.paths = []
        cls.addClassCleanup(cls._clean_up)
        gateway = cls.session.upsert("gateways", {
            "id": UPLOAD_GATEWAY_ID, "name": "CAPTURE_UPLOAD_Race_Gateway", "deployment": "host",
            "description": "Fixture for ingestion/test_recorded_capture_replay.py. Safe to delete.",
        })
        cls.device = cls.session.upsert("devices", {
            "id": UPLOAD_DEVICE_ID, "name": "CAPTURE_UPLOAD_Race_Device", "gateway_id": gateway["id"],
            "description": "Fixture for ingestion/test_recorded_capture_replay.py. Safe to delete.",
        })
        cls.gw, cls.dev = gateway["sparkplug_id"], cls.device["sparkplug_id"]
        epoch = int(time.time() * 1000)
        cls.first = small_capture(cls.gw, cls.dev, "CAPTURE/UPLOAD_RACE", epoch)
        status, cls.first_id, cls.first_path = store_upload(cls.session, "device", UPLOAD_DEVICE_ID,
                                                            cls.first)
        cls.paths.append(cls.first_path)
        if status != 200:
            raise AssertionError(f"could not store the first capture: {status} {cls.first_id}")
        cls.first_bytes = download(cls.session, cls.first_path)[1]

    @classmethod
    def _clean_up(cls):
        session = cls.session
        for action in (
            lambda: session.rest(f"/captures?subject_kind=eq.device&device_id=eq.{UPLOAD_DEVICE_ID}",
                                 method="DELETE"),
            *[lambda p=p: session.remove(p) for p in cls.paths if p],
            lambda: session.rest(f"/devices?id=eq.{UPLOAD_DEVICE_ID}", method="DELETE"),
            lambda: session.rest(f"/gateways?id=eq.{UPLOAD_GATEWAY_ID}", method="DELETE"),
        ):
            try:
                action()
            except Exception as err:  # noqa: BLE001 -- cleanup must not mask a real failure
                print(f"cleanup warning: {err}")
        try:
            conn = owner_connection()
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("DELETE FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[])",
                            ([UPLOAD_GATEWAY_ID, UPLOAD_DEVICE_ID],))
            conn.close()
        except Exception as err:  # noqa: BLE001
            print(f"cleanup warning: the audit rows: {err}")

    def row(self):
        status, rows = self.session.rest(
            f"/captures?select=id,storage_path,size_bytes&subject_kind=eq.device"
            f"&device_id=eq.{UPLOAD_DEVICE_ID}")
        self.assertEqual(status, 200)
        return rows

    def test_1_a_page_that_showed_no_capture_is_refused_before_it_writes(self):
        status, body = self.session.rpc("begin_capture_upload", {
            "p_subject_kind": "device", "p_subject_id": UPLOAD_DEVICE_ID, "p_replace": False})
        self.assertEqual(status, 409, f"a stale page was issued a path: {body}")
        self.assertIn("already exists", str(body))

    def test_2_nobody_writes_the_stored_file_or_a_path_not_issued(self):
        other = small_capture(self.gw, self.dev, "CAPTURE/UPLOAD_RACE_B", int(time.time() * 1000))
        for path in (self.first_path, f"{self.dev}/capture.json", f"{self.dev}/anything.json"):
            with self.subTest(path=path):
                status, _ = self.session.upload(path, other)
                self.assertNotIn(status, (200, 201), f"the bucket took a write to {path}")
        self.assertEqual(download(self.session, self.first_path)[1], self.first_bytes)

    def test_3_a_refused_register_leaves_the_row_and_its_file_agreeing(self):
        stale = small_capture(self.gw, self.dev, "CAPTURE/UPLOAD_RACE_STALE", int(time.time() * 1000))
        status, issued = self.session.rpc("begin_capture_upload", {
            "p_subject_kind": "device", "p_subject_id": UPLOAD_DEVICE_ID, "p_replace": True,
            "p_expected_capture_id": self.first_id})
        self.assertEqual(status, 200, issued)
        stale_path = issued["storage_path"]
        self.paths.append(stale_path)
        self.assertIn(self.session.upload(stale_path, stale)[0], (200, 201))

        # Another operator stores a capture meanwhile, claiming a size no file has.
        newer = small_capture(self.gw, self.dev, "CAPTURE/UPLOAD_RACE_NEWER", int(time.time() * 1000))
        status, newer_id, newer_path = store_upload(self.session, "device", UPLOAD_DEVICE_ID, newer,
                                                    size=10 ** 15)
        self.paths.append(newer_path)
        self.assertEqual(status, 200, newer_id)

        status, body = self.session.rpc("register_uploaded_capture", {
            "p_subject_kind": "device", "p_subject_id": UPLOAD_DEVICE_ID,
            "p_storage_path": stale_path, "p_size_bytes": 1, "p_message_count": 4,
            "p_manifest": {"device_ids": [self.dev]}, "p_replace": True})
        self.assertEqual(status, 409, f"the stale upload was registered: {body}")

        stored = download(self.session, newer_path)[1]
        self.assertEqual(self.row(), [{"id": newer_id, "storage_path": newer_path,
                                       "size_bytes": len(stored)}],
                         "the row does not describe the file it names, or took the browser's size")
        self.assertEqual(json.loads(stored)["messages"][1]["payload"]["metrics"][0]["name"],
                         "CAPTURE/UPLOAD_RACE_NEWER")
        # The refused upload's file and the replaced first file are claimed by nothing; the stored
        # one is claimed, and survives a delete.
        self.assertEqual([o.get("name") for o in self.session.remove(stale_path)], [stale_path])
        self.assertEqual([o.get("name") for o in self.session.remove(self.first_path)], [self.first_path])
        self.assertEqual(self.session.remove(newer_path), [])
        self.assertEqual(download(self.session, newer_path)[0], 200)
        type(self).newer_path = newer_path

    def test_4_a_deleted_subject_releases_its_capture_file(self):
        """A capture is deleted with its subject: the row goes by cascade, and its file is then
        claimed by nothing, so it can be deleted (the ingestion daemon's sweep does it hourly)."""
        newer_path = getattr(type(self), "newer_path", None)
        if not newer_path:
            self.skipTest("test_3 did not store a capture")
        self.session.rest(f"/devices?id=eq.{UPLOAD_DEVICE_ID}", method="DELETE")
        self.assertEqual(self.row(), [])
        self.assertEqual([o.get("name") for o in self.session.remove(newer_path)], [newer_path])


# DDATA of fifty aliased integers that no birth declares: the shape that cost the daemon the most
# memory before 1.5. The daemon drops an undeclared alias, so neither the recording nor the replay
# writes a historian row.
CAP_ALIASES = 50
CAP_RATE = 400                 # messages a second, as the audit published; the cap in about 65 s
CAP_RECORD_TIMEOUT = 300
CAP_SPEED = 4.0
# Each worker's peak since its container started, as a share of its limit.
CAP_MEMORY_SHARE = 0.6


def cgroup_memory(deployment):
    """(memory.peak, memory.max) of the deployment's container, in bytes; the limit is None
    when there is none."""
    result = stack_exec._kubectl("exec", f"deploy/{deployment}", "-c", deployment, "--", "cat",
                                 "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory.max")
    if result.returncode != 0:
        raise AssertionError(f"could not read deploy/{deployment}'s cgroup: {result.stderr.strip()}")
    peak, limit = result.stdout.split()[:2]
    return int(peak), int(limit) if limit.isdigit() else None


class FloodEdgeNode(FixtureEdgeNode):
    """The fixture edge node, publishing CAP_ALIASES undeclared aliases a message at CAP_RATE."""

    def start(self):
        self.sent = 0
        self._birth()
        self._thread = threading.Thread(target=self._run, name=f"flood-{self.node_id}", daemon=True)
        self._thread.start()

    def flood(self):
        self._flood_start = time.monotonic()
        self._data.set()

    def _ddata(self, seq):
        payload = sparkplug_b_pb2.Payload()
        payload.timestamp = self._stamp()
        payload.seq = seq
        for i in range(CAP_ALIASES):
            metric = payload.metrics.add()
            metric.alias = 1000 + i
            metric.int_value = (self.sent * 7 + i) % 100000
        return payload.SerializeToString()

    def _run(self):
        while not self._halt.is_set():
            with self._lock:
                if self._rebirth.is_set():
                    self._rebirth.clear()
                    self._birth()
                elif self._data.is_set():
                    if self._send("DDATA", self.topic("DDATA", self.device_id), self._ddata):
                        self.sent += 1
            ahead = (self._flood_start + self.sent / CAP_RATE - time.monotonic()
                     if self._data.is_set() else 0.02)
            if ahead > 0:
                time.sleep(ahead)


class ACaptureAtTheCapFitsBothWorkers(unittest.TestCase):
    """
    A recording to the 50 MiB size cap and its replay, reading each worker's memory from its
    container's cgroup. Before 1.5 the daemon held a recording as Python objects and OOM-killed
    at the cap, and the playback worker held the parsed file and its plan, about 4.6 times the
    file. Each peak must stay under CAP_MEMORY_SHARE of the container's limit. memory.peak counts
    from the container's start: restart deploy/ingestion and deploy/playback first for a reading of
    this case alone.
    """

    _issue_gateway_credential = RecordedCaptureReplays.__dict__["_issue_gateway_credential"]
    _worker_holds = RecordedCaptureReplays.__dict__["_worker_holds"]
    _ensure_worker_credential = RecordedCaptureReplays.__dict__["_ensure_worker_credential"]

    @classmethod
    def setUpClass(cls):
        cls.session = Session(sign_in())
        cls.edge = cls.capture_job = cls.capture = cls.playback_job = cls.lane = None
        cls.memory = {}
        cls.metric = "CAPTURE/AT_THE_CAP_" + secrets.token_hex(6).upper()
        cls.addClassCleanup(cls._clean_up)
        cls.gateway = cls.session.upsert("gateways", {
            "id": CAP_GATEWAY_ID, "name": "CAPTURE_CAP_Source_Gateway", "deployment": "host",
            "description": "Fixture for ingestion/test_recorded_capture_replay.py. Safe to delete.",
        })
        cls.device = cls.session.upsert("devices", {
            "id": CAP_DEVICE_ID, "name": "CAPTURE_CAP_Source_Device", "gateway_id": cls.gateway["id"],
            "description": "Fixture for ingestion/test_recorded_capture_replay.py. Safe to delete.",
        })
        cls.memory["ingestion before"] = cgroup_memory("ingestion")
        cls._record()
        cls.memory["ingestion"] = cgroup_memory("ingestion")
        cls._replay()
        cls.memory["playback"] = cgroup_memory("playback")
        print("cgroup memory (peak, limit) in MiB: " + ", ".join(
            "%s %.0f of %s" % (name, peak / 2**20, "%.0f" % (limit / 2**20) if limit else "none")
            for name, (peak, limit) in cls.memory.items()))

    @classmethod
    def _record(cls):
        password = cls._issue_gateway_credential()
        deadline = time.monotonic() + BROKER_ACCEPT_TIMEOUT
        while True:
            cls.edge = FloodEdgeNode(cls.gateway["sparkplug_group"], cls.gateway["sparkplug_id"],
                                     cls.device, password, cls.metric)
            if cls.edge.connect(MQTT_HOST, MQTT_PORT) == 0 and cls.edge.subscribed.is_set():
                break
            cls.edge.stop()
            if time.monotonic() >= deadline:
                raise AssertionError("the broker did not accept the memory case's gateway")
            time.sleep(2)
        cls.edge.start()

        def device():
            got, rows = cls.session.rest(
                f"/devices?select=last_birth_metrics&id=eq.{CAP_DEVICE_ID}&limit=1")
            return rows[0] if got == 200 and rows else {}
        poll(device, lambda d: cls.metric in (d.get("last_birth_metrics") or []),
             LIVE_BIRTH_TIMEOUT, 2)

        status, job_id = cls.session.rpc("start_capture_job", {
            "p_subject_kind": "device", "p_subject_id": CAP_DEVICE_ID, "p_max_seconds": 600,
            "p_note": "memory at the size cap", "p_replace": True})
        if status not in (200, 201) or not job_id:
            raise AssertionError(f"start_capture_job refused the memory case: {status} {job_id}")
        cls.capture_job_id = job_id

        def job():
            got, rows = cls.session.rest(f"/capture_jobs?select=*&id=eq.{job_id}&limit=1")
            return rows[0] if got == 200 and rows else {}
        poll(job, lambda j: j.get("status") == "RECORDING", CLAIM_TIMEOUT, 1)
        started = time.monotonic()
        poll(lambda: cls.edge.births_since(started), bool, REBIRTH_TIMEOUT, 0.2)
        cls.edge.flood()
        cls.capture_job = poll(job, lambda j: j.get("status") in TERMINAL, CAP_RECORD_TIMEOUT, 2)
        cls.edge.stop()
        if cls.capture_job.get("capture_id"):
            status, rows = cls.session.rest(
                f"/captures?select=*&id=eq.{cls.capture_job['capture_id']}&limit=1")
            cls.capture = rows[0] if status == 200 and rows else None

    @classmethod
    def _replay(cls):
        if not cls.capture:
            return
        status, rows = cls.session.rest("/gateways?select=id,sparkplug_id&is_shadow=eq.true"
                                        "&is_archived=eq.false&limit=1")
        cls.playback_gateway = rows[0]
        cls._ensure_worker_credential()
        status, mapping = cls.session.rpc("ensure_shadow_devices", {"p_capture_id": cls.capture["id"]})
        if status != 200 or not mapping:
            raise AssertionError(f"could not mint the replay lane: {status} {mapping}")
        cls.lane = mapping.get(cls.device["sparkplug_id"])
        status, job_id = cls.session.rpc("start_playback_job", {
            "p_capture_id": cls.capture["id"], "p_target_gateway_id": cls.playback_gateway["id"],
            "p_device_map": mapping, "p_speed": CAP_SPEED})
        if status not in (200, 201) or not job_id:
            raise AssertionError(f"start_playback_job refused the capture at the cap: {status} {job_id}")

        def read():
            got, rows = cls.session.rest(f"/playback_jobs?select=*&id=eq.{job_id}&limit=1")
            return rows[0] if got == 200 and rows else {}
        cls.playback_job = poll(read, lambda j: j.get("status") in TERMINAL,
                                JOB_TIMEOUT + CAP_RECORD_TIMEOUT / CAP_SPEED, 2)

    @classmethod
    def _clean_up(cls):
        if cls.edge is not None:
            cls.edge.stop()
        session = cls.session

        def attempt(what, action):
            try:
                action()
            except Exception as err:  # noqa: BLE001 -- cleanup must not mask a real failure
                print(f"cleanup warning: {what}: {err}")

        if getattr(cls, "capture_job_id", None):
            attempt("stopping the capture", lambda: session.rpc(
                "request_capture_stop", {"p_job_id": cls.capture_job_id}))
        if cls.lane:
            attempt("the lane", lambda: session.rest(f"/devices?sparkplug_id=eq.{cls.lane}",
                                                     method="DELETE"))
        if cls.capture:
            attempt("the capture row", lambda: session.rest(f"/captures?id=eq.{cls.capture['id']}",
                                                            method="DELETE"))
            attempt("the stored file", lambda: session.remove(cls.capture["storage_path"]))
        attempt("the device", lambda: session.rest(f"/devices?id=eq.{CAP_DEVICE_ID}", method="DELETE"))
        attempt("the gateway", lambda: session.rest(f"/gateways?id=eq.{CAP_GATEWAY_ID}",
                                                    method="DELETE"))
        attempt("the broker account", lambda: delete_broker_account(cls.gateway["sparkplug_id"]))

        def rows():
            conn = historian()
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("DELETE FROM telemetry WHERE metric_name = %s", (cls.metric,))
            conn.close()
            conn = owner_connection()
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("DELETE FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[])",
                            ([CAP_GATEWAY_ID, CAP_DEVICE_ID],))
            conn.close()
        attempt("the historian and audit rows", rows)

    def assert_under_share(self, name):
        peak, limit = self.memory[name]
        if limit is None:
            self.skipTest(f"deploy/{name} has no memory limit to measure against")
        self.assertLess(peak, CAP_MEMORY_SHARE * limit,
                        f"deploy/{name} peaked at {peak / 2**20:.0f} MiB of its {limit / 2**20:.0f} MiB")

    def test_the_recording_stopped_at_the_size_cap_and_was_stored(self):
        job = self.capture_job or {}
        self.assertEqual(job.get("status"), "COMPLETED", job.get("error"))
        self.assertIsNotNone(self.capture, "the job names no stored capture")
        self.assertEqual(self.capture["manifest"].get("stop_reason"), "size_cap")
        cap = job["max_bytes"]
        # The file is the counted bytes and its head and tail.
        self.assertGreaterEqual(self.capture["size_bytes"], cap)
        self.assertLess(self.capture["size_bytes"], cap + 64 * 1024)

    def test_the_daemon_stayed_under_its_share_of_its_limit(self):
        self.assert_under_share("ingestion")

    def test_the_replay_published_every_planned_message(self):
        job = self.playback_job or {}
        self.assertEqual(job.get("status"), "COMPLETED", job.get("error"))
        self.assertGreater(job.get("messages_total") or 0, 0)
        self.assertEqual(job.get("messages_sent"), job.get("messages_total"))

    def test_the_playback_worker_stayed_under_its_share_of_its_limit(self):
        self.assertIn("playback", self.memory, "the replay did not run")
        self.assert_under_share("playback")


if __name__ == "__main__":
    unittest.main(verbosity=2)
