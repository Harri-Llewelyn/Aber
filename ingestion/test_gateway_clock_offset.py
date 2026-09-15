"""
Unit tests for the appliance clock offset measured on the gateway heartbeat
(`record_gateway_clock_offset` and its use in `process_node_message`, both in ingestion.py), and
for the edge-node label the timestamp rejection counter now leaves through.

WHY EACH PROPERTY HERE IS WORTH A TEST. The fault this measurement exists to find is the one that
breaks nothing else: an appliance a few minutes fast is ONLINE, is not stale, drops no messages,
skips no sequence numbers and verifies its certificate perfectly -- because TLS validity is
measured in months and this is measured in minutes. Every assertion below guards a way of
silently reporting a healthy clock for an appliance that does not have one.

  * THE EXTREME READINGS MUST BE KEPT, not rejected as implausible. `Cert_Expires_At` next door is
    bounded to dates that could be a certificate, and copying that instinct here would discard
    exactly the reading the measurement was added for: a single-board computer with no
    battery-backed clock coming back from a plant power cut at the epoch. A plausibility filter
    would blind this to its own worst case.
  * A PAYLOAD THAT CARRIED NO TIMESTAMP MUST PRODUCE NO SERIES. Sparkplug makes the field optional
    and parse_sparkplug_payload()'s JSON branch substitutes receipt time when it is absent -- which
    reads as a flawless clock. Recording a zero offset for an appliance that reported nothing to
    compare would be worse than recording nothing, because it looks like an answer.
  * NDEATH MUST NEVER BE MEASURED. It is the broker's Last Will, built by the appliance at CONNECT
    time and held until the connection drops, so its timestamp is the clock reading of an
    arbitrarily earlier moment. Measuring it would report every perfectly synchronised gateway in
    the fleet as hours slow at the instant it went offline.
  * NO DATETIME CONVERSION ANYWHERE. datetime.fromtimestamp() raises on values a genuinely wrong
    clock does produce, and an exception here is on the heartbeat path -- a diagnostic must not be
    able to take a gateway off the board.
  * THE REJECTION COUNTER MUST LEAVE EXACTLY ONCE. It is now exported labelled by edge node and
    must NOT also be exported unlabelled, or a scraper summing the series double-counts; and it
    must not fall through to the `unmapped` catch-all, which would mean the opposite of what its
    absence from COUNTER_MAP is there to say.

Same stubbing approach as test_gateway_health_metrics.py: the daemon's heavy imports (protobuf,
MQTT, psycopg2) are replaced before ingestion.py is loaded, so this stays pure logic with no
`protoc` and no broker.
"""
import os
import sys
import types
import unittest
from datetime import datetime, timezone
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
import metrics  # noqa: E402
import registry  # noqa: E402

GROUP = "ACS-Cymru"
NODE = "gwy110000000000400080000"

# The receipt time every measurement below is taken against. Fixed rather than `now`, so an
# assertion states an offset in seconds instead of restating the arithmetic under test.
AT = datetime(2026, 9, 8, 12, 0, 0, tzinfo=timezone.utc)
AT_MS = int(AT.timestamp() * 1000)


class FakePayload:
    """A Sparkplug payload as this path sees it: a payload-level timestamp and its metrics."""

    def __init__(self, timestamp=None, metrics=()):
        if timestamp is not None:
            self.timestamp = timestamp
        self.metrics = list(metrics)


class RecordGatewayClockOffsetTests(unittest.TestCase):
    def setUp(self):
        ingestion._gateway_clock_gauges.clear()
        # Module state keyed by edge node, and it would otherwise suppress the warning -- and
        # therefore hide a genuine regression -- in every test after the first one that trips it.
        ingestion._gateway_clock_warned.clear()

    def _record(self, timestamp_ms):
        ingestion.record_gateway_clock_offset(NODE, FakePayload(timestamp_ms), AT)
        return ingestion.gateway_clock_gauge_snapshot().get(NODE)

    def test_an_appliance_running_ahead_reports_a_positive_offset(self):
        # The direction that corrupts: its readings are filed at times that have not happened yet,
        # and inside the sanity window nothing refuses them.
        got = self._record(AT_MS + 90_000)
        self.assertAlmostEqual(got[ingestion.GATEWAY_CLOCK_OFFSET_GAUGE], 90.0, places=3)

    def test_an_appliance_running_behind_reports_a_negative_offset(self):
        got = self._record(AT_MS - 45_000)
        self.assertAlmostEqual(got[ingestion.GATEWAY_CLOCK_OFFSET_GAUGE], -45.0, places=3)

    def test_the_measurement_carries_the_time_it_was_taken(self):
        # Without this the offset is unreadable: a gauge holds its last value forever, so an
        # appliance powered down mid-fault would go on reporting the clock it had when it left.
        got = self._record(AT_MS)
        self.assertAlmostEqual(got[ingestion.GATEWAY_CLOCK_MEASURED_GAUGE], AT.timestamp(), places=3)

    def test_a_payload_with_no_timestamp_is_not_measured(self):
        ingestion.record_gateway_clock_offset(NODE, FakePayload(None), AT)
        self.assertEqual(ingestion.gateway_clock_gauge_snapshot(), {})

    def test_a_zero_timestamp_is_not_measured(self):
        # protobuf's zero default for an unset uint64, which is "nothing was sent" and not
        # "1970" -- and a 56-year offset invented from an absent field would be the loudest
        # possible false positive.
        self.assertIsNone(self._record(0))
        self.assertEqual(ingestion.gateway_clock_gauge_snapshot(), {})

    def test_an_appliance_that_came_up_at_the_epoch_is_recorded_rather_than_refused(self):
        # THE CASE THIS EXISTS FOR. A Raspberry Pi has no battery-backed real-time clock, so a
        # plant power cut restarts the fleet with no time at all. An implausibility filter here
        # would discard the reading that matters most.
        got = self._record(1)
        self.assertLess(got[ingestion.GATEWAY_CLOCK_OFFSET_GAUGE], -1.7e9)

    def test_a_timestamp_outside_datetime_range_does_not_raise(self):
        # datetime.fromtimestamp() raises on this; float arithmetic does not. The measurement is
        # on the heartbeat path, so a diagnostic must never be able to take a gateway off the
        # board -- which is why nothing here converts to a datetime.
        got = self._record(2 ** 63 - 1)
        self.assertGreater(got[ingestion.GATEWAY_CLOCK_OFFSET_GAUGE], 0)

    def test_a_later_measurement_replaces_the_previous_one(self):
        # REPLACED, NOT MERGED, unlike the health gauges: an offset is one reading taken fresh on
        # every heartbeat, so a stale half would be a clock reading nobody took.
        self._record(AT_MS + 10_000)
        got = self._record(AT_MS - 10_000)
        self.assertAlmostEqual(got[ingestion.GATEWAY_CLOCK_OFFSET_GAUGE], -10.0, places=3)


class ClockSkewWarningTests(unittest.TestCase):
    """The log half, at the site that made the measurement -- as every counter in this file is."""

    def setUp(self):
        ingestion._gateway_clock_gauges.clear()
        ingestion._gateway_clock_warned.clear()

    def _record(self, offset_seconds):
        ingestion.record_gateway_clock_offset(
            NODE, FakePayload(AT_MS + int(offset_seconds * 1000)), AT)

    def test_a_clock_inside_the_threshold_says_nothing(self):
        with self.assertLogs(ingestion.logger, level="WARNING") as captured:
            self._record(ingestion.GATEWAY_CLOCK_OFFSET_WARN_SECONDS - 1)
            # assertLogs fails an empty context, so something has to be logged to assert against.
            ingestion.logger.warning("sentinel")
        self.assertEqual([r for r in captured.output if "CLOCK SKEW" in r], [])

    def test_a_clock_past_the_threshold_warns_in_either_direction(self):
        for offset in (ingestion.GATEWAY_CLOCK_OFFSET_WARN_SECONDS,
                       -ingestion.GATEWAY_CLOCK_OFFSET_WARN_SECONDS):
            with self.subTest(offset=offset):
                ingestion._gateway_clock_warned.clear()
                with self.assertLogs(ingestion.logger, level="WARNING") as captured:
                    self._record(offset)
                self.assertTrue(any("CLOCK SKEW" in line for line in captured.output))

    def test_the_warning_is_throttled_per_edge_node(self):
        # A wrong clock is wrong on all 119 heartbeats an hour. Unthrottled, the one line that
        # names the appliance would be the only thing in the log.
        with self.assertLogs(ingestion.logger, level="WARNING") as captured:
            for _ in range(5):
                self._record(600)
        self.assertEqual(len([line for line in captured.output if "CLOCK SKEW" in line]), 1)

    def test_the_threshold_stays_inside_the_sanity_window(self):
        # The warning has to arrive while telemetry is still being ACCEPTED. Once the offset
        # passes TELEMETRY_MAX_FUTURE_SECONDS the readings are dropped instead, and the fault has
        # been silently misfiling data for however long it took to get there.
        self.assertLess(
            ingestion.GATEWAY_CLOCK_OFFSET_WARN_SECONDS, ingestion.TELEMETRY_MAX_FUTURE_SECONDS)


class ProcessNodeMessageClockTests(unittest.TestCase):
    """The wiring: which messages are measured, and for which gateways."""

    def setUp(self):
        ingestion._gateway_clock_gauges.clear()
        ingestion._gateway_clock_warned.clear()

        self.client = MagicMock()
        chain = MagicMock()
        chain.execute.return_value = None
        self.client.rpc.return_value = chain

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

    def _send(self, msg_type, timestamp_ms=None):
        ingestion.process_node_message(
            NODE, msg_type, FakePayload(timestamp_ms), group_id=GROUP)
        return ingestion.gateway_clock_gauge_snapshot()

    def test_an_nbirth_and_an_ndata_are_both_measured(self):
        for msg_type in ("NBIRTH", "NDATA"):
            with self.subTest(msg_type=msg_type):
                ingestion._gateway_clock_gauges.clear()
                self.assertIn(NODE, self._send(msg_type, timestamp_ms=AT_MS))

    def test_an_ndeath_is_never_measured(self):
        # The Last Will, registered at CONNECT time. Its timestamp is the clock reading of an
        # arbitrarily earlier moment, so measuring it would report every clean gateway in the
        # fleet as hours slow the instant it disconnected.
        self.assertEqual(self._send("NDEATH", timestamp_ms=AT_MS), {})

    def test_an_unregistered_edge_node_cannot_add_a_series(self):
        # The same bound the health gauges get, inherited for free by measuring only after
        # resolve_gateway() has matched: an unknown or forged edge node id publishing into the
        # broker cannot grow this dict without limit.
        ingestion.resolve_gateway = lambda node, group=None: None
        self.assertEqual(self._send("NDATA", timestamp_ms=AT_MS), {})

    def test_the_measurement_does_not_depend_on_the_appliance_reporting_health(self):
        # The whole reason this is not folded into the health gauges. An appliance on a bundle
        # predating health reporting sends none of those metrics and still has a clock.
        got = self._send("NDATA", timestamp_ms=AT_MS)
        self.assertIn(NODE, got)
        self.assertEqual(ingestion.gateway_health_gauge_snapshot(), {})


class ClockGaugeExpositionTests(unittest.TestCase):
    """What a scraper actually sees, rendered through the real registry."""

    def setUp(self):
        registry.reset()

    def render(self, series):
        """The exposition with `series` as what the daemon holds when the scrape arrives."""
        registry.set_scrape_time_source(lambda: series)
        return registry.render()

    def test_both_gauges_render_labelled_by_edge_node(self):
        body = self.render({
            (ingestion.GATEWAY_CLOCK_OFFSET_GAUGE, (("edge_node", NODE),)): -12.5,
            (ingestion.GATEWAY_CLOCK_MEASURED_GAUGE, (("edge_node", NODE),)): 1757332800.0,
        })
        self.assertIn(
            'acs_ingestion_gateway_clock_offset_seconds{edge_node="%s"} -12.5' % NODE, body)
        self.assertIn(
            'acs_ingestion_gateway_clock_measured_timestamp_seconds{edge_node="%s"}' % NODE, body)

    def test_they_are_typed_as_gauges(self):
        # A counter by default. Typed wrongly, `rate()` on a clock being corrected would produce
        # a number, and it would be meaningless rather than absent.
        body = self.render({(ingestion.GATEWAY_CLOCK_OFFSET_GAUGE, (("edge_node", NODE),)): 1.0})
        self.assertIn("# TYPE acs_ingestion_gateway_clock_offset_seconds gauge", body)

    def test_both_gauges_are_documented(self):
        for metric in (ingestion.GATEWAY_CLOCK_OFFSET_GAUGE, ingestion.GATEWAY_CLOCK_MEASURED_GAUGE):
            with self.subTest(metric=metric):
                self.assertIn(metric, metrics.HELP)


class TimestampRejectionLabelTests(unittest.TestCase):
    """
    The counter that could not name the appliance, which is the other half of the same fault.

    An out-of-window timestamp is almost always a clock rather than a device, and unlabelled the
    counter said the fleet had lost samples without saying which gateway lost them -- the one line
    that named it went to a log nothing keeps.
    """

    def setUp(self):
        registry.reset()

    def samples(self, body):
        """Sample lines only. A declared family carries a HELP/TYPE pair before it has any."""
        return [line for line in body.split("\n") if line and not line.startswith("#")]

    def test_the_flat_counter_is_not_exported_unlabelled(self):
        # Both call sites, as ingestion.py has them: the flat count beside the labelled one, with
        # the same increment. Exporting both would give a scraper two ways to count one rejection.
        registry.count("metrics_rejected_timestamp", 7)
        registry.count_labelled(
            "acs_ingestion_timestamps_rejected_total", {"edge_node": NODE}, 7)
        samples = self.samples(registry.render())
        self.assertNotIn("acs_ingestion_timestamps_rejected_total 7.0", samples)
        self.assertIn(
            'acs_ingestion_timestamps_rejected_total{edge_node="%s"} 7.0' % NODE, samples)

    def test_it_is_not_reported_as_an_unmapped_counter(self):
        # The catch-all means "metrics.py has fallen behind ingestion.py". Letting this fall into
        # it would say the exact opposite of what its absence from COUNTER_MAP is there to say.
        registry.count("metrics_rejected_timestamp", 7)
        for line in self.samples(registry.render()):
            self.assertFalse(line.startswith("acs_ingestion_unmapped_counter_total"), line)

    def test_it_still_reads_back_under_its_flat_name(self):
        # The other half of the omission: the STATS log line reports by flat name, so a counter
        # not exported under one of its own must still be summed back from the series that carries
        # it. Dropping that is how the omission would quietly become a loss.
        registry.count("metrics_rejected_timestamp", 7)
        registry.count_labelled(
            "acs_ingestion_timestamps_rejected_total", {"edge_node": NODE}, 7)
        self.assertEqual(7, registry.counter_snapshot()["metrics_rejected_timestamp"])

    def test_the_reason_for_the_omission_is_recorded_beside_the_name(self):
        self.assertIn("metrics_rejected_timestamp", metrics.EXPORTED_LABELLED_INSTEAD)

    def test_the_labelled_series_names_the_edge_node(self):
        registry.count_labelled(
            "acs_ingestion_timestamps_rejected_total", {"edge_node": NODE}, 3)
        self.assertIn(
            'acs_ingestion_timestamps_rejected_total{edge_node="%s"} 3.0' % NODE,
            self.samples(registry.render()))

    def test_the_message_total_omission_still_holds(self):
        # The pre-existing member of the same table, kept asserted because generalising a single
        # `if` into a lookup is exactly the edit that silently drops the original case.
        registry.count("messages_total", 42)
        registry.count("messages_DDATA", 42)
        samples = self.samples(registry.render())
        self.assertNotIn("acs_ingestion_messages_total 42.0", samples)
        self.assertIn('acs_ingestion_messages_total{msg_type="DDATA"} 42.0', samples)
        self.assertEqual(42, registry.counter_snapshot()["messages_total"])


if __name__ == "__main__":
    unittest.main()
