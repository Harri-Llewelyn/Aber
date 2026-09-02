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
import unittest

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


GROUP = "ACS-Cymru"
GWY = "gwy120000000000400080000"
DEV = "dev270000000000400080000"
OTHER_DEV = "dev990000000000400080000"


def job(**over):
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
    return capture_worker._JobState(base)


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

    def test_a_gateway_capture_ignores_another_sparkplug_group(self):
        j = job()
        self.assertFalse(j.matches(parts("spBv1.0/OtherGroup/NDATA/%s" % GWY)))

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
        self.assertFalse(j.matches(parts("spBv1.0/%s/NBIRTH/gwy999999999999999999999" % GROUP)))


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


if __name__ == "__main__":
    unittest.main()
