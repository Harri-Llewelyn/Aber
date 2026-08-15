"""
Unit tests for report-by-exception telemetry handling in ingestion.py.

RBE means a device publishes a metric ONLY when it changes. Two properties follow from that, and
this suite pins both because neither is visible from a passing end-to-end run:

  1. A SPARSE DDATA IS COMPLETE. A payload carrying one metric is not a payload that lost five --
     it is a device saying one thing moved. The daemon must write exactly what arrived and must
     not synthesise rows for the metrics that stayed put, because a historian row asserts that an
     observation was taken.

  2. A MISSING MESSAGE IS UNRECOVERABLE WITHOUT THE SEQUENCE NUMBER. When telemetry was published
     on a timer, a dropped message cost one sample and the next tick restated everything. Under
     RBE the message IS the change: lose the DDATA that said INTERRUPTED and every consumer holds
     ACTIVE forever, confidently. `seq` is the only evidence that it happened, which is why
     check_message_sequence() exists and why it asks for a rebirth rather than merely logging.

The heavy imports at the top of ingestion.py are stubbed before it loads, the same arrangement
test_declared_metrics.py uses and for the same reason: none of protobuf, MQTT or psycopg2 is
reachable from the logic under test.
"""
import os
import sys
import time
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
_stub("sparkplug_b_pb2", Payload=object)
_stub("paho")
_stub("paho.mqtt")
_stub("paho.mqtt.client", Client=object)

import ingestion  # noqa: E402  (must follow the stubs above)

GROUP = "ACS-Cymru"
NODE = "gwy100000000000400080000"
DEVICE = "dev200000000000400080000"


class SeqPayload:
    """A payload as check_message_sequence() sees it: a `seq`, present or absent."""

    def __init__(self, seq=None):
        self.metrics = []
        if seq is not None:
            self.seq = seq
        self._has_seq = seq is not None

    def HasField(self, field):
        return field == "seq" and self._has_seq


class DataMetric:
    """
    A DDATA metric with a name and exactly one value field set, plus protobuf's HasField.

    The value fields are checked in the daemon's own order (int, long, float, double, boolean,
    string), so a metric must report `False` for every field it does not carry -- a fake that
    answered True for all of them would make the first branch win every time and the test would
    pass while asserting nothing.
    """

    def __init__(self, name, double=None, string=None, boolean=None, timestamp=None):
        self.name = name
        self.alias = 0
        self.double_value = double if double is not None else 0.0
        self.string_value = string if string is not None else ""
        self.boolean_value = boolean if boolean is not None else False
        self.timestamp = timestamp or 0
        self._present = set()
        if double is not None:
            self._present.add("double_value")
        if string is not None:
            self._present.add("string_value")
        if boolean is not None:
            self._present.add("boolean_value")
        if timestamp:
            self._present.add("timestamp")

    def HasField(self, field):
        return field in self._present


# FIXED AT IMPORT, NOT HARDCODED, and the difference is a test that expired.
#
# This default used to be the literal 1786284000000 -- 2026-08-09T14:00:00Z. `_timestamp_is_sane()`
# rejects a metric more than 24 hours old, so every telemetry write in TestSparseDdataIngestion
# silently stopped being issued at 2026-08-10T14:00:00Z and five tests began failing on a file
# nobody had touched. The last green run on main beat that deadline by 41 minutes.
#
# Computed ONCE per process rather than per payload, because these tests also assert on the
# hypertable's (time, asset_id, metric_name) collision behaviour -- two payloads have to be able to
# share a timestamp for that to mean anything.
FIXTURE_TIMESTAMP_MS = int(time.time() * 1000)


class DataPayload:
    def __init__(self, metrics, timestamp=None):
        self.metrics = metrics
        self.timestamp = FIXTURE_TIMESTAMP_MS if timestamp is None else timestamp


class FakeMetricList(list):
    def add(self):
        metric = types.SimpleNamespace(name="", datatype=0, boolean_value=False)
        self.append(metric)
        return metric


class FakeProtoPayload:
    """
    Just enough of the generated protobuf class for build_rebirth_payload().

    The module-level `sparkplug_b_pb2` stub is a bare `object`, shared with four other suites, so
    the sequence tests swap this in for their own duration rather than enriching it -- the same
    arrangement test_declared_metrics.py's rebirth suite uses.
    """

    def __init__(self):
        self.timestamp = 0
        self.metrics = FakeMetricList()

    def SerializeToString(self):
        parts = ["ts=%d" % self.timestamp]
        parts += ["%s|%s|%s" % (m.name, m.datatype, m.boolean_value) for m in self.metrics]
        return ";".join(parts).encode()


def reset_module_state():
    """Clear the process-wide caches, so ordering cannot decide a result."""
    ingestion._alias_map.clear()
    ingestion._rebirth_requested.clear()
    ingestion._device_seen.clear()
    ingestion._last_seq.clear()


class TestSequenceTracking(unittest.TestCase):
    """check_message_sequence(): follow the counter, and speak up when it jumps."""

    def setUp(self):
        reset_module_state()
        self._real_pb2 = ingestion.sparkplug_b_pb2
        ingestion.sparkplug_b_pb2 = types.SimpleNamespace(Payload=FakeProtoPayload)
        self.client = MagicMock()

    def tearDown(self):
        ingestion.sparkplug_b_pb2 = self._real_pb2

    def check(self, msg_type, seq):
        return ingestion.check_message_sequence(
            GROUP, NODE, msg_type, SeqPayload(seq), client=self.client
        )

    def test_consecutive_messages_are_in_sequence(self):
        self.check("NBIRTH", 0)
        for seq in range(1, 6):
            self.assertTrue(self.check("DDATA", seq), "seq %d should be in sequence" % seq)
        self.client.publish.assert_not_called()

    def test_first_message_after_startup_is_adopted_not_reported(self):
        """
        The daemon restarts far more often than a gateway does, and it comes up mid-run. Treating
        the first message as a gap would fire a rebirth at every node on every deploy.
        """
        self.assertTrue(self.check("DDATA", 137))
        self.client.publish.assert_not_called()

    def test_nbirth_restarts_the_run_at_zero(self):
        """Per the specification an NBIRTH is seq 0 and voids whatever came before it."""
        self.check("DDATA", 90)
        self.assertTrue(self.check("NBIRTH", 0))
        self.assertTrue(self.check("DDATA", 1))
        self.client.publish.assert_not_called()

    def test_a_gap_is_reported_and_requests_a_rebirth(self):
        self.check("NBIRTH", 0)
        self.check("DDATA", 1)
        # 2 never arrived.
        self.assertFalse(self.check("DDATA", 3))
        self.client.publish.assert_called_once()
        topic = self.client.publish.call_args[0][0]
        self.assertEqual(topic, "spBv1.0/%s/NCMD/%s" % (GROUP, NODE))

    def test_the_counter_resyncs_after_a_gap(self):
        """
        Staying latched to the expectation that was missed would turn one lost message into a
        permanent alarm on every message after it.
        """
        self.check("NBIRTH", 0)
        self.check("DDATA", 1)
        self.assertFalse(self.check("DDATA", 5))
        self.assertTrue(self.check("DDATA", 6))
        self.assertTrue(self.check("DDATA", 7))

    def test_wrapping_past_255_is_in_sequence(self):
        """
        seq is a single byte and 255 is followed by 0, not by 256. Read as a plain integer the
        wrap looks like a 255-message gap and would fire a rebirth once every 256 messages
        forever. The baseline is adopted at 254 rather than walked up from an NBIRTH so the test
        says what it is about.
        """
        self.check("DDATA", 254)
        self.assertTrue(self.check("DDATA", 255))
        self.assertTrue(self.check("DDATA", 0))
        self.assertTrue(self.check("DDATA", 1))
        self.client.publish.assert_not_called()

    def test_a_redelivered_message_is_not_a_gap(self):
        """
        A repeated seq is the broker redelivering, not the device losing anything -- and the
        historian's ON CONFLICT DO NOTHING has already absorbed the duplicate row.
        """
        self.check("NBIRTH", 0)
        self.check("DDATA", 1)
        self.assertTrue(self.check("DDATA", 1))
        self.client.publish.assert_not_called()

    def test_ndeath_is_exempt(self):
        """
        NDEATH is the broker's registered Last Will, published when the node is already gone. It
        carries bdSeq rather than a live seq and is not part of the counter's run.
        """
        self.check("NBIRTH", 0)
        self.check("DDATA", 1)
        self.assertTrue(ingestion.check_message_sequence(
            GROUP, NODE, "NDEATH", SeqPayload(0), client=self.client))
        self.assertTrue(self.check("DDATA", 2))
        self.client.publish.assert_not_called()

    def test_a_payload_without_seq_is_not_judged(self):
        """A publisher that omits seq cannot be checked; it must not be accused either."""
        self.check("NBIRTH", 0)
        self.assertTrue(ingestion.check_message_sequence(
            GROUP, NODE, "DDATA", SeqPayload(None), client=self.client))
        self.client.publish.assert_not_called()

    def test_each_edge_node_has_its_own_counter(self):
        """
        The counter is per edge node and shared by its devices. Two gateways interleaving their
        traffic must not look like one gateway skipping.
        """
        other = "gwy900000000000400080000"
        ingestion.check_message_sequence(GROUP, NODE, "NBIRTH", SeqPayload(0), client=self.client)
        ingestion.check_message_sequence(GROUP, other, "NBIRTH", SeqPayload(0), client=self.client)
        for seq in range(1, 4):
            self.assertTrue(ingestion.check_message_sequence(
                GROUP, NODE, "DDATA", SeqPayload(seq), client=self.client))
            self.assertTrue(ingestion.check_message_sequence(
                GROUP, other, "DDATA", SeqPayload(seq), client=self.client))
        self.client.publish.assert_not_called()

    def test_a_gap_without_a_broker_client_still_reports(self):
        """The rebirth cannot be sent, but the gap is still a fact and must return False."""
        ingestion.check_message_sequence(GROUP, NODE, "NBIRTH", SeqPayload(0), client=None)
        self.assertFalse(
            ingestion.check_message_sequence(GROUP, NODE, "DDATA", SeqPayload(9), client=None))


class TestSparseDdataIngestion(unittest.TestCase):
    """
    process_ddata(): write what arrived, and nothing else.

    The database is faked at the cursor, so what is asserted is the SQL the daemon chose to issue
    -- which is the property under test. A real hypertable would prove the same thing more slowly
    and would not run in CI without a container.
    """

    def setUp(self):
        reset_module_state()
        self.device = {
            "id": "20000000-0000-4000-8000-000000000002",
            "name": "Simulated_CNC_01",
            "sparkplug_id": DEVICE,
            "is_quarantined": False,
        }
        self._real = {
            "resolve_device": ingestion.resolve_device,
            "verify_gateway_binding": ingestion.verify_gateway_binding,
            "get_timescaledb_connection": ingestion.get_timescaledb_connection,
        }
        ingestion.resolve_device = lambda wire_id, use_cache=True: self.device
        ingestion.verify_gateway_binding = lambda *a, **k: None

        self.cursor = MagicMock()
        self.cursor.__enter__ = MagicMock(return_value=self.cursor)
        self.cursor.__exit__ = MagicMock(return_value=False)
        conn = MagicMock()
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=False)
        conn.cursor = MagicMock(return_value=self.cursor)
        ingestion.get_timescaledb_connection = lambda: conn

    def tearDown(self):
        for name, fn in self._real.items():
            setattr(ingestion, name, fn)
        reset_module_state()

    def telemetry_writes(self):
        """The (metric_name, val_double, val_string, val_bool) of each telemetry INSERT issued."""
        rows = []
        for call in self.cursor.execute.call_args_list:
            sql = call[0][0]
            if "INSERT INTO telemetry" not in sql:
                continue
            params = call[0][1]
            rows.append((params[2], params[3], params[4], params[5]))
        return rows

    def ingest(self, payload):
        ingestion.process_ddata(DEVICE, NODE, payload, group_id=GROUP, client=MagicMock())

    def test_a_single_metric_payload_writes_exactly_one_row(self):
        """
        THE CENTRAL RBE PROPERTY. A device reporting only that its temperature moved must produce
        one row. Filling in the other metrics at their last known values would fabricate
        observations, and every one of them would be indistinguishable from a real reading.
        """
        self.ingest(DataPayload([DataMetric("Systems/TEMPERATURE", double=47.5)]))
        self.assertEqual(self.telemetry_writes(), [("Systems/TEMPERATURE", 47.5, None, None)])

    def test_unreported_metrics_produce_no_rows_at_all(self):
        rows = []
        for value in (42.0, 43.0, 44.0):
            self.cursor.reset_mock()
            self.ingest(DataPayload([DataMetric("Systems/TEMPERATURE", double=value)]))
            rows.extend(self.telemetry_writes())
        self.assertEqual([name for name, *_ in rows], ["Systems/TEMPERATURE"] * 3)

    def test_every_insert_is_conflict_tolerant(self):
        """
        A REDELIVERED MESSAGE MUST NOT MULTIPLY ROWS. The primary key is
        (time, asset_id, metric_name), so an identical value at an identical timestamp collides --
        and the write must be `ON CONFLICT DO NOTHING`, never an upsert, because the historian is
        an append-only record of what was observed rather than something a publisher may rewrite.
        """
        self.ingest(DataPayload([
            DataMetric("Systems/TEMPERATURE", double=42.0),
            DataMetric("Controller/EXECUTION", string="ACTIVE"),
        ]))
        inserts = [c[0][0] for c in self.cursor.execute.call_args_list
                   if "INSERT INTO telemetry" in c[0][0]]
        self.assertEqual(len(inserts), 2)
        for sql in inserts:
            self.assertIn("ON CONFLICT (time, asset_id, metric_name) DO NOTHING", sql)
            self.assertNotIn("DO UPDATE", sql)

    def test_identity_metrics_are_never_historised(self):
        """
        Asset_ID and Asset_Name are identity, not telemetry. The RBE simulator no longer sends
        them in DDATA at all, but a third-party gateway may, and they must not become series.
        """
        self.ingest(DataPayload([
            DataMetric("Asset_ID", string=DEVICE),
            DataMetric("Asset_Name", string="Simulated_CNC_01"),
            DataMetric("Systems/TEMPERATURE", double=42.0),
        ]))
        self.assertEqual([name for name, *_ in self.telemetry_writes()], ["Systems/TEMPERATURE"])

    def test_a_payload_carrying_no_metrics_writes_no_telemetry(self):
        """
        An empty DDATA is what an over-eager RBE filter emits. It is not an error, and it must not
        become a row -- but the asset upsert still runs, which is why this asserts on the
        telemetry writes rather than on the call count.
        """
        self.ingest(DataPayload([]))
        self.assertEqual(self.telemetry_writes(), [])

    def test_state_metrics_keep_their_own_columns(self):
        """A string state and a boolean must not be coerced into val_double."""
        self.ingest(DataPayload([
            DataMetric("Controller/EXECUTION", string="INTERRUPTED"),
            DataMetric("safety_interlock", boolean=False),
            DataMetric("Systems/TEMPERATURE", double=95.0),
        ]))
        self.assertEqual(sorted(self.telemetry_writes()), sorted([
            ("Controller/EXECUTION", None, "INTERRUPTED", None),
            ("safety_interlock", None, None, False),
            ("Systems/TEMPERATURE", 95.0, None, None),
        ]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
