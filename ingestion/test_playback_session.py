"""
The playback worker's Sparkplug session: its Will, its bdSeq, and the NDEATH that ends every job.

    python ingestion/test_playback_session.py

A replay is one or more MQTT sessions as the Playback gateway. Each registers its NDEATH as the
Will and ends by publishing it before DISCONNECT, so the gateway reads OFFLINE between replays
instead of going stale. What this suite holds:

  * THE PLAN IS A SESSION. It opens at an NBIRTH and leaves out what no session carries; every
    replayed NBIRTH and NDEATH carries the bdSeq of the session the worker publishes it in, not the
    recorded one; seq is numbered per session; and a recorded NDEATH ends a session.
  * THE WORKER ENDS EVERY JOB WITH THE DEATH: finished, stopped by the operator, or failed while
    publishing. The death is QoS 1 and acknowledged before DISCONNECT; one the broker never
    acknowledged is left to the Will.
  * INGESTION APPLIES IT. What the worker published, fed through the daemon's own dispatch, leaves
    the gateway OFFLINE, and an earlier job's Will arriving late is ignored.

The broker is a fake paho client that answers CONNECT at once and acknowledges every QoS 1 publish.
"""
import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import capture  # noqa: E402
import ingestion  # noqa: E402
import playback_worker  # noqa: E402
import registry  # noqa: E402
import sparkplug_b_pb2  # noqa: E402

GROUP = "Aber"
GW = "gwy160000000000400080000"
CAPTURED_GW = "gwy990000000000400080000"
CAPTURED_DEV = "dev880000000000400080000"
LANE = "dev770000000000400080000"
GATEWAY_ROW_ID = "a6000000-0000-4000-8000-000000000006"
EPOCH = 1_700_000_000_000


def recorded(offset_ms, msg_type, bdseq=None, encoding="protobuf", device=None, value=None,
             seq=0, alias=None):
    """One capture-file message from the recorded node, in the file's readable shape."""
    topic = "spBv1.0/%s/%s/%s" % (GROUP, msg_type, CAPTURED_GW)
    if device:
        topic += "/" + device
    stamp = EPOCH + offset_ms
    metrics = []
    if bdseq is not None:
        metrics.append({"name": "bdSeq", "datatype": 4, "long_value": bdseq, "timestamp": stamp})
    if msg_type == "NBIRTH":
        metrics.append({"name": "Node Control/Rebirth", "datatype": 11, "boolean_value": False,
                        "timestamp": stamp})
    if value is not None:
        metric = {"name": "Temperature", "datatype": 10, "double_value": value, "timestamp": stamp}
        if alias is not None:
            # A birth binds the alias to the name; data carries the alias alone.
            metric["alias"] = alias
            if "BIRTH" not in msg_type:
                del metric["name"]
        metrics.append(metric)
    payload = {"timestamp": stamp, "metrics": metrics}
    if msg_type != "NDEATH":
        payload["seq"] = seq
    return {"offset_ms": offset_ms, "topic": topic, "encoding": encoding, "payload": payload}


def capture_file(messages):
    return {
        "aber_capture_version": capture.CAPTURE_VERSION,
        "recorded_at": "2026-10-13T00:00:00+00:00",
        "capture_epoch_ms": EPOCH,
        "duration_ms": messages[-1]["offset_ms"],
        "identities": {"edge_nodes": [CAPTURED_GW], "devices": [CAPTURED_DEV]},
        "messages": messages,
    }


def a_session(birth_bdseq=7):
    """The shape a recording from the Capture page has: the rebirth it asked for, then readings."""
    return [
        recorded(0, "NBIRTH", bdseq=birth_bdseq),
        recorded(10, "DBIRTH", device=CAPTURED_DEV, value=1.0),
        recorded(20, "DDATA", device=CAPTURED_DEV, value=2.0),
    ]


def decode(payload_bytes):
    out = sparkplug_b_pb2.Payload()
    out.ParseFromString(payload_bytes)
    return out


def bdseq_of(payload_bytes):
    """The bdSeq a published certificate carries, read as the daemon reads it."""
    return ingestion.payload_bdseq(
        ingestion.parse_sparkplug_payload(SimpleNamespace(topic="t", payload=payload_bytes)))


def msg_type_of(topic):
    return capture.split_topic(topic)[1]


class SessionPlanTests(unittest.TestCase):
    """capture.plan_playback(..., bdseq=N), with no broker."""

    def plan(self, messages, bdseq=3):
        plan = capture.plan_playback(capture_file(messages), GW, {CAPTURED_DEV: LANE}, EPOCH,
                                     group=GROUP, bdseq=bdseq)
        return [(msg_type_of(topic), payload_bytes) for _, topic, payload_bytes, _ in plan]

    def certificates(self, messages, bdseq=3):
        return [(kind, bdseq_of(body)) for kind, body in self.plan(messages, bdseq)
                if kind in ("NBIRTH", "NDEATH")]

    def test_a_recorded_nbirth_carries_the_sessions_bdseq(self):
        birth = decode(self.plan(a_session(birth_bdseq=7))[0][1])
        metric = next(m for m in birth.metrics if m.name == "bdSeq")
        self.assertEqual((metric.long_value, metric.datatype), (3, capture.INT64))
        self.assertEqual(len([m for m in birth.metrics if m.name == "bdSeq"]), 1)

    def test_a_json_nbirth_is_rewritten_and_stays_json(self):
        body = self.plan([recorded(0, "NBIRTH", bdseq=7, encoding="json"),
                          recorded(10, "NDATA", value=1.0)])[0][1]
        self.assertEqual(json.loads(body)["metrics"][0]["long_value"], 3)
        self.assertEqual(bdseq_of(body), 3)

    def test_an_nbirth_without_a_bdseq_gains_one(self):
        """Every NBIRTH carries one (tck-id-payloads-nbirth-bdseq), or the Will's has nothing to match."""
        messages = [recorded(0, "NBIRTH"), recorded(10, "NDATA", value=1.0)]
        self.assertEqual(self.certificates(messages), [("NBIRTH", 3)])

    def test_births_in_one_session_repeat_its_bdseq(self):
        """A rebirth on the same connection keeps the bdSeq (-rebirth-action-3)."""
        messages = [recorded(0, "NBIRTH", bdseq=7), recorded(50, "NBIRTH", bdseq=8),
                    recorded(60, "NDATA", value=1.0)]
        self.assertEqual(self.certificates(messages), [("NBIRTH", 3), ("NBIRTH", 3)])

    def test_a_recorded_ndeath_ends_the_session(self):
        messages = [recorded(0, "NBIRTH", bdseq=7), recorded(10, "NDATA", value=1.0),
                    recorded(20, "NDEATH", bdseq=7), recorded(30, "NBIRTH", bdseq=8),
                    recorded(40, "NDEATH", bdseq=8)]
        self.assertEqual(self.certificates(messages),
                         [("NBIRTH", 3), ("NDEATH", 3), ("NBIRTH", 4), ("NDEATH", 4)])

    def test_the_session_number_wraps_from_255_to_0(self):
        messages = [recorded(0, "NBIRTH", bdseq=1), recorded(5, "NDATA", value=1.0),
                    recorded(10, "NDEATH", bdseq=1), recorded(20, "NBIRTH", bdseq=2)]
        self.assertEqual(self.certificates(messages, bdseq=255),
                         [("NBIRTH", 255), ("NDEATH", 255), ("NBIRTH", 0)])

    def test_device_messages_are_not_certificates(self):
        plan = self.plan(a_session())
        self.assertNotIn("bdSeq", [m.name for m in decode(plan[1][1]).metrics])

    def test_without_a_bdseq_the_recording_is_replayed_as_it_was(self):
        """`capture.py play` passes none."""
        self.assertEqual(self.certificates(a_session(birth_bdseq=7), bdseq=None), [("NBIRTH", 7)])

    def test_the_source_capture_is_not_mutated(self):
        messages = a_session(birth_bdseq=7)
        self.plan(messages)
        self.assertEqual(messages[0]["payload"]["metrics"][0]["long_value"], 7)

    def test_node_death_is_a_conformant_ndeath(self):
        """bdSeq as its only metric, Int64, and no seq (tck-id-topics-ndeath-payload, -ndeath-seq)."""
        death = decode(capture.node_death(5, EPOCH))
        self.assertFalse(death.HasField("seq"))
        self.assertEqual([(m.name, m.datatype, m.long_value) for m in death.metrics],
                         [("bdSeq", capture.INT64, 5)])

    # ---------------------------------------------------------------------------------------------
    # A session opens at an NBIRTH, and a device's data follows its DBIRTH
    # (tck-id-payloads-ndata-order, -ddata-order, -dbirth-order)
    # ---------------------------------------------------------------------------------------------
    def kinds(self, messages):
        return [kind for kind, _ in self.plan(messages)]

    def test_a_plan_opens_at_the_first_nbirth(self):
        """What a recording caught before the birth it asked for is left out, and waits are kept."""
        messages = [recorded(0, "DDATA", device=CAPTURED_DEV, value=1.0, alias=1),
                    recorded(5, "NDATA", value=2.0)] + [
            dict(m, offset_ms=m["offset_ms"] + 10) for m in a_session()]
        plan = capture.plan_playback(capture_file(messages), GW, {CAPTURED_DEV: LANE}, EPOCH,
                                     group=GROUP, bdseq=3)
        self.assertEqual([(delay, msg_type_of(topic)) for delay, topic, _, _ in plan],
                         [(10, "NBIRTH"), (20, "DBIRTH"), (30, "DDATA")])

    def test_a_capture_without_an_nbirth_is_refused(self):
        """
        Its aliases would resolve through whatever the Playback gateway's last replay declared, and
        its readings be filed under another capture's names.
        """
        for messages in ([recorded(0, "DDATA", device=CAPTURED_DEV, value=1.0, alias=1)],
                         a_session()[1:]):
            with self.assertRaises(capture.CaptureError) as caught:
                self.plan(messages)
            self.assertIn("holds no NBIRTH", str(caught.exception))
            self.assertIn("Record it again", str(caught.exception))

    def test_a_devices_data_before_its_dbirth_is_left_out(self):
        messages = [recorded(0, "NBIRTH", bdseq=7),
                    recorded(5, "DDATA", device=CAPTURED_DEV, value=1.0),
                    recorded(10, "DBIRTH", device=CAPTURED_DEV, value=1.0),
                    recorded(20, "DDATA", device=CAPTURED_DEV, value=2.0)]
        self.assertEqual(self.kinds(messages), ["NBIRTH", "DBIRTH", "DDATA"])

    def test_a_devices_data_after_its_ddeath_waits_for_its_next_dbirth(self):
        messages = a_session() + [
            recorded(30, "DDEATH", device=CAPTURED_DEV),
            recorded(40, "DDATA", device=CAPTURED_DEV, value=3.0),
            recorded(50, "DBIRTH", device=CAPTURED_DEV, value=4.0),
            recorded(60, "DDATA", device=CAPTURED_DEV, value=5.0)]
        self.assertEqual(self.kinds(messages),
                         ["NBIRTH", "DBIRTH", "DDATA", "DDEATH", "DBIRTH", "DDATA"])

    def test_after_a_recorded_ndeath_nothing_replays_until_the_next_nbirth(self):
        messages = a_session() + [
            recorded(30, "NDEATH", bdseq=7), recorded(40, "NDATA", value=1.0),
            recorded(50, "DDATA", device=CAPTURED_DEV, value=2.0), recorded(60, "NDEATH", bdseq=7),
            recorded(70, "NBIRTH", bdseq=8),
            recorded(80, "DDATA", device=CAPTURED_DEV, value=3.0),
            recorded(90, "DBIRTH", device=CAPTURED_DEV, value=4.0),
            recorded(100, "DDATA", device=CAPTURED_DEV, value=5.0)]
        self.assertEqual(self.kinds(messages), ["NBIRTH", "DBIRTH", "DDATA", "NDEATH",
                                                "NBIRTH", "DBIRTH", "DDATA"])

    def test_a_rebirth_needs_the_devices_born_again(self):
        """An NBIRTH resets every alias the node and its devices declared, as the daemon does."""
        messages = a_session() + [
            recorded(30, "NBIRTH", bdseq=7),
            recorded(40, "DDATA", device=CAPTURED_DEV, value=3.0),
            recorded(50, "DBIRTH", device=CAPTURED_DEV, value=4.0),
            recorded(60, "DDATA", device=CAPTURED_DEV, value=5.0)]
        self.assertEqual(self.kinds(messages),
                         ["NBIRTH", "DBIRTH", "DDATA", "NBIRTH", "DBIRTH", "DDATA"])

    def test_a_capture_of_births_alone_is_refused(self):
        with self.assertRaises(capture.CaptureError) as caught:
            self.plan(a_session()[:2])
        self.assertIn("only birth certificates", str(caught.exception))
        self.assertIn("nothing to replay", str(caught.exception))

    def test_a_refusal_counts_the_data_it_left_out(self):
        with self.assertRaises(capture.CaptureError) as caught:
            self.plan([recorded(0, "NBIRTH", bdseq=7),
                       recorded(10, "DDATA", device=CAPTURED_DEV, value=1.0)])
        self.assertIn("1 message(s) recorded outside a Sparkplug session", str(caught.exception))

    # ---------------------------------------------------------------------------------------------
    # seq is one counter per session, whatever was recorded
    # ---------------------------------------------------------------------------------------------
    def seqs(self, messages, encoding="protobuf"):
        out = []
        for _, body in self.plan([dict(m, encoding=encoding) for m in messages]):
            payload = ingestion.parse_sparkplug_payload(SimpleNamespace(topic="t", payload=body))
            out.append(payload.seq if payload.HasField("seq") else None)
        return out

    def test_a_device_scoped_plan_numbers_seq_contiguously(self):
        """
        A device capture of a node with two devices keeps the node's messages and one device's, so
        the recorded seq skips every sibling's message (tck-id-payloads-sequence-num-incrementing).
        """
        messages = [recorded(0, "NBIRTH", bdseq=7, seq=0),
                    recorded(10, "DBIRTH", device=CAPTURED_DEV, value=1.0, seq=1)] + [
            recorded(20 + i, "DDATA", device=CAPTURED_DEV, value=float(i), seq=3 + 2 * i)
            for i in range(6)]
        for encoding in ("protobuf", "json"):
            self.assertEqual(self.seqs(messages, encoding), list(range(8)), encoding)

    def test_the_daemon_sees_no_gap_in_a_device_scoped_replay(self):
        messages = [recorded(0, "NBIRTH", bdseq=7, seq=0),
                    recorded(10, "DBIRTH", device=CAPTURED_DEV, value=1.0, seq=1)] + [
            recorded(20 + i, "DDATA", device=CAPTURED_DEV, value=float(i), seq=3 + 2 * i)
            for i in range(6)]
        ingestion._last_seq.clear()
        try:
            verdicts = [
                ingestion.check_message_sequence(GROUP, GW, kind, decode(body))
                for kind, body in self.plan(messages)]
        finally:
            ingestion._last_seq.clear()
        self.assertEqual(verdicts, [True] * len(messages))

    def test_seq_restarts_at_each_nbirth_and_an_ndeath_carries_none(self):
        """tck-id-topics-nbirth-seq-num, tck-id-payloads-ndeath-seq."""
        messages = [recorded(0, "NBIRTH", bdseq=7, seq=40),
                    recorded(10, "NDATA", value=1.0, seq=41), recorded(20, "NDEATH", bdseq=7),
                    recorded(30, "NBIRTH", bdseq=8, seq=9),
                    recorded(40, "NDATA", value=2.0, seq=10)]
        self.assertEqual(self.seqs(messages), [0, 1, None, 0, 1])

    def test_a_recorded_seq_on_an_ndeath_is_dropped(self):
        death = dict(recorded(20, "NDEATH", bdseq=7))
        death["payload"] = dict(death["payload"], seq=12)
        messages = [recorded(0, "NBIRTH", bdseq=7), recorded(10, "NDATA", value=1.0), death]
        self.assertEqual(self.seqs(messages)[2], None)

    def test_seq_wraps_from_255_to_0(self):
        messages = [recorded(0, "NBIRTH", bdseq=7)] + [
            recorded(1 + i, "NDATA", value=float(i)) for i in range(300)]
        self.assertEqual(self.seqs(messages), [i % 256 for i in range(301)])

    def test_the_source_capture_keeps_its_recorded_seq(self):
        messages = [recorded(0, "NBIRTH", bdseq=7, seq=40),
                    recorded(10, "NDATA", value=1.0, seq=41)]
        self.plan(messages)
        self.assertEqual([m["payload"]["seq"] for m in messages], [40, 41])


# -------------------------------------------------------------------------------------------------
# The worker, against a fake paho client
# -------------------------------------------------------------------------------------------------
class FakeInfo:
    def __init__(self, acked):
        self.acked = acked
        self.timeout = None
        self.rc = 0

    def wait_for_publish(self, timeout=None):
        self.timeout = timeout

    def is_published(self):
        return self.acked


class FakeSocket:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakeClient:
    """Records what the worker asks of paho, in order. The broker answers CONNECT at once."""
    made = []
    connack = 0
    acked = True
    fail_on = None

    def __init__(self, client_id=None, **_kwargs):
        self.client_id = client_id
        self.events = []
        self.will = None
        self.sock = FakeSocket()
        FakeClient.made.append(self)

    def username_pw_set(self, username, password):
        self.username = username

    def will_set(self, topic, payload, qos=0, retain=False):
        self.will = (topic, payload, qos, retain)
        self.events.append("will_set")

    def tls_set(self, **_kwargs):
        pass

    def connect(self, host, port, keepalive):
        self.events.append("connect")
        self.on_connect(self, None, {}, FakeClient.connack)

    def loop_start(self):
        self.events.append("loop_start")

    def loop_stop(self):
        self.events.append("loop_stop")

    def subscribe(self, topics):
        self.on_subscribe(self, None, 1, tuple(qos for _, qos in topics))
        return 0, 1

    def publish(self, topic, payload, qos=0, retain=False):
        if FakeClient.fail_on and msg_type_of(topic) == FakeClient.fail_on:
            raise OSError("connection reset")
        self.events.append(("publish", topic, payload, qos, retain))
        return FakeInfo(FakeClient.acked)

    def disconnect(self):
        self.events.append("disconnect")

    def socket(self):
        return self.sock

    def published(self):
        return [e for e in self.events if isinstance(e, tuple)]


class FakeStorage:
    def __init__(self, document):
        self.body = json.dumps(document).encode("utf-8")

    def from_(self, _bucket):
        return self

    def download(self, _path):
        return self.body


class FakeSupabase:
    """`playback_progress` answers whether the operator asked to stop."""

    def __init__(self, stop=False):
        self.stop = stop

    def rpc(self, _name, _params):
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=self.stop))


class WorkerTestCase(unittest.TestCase):
    def setUp(self):
        self._saved = (playback_worker.mqtt.Client, playback_worker.PROGRESS_INTERVAL_SECONDS)
        playback_worker.mqtt.Client = FakeClient
        FakeClient.made, FakeClient.connack, FakeClient.acked, FakeClient.fail_on = [], 0, True, None
        playback_worker._next_bdseq.clear()

    def tearDown(self):
        playback_worker.mqtt.Client, playback_worker.PROGRESS_INTERVAL_SECONDS = self._saved
        playback_worker._next_bdseq.clear()

    def run_job(self, messages, supabase=None):
        job = {"id": "00000000-0000-4000-8000-0000000000bb", "target_edge_node_id": GW,
               "capture_storage_path": "dev880000000000400080000/capture.json",
               "device_map": {CAPTURED_DEV: LANE}, "speed": 1000.0, "sparkplug_group": GROUP}
        return playback_worker._run_job(supabase or FakeSupabase(), FakeStorage(capture_file(messages)),
                                        {GW: "a-password"}, job)

    def deaths(self, client):
        return [e for e in client.published() if msg_type_of(e[1]) == "NDEATH"]

    def assert_ended_with_its_death(self, client):
        """NDEATH, QoS 1, not retained, the Will's bdSeq; acknowledged; then DISCONNECT."""
        will_topic, will_payload, _, _ = client.will
        last = client.published()[-1]
        self.assertEqual(last[1], will_topic)
        self.assertEqual(last[3:], (1, False))
        self.assertEqual(bdseq_of(last[2]), bdseq_of(will_payload))
        self.assertEqual(client.events[-2:], ["loop_stop", "disconnect"])


class WorkerSessionTests(WorkerTestCase):
    def test_the_will_is_the_ndeath_of_the_session_its_nbirth_opens(self):
        self.run_job(a_session(birth_bdseq=7))
        client, = FakeClient.made
        topic, payload, qos, retain = client.will
        self.assertEqual(topic, "spBv1.0/%s/NDEATH/%s" % (GROUP, GW))
        self.assertEqual((qos, retain), (1, False))
        self.assertLess(client.events.index("will_set"), client.events.index("connect"))
        birth = client.published()[0]
        self.assertEqual(msg_type_of(birth[1]), "NBIRTH")
        self.assertEqual(bdseq_of(birth[2]), bdseq_of(payload))
        self.assertEqual(bdseq_of(payload), 0, "a process's first CONNECT carries bdSeq 0")

    def test_a_finished_job_ends_with_its_ndeath_before_disconnect(self):
        sent, _, error = self.run_job(a_session())
        self.assertIsNone(error)
        self.assertEqual(sent, 3, "the worker's own NDEATH is not a planned message")
        self.assert_ended_with_its_death(FakeClient.made[0])

    def test_a_job_the_operator_stops_ends_with_its_ndeath(self):
        playback_worker.PROGRESS_INTERVAL_SECONDS = 0
        sent, _, error = self.run_job(a_session(), supabase=FakeSupabase(stop=True))
        self.assertIsNone(error)
        self.assertEqual(sent, 1)
        self.assert_ended_with_its_death(FakeClient.made[0])

    def test_a_job_that_fails_while_publishing_ends_with_its_ndeath(self):
        FakeClient.fail_on = "DDATA"
        sent, _, error = self.run_job(a_session())
        self.assertIn("publishing stopped after 2 message(s)", error)
        self.assert_ended_with_its_death(FakeClient.made[0])

    def test_an_unacknowledged_death_is_left_to_the_will(self):
        """A DISCONNECT would tell the broker to discard the Will, and nothing would say the node died."""
        FakeClient.acked = False
        self.run_job(a_session())
        client, = FakeClient.made
        self.assertNotIn("disconnect", client.events)
        self.assertTrue(client.sock.closed)

    def test_a_death_that_cannot_be_published_is_left_to_the_will(self):
        FakeClient.fail_on = "NDEATH"
        sent, _, error = self.run_job(a_session())
        self.assertEqual((sent, error), (3, None))
        client, = FakeClient.made
        self.assertNotIn("disconnect", client.events)
        self.assertTrue(client.sock.closed)

    def test_a_refused_connect_publishes_nothing_and_still_spends_its_bdseq(self):
        FakeClient.connack = 5
        sent, _, error = self.run_job(a_session())
        self.assertEqual(sent, 0)
        self.assertIn("rc=5", error)
        self.assertEqual(FakeClient.made[0].published(), [])
        self.assertEqual(playback_worker._next_bdseq[GW], 1)

    def test_each_job_connects_with_the_next_bdseq(self):
        """tck-id-topics-nbirth-bdseq-increment: one more on every CONNECT, whatever was recorded."""
        self.run_job(a_session(birth_bdseq=7))
        self.run_job(a_session(birth_bdseq=7))
        self.assertEqual([bdseq_of(c.will[1]) for c in FakeClient.made], [0, 1])
        self.assertEqual([bdseq_of(c.published()[0][2]) for c in FakeClient.made], [0, 1])

    def test_the_bdseq_wraps_from_255_to_0(self):
        playback_worker._next_bdseq[GW] = 255
        self.run_job(a_session())
        self.run_job(a_session())
        self.assertEqual([bdseq_of(c.will[1]) for c in FakeClient.made], [255, 0])

    def test_a_recorded_ndeath_ends_the_session_and_the_next_opens_with_the_next_bdseq(self):
        messages = [recorded(0, "NBIRTH", bdseq=7), recorded(10, "NDATA", value=1.0),
                    recorded(20, "NDEATH", bdseq=7), recorded(30, "NBIRTH", bdseq=8),
                    recorded(40, "NDATA", value=2.0)]
        sent, _, error = self.run_job(messages)
        self.assertIsNone(error)
        self.assertEqual(sent, 5)
        first, second = FakeClient.made
        self.assertEqual(bdseq_of(first.will[1]), 0)
        recorded_death = self.deaths(first)
        self.assertEqual([(bdseq_of(d[2]), d[3]) for d in recorded_death], [(0, 1)])
        self.assertEqual(first.events[-2:], ["loop_stop", "disconnect"])
        self.assertEqual(bdseq_of(second.will[1]), 1)
        self.assertEqual(bdseq_of(second.published()[0][2]), 1)
        self.assert_ended_with_its_death(second)

    def test_a_recording_that_ends_in_an_ndeath_sends_one_death(self):
        messages = a_session() + [recorded(30, "NDEATH", bdseq=7)]
        sent, _, error = self.run_job(messages)
        self.assertIsNone(error)
        self.assertEqual(sent, 4)
        client, = FakeClient.made
        self.assertEqual(len(self.deaths(client)), 1)
        self.assert_ended_with_its_death(client)


class IngestionAppliesTheDeathTests(WorkerTestCase):
    """What the worker published, through the daemon's own dispatch, as test_stale_node_death.py stubs it."""

    def setUp(self):
        super().setUp()
        registry.reset()
        for store in (ingestion._session_bdseq, ingestion._alias_map, ingestion._alias_datatypes,
                      ingestion._name_datatypes, ingestion._last_seq, ingestion._device_seen,
                      ingestion._device_offline, ingestion._node_epoch,
                      ingestion._observed_group_written):
            store.clear()
        self._real = (ingestion.supabase_client, ingestion.resolve_gateway)
        self.db = MagicMock()
        self.db.rpc.return_value.execute.return_value = MagicMock(data=[])
        ingestion.supabase_client = self.db
        gateway = {"id": GATEWAY_ROW_ID, "name": "Playback", "sparkplug_id": GW,
                   "sparkplug_group": GROUP, "status": "OFFLINE", "is_archived": False}
        ingestion.resolve_gateway = lambda wire_id, group_id=None, include_archived=False: gateway

    def tearDown(self):
        ingestion.supabase_client, ingestion.resolve_gateway = self._real
        ingestion._session_bdseq.clear()
        super().tearDown()

    def deliver(self, topic, payload):
        """A node-level message as the broker hands it to the daemon."""
        ingestion.on_message(None, None, SimpleNamespace(topic=topic, payload=payload))

    def deliver_node_messages(self, client):
        for _, topic, payload, _, _ in client.published():
            if len(topic.split("/")) == 4:
                self.deliver(topic, payload)

    def statuses(self):
        return [c.args[1]["p_status"] for c in self.db.rpc.call_args_list
                if c.args[0] == "ingest_record_gateway_health"]

    def stale_deaths(self):
        return [line for line in registry.render().split("\n")
                if line.startswith("aber_ingestion_stale_deaths_total{")]

    def test_the_gateway_reads_offline_after_a_replay(self):
        self.run_job(a_session(birth_bdseq=7))
        self.deliver_node_messages(FakeClient.made[0])
        self.assertEqual(self.statuses(), ["ONLINE", "OFFLINE"])
        self.assertEqual(self.stale_deaths(), [])

    def test_a_capture_without_an_nbirth_is_refused_before_the_broker(self):
        """A session opens with an NBIRTH, so nothing is published and the gateway is untouched."""
        sent, _, error = self.run_job(a_session()[1:] + [recorded(30, "NDATA", value=3.0)])
        self.assertEqual(sent, 0)
        self.assertIn("holds no NBIRTH", error)
        self.assertEqual(FakeClient.made, [])

    def test_a_replay_leaves_no_alias_behind_for_the_next(self):
        """
        The NDEATH that ends a replay clears the aliases its NBIRTH declared, so the next replay
        onto the same gateway resolves only what its own births declare.
        """
        self.run_job([recorded(0, "NBIRTH", bdseq=7, value=1.0, alias=1),
                      recorded(10, "NDATA", value=2.0, alias=1)])
        alias_only = sparkplug_b_pb2.Payload.Metric(alias=1)
        delivered = FakeClient.made[0].published()
        self.deliver(*delivered[0][1:3])
        self.assertEqual(ingestion.resolve_metric_name(GROUP, GW, alias_only), "Temperature")
        self.deliver(*delivered[-1][1:3])
        self.assertEqual(self.statuses(), ["ONLINE", "OFFLINE"])
        self.assertIsNone(ingestion.resolve_metric_name(GROUP, GW, alias_only))

    def test_a_will_from_an_earlier_job_is_ignored(self):
        """Job 1's Will, delivered after job 2's NBIRTH, names a different bdSeq and changes nothing."""
        self.run_job(a_session(birth_bdseq=7))
        self.run_job(a_session(birth_bdseq=7))
        first, second = FakeClient.made
        self.deliver(*second.published()[0][1:3])
        self.deliver(*first.will[:2])
        self.assertEqual(self.statuses(), ["ONLINE"])
        self.assertEqual(len(self.stale_deaths()), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
