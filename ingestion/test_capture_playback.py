"""
Unit tests for broker capture and playback (capture.py).

WHAT THIS PROTECTS, IN ORDER OF HOW BADLY IT FAILS. Every failure in this file is SILENT in
production -- there is no exception, no log line and no error count, only an empty historian --
which is why they are asserted here rather than left to a live run to reveal.

  1. THE IDENTITY REWRITE. The broker's roles confine a client to `spBv1.0/+/+/<sparkplug_id>/#`, and a publish
     outside that is dropped by the broker with no PUBACK at QoS 0. A playback that failed to
     rewrite the edge-node segment would connect, publish every message, report success, and move
     nothing. validate.py has already had this exact run.

  2. THE ASSET_ID REWRITE. Rewriting the topic and NOT the payload's Asset_ID claim is worse than
     rewriting neither: the message arrives, resolve_wire_identity() sees the topic and the claim
     disagree, and every device the playback creates is quarantined. That reads as a fleet problem.

  3. METRIC TIMESTAMPS. process_ddata() judges `metric.timestamp` and only falls back to the
     payload's when the metric has none. Rebasing the payload alone leaves every metric on the
     capture's clock, where `_timestamp_is_sane()` drops it -- again, silently, as a count.

  4. HasField FIDELITY. `seq` and `alias` are tested with HasField all through the daemon, so a
     round trip that materialises an absent field as 0 turns "sends no sequence number" into
     "sent sequence 0" -- a legitimate wrap, which masks a real gap.

capture.py deliberately imports neither supabase nor psycopg, so unlike the other suites here this
one needs no stubbing of its own -- but it does have to UNDO theirs, see below.
"""
import json
import os
import sys
import unittest

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

# =============================================================================================
# THIS SUITE NEEDS THE REAL GENERATED PROTOBUF, AND ITS SIBLINGS REPLACE IT WITH `object`.
#
# The pure-logic suites here stub `sparkplug_b_pb2` with `Payload=object` so they do not require
# `protoc` to have been run. They install it with `sys.modules.setdefault`, so whichever module
# loads first wins for the whole process -- and under `unittest discover` this file is imported
# after test_archived_gateway and test_audit_write_dedup, which means `capture` would bind their
# stub and every encoding test here would fail with "'object' object has no attribute
# 'timestamp'". Run on its own the file passed, which is exactly how an order-dependent suite
# hides.
#
# This one genuinely cannot use the stub: what it asserts is that a real payload survives a round
# trip through the capture format, and `object` has no fields to survive.
#
# So the stub is lifted for the duration of these two imports and then HANDED BACK, because the
# siblings' reason for it is still good and they are entitled to it. Only a stub is ever
# displaced: if `sparkplug_b_pb2` is already the real module, it is left alone -- re-importing a
# generated protobuf module registers its descriptors a second time and raises.
# =============================================================================================
#
# DROPPING THE STUB IS NOT ENOUGH, AND THE REASON IS THE IMPORT GRAPH. ingestion.py imports
# `capture_worker`, which imports `capture`, so by the time this file runs a sibling that imported
# the daemon has ALREADY loaded `capture` bound to the stub, and `import capture` below would hand
# back that cached module. Every encoding test then fails with "'object' object has no attribute
# 'timestamp'", from a cause one import away.
#
# Neither module registers protobuf descriptors of its own, so re-importing them is free -- unlike
# the generated module, which is why only a STUB of that is ever displaced.
_installed = sys.modules.get("sparkplug_b_pb2")
_is_stub = _installed is not None and getattr(_installed, "Payload", None) is object
if _is_stub:
    del sys.modules["sparkplug_b_pb2"]
    for _bound in ("capture", "capture_worker"):
        sys.modules.pop(_bound, None)

import sparkplug_b_pb2  # noqa: E402  (the real generated module, not the siblings' stub)
import capture  # noqa: E402  (must follow, so it binds the real one)

if _is_stub:
    sys.modules["sparkplug_b_pb2"] = _installed


GW = "gwy110000000000400080000"
DEV_A = "dev220000000000400080000"
DEV_B = "dev330000000000400080000"
CAPTURED_GW = "gwy990000000000400080000"
CAPTURED_DEV = "dev880000000000400080000"

EPOCH = 1_700_000_000_000  # the capture's own clock
NOW = 1_800_000_000_000    # playback's


def message(offset_ms, msg_type, device=CAPTURED_DEV, metrics=None, **payload):
    topic = "spBv1.0/Aber/%s/%s" % (msg_type, CAPTURED_GW)
    if device:
        topic += "/" + device
    body = {"timestamp": EPOCH + offset_ms, "metrics": metrics or []}
    body.update(payload)
    return {"offset_ms": offset_ms, "topic": topic, "payload": body}


def capture_file(messages=None):
    messages = messages if messages is not None else [message(0, "DDATA")]
    return {
        "acs_capture_version": capture.CAPTURE_VERSION,
        "recorded_at": "2026-08-27T12:00:00+00:00",
        "capture_epoch_ms": EPOCH,
        "duration_ms": messages[-1]["offset_ms"],
        "identities": {"edge_nodes": [CAPTURED_GW], "devices": [CAPTURED_DEV]},
        "messages": messages,
    }


DEFAULT_MAP = {CAPTURED_DEV: DEV_A}


class PayloadRoundTripTests(unittest.TestCase):
    """protobuf -> dict -> protobuf, which is what a capture file is."""

    def _round_trip(self, payload):
        data = capture.payload_to_dict(payload)
        restored = sparkplug_b_pb2.Payload()
        restored.ParseFromString(capture.dict_to_payload_bytes(data))
        return data, restored

    def test_carries_every_value_field(self):
        # A field missing from VALUE_FIELDS is a value the recorder reads and never writes down,
        # producing a capture whose metrics play back with no value at all.
        payload = sparkplug_b_pb2.Payload()
        payload.timestamp = EPOCH
        for name, field, value in (
            ("s", "string_value", "ACTIVE"),
            ("d", "double_value", 42.5),
            ("f", "float_value", 1.5),
            ("b", "boolean_value", True),
            ("i", "int_value", 7),
            ("l", "long_value", 2 ** 40),
        ):
            m = payload.metrics.add()
            m.name = name
            setattr(m, field, value)

        _, restored = self._round_trip(payload)
        by_name = {m.name: m for m in restored.metrics}
        self.assertEqual(by_name["s"].string_value, "ACTIVE")
        self.assertEqual(by_name["d"].double_value, 42.5)
        self.assertAlmostEqual(by_name["f"].float_value, 1.5, places=5)
        self.assertIs(by_name["b"].boolean_value, True)
        self.assertEqual(by_name["i"].int_value, 7)
        self.assertEqual(by_name["l"].long_value, 2 ** 40)

    def test_an_absent_seq_stays_absent(self):
        # THE HasField TRAP. check_message_sequence() tests HasField('seq'); a materialised 0
        # reads as a legitimate wrap and hides a real gap.
        payload = sparkplug_b_pb2.Payload()
        payload.timestamp = EPOCH
        data, restored = self._round_trip(payload)
        self.assertNotIn("seq", data)
        self.assertFalse(restored.HasField("seq"))

    def test_a_seq_of_zero_survives(self):
        # The other half of the same trap: 0 is a REAL sequence number (a birth), so a reader
        # that treated falsy as absent would drop it.
        payload = sparkplug_b_pb2.Payload()
        payload.timestamp = EPOCH
        payload.seq = 0
        data, restored = self._round_trip(payload)
        self.assertEqual(data["seq"], 0)
        self.assertTrue(restored.HasField("seq"))

    def test_an_absent_alias_stays_absent(self):
        # resolve_metric_name() tests HasField('alias'). A materialised alias 0 would send a
        # named metric down the alias-resolution path and have it fail to resolve.
        payload = sparkplug_b_pb2.Payload()
        m = payload.metrics.add()
        m.name = "Systems/TEMPERATURE"
        m.double_value = 20.0
        data, restored = self._round_trip(payload)
        self.assertNotIn("alias", data["metrics"][0])
        self.assertFalse(restored.metrics[0].HasField("alias"))

    def test_an_alias_only_metric_keeps_no_name(self):
        # What a real gateway publishes after birthing. A name materialised here would make the
        # capture less realistic than the traffic it came from, and would bypass the alias table.
        payload = sparkplug_b_pb2.Payload()
        m = payload.metrics.add()
        m.alias = 3
        m.double_value = 20.0
        data, restored = self._round_trip(payload)
        self.assertNotIn("name", data["metrics"][0])
        self.assertFalse(restored.metrics[0].HasField("name"))
        self.assertEqual(restored.metrics[0].alias, 3)


class IdentityRewriteTests(unittest.TestCase):

    def test_the_edge_node_segment_becomes_the_playback_gateway(self):
        # FAILURE 1. Without this the broker discards every publish and says nothing.
        topic, _ = capture.rewrite_identity(
            "spBv1.0/Aber/DDATA/%s/%s" % (CAPTURED_GW, CAPTURED_DEV),
            {"metrics": []}, GW, DEFAULT_MAP,
        )
        self.assertEqual(topic, "spBv1.0/Aber/DDATA/%s/%s" % (GW, DEV_A))

    def test_a_node_topic_keeps_its_four_segments(self):
        # NBIRTH/NDATA/NDEATH carry no device. Appending one would make process_node_message()
        # unreachable for the capture's gateway heartbeats.
        topic, _ = capture.rewrite_identity(
            "spBv1.0/Aber/NBIRTH/%s" % CAPTURED_GW, {"metrics": []}, GW, {},
        )
        self.assertEqual(topic, "spBv1.0/Aber/NBIRTH/%s" % GW)

    def test_the_asset_id_claim_is_rewritten_with_the_topic(self):
        # FAILURE 2. A topic and a claim that disagree is the definition of a faulty identity.
        _, payload = capture.rewrite_identity(
            "spBv1.0/Aber/DBIRTH/%s/%s" % (CAPTURED_GW, CAPTURED_DEV),
            {"metrics": [{"name": "Asset_ID", "string_value": CAPTURED_DEV}]},
            GW, DEFAULT_MAP,
        )
        self.assertEqual(payload["metrics"][0]["string_value"], DEV_A)

    def test_no_asset_id_is_invented_for_an_aliased_ddata(self):
        # An optimised gateway does not repeat identity on every message; the topic is the only
        # identity available. Adding one would make playback unrepresentative of real traffic.
        _, payload = capture.rewrite_identity(
            "spBv1.0/Aber/DDATA/%s/%s" % (CAPTURED_GW, CAPTURED_DEV),
            {"metrics": [{"alias": 3, "double_value": 20.0}]}, GW, DEFAULT_MAP,
        )
        self.assertEqual(len(payload["metrics"]), 1)
        self.assertNotIn("string_value", payload["metrics"][0])

    def test_an_unmapped_device_is_refused(self):
        # Passing it through would address an asset the playback gateway does not own -- dropped
        # by the broker, silently. Refusing names the device that needs a --map.
        with self.assertRaises(capture.CaptureError) as ctx:
            capture.rewrite_identity(
                "spBv1.0/Aber/DDATA/%s/%s" % (CAPTURED_GW, CAPTURED_DEV),
                {"metrics": []}, GW, {},
            )
        self.assertIn(CAPTURED_DEV, str(ctx.exception))

    def test_the_source_payload_is_not_mutated(self):
        # Replaying one capture at two speeds must not have the first run edit the second's source.
        source = {"metrics": [{"name": "Asset_ID", "string_value": CAPTURED_DEV}]}
        capture.rewrite_identity(
            "spBv1.0/Aber/DBIRTH/%s/%s" % (CAPTURED_GW, CAPTURED_DEV),
            source, GW, DEFAULT_MAP,
        )
        self.assertEqual(source["metrics"][0]["string_value"], CAPTURED_DEV)

    def test_the_group_is_preserved_by_default(self):
        # Not rewritten silently: resolve_gateway() scopes by group, so a capture from another
        # group should fail the binding check loudly rather than be relabelled into passing.
        topic, _ = capture.rewrite_identity(
            "spBv1.0/Other-Group/DDATA/%s/%s" % (CAPTURED_GW, CAPTURED_DEV),
            {"metrics": []}, GW, DEFAULT_MAP,
        )
        self.assertTrue(topic.startswith("spBv1.0/Other-Group/"))


class RebaseTests(unittest.TestCase):

    def test_the_payload_clock_moves_onto_playback(self):
        out = capture.rebase_payload({"timestamp": EPOCH + 5000, "metrics": []}, EPOCH, NOW)
        self.assertEqual(out["timestamp"], NOW + 5000)

    def test_metric_timestamps_move_too(self):
        # FAILURE 3. The daemon judges the METRIC's timestamp. Moving only the payload leaves
        # every metric on the capture's clock, where the sanity window drops it as a count.
        out = capture.rebase_payload(
            {"timestamp": EPOCH, "metrics": [{"name": "t", "timestamp": EPOCH + 250}]},
            EPOCH, NOW,
        )
        self.assertEqual(out["metrics"][0]["timestamp"], NOW + 250)

    def test_a_metric_without_a_timestamp_does_not_gain_one(self):
        # process_ddata() falls back to the payload's for exactly this case. Materialising one
        # would write a timestamp the original publisher never sent.
        out = capture.rebase_payload(
            {"timestamp": EPOCH, "metrics": [{"name": "t", "double_value": 1.0}]}, EPOCH, NOW,
        )
        self.assertNotIn("timestamp", out["metrics"][0])

    def test_speed_compresses_the_intervals_uniformly(self):
        out = capture.rebase_payload(
            {"timestamp": EPOCH + 10_000,
             "metrics": [{"name": "t", "timestamp": EPOCH + 20_000}]},
            EPOCH, NOW, speed=10.0,
        )
        self.assertEqual(out["timestamp"], NOW + 1_000)
        self.assertEqual(out["metrics"][0]["timestamp"], NOW + 2_000)

    def test_intervals_survive_the_round_trip_at_speed_one(self):
        # The one property playback exists to preserve, stated as a property rather than a value.
        first = capture.rebase_payload({"timestamp": EPOCH, "metrics": []}, EPOCH, NOW)
        later = capture.rebase_payload({"timestamp": EPOCH + 37_123, "metrics": []}, EPOCH, NOW)
        self.assertEqual(later["timestamp"] - first["timestamp"], 37_123)

    def test_a_speed_of_zero_is_refused(self):
        with self.assertRaises(capture.CaptureError):
            capture.rebase_payload({"timestamp": EPOCH, "metrics": []}, EPOCH, NOW, speed=0)


class PlanTests(unittest.TestCase):

    def _plan(self, **kwargs):
        params = dict(
            capture=capture_file(), gateway_id=GW, device_map=DEFAULT_MAP,
            play_epoch_ms=NOW, speed=1.0,
        )
        params.update(kwargs)
        return capture.plan_playback(**params)

    def test_a_plan_carries_delay_topic_and_encoded_bytes(self):
        plan = self._plan()
        delay_ms, topic, payload_bytes, payload = plan[0]
        self.assertEqual(delay_ms, 0)
        self.assertIn(GW, topic)
        # Re-encoded protobuf is what goes on the wire, so a real gateway and a playback are the
        # same encoding downstream.
        decoded = sparkplug_b_pb2.Payload()
        decoded.ParseFromString(payload_bytes)
        self.assertEqual(decoded.timestamp, NOW)
        self.assertEqual(payload["timestamp"], NOW)

    def test_delays_are_divided_by_speed(self):
        plan = self._plan(
            capture=capture_file([message(0, "DDATA"), message(60_000, "DDATA")]), speed=60.0,
        )
        self.assertEqual([d for d, _, _, _ in plan], [0, 1000])

    def test_an_unknown_capture_version_is_refused(self):
        bad = capture_file()
        bad["acs_capture_version"] = 99
        with self.assertRaises(capture.CaptureError) as ctx:
            self._plan(capture=bad)
        self.assertIn("99", str(ctx.exception))

    def test_a_gateway_id_of_the_wrong_shape_is_refused(self):
        # sparkplug_id is a GENERATED column, so a friendly name cannot be one -- and passing it
        # through would be dropped by the broker rather than reported.
        for bad_id in ("Sim_Gateway_Cell1", "gwy110000000000400080000extra", DEV_A, ""):
            with self.assertRaises(capture.CaptureError):
                self._plan(gateway_id=bad_id)

    def test_a_device_mapped_onto_a_non_device_id_is_refused(self):
        with self.assertRaises(capture.CaptureError):
            self._plan(device_map={CAPTURED_DEV: "Press_01"})

    def test_an_empty_capture_is_refused(self):
        empty = capture_file()
        empty["messages"] = []
        with self.assertRaises(capture.CaptureError):
            self._plan(capture=empty)

    def test_a_group_override_applies_to_every_message(self):
        plan = self._plan(group="Replay-Lab")
        self.assertTrue(plan[0][1].startswith("spBv1.0/Replay-Lab/"))
        self.assertIn(DEV_A, plan[0][1])

    def test_two_devices_map_independently(self):
        msgs = [message(0, "DDATA", device=CAPTURED_DEV), message(10, "DDATA", device=DEV_B)]
        plan = self._plan(
            capture=capture_file(msgs), device_map={CAPTURED_DEV: DEV_A, DEV_B: DEV_B},
        )
        self.assertIn(DEV_A, plan[0][1])
        self.assertIn(DEV_B, plan[1][1])


class SanityWindowTests(unittest.TestCase):
    """
    The check that catches a playback which would report success and write nothing.

    THE FIRST VERSION OF THIS SUITE ASSERTED THE OPPOSITE OF THE TRUTH and the tests caught it,
    so the corrected property is pinned here rather than merely fixed: no choice of --speed can
    put a message outside the window, because rebase_payload() and the scheduler divide by the
    same number. What survives rebasing is a timestamp's distance from the capture epoch, so that
    distance is the only thing that can be out of range.
    """

    def test_a_normal_playback_has_nothing_out_of_window(self):
        plan = capture.plan_playback(
            capture_file([message(0, "DDATA"), message(30_000, "DDATA")]),
            GW, DEFAULT_MAP, NOW, speed=1.0,
        )
        self.assertEqual(capture.unsane_timestamps(plan, NOW), [])

    def test_no_speed_can_push_a_message_out_of_window(self):
        # THE PROPERTY, NOT AN EXAMPLE. An hour of capture from a ten-hour crawl to a 600x
        # sprint: the send delay and the timestamp move together, so the offset at send is
        # always zero. A future change that rebased against wall time instead of the shared
        # divisor would break this at both extremes.
        long_capture = capture_file([message(0, "DDATA"), message(3_600_000, "DDATA")])
        for speed in (0.1, 0.5, 1.0, 60.0, 600.0):
            plan = capture.plan_playback(long_capture, GW, DEFAULT_MAP, NOW, speed=speed)
            self.assertEqual(
                capture.unsane_timestamps(plan, NOW), [],
                "speed %r put a message outside the window" % speed,
            )

    def test_a_reading_older_than_the_window_is_caught(self):
        # The case that IS real: a metric stamped 25 hours before the capture epoch stays 25
        # hours behind after rebasing, and the daemon drops it as a count rather than an error.
        stale = capture_file([message(0, "DDATA", metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": EPOCH - 25 * 3600 * 1000,
             "double_value": 20.0},
        ])])
        plan = capture.plan_playback(stale, GW, DEFAULT_MAP, NOW)
        self.assertEqual(len(capture.unsane_timestamps(plan, NOW)), 1)

    def test_a_hand_edited_future_timestamp_is_caught(self):
        # Hand-editing is a feature of this tool, so the mistake it invites is checked for.
        edited = capture_file([message(0, "DDATA", metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": EPOCH + 6 * 60 * 1000,
             "double_value": 20.0},
        ])])
        plan = capture.plan_playback(edited, GW, DEFAULT_MAP, NOW)
        self.assertEqual(len(capture.unsane_timestamps(plan, NOW)), 1)

    # -----------------------------------------------------------------------------------------
    # WHOSE CLOCK IS JUDGED, which is process_ddata()'s rule and not an obvious one. A metric is
    # judged on its own timestamp and falls back to the payload's only when it has none -- so
    # reading the payload clock as a verdict of its own over-reports, and now that the worker
    # refuses a total loss, over-reporting refuses a capture the daemon would have written.
    # -----------------------------------------------------------------------------------------
    def test_a_metric_with_its_own_timestamp_is_not_judged_by_the_payloads(self):
        # THE CASE THE DAEMON'S PER-METRIC RULE EXISTS FOR: an edge node with a skewed clock
        # stamping the payload, each metric carrying the device's own time. Nothing is lost, and a
        # check that read the payload clock would have called this a total no-op.
        skewed = capture_file([message(0, "DDATA", timestamp=EPOCH - 25 * 3600 * 1000, metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": EPOCH, "double_value": 20.0},
        ])])
        plan = capture.plan_playback(skewed, GW, DEFAULT_MAP, NOW)
        self.assertEqual(capture.unsane_timestamps(plan, NOW), [])
        self.assertEqual(capture.window_outcome(plan, NOW)[1:], (1, 0))

    def test_a_metric_without_a_timestamp_takes_the_payloads(self):
        # The other half of the same rule: the fallback is real, so a skewed payload clock DOES
        # cost every metric that has none of its own.
        skewed = capture_file([message(0, "DDATA", timestamp=EPOCH - 25 * 3600 * 1000, metrics=[
            {"name": "Systems/TEMPERATURE", "double_value": 20.0},
        ])])
        plan = capture.plan_playback(skewed, GW, DEFAULT_MAP, NOW)
        self.assertEqual(len(capture.unsane_timestamps(plan, NOW)), 1)

    def test_a_zero_timestamp_is_no_timestamp(self):
        # `HasField` plus `> 0` is the daemon's test, so a zero already means "use the payload's".
        # Rebasing it would manufacture one -- NOW minus the capture epoch, decades adrift -- and
        # turn a reading the daemon files under the payload clock into one it drops.
        zeroed = capture_file([message(0, "DDATA", metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": 0, "double_value": 20.0},
        ])])
        plan = capture.plan_playback(zeroed, GW, DEFAULT_MAP, NOW)
        self.assertEqual(plan[0][3]["metrics"][0]["timestamp"], 0, "rebasing moved a zero")
        self.assertEqual(capture.unsane_timestamps(plan, NOW), [])

    def test_a_payload_without_a_clock_is_stamped_on_arrival(self):
        # payload_ts falls back to the receive time in the daemon, which is in window by
        # construction. Nothing here is out of range, and nothing may be reported as though it is.
        unstamped = capture_file([message(0, "DDATA", timestamp=None, metrics=[
            {"name": "Systems/TEMPERATURE", "double_value": 20.0},
        ])])
        plan = capture.plan_playback(unstamped, GW, DEFAULT_MAP, NOW)
        self.assertIsNone(plan[0][3]["timestamp"], "rebasing materialised a payload clock")
        self.assertEqual(capture.unsane_timestamps(plan, NOW), [])

    def test_a_message_that_loses_one_metric_keeps_the_other(self):
        # WHY THE COUNTS ARE METRICS AND THE LIST IS MESSAGES. This message is lossy AND writes a
        # reading. A refusal keyed on "every message is lossy" would call it a no-op.
        mixed = capture_file([message(0, "DDATA", metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": EPOCH - 25 * 3600 * 1000,
             "double_value": 20.0},
            {"name": "Systems/PRESSURE", "timestamp": EPOCH, "double_value": 3.0},
        ])])
        plan = capture.plan_playback(mixed, GW, DEFAULT_MAP, NOW)
        lossy, kept, dropped = capture.window_outcome(plan, NOW)
        self.assertEqual((len(lossy), kept, dropped), (1, 1, 1))

    def test_the_window_matches_the_daemons(self):
        # Restated rather than imported, so it is pinned against drift from ingestion.py.
        self.assertEqual(capture.TELEMETRY_MAX_AGE_SECONDS, 24 * 60 * 60)
        self.assertEqual(capture.TELEMETRY_MAX_FUTURE_SECONDS, 5 * 60)
        self.assertTrue(capture.timestamp_is_sane(NOW, NOW))
        self.assertFalse(capture.timestamp_is_sane(NOW - 25 * 3600 * 1000, NOW))
        self.assertFalse(capture.timestamp_is_sane(NOW + 6 * 60 * 1000, NOW))


class TopicAndMapTests(unittest.TestCase):

    def test_a_non_sparkplug_topic_raises(self):
        # A corrupted capture should stop the run: skipping would play back a subset while
        # reporting a whole.
        for bad in ("factory/line1/temp", "spBv1.0/group/DDATA", ""):
            with self.assertRaises(capture.CaptureError):
                capture.split_topic(bad)

    def test_identities_are_listed_in_first_seen_order_without_duplicates(self):
        msgs = [
            message(0, "NBIRTH", device=None),
            message(1, "DDATA", device=CAPTURED_DEV),
            message(2, "DDATA", device=DEV_B),
            message(3, "DDATA", device=CAPTURED_DEV),
        ]
        edge_nodes, devices = capture.capture_identities(msgs)
        self.assertEqual(edge_nodes, [CAPTURED_GW])
        self.assertEqual(devices, [CAPTURED_DEV, DEV_B])

    def test_parse_device_map_reads_pairs(self):
        self.assertEqual(
            capture.parse_device_map(["%s=%s" % (CAPTURED_DEV, DEV_A)]), {CAPTURED_DEV: DEV_A},
        )

    def test_parse_device_map_refuses_a_conflicting_duplicate(self):
        # Last-wins would silently send half a device's traffic somewhere the operator did not ask.
        with self.assertRaises(capture.CaptureError):
            capture.parse_device_map(
                ["%s=%s" % (CAPTURED_DEV, DEV_A), "%s=%s" % (CAPTURED_DEV, DEV_B)]
            )

    def test_parse_device_map_refuses_a_malformed_pair(self):
        for bad in ["nodelimiter", "=dev1", "dev1="]:
            with self.assertRaises(capture.CaptureError):
                capture.parse_device_map([bad])


class CaptureFileShapeTests(unittest.TestCase):

    def test_a_capture_is_json_serialisable_and_reloads_identically(self):
        # Hand-editing is half the point of the feature, so the file has to survive a round trip
        # through a text editor's idea of JSON.
        original = capture_file([message(0, "DDATA", metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": EPOCH, "double_value": 42.5,
             "datatype": 10},
        ])])
        reloaded = json.loads(json.dumps(original))
        self.assertEqual(reloaded, original)
        plan = capture.plan_playback(reloaded, GW, DEFAULT_MAP, NOW)
        self.assertEqual(len(plan), 1)

    def test_a_hand_edited_value_reaches_the_wire(self):
        # THE FEATURE'S WHOLE POINT: reproduce a fault by editing a number. If this stops being
        # true the tool is only a recorder.
        edited = capture_file([message(0, "DDATA", metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": EPOCH, "double_value": 999.9,
             "datatype": 10},
        ])])
        _, _, payload_bytes, _ = capture.plan_playback(edited, GW, DEFAULT_MAP, NOW)[0]
        decoded = sparkplug_b_pb2.Payload()
        decoded.ParseFromString(payload_bytes)
        self.assertEqual(decoded.metrics[0].double_value, 999.9)


# =============================================================================================
# WHAT THE WORKER DOES WITH THE COUNT unsane_timestamps() RETURNS (#216).
#
# The tests above assert that the count is RIGHT. These assert what is done with it, which is a
# separate decision and the one that was wrong: the daemon answers an out-of-window metric with a
# counter rather than an error, nothing travels back to the publisher, and so a playback every one
# of whose timestamps would be discarded published its whole capture, was recorded COMPLETED with
# the full `messages_sent`, and wrote nothing to the historian.
#
# NO BROKER AND NO SUPABASE HERE, WHICH IS WHY THESE LIVE IN THE UNIT LANE. The refusal is reached
# before `_connect`, from the plan alone -- so a stub storage client and a capture with stale
# timestamps are the whole fixture. The replay suite (test_playback_replay.py, stack lane) covers
# the path where a real worker publishes to a real broker; it cannot cheaply build a capture the
# daemon will reject in full, and would not prove the decision if it could.
# =============================================================================================
class WorkerOutOfWindowTests(unittest.TestCase):

    def setUp(self):
        # NO BROKER MAY BE REACHED FROM THESE TESTS, and leaving that to chance is not enough. Two
        # of them deliberately get past the refusal and on to `_connect`, and on a host where
        # `mosquitto` resolves -- in-cluster, or a developer with an /etc/hosts entry -- that would
        # publish a fixture capture into a real stack. Pointed at a name reserved by RFC 2606 to
        # resolve nowhere, so the connection fails everywhere for the same reason.
        worker = self._worker()
        self._host = worker.MQTT_HOST
        worker.MQTT_HOST = "broker.invalid"

    def tearDown(self):
        self._worker().MQTT_HOST = self._host

    @staticmethod
    def _worker():
        import playback_worker
        return playback_worker

    @staticmethod
    def _job():
        """A claimed job, as `playback_claim_job()` hands one over."""
        return {
            "id": "00000000-0000-4000-8000-0000000000aa",
            "target_edge_node_id": GW,
            "capture_storage_path": "captures/fixture.json",
            "device_map": DEFAULT_MAP,
            "speed": 1.0,
            "sparkplug_group": None,
        }

    class _Storage:
        """Enough of the storage client for `_run_job` to read one capture."""

        def __init__(self, document):
            self._body = json.dumps(document).encode("utf-8")

        def from_(self, _bucket):
            return self

        def download(self, _path):
            return self._body

    def _run(self, document):
        worker = self._worker()
        return worker._run_job(
            supabase=None, storage=self._Storage(document),
            credentials={GW: "a-password"}, job=self._job(),
        )

    @staticmethod
    def _stale(offset_ms, count=1):
        """`count` messages, every metric stamped a day and an hour before the capture epoch."""
        return capture_file([
            message(offset_ms * i, "DDATA", metrics=[
                {"name": "Systems/TEMPERATURE", "timestamp": EPOCH - 25 * 3600 * 1000,
                 "double_value": 20.0},
            ])
            for i in range(count)
        ])

    def test_a_playback_that_would_write_nothing_is_refused(self):
        # A playback whose every message is out of window can write nothing, so it is refused
        # BEFORE the broker is contacted: `sent` is zero and the error is what the Capture page
        # shows, rather than a run that reports success and moves nothing.
        sent, out_of_window, error = self._run(self._stale(1_000, count=3))
        self.assertEqual(sent, 0)
        self.assertEqual(out_of_window, 3)
        self.assertIsNotNone(error, "a playback that can write nothing was not refused")
        self.assertIn("write nothing to the historian", error)

    def test_the_refusal_names_the_first_offending_message(self):
        # An operator's next move is to look at a timestamp, so the message names one rather than
        # reporting a count they would then have to go and find the cause of.
        _, _, error = self._run(self._stale(1_000, count=2))
        self.assertIn("spBv1.0/", error, "the refusal does not name a topic")
        self.assertIn("--speed cannot cause it", error,
                      "the refusal does not rule out the explanation an operator reaches for first")

    def test_a_partly_stale_capture_is_not_refused(self):
        # THE OTHER HALF OF THE DECISION, and the reason this is not simply the CLI's refusal moved
        # over: a capture carrying ONE stale device clock is still worth replaying, and the page has
        # no equivalent of `--allow-unsane` for an operator to reach for. It gets as far as the
        # broker, which is absent here -- so the error is a connection failure, NOT a refusal, and
        # the count travels with it.
        mixed = capture_file([
            message(0, "DDATA", metrics=[
                {"name": "Systems/TEMPERATURE", "timestamp": EPOCH - 25 * 3600 * 1000,
                 "double_value": 20.0},
            ]),
            message(1_000, "DDATA", metrics=[
                {"name": "Systems/TEMPERATURE", "timestamp": EPOCH, "double_value": 21.0},
            ]),
        ])
        sent, out_of_window, error = self._run(mixed)
        self.assertEqual(sent, 0)
        self.assertEqual(out_of_window, 1)
        self.assertNotIn("write nothing to the historian", error or "",
                         "a capture with one good message was refused as a total no-op")

    def test_a_capture_the_daemon_would_write_in_full_is_not_refused(self):
        # THE REFUSAL MUST NOT BE STRICTER THAN THE DAEMON IT MODELS. Every payload here carries a
        # skewed edge-node clock and every metric its own good one, so the daemon writes all of it
        # -- and refusing on the payload clock would fail the job saying it would write nothing,
        # from a page with no `--allow-unsane`. It gets as far as the absent broker instead.
        skewed = capture_file([
            message(offset, "DDATA", timestamp=EPOCH - 25 * 3600 * 1000, metrics=[
                {"name": "Systems/TEMPERATURE", "timestamp": EPOCH + offset,
                 "double_value": 20.0},
            ])
            for offset in (0, 1_000, 2_000)
        ])
        sent, out_of_window, error = self._run(skewed)
        self.assertEqual((sent, out_of_window), (0, 0))
        self.assertNotIn("write nothing to the historian", error or "",
                         "a capture the daemon would write in full was refused as a total no-op")

    def test_a_healthy_capture_counts_nothing_out_of_window(self):
        # The control. Without it every assertion above would also pass against a worker that
        # reported a discard for every job.
        _, out_of_window, _ = self._run(capture_file([message(0, "DDATA"), message(50, "DDATA")]))
        self.assertEqual(out_of_window, 0)

    def test_the_count_is_reported_even_when_the_job_fails_early(self):
        # `playback_finish` records it on every outcome, so the count has to survive a failure
        # rather than only a success: on a FAILED job it is the diagnosis.
        worker = self._worker()
        sent, out_of_window, error = worker._run_job(
            supabase=None, storage=self._Storage(capture_file()),
            credentials={}, job=self._job(),
        )
        self.assertEqual((sent, out_of_window), (0, 0))
        self.assertIn("holds no broker credential", error)


if __name__ == "__main__":
    unittest.main(verbosity=2)
