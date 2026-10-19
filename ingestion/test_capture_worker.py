"""
Unit tests for the daemon-side capture engine (capture_worker.py).

WHAT THIS PROTECTS, IN ORDER OF HOW BADLY IT FAILS. As with test_capture_playback.py, every
failure here is SILENT in production -- the capture completes, the page shows a green tick, and the
file is wrong in a way nobody finds until a playback ingests nothing.

  1. THE DEVICE-CAPTURE MATCHING RULE. A device-scoped recording that kept only its own DDATA would
     omit the NBIRTH where the alias table lives. An alias-optimised gateway then replays as
     `unresolved_alias` and drops every metric -- from a file that looks complete and whose message
     count is entirely plausible. ingestion.py documents this at `_alias_map`: it "ingests nothing
     at all from an alias-optimised gateway, and reports no error while doing it".

  2. THE SIZE ACCOUNTING. The size cap exists so that a recording cannot produce a file the bucket
     refuses -- a failure that lands AFTER the capture has succeeded, when it exists only in a
     buffer about to be freed. Counting wire bytes rather than serialised bytes would let a
     protobuf capture sail several-fold past its cap.

  3. THE SUBJECT FILTER. A job that recorded another edge node's traffic would produce a capture
     that plays back as the wrong plant, under a name that says otherwise.

  4. `birth_captured`. It is the one manifest field an operator acts on, and a recording that saw a
     birth and reported none is a file that will be distrusted for no reason -- or, the other way
     round, trusted when it should not be.

Like its sibling this suite needs the REAL generated protobuf and has to undo the other suites'
stub; see test_capture_playback.py's header for why that is, at length.
"""
import json
import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

#
# `capture` and `capture_worker` ARE DROPPED TOO, and that half is not optional here: ingestion.py
# imports capture_worker at module scope, so any sibling suite that imports the daemon has already
# loaded both of them bound to the stub. Re-importing the generated module without them leaves this
# file testing a worker whose decoder is `object`, which silently buffers nothing -- every
# assertion about a recorded message then fails as `0 != 1`.
_installed = sys.modules.get("sparkplug_b_pb2")
_is_stub = _installed is not None and getattr(_installed, "Payload", None) is object
if _is_stub:
    del sys.modules["sparkplug_b_pb2"]
    for _bound in ("capture", "capture_worker"):
        sys.modules.pop(_bound, None)

import sparkplug_b_pb2  # noqa: E402  (the real generated module, not the siblings' stub)
import capture  # noqa: E402
import capture_worker  # noqa: E402

if _is_stub:
    sys.modules["sparkplug_b_pb2"] = _installed

# The daemon, for the rebirth request a capture opens with. Its broker and historian libraries are
# stubbed as the sibling suites stub them; nothing reached here uses them.
for _name in ("psycopg2", "psycopg2.extras", "paho", "paho.mqtt", "paho.mqtt.client"):
    sys.modules.setdefault(_name, types.ModuleType(_name))
sys.modules["psycopg2.extras"].execute_values = getattr(
    sys.modules["psycopg2.extras"], "execute_values", None)
sys.modules["paho.mqtt.client"].Client = getattr(sys.modules["paho.mqtt.client"], "Client", object)
import ingestion  # noqa: E402


GROUP = "Aber"
# A group the edge node publishes under that is not the one its gateway row names.
OTHER_GROUP = "Line2"
GWY = "gwy120000000000400080000"
OTHER_GWY = "gwy999999999999999999999"
DEV = "dev270000000000400080000"
OTHER_DEV = "dev990000000000400080000"


def row(**over):
    """A claimed capture_jobs row, as ingest_claim_capture_job() returns it."""
    base = {
        "id": "00000000-0000-4000-8000-0000000000aa",
        "sparkplug_group": GROUP,
        "edge_node_id": GWY,
        "device_sparkplug_id": None,
        "storage_path": GWY + "/capture.json",
        "max_seconds": 60,
        "max_messages": 100000,
        "max_bytes": 52428800,
    }
    base.update(over)
    return base


def job(**over):
    return capture_worker._JobState(row(**over))


def wire(metrics=(("Temperature", 21.5),), seq=None, timestamp=1700000000000):
    """A real protobuf payload on the wire, because that is what the matcher has to survive."""
    p = sparkplug_b_pb2.Payload()
    p.timestamp = timestamp
    if seq is not None:
        p.seq = seq
    for name, value in metrics:
        m = p.metrics.add()
        m.name = name
        m.timestamp = timestamp
        m.datatype = 10          # Double
        m.double_value = value
    return p.SerializeToString()


def parts(topic):
    return topic.split("/")


class SubjectMatching(unittest.TestCase):
    """Which messages belong to the capture, which is the whole of the alias argument."""

    def test_a_gateway_capture_takes_everything_on_its_edge_node(self):
        j = job()
        for topic in (
            "spBv1.0/%s/NBIRTH/%s" % (GROUP, GWY),
            "spBv1.0/%s/NDATA/%s" % (GROUP, GWY),
            "spBv1.0/%s/DBIRTH/%s/%s" % (GROUP, GWY, DEV),
            "spBv1.0/%s/DDATA/%s/%s" % (GROUP, GWY, OTHER_DEV),
        ):
            self.assertTrue(j.matches(parts(topic)), topic)

    def test_a_gateway_capture_ignores_other_edge_nodes(self):
        j = job()
        self.assertFalse(j.matches(parts("spBv1.0/%s/NDATA/gwy999999999999999999999" % GROUP)))

    def test_a_gateway_capture_takes_its_edge_node_under_another_group(self):
        """
        Ingestion accepts an edge node under any group, by its sparkplug_id, so a capture records
        the same traffic. Matching the configured group recorded nothing from such a node.
        """
        j = job()
        for topic in (
            "spBv1.0/%s/NBIRTH/%s" % (OTHER_GROUP, GWY),
            "spBv1.0/%s/NDATA/%s" % (OTHER_GROUP, GWY),
            "spBv1.0/%s/DBIRTH/%s/%s" % (OTHER_GROUP, GWY, DEV),
            "spBv1.0/%s/DDATA/%s/%s" % (OTHER_GROUP, GWY, OTHER_DEV),
        ):
            self.assertTrue(j.matches(parts(topic)), topic)

    def test_another_edge_node_under_that_group_is_not_recorded(self):
        j = job()
        self.assertFalse(j.matches(parts("spBv1.0/%s/NDATA/%s" % (OTHER_GROUP, OTHER_GWY))))
        self.assertFalse(j.matches(parts("spBv1.0/%s/DDATA/%s/%s" % (OTHER_GROUP, OTHER_GWY, DEV))))

    def test_a_device_capture_takes_its_own_device(self):
        j = job(device_sparkplug_id=DEV)
        self.assertTrue(j.matches(parts("spBv1.0/%s/DDATA/%s/%s" % (GROUP, GWY, DEV))))

    def test_a_device_capture_ignores_its_siblings(self):
        j = job(device_sparkplug_id=DEV)
        self.assertFalse(j.matches(parts("spBv1.0/%s/DDATA/%s/%s" % (GROUP, GWY, OTHER_DEV))))

    def test_a_device_capture_still_takes_the_nodes_birth(self):
        """
        THE ONE THAT MATTERS. Without this the capture omits the NBIRTH carrying the alias table,
        and every DDATA metric that arrives by alias alone replays as unresolvable -- from a file
        whose message count looks entirely reasonable.
        """
        j = job(device_sparkplug_id=DEV)
        self.assertTrue(j.matches(parts("spBv1.0/%s/NBIRTH/%s" % (GROUP, GWY))))
        self.assertTrue(j.matches(parts("spBv1.0/%s/NDEATH/%s" % (GROUP, GWY))))

    def test_a_device_capture_does_not_take_node_topics_of_another_gateway(self):
        j = job(device_sparkplug_id=DEV)
        self.assertFalse(j.matches(parts("spBv1.0/%s/NBIRTH/%s" % (GROUP, OTHER_GWY))))

    def test_a_device_capture_takes_its_device_and_node_under_another_group(self):
        j = job(device_sparkplug_id=DEV)
        self.assertTrue(j.matches(parts("spBv1.0/%s/DDATA/%s/%s" % (OTHER_GROUP, GWY, DEV))))
        self.assertTrue(j.matches(parts("spBv1.0/%s/NBIRTH/%s" % (OTHER_GROUP, GWY))))
        self.assertFalse(j.matches(parts("spBv1.0/%s/DDATA/%s/%s" % (OTHER_GROUP, GWY, OTHER_DEV))))


class Buffering(unittest.TestCase):
    def test_the_first_message_defines_the_offset_origin(self):
        j = job()
        j.append("spBv1.0/%s/NDATA/%s" % (GROUP, GWY), wire(), "NDATA")
        j.append("spBv1.0/%s/NDATA/%s" % (GROUP, GWY), wire(), "NDATA")
        self.assertEqual(j.messages[0]["offset_ms"], 0)
        self.assertGreaterEqual(j.messages[1]["offset_ms"], 0)

    def test_the_wire_encoding_is_recorded(self):
        """Playback re-encodes in the encoding a message ARRIVED in; losing it changes the test."""
        j = job()
        j.append("spBv1.0/%s/NDATA/%s" % (GROUP, GWY), wire(), "NDATA")
        self.assertEqual(j.messages[0]["encoding"], capture.ENCODING_PROTOBUF)

        payload = {"timestamp": 1700000000000,
                   "metrics": [{"name": "T", "datatype": 10, "double_value": 1.0}]}
        j.append("spBv1.0/%s/NDATA/%s" % (GROUP, GWY),
                 json.dumps(payload).encode("utf-8"), "NDATA")
        self.assertEqual(j.messages[1]["encoding"], capture.ENCODING_JSON)

    def test_an_undecodable_payload_is_skipped_not_invented(self):
        """A placeholder would replay something the fleet never sent, which is worse than short."""
        j = job()
        self.assertIsNone(j.append("spBv1.0/%s/NDATA/%s" % (GROUP, GWY), b"\xff\xfe not sparkplug",
                                   "NDATA"))
        self.assertEqual(j.messages, [])

    def test_a_birth_sets_birth_captured(self):
        j = job()
        self.assertFalse(j.birth_captured)
        j.append("spBv1.0/%s/NBIRTH/%s" % (GROUP, GWY), wire(seq=0), "NBIRTH")
        self.assertTrue(j.birth_captured)

    def test_ordinary_data_does_not_set_birth_captured(self):
        j = job()
        j.append("spBv1.0/%s/NDATA/%s" % (GROUP, GWY), wire(), "NDATA")
        self.assertFalse(j.birth_captured)


class Caps(unittest.TestCase):
    def test_the_message_cap_stops_the_recording(self):
        j = job(max_messages=2)
        topic = "spBv1.0/%s/NDATA/%s" % (GROUP, GWY)
        self.assertIsNone(j.append(topic, wire(), "NDATA"))
        self.assertIn("message cap", j.append(topic, wire(), "NDATA"))

    def test_the_size_cap_counts_the_serialised_form_not_the_wire(self):
        """
        THE CAP EXISTS TO KEEP THE FILE UNDER THE BUCKET'S LIMIT, so it has to measure the thing
        that gets uploaded. A protobuf payload expands several-fold as JSON -- asserted here rather
        than assumed, because counting `len(raw)` would look correct and let a capture finish at
        several times its stated cap, to be refused at upload with nothing left to retry from.
        """
        j = job()
        raw = wire(metrics=[("Metric_%d" % i, float(i)) for i in range(20)])
        j.append("spBv1.0/%s/NDATA/%s" % (GROUP, GWY), raw, "NDATA")
        self.assertGreater(j.bytes, len(raw),
                           "the JSON form of a capture entry is larger than the protobuf wire form")

    def test_the_size_cap_stops_the_recording(self):
        j = job(max_bytes=200)
        topic = "spBv1.0/%s/NDATA/%s" % (GROUP, GWY)
        reason = None
        for _ in range(20):
            reason = j.append(topic, wire(), "NDATA")
            if reason:
                break
        self.assertIsNotNone(reason, "the size cap never fired")
        self.assertIn("size cap", reason)

    def test_the_caps_default_to_the_schema_bounds(self):
        """A job row missing its caps must not become an unbounded recording."""
        j = capture_worker._JobState({
            "id": "x", "sparkplug_group": GROUP, "edge_node_id": GWY,
            "device_sparkplug_id": None, "storage_path": "p",
        })
        self.assertEqual(j.max_seconds, 7200)
        self.assertEqual(j.max_messages, 100000)
        self.assertEqual(j.max_bytes, 52428800)


class Manifest(unittest.TestCase):
    def test_it_describes_a_file_nobody_has_downloaded(self):
        j = job()
        topic = "spBv1.0/%s/DDATA/%s/%s" % (GROUP, GWY, DEV)
        j.append(topic, wire(metrics=(("Temperature", 1.0), ("Pressure", 2.0))), "DDATA")
        j.append("spBv1.0/%s/NBIRTH/%s" % (GROUP, GWY), wire(metrics=(("Temperature", 3.0),)),
                 "NBIRTH")

        m = capture_worker._manifest(j.messages, j)
        self.assertEqual(sorted(m["metric_names"]), ["Pressure", "Temperature"])
        self.assertEqual(m["topic_count"], 2)
        self.assertTrue(m["birth_captured"])

    def test_metric_names_are_deduplicated_in_first_seen_order(self):
        j = job()
        topic = "spBv1.0/%s/NDATA/%s" % (GROUP, GWY)
        for _ in range(5):
            j.append(topic, wire(metrics=(("B", 1.0), ("A", 2.0))), "NDATA")
        self.assertEqual(capture_worker._manifest(j.messages, j)["metric_names"], ["B", "A"])

    def test_a_capture_with_no_birth_says_so(self):
        """`birth_captured=false` is what stops a file that cannot replay looking like one that can."""
        j = job()
        j.append("spBv1.0/%s/NDATA/%s" % (GROUP, GWY), wire(), "NDATA")
        self.assertFalse(capture_worker._manifest(j.messages, j)["birth_captured"])


class Observe(unittest.TestCase):
    """The hot path. Runs on paho's network thread for every message the fleet publishes."""

    def tearDown(self):
        capture_worker._active = None

    def test_it_is_a_no_op_when_nothing_is_recording(self):
        capture_worker._active = None
        capture_worker.observe("spBv1.0/%s/NDATA/%s" % (GROUP, GWY), wire(),
                               parts("spBv1.0/%s/NDATA/%s" % (GROUP, GWY)))  # must not raise

    def test_it_buffers_a_matching_message(self):
        j = job()
        capture_worker._active = j
        topic = "spBv1.0/%s/NDATA/%s" % (GROUP, GWY)
        capture_worker.observe(topic, wire(), parts(topic))
        self.assertEqual(len(j.messages), 1)

    def test_it_buffers_its_edge_node_under_another_group(self):
        j = job()
        capture_worker._active = j
        topic = "spBv1.0/%s/NDATA/%s" % (OTHER_GROUP, GWY)
        capture_worker.observe(topic, wire(), parts(topic))
        self.assertEqual([m["topic"] for m in j.messages], [topic])

    def test_it_ignores_another_edge_node_under_that_group(self):
        j = job()
        capture_worker._active = j
        topic = "spBv1.0/%s/NDATA/%s" % (OTHER_GROUP, OTHER_GWY)
        capture_worker.observe(topic, wire(), parts(topic))
        self.assertEqual(j.messages, [])

    def test_it_ignores_a_message_for_another_subject(self):
        j = job(device_sparkplug_id=DEV)
        capture_worker._active = j
        topic = "spBv1.0/%s/DDATA/%s/%s" % (GROUP, GWY, OTHER_DEV)
        capture_worker.observe(topic, wire(), parts(topic))
        self.assertEqual(j.messages, [])

    def test_a_met_cap_is_recorded_for_the_worker_thread(self):
        """observe() never stops the job itself: it flags, and the worker finalises on its tick."""
        j = job(max_messages=1)
        capture_worker._active = j
        topic = "spBv1.0/%s/NDATA/%s" % (GROUP, GWY)
        capture_worker.observe(topic, wire(), parts(topic))
        self.assertIn("message cap", j.cap_reason)


class FakeGateways:
    """`supabase_client.table("gateways").select(...).eq(...).execute()`, answering `rows`."""

    def __init__(self, rows=(), error=None):
        self.rows, self.error, self.reads = list(rows), error, []

    def table(self, name):
        self.reads.append([name])
        return self

    def select(self, columns):
        self.reads[-1].append(columns)
        return self

    def eq(self, column, value):
        self.reads[-1].append((column, value))
        return self

    def execute(self):
        if self.error:
            raise self.error
        return SimpleNamespace(data=self.rows)


class TheRebirthRequest(unittest.TestCase):
    """
    A capture opens by asking its edge node to rebirth, through the callable ingestion.py passes to
    start(). An edge node subscribes to NCMD under its own group only (Sparkplug 3.0.0
    tck-id-message-flow-edge-node-ncmd-subscribe, tck-id-topics-ncmd-topic), so a request under
    the configured group is not heard from a node that publishes under another.
    """

    def setUp(self):
        self.client = MagicMock()
        for target, name, value in (
            (ingestion, "build_rebirth_payload", lambda: b"rebirth"),
            # As ingestion.main() wires it.
            (capture_worker, "_rebirth", lambda group, node: ingestion.request_operator_rebirth(
                self.client, group, node)),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        capture_worker._active = None

    def begin(self, gateways, **over):
        with patch.object(ingestion, "supabase_client", gateways):
            state = capture_worker._begin(row(**over))
        return state, [c.args[0] for c in self.client.publish.call_args_list]

    def test_it_goes_to_the_group_the_node_publishes_under(self):
        gateways = FakeGateways([{"observed_sparkplug_group": OTHER_GROUP}])
        state, topics = self.begin(gateways)
        self.assertEqual(topics, ["spBv1.0/%s/NCMD/%s" % (OTHER_GROUP, GWY)])
        self.assertTrue(state.rebirth_requested)
        self.assertEqual(gateways.reads,
                         [["gateways", "observed_sparkplug_group", ("sparkplug_id", GWY)]])

    def test_a_device_capture_asks_its_gateway_in_that_group(self):
        _, topics = self.begin(FakeGateways([{"observed_sparkplug_group": OTHER_GROUP}]),
                               device_sparkplug_id=DEV, storage_path=DEV + "/capture.json")
        self.assertEqual(topics, ["spBv1.0/%s/NCMD/%s" % (OTHER_GROUP, GWY)])

    def test_a_node_with_no_recorded_group_is_asked_under_its_configured_one(self):
        _, topics = self.begin(FakeGateways([{"observed_sparkplug_group": None}]))
        self.assertEqual(topics, ["spBv1.0/%s/NCMD/%s" % (GROUP, GWY)])

    def test_a_failed_read_falls_back_to_the_configured_group(self):
        """An upgrade can run the daemon before db-init has added the column."""
        _, topics = self.begin(FakeGateways(error=RuntimeError("column does not exist")))
        self.assertEqual(topics, ["spBv1.0/%s/NCMD/%s" % (GROUP, GWY)])


class DrainIsExclusive(unittest.TestCase):
    def test_draining_empties_the_buffer(self):
        """
        _finish() clears the active job BEFORE draining, so a message arriving in between is
        dropped rather than serialised twice or half-written. This asserts the drain half.
        """
        j = job()
        topic = "spBv1.0/%s/NDATA/%s" % (GROUP, GWY)
        j.append(topic, wire(), "NDATA")
        drained = j.drain()
        self.assertEqual(len(drained), 1)
        self.assertEqual(j.messages, [])


def unstamped_wire():
    """A protobuf payload from a publisher that sends no clock: neither the message nor its metric."""
    p = sparkplug_b_pb2.Payload()
    m = p.metrics.add()
    m.name = "Temperature"
    m.datatype = 10
    m.double_value = 21.5
    return p.SerializeToString()


class TheCaptureEpoch(unittest.TestCase):
    """
    A capture is rebased from its epoch, and the offsets count from the first message's RECEIPT.
    A first message with no payload clock must take that receipt as its epoch: taking the time the
    recording ended files every stamped reading early by the length of the recording.
    """

    RECEIVED_S = 1_800_000_000.0
    FINISHED_S = RECEIVED_S + 2 * 3600

    def _finished(self, raw):
        j = job()
        topic = "spBv1.0/%s/NDATA/%s" % (GROUP, GWY)
        with patch.object(capture_worker.time, "time", return_value=self.RECEIVED_S):
            j.append(topic, raw, "NDATA")
        uploads = []
        storage = MagicMock()
        storage.from_.return_value.upload.side_effect = lambda **kw: uploads.append(kw)
        with patch.object(capture_worker, "_storage", storage), \
                patch.object(capture_worker, "_supabase", MagicMock()), \
                patch.object(capture_worker.time, "time", return_value=self.FINISHED_S):
            capture_worker._finish(j, "duration reached")
        self.assertEqual(len(uploads), 1, "the capture was not stored")
        return json.loads(uploads[0]["file"])

    def test_a_first_message_with_no_clock_is_rebased_from_its_receipt(self):
        document = self._finished(unstamped_wire())
        self.assertEqual(document["capture_epoch_ms"], int(self.RECEIVED_S * 1000))

    def test_a_first_message_with_a_zero_clock_is_rebased_from_its_receipt(self):
        document = self._finished(wire(timestamp=0))
        self.assertEqual(document["capture_epoch_ms"], int(self.RECEIVED_S * 1000))

    def test_a_first_message_with_a_clock_is_rebased_from_it(self):
        document = self._finished(wire(timestamp=1700000000000))
        self.assertEqual(document["capture_epoch_ms"], 1700000000000)

    def test_a_reading_stamped_later_lands_where_it_was_taken(self):
        # The first message carries no clock; a later one carries its device's. Rebased from the
        # receipt, a reading stamped 30 s after the first message plays 30 s after the start.
        document = self._finished(unstamped_wire())
        epoch = document["capture_epoch_ms"]
        later = {"timestamp": epoch + 30_000, "metrics": [
            {"name": "Temperature", "timestamp": epoch + 30_000, "double_value": 22.0}]}
        moved = capture.rebase_payload(later, epoch, 1_900_000_000_000)
        self.assertEqual(moved["metrics"][0]["timestamp"], 1_900_000_030_000)


class TheWindowIsTheDaemons(unittest.TestCase):
    """
    capture.py restates the daemon's timestamp window and must not import the daemon, so this suite
    (which can) holds the two together: the three bounds, and the verdict on what each puts on the
    wire.
    """

    def test_the_bounds_are_the_daemons(self):
        for name in ("TELEMETRY_MAX_AGE_SECONDS", "TELEMETRY_MAX_FUTURE_SECONDS",
                     "TELEMETRY_MAX_HISTORICAL_AGE_SECONDS"):
            self.assertEqual(getattr(capture, name), getattr(ingestion, name), name)

    def test_a_stamp_is_judged_as_the_daemon_judges_it(self):
        now = datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc)
        now_ms = int(now.timestamp() * 1000)
        bounds = (ingestion.TELEMETRY_MAX_AGE_SECONDS, ingestion.TELEMETRY_MAX_HISTORICAL_AGE_SECONDS,
                  -ingestion.TELEMETRY_MAX_FUTURE_SECONDS)
        offsets = sorted({-bound + step for bound in bounds for step in (-1, 0, 1)} | {0, 8 * 86400})
        for historical in (False, True):
            for ahead in offsets:
                stamp = now + timedelta(seconds=ahead)
                expected = ingestion.timestamp_refusal(stamp, historical, now) is None
                got = capture.timestamp_is_sane(int(stamp.timestamp() * 1000), now_ms, historical)
                self.assertEqual(got, expected, "historical=%s, %+ds from now" % (historical, ahead))

    @staticmethod
    def _daemon_drops(plan, now_ms):
        """The metrics the daemon's window drops from what the plan puts on the wire."""
        dropped = 0
        for delay_ms, _topic, raw, _ in plan:
            arrives = datetime.fromtimestamp((now_ms + delay_ms) / 1000.0, timezone.utc)
            payload, _encoding = capture.decode_wire_payload(raw)
            payload_ts = payload.timestamp if payload.timestamp > 0 else int(arrives.timestamp() * 1000)
            payload_dt = datetime.fromtimestamp(payload_ts / 1000.0, timezone.utc)
            for metric in payload.metrics:
                if metric.HasField("timestamp") and metric.timestamp > 0:
                    stamped = datetime.fromtimestamp(metric.timestamp / 1000.0, timezone.utc)
                else:
                    stamped = payload_dt
                if ingestion.timestamp_refusal(stamped, ingestion.is_historical(metric), arrives):
                    dropped += 1
        return dropped

    def test_a_plan_is_judged_as_the_daemon_will_judge_it_at_every_speed(self):
        epoch, now_ms, hour = 1_700_000_000_000, 1_800_000_000_000, 3600 * 1000
        gateway, device, mapped = "gwy" + "1" * 21, "dev" + "2" * 21, "dev" + "3" * 21
        stamps = (
            (0, False), (-20 * 60 * 1000, False), (4_000, False), (-30 * hour, False),
            (-30 * hour, True), (-8 * 24 * hour, True), (6 * 60 * 1000, True), (-6 * 24 * hour, True),
        )
        messages = []
        for offset in (0, 60_000, 3_600_000):
            for stamp, historical in stamps:
                metric = {"name": "Systems/T", "timestamp": epoch + offset + stamp, "double_value": 1.0}
                if historical:
                    metric["is_historical"] = True
                messages.append({
                    "offset_ms": offset, "topic": "spBv1.0/Aber/DDATA/%s/%s" % (gateway, device),
                    "payload": {"timestamp": epoch + offset, "metrics": [metric]},
                })
        # A replay opens with the node's birth and the device's (capture.plan_playback()).
        births = [{"offset_ms": 0, "topic": "spBv1.0/Aber/%s/%s" % (kind, path),
                   "payload": {"timestamp": epoch, "metrics": []}}
                  for kind, path in (("NBIRTH", gateway), ("DBIRTH", gateway + "/" + device))]
        document = {
            "aber_capture_version": capture.CAPTURE_VERSION, "capture_epoch_ms": epoch,
            "messages": births + sorted(messages, key=lambda m: m["offset_ms"]),
        }
        for speed in (0.01, 0.1, 1.0, 10.0):
            for encoding in (capture.ENCODING_PROTOBUF, capture.ENCODING_JSON):
                for entry in document["messages"]:
                    entry["encoding"] = encoding
                plan = capture.plan_playback(document, gateway, {device: mapped}, now_ms, speed=speed)
                expected = self._daemon_drops(plan, now_ms)
                self.assertEqual(capture.window_outcome(plan, now_ms)[2], expected,
                                 "speed %s, %s" % (speed, encoding))
                if speed == 1.0:
                    self.assertGreater(expected, 0, "the fixture drops nothing, so proves little")


if __name__ == "__main__":
    unittest.main()
