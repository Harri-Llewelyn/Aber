"""
Unit tests for appliance health metrics on the gateway heartbeat (`extract_gateway_health` and its
use in `process_node_message`, both in ingestion.py).

WHY EACH PROPERTY HERE IS WORTH A TEST. Every one of them, broken, breaks in the same direction:
toward a number on an operator's page that is wrong in a way nothing else would notice.

  * A REJECTED METRIC MUST NOT TAKE THE HEARTBEAT WITH IT. Migration 0035 declines to put CHECK
    constraints on these columns precisely because they are written in the same UPDATE as `status`
    and `last_heartbeat` -- so the validation that replaces those constraints has to drop one
    metric and keep the rest. If it ever threw instead, a gateway reporting a garbled disk figure
    would stop reporting ONLINE, and a cosmetic fault would present as an outage.
  * AN EXPIRED CERTIFICATE MUST BE ACCEPTED. `Cert_Expires_At` exists for the CA-expiry failure
    (docs/incidents.md), so a notAfter in the past is the single most important reading it can
    carry. A plausible-looking "must be in the future" guard would discard exactly the value the
    column was added for.
  * `health_reported_at` MUST BE STAMPED ONLY WHEN SOMETHING WAS RECOGNISED, or the column stops
    distinguishing "this bundle does not report health" from "it stopped reporting it" -- which
    0035 gives as the whole reason it is separate from `last_heartbeat`.
  * ALIAS RESOLUTION MUST APPLY. A node publishing alias-optimised NDATA carries no metric names
    at all, so a raw `metric.name` test would see a reporting appliance as reporting nothing.

Same stubbing approach as test_declared_metrics.py: the daemon's heavy imports (protobuf, MQTT,
psycopg2) are replaced before ingestion.py is loaded, so this stays pure logic with no `protoc`
and no broker.
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
    if "." in name:
        parent, _, leaf = name.rpartition(".")
        if parent in sys.modules:
            setattr(sys.modules[parent], leaf, sys.modules[name])
    return module


_stub("psycopg2", connect=lambda *a, **k: None)
_stub("psycopg2.extras", execute_values=lambda *a, **k: None)
_stub("sparkplug_b_pb2", Payload=object)
_stub("paho")
_stub("paho.mqtt")
_stub("paho.mqtt.client", Client=object)

import ingestion  # noqa: E402  (must follow the stubs above)

GROUP = "ACS-Cymru"
NODE = "gwy110000000000400080000"


class FakeMetric:
    """
    A Sparkplug metric as the code under test sees it. Exactly one value field is `present`, which
    is what protobuf's `HasField` reports and what `_numeric_metric_value` walks.
    """

    def __init__(self, name="", alias=None, **values):
        self.name = name
        self.alias = alias if alias is not None else 0
        self._present = set()
        if alias is not None:
            self._present.add("alias")
        for field, value in values.items():
            setattr(self, field, value)
            self._present.add(field)

    def HasField(self, field):
        return field in self._present

    def __getattr__(self, field):
        # An absent value field reads as protobuf's zero default, never as an AttributeError --
        # the code under test is entitled to assume the field exists once HasField says so, and
        # entitled to be wrong about it in a way that shows up here rather than in production.
        if field.endswith("_value"):
            return "" if field == "string_value" else 0
        raise AttributeError(field)


class FakePayload:
    def __init__(self, metrics):
        self.metrics = metrics


def health(*metrics):
    return ingestion.extract_gateway_health(GROUP, NODE, FakePayload(list(metrics)))


class ExtractGatewayHealthTests(unittest.TestCase):
    def setUp(self):
        # The rejection throttle is module state keyed by edge node, and it would otherwise
        # suppress the warning -- and therefore hide a genuine regression -- in every test after
        # the first one that trips it.
        ingestion._health_rejected_warned.clear()

    def test_every_recognised_metric_maps_to_its_column(self):
        got = health(
            FakeMetric("Uptime_s", int_value=4210),
            FakeMetric("Load_1m", double_value=0.42),
            FakeMetric("Mem_Available_Bytes", long_value=1_073_741_824),
            FakeMetric("Disk_Free_Bytes", long_value=52_428_800),
            FakeMetric("Agent_Version", string_value="1.4.0"),
            FakeMetric("Flow_Hash", string_value="a" * 64),
        )
        self.assertEqual(got["uptime_seconds"], 4210)
        self.assertAlmostEqual(got["load_1m"], 0.42)
        self.assertEqual(got["mem_available_bytes"], 1_073_741_824)
        self.assertEqual(got["disk_free_bytes"], 52_428_800)
        self.assertEqual(got["agent_version"], "1.4.0")
        self.assertEqual(got["flow_hash"], "a" * 64)
        # Integers stay integers: the columns are bigint, and a float here would round-trip
        # through JSON as 4210.0 and be refused.
        self.assertIsInstance(got["uptime_seconds"], int)

    def test_a_payload_with_nothing_recognised_yields_nothing(self):
        # The ordinary case for the platform's own simulators and for any appliance on a bundle
        # predating 0035 -- it must be empty rather than partially populated, because the caller
        # keys `health_reported_at` off emptiness.
        self.assertEqual(health(
            FakeMetric("Gateway_Status", string_value="ONLINE"),
            FakeMetric("bdSeq", int_value=7),
        ), {})

    def test_a_rejected_metric_does_not_discard_its_neighbours(self):
        got = health(
            FakeMetric("Disk_Free_Bytes", long_value=-1),
            FakeMetric("Uptime_s", int_value=99),
        )
        self.assertNotIn("disk_free_bytes", got)
        self.assertEqual(got["uptime_seconds"], 99)

    def test_negative_quantities_are_refused(self):
        for name in ("Uptime_s", "Load_1m", "Mem_Available_Bytes", "Disk_Free_Bytes"):
            with self.subTest(metric=name):
                self.assertEqual(health(FakeMetric(name, double_value=-0.5)), {})

    def test_non_finite_numbers_are_refused(self):
        # NaN and the infinities are floats, so they pass a type check and then serialise into
        # JSON the database refuses -- which would fail the whole heartbeat UPDATE.
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                self.assertEqual(health(FakeMetric("Load_1m", double_value=value)), {})

    def test_a_numeric_metric_carrying_no_number_is_refused(self):
        self.assertEqual(health(FakeMetric("Uptime_s", string_value="4210")), {})

    def test_a_text_metric_carrying_no_string_is_refused(self):
        self.assertEqual(health(FakeMetric("Agent_Version", int_value=140)), {})

    def test_text_is_trimmed_and_bounded(self):
        self.assertEqual(health(FakeMetric("Agent_Version", string_value="  1.4.0  "))
                         ["agent_version"], "1.4.0")
        self.assertEqual(health(FakeMetric("Agent_Version", string_value="   ")), {})
        # Over-length is dropped, never truncated: a truncated flow hash matches nothing and would
        # read as "this appliance is running something we never deployed".
        self.assertEqual(health(FakeMetric("Flow_Hash", string_value="b" * 65)), {})

    def test_an_expired_certificate_date_is_accepted(self):
        # THE READING THE COLUMN EXISTS FOR. 2020-01-01, years in the past.
        got = health(FakeMetric("Cert_Expires_At", long_value=1577836800000))
        self.assertTrue(got["cert_expires_at"].startswith("2020-01-01T00:00:00"))

    def test_certificate_dates_are_converted_to_utc_iso(self):
        got = health(FakeMetric("Cert_Expires_At", long_value=4102444800000))
        self.assertTrue(got["cert_expires_at"].startswith("2100-01-01T00:00:00"))
        self.assertIn("+00:00", got["cert_expires_at"])

    def test_implausible_certificate_dates_are_refused(self):
        for value in (
            0,                    # unset, or a parse that produced nothing
            1577836800,           # seconds where milliseconds were meant
            99999999999999,       # far beyond any certificate's lifetime
        ):
            with self.subTest(value=value):
                self.assertEqual(health(FakeMetric("Cert_Expires_At", long_value=value)), {})

    def test_an_alias_only_metric_resolves_through_the_birth_map(self):
        birth = FakePayload([FakeMetric("Disk_Free_Bytes", alias=11)])
        ingestion.register_birth_aliases(GROUP, NODE, birth, reset=True)
        got = health(FakeMetric("", alias=11, long_value=4096))
        self.assertEqual(got["disk_free_bytes"], 4096)

    def test_a_rejection_is_counted(self):
        before = ingestion.counter_snapshot().get("gateway_health_metrics_rejected", 0)
        health(FakeMetric("Uptime_s", long_value=-1))
        after = ingestion.counter_snapshot().get("gateway_health_metrics_rejected", 0)
        self.assertEqual(after, before + 1)


class ProcessNodeMessageHealthTests(unittest.TestCase):
    """The wiring: what actually reaches the UPDATE."""

    def setUp(self):
        ingestion._health_rejected_warned.clear()
        self.updates = []

        self.client = MagicMock()
        self.client.rpc.side_effect = lambda fn, params: self._capture(fn, params)

        self._real_client = ingestion.supabase_client
        self._real_resolve = ingestion.resolve_gateway
        ingestion.supabase_client = self.client
        ingestion.resolve_gateway = lambda node, group=None: {
            "id": "11000000-0000-4000-8000-000000000001",
            "name": "Test Gateway",
            "status": "ONLINE",
        }

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        ingestion.resolve_gateway = self._real_resolve

    def _capture(self, fn, params):
        if fn == "ingest_record_gateway_health":
            self.updates.append(params)
        chain = MagicMock()
        chain.execute.return_value = None
        return chain

    def _send(self, *metrics):
        """
        The parameters of the ingest_record_gateway_health() call the heartbeat made.

        The write goes through a gate now (roadmap item 16, migration 0047), so the health
        readings arrive as a `p_health` object rather than as columns spread across an UPDATE
        payload. `_flat` below keeps the assertions reading the way they did.
        """
        ingestion.process_node_message(NODE, "NDATA", FakePayload(list(metrics)), group_id=GROUP)
        return self.updates[-1]

    @staticmethod
    def _flat(params):
        """The call flattened back into the column view the assertions are written against."""
        flat = {"status": params["p_status"], "last_heartbeat": params["p_heartbeat_at"]}
        flat.update(params.get("p_health") or {})
        return flat

    def test_health_metrics_reach_the_gate_and_mark_it_as_reporting(self):
        params = self._send(FakeMetric("Disk_Free_Bytes", long_value=8192))
        self.assertEqual(self._flat(params)["disk_free_bytes"], 8192)
        # `health_reported_at` is no longer stamped here: the gate stamps it, and only when
        # `p_health` is a non-empty object. A non-empty p_health IS the signal, so that is what
        # this asserts -- and 0047's self-check asserts the gate acts on it. Sending the timestamp
        # from the daemon would have made it a caller convention again.
        self.assertTrue(params["p_health"])
        self.assertEqual(params["p_heartbeat_at"], self._flat(params)["last_heartbeat"])

    def test_a_payload_reporting_no_health_leaves_the_timestamp_alone(self):
        # An appliance on an older bundle. It must beat normally and leave `health_reported_at`
        # untouched -- writing it here would make "does not report health" indistinguishable from
        # "reported health a moment ago", which is the distinction 0035 adds the column for.
        params = self._send(FakeMetric("Gateway_Status", string_value="ONLINE"))
        # No health object at all, which is what keeps the gate from stamping the column.
        self.assertIsNone(params["p_health"])
        self.assertEqual(params["p_status"], "ONLINE")
        self.assertIsNotNone(params["p_heartbeat_at"])

    def test_a_rejected_metric_still_leaves_a_heartbeat(self):
        # The property that replaces the CHECK constraints 0035 declines to add.
        params = self._send(FakeMetric("Disk_Free_Bytes", long_value=-5))
        self.assertNotIn("disk_free_bytes", self._flat(params))
        self.assertIsNone(params["p_health"])
        self.assertIsNotNone(params["p_heartbeat_at"])
        self.assertEqual(params["p_status"], "ONLINE")


class GatewayHealthGaugeTests(unittest.TestCase):
    """
    The scrapeable half. These gauges exist because the columns hold a latest value and no history,
    so "is the disk filling" is answerable here and nowhere else.

    THE EXCLUSIONS ARE THE ASSERTION THAT MATTERS. The metrics endpoint needs no credential and is
    published to the host, so `agent_version`, `flow_hash` and `cert_expires_at` must never appear
    on it -- the first two fingerprint an appliance's deployed configuration, and the third is the
    day the whole fleet's trust anchor dies. A future edit that "completes" the gauge set by adding
    them would be a real widening of an unauthenticated surface, and this is what says so.
    """

    def setUp(self):
        ingestion._gateway_health_gauges.clear()

    def _record(self, health, when=None):
        from datetime import datetime, timezone
        ingestion.record_gateway_health_gauges(
            NODE, health, when or datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc))
        return ingestion.gateway_health_gauge_snapshot()[NODE]

    def test_the_four_trend_readings_are_exported(self):
        got = self._record({
            'uptime_seconds': 4210, 'load_1m': 0.42,
            'mem_available_bytes': 6423183360, 'disk_free_bytes': 52428288000,
        })
        self.assertEqual(got['acs_ingestion_gateway_uptime_seconds'], 4210)
        self.assertEqual(got['acs_ingestion_gateway_load1'], 0.42)
        self.assertEqual(got['acs_ingestion_gateway_mem_available_bytes'], 6423183360)
        self.assertEqual(got['acs_ingestion_gateway_disk_free_bytes'], 52428288000)

    def test_the_unauthenticated_endpoint_never_sees_the_other_three(self):
        got = self._record({
            'disk_free_bytes': 4096,
            'agent_version': '1.4.0',
            'flow_hash': 'd' * 64,
            'cert_expires_at': '2027-09-28T09:30:14+00:00',
        })
        exported = ' '.join(got)
        for forbidden in ('agent', 'version', 'flow_hash', 'cert', 'expires'):
            self.assertNotIn(forbidden, exported)
        self.assertNotIn('1.4.0', [str(v) for v in got.values()])
        # And the one that should be there still is, so this is not passing by exporting nothing.
        self.assertEqual(got['acs_ingestion_gateway_disk_free_bytes'], 4096)

    def test_a_partial_payload_merges_rather_than_zeroing_the_rest(self):
        self._record({'load_1m': 1.5, 'disk_free_bytes': 100})
        got = self._record({'disk_free_bytes': 90})
        self.assertEqual(got['acs_ingestion_gateway_load1'], 1.5)
        self.assertEqual(got['acs_ingestion_gateway_disk_free_bytes'], 90)

    def test_the_reported_timestamp_moves_with_every_recognised_payload(self):
        from datetime import datetime, timedelta, timezone
        first = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
        a = self._record({'disk_free_bytes': 1}, first)[ingestion.HEALTH_REPORTED_GAUGE]
        b = self._record({'disk_free_bytes': 1}, first + timedelta(minutes=5))[
            ingestion.HEALTH_REPORTED_GAUGE]
        self.assertEqual(b - a, 300)

    def test_they_render_as_labelled_gauges(self):
        self._record({'disk_free_bytes': 52428288000})
        labelled = {
            (metric, (("edge_node", NODE),)): value
            for node, values in ingestion.gateway_health_gauge_snapshot().items()
            for metric, value in values.items()
        }
        text = ingestion.metrics.render_exposition(counters={}, labelled=labelled)
        self.assertIn('# TYPE acs_ingestion_gateway_disk_free_bytes gauge', text)
        self.assertIn(
            'acs_ingestion_gateway_disk_free_bytes{edge_node="%s"} 52428288000' % NODE, text)
        # A metric with no TYPES entry renders as a counter, which for a disk figure would be
        # wrong in a way only a rate() query would reveal.
        self.assertNotIn('# TYPE acs_ingestion_gateway_disk_free_bytes counter', text)

    def test_the_rejection_counter_is_mapped(self):
        # An unmapped counter still reaches a scraper, but as
        # acs_ingestion_unmapped_counter_total{counter="..."} -- which no dashboard or alert would
        # be written against. This is the assertion that it was named properly.
        text = ingestion.metrics.render_exposition(
            counters={'gateway_health_metrics_rejected': 3})
        self.assertIn('acs_ingestion_gateway_health_rejected_total 3', text)
        self.assertNotIn('unmapped', text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
