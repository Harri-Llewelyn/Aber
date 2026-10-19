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
        self.retained = {}                # topic -> payload, delivered on subscribe
        self.refuse_subscribe = False
        self.accepts = None               # the passwords the broker accepts; None accepts any
        self.refusal = 5                  # the CONNACK rc for any other


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
        accepts = FakeClient.broker.accepts
        rc = 0 if accepts is None or self.password in accepts else FakeClient.broker.refusal
        self.connected = rc == 0
        self.on_connect(self, None, {}, rc)

    def loop_start(self):
        self.events.append("loop_start")

    def loop_stop(self):
        self.events.append("loop_stop")

    def subscribe(self, topics):
        self.events.append(("subscribe", tuple(topics)))
        granted = tuple(0x80 if FakeClient.broker.refuse_subscribe else qos for _, qos in topics)
        self.on_subscribe(self, None, 7, granted)
        for topic, _ in topics:
            if topic in FakeClient.broker.retained:
                self.deliver(topic, FakeClient.broker.retained[topic])
        return 0, 7

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

    def deliver(self, topic, payload):
        """The broker hands this client a message on a topic it subscribed to."""
        self.on_message(self, None, SimpleNamespace(topic=topic, payload=payload, retain=False))

    def subscriptions(self):
        return [e[1] for e in self.events if isinstance(e, tuple) and e[0] == "subscribe"]

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
        self._saved = (playback_worker.mqtt.Client, playback_worker.PROGRESS_INTERVAL_SECONDS,
                       playback_worker.PRIMARY_HOST_ID)
        FakeClient.broker = self.broker = FakeBroker()
        playback_worker.mqtt.Client = FakeClient
        playback_worker.PRIMARY_HOST_ID = ""
        playback_worker._next_bdseq.clear()

    def tearDown(self):
        (playback_worker.mqtt.Client, playback_worker.PROGRESS_INTERVAL_SECONDS,
         playback_worker.PRIMARY_HOST_ID) = self._saved
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

    def test_a_playback_shorter_than_a_progress_interval_still_reports_its_total(self):
        """messages_total stayed 0 on the page for a job that finished within one interval."""
        self.run_job(a_session(readings=1))
        reports = self.supabase.called("playback_progress")
        self.assertTrue(reports, "no progress was reported at all")
        self.assertEqual(reports[0]["p_messages_total"], 3)


# -------------------------------------------------------------------------------------------------
# Waiting, stopping, and the end of a job
# -------------------------------------------------------------------------------------------------
class FakeClock:
    """time.monotonic(), time.time() and time.sleep() for the worker, advancing only on sleep."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def time(self):
        return 1_760_000_000.0 + self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class ClockedCase(WorkerLoopCase):
    def setUp(self):
        super().setUp()
        self._real_time = playback_worker.time
        self.clock = playback_worker.time = FakeClock()

    def tearDown(self):
        playback_worker.time = self._real_time
        super().tearDown()


def with_a_long_gap(gap_ms=600_000):
    """A session whose last reading comes ten minutes after the others, as the audit's did."""
    messages = a_session(readings=1)
    messages.append(recorded(gap_ms, "DDATA", device=CAPTURED_DEV, value=9.0))
    return messages


class LongGapTests(ClockedCase):
    def test_stop_during_a_long_gap_ends_the_job_within_a_second(self):
        start = self.clock.now
        stop_at = start + 30.0
        supabase = FakeSupabase(playback_progress=lambda _p: self.clock.now >= stop_at)
        outcome = {}
        self.supabase = supabase
        sent, _, error = playback_worker._run_job(
            supabase, FakeStorage(capture_file(with_a_long_gap())), {GW: "a-password"},
            self.job(speed=1.0), outcome=outcome)
        self.assertEqual((sent, error, outcome.get("stopped")), (3, None, True))
        self.assertLessEqual(self.clock.now - stop_at, 1.0)
        client, = self.broker.clients
        self.assertNotIn("DDATA", client.published_types()[3:], "the reading after the gap went out")

    def test_no_sleep_is_longer_than_a_second(self):
        self.run_job(with_a_long_gap(gap_ms=5_500), speed=1.0)
        self.assertTrue(self.clock.sleeps)
        self.assertLessEqual(max(self.clock.sleeps), 1.0)

    def test_progress_is_reported_through_the_gap(self):
        self.run_job(with_a_long_gap(gap_ms=10_000), speed=1.0)
        reports = self.supabase.called("playback_progress")
        in_the_gap = [r for r in reports if r["p_messages_sent"] == 3]
        self.assertGreaterEqual(len(in_the_gap), 10, "the ten-second gap was not reported each second")
        self.assertTrue(all(r["p_messages_total"] == 4 for r in reports))

    def test_a_connection_lost_in_a_gap_fails_the_job_within_a_second(self):
        dropped_at = []

        def drop_after_the_third(client, n):
            if n == 3:
                dropped_at.append(self.clock.now)
                client.drop()

        self.broker.after_publish = drop_after_the_third
        sent, _, error = self.run_job(with_a_long_gap(), speed=1.0)
        self.assertEqual(sent, 3)
        self.assertIn("the broker connection was lost", error)
        self.assertLessEqual(self.clock.now - dropped_at[0], 1.0)


class Done(BaseException):
    """Ends main()'s loop from a fake, past its `except Exception`."""


class MainLoopTests(ClockedCase):
    def setUp(self):
        super().setUp()
        self._saved_main = (playback_worker._supabase, playback_worker._storage,
                            playback_worker._start_heartbeat, playback_worker._run_job,
                            playback_worker._credential_sources, playback_worker.SUPABASE_PLAYBACK_KEY)
        playback_worker._storage = lambda: None
        playback_worker._start_heartbeat = lambda holdings: self.heartbeats.append(holdings)
        playback_worker._credential_sources = lambda: {GW: [("delivered", "a-password")]}
        playback_worker.SUPABASE_PLAYBACK_KEY = "a-key"
        self.heartbeats = []
        self.ran = []

        def run_job(supabase, storage, credentials, job, outcome=None):
            self.ran.append(job["id"])
            return 3, 0, None
        playback_worker._run_job = run_job

    def tearDown(self):
        (playback_worker._supabase, playback_worker._storage, playback_worker._start_heartbeat,
         playback_worker._run_job, playback_worker._credential_sources,
         playback_worker.SUPABASE_PLAYBACK_KEY) = self._saved_main
        super().tearDown()

    def main(self, **answers):
        claims = iter([self.job()])

        def claim(_params):
            try:
                return next(claims)
            except StopIteration:
                raise Done()

        answers.setdefault("playback_claim_job", claim)
        supabase = FakeSupabase(**answers)
        playback_worker._supabase = lambda: supabase
        with self.assertRaises(Done):
            playback_worker.main()
        return supabase

    @staticmethod
    def failing(times, then=None):
        """An answer that raises `times` times, then returns `then`."""
        calls = []

        def answer(_params):
            calls.append(1)
            if len(calls) <= times:
                raise ConnectionError("PGRST002: schema cache not loaded")
            return then
        return answer

    def test_a_failed_startup_sweep_is_retried_and_nothing_is_claimed_before_it_runs(self):
        supabase = self.main(playback_reconcile_jobs=self.failing(2, then=0))
        names = [n for n, _ in supabase.calls]
        self.assertEqual(names[:3], ["playback_reconcile_jobs"] * 3)
        self.assertLess(names.index("playback_reconcile_jobs"), names.index("playback_claim_job"))
        self.assertEqual(names.count("playback_reconcile_jobs"), 3, "the sweep ran again after it succeeded")
        self.assertEqual(self.ran, [JOB_ID])

    def test_a_failed_finish_is_retried_with_backoff_until_recorded(self):
        supabase = self.main(playback_finish=self.failing(3))
        finishes = supabase.called("playback_finish")
        self.assertEqual(len(finishes), 4)
        self.assertEqual(finishes[-1], {"p_job_id": JOB_ID, "p_messages_sent": 3, "p_error": None,
                                        "p_messages_out_of_window": 0})
        self.assertEqual([s for s in self.clock.sleeps if s in (1.0, 2.0, 4.0)], [1.0, 2.0, 4.0])

    def test_a_finish_that_never_succeeds_is_given_up_and_the_worker_carries_on(self):
        with self.assertLogs(playback_worker.logger, level="ERROR") as logs:
            supabase = self.main(playback_finish=self.failing(10_000))
        self.assertIn("could not be recorded", "\n".join(logs.output))
        self.assertGreater(len(supabase.called("playback_finish")), 5)
        # Bounded, and then back to the queue.
        self.assertLessEqual(sum(self.clock.sleeps), playback_worker.FINISH_RETRY_SECONDS + 3 * 30)
        self.assertEqual(len(supabase.called("playback_claim_job")), 2)

    def test_a_job_the_operator_stopped_is_logged_as_stopped_not_complete(self):
        def stopped(supabase, storage, credentials, job, outcome=None):
            outcome["stopped"] = True
            return 2, 0, None
        playback_worker._run_job = stopped
        with self.assertLogs(playback_worker.logger, level="INFO") as logs:
            self.main(playback_reconcile_jobs=lambda _p: 0)
        log = "\n".join(logs.output)
        self.assertIn("stopped by the operator: 2 message(s) published", log)
        self.assertNotIn("complete", log)

    def test_the_heartbeat_is_started_before_any_job(self):
        self.main(playback_reconcile_jobs=lambda _p: 0)
        self.assertEqual(len(self.heartbeats), 1)
        self.assertEqual(self.heartbeats[0].credentials, {GW: "a-password"})


class HeartbeatTests(unittest.TestCase):
    """The timer thread, which reports whether or not a job is running."""

    def setUp(self):
        self._saved = (playback_worker._credential_sources,
                       playback_worker.CREDENTIAL_REPORT_INTERVAL_SECONDS)
        playback_worker._credential_sources = lambda: {GW: [("delivered", "a-password")]}
        playback_worker.CREDENTIAL_REPORT_INTERVAL_SECONDS = 0.01

    def tearDown(self):
        playback_worker._credential_sources, playback_worker.CREDENTIAL_REPORT_INTERVAL_SECONDS = self._saved

    def test_it_keeps_reporting_on_its_own_thread_and_survives_a_failed_report(self):
        import threading
        reports = []
        enough = threading.Event()

        def report(params):
            reports.append(params)
            if len(reports) == 1:
                raise ConnectionError("gateway restarting")
            if len(reports) >= 4:
                enough.set()

        holdings = playback_worker._Holdings()
        stop = threading.Event()
        thread = threading.Thread(target=holdings.run_heartbeat,
                                  args=(FakeSupabase(playback_report_credentials=report), stop))
        with self.assertLogs(playback_worker.logger, level="WARNING"):
            thread.start()
            # The main thread is busy elsewhere, as it is during a playback.
            self.assertTrue(enough.wait(5), "the heartbeat stopped reporting")
        stop.set()
        thread.join(5)
        self.assertEqual(reports[0]["p_rotated"], [GW], "startup counts as picking the password up")
        self.assertEqual(reports[1]["p_rotated"], [GW], "a failed report cleared the rotation")
        self.assertEqual(reports[2]["p_rotated"], [])
        self.assertEqual({tuple(r["p_edge_nodes"]) for r in reports}, {(GW,)})

    def test_a_change_is_logged_by_id_and_wakes_the_heartbeat(self):
        holdings = playback_worker._Holdings()
        holdings._changed.clear()
        playback_worker._credential_sources = lambda: {GW: [("delivered", "a-new-password")]}
        with self.assertLogs(playback_worker.logger, level="INFO") as logs:
            holdings.refresh()
        self.assertIn("rotated %s" % GW, "\n".join(logs.output))
        self.assertNotIn("a-new-password", "\n".join(logs.output))
        self.assertTrue(holdings._changed.is_set())


# -------------------------------------------------------------------------------------------------
# A full Sparkplug edge node: NCMD and the rebirth answer
# -------------------------------------------------------------------------------------------------
NCMD = "spBv1.0/%s/NCMD/%s" % (GROUP, GW)
HOST = "Aber"
STATE = "spBv1.0/STATE/%s" % HOST


def rebirth_request(value=True, name="Node Control/Rebirth"):
    """The NCMD the ingestion daemon publishes, protobuf-encoded."""
    return capture.dict_to_payload_bytes({
        "timestamp": EPOCH, "metrics": [{"name": name, "datatype": 11, "boolean_value": value}]})


def seq_of(raw):
    try:
        return decode(raw).seq
    except Exception:
        return json.loads(raw)["seq"]


def bdseq_in(raw):
    payload = decode(raw)
    return next(m.long_value for m in payload.metrics if m.name == "bdSeq")


def state(online, timestamp):
    return json.dumps({"online": online, "timestamp": timestamp}).encode("utf-8")


class RebirthTests(WorkerLoopCase):
    def published(self):
        client, = self.broker.clients
        return [(msg_type_of(e[1]), e[2]) for e in client.published()]

    def test_it_subscribes_to_its_own_ncmd_at_qos_1_before_the_nbirth(self):
        self.run_job(a_session())
        client, = self.broker.clients
        self.assertEqual(client.subscriptions(), [((NCMD, 1),)])
        first_publish = next(i for i, e in enumerate(client.events)
                             if isinstance(e, tuple) and e[0] == "publish")
        first_subscribe = next(i for i, e in enumerate(client.events)
                               if isinstance(e, tuple) and e[0] == "subscribe")
        self.assertLess(first_subscribe, first_publish)

    def test_a_rebirth_request_is_answered_with_the_births_and_seq_restarts(self):
        def ask_after_the_first_reading(client, n):
            if n == 3:
                client.deliver(NCMD, rebirth_request())

        self.broker.after_publish = ask_after_the_first_reading
        sent, _, error = self.run_job(a_session(readings=3))
        self.assertEqual((sent, error), (5, None), "the re-published births were counted as planned")
        published = self.published()
        self.assertEqual([t for t, _ in published],
                         ["NBIRTH", "DBIRTH", "DDATA", "NBIRTH", "DBIRTH", "DDATA", "DDATA", "NDEATH"])
        self.assertEqual([seq_of(raw) for _, raw in published[3:7]], [0, 1, 2, 3])
        self.assertEqual(bdseq_in(published[3][1]), bdseq_in(published[0][1]),
                         "a rebirth on the same connection keeps the bdSeq")
        self.assertEqual(decode(published[4][1]).metrics[0].double_value, 0.0,
                         "the DBIRTH re-published is the one the session published")

    def test_a_json_session_is_re_stamped_as_json(self):
        self.broker.after_publish = lambda client, n: n == 3 and client.deliver(NCMD, rebirth_request())
        self.run_job(a_session(readings=2, encoding="json"))
        published = self.published()
        self.assertEqual([json.loads(raw)["seq"] for _, raw in published[3:6]], [0, 1, 2])

    def test_a_request_that_is_not_a_rebirth_is_ignored(self):
        def ask(client, n):
            if n == 3:
                client.deliver(NCMD, rebirth_request(value=False))
                client.deliver(NCMD, rebirth_request(name="Node Control/Reboot"))
                client.deliver(NCMD, b"not a payload at all")

        self.broker.after_publish = ask
        self.run_job(a_session(readings=2))
        self.assertEqual([t for t, _ in self.published()], ["NBIRTH", "DBIRTH", "DDATA", "DDATA", "NDEATH"])

    def test_a_request_before_the_nbirth_is_answered_by_the_nbirth(self):
        self.broker.retained[NCMD] = rebirth_request()
        self.run_job(a_session(readings=1))
        self.assertEqual([t for t, _ in self.published()], ["NBIRTH", "DBIRTH", "DDATA", "NDEATH"])

    def test_a_device_that_died_is_not_re_born(self):
        messages = a_session(readings=1) + [recorded(40, "DDEATH", device=CAPTURED_DEV),
                                            recorded(50, "NDATA", value=5.0)]
        self.broker.after_publish = lambda client, n: n == 4 and client.deliver(NCMD, rebirth_request())
        self.run_job(messages)
        self.assertEqual([t for t, _ in self.published()],
                         ["NBIRTH", "DBIRTH", "DDATA", "DDEATH", "NBIRTH", "NDATA", "NDEATH"])

    def test_the_sessions_open_for_the_cli_keep_their_positional_shape(self):
        """capture.py play calls _open_session(edge_node, password, will_topic, bdseq)."""
        client, error = playback_worker._open_session(
            GW, "a-password", "spBv1.0/%s/NDEATH/%s" % (GROUP, GW), 5)
        self.assertIsNone(error)
        self.assertEqual(client.subscriptions(), [((NCMD, 1),)])
        self.assertEqual(bdseq_in(client.will[1]), 5)
        playback_worker._end_session(client, client.will[0], client.will[1])
        self.assertEqual(client.events[-1], "disconnect")


class LongGapRebirthTests(ClockedCase):
    def test_a_rebirth_in_a_long_gap_is_answered_within_a_second(self):
        asked = []

        def ask(client, n):
            if n == 3:
                asked.append(self.clock.now)
                client.deliver(NCMD, rebirth_request())

        self.broker.after_publish = ask
        self.supabase = FakeSupabase()
        playback_worker._run_job(self.supabase, FakeStorage(capture_file(with_a_long_gap(30_000))),
                                 {GW: "a-password"}, self.job(speed=1.0))
        client, = self.broker.clients
        births = [i for i, e in enumerate(client.published()) if msg_type_of(e[1]) == "NBIRTH"]
        self.assertEqual(len(births), 2)
        self.assertLess(births[1], 4, "the answer waited for the next reading")


# -------------------------------------------------------------------------------------------------
# A full Sparkplug edge node: the primary host's STATE
# -------------------------------------------------------------------------------------------------
class PrimaryHostTests(ClockedCase):
    def setUp(self):
        super().setUp()
        playback_worker.PRIMARY_HOST_ID = HOST

    def published_types(self):
        client, = self.broker.clients
        return client.published_types()

    def test_it_subscribes_to_the_hosts_state_and_births_once_it_is_online(self):
        self.broker.retained[STATE] = state(True, 1000)
        sent, _, error = self.run_job(a_session())
        self.assertEqual((sent, error), (5, None))
        client, = self.broker.clients
        self.assertEqual(client.subscriptions(), [((NCMD, 1), (STATE, 1))])
        self.assertEqual(self.published_types()[0], "NBIRTH")

    def test_no_birth_while_the_host_never_says_online(self):
        self.broker.retained[STATE] = state(False, 1000)
        sent, _, error = self.run_job(a_session())
        self.assertEqual(sent, 0)
        self.assertIn("the primary host 'Aber' did not say it is online on %s" % STATE, error)
        self.assertEqual(self.published_types(), [], "an NBIRTH or a death went out")
        client, = self.broker.clients
        self.assertEqual(client.events[-1], "disconnect", "the unborn session was not closed cleanly")
        self.assertGreaterEqual(self.clock.now - 1000.0, playback_worker.PRIMARY_HOST_WAIT_SECONDS)

    def test_it_waits_for_the_host_to_come_online(self):
        self.broker.retained[STATE] = state(False, 1000)
        start = self.clock.now

        def come_online_after_ten_seconds(seconds, sleep=self.clock.sleep):
            sleep(seconds)
            client = self.broker.clients[0] if self.broker.clients else None
            if client and self.clock.now - start >= 10 and client.aber.host_online is False:
                client.deliver(STATE, state(True, 2000))

        self.clock.sleep = come_online_after_ten_seconds
        sent, _, error = self.run_job(a_session())
        self.assertEqual((sent, error), (5, None))
        self.assertGreaterEqual(self.clock.now - start, 10)

    def test_progress_is_reported_and_stop_honoured_while_waiting(self):
        start = self.clock.now
        supabase = FakeSupabase(playback_progress=lambda _p: self.clock.now - start >= 5)
        self.supabase = supabase
        outcome = {}
        sent, _, error = playback_worker._run_job(
            supabase, FakeStorage(capture_file(a_session())), {GW: "a-password"}, self.job(),
            outcome=outcome)
        self.assertEqual((sent, error, outcome.get("stopped")), (0, None, True))
        self.assertEqual(supabase.called("playback_progress")[0]["p_messages_total"], 5)
        self.assertEqual(self.published_types(), [])
        self.assertLess(self.clock.now - start, 7)

    def test_the_host_going_offline_mid_replay_ends_the_session_and_fails_the_job(self):
        self.broker.retained[STATE] = state(True, 1000)
        self.broker.after_publish = lambda client, n: n == 3 and client.deliver(STATE, state(False, 1000))
        sent, _, error = self.run_job(a_session(readings=3))
        self.assertEqual(sent, 3)
        self.assertIn("the primary host 'Aber' went offline after 3 message(s)", error)
        client, = self.broker.clients
        self.assertEqual(self.published_types(), ["NBIRTH", "DBIRTH", "DDATA", "NDEATH"])
        self.assertEqual(client.published()[-1][3], 1, "the NDEATH is QoS 1")
        self.assertEqual(client.events[-1], "disconnect")

    def test_an_older_offline_is_a_previous_session_s_will_and_is_ignored(self):
        """A daemon restart: the new STATE online, then the old connection's Will, stamped earlier."""
        self.broker.retained[STATE] = state(True, 2000)
        self.broker.after_publish = lambda client, n: n == 3 and client.deliver(STATE, state(False, 1000))
        sent, _, error = self.run_job(a_session(readings=3))
        self.assertEqual((sent, error), (5, None))

    def test_a_refused_subscription_fails_the_job_before_any_birth(self):
        self.broker.refuse_subscribe = True
        sent, _, error = self.run_job(a_session())
        self.assertEqual(sent, 0)
        self.assertIn("refused this worker's subscription", error)
        self.assertEqual(self.published_types(), [])


class WireHelperTests(unittest.TestCase):
    def test_seq_is_replaced_in_protobuf_without_touching_the_rest(self):
        raw = capture.dict_to_payload_bytes({"timestamp": EPOCH, "seq": 9, "metrics": [
            {"name": "bdSeq", "datatype": 4, "long_value": 3}]})
        out = decode(playback_worker._with_seq(raw, 0))
        self.assertEqual((out.seq, out.timestamp, out.metrics[0].long_value), (0, EPOCH, 3))

    def test_seq_is_replaced_in_json(self):
        raw = json.dumps({"timestamp": EPOCH, "seq": 9, "metrics": []}).encode()
        self.assertEqual(json.loads(playback_worker._with_seq(raw, 4)),
                         {"timestamp": EPOCH, "seq": 4, "metrics": []})

    def test_a_state_payload_is_read_strictly(self):
        self.assertEqual(playback_worker._host_state(state(True, 5)), (True, 5))
        for bad in (b"{}", b'{"online": "true", "timestamp": 1}', b'{"online": true}',
                    b'{"online": true, "timestamp": true}', b"nope"):
            self.assertIsNone(playback_worker._host_state(bad), bad)


# -------------------------------------------------------------------------------------------------
# Which password: the delivered one first, then the Helm value
# -------------------------------------------------------------------------------------------------
STALE_DELIVERED = ("delivered", "stale-delivered-value")
HELM_VALUE = ("helm", "current-helm-value")


class CredentialFallbackTests(WorkerLoopCase):
    def run_with_both(self, messages=None):
        self.outcome = {}
        self.supabase = FakeSupabase()
        return playback_worker._run_job(
            self.supabase, FakeStorage(capture_file(messages or a_session())),
            {GW: [STALE_DELIVERED, HELM_VALUE]}, self.job(), outcome=self.outcome)

    def test_a_refused_delivered_password_falls_back_to_the_helm_value(self):
        """The case the credential dialog's fallback is for: a re-issue whose delivery failed."""
        self.broker.accepts = {HELM_VALUE[1]}
        with self.assertLogs(playback_worker.logger, level="INFO") as logs:
            sent, _, error = self.run_with_both()
        self.assertEqual((sent, error), (5, None))
        refused, accepted = self.broker.clients
        self.assertEqual((refused.password, accepted.password), (STALE_DELIVERED[1], HELM_VALUE[1]))
        self.assertEqual(refused.published(), [])
        self.assertEqual(self.outcome["accepted"], HELM_VALUE)
        log = "\n".join(logs.output)
        self.assertIn("accepted the password in secrets.mqttPlaybackCredentials for %s after "
                      "refusing the delivered password (CONNACK rc=5)" % GW, log)
        self.assertIn("connected as %s with the password in secrets.mqttPlaybackCredentials" % GW, log)
        self.assertNotIn(STALE_DELIVERED[1], log)
        self.assertNotIn(HELM_VALUE[1], log)

    def test_the_accepted_connect_carries_the_next_bdseq_and_the_nbirth_repeats_it(self):
        """Each CONNECT spends a bdSeq, so the plan is renumbered for the one accepted."""
        self.broker.accepts = {HELM_VALUE[1]}
        self.run_with_both()
        refused, accepted = self.broker.clients
        self.assertEqual((bdseq_in(refused.will[1]), bdseq_in(accepted.will[1])), (0, 1))
        self.assertEqual(bdseq_in(accepted.published()[0][2]), 1)
        self.assertEqual(bdseq_in(accepted.published()[-1][2]), 1)

    def test_both_refused_fails_naming_both(self):
        self.broker.accepts = set()
        sent, _, error = self.run_with_both()
        self.assertEqual(sent, 0)
        self.assertIn("rc=5", error)
        self.assertIn("Also refused: the delivered password (CONNACK rc=5)", error)

    def test_a_refusal_that_is_not_about_the_password_does_not_fall_back(self):
        self.broker.accepts, self.broker.refusal = set(), 3
        sent, _, error = self.run_with_both()
        self.assertEqual(len(self.broker.clients), 1)
        self.assertIn("rc=3", error)

    def test_a_later_session_in_the_job_uses_the_password_accepted(self):
        self.broker.accepts = {HELM_VALUE[1]}
        messages = a_session(readings=1) + [recorded(40, "NDEATH"), recorded(50, "NBIRTH"),
                                            recorded(60, "NDATA", value=1.0)]
        sent, _, error = self.run_with_both(messages)
        self.assertEqual((sent, error), (6, None))
        self.assertEqual([c.password for c in self.broker.clients],
                         [STALE_DELIVERED[1], HELM_VALUE[1], HELM_VALUE[1]])


class CredentialSourceTests(unittest.TestCase):
    """_credential_sources() and what the worker reports about them."""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "credentials.json")
        self._saved_env = {k: os.environ.get(k) for k in (
            "MQTT_PLAYBACK_CREDENTIALS", "MQTT_PLAYBACK_USER", "MQTT_PLAYBACK_PASSWORD")}
        for k in self._saved_env:
            os.environ.pop(k, None)
        self._saved_file = playback_worker.PLAYBACK_CREDENTIAL_FILE
        playback_worker.PLAYBACK_CREDENTIAL_FILE = self.path

    def tearDown(self):
        playback_worker.PLAYBACK_CREDENTIAL_FILE = self._saved_file
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def deliver(self, value):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({GW: value}, handle)

    def test_the_delivered_password_comes_first_then_the_helm_value(self):
        self.deliver(STALE_DELIVERED[1])
        os.environ["MQTT_PLAYBACK_CREDENTIALS"] = json.dumps({GW: HELM_VALUE[1]})
        self.assertEqual(playback_worker._credential_sources(), {GW: [STALE_DELIVERED, HELM_VALUE]})
        self.assertEqual(playback_worker._credentials(), {GW: STALE_DELIVERED[1]})

    def test_a_password_two_sources_agree_on_is_tried_once(self):
        self.deliver(HELM_VALUE[1])
        os.environ["MQTT_PLAYBACK_CREDENTIALS"] = json.dumps({GW: HELM_VALUE[1]})
        self.assertEqual(playback_worker._credential_sources(), {GW: [("delivered", HELM_VALUE[1])]})

    def test_the_accepted_one_goes_first_until_a_new_delivery(self):
        self.deliver(STALE_DELIVERED[1])
        os.environ["MQTT_PLAYBACK_CREDENTIALS"] = json.dumps({GW: HELM_VALUE[1]})
        holdings = playback_worker._Holdings()
        holdings.accepted(GW, HELM_VALUE)
        self.assertEqual(holdings.for_jobs(), {GW: [HELM_VALUE, STALE_DELIVERED]})
        self.deliver("a-newer-delivery")
        holdings.refresh()
        self.assertEqual(holdings.for_jobs()[GW][0], ("delivered", "a-newer-delivery"))

    def test_the_heartbeat_reports_the_sources_in_the_order_tried(self):
        self.deliver(STALE_DELIVERED[1])
        os.environ["MQTT_PLAYBACK_CREDENTIALS"] = json.dumps({GW: HELM_VALUE[1]})
        holdings = playback_worker._Holdings()
        supabase = FakeSupabase()
        holdings.report(supabase)
        holdings.accepted(GW, HELM_VALUE)
        holdings.report(supabase)
        self.assertEqual([p["p_sources"] for p in supabase.called("playback_report_credential_sources")],
                         [{GW: ["delivered", "helm"]}, {GW: ["helm", "delivered"]}])
        self.assertNotIn(HELM_VALUE[1], json.dumps(supabase.calls))


if __name__ == "__main__":
    unittest.main(verbosity=2)
