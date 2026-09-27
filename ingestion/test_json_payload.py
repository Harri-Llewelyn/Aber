"""
The JSON encoding of a Sparkplug payload, as parse_sparkplug_payload() reads it.

The appliance template publishes JSON, not protobuf, and publishes device readings by exception:
each metric carries the time it was read, and a refresh republishes unchanged values with the time
of the refresh. The protobuf path has always honoured a metric's own timestamp; these pin that the
JSON path does too, so a reading is filed when it was taken rather than when its message was built.

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


class _Message:
    topic = "spBv1.0/Aber/DDATA/gwy120000000000400080000/press-01"

    def __init__(self, body):
        self.payload = json.dumps(body).encode("utf-8")


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
