"""
Unit tests for the ingestion daemon's birth-metric observation
(`extract_declared_metrics` / `record_declared_metrics` in ingestion.py).

Unlike the edge-function suites, which mirror TypeScript logic in Python, these exercise the
shipped functions directly -- there is no second copy to drift from. To do that without the
daemon's runtime, the heavy imports at the top of ingestion.py (protobuf, MQTT, psycopg2) are
stubbed before it is loaded: none of them are reachable from the code under test, and requiring
a compiled sparkplug_b_pb2 would tie a pure-logic test to `protoc` being installed.
"""
import os
import sys
import types
import unittest
from unittest.mock import MagicMock

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)


def _stub(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules.setdefault(name, module)
    # Also bind onto the parent package, so `import paho.mqtt.client as mqtt` resolves by
    # attribute access rather than relying on the sys.modules fallback.
    if "." in name:
        parent, _, leaf = name.rpartition(".")
        if parent in sys.modules:
            setattr(sys.modules[parent], leaf, sys.modules[name])
    return module


_stub("psycopg2", connect=lambda *a, **k: None)
_stub("sparkplug_b_pb2", Payload=object)
_stub("paho")
_stub("paho.mqtt")
_stub("paho.mqtt.client", Client=object)

import ingestion  # noqa: E402  (must follow the stubs above)


class FakeMetric:
    """The only attribute extract_declared_metrics reads is `.name`."""
    def __init__(self, name):
        self.name = name


class FakePayload:
    def __init__(self, *names):
        self.metrics = [FakeMetric(n) for n in names]


class TestExtractDeclaredMetrics(unittest.TestCase):

    def test_returns_sorted_unique_names(self):
        declared = ingestion.extract_declared_metrics(
            FakePayload("temperature", "availability", "temperature")
        )
        self.assertEqual(declared, ["availability", "temperature"])

    def test_identity_metrics_are_excluded(self):
        """Asset_ID/Asset_Name carry identity, not something a schema should model."""
        declared = ingestion.extract_declared_metrics(
            FakePayload("Asset_ID", "Asset_Name", "vibration")
        )
        self.assertEqual(declared, ["vibration"])

    def test_valueless_metrics_are_still_declared(self):
        """
        The divergence from store_birth_parameters, which skips metrics carrying no value
        because it is recording parameter values. A metric declared with no value is exactly
        the kind of thing a schema should account for, so it must count here.
        """
        declared = ingestion.extract_declared_metrics(FakePayload("no_value_yet"))
        self.assertEqual(declared, ["no_value_yet"])

    def test_unnamed_metrics_are_ignored(self):
        declared = ingestion.extract_declared_metrics(FakePayload("", "temperature"))
        self.assertEqual(declared, ["temperature"])

    def test_birth_declaring_nothing_yields_empty_list(self):
        """
        Empty list, not None: "a birth was observed and it declared nothing" is a different
        finding from "no birth has ever been observed", which is NULL in the column.
        """
        self.assertEqual(ingestion.extract_declared_metrics(FakePayload("Asset_ID")), [])


class TestRecordDeclaredMetrics(unittest.TestCase):

    def setUp(self):
        self._real_client = ingestion.supabase_client
        self.client = MagicMock()
        ingestion.supabase_client = self.client

    def tearDown(self):
        ingestion.supabase_client = self._real_client

    def _update_payloads(self):
        return [c.args[0] for c in self.client.table.return_value.update.call_args_list]

    def test_writes_when_the_declared_set_is_new(self):
        device = {"id": "dev-uuid", "name": "Robot_01", "last_birth_metrics": None}
        ingestion.record_declared_metrics(device, FakePayload("temperature", "vibration"))

        payloads = self._update_payloads()
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["last_birth_metrics"], ["temperature", "vibration"])
        self.assertIn("last_birth_metrics_at", payloads[0])

    def test_no_write_when_the_declared_set_is_unchanged(self):
        """
        The point of the change check: log_digital_thread_event() fires on every UPDATE to
        `devices`, so an unchanged rewrite on each rebirth would append an audit row every
        time to a table that is deliberately append-only.
        """
        device = {"id": "dev-uuid", "name": "Robot_01",
                  "last_birth_metrics": ["temperature", "vibration"]}
        ingestion.record_declared_metrics(device, FakePayload("vibration", "temperature"))
        self.assertEqual(self._update_payloads(), [])

    def test_write_when_a_metric_is_added(self):
        device = {"id": "dev-uuid", "name": "Robot_01", "last_birth_metrics": ["temperature"]}
        ingestion.record_declared_metrics(device, FakePayload("temperature", "humidity"))

        payloads = self._update_payloads()
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["last_birth_metrics"], ["humidity", "temperature"])

    def test_write_when_a_metric_is_removed(self):
        device = {"id": "dev-uuid", "name": "Robot_01",
                  "last_birth_metrics": ["humidity", "temperature"]}
        ingestion.record_declared_metrics(device, FakePayload("temperature"))
        self.assertEqual(self._update_payloads()[0]["last_birth_metrics"], ["temperature"])

    def test_cached_row_is_updated_in_place(self):
        """
        resolve_device caches the same dict, so the in-place update is what stops a second
        birth inside the cache TTL from re-detecting the same change and writing again.
        """
        device = {"id": "dev-uuid", "name": "Robot_01", "last_birth_metrics": None}
        ingestion.record_declared_metrics(device, FakePayload("temperature"))
        self.assertEqual(device["last_birth_metrics"], ["temperature"])

        ingestion.record_declared_metrics(device, FakePayload("temperature"))
        self.assertEqual(len(self._update_payloads()), 1)

    def test_supabase_failure_does_not_propagate(self):
        """A failed write must not abort DBIRTH handling; the next birth retries."""
        self.client.table.return_value.update.side_effect = RuntimeError("supabase down")
        device = {"id": "dev-uuid", "name": "Robot_01", "last_birth_metrics": None}

        ingestion.record_declared_metrics(device, FakePayload("temperature"))

        # The row is left unchanged, so the write is retried rather than assumed applied.
        self.assertIsNone(device["last_birth_metrics"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
