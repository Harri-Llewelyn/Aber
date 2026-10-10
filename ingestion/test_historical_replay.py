"""
Unit tests for readings an edge node replays after an outage, and for the outage report it sends.

An appliance that could not deliver buffers its readings and replays them with `is_historical`
set on each metric. What this suite holds, each a way of losing or mis-filing data silently:

  * IS_HISTORICAL IS READ ON BOTH ENCODINGS. The appliance and conformant edge nodes publish
    protobuf; the daemon also reads JSON. A flag only one path read would hold the other to the
    24-hour window.
  * A REPLAY HAS ITS OWN WINDOW. A historical reading up to TELEMETRY_MAX_HISTORICAL_AGE_SECONDS
    old is written; a live one past 24 hours is still refused. Every refusal is counted by edge
    node and reason, and stamped for the alert.
  * A REPLAY SAYS NOTHING ABOUT NOW. It does not set a device ONLINE, reach the UNS (whose retained
    topics are current values), set a gateway's status, health or clock offset.
  * A REPLAY OUT OF ORDER IS NOT A GAP, and a replay in order is checked like any message.
  * THE OUTAGE REPORT IS COUNTED ONCE, from a registered gateway only, and an unusable one is
    refused rather than guessed at. An NBIRTH declares it null when there is none: not a refusal.
  * REPLAYED DATA MEETS THE SAME QUARANTINE AND BINDING CHECKS: a replay for a quarantined device
    or through the wrong gateway is dropped as live data is.
"""
import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import capture  # noqa: E402
import ingestion  # noqa: E402
import registry  # noqa: E402
import sparkplug_b_pb2  # noqa: E402

GROUP = "Aber"
NODE = "gwy" + "3" * 21
DEVICE = "dev" + "4" * 21
DAY_MS = 24 * 3600 * 1000


def now_ms():
    return int(time.time() * 1000)


def payload(*metrics, seq=None):
    """A protobuf payload; each metric is (name, value, timestamp_ms, historical)."""
    out = sparkplug_b_pb2.Payload()
    out.timestamp = now_ms()
    if seq is not None:
        out.seq = seq
    for name, value, stamp, historical in metrics:
        m = out.metrics.add()
        m.name = name
        m.datatype = 10
        m.double_value = float(value)
        m.timestamp = stamp
        if historical:
            m.is_historical = True
    return out


def samples():
    return [line for line in registry.render().split("\n") if line and not line.startswith("#")]


class JsonEncodingTest(unittest.TestCase):
    def test_json_true_sets_the_flag(self):
        p = capture.json_payload({"metrics": [
            {"name": "T", "datatype": 10, "double_value": 1.0, "timestamp": 5, "is_historical": True}]})
        self.assertTrue(ingestion.is_historical(p.metrics[0]))

    def test_absent_or_not_a_json_true_leaves_it_unset(self):
        for value in (None, False, "true", 1):
            with self.subTest(value=value):
                m = {"name": "T", "datatype": 10, "double_value": 1.0}
                if value is not None:
                    m["is_historical"] = value
                metric = capture.json_payload({"metrics": [m]}).metrics[0]
                self.assertFalse(metric.HasField("is_historical"))

    def test_a_capture_keeps_the_flag(self):
        p = payload(("T", 1.0, now_ms(), True))
        self.assertTrue(capture.dict_to_payload(capture.payload_to_dict(p)).metrics[0].is_historical)


class WindowTest(unittest.TestCase):
    NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)

    def refusal(self, delta, historical):
        return ingestion.timestamp_refusal(self.NOW + delta, historical, self.NOW)

    def test_two_days_late_is_refused_live_and_kept_historical(self):
        self.assertEqual(self.refusal(timedelta(days=-2), False), ingestion.TIMESTAMP_TOO_OLD)
        self.assertIsNone(self.refusal(timedelta(days=-2), True))

    def test_past_the_historical_bound_is_refused_with_its_own_reason(self):
        late = -timedelta(seconds=ingestion.TELEMETRY_MAX_HISTORICAL_AGE_SECONDS + 60)
        self.assertEqual(self.refusal(late, True), ingestion.TIMESTAMP_HISTORICAL_TOO_OLD)

    def test_the_future_bound_is_the_same_for_both(self):
        for historical in (False, True):
            self.assertEqual(self.refusal(timedelta(minutes=10), historical), ingestion.TIMESTAMP_TOO_NEW)

    def test_the_default_matches_the_appliance_buffer(self):
        self.assertEqual(ingestion.TELEMETRY_MAX_HISTORICAL_AGE_SECONDS, 7 * 24 * 3600)


class DdataTestCase(unittest.TestCase):
    def setUp(self):
        registry.reset()
        ingestion._device_seen.clear()
        ingestion._device_offline.clear()
        ingestion._last_seq.clear()
        ingestion._timestamp_refused_at.clear()
        self.device = {"id": "40000000-0000-4000-8000-000000000004", "name": "Press 4",
                       "sparkplug_id": DEVICE, "is_quarantined": False, "status": "OFFLINE"}
        self.binding = None
        self.written = MagicMock()
        self.uns = MagicMock(return_value=0)
        self.accept = MagicMock(return_value=True)
        cursor = MagicMock()
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        conn = MagicMock()
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=False)
        conn.cursor = MagicMock(return_value=cursor)
        for target, value in (
            ("resolve_device", lambda wire_id, use_cache=True, include_archived=False: self.device),
            ("verify_gateway_binding", lambda *a, **k: self.binding),
            ("get_timescaledb_connection", lambda: conn),
            ("execute_values", self.written),
            ("accept_device_data", self.accept),
            ("AUDIT_PAYLOAD_REJECTIONS", False),
        ):
            patcher = patch.object(ingestion, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(ingestion.uns_publish, "publish_ddata", self.uns)
        patcher.start()
        self.addCleanup(patcher.stop)

    def ingest(self, p):
        ingestion.process_ddata(DEVICE, NODE, p, group_id=GROUP, client=MagicMock())
        ingestion._writer.flush()

    def rows(self):
        return [row for c in self.written.call_args_list if "INSERT INTO telemetry" in c[0][1]
                for row in c[0][2]]


class ReplayedDdataTest(DdataTestCase):
    def test_a_replay_two_days_late_is_written_and_counted_as_historical(self):
        self.ingest(payload(("T", 1.0, now_ms() - 2 * DAY_MS, True), ("P", 2.0, now_ms() - 2 * DAY_MS, True)))
        self.assertEqual(sorted(r[2] for r in self.rows()), ["P", "T"])
        self.assertIn('aber_ingestion_historical_readings_total{edge_node="%s"} 2.0' % NODE, samples())

    def test_a_live_reading_two_days_late_is_still_refused_with_its_reason(self):
        self.ingest(payload(("T", 1.0, now_ms() - 2 * DAY_MS, False), ("P", 2.0, now_ms(), False)))
        self.assertEqual([r[2] for r in self.rows()], ["P"])
        self.assertIn('aber_ingestion_timestamps_rejected_total{edge_node="%s",reason="too_old"} 1.0' % NODE,
                      samples())

    def test_a_replay_past_the_historical_bound_is_refused_counted_and_stamped(self):
        late = now_ms() - (ingestion.TELEMETRY_MAX_HISTORICAL_AGE_SECONDS + 3600) * 1000
        self.ingest(payload(("T", 1.0, late, True)))
        self.assertEqual(self.rows(), [])
        self.assertIn(
            'aber_ingestion_timestamps_rejected_total{edge_node="%s",reason="historical_too_old"} 1.0' % NODE,
            samples())
        self.assertIn((NODE, ingestion.TIMESTAMP_HISTORICAL_TOO_OLD), ingestion.timestamp_refusal_gauge_snapshot())
        series = ingestion.scrape_time_series()
        self.assertIn((ingestion.TIMESTAMP_REFUSED_AT_GAUGE,
                       (("edge_node", NODE), ("reason", "historical_too_old"))), series)

    def test_a_replay_does_not_set_the_device_online(self):
        self.ingest(payload(("T", 1.0, now_ms() - DAY_MS, True)))
        self.accept.assert_not_called()
        self.ingest(payload(("T", 1.0, now_ms(), False)))
        self.accept.assert_called_once()

    def test_only_live_readings_reach_the_uns(self):
        stamp = now_ms()
        self.ingest(payload(("Old", 1.0, stamp - DAY_MS, True), ("New", 2.0, stamp, False)))
        published = self.uns.call_args[0][4]
        self.assertEqual([r[2] for r in published], ["New"])


class ReplayMeetsTheSameChecksTest(DdataTestCase):
    """Replayed data goes through the quarantine and binding checks live data does."""

    def test_a_replay_for_a_quarantined_device_is_dropped(self):
        self.device["is_quarantined"] = True
        self.ingest(payload(("T", 1.0, now_ms() - DAY_MS, True)))
        self.assertEqual(self.rows(), [])

    def test_a_replay_through_a_gateway_the_device_is_not_bound_to_is_dropped(self):
        self.binding = "bound to another edge node"
        self.ingest(payload(("T", 1.0, now_ms() - DAY_MS, True)))
        self.assertEqual(self.rows(), [])


class SequenceTest(unittest.TestCase):
    def setUp(self):
        registry.reset()
        ingestion._last_seq.clear()
        self.rebirth = patch.object(ingestion, "request_node_rebirth", MagicMock(return_value=False))
        self.asked = self.rebirth.start()
        self.addCleanup(self.rebirth.stop)

    def send(self, seq, historical=False, msg_type="DDATA"):
        p = payload(("T", 1.0, now_ms() - (DAY_MS if historical else 0), historical), seq=seq)
        return ingestion.check_message_sequence(GROUP, NODE, msg_type, p, client=MagicMock())

    def test_a_replay_sent_in_sequence_is_checked_like_any_message(self):
        self.send(10)
        self.assertTrue(self.send(11, historical=True))
        self.assertTrue(self.send(12))
        self.asked.assert_not_called()

    def test_a_replay_under_its_original_seq_is_not_a_gap_and_the_live_run_continues(self):
        self.send(200)
        for seq in (40, 41, 42):
            self.assertTrue(self.send(seq, historical=True))
        self.assertTrue(self.send(201))
        self.asked.assert_not_called()
        self.assertNotIn("aber_ingestion_sequence_gaps_total", "\n".join(samples()))
        self.assertIn('aber_ingestion_sequence_replayed_total{edge_node="%s"} 3.0' % NODE, samples())

    def test_a_live_gap_is_still_a_gap(self):
        self.send(10)
        self.assertFalse(self.send(13))
        self.asked.assert_called_once()


class NodeMessageTestCase(unittest.TestCase):
    def setUp(self):
        registry.reset()
        ingestion._gateway_outage_gauges.clear()
        ingestion._gateway_outage_counted.clear()
        ingestion._gateway_clock_gauges.clear()
        self.gateway = {"id": "50000000-0000-4000-8000-000000000005", "name": "Line 5", "status": "ONLINE"}
        self.supabase = MagicMock()
        for target, value in (
            ("supabase_client", self.supabase),
            ("resolve_gateway", lambda *a, **k: self.gateway),
        ):
            patcher = patch.object(ingestion, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def node(self, metrics, msg_type="NDATA"):
        p = sparkplug_b_pb2.Payload()
        p.timestamp = now_ms()
        for m in metrics:
            p.metrics.add().CopyFrom(m)
        ingestion.process_node_message(NODE, msg_type, p, group_id=GROUP)

    @staticmethod
    def number(name, value, datatype=10):
        m = sparkplug_b_pb2.Payload.Metric()
        m.name, m.datatype = name, datatype
        if datatype == 13:
            m.long_value = int(value)
        else:
            m.double_value = float(value)
        return m

    @staticmethod
    def flag(name, value):
        m = sparkplug_b_pb2.Payload.Metric()
        m.name, m.datatype, m.boolean_value = name, 11, value
        return m

    def report(self, started, ended, buffered=0, dropped=0, buffering=True):
        return [
            self.number(ingestion.OUTAGE_STARTED_AT, started, 13),
            self.number(ingestion.OUTAGE_ENDED_AT, ended, 13),
            self.number(ingestion.OUTAGE_READINGS_BUFFERED, buffered),
            self.number(ingestion.OUTAGE_READINGS_DROPPED, dropped),
            self.flag(ingestion.OUTAGE_BUFFERING, buffering),
        ]


class OutageReportTest(NodeMessageTestCase):
    def test_a_report_is_counted_and_exported(self):
        end = now_ms() - 1000
        self.node(self.report(end - 600_000, end, buffered=1200, dropped=30))
        out = samples()
        self.assertIn('aber_ingestion_gateway_outages_total{buffering="on",edge_node="%s"} 1.0' % NODE, out)
        self.assertIn('aber_ingestion_gateway_outage_readings_dropped_total{edge_node="%s"} 30.0' % NODE, out)
        self.assertIn('aber_ingestion_gateway_outage_readings_buffered_total{edge_node="%s"} 1200.0' % NODE, out)
        self.assertIn('aber_ingestion_gateway_outage_seconds_total{edge_node="%s"} 600.0' % NODE, out)
        gauges = ingestion.gateway_outage_gauge_snapshot()[NODE]
        self.assertEqual(gauges["aber_ingestion_gateway_outage_last_readings_dropped"], 30)
        self.assertIn(ingestion.OUTAGE_REPORTED_GAUGE, gauges)

    def test_a_repeated_report_is_counted_once(self):
        end = now_ms() - 1000
        for _ in range(3):
            self.node(self.report(end - 60_000, end, dropped=5))
        self.assertIn('aber_ingestion_gateway_outage_readings_dropped_total{edge_node="%s"} 5.0' % NODE, samples())

    def test_an_appliance_that_does_not_buffer_says_so(self):
        end = now_ms() - 1000
        self.node(self.report(end - 60_000, end, dropped=40, buffering=False))
        self.assertIn('aber_ingestion_gateway_outages_total{buffering="off",edge_node="%s"} 1.0' % NODE, samples())
        self.assertEqual(ingestion.gateway_outage_gauge_snapshot()[NODE]["aber_ingestion_gateway_outage_last_buffering"], 0)

    def test_an_unusable_report_is_refused_not_guessed(self):
        end = now_ms() - 1000
        for metrics in (
            self.report(end, end - 60_000),                       # ends before it starts
            self.report(end - 60_000, end + 3_600_000),           # ends in the future
            self.report(end - 60_000, end, dropped=-1),           # a negative count
            [self.number(ingestion.OUTAGE_READINGS_DROPPED, 3)],  # no window at all
        ):
            self.node(metrics)
        self.assertEqual(ingestion.gateway_outage_gauge_snapshot(), {})
        self.assertIn("aber_ingestion_gateway_outage_reports_rejected_total 4.0", samples())

    def test_a_birth_declaring_the_report_null_is_neither_counted_nor_refused(self):
        declared = []
        for name, datatype in ((ingestion.OUTAGE_STARTED_AT, 13), (ingestion.OUTAGE_ENDED_AT, 13),
                               (ingestion.OUTAGE_READINGS_BUFFERED, 10),
                               (ingestion.OUTAGE_READINGS_DROPPED, 10), (ingestion.OUTAGE_BUFFERING, 11)):
            m = sparkplug_b_pb2.Payload.Metric()
            m.name, m.datatype, m.is_null = name, datatype, True
            declared.append(m)
        def rejected():
            return [line for line in samples()
                    if line.startswith("aber_ingestion_gateway_outage_reports_rejected_total ")]
        before = rejected()
        self.node(declared, msg_type="NBIRTH")
        self.assertEqual(ingestion.gateway_outage_gauge_snapshot(), {})
        self.assertEqual(rejected(), before)

    def test_an_unregistered_edge_node_adds_no_series(self):
        self.gateway = None
        end = now_ms() - 1000
        self.node(self.report(end - 60_000, end, dropped=5))
        self.assertEqual(ingestion.gateway_outage_gauge_snapshot(), {})


class ReplayedNodeMessageTest(NodeMessageTestCase):
    def test_a_replayed_node_message_measures_no_clock_and_overrides_no_status(self):
        status = sparkplug_b_pb2.Payload.Metric()
        status.name, status.datatype, status.string_value, status.is_historical = "Gateway_Status", 12, "MAINTENANCE", True
        uptime = self.number("Uptime_s", 50)
        uptime.is_historical = True
        p = sparkplug_b_pb2.Payload()
        p.timestamp = now_ms() - DAY_MS
        p.metrics.add().CopyFrom(status)
        p.metrics.add().CopyFrom(uptime)
        ingestion.process_node_message(NODE, "NDATA", p, group_id=GROUP)
        self.assertEqual(ingestion.gateway_clock_gauge_snapshot(), {})
        call = self.supabase.rpc.call_args[0][1]
        self.assertEqual((call["p_status"], call["p_health"]), ("ONLINE", None))


if __name__ == "__main__":
    unittest.main()
