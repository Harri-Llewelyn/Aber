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
_stub("psycopg2.extras", execute_values=lambda *a, **k: None)
_stub("sparkplug_b_pb2", Payload=object)
_stub("paho")
_stub("paho.mqtt")
_stub("paho.mqtt.client", Client=object)

import ingestion  # noqa: E402  (must follow the stubs above)

GROUP = "Aber"
NODE = "gwy120000000000400080000"
DEVICE = "dev220000000000400080000"


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
# A LITERAL EXPIRES. `_timestamp_is_sane()` rejects a metric more than 24 hours old, so a hardcoded
# base stops every telemetry write in TestSparseDdataIngestion on a fixed date, and the suite then
# fails on a file nobody has touched.
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
    ingestion._alias_datatypes.clear()
    ingestion._name_datatypes.clear()
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
            "name": "Sim_CNC_Mill_01",
            "sparkplug_id": DEVICE,
            "is_quarantined": False,
        }
        self._real = {
            "resolve_device": ingestion.resolve_device,
            "verify_gateway_binding": ingestion.verify_gateway_binding,
            "get_timescaledb_connection": ingestion.get_timescaledb_connection,
        }
        ingestion.resolve_device = lambda wire_id, use_cache=True, include_archived=False: self.device
        ingestion.verify_gateway_binding = lambda *a, **k: None

        self.cursor = MagicMock()
        self.cursor.__enter__ = MagicMock(return_value=self.cursor)
        self.cursor.__exit__ = MagicMock(return_value=False)
        conn = MagicMock()
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=False)
        conn.cursor = MagicMock(return_value=self.cursor)
        ingestion.get_timescaledb_connection = lambda: conn

        # Telemetry is written with ONE batched execute_values() per message rather than an
        # execute() per metric. `ingestion` imported the name directly, so it is bound in that
        # module's namespace and this is where it has to be replaced.
        self._real["execute_values"] = ingestion.execute_values
        self.execute_values = MagicMock()
        ingestion.execute_values = self.execute_values

    def tearDown(self):
        for name, fn in self._real.items():
            setattr(ingestion, name, fn)
        reset_module_state()

    def telemetry_writes(self):
        """
        The (metric_name, val_double, val_string, val_bool) of every telemetry row written.

        Harvested from the batched execute_values() call rather than from execute(). The assertions
        in this class are unchanged by that -- they are about WHICH ROWS the daemon chose to write,
        which is the property under test; the statement count is not.
        """
        rows = []
        for call in self.execute_values.call_args_list:
            sql = call[0][1]
            if "INSERT INTO telemetry" not in sql:
                continue
            for params in call[0][2]:
                rows.append((params[2], params[3], params[4], params[5]))
        return rows

    def telemetry_statements(self):
        """The SQL of each batched telemetry INSERT issued."""
        return [c[0][1] for c in self.execute_values.call_args_list
                if "INSERT INTO telemetry" in c[0][1]]

    def ingest(self, payload):
        ingestion.process_ddata(DEVICE, NODE, payload, group_id=GROUP, client=MagicMock())
        # The writer thread is never started by the suites; drain the queue here.
        ingestion._writer.flush()

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
            self.execute_values.reset_mock()
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
        # ONE statement now carries both rows -- that is the batching change, and it is why this
        # asserts on the row count separately from the statement count. The conflict clause is the
        # property under test and it is unchanged.
        statements = self.telemetry_statements()
        self.assertEqual(len(statements), 1)
        self.assertEqual(len(self.telemetry_writes()), 2)
        for sql in statements:
            self.assertIn("ON CONFLICT (time, asset_id, metric_name) DO NOTHING", sql)
            self.assertNotIn("DO UPDATE", sql)

    def test_identity_metrics_are_never_historised(self):
        """
        Asset_ID and Asset_Name are identity, not telemetry. The RBE simulator no longer sends
        them in DDATA at all, but a third-party gateway may, and they must not become series.
        """
        self.ingest(DataPayload([
            DataMetric("Asset_ID", string=DEVICE),
            DataMetric("Asset_Name", string="Sim_CNC_Mill_01"),
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


INT8, INT16, INT32, INT64, UINT8, UINT16, UINT32, UINT64 = 1, 2, 3, 4, 5, 6, 7, 8

# (datatype, value) at each signed type's minimum, -1 and maximum, and each unsigned type's maximum.
SIGNED_CASES = [
    (INT8, -128), (INT8, -1), (INT8, 127),
    (INT16, -32768), (INT16, -1), (INT16, 32767),
    (INT32, -2 ** 31), (INT32, -1), (INT32, 2 ** 31 - 1),
    (INT64, -2 ** 63), (INT64, -1), (INT64, 2 ** 63 - 1),
]
UNSIGNED_CASES = [(UINT8, 255), (UINT16, 65535), (UINT32, 2 ** 32 - 1), (UINT64, 2 ** 64 - 1)]


class IntMetric:
    """
    An integer metric as the protobuf wire carries it: `int_value` is a uint32 and `long_value` a
    uint64, so a signed value arrives as its two's-complement pattern. Refuses a negative, as
    protobuf does, so a test cannot pass by handing the daemon the answer.
    """

    def __init__(self, name="", alias=None, datatype=None, int_value=None, long_value=None):
        assert int_value is None or 0 <= int_value < 2 ** 32
        assert long_value is None or 0 <= long_value < 2 ** 64
        self.name = name
        self.alias = alias if alias is not None else 0
        self.datatype = datatype or 0
        self.int_value = int_value or 0
        self.long_value = long_value or 0
        self.timestamp = 0
        self._present = {field for field, value in (
            ("alias", alias), ("datatype", datatype),
            ("int_value", int_value), ("long_value", long_value),
        ) if value is not None}

    def HasField(self, field):
        return field in self._present


def on_the_wire(datatype, value):
    """The field and pattern Eclipse Tahu's Java encoder sends: Int8-32 sign-extended into the uint32."""
    if datatype in (INT64, UINT64):
        return {"long_value": value & (2 ** 64 - 1)}
    return {"int_value": value & (2 ** 32 - 1)}


class TestSignedIntegerDdata(unittest.TestCase):
    """
    A signed Sparkplug integer is written as the number the device sent, not its unsigned pattern.

    DDATA may carry only an alias, or only a name, and no datatype: the datatype comes from the
    birth. Borrows the cursor-level fake above rather than inheriting it, so its tests run once.
    """

    tearDown = TestSparseDdataIngestion.tearDown
    telemetry_writes = TestSparseDdataIngestion.telemetry_writes

    def setUp(self):
        TestSparseDdataIngestion.setUp(self)
        self._real["supabase_client"] = ingestion.supabase_client
        ingestion.supabase_client = None  # process_dbirth() registers the birth, then returns

    def birth(self, *metrics, device=DEVICE):
        ingestion.process_dbirth(device, NODE, DataPayload(list(metrics)), group_id=GROUP)

    def written(self, device=DEVICE, *metrics):
        self.execute_values.reset_mock()
        ingestion.process_ddata(device, NODE, DataPayload(list(metrics)), group_id=GROUP,
                                client=MagicMock())
        ingestion._writer.flush()
        return {name: value for name, value, _s, _b in self.telemetry_writes()}

    def cases(self):
        """Each case under its own name and alias, declared in one DBIRTH."""
        return [("m%d" % i, 100 + i, datatype, value)
                for i, (datatype, value) in enumerate(SIGNED_CASES + UNSIGNED_CASES)]

    def test_an_aliased_ddata_reads_each_width_at_its_limits(self):
        cases = self.cases()
        self.birth(*[IntMetric(name, alias=alias, datatype=datatype, **on_the_wire(datatype, 0))
                     for name, alias, datatype, _ in cases])
        written = self.written(DEVICE, *[IntMetric(alias=alias, **on_the_wire(datatype, value))
                                         for _, alias, datatype, value in cases])
        for name, _, datatype, value in cases:
            with self.subTest(datatype=datatype, value=value):
                self.assertEqual(written[name], float(value))

    def test_a_named_ddata_reads_each_width_at_its_limits(self):
        cases = self.cases()
        self.birth(*[IntMetric(name, datatype=datatype, **on_the_wire(datatype, 0))
                     for name, _, datatype, _ in cases])
        written = self.written(DEVICE, *[IntMetric(name, **on_the_wire(datatype, value))
                                         for name, _, datatype, value in cases])
        for name, _, datatype, value in cases:
            with self.subTest(datatype=datatype, value=value):
                self.assertEqual(written[name], float(value))

    def test_an_unsigned_maximum_stays_positive(self):
        self.birth(IntMetric("count", alias=1, datatype=UINT32, int_value=0))
        written = self.written(DEVICE, IntMetric(alias=1, int_value=2 ** 32 - 1))
        self.assertEqual(written["count"], 4294967295.0)

    def test_a_narrow_type_sent_at_its_own_width_reads_the_same(self):
        # Tahu's Python encoder sends an Int8 of -5 as 0xFB rather than 0xFFFFFFFB.
        self.birth(IntMetric("offset", datatype=INT8, int_value=0))
        self.assertEqual(self.written(DEVICE, IntMetric("offset", int_value=0xFB))["offset"], -5.0)

    def test_a_datatype_on_the_ddata_itself_is_used(self):
        written = self.written(DEVICE, IntMetric("offset", datatype=INT32, int_value=2 ** 32 - 5))
        self.assertEqual(written["offset"], -5.0)

    def test_the_datatype_is_per_device_not_per_node(self):
        other = "dev330000000000400080000"
        self.birth(IntMetric("offset", datatype=INT32, int_value=0))
        self.birth(IntMetric("offset", datatype=UINT32, int_value=0), device=other)
        self.assertEqual(self.written(DEVICE, IntMetric("offset", int_value=2 ** 32 - 1))["offset"], -1.0)
        self.assertEqual(self.written(other, IntMetric("offset", int_value=2 ** 32 - 1))["offset"],
                         4294967295.0)

    def test_an_nbirth_forgets_the_datatypes_it_does_not_redeclare(self):
        self.birth(IntMetric("offset", alias=1, datatype=INT32, int_value=0))
        ingestion.register_birth_aliases(GROUP, NODE, DataPayload([IntMetric("offset", alias=1)]),
                                         reset=True)
        self.assertEqual(self.written(DEVICE, IntMetric(alias=1, int_value=2 ** 32 - 1))["offset"],
                         4294967295.0)

    def test_an_undeclared_datatype_is_stored_unsigned_and_counted(self):
        # No birth seen: the conservative reading is the one made before datatypes were read.
        before = ingestion.counter_snapshot().get("metrics_integer_datatype_unknown", 0)
        written = self.written(DEVICE, IntMetric("offset", int_value=2 ** 32 - 5))
        self.assertEqual(written["offset"], 4294967291.0)
        self.assertEqual(
            ingestion.counter_snapshot().get("metrics_integer_datatype_unknown", 0), before + 1)

    def test_birth_parameters_are_read_signed(self):
        ingestion.supabase_client = MagicMock()
        ingestion.store_birth_parameters(DEVICE, DataPayload([
            IntMetric("offset", datatype=INT16, int_value=2 ** 32 - 300),
            IntMetric("drift", datatype=INT64, long_value=2 ** 64 - 7),
        ]))
        rows = ingestion.supabase_client.rpc.call_args[0][1]["p_rows"]
        self.assertEqual({r["metric_name"]: r["val_double"] for r in rows},
                         {"offset": -300.0, "drift": -7.0})

    def test_a_gateway_health_integer_is_read_signed(self):
        # A negative free-space figure is refused; read unsigned it was recorded as 18 EB.
        ingestion.register_birth_aliases(GROUP, NODE, DataPayload([
            IntMetric("Disk_Free_Bytes", alias=9, datatype=INT64, long_value=0)]), reset=True)
        health = ingestion.extract_gateway_health(
            GROUP, NODE, DataPayload([IntMetric(alias=9, long_value=2 ** 64 - 1)]))
        self.assertNotIn("disk_free_bytes", health)


if __name__ == "__main__":
    unittest.main(verbosity=2)
