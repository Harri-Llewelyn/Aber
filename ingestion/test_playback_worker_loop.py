"""
The playback worker as a Sparkplug edge node, and what it reports about a job.

    python ingestion/test_playback_worker_loop.py

Against a fake broker and a fake PostgREST, with no network. What this suite holds:

  * A MESSAGE COUNTS ONLY WHEN PAHO ACCEPTED IT on a connection that has not dropped. A refused
    publish or a dropped connection fails the job with how many messages went out.
"""
import json
import os
import sys
import unittest
from types import SimpleNamespace

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import capture  # noqa: E402
import paho.mqtt.client as mqtt  # noqa: E402
import playback_worker  # noqa: E402
import sparkplug_b_pb2  # noqa: E402

GROUP = "Aber"
GW = "gwy160000000000400080000"
CAPTURED_GW = "gwy990000000000400080000"
CAPTURED_DEV = "dev880000000000400080000"
LANE = "dev770000000000400080000"
EPOCH = 1_700_000_000_000
JOB_ID = "00000000-0000-4000-8000-0000000000cc"


def recorded(offset_ms, msg_type, device=None, value=None, encoding="protobuf"):
    """One capture-file message from the recorded node."""
    topic = "spBv1.0/%s/%s/%s" % (GROUP, msg_type, CAPTURED_GW)
    if device:
        topic += "/" + device
    stamp = EPOCH + offset_ms
    metrics = []
    if msg_type in ("NBIRTH", "NDEATH"):
        metrics.append({"name": "bdSeq", "datatype": 4, "long_value": 9, "timestamp": stamp})
    if msg_type == "NBIRTH":
        metrics.append({"name": "Node Control/Rebirth", "datatype": 11, "boolean_value": False,
                        "timestamp": stamp})
    if value is not None:
        metrics.append({"name": "Temperature", "datatype": 10, "double_value": value,
                        "timestamp": stamp})
    payload = {"timestamp": stamp, "metrics": metrics}
    if msg_type != "NDEATH":
        payload["seq"] = 0
    return {"offset_ms": offset_ms, "topic": topic, "encoding": encoding, "payload": payload}


def a_session(readings=3, gap_ms=10, encoding="protobuf"):
    """An NBIRTH, one device's DBIRTH, then `readings` DDATA `gap_ms` apart."""
    messages = [recorded(0, "NBIRTH", encoding=encoding),
                recorded(gap_ms, "DBIRTH", device=CAPTURED_DEV, value=0.0, encoding=encoding)]
    for i in range(readings):
        messages.append(recorded(gap_ms * (i + 2), "DDATA", device=CAPTURED_DEV,
                                 value=float(i + 1), encoding=encoding))
    return messages


def capture_file(messages):
    return {
        "aber_capture_version": capture.CAPTURE_VERSION,
        "recorded_at": "2026-10-19T00:00:00+00:00",
        "capture_epoch_ms": EPOCH,
        "duration_ms": messages[-1]["offset_ms"],
        "identities": {"edge_nodes": [CAPTURED_GW], "devices": [CAPTURED_DEV]},
        "messages": messages,
    }


def msg_type_of(topic):
    return topic.split("/")[2]


def decode(raw):
    out = sparkplug_b_pb2.Payload()
    out.ParseFromString(raw)
    return out


# -------------------------------------------------------------------------------------------------
# Fakes
# -------------------------------------------------------------------------------------------------
class FakeInfo:
    def __init__(self, rc=0, acked=True):
        self.rc = rc
        self.acked = acked

    def wait_for_publish(self, timeout=None):
        if self.rc:
            raise RuntimeError(mqtt.error_string(self.rc))

    def is_published(self):
        return self.acked and not self.rc


class FakeSocket:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakeBroker:
    """
    The broker's side, shared by every client a test makes. `after_publish(client, n)` runs after
    the n-th accepted publish of planned traffic and may drop the connection or deliver a message.
    """

    def __init__(self):
        self.clients = []
        self.after_publish = None
        self.refuse_publish_from = None   # the 1-based publish from which paho answers NO_CONN


class FakeClient:
    broker = None

    def __init__(self, client_id=None, **_kwargs):
        self.client_id = client_id
        self.events = []
        self.will = None
        self.password = None
        self.connected = False
        self.sock = FakeSocket()
        self.on_connect = self.on_disconnect = self.on_subscribe = self.on_message = None
        self.publishes = 0
        FakeClient.broker.clients.append(self)

    # -- what the worker calls --------------------------------------------------------------------
    def username_pw_set(self, username, password):
        self.username, self.password = username, password

    def will_set(self, topic, payload, qos=0, retain=False):
        self.will = (topic, payload, qos, retain)

    def tls_set(self, **_kwargs):
        pass

    def connect(self, host, port, keepalive):
        self.events.append("connect")
        self.connected = True
        self.on_connect(self, None, {}, 0)

    def loop_start(self):
        self.events.append("loop_start")

    def loop_stop(self):
        self.events.append("loop_stop")

    def publish(self, topic, payload, qos=0, retain=False):
        planned = msg_type_of(topic) != "NDEATH"
        if not self.connected:
            return FakeInfo(rc=mqtt.MQTT_ERR_NO_CONN)
        if planned:
            self.publishes += 1
            limit = FakeClient.broker.refuse_publish_from
            if limit is not None and self.publishes >= limit:
                return FakeInfo(rc=mqtt.MQTT_ERR_NO_CONN)
        self.events.append(("publish", topic, payload, qos, retain))
        if planned and FakeClient.broker.after_publish:
            FakeClient.broker.after_publish(self, self.publishes)
        return FakeInfo()

    def disconnect(self):
        self.events.append("disconnect")
        self.connected = False

    def socket(self):
        return self.sock

    # -- what a test does to it -------------------------------------------------------------------
    def drop(self, rc=mqtt.MQTT_ERR_CONN_LOST):
        """The broker closes the connection, as Dynamic Security does when the password changes."""
        self.connected = False
        self.on_disconnect(self, None, rc)

    def published(self):
        return [e for e in self.events if isinstance(e, tuple) and e[0] == "publish"]

    def published_types(self):
        return [msg_type_of(e[1]) for e in self.published()]


class FakeStorage:
    def __init__(self, document):
        self.body = json.dumps(document).encode("utf-8")

    def from_(self, _bucket):
        return self

    def download(self, _path):
        return self.body


class FakeSupabase:
    """Records every RPC; `answers` maps a function name to a callable(params) -> data."""

    def __init__(self, **answers):
        self.calls = []
        self.answers = answers

    def rpc(self, name, params):
        def execute():
            self.calls.append((name, dict(params)))
            answer = self.answers.get(name)
            return SimpleNamespace(data=answer(params) if answer else None)
        return SimpleNamespace(execute=execute)

    def called(self, name):
        return [p for n, p in self.calls if n == name]


class WorkerLoopCase(unittest.TestCase):
    def setUp(self):
        self._saved = (playback_worker.mqtt.Client, playback_worker.PROGRESS_INTERVAL_SECONDS)
        FakeClient.broker = self.broker = FakeBroker()
        playback_worker.mqtt.Client = FakeClient
        playback_worker._next_bdseq.clear()

    def tearDown(self):
        playback_worker.mqtt.Client, playback_worker.PROGRESS_INTERVAL_SECONDS = self._saved
        playback_worker._next_bdseq.clear()

    def job(self, **overrides):
        job = {"id": JOB_ID, "target_edge_node_id": GW,
               "capture_storage_path": "dev880000000000400080000/capture.json",
               "device_map": {CAPTURED_DEV: LANE}, "speed": 1000.0, "sparkplug_group": GROUP}
        job.update(overrides)
        return job

    def run_job(self, messages, supabase=None, credentials=None, **job):
        self.supabase = supabase or FakeSupabase()
        return playback_worker._run_job(self.supabase, FakeStorage(capture_file(messages)),
                                        credentials or {GW: "a-password"}, self.job(**job))

    def assert_death_attempted(self, client):
        deaths = [e for e in client.published() if msg_type_of(e[1]) == "NDEATH" and e[3] == 1]
        self.assertTrue(deaths or client.sock.closed, "the session was neither ended nor left to the Will")


# -------------------------------------------------------------------------------------------------
# Counting only what paho accepted
# -------------------------------------------------------------------------------------------------
class PublishAccountingTests(WorkerLoopCase):
    def test_a_refused_publish_fails_the_job_with_the_count_reached(self):
        """paho answers MQTT_ERR_NO_CONN from the fourth message: three went out."""
        self.broker.refuse_publish_from = 4
        sent, _, error = self.run_job(a_session(readings=4))
        self.assertEqual(sent, 3)
        self.assertIn("publishing stopped after 3 message(s): the broker connection was lost", error)

    def test_a_dropped_connection_fails_the_job_before_the_next_publish(self):
        """Dynamic Security drops the session when the password is re-issued (seen at message 8)."""
        self.broker.after_publish = lambda client, n: n == 3 and client.drop()
        sent, _, error = self.run_job(a_session(readings=4))
        client, = self.broker.clients
        self.assertEqual(sent, 3)
        self.assertEqual(client.published_types()[:3], ["NBIRTH", "DBIRTH", "DDATA"])
        self.assertEqual(len([t for t in client.published_types() if t == "DDATA"]), 1)
        self.assertIn("publishing stopped after 3 message(s): the broker connection was lost", error)
        self.assert_death_attempted(client)

    def test_a_job_that_kept_its_connection_counts_every_message(self):
        sent, _, error = self.run_job(a_session(readings=4))
        self.assertEqual((sent, error), (6, None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
