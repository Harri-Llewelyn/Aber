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
        self.assertEqual((sent, error, outcome), (3, None, {"stopped": True}))
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
                            playback_worker._credentials, playback_worker.SUPABASE_PLAYBACK_KEY)
        playback_worker._storage = lambda: None
        playback_worker._start_heartbeat = lambda holdings: self.heartbeats.append(holdings)
        playback_worker._credentials = lambda: {GW: "a-password"}
        playback_worker.SUPABASE_PLAYBACK_KEY = "a-key"
        self.heartbeats = []
        self.ran = []

        def run_job(supabase, storage, credentials, job, outcome=None):
            self.ran.append(job["id"])
            return 3, 0, None
        playback_worker._run_job = run_job

    def tearDown(self):
        (playback_worker._supabase, playback_worker._storage, playback_worker._start_heartbeat,
         playback_worker._run_job, playback_worker._credentials,
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

    def test_the_heartbeat_is_started_before_any_job(self):
        self.main(playback_reconcile_jobs=lambda _p: 0)
        self.assertEqual(len(self.heartbeats), 1)
        self.assertEqual(self.heartbeats[0].credentials, {GW: "a-password"})


class HeartbeatTests(unittest.TestCase):
    """The timer thread, which reports whether or not a job is running."""

    def setUp(self):
        self._saved = (playback_worker._credentials, playback_worker.CREDENTIAL_REPORT_INTERVAL_SECONDS)
        playback_worker._credentials = lambda: {GW: "a-password"}
        playback_worker.CREDENTIAL_REPORT_INTERVAL_SECONDS = 0.01

    def tearDown(self):
        playback_worker._credentials, playback_worker.CREDENTIAL_REPORT_INTERVAL_SECONDS = self._saved

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
        playback_worker._credentials = lambda: {GW: "a-new-password"}
        with self.assertLogs(playback_worker.logger, level="INFO") as logs:
            holdings.refresh()
        self.assertIn("rotated %s" % GW, "\n".join(logs.output))
        self.assertNotIn("a-new-password", "\n".join(logs.output))
        self.assertTrue(holdings._changed.is_set())


if __name__ == "__main__":
    unittest.main(verbosity=2)
