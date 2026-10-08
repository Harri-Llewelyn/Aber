"""
The JSON encoding of a Sparkplug payload, as parse_sparkplug_payload() reads it.

The appliance template publishes JSON, not protobuf, and publishes device readings by exception:
each metric carries the time it was read, and a refresh republishes unchanged values with the time
of the refresh. The protobuf path has always honoured a metric's own timestamp; these pin that the
JSON path does too, so a reading is filed when it was taken rather than when its message was built.

The playback recorder (capture.py) decodes JSON through the same reader, so a recorded message
replays as what the daemon stored from the original; ReplayReadsAsTheDaemonStored pins that.

Needs the generated `sparkplug_b_pb2` (python -m grpc_tools.protoc --python_out=ingestion -I.
sparkplug_b.proto). The run-python-suites runner starts each suite in its own process, so the
stubbed modules below cannot leak into a sibling.
"""
import json
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _stub(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules.setdefault(name, module)


_stub("psycopg2", connect=lambda *a, **k: None)
_stub("psycopg2.extras", execute_values=lambda *a, **k: None)
_stub("paho")
_stub("paho.mqtt")
_stub("paho.mqtt.client", Client=object)

import ingestion  # noqa: E402  (must follow the stubs above)
import capture  # noqa: E402  (the module ingestion imported, bound to the same protobuf)


class _Message:
    topic = "spBv1.0/Aber/DDATA/gwy120000000000400080000/press-01"

    def __init__(self, body):
        self.payload = json.dumps(body).encode("utf-8")


class _Wire(_Message):
    def __init__(self, raw):
        self.payload = raw


def parse(metrics, **payload):
    return ingestion.parse_sparkplug_payload(_Message({"timestamp": 1790000000000, "seq": 4, "metrics": metrics, **payload}))


class JsonMetricTimestamps(unittest.TestCase):
    def test_a_metric_keeps_its_own_timestamp(self):
        payload = parse([{"name": "Temperature", "datatype": 10, "double_value": 21.4, "timestamp": 1789999990000}])
        metric = payload.metrics[0]
        self.assertTrue(metric.HasField("timestamp"))
        self.assertEqual(metric.timestamp, 1789999990000)
        self.assertEqual(payload.timestamp, 1790000000000)

    def test_a_metric_without_one_has_none(self):
        # The daemon then files the reading at the payload's time, as before.
        metric = parse([{"name": "Temperature", "datatype": 10, "double_value": 21.4}]).metrics[0]
        self.assertFalse(metric.HasField("timestamp"))

    def test_a_timestamp_that_is_not_a_positive_number_is_ignored(self):
        for bad in (True, "1789999990000", 0, -5, None):
            with self.subTest(timestamp=bad):
                metric = parse([{"name": "t", "datatype": 10, "double_value": 1.0, "timestamp": bad}]).metrics[0]
                self.assertFalse(metric.HasField("timestamp"))

    def test_each_metric_is_read_separately(self):
        payload = parse([
            {"name": "a", "datatype": 10, "double_value": 1.0, "timestamp": 1789999980000},
            {"name": "b", "datatype": 11, "boolean_value": True},
        ])
        self.assertEqual(payload.metrics[0].timestamp, 1789999980000)
        self.assertFalse(payload.metrics[1].HasField("timestamp"))
        self.assertTrue(payload.metrics[1].boolean_value)


class JsonSignedIntegers(unittest.TestCase):
    """A negative JSON int_value, which the unsigned protobuf field refused and lost the payload for."""

    def read_back(self, metric):
        return ingestion.sparkplug_integer_value(metric.datatype, metric.int_value)

    def test_a_negative_integer_without_a_datatype_reads_back_as_itself(self):
        metric = parse([{"name": "Offset", "int_value": -5}]).metrics[0]
        self.assertEqual((metric.int_value, metric.datatype), (4294967291, 3))
        self.assertEqual(self.read_back(metric), -5)

    def test_a_declared_datatype_is_kept(self):
        metric = parse([{"name": "Offset", "datatype": 2, "int_value": -32768}]).metrics[0]
        self.assertEqual(metric.datatype, 2)
        self.assertEqual(self.read_back(metric), -32768)

    def test_a_non_negative_integer_is_unchanged(self):
        metric = parse([{"name": "Count", "int_value": 7}]).metrics[0]
        self.assertFalse(metric.HasField("datatype"))
        self.assertEqual(metric.int_value, 7)


FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "test-harness", "fixtures", "sparkplug-json-values.json"
)


class JsonValuesAgreeWithI3x(unittest.TestCase):
    """
    Every case in test-harness/fixtures/sparkplug-json-values.json, read through this parser. The
    i3X server asserts the same file through decode_metrics(), so the historian stores what i3X
    serves for the same JSON payload.
    """

    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, encoding="utf-8") as f:
            cls.cases = json.load(f)["cases"]

    def setUp(self):
        ingestion._json_metric_refused_warned.clear()

    @staticmethod
    def reads(metric):
        """The Sparkplug value the daemon takes from a metric: an integer through its datatype."""
        which = metric.WhichOneof("value")
        if which is None:
            return None
        raw = getattr(metric, which)
        if which in ("int_value", "long_value"):
            return ingestion.sparkplug_integer_value(ingestion._declared_datatype(metric), raw)
        return raw

    def test_the_fixture_is_not_empty(self):
        self.assertGreater(len(self.cases), 10)
        self.assertTrue(any(case.get("dropped") for case in self.cases))

    def test_every_case_reads_as_the_fixture_says(self):
        with self.assertLogs(ingestion.logger, "WARNING"):
            payload = parse([case["metric"] for case in self.cases])
        got = {metric.name: self.reads(metric) for metric in payload.metrics}
        for case in self.cases:
            name = case["metric"]["name"]
            with self.subTest(case=name):
                if case.get("dropped"):
                    self.assertNotIn(name, got)
                else:
                    self.assertEqual(got[name], case["reads"])
                    self.assertEqual(type(got[name]) is bool, type(case["reads"]) is bool)

    def test_a_refused_metric_costs_only_itself_and_is_logged(self):
        with self.assertLogs(ingestion.logger, "WARNING") as logs:
            payload = parse([
                {"name": "Too_Wide", "int_value": 2**32},
                {"name": "Temperature", "datatype": 10, "double_value": 21.4},
            ])
        self.assertEqual([metric.name for metric in payload.metrics], ["Temperature"])
        self.assertIn("Too_Wide", "\n".join(logs.output))

    def test_a_negative_int64_is_stored_as_its_64_bit_pattern(self):
        metric = parse([{"name": "Offset", "datatype": 4, "int_value": -5}]).metrics[0]
        self.assertEqual(metric.WhichOneof("value"), "long_value")
        self.assertEqual(self.reads(metric), -5)

    def test_a_null_name_is_an_alias_only_metric(self):
        metric = parse([{"name": None, "alias": 7, "datatype": 10, "double_value": 1.5}]).metrics[0]
        self.assertEqual((metric.name, metric.alias, metric.double_value), ("", 7, 1.5))

    def test_long_and_float_values_are_read(self):
        payload = parse([
            {"name": "Bytes", "datatype": 8, "long_value": 2**40},
            {"name": "Ratio", "datatype": 9, "float_value": 0.5},
        ])
        self.assertEqual([self.reads(metric) for metric in payload.metrics], [2**40, 0.5])


class ReplayReadsAsTheDaemonStored(unittest.TestCase):
    """
    A JSON message recorded by capture.py and played back reads as the daemon read the original.

    Recording is decode_wire_payload() then payload_to_dict(). Playback is encode_wire_payload() in
    the encoding recorded (JSON), and in protobuf, which goes through dict_to_payload(): the capture
    file is JSON whichever encoding replays it, so both must read it as the daemon does.
    """

    TIMESTAMP = 1790000000000

    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, encoding="utf-8") as f:
            cls.cases = json.load(f)["cases"]

    @staticmethod
    def daemon(raw):
        """parse_sparkplug_payload() on the wire bytes, with its refusal warnings throttled off."""
        throttled, ingestion._throttled = ingestion._throttled, lambda *_: False
        try:
            return ingestion.parse_sparkplug_payload(_Wire(raw))
        finally:
            ingestion._throttled = throttled

    @staticmethod
    def reading(payload):
        """Everything the daemon takes from a parsed payload: the clocks, seq and each metric."""
        def field(message, name):
            return getattr(message, name) if message.HasField(name) else None

        metrics = []
        for metric in payload.metrics:
            value = JsonValuesAgreeWithI3x.reads(metric)
            metrics.append((metric.name, field(metric, "alias"), field(metric, "datatype"),
                            value, type(value).__name__, field(metric, "timestamp")))
        return {"timestamp": field(payload, "timestamp"), "seq": field(payload, "seq"),
                "metrics": metrics}

    def assert_replays_as_stored(self, body):
        raw = json.dumps(body).encode("utf-8")
        stored = self.reading(self.daemon(raw))

        recorded, encoding = capture.decode_wire_payload(raw)
        self.assertEqual(encoding, capture.ENCODING_JSON)
        self.assertEqual(self.reading(recorded), stored, "the recorder decoded what the daemon did not")

        entry = capture.payload_to_dict(recorded)
        for replay in (capture.ENCODING_JSON, capture.ENCODING_PROTOBUF):
            with self.subTest(replayed_as=replay):
                replayed = self.daemon(capture.encode_wire_payload(entry, replay))
                self.assertEqual(self.reading(replayed), stored)

        # The original body as a hand-written capture entry, played back as protobuf.
        edited = self.daemon(capture.dict_to_payload_bytes(body))
        self.assertEqual(self.reading(edited), stored, "dict_to_payload() read the body differently")
        return entry

    def test_every_fixture_case_replays_as_stored(self):
        for case in self.cases:
            with self.subTest(case=case["metric"]["name"]):
                self.assert_replays_as_stored({"timestamp": self.TIMESTAMP, "seq": 4,
                                               "metrics": [case["metric"]]})

    def test_the_whole_fixture_in_one_message_replays_as_stored(self):
        # A refused metric costs only itself on both sides, so the message is recorded.
        entry = self.assert_replays_as_stored({"timestamp": self.TIMESTAMP, "seq": 4,
                                               "metrics": [case["metric"] for case in self.cases]})
        kept = [case["metric"]["name"] for case in self.cases if not case.get("dropped")]
        self.assertEqual([metric["name"] for metric in entry["metrics"]], kept)

    def test_the_four_readings_the_recorder_used_to_get_wrong(self):
        # A bare `value` was lost, a negative Int64 was kept in 32 bits, an int_value too wide for
        # its field skipped the whole message, and the string "false" was recorded as true.
        entry = self.assert_replays_as_stored({"timestamp": self.TIMESTAMP, "metrics": [
            {"name": "Bare", "value": 2.5},
            {"name": "Offset", "datatype": 4, "int_value": -5},
            {"name": "Too_Wide", "int_value": 2**32},
            {"name": "Flag", "boolean_value": "false"},
            {"name": "Temperature", "datatype": 10, "double_value": 21.4},
        ]})
        self.assertEqual(entry["metrics"], [
            {"name": "Bare", "double_value": 2.5},
            {"name": "Offset", "datatype": 4, "long_value": 2**64 - 5},
            {"name": "Temperature", "datatype": 10, "double_value": 21.4},
        ])

    def test_metric_names_aliases_and_timestamps_replay_as_stored(self):
        entry = self.assert_replays_as_stored({"timestamp": self.TIMESTAMP, "metrics": [
            {"alias": 7, "datatype": 10, "double_value": 1.5},
            {"name": None, "alias": "8", "double_value": 2.5},
            {"name": "Stamped", "double_value": 3.5, "timestamp": self.TIMESTAMP - 10000},
            {"name": "Zero_Stamp", "double_value": 4.5, "timestamp": 0},
            {"name": "Text_Stamp", "double_value": 5.5, "timestamp": "1789999990000"},
            {"name": 5, "double_value": 6.5},
        ]})
        # An alias-only metric is recorded without a name, as the publisher sent it.
        self.assertNotIn("name", entry["metrics"][0])
        self.assertEqual(len(entry["metrics"]), 5)

    def test_a_seq_the_daemon_ignores_is_not_recorded(self):
        # Neither is a sequence number to the daemon. The recorder used to keep the first as 4 and
        # skip the whole message on the second.
        for seq in ("4", "x", True):
            with self.subTest(seq=seq):
                entry = self.assert_replays_as_stored({"timestamp": self.TIMESTAMP, "seq": seq,
                                                       "metrics": [{"name": "T", "double_value": 1.0}]})
                self.assertNotIn("seq", entry)

    def test_a_message_the_daemon_drops_is_not_recorded(self):
        # A null payload clock fails the daemon's whole JSON parse; the recorder skips it too.
        raw = json.dumps({"timestamp": None, "metrics": [{"name": "T", "double_value": 1.0}]}).encode()
        with self.assertLogs(ingestion.logger, "WARNING"):
            self.assertIsNone(self.daemon(raw))
        with self.assertRaises(TypeError):
            capture.decode_wire_payload(raw)


if __name__ == "__main__":
    unittest.main(verbosity=2)
