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
import argparse
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

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


def births(messages):
    """
    What a replay opens with: an NBIRTH, then a DBIRTH for each device the messages name, all at
    offset 0 and carrying no metrics, so they change no count the tests below assert.
    """
    devices = []
    for msg in messages:
        parts = msg["topic"].split("/")
        if len(parts) == 5 and parts[4] not in devices:
            devices.append(parts[4])
    return [message(0, "NBIRTH", device=None)] + [message(0, "DBIRTH", device=d) for d in devices]


def capture_file(messages=None, born=True):
    """A capture file. `born` opens it with births(), as a recording from the Capture page opens."""
    messages = messages if messages is not None else [message(0, "DDATA")]
    if born:
        messages = births(messages) + messages
    return {
        "aber_capture_version": capture.CAPTURE_VERSION,
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

    @staticmethod
    def _every_field():
        """A payload using every field the proto defines beyond the six scalar values."""
        payload = sparkplug_b_pb2.Payload()
        payload.timestamp = EPOCH
        payload.seq = 4
        payload.uuid = "aber-test"
        payload.body = b"\x00\x01raw"

        declared = payload.metrics.add()
        declared.name, declared.datatype, declared.timestamp = "Agent_Version", 12, EPOCH
        declared.is_null = True
        declared.is_transient = True
        declared.metadata.content_type = "text/plain"
        declared.metadata.size = 2 ** 40
        declared.properties.keys.extend(["engUnit", "limits"])
        unit = declared.properties.values.add()
        unit.type, unit.string_value = 12, "°C"
        limits = declared.properties.values.add()
        limits.type = 20
        limits.propertyset_value.keys.append("high")
        high = limits.propertyset_value.values.add()
        high.type, high.double_value = 10, 85.5

        blob = payload.metrics.add()
        blob.name, blob.datatype, blob.bytes_value = "Snapshot", 17, b"\xff\x00\x10"

        table = payload.metrics.add()
        table.name, table.datatype = "Recipe", 16
        table.dataset_value.num_of_columns = 2
        table.dataset_value.columns.extend(["step", "temp"])
        table.dataset_value.types.extend([3, 10])
        row = table.dataset_value.rows.add()
        row.elements.add().int_value = 1
        row.elements.add().double_value = 180.0

        definition = payload.metrics.add()
        definition.name, definition.datatype = "_types_/Motor", 19
        definition.template_value.is_definition = True
        definition.template_value.version = "1"
        member = definition.template_value.metrics.add()
        member.name, member.datatype, member.long_value = "Rpm", 8, 2 ** 63
        parameter = definition.template_value.parameters.add()
        parameter.name, parameter.type, parameter.string_value = "Rated", 12, "4kW"

        instance = payload.metrics.add()
        instance.name, instance.datatype, instance.alias = "Line/Motor1", 19, 9
        instance.template_value.template_ref = "_types_/Motor"
        instance.template_value.metrics.add().CopyFrom(member)

        extended = payload.metrics.add()
        extended.name = "Vendor"
        # An extension's content is fields the proto does not name: kept as the bytes received.
        extended.extension_value.MergeFromString(b"\x08\x96\x01")
        return payload

    def test_carries_every_metric_field_and_the_body(self):
        """
        The file is a faithful record: the replay is the message received
        (tck-id-topics-nbirth-metrics, tck-id-payloads-template-definition-is-definition,
        -members, -template-instance-ref).
        """
        payload = self._every_field()
        data, restored = self._round_trip(payload)
        self.assertEqual(restored.SerializeToString(), payload.SerializeToString())
        declared = data["metrics"][0]
        self.assertEqual((declared["is_null"], declared["is_transient"]), (True, True))
        self.assertNotIn("string_value", declared)
        self.assertTrue(restored.metrics[0].HasField("is_null"))
        self.assertEqual(restored.metrics[3].template_value.is_definition, True)
        self.assertEqual(restored.metrics[4].template_value.template_ref, "_types_/Motor")

    def test_the_file_survives_json_and_a_json_replay_carries_the_same(self):
        payload = self._every_field()
        data = json.loads(json.dumps(capture.payload_to_dict(payload)))
        self.assertEqual(capture.dict_to_payload_bytes(data), payload.SerializeToString())
        wire = capture.encode_wire_payload(data, capture.ENCODING_JSON)
        self.assertEqual(capture.json_payload(json.loads(wire)).SerializeToString(),
                         payload.SerializeToString())

    def test_a_flag_that_is_false_is_not_written(self):
        payload = sparkplug_b_pb2.Payload()
        m = payload.metrics.add()
        m.name, m.double_value, m.is_null, m.is_transient = "t", 1.0, False, False
        data = capture.payload_to_dict(payload)
        self.assertEqual(data["metrics"][0], {"name": "t", "double_value": 1.0})

    def test_a_file_without_the_new_fields_still_reads(self):
        restored = capture.dict_to_payload({"timestamp": EPOCH, "metrics": [
            {"name": "t", "datatype": 10, "double_value": 1.0}]})
        metric = restored.metrics[0]
        self.assertFalse(restored.HasField("body"))
        for field in ("is_null", "is_transient", "metadata", "properties"):
            self.assertFalse(metric.HasField(field), field)
        self.assertEqual(metric.double_value, 1.0)

    def test_a_field_not_in_the_files_form_costs_only_itself(self):
        # The daemon reads JSON traffic with the same reader, and it ignored these keys before.
        restored = capture.dict_to_payload({"body": "not base64!", "metrics": [
            {"name": "a", "double_value": 1.0, "properties": {"engUnit": "C"}, "metadata": "x",
             "is_null": "true"},
            {"name": "b", "bytes_value": "%%%"},
            {"name": "c", "dataset_value": {"rows": "many"}},
        ]})
        a, b, c = restored.metrics
        self.assertFalse(restored.HasField("body"))
        self.assertEqual(a.double_value, 1.0)
        for field in ("properties", "metadata", "is_null"):
            self.assertFalse(a.HasField(field), field)
        self.assertEqual((b.WhichOneof("value"), c.WhichOneof("value")), (None, None))

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

    def test_a_signed_integer_is_recorded_as_its_wire_pattern(self):
        # The file holds what the wire carried, datatype included, so playback reproduces the
        # bytes and the daemon reads the value back signed.
        payload = sparkplug_b_pb2.Payload()
        m = payload.metrics.add()
        m.name = "Offset"
        m.datatype = 3  # Int32
        m.int_value = (-5) & 0xFFFFFFFF
        data, restored = self._round_trip(payload)
        self.assertEqual(data["metrics"][0], {"name": "Offset", "datatype": 3, "int_value": 4294967291})
        self.assertEqual(restored.SerializeToString(), payload.SerializeToString())

    def test_a_negative_integer_in_the_file_is_encoded_as_twos_complement(self):
        # A JSON message or a hand edit carries the number itself; protobuf's unsigned fields
        # refuse it, so it is written as the pattern a signed encoder would have sent.
        restored = capture.dict_to_payload({"metrics": [
            {"name": "a", "int_value": -5},
            {"name": "b", "datatype": 2, "int_value": -5},
            {"name": "c", "long_value": -7},
        ]})
        a, b, c = restored.metrics
        self.assertEqual((a.int_value, a.datatype), (4294967291, 3))
        self.assertEqual((b.int_value, b.datatype), (4294967291, 2))
        self.assertEqual((c.long_value, c.datatype), (2 ** 64 - 7, 4))

    def test_a_metric_the_daemon_refuses_is_dropped_not_coerced(self):
        # The file reads as the daemon reads JSON, in either encoding: the string "false" is not
        # true, and a value too wide for its field costs that metric, not the message.
        restored = capture.dict_to_payload({"metrics": [
            {"name": "Flag", "boolean_value": "false"},
            {"name": "Too_Wide", "int_value": 2 ** 32},
            {"name": "Bare", "value": 2.5},
        ]})
        self.assertEqual([(m.name, m.WhichOneof("value")) for m in restored.metrics],
                         [("Bare", "double_value")])


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
        # Not rewritten silently: resolve_gateway() warns that a capture from another group was
        # matched by sparkplug_id, which a relabelled topic would hide.
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
        delay_ms, topic, payload_bytes, payload = plan[-1]
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
        self.assertEqual([d for d, _, _, _ in plan][-2:], [0, 1000])

    def test_an_unknown_capture_version_is_refused(self):
        bad = capture_file()
        bad["aber_capture_version"] = 99
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
        self.assertTrue(all(topic.startswith("spBv1.0/Replay-Lab/") for _, topic, _, _ in plan))
        self.assertIn(DEV_A, plan[-1][1])

    def test_two_devices_map_independently(self):
        msgs = [message(0, "DDATA", device=CAPTURED_DEV), message(10, "DDATA", device=DEV_B)]
        plan = self._plan(
            capture=capture_file(msgs), device_map={CAPTURED_DEV: DEV_A, DEV_B: DEV_B},
        )
        self.assertIn(DEV_A, plan[-2][1])
        self.assertIn(DEV_B, plan[-1][1])


class MalformedCaptureTests(unittest.TestCase):
    """
    A file reaches the plan from the page, an upload or a hand edit, so its shape is checked first
    and a fault is refused as a CaptureError naming the message, never a KeyError or TypeError.
    """

    def refusal(self, document, **kwargs):
        with self.assertRaises(capture.CaptureError) as caught:
            capture.plan_playback(document, GW, kwargs.pop("device_map", DEFAULT_MAP), NOW,
                                  **kwargs)
        return str(caught.exception)

    def with_message(self, index, **changes):
        """A good capture whose message `index` (after births()) has `changes`; None deletes."""
        document = capture_file([message(0, "DDATA"), message(10, "DDATA")])
        msg = document["messages"][index]
        for key, value in changes.items():
            if value is None:
                msg.pop(key, None)
            else:
                msg[key] = value
        return document

    def test_a_well_formed_capture_passes(self):
        self.assertEqual(len(capture.check_capture(capture_file())), 3)

    def test_the_document_must_be_an_object_of_the_known_shape(self):
        for document, expected in (
            ([], "is an array"),
            (dict(capture_file(), aber_capture_version=2), "version 2"),
            (dict(capture_file(), capture_epoch_ms="yesterday"), "capture_epoch_ms is a string"),
            (dict(capture_file(), capture_epoch_ms=None), "capture_epoch_ms is null"),
            (dict(capture_file(), messages="spBv1.0/Aber/NBIRTH/x"), "messages are a string"),
            (dict(capture_file(), messages={"0": {}}), "messages are an object"),
            (dict(capture_file(), messages=[]), "no messages"),
        ):
            self.assertIn(expected, self.refusal(document))

    def test_a_message_without_a_topic_is_named_by_its_index(self):
        self.assertIn("message 3: it has no topic", self.refusal(self.with_message(3, topic=None)))

    def test_a_message_must_be_an_object_with_a_payload_object(self):
        document = capture_file()
        document["messages"][2] = "DDATA"
        self.assertIn("message 2: it is a string", self.refusal(document))
        self.assertIn("message 2: its payload is null",
                      self.refusal(self.with_message(2, payload=None)))
        self.assertIn("its payload is an array", self.refusal(self.with_message(2, payload=[])))

    def test_metrics_must_be_an_array_of_objects(self):
        self.assertIn("message 2: its metrics are an object", self.refusal(
            self.with_message(2, payload={"timestamp": EPOCH, "metrics": {"name": "a"}})))
        self.assertIn("its metric 1 is a number", self.refusal(
            self.with_message(2, payload={"timestamp": EPOCH, "metrics": [{"name": "a"}, 5]})))
        self.assertIn("its metrics are null", self.refusal(
            self.with_message(2, payload={"timestamp": EPOCH, "metrics": None})))

    def test_only_the_six_edge_node_message_types_are_accepted(self):
        """tck-id-topic-structure-namespace-device-id-associated-message-types, -non-associated-."""
        for topic in ("spBv1.0/Aber/NCMD/%s" % CAPTURED_GW,
                      "spBv1.0/Aber/DCMD/%s/%s" % (CAPTURED_GW, CAPTURED_DEV),
                      "spBv1.0/STATE/aber-ingestion",
                      "spBv1.0/Aber/BOGUS/%s" % CAPTURED_GW,
                      "spBv1.0/Aber/NDATA/%s/%s" % (CAPTURED_GW, CAPTURED_DEV),
                      "spBv1.0/Aber/DDATA/%s" % CAPTURED_GW,
                      "spBv1.0/Aber/DDATA/%s/%s/extra" % (CAPTURED_GW, CAPTURED_DEV),
                      "spBv2.0/Aber/DDATA/%s/%s" % (CAPTURED_GW, CAPTURED_DEV),
                      "factory/line1/temp", ""):
            text = self.refusal(self.with_message(3, topic=topic))
            self.assertIn("message 3: topic", text, topic)

    def test_a_segment_may_hold_no_wildcard_no_nul_and_nothing_but_utf8(self):
        """tck-id-topic-structure-namespace-valid-group-id, -valid-edge-node-id, -valid-device-id"""
        for group, problem in (("Ab+", "contains '+'"), ("A#", "contains '#'"),
                               ("A\x00b", "contains a NUL character"), ("", "is empty"),
                               ("A\ud800", "is not valid UTF-8")):
            text = self.refusal(self.with_message(
                3, topic="spBv1.0/%s/DDATA/%s/%s" % (group, CAPTURED_GW, CAPTURED_DEV)))
            self.assertIn("the group segment %s" % problem, text)
        self.assertIn("the device segment contains '+'", self.refusal(self.with_message(
            3, topic="spBv1.0/Aber/DDATA/%s/+" % CAPTURED_GW)))
        self.assertIn("the edge node segment contains a NUL", self.refusal(self.with_message(
            3, topic="spBv1.0/Aber/DDATA/gwy\x00/%s" % CAPTURED_DEV)))

    def test_offsets_are_whole_ordered_and_within_a_day(self):
        for offset, expected in ((None, "has no offset_ms"), ("10", "not a whole number"),
                                 (1.5, "not a whole number"), (True, "not a whole number"),
                                 (-1, "is negative"), (86_400_001, "more than 24 hours")):
            text = self.refusal(self.with_message(3, offset_ms=offset))
            self.assertIn("message 3:", text, offset)
            self.assertIn(expected, text, offset)

    def test_an_offset_earlier_than_the_one_before_is_refused(self):
        self.assertIn("message 3: its offset_ms 10 is earlier than the message before it (20)",
                      self.refusal(self.with_message(2, offset_ms=20)))

    def test_thirty_years_after_the_first_message_is_refused(self):
        """An upload whose second message would have planned a 946,728,000-second sleep."""
        self.assertIn("more than 24 hours",
                      self.refusal(self.with_message(3, offset_ms=946_728_000_000)))

    def test_a_whole_float_offset_and_exactly_a_day_are_accepted(self):
        plan = capture.plan_playback(self.with_message(3, offset_ms=86_400_000.0), GW,
                                     DEFAULT_MAP, NOW)
        self.assertEqual(plan[-1][0], 86_400_000)

    def test_an_encoding_must_be_one_this_tool_knows(self):
        self.assertIn("message 3: its encoding 'xml'",
                      self.refusal(self.with_message(3, encoding="xml")))

    def test_a_timestamp_that_is_not_a_number_is_refused_by_message(self):
        self.assertIn("message 3: its payload timestamp 'noon' is not a number", self.refusal(
            self.with_message(3, payload={"timestamp": "noon", "metrics": []})))
        self.assertIn("message 3: its metric 0's timestamp", self.refusal(self.with_message(
            3, payload={"timestamp": EPOCH, "metrics": [{"name": "t", "timestamp": "noon"}]})))

    def test_a_group_override_is_held_to_the_segment_rule(self):
        self.assertIn("the group 'Replay/Lab' contains '/'",
                      self.refusal(capture_file(), group="Replay/Lab"))


class SanityWindowTests(unittest.TestCase):
    """
    The check that catches a playback which would report success and write nothing.

    WHAT IS JUDGED IS THE GAP BETWEEN A STAMP AND THE TIME ITS MESSAGE ARRIVES, and the speed
    divides that gap. rebase_payload() and the scheduler share a divisor, so a stamp at its
    message's own receipt time stays in window at any speed. Any other gap is stretched by a slow
    speed: a metric stamped 20 minutes before its birth is 33 hours behind at 0.01x.
    """

    def test_a_normal_playback_has_nothing_out_of_window(self):
        plan = capture.plan_playback(
            capture_file([message(0, "DDATA"), message(30_000, "DDATA")]),
            GW, DEFAULT_MAP, NOW, speed=1.0,
        )
        self.assertEqual(capture.unsane_timestamps(plan, NOW), [])

    def test_a_reading_stamped_at_its_receipt_stays_in_window_at_any_speed(self):
        # THE PROPERTY, NOT AN EXAMPLE, FOR A GAP OF ZERO. An hour of capture from a ten-hour
        # crawl to a 600x sprint: the send delay and the timestamp move together, so the offset
        # at send is always zero. A future change that rebased against wall time instead of the
        # shared divisor would break this at both extremes.
        long_capture = capture_file([message(0, "DDATA"), message(3_600_000, "DDATA")])
        for speed in (0.1, 0.5, 1.0, 60.0, 600.0):
            plan = capture.plan_playback(long_capture, GW, DEFAULT_MAP, NOW, speed=speed)
            self.assertEqual(
                capture.unsane_timestamps(plan, NOW), [],
                "speed %r put a message outside the window" % speed,
            )

    def _gap_capture(self, stamp_offset_ms, **metric):
        """One DDATA at the capture epoch whose only metric is stamped `stamp_offset_ms` from it."""
        return capture_file([message(0, "DDATA", metrics=[
            dict({"name": "Systems/TEMPERATURE", "timestamp": EPOCH + stamp_offset_ms,
                  "double_value": 20.0}, **metric),
        ])])

    def _dropped_at(self, document, speed):
        plan = capture.plan_playback(document, GW, DEFAULT_MAP, NOW, speed=speed)
        return capture.window_outcome(plan, NOW)[2]

    def test_a_slow_speed_stretches_how_old_a_reading_is_before_its_message(self):
        # A metric stamped 20 minutes before its message. The gap is divided by the
        # speed, so it is 20 minutes at 1x, 200 minutes at 0.1x and 33 hours at 0.01x, which is
        # past the 24-hour bound. A faster speed shrinks it.
        document = self._gap_capture(-20 * 60 * 1000)
        self.assertEqual(
            [self._dropped_at(document, speed) for speed in (10.0, 1.0, 0.1, 0.01)],
            [0, 0, 0, 1],
        )

    def test_a_slow_speed_stretches_how_far_ahead_a_fast_device_clock_is(self):
        # A device clock 4 seconds fast: 4 s at 1x, 40 s at 0.1x and 400 s at 0.01x, past the
        # 5-minute bound.
        document = self._gap_capture(4_000)
        self.assertEqual(
            [self._dropped_at(document, speed) for speed in (10.0, 1.0, 0.1, 0.01)],
            [0, 0, 0, 1],
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
        self.assertEqual(plan[-1][3]["metrics"][0]["timestamp"], 0, "rebasing moved a zero")
        self.assertEqual(capture.unsane_timestamps(plan, NOW), [])

    def test_a_payload_without_a_clock_is_stamped_on_arrival(self):
        # payload_ts falls back to the receive time in the daemon, which is in window by
        # construction. Nothing here is out of range, and nothing may be reported as though it is.
        unstamped = capture_file([message(0, "DDATA", timestamp=None, metrics=[
            {"name": "Systems/TEMPERATURE", "double_value": 20.0},
        ])])
        plan = capture.plan_playback(unstamped, GW, DEFAULT_MAP, NOW)
        self.assertIsNone(plan[-1][3]["timestamp"], "rebasing materialised a payload clock")
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

    # -----------------------------------------------------------------------------------------
    # A READING FLAGGED is_historical HAS THE DAEMON'S LONGER BOUND, and the future bound is the
    # same for both. A gateway replaying its buffer after an outage is the case: refusing it here
    # would fail a playback the daemon writes in full.
    # -----------------------------------------------------------------------------------------
    HOUR_MS = 3600 * 1000

    def _window(self, document):
        plan = capture.plan_playback(document, GW, DEFAULT_MAP, NOW)
        return capture.window_outcome(plan, NOW)

    def test_a_historical_reading_thirty_hours_old_is_kept(self):
        lossy, kept, dropped = self._window(
            self._gap_capture(-30 * self.HOUR_MS, is_historical=True))
        self.assertEqual((lossy, kept, dropped), ([], 1, 0))

    def test_a_live_reading_thirty_hours_old_is_dropped(self):
        lossy, kept, dropped = self._window(self._gap_capture(-30 * self.HOUR_MS))
        self.assertEqual((len(lossy), kept, dropped), (1, 0, 1))

    def test_a_historical_reading_eight_days_old_is_dropped(self):
        lossy, kept, dropped = self._window(
            self._gap_capture(-8 * 24 * self.HOUR_MS, is_historical=True))
        self.assertEqual((len(lossy), kept, dropped), (1, 0, 1))

    def test_a_reading_six_minutes_ahead_is_dropped_historical_or_not(self):
        for flags in ({}, {"is_historical": True}):
            lossy, kept, dropped = self._window(self._gap_capture(6 * 60 * 1000, **flags))
            self.assertEqual((len(lossy), kept, dropped), (1, 0, 1), flags)

    def test_only_a_true_flag_is_historical(self):
        # The daemon sets the flag from a JSON `true` alone, so a hand edit that writes the word
        # or a number is a live reading to it, and is judged as one.
        for flag in ("true", 1):
            lossy, kept, dropped = self._window(
                self._gap_capture(-30 * self.HOUR_MS, is_historical=flag))
            self.assertEqual((len(lossy), kept, dropped), (1, 0, 1), flag)

    def test_a_historical_metric_without_a_timestamp_takes_the_payloads_and_its_bound(self):
        replayed = capture_file([message(0, "DDATA", timestamp=EPOCH - 30 * self.HOUR_MS, metrics=[
            {"name": "Systems/TEMPERATURE", "double_value": 20.0, "is_historical": True},
        ])])
        self.assertEqual(self._window(replayed)[1:], (1, 0))

    def test_the_window_matches_the_daemons_values(self):
        # Restated rather than imported; test_capture_worker.py holds these to ingestion.py's
        # own, which it can import.
        self.assertEqual(capture.TELEMETRY_MAX_AGE_SECONDS, 24 * 60 * 60)
        self.assertEqual(capture.TELEMETRY_MAX_FUTURE_SECONDS, 5 * 60)
        self.assertEqual(capture.TELEMETRY_MAX_HISTORICAL_AGE_SECONDS, 7 * 24 * 60 * 60)
        self.assertTrue(capture.timestamp_is_sane(NOW, NOW))
        self.assertFalse(capture.timestamp_is_sane(NOW - 25 * 3600 * 1000, NOW))
        self.assertTrue(capture.timestamp_is_sane(NOW - 25 * 3600 * 1000, NOW, historical=True))
        self.assertFalse(capture.timestamp_is_sane(NOW - 8 * 24 * 3600 * 1000, NOW, historical=True))
        self.assertFalse(capture.timestamp_is_sane(NOW + 6 * 60 * 1000, NOW))
        self.assertFalse(capture.timestamp_is_sane(NOW + 6 * 60 * 1000, NOW, historical=True))


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
        self.assertEqual(len(plan), len(original["messages"]))

    def test_a_hand_edited_value_reaches_the_wire(self):
        # THE FEATURE'S WHOLE POINT: reproduce a fault by editing a number. If this stops being
        # true the tool is only a recorder.
        edited = capture_file([message(0, "DDATA", metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": EPOCH, "double_value": 999.9,
             "datatype": 10},
        ])])
        _, _, payload_bytes, _ = capture.plan_playback(edited, GW, DEFAULT_MAP, NOW)[-1]
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

    def _run(self, document, speed=1.0):
        worker = self._worker()
        return worker._run_job(
            supabase=None, storage=self._Storage(document),
            credentials={GW: "a-password"}, job=dict(self._job(), speed=speed),
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

    def test_the_refusal_says_too_old_or_too_far_in_the_future(self):
        _, _, error = self._run(self._stale(1_000))
        self.assertIn("too old or too far in the future", error)

    def test_a_slow_speed_is_named_as_a_cause_and_1x_as_the_retry(self):
        # Every metric is stamped 20 minutes before its message: in window at 1x, 33 hours behind
        # at 0.01x. The refusal says the speed did it and what to try, and does not say the
        # opposite.
        document = capture_file([message(0, "DDATA", metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": EPOCH - 20 * 60 * 1000,
             "double_value": 20.0},
        ])])
        _, _, error = self._run(document, speed=0.01)
        self.assertIn("write nothing to the historian", error)
        self.assertIn("A slow --speed stretches that gap", error)
        self.assertIn("retrying at 1x may help", error)
        self.assertNotIn("cannot cause", error)

        _, out_of_window, error = self._run(document, speed=1.0)
        self.assertEqual(out_of_window, 0)
        self.assertNotIn("write nothing to the historian", error or "")

    def test_a_replayed_buffer_the_daemon_would_write_is_not_refused(self):
        # A gateway replaying its store-and-forward buffer after an outage: every reading
        # flagged is_historical and 30 hours old. The daemon writes it in full, so the refusal
        # must not fail it as a total no-op.
        replayed = capture_file([
            message(offset, "DDATA", metrics=[
                {"name": "Systems/TEMPERATURE", "timestamp": EPOCH - 30 * 3600 * 1000 + offset,
                 "double_value": 20.0, "is_historical": True},
            ])
            for offset in (0, 1_000)
        ])
        sent, out_of_window, error = self._run(replayed)
        self.assertEqual((sent, out_of_window), (0, 0))
        self.assertNotIn("write nothing to the historian", error or "")

    def test_the_command_line_refusal_reads_the_same(self):
        import argparse
        import tempfile
        document = capture_file([message(0, "DDATA", metrics=[
            {"name": "Systems/TEMPERATURE", "timestamp": EPOCH - 20 * 60 * 1000,
             "double_value": 20.0},
        ])])
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "fixture.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(document, fh)
            args = argparse.Namespace(
                capture=path, map=["%s=%s" % (CAPTURED_DEV, DEV_A)], as_gateway=GW, speed=0.01,
                group=None, allow_unsane=False, dry_run=True, head=5, verbose=False,
            )
            with self.assertRaises(capture.CaptureError) as caught:
                capture.cmd_play(args)
        text = str(caught.exception)
        self.assertIn("too old or too far in the future", text)
        self.assertIn("retrying at 1x may help", text)
        self.assertNotIn("cannot cause", text)

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


# =============================================================================================
# THE COMMAND LINE: `record` keeps what the daemon ingests, `play` is the dashboard's session.
# Against fake paho clients; no broker is reached.
# =============================================================================================
def wire_message(topic, payload=b"", retain=False):
    return SimpleNamespace(topic=topic, payload=payload, retain=retain)


def protobuf(seq=None, **metrics):
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = EPOCH
    if seq is not None:
        payload.seq = seq
    for name, value in metrics.items():
        m = payload.metrics.add()
        m.name, m.datatype, m.double_value = name, 10, value
    return payload.SerializeToString()


class FakeRecorder:
    """The subscription: delivers `arriving` when the loop starts, retained messages first."""

    def __init__(self, arriving):
        self.arriving = arriving
        self.on_message = None

    def subscribe(self, topic, qos=0):
        self.topic = topic

    def loop_start(self):
        for msg in self.arriving:
            self.on_message(self, None, msg)

    def loop_stop(self):
        pass

    def disconnect(self):
        pass


class FakeBroker:
    """A paho client for the playback session: CONNACK at once, every QoS 1 publish acknowledged."""
    made = []
    rc_after = None   # publishes after this many return MQTT_ERR_NO_CONN

    def __init__(self, client_id=None, **_kwargs):
        self.client_id = client_id
        self.events = []
        self.will = None
        FakeBroker.made.append(self)

    def username_pw_set(self, username, password):
        self.username = username

    def will_set(self, topic, payload, qos=0, retain=False):
        self.will = (topic, payload, qos, retain)
        self.events.append("will_set")

    def tls_set(self, **_kwargs):
        pass

    def connect(self, host, port, keepalive):
        self.events.append(("connect", host, port))
        self.on_connect(self, None, {}, 0)

    def loop_start(self):
        self.events.append("loop_start")

    def loop_stop(self):
        self.events.append("loop_stop")

    def subscribe(self, topic, qos=0):
        self.events.append(("subscribe", topic, qos))
        return 0, 1

    def message_callback_add(self, sub, callback):
        pass

    def publish(self, topic, payload, qos=0, retain=False):
        published = sum(1 for b in FakeBroker.made for e in b.events if e[0] == "publish")
        lost = FakeBroker.rc_after is not None and published >= FakeBroker.rc_after
        self.events.append(("publish", topic, payload, qos))
        return SimpleNamespace(rc=4 if lost else 0, wait_for_publish=lambda timeout=None: None,
                               is_published=lambda: not lost)

    def disconnect(self):
        self.events.append("disconnect")

    def socket(self):
        return None

    def published(self):
        return [e[1:] for e in self.events if e[0] == "publish"]


def kind(topic):
    return capture.split_topic(topic)[1]


def bdseq_of(payload_bytes):
    payload, _ = capture.decode_wire_payload(payload_bytes)
    return next(m.long_value for m in payload.metrics if m.name == "bdSeq")


class CommandLineTests(unittest.TestCase):

    def setUp(self):
        import playback_worker
        self.worker = playback_worker
        self.saved = (playback_worker.mqtt.Client, playback_worker.MQTT_HOST,
                      playback_worker.MQTT_PORT, capture.PLAY_USER, capture.PLAY_PASSWORD,
                      capture._connect)
        playback_worker.mqtt.Client = FakeBroker
        capture.PLAY_USER, capture.PLAY_PASSWORD = GW, "a-password"
        FakeBroker.made, FakeBroker.rc_after = [], None
        playback_worker._next_bdseq.clear()
        self.folder = tempfile.TemporaryDirectory()

    def tearDown(self):
        (self.worker.mqtt.Client, self.worker.MQTT_HOST, self.worker.MQTT_PORT, capture.PLAY_USER,
         capture.PLAY_PASSWORD, capture._connect) = self.saved
        self.worker._next_bdseq.clear()
        self.folder.cleanup()

    # -- record -----------------------------------------------------------------------------------
    def record(self, arriving):
        capture._connect = lambda *_args: FakeRecorder(arriving)
        path = os.path.join(self.folder.name, "recorded.json")
        args = argparse.Namespace(out=path, seconds=0, topic="spBv1.0/#", verbose=False)
        with contextlib.redirect_stdout(io.StringIO()):
            status = capture.cmd_record(args)
        with open(path, encoding="utf-8") as fh:
            return status, json.load(fh)

    def test_record_leaves_out_state_and_commands(self):
        """The primary host's STATE is retained, so it arrives on subscribe, every time."""
        node = "spBv1.0/Aber/%s/" + CAPTURED_GW
        status, document = self.record([
            wire_message("spBv1.0/STATE/aber-ingestion", b'{"online":true,"timestamp":1}', True),
            wire_message(node % "NCMD", protobuf(**{"Node Control/Rebirth": 1.0})),
            wire_message(node % "DCMD" + "/" + CAPTURED_DEV, protobuf(Setpoint=1.0)),
            wire_message(node % "NDATA", b""),
            wire_message(node % "NBIRTH", protobuf(seq=0, Uptime_s=1.0)),
            wire_message(node % "DBIRTH" + "/" + CAPTURED_DEV, protobuf(seq=1, Temperature=20.0)),
            wire_message(node % "DDATA" + "/" + CAPTURED_DEV, protobuf(seq=2, Temperature=21.0)),
        ])
        self.assertEqual(status, 0)
        self.assertEqual([kind(m["topic"]) for m in document["messages"]],
                         ["NBIRTH", "DBIRTH", "DDATA"])
        self.assertEqual(document["identities"], {"edge_nodes": [CAPTURED_GW],
                                                  "devices": [CAPTURED_DEV]})
        self.assertEqual(len(capture.plan_playback(document, GW, DEFAULT_MAP, NOW)), 3)

    def test_a_recording_of_state_alone_says_so(self):
        with self.assertRaises(capture.CaptureError) as caught:
            self.record([wire_message("spBv1.0/STATE/aber-ingestion", b'{"online":true}', True)])
        self.assertIn("were STATE, NCMD or DCMD", str(caught.exception))

    # -- play -------------------------------------------------------------------------------------
    def play(self, messages, **overrides):
        path = os.path.join(self.folder.name, "capture.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(capture_file(messages, born=False), fh)
        args = argparse.Namespace(
            capture=path, map=["%s=%s" % (CAPTURED_DEV, DEV_A)], as_gateway=GW, speed=1000.0,
            group=None, allow_unsane=False, dry_run=False, head=5, verbose=False)
        for key, value in overrides.items():
            setattr(args, key, value)
        with contextlib.redirect_stdout(io.StringIO()):
            return capture.cmd_play(args)

    @staticmethod
    def session(bdseq=9):
        return [message(0, "NBIRTH", device=None, metrics=[
                    {"name": "bdSeq", "datatype": 4, "long_value": bdseq}]),
                message(10, "DBIRTH"), message(20, "DDATA")]

    def assert_a_session(self, client, bdseq):
        """The Will is the session's NDEATH; the NBIRTH repeats its bdSeq; the death ends it."""
        will_topic, will_payload, will_qos, will_retain = client.will
        self.assertEqual(will_topic, "spBv1.0/Aber/NDEATH/" + GW)
        self.assertEqual((will_qos, will_retain), (1, False))
        self.assertLess(client.events.index("will_set"), 1)
        first, last = client.published()[0], client.published()[-1]
        self.assertEqual(kind(first[0]), "NBIRTH")
        self.assertEqual(bdseq_of(first[1]), bdseq)
        self.assertEqual(bdseq_of(will_payload), bdseq)
        self.assertEqual((kind(last[0]), last[2], bdseq_of(last[1])), ("NDEATH", 1, bdseq))
        self.assertEqual(client.events[-2:], ["loop_stop", "disconnect"])

    def test_play_opens_and_ends_the_dashboards_session(self):
        """tck-id-payloads-ndeath-will-message, -nbirth-bdseq-repeat, -intentional-disconnect."""
        self.assertEqual(self.play(self.session(bdseq=9)), 0)
        client, = FakeBroker.made
        self.assertEqual(client.username, GW)
        self.assertEqual(client.events[1], ("connect", capture.MQTT_HOST, capture.MQTT_PORT))
        self.assertEqual([kind(t) for t, _, _ in client.published()],
                         ["NBIRTH", "DBIRTH", "DDATA", "NDEATH"])
        self.assert_a_session(client, bdseq=0)

    def test_a_recorded_ndeath_ends_one_session_and_the_next_opens_with_the_next_bdseq(self):
        messages = self.session() + [message(30, "NDEATH", device=None),
                                     message(40, "NBIRTH", device=None),
                                     message(50, "NDATA", device=None)]
        self.play(messages)
        first, second = FakeBroker.made
        self.assert_a_session(first, bdseq=0)
        self.assert_a_session(second, bdseq=1)

    def test_a_lost_connection_stops_the_run_instead_of_reporting_success(self):
        FakeBroker.rc_after = 2
        with self.assertRaises(capture.CaptureError) as caught:
            self.play(self.session())
        self.assertIn("publishing stopped after 2 message(s): the broker connection was lost",
                      str(caught.exception))

    def test_a_birthless_capture_is_refused_before_connecting(self):
        with self.assertRaises(capture.CaptureError) as caught:
            self.play([message(0, "DDATA")])
        self.assertIn("holds no NBIRTH", str(caught.exception))
        self.assertEqual(FakeBroker.made, [])

    def test_the_credential_advice_is_the_gateways_page_and_the_delivered_secret(self):
        capture.PLAY_USER = ""
        with self.assertRaises(capture.CaptureError) as caught:
            self.play(self.session())
        text = str(caught.exception)
        self.assertIn("Gateways page", text)
        self.assertIn("mosquitto-passwords", text)
        self.assertIn("playback_credentials.json", text)
        self.assertNotIn("mosquitto-provision-gateway", text)
        self.assertEqual(FakeBroker.made, [])

    def test_the_map_help_names_the_replay_lanes(self):
        text = capture.build_parser()._subparsers._group_actions[0].choices["play"].format_help()
        self.assertIn("Prepare replay lanes", " ".join(text.split()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
