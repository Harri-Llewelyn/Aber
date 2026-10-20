"""
A capture's and a replay's whole life on the stack: the cases the other two capture suites never run.

    python ingestion/test_capture_lifecycle_stack.py

test_playback_replay.py replays an uploaded device capture, and test_recorded_capture_replay.py
records one device and replays it. Neither records a gateway, lets a duration cap end a job, meets
an edge node that ignores the rebirth request, stops a replay partway, or restarts a worker while it
has a job. This suite does each, in order, against one fixture Host gateway with two devices whose
edge node publishes from this process:

  1. a gateway capture holds both devices, and replays into the historian under both lanes;
  2. a device capture left to run is ended by its duration cap, and says so in its manifest;
  3. an edge node that ignores the rebirth request is recorded without a birth certificate, and its
     replay fails saying so, having published nothing;
  4. Stop during a replay ends the job CANCELLED within seconds, with only what went out counted;
  5. the playback worker restarted during a replay: the job fails and the Playback gateway's Will
     marks it OFFLINE;
  6. the ingestion daemon restarted during a recording: the job fails, the stored capture of the
     subject is kept, and the next capture records.

TheBucketAdmitsEachWorkerToItsOwnObject runs the broker-captures policies on the real
storage.objects, as the storage-policies Job applied them: the daemon's arm, the worker's arm, and
a device's folder. The db lane runs the same policy text on a stand-in table.

Stages 5 and 6 restart a Deployment with `kubectl --context $ABER_KUBE_CONTEXT -n $KUBE_NAMESPACE
rollout restart` (k3d-aber and aber by default), and wait for the rollout. They skip, saying why,
when kubectl or that context is absent. Restarting ingestion stops ingestion for the whole stack for
the length of the rollout.

Needs the stack up and `playback.enabled` (values-dev.yaml sets it), and the environment
test_playback_replay.py reads, whose helpers this reuses with test_recorded_capture_replay.py's.
REQUIRE_PLAYBACK_REPLAY=1 makes every other skip a failure.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import traceback
import unittest
from pathlib import Path

import psycopg2
from psycopg2 import errors as pg_errors

INGESTION = Path(__file__).resolve().parent
sys.path.insert(0, str(INGESTION))
sys.path.insert(0, str(INGESTION.parent / "test-harness"))

from test_playback_replay import (  # noqa: E402
    PUBLISHABLE_KEY, SUPABASE_URL, Session, _epoch_seconds, _request, capture_version, historian,
    sign_in, skip_or_fail,
)
from test_recorded_capture_replay import (  # noqa: E402
    MQTT_HOST, MQTT_PORT, TERMINAL, FixtureEdgeNode, delete_broker_account, download, msg_type,
    owner_connection, payloads, poll, reading, store_upload,
)
from test_recorded_capture_replay import setUpModule  # noqa: E402,F401 -- the stack and paho

KUBE_CONTEXT = os.getenv("ABER_KUBE_CONTEXT", "k3d-aber")
KUBE_NAMESPACE = os.getenv("KUBE_NAMESPACE", "aber")

# Pinned, so a run killed before its cleanup leaves rows the next run reclaims. The first hex block
# differs from every other fixture's: `sparkplug_id` is the first 21 hex characters of the uuid.
GATEWAY_ID = "7a000000-0000-4000-8000-000000000001"
DEVICE_A_ID = "7b000000-0000-4000-8000-000000000001"
DEVICE_B_ID = "7c000000-0000-4000-8000-000000000001"

DATA_INTERVAL = 1.0
DATA_AFTER_BIRTH = 3
STOP_GRACE = 2.0
DURATION_CAP = 5
BROKER_ACCEPT_TIMEOUT = 30
LIVE_BIRTH_TIMEOUT = 45
CLAIM_TIMEOUT = 30
REBIRTH_TIMEOUT = 15
FINISH_TIMEOUT = 60
CREDENTIAL_TIMEOUT = 240
WORKER_STALE_SECONDS = 120
JOB_TIMEOUT = 120
HISTORIAN_TIMEOUT = 60
HISTORIAN_SETTLE = 3
GATEWAY_STATUS_TIMEOUT = 90
# A Stop is answered within a second of the worker's next progress report.
STOP_ANSWER_SECONDS = 10
# A restart: the old pod's termination, the new pod's initContainer, then the startup sweep.
RESTART_TIMEOUT = 300

# The long replay: a birth, then one reading a second, so it can be stopped or cut partway. Long
# enough to outlast the playback pod's 30-second termination grace: the worker installs no SIGTERM
# handler, so as PID 1 it publishes on until the kubelet kills it.
LONG_READINGS = 90
# The replay is stopped or cut once it has reported this many messages published.
CUT_AFTER = 4
# Replayed values, far above anything the live edge node counts to in a run.
LONG_BASE = 100000.0

STAGES = ("the fixture", "the gateway capture", "its replay", "the duration cap",
          "the unanswered rebirth", "the stop mid-replay", "the playback worker restart",
          "the ingestion daemon restart")


def replayed(messages):
    """What capture.plan_playback() replays: from an NBIRTH, and a device's data after its DBIRTH."""
    out, node_born, born = [], False, set()
    for message in messages:
        kind = msg_type(message)
        device = message["topic"].split("/")[4] if message["topic"].count("/") >= 4 else None
        if kind == "NBIRTH":
            node_born, born = True, set()
        elif not node_born or (kind in ("DDATA", "DDEATH") and device not in born):
            continue
        elif kind == "DBIRTH":
            born.add(device)
        elif kind == "DDEATH":
            born.discard(device)
        elif kind == "NDEATH":
            node_born, born = False, set()
        out.append(message)
    return out


def long_capture(gateway, device, metric, epoch_ms):
    """A valid capture of one device: NBIRTH, DBIRTH, then LONG_READINGS readings a second apart."""
    def message(offset, kind, segment, metrics):
        topic = "spBv1.0/Aber/%s/%s%s" % (kind, gateway, "/" + segment if segment else "")
        return {"offset_ms": offset, "topic": topic, "encoding": "json",
                "payload": {"timestamp": epoch_ms + offset, "metrics": metrics}}
    value = lambda v, at: [{"name": metric, "datatype": 10, "double_value": v,  # noqa: E731
                            "timestamp": epoch_ms + at}]
    messages = [
        message(0, "NBIRTH", None, [{"name": "bdSeq", "datatype": 8, "long_value": 0}]),
        message(0, "DBIRTH", device, value(0.0, 0)),
    ] + [message(1000 * (i + 1), "DDATA", device, value(LONG_BASE + i, 1000 * (i + 1)))
         for i in range(LONG_READINGS)]
    return {
        "aber_capture_version": capture_version(),
        "capture_epoch_ms": epoch_ms,
        "duration_ms": messages[-1]["offset_ms"],
        "identities": {"edge_nodes": [gateway], "devices": [device]},
        "messages": messages,
    }


# -------------------------------------------------------------------------------------------------
# kubectl, for the two restarts
# -------------------------------------------------------------------------------------------------
def kubectl(*args, timeout=RESTART_TIMEOUT + 30):
    return subprocess.run(["kubectl", "--context", KUBE_CONTEXT, "-n", KUBE_NAMESPACE, *args],
                          capture_output=True, text=True, timeout=timeout)


def why_no_restart():
    """None when this run may restart the workers, or why it may not."""
    if shutil.which("kubectl") is None:
        return "kubectl is not on PATH"
    contexts = subprocess.run(["kubectl", "config", "get-contexts", "-o", "name"],
                              capture_output=True, text=True, timeout=30)
    if KUBE_CONTEXT not in contexts.stdout.split():
        return (f"kubectl has no context {KUBE_CONTEXT!r}; the restart cases run on the k3d dev "
                f"cluster (ABER_KUBE_CONTEXT names another)")
    found = kubectl("get", "deployment", "ingestion", "playback", "-o", "name", timeout=30)
    if found.returncode != 0:
        return (f"cannot read deployment/ingestion and deployment/playback in {KUBE_NAMESPACE} on "
                f"{KUBE_CONTEXT}: {found.stderr.strip()}")
    return None


def restart(deployment):
    result = kubectl("rollout", "restart", f"deployment/{deployment}", timeout=60)
    if result.returncode != 0:
        raise AssertionError(f"kubectl rollout restart deployment/{deployment} failed: "
                             f"{result.stderr.strip()}")


def await_rollout(deployment):
    result = kubectl("rollout", "status", f"deployment/{deployment}", f"--timeout={RESTART_TIMEOUT}s")
    if result.returncode != 0:
        raise AssertionError(f"deployment/{deployment} did not come back within {RESTART_TIMEOUT}s: "
                             f"{result.stderr.strip() or result.stdout.strip()}")


# -------------------------------------------------------------------------------------------------
# The fixture's edge node
# -------------------------------------------------------------------------------------------------
class TwoDeviceEdgeNode(FixtureEdgeNode):
    """
    FixtureEdgeNode with two devices, which can be told to ignore rebirth requests. Each DDATA
    carries the next whole number across both devices, so a reading names the message it came from.
    """

    def __init__(self, group, node_id, devices, password, metric, answer_rebirth=True):
        super().__init__(group, node_id, devices[0], password, metric)
        self.devices = [(d["sparkplug_id"], d["name"]) for d in devices]
        self.answer_rebirth = answer_rebirth
        self.by_device = {device_id: [] for device_id, _ in self.devices}

    def resume(self):
        self._data.set()

    def _birth(self):
        node_stamp = self._stamp()
        self._send("NBIRTH", self.topic("NBIRTH"),
                   lambda seq: payloads.node_birth(node_stamp, seq, self.bdseq))
        for device_id, name in self.devices:
            stamp = self._stamp()
            self._send("DBIRTH", self.topic("DBIRTH", device_id),
                       lambda seq, d=device_id, n=name, s=stamp: payloads.device_birth(
                           d, n, [self.metric], s, seq))
        self.births.append(time.monotonic())

    def _run(self):
        due = time.monotonic() + DATA_INTERVAL
        while not self._halt.is_set():
            with self._lock:
                if self._rebirth.is_set():
                    self._rebirth.clear()
                    if self.answer_rebirth:
                        self._birth()
                elif self._data.is_set() and time.monotonic() >= due:
                    for device_id, _ in self.devices:
                        value = float(len(self.values) + 1)
                        stamp = self._stamp()
                        if self._send("DDATA", self.topic("DDATA", device_id),
                                      lambda seq, s=stamp, v=value: payloads.device_data(
                                          [self.metric], s, [v], seq)):
                            self.values.append((time.monotonic(), value))
                            self.by_device[device_id].append(value)
                    due = time.monotonic() + DATA_INTERVAL
            time.sleep(0.02)


class CaptureLifecycleOnTheStack(unittest.TestCase):
    """
    Eight stages walked in setUpClass, in order. Each test asserts one step; a test whose stage was
    not reached fails naming the stage that broke, and one whose stage was skipped skips with why.
    """

    @classmethod
    def setUpClass(cls):
        cls.reached, cls.skipped, cls.broken = [], {}, None
        cls.session = cls.edge = cls.gateway = None
        cls.devices = {}
        cls.paths = set()
        cls.lanes = {}
        cls.capture_jobs, cls.playback_jobs = [], []
        cls.metric = "CAPTURE/LIFECYCLE_" + secrets.token_hex(8).upper()
        cls.addClassCleanup(cls._clean_up)
        steps = (cls._fixture, cls._gateway_capture, cls._gateway_replay, cls._duration_cap,
                 cls._unanswered_rebirth, cls._stop_mid_replay, cls._playback_restart,
                 cls._ingestion_restart)
        for stage, step in zip(STAGES, steps):
            try:
                step()
            except unittest.SkipTest as skip:
                print(f"{stage} skipped: {skip}")
                cls.skipped[stage] = str(skip)
                continue
            except Exception as err:  # noqa: BLE001 -- every test needing the stage reports it
                traceback.print_exc()
                cls.broken = f"{stage} did not complete: {err}"
                return
            cls.reached.append(stage)

    def _needs(self, stage):
        if stage in self.skipped:
            self.skipTest(f"{stage} was skipped: {self.skipped[stage]}")
        if stage not in self.reached:
            self.fail(self.broken or f"{stage} was not reached")

    # ------------------------------------------------------------------------------------------
    # Shared steps
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _rest_one(cls, path):
        status, rows = cls.session.rest(path)
        return rows[0] if status == 200 and rows else {}

    @classmethod
    def _capture_job(cls, job_id, done, timeout):
        return poll(lambda: cls._rest_one(f"/capture_jobs?select=*&id=eq.{job_id}&limit=1"),
                    done, timeout, 1)

    @classmethod
    def _playback_job(cls, job_id, done, timeout, interval=1):
        return poll(lambda: cls._rest_one(f"/playback_jobs?select=*&id=eq.{job_id}&limit=1"),
                    done, timeout, interval)

    @classmethod
    def _capture_row(cls, capture_id):
        row = cls._rest_one(f"/captures?select=*&id=eq.{capture_id}&limit=1")
        if not row:
            raise AssertionError(f"capture {capture_id} cannot be read")
        cls.paths.add(row["storage_path"])
        return row

    @classmethod
    def _stored_of(cls, device_id):
        status, rows = cls.session.rest(
            f"/captures?select=id,storage_path&subject_kind=eq.device&device_id=eq.{device_id}")
        return rows if status == 200 else None

    @classmethod
    def _connect_edge(cls, answer_rebirth=True):
        deadline = time.monotonic() + BROKER_ACCEPT_TIMEOUT
        while True:
            edge = TwoDeviceEdgeNode(cls.gateway["sparkplug_group"], cls.gateway["sparkplug_id"],
                                     [cls.devices["a"], cls.devices["b"]], cls.password, cls.metric,
                                     answer_rebirth=answer_rebirth)
            try:
                rc = edge.connect(MQTT_HOST, MQTT_PORT)
            except OSError as err:
                edge.stop()
                raise AssertionError(f"cannot reach the broker at {MQTT_HOST}:{MQTT_PORT} ({err})")
            if rc == 0 and edge.subscribed.is_set():
                edge.start()
                return edge
            edge.stop()
            if time.monotonic() >= deadline:
                raise AssertionError(f"the broker did not accept the fixture gateway within "
                                     f"{BROKER_ACCEPT_TIMEOUT}s (CONNACK {rc})")
            time.sleep(2)

    @classmethod
    def _replace_edge(cls, answer_rebirth):
        cls.edge.stop()
        cls.edge = cls._connect_edge(answer_rebirth=answer_rebirth)

    @classmethod
    def _start_capture(cls, kind, subject_id, seconds, note):
        status, job_id = cls.session.rpc("start_capture_job", {
            "p_subject_kind": kind, "p_subject_id": subject_id, "p_note": note,
            "p_max_seconds": seconds, "p_replace": True,
        })
        if status not in (200, 201) or not job_id:
            raise AssertionError(f"start_capture_job refused the {note}: {status} {job_id}")
        cls.capture_jobs.append(job_id)
        job = cls._capture_job(job_id, lambda j: j.get("status") not in (None, "PENDING"),
                               CLAIM_TIMEOUT)
        if job.get("status") != "RECORDING":
            raise AssertionError(f"the {note} is {job.get('status')} after {CLAIM_TIMEOUT}s, not "
                                 f"RECORDING ({job.get('error')})")
        return job_id

    @classmethod
    def _record_until_stopped(cls, kind, subject_id, note):
        """Start, wait for the rebirth's answer and DATA_AFTER_BIRTH rounds, stop; the finished job."""
        started = time.monotonic()
        job_id = cls._start_capture(kind, subject_id, 120, note)
        births = poll(lambda: cls.edge.births_since(started), bool, REBIRTH_TIMEOUT, 0.2)
        if not births:
            raise AssertionError(f"the edge node answered no rebirth request within "
                                 f"{REBIRTH_TIMEOUT}s; NCMDs received: {cls.edge.commands}")
        poll(lambda: cls.edge.values_since(births[0]),
             lambda v: len(v) >= DATA_AFTER_BIRTH * len(cls.edge.devices),
             DATA_AFTER_BIRTH * DATA_INTERVAL + 10, 0.2)
        cls.edge.pause()
        time.sleep(STOP_GRACE)
        status, stopped = cls.session.rpc("request_capture_stop", {"p_job_id": job_id})
        if status != 200 or stopped is not True:
            raise AssertionError(f"request_capture_stop answered {status} {stopped}")
        job = cls._capture_job(job_id, lambda j: j.get("status") in TERMINAL, FINISH_TIMEOUT)
        cls.edge.resume()
        return job

    @classmethod
    def _download_json(cls, path):
        status, raw = download(cls.session, path)
        if status != 200:
            raise AssertionError(f"{path} answered {status}: {raw[:300]!r}")
        return raw, json.loads(raw.decode("utf-8"))

    @classmethod
    def _worker_holds(cls, wanted):
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
        """Issued only when the worker does not already hold a current one."""
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
                                 f"{(body or {}).get('error')} {(body or {}).get('details')}")
        if not poll(lambda: cls._worker_holds(wanted), bool, CREDENTIAL_TIMEOUT, 3):
            raise AssertionError(f"the playback worker did not report holding {wanted}'s current "
                                 f"credential within {CREDENTIAL_TIMEOUT}s")

    @classmethod
    def _lanes_for(cls, capture_id):
        status, mapping = cls.session.rpc("ensure_shadow_devices", {"p_capture_id": capture_id})
        if status != 200 or not mapping:
            raise AssertionError(f"could not mint the replay lanes: {status} {mapping}")
        cls.lanes.update(mapping)
        return mapping

    @classmethod
    def _start_playback(cls, capture_id, mapping):
        status, job_id = cls.session.rpc("start_playback_job", {
            "p_capture_id": capture_id, "p_target_gateway_id": cls.playback_gateway["id"],
            "p_device_map": mapping, "p_speed": 1.0,
        })
        if status not in (200, 201) or not job_id:
            raise AssertionError(f"start_playback_job refused: {status} {job_id}")
        cls.playback_jobs.append(job_id)
        return job_id

    @classmethod
    def _playback_gateway_status(cls):
        return cls._rest_one(f"/gateway_status?select=status,live_status,last_heartbeat"
                             f"&id=eq.{cls.playback_gateway['id']}&limit=1")

    @classmethod
    def _run_long_until(cls, job_id, sent_at_least):
        """Wait until the replay has reported `sent_at_least` published; True when the Playback
        gateway was seen ONLINE meanwhile."""
        online = []

        def read():
            if cls._playback_gateway_status().get("status") == "ONLINE":
                online.append(True)
            return cls._rest_one(f"/playback_jobs?select=*&id=eq.{job_id}&limit=1")
        job = poll(read, lambda j: j.get("status") in TERMINAL
                   or (j.get("status") == "RUNNING" and (j.get("messages_sent") or 0) >= sent_at_least),
                   JOB_TIMEOUT, 0.5)
        if job.get("status") != "RUNNING":
            raise AssertionError(f"the long replay was not running with {sent_at_least} message(s) "
                                 f"published within {JOB_TIMEOUT}s: {job}")
        return bool(online)

    @classmethod
    def _await_playback_gateway(cls, status):
        return poll(cls._playback_gateway_status, lambda r: r.get("status") == status,
                    GATEWAY_STATUS_TIMEOUT, 1)

    @classmethod
    def _historian(cls):
        """Every row carrying the run's metric, as (asset_id, value) in time order."""
        try:
            conn = historian()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT asset_id, val_double FROM telemetry WHERE metric_name = %s "
                                "ORDER BY time", (cls.metric,))
                    return [(a, float(v)) for a, v in cur.fetchall()]
            finally:
                conn.close()
        except psycopg2.Error as err:
            print(f"historian poll retrying: {err}")
            return []

    # ------------------------------------------------------------------------------------------
    # Stage 1: the fixture
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _fixture(cls):
        cls.session = Session(sign_in())
        cls.gateway = cls.session.upsert("gateways", {
            "id": GATEWAY_ID, "name": "CAPTURE_LIFECYCLE_Gateway", "deployment": "host",
            "description": "Fixture for ingestion/test_capture_lifecycle_stack.py. Safe to delete.",
        })
        for key, device_id in (("a", DEVICE_A_ID), ("b", DEVICE_B_ID)):
            cls.devices[key] = cls.session.upsert("devices", {
                "id": device_id, "name": f"CAPTURE_LIFECYCLE_Device_{key.upper()}",
                "gateway_id": GATEWAY_ID,
                "description": "Fixture for ingestion/test_capture_lifecycle_stack.py. Safe to delete.",
            })
            # Under `enforce` the run's metric, which no schema declares, would be dropped.
            if cls.devices[key]["conformance_policy"] != "audit":
                raise AssertionError(f"fixture device {key} is not under audit")
        status, rows = cls.session.rest(
            "/gateways?select=id,name,sparkplug_id&is_shadow=eq.true&is_archived=eq.false&limit=1")
        if status != 200 or not rows:
            raise AssertionError(f"no live Playback gateway ({status})")
        cls.playback_gateway = rows[0]

        status, body = _request(
            f"{SUPABASE_URL}/functions/v1/gateway-credential", method="POST",
            body={"gateway_id": GATEWAY_ID},
            headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {cls.session.token}",
                     "Content-Type": "application/json"},
        )
        if status != 200 or not (body or {}).get("password"):
            raise AssertionError(f"could not issue the fixture gateway's credential: {status} {body}")
        cls.password = body["password"]
        cls.edge = cls._connect_edge()

        def born():
            status, rows = cls.session.rest(
                f"/devices?select=id,last_birth_metrics&id=in.({DEVICE_A_ID},{DEVICE_B_ID})")
            return rows if status == 200 else []
        rows = poll(born, lambda r: len(r) == 2 and all(
            cls.metric in (x.get("last_birth_metrics") or []) for x in r), LIVE_BIRTH_TIMEOUT, 2)
        if not (len(rows) == 2 and all(cls.metric in (x.get("last_birth_metrics") or []) for x in rows)):
            raise AssertionError(f"the daemon did not record both fixture devices' DBIRTH within "
                                 f"{LIVE_BIRTH_TIMEOUT}s: {rows}")

    # ------------------------------------------------------------------------------------------
    # Stage 2 and 3: a gateway capture, and its replay
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _gateway_capture(cls):
        cls.gateway_job = cls._record_until_stopped("gateway", GATEWAY_ID, "gateway capture")
        if cls.gateway_job.get("status") != "COMPLETED":
            raise AssertionError(f"the gateway capture is {cls.gateway_job.get('status')}: "
                                 f"{cls.gateway_job.get('error')}")
        cls.gateway_row = cls._capture_row(cls.gateway_job["capture_id"])
        _, cls.gateway_doc = cls._download_json(cls.gateway_row["storage_path"])

    @classmethod
    def _gateway_replay(cls):
        cls._ensure_worker_credential()
        cls.gateway_map = cls._lanes_for(cls.gateway_row["id"])
        job_id = cls._start_playback(cls.gateway_row["id"], cls.gateway_map)
        timeout = JOB_TIMEOUT + cls.gateway_doc.get("duration_ms", 0) / 1000
        cls.gateway_replay = cls._playback_job(job_id, lambda j: j.get("status") in TERMINAL, timeout, 2)
        if cls.gateway_replay.get("status") not in TERMINAL:
            raise AssertionError(f"the gateway replay did not finish within {timeout:.0f}s: "
                                 f"{cls.gateway_replay}")
        cls.gateway_replayed = replayed(cls.gateway_doc["messages"])
        lanes = set(cls.gateway_map.values())
        expected = sum(1 for m in cls.gateway_replayed if msg_type(m) == "DDATA")
        poll(cls._historian, lambda rows: sum(1 for a, _ in rows if a in lanes) >= expected,
             HISTORIAN_TIMEOUT, 3)
        time.sleep(HISTORIAN_SETTLE)
        cls.gateway_rows = cls._historian()

    # ------------------------------------------------------------------------------------------
    # Stage 4: the duration cap
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _duration_cap(cls):
        job_id = cls._start_capture("device", DEVICE_A_ID, DURATION_CAP, "duration cap")
        cls.cap_job = cls._capture_job(job_id, lambda j: j.get("status") in TERMINAL,
                                       DURATION_CAP + FINISH_TIMEOUT)
        if cls.cap_job.get("status") != "COMPLETED":
            raise AssertionError(f"the capped capture is {cls.cap_job.get('status')}: "
                                 f"{cls.cap_job.get('error')}")
        cls.cap_row = cls._capture_row(cls.cap_job["capture_id"])

    # ------------------------------------------------------------------------------------------
    # Stage 5: an edge node that ignores the rebirth request
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _unanswered_rebirth(cls):
        cls._replace_edge(answer_rebirth=False)
        # Its own births, at connect, are over before the recording starts.
        time.sleep(STOP_GRACE)
        started = time.monotonic()
        job_id = cls._start_capture("device", DEVICE_A_ID, 8, "unanswered rebirth")
        cls.silent_birth_job = cls._capture_job(job_id, lambda j: j.get("status") in TERMINAL,
                                                8 + FINISH_TIMEOUT)
        cls.ignored = [c for c in cls.edge.commands if c[0] >= started and c[2]]
        cls.births_after = cls.edge.births_since(started)
        cls._replace_edge(answer_rebirth=True)
        if cls.silent_birth_job.get("status") != "COMPLETED":
            raise AssertionError(f"the capture without a birth is {cls.silent_birth_job.get('status')}: "
                                 f"{cls.silent_birth_job.get('error')}")
        cls.birthless_row = cls._capture_row(cls.silent_birth_job["capture_id"])
        _, cls.birthless_doc = cls._download_json(cls.birthless_row["storage_path"])

        mapping = cls._lanes_for(cls.birthless_row["id"])
        job_id = cls._start_playback(cls.birthless_row["id"], mapping)
        cls.birthless_replay = cls._playback_job(job_id, lambda j: j.get("status") in TERMINAL,
                                                 JOB_TIMEOUT, 2)

    # ------------------------------------------------------------------------------------------
    # Stage 6: Stop during a replay
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _stop_mid_replay(cls):
        document = long_capture(cls.gateway["sparkplug_id"], cls.devices["b"]["sparkplug_id"],
                                cls.metric, int(time.time() * 1000))
        cls.long_total = len(document["messages"])
        status, capture_id, path = store_upload(cls.session, "device", DEVICE_B_ID, document)
        if path:
            cls.paths.add(path)
        if status != 200:
            raise AssertionError(f"could not store the long capture: {status} {capture_id}")
        cls.long_capture_id = capture_id
        cls.long_map = cls._lanes_for(capture_id)
        cls.lane_b = cls.long_map[cls.devices["b"]["sparkplug_id"]]

        job_id = cls._start_playback(capture_id, cls.long_map)
        cls.stop_seen_online = cls._run_long_until(job_id, CUT_AFTER)
        status, stopped = cls.session.rpc("request_playback_stop", {"p_job_id": job_id})
        asked = time.monotonic()
        if status != 200 or stopped is not True:
            raise AssertionError(f"request_playback_stop answered {status} {stopped}")
        cls.stopped_replay = cls._playback_job(job_id, lambda j: j.get("status") in TERMINAL,
                                               JOB_TIMEOUT, 0.5)
        cls.stop_took = time.monotonic() - asked
        cls.after_stop = cls._await_playback_gateway("OFFLINE")
        time.sleep(HISTORIAN_SETTLE)
        cls.stop_rows = [v for a, v in cls._historian() if a == cls.lane_b and v >= LONG_BASE]

    # ------------------------------------------------------------------------------------------
    # Stage 7 and 8: each worker restarted mid-job
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _playback_restart(cls):
        reason = why_no_restart()
        if reason:
            raise unittest.SkipTest(reason)
        job_id = cls._start_playback(cls.long_capture_id, cls.long_map)
        cls.restart_seen_online = cls._run_long_until(job_id, CUT_AFTER)
        restart("playback")
        cls.restarted_replay = cls._playback_job(job_id, lambda j: j.get("status") in TERMINAL,
                                                 RESTART_TIMEOUT, 2)
        cls.after_restart = cls._await_playback_gateway("OFFLINE")
        await_rollout("playback")
        # The worker back, and holding the Playback gateway, before anything else replays.
        if not poll(lambda: cls._worker_holds(cls.playback_gateway["sparkplug_id"]), bool,
                    CREDENTIAL_TIMEOUT, 3):
            raise AssertionError("the restarted playback worker never reported holding the "
                                 "Playback gateway's credential")

    @classmethod
    def _ingestion_restart(cls):
        reason = why_no_restart()
        if reason:
            raise unittest.SkipTest(reason)
        cls.kept_before = cls._stored_of(DEVICE_A_ID)
        if not cls.kept_before:
            raise AssertionError("device A has no stored capture to keep")
        cls.kept_bytes = download(cls.session, cls.kept_before[0]["storage_path"])[1]
        job_id = cls._start_capture("device", DEVICE_A_ID, 120, "ingestion restart")
        cls._capture_job(job_id, lambda j: (j.get("messages") or 0) >= 2, 30)
        restart("ingestion")
        cls.cut_recording = cls._capture_job(job_id, lambda j: j.get("status") in TERMINAL,
                                             RESTART_TIMEOUT)
        await_rollout("ingestion")
        cls.kept_after = cls._stored_of(DEVICE_A_ID)
        cls.kept_bytes_after = download(cls.session, cls.kept_before[0]["storage_path"])[1]
        # The daemon is consuming again: a capture records.
        job_id = cls._start_capture("device", DEVICE_A_ID, DURATION_CAP, "after the restart")
        cls.next_recording = cls._capture_job(job_id, lambda j: j.get("status") in TERMINAL,
                                              DURATION_CAP + FINISH_TIMEOUT)
        if cls.next_recording.get("capture_id"):
            cls._capture_row(cls.next_recording["capture_id"])

    # ------------------------------------------------------------------------------------------
    # Cleanup, in the order the foreign keys want; also after a stage that broke
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _clean_up(cls):
        if cls.edge is not None:
            cls.edge.stop()
        session = cls.session
        if session is None:
            return

        def attempt(what, action):
            try:
                action()
            except Exception as err:  # noqa: BLE001 -- cleanup must not mask a real failure
                print(f"cleanup warning: {what}: {err}")

        def settle():
            """A job left in flight blocks every capture, or every playback, on the stack."""
            for job_id in cls.capture_jobs:
                row = cls._rest_one(f"/capture_jobs?select=status&id=eq.{job_id}")
                if row.get("status") in ("PENDING", "RECORDING"):
                    session.rpc("request_capture_stop", {"p_job_id": job_id})
                    cls._capture_job(job_id, lambda j: j.get("status") in TERMINAL or not j,
                                     FINISH_TIMEOUT)
            for job_id in cls.playback_jobs:
                row = cls._rest_one(f"/playback_jobs?select=status&id=eq.{job_id}")
                if row.get("status") in ("PENDING", "RUNNING"):
                    session.rpc("request_playback_stop", {"p_job_id": job_id})
                    cls._playback_job(job_id, lambda j: j.get("status") in TERMINAL or not j,
                                      JOB_TIMEOUT)

        attempt("settling jobs", settle)
        lanes = sorted(set(cls.lanes.values()))
        lane_ids, capture_ids = [], []

        def read_ids():
            if lanes:
                status, rows = session.rest(f"/devices?select=id&sparkplug_id=in.({','.join(lanes)})")
                lane_ids.extend(r["id"] for r in (rows or []) if status == 200)
            status, rows = session.rest(f"/captures?select=id&or=(gateway_id.eq.{GATEWAY_ID},"
                                        f"device_id.in.({DEVICE_A_ID},{DEVICE_B_ID}))")
            capture_ids.extend(r["id"] for r in (rows or []) if status == 200)
        attempt("reading the lanes and captures", read_ids)
        for lane in lanes:
            attempt(f"the lane {lane}", lambda lane=lane: session.rest(
                f"/devices?sparkplug_id=eq.{lane}", method="DELETE"))
        attempt("the captures", lambda: session.rest(
            f"/captures?or=(gateway_id.eq.{GATEWAY_ID},device_id.in.({DEVICE_A_ID},{DEVICE_B_ID}))",
            method="DELETE"))
        for path in sorted(cls.paths):
            attempt(f"the stored file {path}", lambda path=path: session.remove(path))
        for device_id in (DEVICE_A_ID, DEVICE_B_ID):
            attempt(f"the device {device_id}", lambda d=device_id: session.rest(
                f"/devices?id=eq.{d}", method="DELETE"))
        attempt("the gateway", lambda: session.rest(f"/gateways?id=eq.{GATEWAY_ID}", method="DELETE"))
        if cls.gateway:
            def account():
                result = delete_broker_account(cls.gateway["sparkplug_id"])
                if result.returncode != 0:
                    raise RuntimeError(result.stderr.strip() or result.stdout.strip())
            attempt("the broker account", account)

        def telemetry():
            conn = historian()
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("DELETE FROM telemetry WHERE metric_name = %s", (cls.metric,))
            conn.close()
        attempt("the historian rows", telemetry)

        def audit():
            conn = owner_connection()
            conn.autocommit = True
            with conn.cursor() as cur:
                # The fixtures', and any row a capture or playback action wrote about its own.
                cur.execute("DELETE FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[])",
                            ([GATEWAY_ID, DEVICE_A_ID, DEVICE_B_ID, *lane_ids, *capture_ids,
                              *cls.capture_jobs, *cls.playback_jobs],))
            conn.close()
        attempt("the audit rows", audit)

    # ==========================================================================================
    # 1. A gateway capture and its replay
    # ==========================================================================================
    def test_a_gateway_capture_holds_both_devices_and_only_its_edge_node(self):
        self._needs("the gateway capture")
        gw = self.gateway["sparkplug_id"]
        a, b = self.devices["a"]["sparkplug_id"], self.devices["b"]["sparkplug_id"]
        row, job = self.gateway_row, self.gateway_job
        self.assertEqual((row["subject_kind"], row["gateway_id"], row["device_id"]),
                         ("gateway", GATEWAY_ID, None))
        self.assertEqual(row["storage_path"], f"{gw}/{job['id']}.json")
        self.assertEqual(sorted(row["manifest"].get("device_ids") or []), sorted([a, b]))
        self.assertEqual(row["manifest"].get("edge_node_ids"), [gw])
        topics = {m["topic"].split("/")[3] for m in self.gateway_doc["messages"]}
        self.assertEqual(topics, {gw}, "the capture holds another edge node's traffic")
        kinds = {(msg_type(m), m["topic"].split("/")[4] if m["topic"].count("/") >= 4 else None)
                 for m in self.gateway_doc["messages"]}
        for expected in (("NBIRTH", None), ("DBIRTH", a), ("DBIRTH", b), ("DDATA", a), ("DDATA", b)):
            self.assertIn(expected, kinds, f"the gateway capture holds no {expected}")

    def test_the_gateway_replay_lands_each_device_under_its_own_lane(self):
        self._needs("its replay")
        job = self.gateway_replay
        self.assertEqual(job["status"], "COMPLETED", job.get("error"))
        self.assertEqual(job["messages_sent"], len(self.gateway_replayed))
        for key in ("a", "b"):
            device = self.devices[key]["sparkplug_id"]
            lane = self.gateway_map[device]
            with self.subTest(device=key):
                expected = [reading(m, self.metric) for m in self.gateway_replayed
                            if msg_type(m) == "DDATA" and m["topic"].endswith("/" + device)]
                self.assertTrue(expected, "the capture holds no reading of this device in session")
                self.assertEqual([v for a, v in self.gateway_rows if a == lane], expected)

    def test_the_gateway_replay_wrote_into_no_real_machine(self):
        self._needs("its replay")
        devices = {d["sparkplug_id"] for d in self.devices.values()}
        lanes = set(self.gateway_map.values())
        carriers = {a for a, _ in self.gateway_rows}
        self.assertEqual(carriers - devices - lanes, set())
        for device in devices:
            live = [v for a, v in self.gateway_rows if a == device]
            self.assertEqual(len(live), len(set(live)),
                             f"{device} holds a reading twice: a replay reached the real machine")

    # ==========================================================================================
    # 2. The duration cap
    # ==========================================================================================
    def test_the_duration_cap_ends_the_job_and_the_manifest_says_so(self):
        self._needs("the duration cap")
        job, manifest = self.cap_job, self.cap_row["manifest"]
        self.assertFalse(job.get("stop_requested"), "nobody pressed Stop; the cap ended it")
        self.assertEqual(manifest.get("stop_reason"), "duration")
        self.assertEqual(manifest.get("requested_seconds"), DURATION_CAP)
        self.assertGreaterEqual(manifest.get("duration_ms"), DURATION_CAP * 1000)
        self.assertLess(manifest.get("duration_ms"), (DURATION_CAP + 4) * 1000,
                        "the cap let the recording run on")
        self.assertEqual(manifest.get("device_ids"), [self.devices["a"]["sparkplug_id"]])

    # ==========================================================================================
    # 3. An unanswered rebirth
    # ==========================================================================================
    def test_the_capture_asked_for_a_birth_and_recorded_none(self):
        self._needs("the unanswered rebirth")
        self.assertTrue(self.ignored, "the daemon never asked the edge node to rebirth")
        self.assertEqual(self.births_after, [], "the edge node answered after all")
        manifest = self.birthless_row["manifest"]
        self.assertIs(manifest.get("birth_captured"), False)
        self.assertIs(manifest.get("rebirth_requested"), True)
        kinds = {msg_type(m) for m in self.birthless_doc["messages"]}
        self.assertEqual(kinds, {"DDATA"}, f"the capture holds {kinds}")

    def test_its_replay_is_refused_for_want_of_a_birth_and_publishes_nothing(self):
        """A replay is a Sparkplug session, so a capture without an NBIRTH cannot be one."""
        self._needs("the unanswered rebirth")
        job = self.birthless_replay
        self.assertEqual(job.get("status"), "FAILED", job)
        self.assertIn("NBIRTH", job.get("error") or "")
        self.assertEqual(job.get("messages_sent"), 0)

    # ==========================================================================================
    # 4. Stop during a replay
    # ==========================================================================================
    def test_stop_ends_a_replay_cancelled_within_seconds(self):
        self._needs("the stop mid-replay")
        job = self.stopped_replay
        self.assertEqual(job.get("status"), "CANCELLED", f"{job.get('status')}: {job.get('error')}")
        self.assertLess(self.stop_took, STOP_ANSWER_SECONDS,
                        f"the replay ran {self.stop_took:.1f}s past its Stop")
        self.assertGreaterEqual(job["messages_sent"], CUT_AFTER)
        self.assertLess(job["messages_sent"], self.long_total, "every message was counted")

    def test_a_stopped_replay_wrote_no_more_than_it_counted_and_ended_its_session(self):
        self._needs("the stop mid-replay")
        births = self.long_total - LONG_READINGS
        self.assertLessEqual(len(self.stop_rows), self.stopped_replay["messages_sent"] - births)
        self.assertTrue(self.stop_seen_online, "the Playback gateway never read ONLINE during the replay")
        self.assertEqual(self.after_stop.get("status"), "OFFLINE",
                         f"the Playback gateway reads {self.after_stop} after the stop: no NDEATH")

    # ==========================================================================================
    # 5. The playback worker restarted mid-replay
    # ==========================================================================================
    def test_a_replay_cut_by_a_worker_restart_fails_saying_how_far_it_got(self):
        self._needs("the playback worker restart")
        job = self.restarted_replay
        self.assertEqual(job.get("status"), "FAILED", f"{job.get('status')}: {job.get('error')}")
        self.assertIn("playback worker", job.get("error") or "")
        self.assertGreaterEqual(job["messages_sent"], CUT_AFTER)
        self.assertLess(job["messages_sent"], self.long_total)

    def test_the_will_marks_the_playback_gateway_offline(self):
        self._needs("the playback worker restart")
        self.assertTrue(self.restart_seen_online, "the Playback gateway never read ONLINE")
        self.assertEqual(self.after_restart.get("status"), "OFFLINE",
                         f"the Playback gateway reads {self.after_restart} after its worker died")

    # ==========================================================================================
    # 6. The ingestion daemon restarted mid-recording
    # ==========================================================================================
    def test_a_recording_cut_by_a_daemon_restart_fails_and_keeps_the_stored_capture(self):
        self._needs("the ingestion daemon restart")
        job = self.cut_recording
        self.assertEqual(job.get("status"), "FAILED", f"{job.get('status')}: {job.get('error')}")
        self.assertIn("ingestion daemon", job.get("error") or "")
        self.assertIsNone(job.get("capture_id"))
        self.assertEqual(self.kept_after, self.kept_before, "the stored capture was replaced")
        self.assertEqual(self.kept_bytes_after, self.kept_bytes, "the stored file changed")

    def test_the_restarted_daemon_records_the_next_capture(self):
        self._needs("the ingestion daemon restart")
        job = self.next_recording
        self.assertEqual(job.get("status"), "COMPLETED", f"{job.get('status')}: {job.get('error')}")
        self.assertGreater(job.get("messages") or 0, 0)


# -------------------------------------------------------------------------------------------------
# The bucket's policies on the real table
# -------------------------------------------------------------------------------------------------
INGESTION_PRINCIPAL = "b0000000-0000-4000-8000-000000000002"
PLAYBACK_PRINCIPAL = "b0000000-0000-4000-8000-000000000003"
PLAYBACK_GATEWAY_ID = "16000000-0000-4000-8000-000000000001"
BUCKET_ADMIN = "00000000-0000-4000-8000-0000000b9280"


class TheBucketAdmitsEachWorkerToItsOwnObject(unittest.TestCase):
    """
    One transaction as the database owner, rolled back: a device recording, a stored capture being
    replayed, a file nothing claims, and each caller's reach into storage.objects. Deleting needs
    `storage.allow_delete_query`, the switch storage-api sets: without it a trigger refuses every
    direct delete before row-level security is asked.
    """

    @classmethod
    def setUpClass(cls):
        try:
            conn = owner_connection()
        except psycopg2.Error as err:
            skip_or_fail(f"cannot reach the Supabase database as its owner: {err}")
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regclass('storage.objects');")
            if not cur.fetchone()[0]:
                skip_or_fail("storage.objects does not exist: storage-api has not started")
            cur.execute("SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND "
                        "tablename = 'objects' AND policyname LIKE 'broker_captures_%';")
            if cur.fetchone()[0] != 4:
                raise AssertionError("the four broker_captures_* policies are not on storage.objects: "
                                     "the storage-policies Job did not apply them")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = owner_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = cur = self.conn.cursor()
        # Nothing else in flight, for the length of this transaction: one capture per stack and one
        # playback per target.
        cur.execute("UPDATE public.capture_jobs SET status = 'FAILED', finished_at = now() "
                    "WHERE status IN ('PENDING', 'RECORDING');")
        cur.execute("UPDATE public.playback_jobs SET status = 'FAILED', finished_at = now() "
                    "WHERE status IN ('PENDING', 'RUNNING') AND target_gateway_id = %s;",
                    (PLAYBACK_GATEWAY_ID,))
        cur.execute("INSERT INTO auth.users (id, email) VALUES (%s, 'bucket-admin@test.local') "
                    "ON CONFLICT (id) DO NOTHING;", (BUCKET_ADMIN,))
        cur.execute("INSERT INTO public.user_roles (user_id, role_id) SELECT %s, id FROM public.roles "
                    "WHERE name = 'Administrator' ON CONFLICT DO NOTHING;", (BUCKET_ADMIN,))
        cur.execute("INSERT INTO public.gateways (name, deployment) VALUES "
                    "('CAPTURE_LIFECYCLE_Bucket_Gateway', 'remote') RETURNING id, sparkplug_id;")
        self.gw, self.gw_wire = cur.fetchone()
        cur.execute("INSERT INTO public.devices (name, gateway_id) VALUES "
                    "('CAPTURE_LIFECYCLE_Bucket_Device', %s) RETURNING id, sparkplug_id;", (self.gw,))
        self.dev, self.dev_wire = cur.fetchone()

        # A recording of the device, at its job's own path.
        self.recording = f"{self.dev_wire}/recording.json"
        cur.execute(
            "INSERT INTO public.capture_jobs (subject_kind, gateway_id, device_id, sparkplug_group, "
            "edge_node_id, device_sparkplug_id, subject_sparkplug_id, storage_path, status, started_at) "
            "VALUES ('device', %s, %s, 'Aber', %s, %s, %s, %s, 'RECORDING', now());",
            (self.gw, self.dev, self.gw_wire, self.dev_wire, self.dev_wire, self.recording))
        self._put("ingestion", self.recording)

        # A stored capture of the gateway, being replayed.
        self.replaying = f"{self.gw_wire}/stored.json"
        self._issue(self.replaying)
        self._put("Administrator", self.replaying)
        cur.execute(
            "INSERT INTO public.captures (subject_kind, gateway_id, subject_sparkplug_id, storage_path, "
            "size_bytes, message_count) VALUES ('gateway', %s, %s, %s, 1, 1) RETURNING id;",
            (self.gw, self.gw_wire, self.replaying))
        capture_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO public.playback_jobs (capture_id, capture_storage_path, target_gateway_id, "
            "target_edge_node_id, sparkplug_group, status, started_at) "
            "SELECT %s, %s, id, sparkplug_id, 'Aber', 'RUNNING', now() FROM public.gateways "
            "WHERE id = %s;", (capture_id, self.replaying, PLAYBACK_GATEWAY_ID))

        # A file nothing claims: its upload was begun three hours ago and never registered.
        self.orphan = f"{self.dev_wire}/orphan.json"
        self._issue(self.orphan)
        self._put("Administrator", self.orphan)
        cur.execute("UPDATE public.capture_uploads SET created_at = now() - interval '3 hours' "
                    "WHERE storage_path = %s;", (self.orphan,))

    # -- fixtures and callers -------------------------------------------------------------------
    def _issue(self, path):
        """An upload begun by BUCKET_ADMIN for `path`, as begin_capture_upload() records one."""
        folder = path.split("/")[0]
        kind, device = ("device", self.dev) if folder == self.dev_wire else ("gateway", None)
        self.cur.execute(
            "INSERT INTO public.capture_uploads (subject_kind, gateway_id, device_id, "
            "subject_sparkplug_id, storage_path, created_by) VALUES (%s, %s, %s, %s, %s, %s);",
            (kind, self.gw, device, folder, path, BUCKET_ADMIN))

    def _run(self, caller, sql, args=(), keep=False):
        """One statement as `caller`, in a savepoint: rolled back unless `keep`; a refusal raises."""
        sub = {"ingestion": INGESTION_PRINCIPAL, "playback": PLAYBACK_PRINCIPAL,
               "Administrator": BUCKET_ADMIN}[caller]
        self.cur.execute("SAVEPOINT call;")
        try:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             ('{"sub": "%s", "role": "authenticated"}' % sub,))
            self.cur.execute("SET LOCAL storage.allow_delete_query = 'true';")
            self.cur.execute(sql, args)
            result = self.cur.rowcount
        except Exception:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT call;" if keep else "ROLLBACK TO SAVEPOINT call;")
        return result

    def _put(self, caller, path):
        self._run(caller, "INSERT INTO storage.objects (bucket_id, name) "
                          "VALUES ('broker-captures', %s);", (path,), keep=True)

    def _sees(self, caller, path):
        return self._run(caller, "SELECT 1 FROM storage.objects WHERE bucket_id = 'broker-captures' "
                                 "AND name = %s;", (path,)) == 1

    def _writes(self, caller, path):
        try:
            self._run(caller, "INSERT INTO storage.objects (bucket_id, name) "
                              "VALUES ('broker-captures', %s);", (path,))
            return True
        except pg_errors.InsufficientPrivilege:
            return False

    def _updates(self, caller, path):
        try:
            return self._run(caller, "UPDATE storage.objects SET metadata = '{}'::jsonb "
                                     "WHERE bucket_id = 'broker-captures' AND name = %s;", (path,)) == 1
        except pg_errors.InsufficientPrivilege:
            return False

    def _deletes(self, caller, path):
        return self._run(caller, "DELETE FROM storage.objects WHERE bucket_id = 'broker-captures' "
                                 "AND name = %s;", (path,)) == 1

    # -- the arms -------------------------------------------------------------------------------
    def test_the_daemon_reaches_its_recording_and_what_nothing_claims(self):
        self.assertEqual(
            {"sees recording": self._sees("ingestion", self.recording),
             "sees orphan": self._sees("ingestion", self.orphan),
             "sees replaying": self._sees("ingestion", self.replaying),
             "overwrites recording": self._updates("ingestion", self.recording),
             "writes elsewhere": self._writes("ingestion", f"{self.dev_wire}/elsewhere.json"),
             "overwrites replaying": self._updates("ingestion", self.replaying),
             "deletes orphan": self._deletes("ingestion", self.orphan),
             "deletes replaying": self._deletes("ingestion", self.replaying)},
            {"sees recording": True, "sees orphan": True, "sees replaying": False,
             "overwrites recording": True, "writes elsewhere": False, "overwrites replaying": False,
             "deletes orphan": True, "deletes replaying": False})

    def test_the_worker_reads_the_capture_it_replays_and_nothing_else(self):
        self.assertEqual(
            {"sees replaying": self._sees("playback", self.replaying),
             "sees recording": self._sees("playback", self.recording),
             "sees orphan": self._sees("playback", self.orphan),
             "overwrites replaying": self._updates("playback", self.replaying),
             "writes": self._writes("playback", f"{self.gw_wire}/worker.json"),
             "deletes orphan": self._deletes("playback", self.orphan)},
            {"sees replaying": True, "sees recording": False, "sees orphan": False,
             "overwrites replaying": False, "writes": False, "deletes orphan": False})

    def test_the_worker_loses_the_capture_when_its_replay_ends(self):
        self.cur.execute("UPDATE public.playback_jobs SET status = 'COMPLETED', finished_at = now() "
                         "WHERE capture_storage_path = %s;", (self.replaying,))
        self.assertFalse(self._sees("playback", self.replaying))

    def test_a_device_folder_admits_only_a_path_issued_for_it(self):
        issued = f"{self.dev_wire}/issued.json"
        self._issue(issued)
        self.assertTrue(self._writes("Administrator", issued))
        self.assertFalse(self._writes("Administrator", f"{self.dev_wire}/not-issued.json"))
        nobody = "dev" + "f" * 21
        self.assertFalse(self._writes("Administrator", f"{nobody}/capture.json"),
                         "a folder naming no device took a write")


if __name__ == "__main__":
    unittest.main(verbosity=2)
