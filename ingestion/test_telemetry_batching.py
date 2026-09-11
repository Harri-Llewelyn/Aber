"""
Unit tests for the batched telemetry write in process_ddata().

WHAT CHANGED AND WHAT DID NOT. The metric loop's decisions -- alias resolution, the identity-metric
filter, the timestamp sanity window, the value-column mapping -- are untouched. Only the write is:
one `execute_values` per message instead of one `execute` per metric, issued by the historian
writer (test_telemetry_writer.py covers the writer itself; here it is flushed synchronously).

WHAT THIS SUITE IS GUARDING AGAINST. The row tuple is positional, six columns wide, and three of
its columns are mutually-exclusive nullable value slots. A transposition -- val_string into
val_bool, say -- would not raise, because every one of those columns is nullable. It would write
NULLs, silently, on the hottest path in the system. So the tuples are asserted element by element
rather than by count.

FAILURE GRANULARITY IS DELIBERATELY UNCHANGED. The write runs inside `with db_conn:`, a
transaction block that rolls back wholesale on any exception, so a bad row aborts the whole
message. Batching changes the number of round trips, not the atomicity -- see
test_a_lone_message_is_written_in_a_transaction.

Same stubbing approach as the sibling suites: the daemon's heavy imports are replaced before
ingestion.py is loaded.
"""
import os
import sys
import time
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

import ingestion  # noqa: E402
import registry  # noqa: E402

GROUP = "ACS-Cymru"
NODE = "gwy" + "1" * 21
DEVICE = "dev" + "2" * 21

# Fixed at import rather than hardcoded: the sanity window is relative to now, so a literal
# timestamp would silently start failing once it aged past TELEMETRY_MAX_AGE_SECONDS.
NOW_MS = int(time.time() * 1000)


class Metric:
    """
    A Sparkplug metric. Only the fields actually set are reported present by HasField, which is
    what makes the daemon's elif-chain over value types meaningful -- a mock answering True for
    everything would make the first branch win and the test would assert nothing.
    """

    def __init__(self, name, double=None, string=None, boolean=None, integer=None,
                 timestamp=None):
        self.name = name
        self.alias = 0
        self.double_value = double if double is not None else 0.0
        self.string_value = string if string is not None else ""
        self.boolean_value = boolean if boolean is not None else False
        self.int_value = integer if integer is not None else 0
        self.timestamp = timestamp if timestamp is not None else 0
        self._present = set()
        if double is not None:
            self._present.add("double_value")
        if string is not None:
            self._present.add("string_value")
        if boolean is not None:
            self._present.add("boolean_value")
        if integer is not None:
            self._present.add("int_value")
        if timestamp:
            self._present.add("timestamp")

    def HasField(self, field):
        return field in self._present


class Payload:
    def __init__(self, metrics, timestamp=None):
        self.metrics = metrics
        self.timestamp = NOW_MS if timestamp is None else timestamp


class BatchingTestCase(unittest.TestCase):

    def setUp(self):
        ingestion._alias_map.clear()
        ingestion._device_seen.clear()
        ingestion._last_seq.clear()
        registry._counters.clear()

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
            "execute_values": ingestion.execute_values,
        }
        ingestion.resolve_device = lambda wire_id, use_cache=True: self.device
        ingestion.verify_gateway_binding = lambda *a, **k: None

        self.cursor = MagicMock()
        self.cursor.__enter__ = MagicMock(return_value=self.cursor)
        self.cursor.__exit__ = MagicMock(return_value=False)
        self.conn = MagicMock()
        self.conn.__enter__ = MagicMock(return_value=self.conn)
        self.conn.__exit__ = MagicMock(return_value=False)
        self.conn.cursor = MagicMock(return_value=self.cursor)
        ingestion.get_timescaledb_connection = lambda: self.conn

        # `from psycopg2.extras import execute_values` binds the name into ingestion's namespace,
        # so that is where it must be replaced.
        self.execute_values = MagicMock()
        ingestion.execute_values = self.execute_values

    def tearDown(self):
        for name, fn in self._real.items():
            setattr(ingestion, name, fn)

    def ingest(self, payload):
        ingestion.process_ddata(DEVICE, NODE, payload, group_id=GROUP, client=MagicMock())
        # The callback thread decides; the writer thread writes. The suites never start that
        # thread, so the queue is drained here, on this one.
        ingestion._writer.flush()

    def batch_calls(self):
        return [c for c in self.execute_values.call_args_list
                if "INSERT INTO telemetry" in c[0][1]]

    def rows(self):
        """Every row tuple handed to execute_values, in order."""
        out = []
        for call in self.batch_calls():
            out.extend(call[0][2])
        return out


class TestOneStatementPerMessage(BatchingTestCase):

    def test_a_forty_metric_payload_issues_one_statement(self):
        """The headline change: 40 round trips become one."""
        self.ingest(Payload([Metric(f"Bench/M{i:02d}", double=float(i)) for i in range(40)]))

        self.assertEqual(len(self.batch_calls()), 1)
        self.assertEqual(len(self.rows()), 40)

    def test_no_per_metric_execute_is_issued(self):
        """
        The regression that would make the batching pointless: leaving the old execute() in place
        alongside the new batch would double every write and still pass a row-count assertion.
        """
        self.ingest(Payload([Metric(f"Bench/M{i:02d}", double=float(i)) for i in range(10)]))

        telemetry_executes = [
            c for c in self.cursor.execute.call_args_list
            if "INSERT INTO telemetry" in c[0][0]
        ]
        self.assertEqual(telemetry_executes, [])

    def test_a_single_metric_payload_still_issues_one_statement(self):
        """The common case under report-by-exception: one metric, one statement, no regression."""
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=47.5)]))
        self.assertEqual(len(self.batch_calls()), 1)
        self.assertEqual(len(self.rows()), 1)

    def test_page_size_is_set_explicitly(self):
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=47.5)]))
        self.assertEqual(
            self.batch_calls()[0][1]["page_size"], ingestion.TELEMETRY_INSERT_PAGE_SIZE
        )

    def test_page_size_default_is_500(self):
        self.assertEqual(ingestion.TELEMETRY_INSERT_PAGE_SIZE, 500)


class TestStatementShape(BatchingTestCase):

    def test_conflict_clause_is_preserved(self):
        """
        DO NOTHING, never DO UPDATE. An upsert would let any publisher rewrite history at a
        timestamp of its choosing -- the historian records what was observed.
        """
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=42.0)]))
        sql = self.batch_calls()[0][0][1]
        self.assertIn("ON CONFLICT (time, asset_id, metric_name) DO NOTHING", sql)
        self.assertNotIn("DO UPDATE", sql)

    def test_column_order_matches_the_tuple(self):
        """
        The column list and the tuple are two halves of one contract, and nothing in the database
        would catch them disagreeing -- every value column is nullable.
        """
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=42.0)]))
        sql = self.batch_calls()[0][0][1]
        self.assertIn(
            "INSERT INTO telemetry (time, asset_id, metric_name, val_double, val_string, val_bool)",
            sql,
        )

    def test_values_placeholder_is_present(self):
        """execute_values requires a bare `VALUES %s` to expand; `VALUES (%s, ...)` is a silent
        no-op that inserts a single literal row."""
        sql = None
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=42.0)]))
        sql = self.batch_calls()[0][0][1]
        self.assertIn("VALUES %s", sql)


class TestRowTuples(BatchingTestCase):
    """
    Element-by-element, because every value column is nullable and a transposition would write
    NULLs rather than raise.
    """

    def test_a_double_lands_in_val_double(self):
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=47.5)]))
        time_, asset_id, metric_name, val_double, val_string, val_bool = self.rows()[0]

        self.assertIsInstance(time_, datetime)
        self.assertEqual(asset_id, DEVICE)
        self.assertEqual(metric_name, "Systems/TEMPERATURE")
        self.assertEqual(val_double, 47.5)
        self.assertIsNone(val_string)
        self.assertIsNone(val_bool)

    def test_a_string_lands_in_val_string(self):
        self.ingest(Payload([Metric("Controller/EXECUTION", string="INTERRUPTED")]))
        _, _, metric_name, val_double, val_string, val_bool = self.rows()[0]

        self.assertEqual(metric_name, "Controller/EXECUTION")
        self.assertIsNone(val_double)
        self.assertEqual(val_string, "INTERRUPTED")
        self.assertIsNone(val_bool)

    def test_a_boolean_lands_in_val_bool(self):
        """False specifically -- a truthiness test rather than a HasField test drops this row."""
        self.ingest(Payload([Metric("safety_interlock", boolean=False)]))
        _, _, metric_name, val_double, val_string, val_bool = self.rows()[0]

        self.assertEqual(metric_name, "safety_interlock")
        self.assertIsNone(val_double)
        self.assertIsNone(val_string)
        self.assertIs(val_bool, False)

    def test_an_integer_is_widened_into_val_double(self):
        self.ingest(Payload([Metric("Parts/COUNT", integer=17)]))
        _, _, _, val_double, val_string, val_bool = self.rows()[0]

        self.assertEqual(val_double, 17.0)
        self.assertIsInstance(val_double, float)
        self.assertIsNone(val_string)
        self.assertIsNone(val_bool)

    def test_mixed_types_in_one_batch_keep_their_own_columns(self):
        """The case batching could plausibly break: three types in one statement."""
        self.ingest(Payload([
            Metric("Controller/EXECUTION", string="ACTIVE"),
            Metric("safety_interlock", boolean=True),
            Metric("Systems/TEMPERATURE", double=95.0),
        ]))

        by_name = {r[2]: r for r in self.rows()}
        self.assertEqual(len(by_name), 3)
        self.assertEqual(by_name["Controller/EXECUTION"][3:], (None, "ACTIVE", None))
        self.assertEqual(by_name["safety_interlock"][3:], (None, None, True))
        self.assertEqual(by_name["Systems/TEMPERATURE"][3:], (95.0, None, None))

    def test_row_order_follows_payload_order(self):
        self.ingest(Payload([
            Metric("A/ONE", double=1.0),
            Metric("B/TWO", double=2.0),
            Metric("C/THREE", double=3.0),
        ]))
        self.assertEqual([r[2] for r in self.rows()], ["A/ONE", "B/TWO", "C/THREE"])

    def test_a_per_metric_timestamp_is_used_over_the_payload_timestamp(self):
        metric_ms = NOW_MS - 30_000
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=42.0, timestamp=metric_ms)]))

        written = self.rows()[0][0]
        self.assertEqual(
            written, datetime.fromtimestamp(metric_ms / 1000.0, timezone.utc)
        )


class TestEmptyAndFilteredBatches(BatchingTestCase):
    """
    execute_values on an empty list emits `VALUES` with nothing after it -- a syntax error. Every
    way a message can end up with no rows is therefore its own test, because each reaches the
    guard by a different path.
    """

    def test_a_payload_with_no_metrics_issues_no_statement(self):
        self.ingest(Payload([]))
        self.assertEqual(self.batch_calls(), [])

    def test_a_payload_of_only_identity_metrics_issues_no_statement(self):
        self.ingest(Payload([
            Metric("Asset_ID", string=DEVICE),
            Metric("Asset_Name", string="Sim_CNC_Mill_01"),
        ]))
        self.assertEqual(self.batch_calls(), [])

    def test_a_payload_of_only_rejected_timestamps_issues_no_statement(self):
        stale = NOW_MS - ((ingestion.TELEMETRY_MAX_AGE_SECONDS + 3600) * 1000)
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=42.0, timestamp=stale)]))
        self.assertEqual(self.batch_calls(), [])

    def test_a_payload_of_only_valueless_metrics_issues_no_statement(self):
        """A metric with no value field set at all is skipped by the elif-chain's else."""
        self.ingest(Payload([Metric("Systems/TEMPERATURE")]))
        self.assertEqual(self.batch_calls(), [])

    def upsert_calls(self):
        return [c for c in self.execute_values.call_args_list
                if "INSERT INTO assets" in c[0][1]]

    def test_the_asset_upsert_still_runs_for_an_empty_payload(self):
        """
        The upsert is a separate statement BEFORE the batch and satisfies the telemetry table's
        foreign key. It must not have been folded into the guarded branch.
        """
        self.ingest(Payload([]))
        self.assertEqual(len(self.upsert_calls()), 1)
        self.assertEqual(self.upsert_calls()[0][0][2], [(DEVICE, "Sim_CNC_Mill_01")])

    def test_the_asset_upsert_precedes_the_batch(self):
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=42.0)]))
        self.assertEqual(len(self.batch_calls()), 1)
        self.assertIn("INSERT INTO assets", self.execute_values.call_args_list[0][0][1])


class TestFilteringStillApplies(BatchingTestCase):
    """The loop's decisions are unchanged; these assert the batch inherited them."""

    def test_identity_metrics_are_excluded_from_the_batch(self):
        self.ingest(Payload([
            Metric("Asset_ID", string=DEVICE),
            Metric("Asset_Name", string="Sim_CNC_Mill_01"),
            Metric("Systems/TEMPERATURE", double=42.0),
        ]))
        self.assertEqual([r[2] for r in self.rows()], ["Systems/TEMPERATURE"])

    def test_a_stale_metric_is_excluded_but_its_siblings_are_written(self):
        stale = NOW_MS - ((ingestion.TELEMETRY_MAX_AGE_SECONDS + 3600) * 1000)
        self.ingest(Payload([
            Metric("Systems/TEMPERATURE", double=42.0, timestamp=stale),
            Metric("Axes/X/POSITION", double=1.5),
        ]))
        self.assertEqual([r[2] for r in self.rows()], ["Axes/X/POSITION"])

    def test_a_future_metric_is_excluded(self):
        future = NOW_MS + ((ingestion.TELEMETRY_MAX_FUTURE_SECONDS + 600) * 1000)
        self.ingest(Payload([
            Metric("Systems/TEMPERATURE", double=42.0, timestamp=future),
            Metric("Axes/X/POSITION", double=1.5),
        ]))
        self.assertEqual([r[2] for r in self.rows()], ["Axes/X/POSITION"])

    def test_a_rejected_timestamp_increments_its_counter(self):
        stale = NOW_MS - ((ingestion.TELEMETRY_MAX_AGE_SECONDS + 3600) * 1000)
        self.ingest(Payload([
            Metric("Systems/TEMPERATURE", double=42.0, timestamp=stale),
            Metric("Axes/X/POSITION", double=1.5),
        ]))
        snapshot = ingestion.counter_snapshot()
        self.assertEqual(snapshot.get("metrics_rejected_timestamp"), 1)
        self.assertEqual(snapshot.get("metrics_written"), 1)

    def test_metrics_written_counter_matches_the_batch_size(self):
        self.ingest(Payload([Metric(f"Bench/M{i:02d}", double=float(i)) for i in range(25)]))
        self.assertEqual(ingestion.counter_snapshot().get("metrics_written"), 25)
        self.assertEqual(len(self.rows()), 25)


class TestTransactionSemantics(BatchingTestCase):

    def test_a_lone_message_is_written_in_a_transaction(self):
        """
        `with db_conn:` is what makes the batch atomic. This asserts the transaction block is
        entered, since dropping it would convert a rolled-back message into a partially-committed
        one without any test noticing. Several messages in one transaction: test_telemetry_writer.py.
        """
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=42.0)]))
        self.conn.__enter__.assert_called()

    def test_a_failing_batch_is_counted_and_does_not_propagate(self):
        """
        A write failure must not kill the writer thread -- the next message has to be processed.
        The counter is what makes the loss visible.
        """
        self.execute_values.side_effect = RuntimeError("connection reset")
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=42.0)]))
        self.assertEqual(ingestion.counter_snapshot().get("write_failures"), 1)

    def test_an_unavailable_database_is_counted_and_skips_the_write(self):
        ingestion.get_timescaledb_connection = lambda: None
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=42.0)]))

        self.assertEqual(self.batch_calls(), [])
        self.assertEqual(ingestion.counter_snapshot().get("dropped_db_unavailable"), 1)

# =================================================================================================
# Schema enforcement (archived migration 0050)
#
# The half that can DESTROY DATA, so these drive the whole of process_ddata and assert on what
# reached execute_values -- not on the validator, which is unit-tested next door. A metric that is
# dropped here was never written and cannot be recovered from anywhere.
# =================================================================================================
class SchemaEnforcementTestCase(BatchingTestCase):

    def setUp(self):
        super().setUp()
        self._real_constraints = ingestion.device_modelled_constraints
        # A bound schema: TEMPERATURE is a number between 0 and 100, MODE is one of two strings.
        self.schema = ingestion.ModelledSchema({
            "Systems/TEMPERATURE": ingestion.MetricConstraint(
                types=frozenset({"number"}), minimum=0.0, maximum=100.0),
            "Controller/MODE": ingestion.MetricConstraint(
                types=frozenset({"string"}), enum=frozenset({"AUTO", "MANUAL"})),
        }, closed=False)
        ingestion.device_modelled_constraints = lambda uuid: self.schema

    def tearDown(self):
        ingestion.device_modelled_constraints = self._real_constraints
        super().tearDown()

    def enforce(self):
        self.device["conformance_policy"] = "enforce"

    def names(self):
        """The metric name of every row that reached the historian."""
        return [r[2] for r in self.rows()]

    # -- the default, which must not have changed ---------------------------------------------
    def test_audit_is_the_default_and_writes_a_violating_metric_anyway(self):
        """
        THE PROPERTY THE WHOLE FEATURE IS BUILT AROUND NOT BREAKING. Everything shipped before
        item 7 behaves this way, and a device that nobody opted in must keep behaving this way.
        """
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=999.0)]))
        self.assertEqual(self.names(), ["Systems/TEMPERATURE"])
        self.assertIsNone(ingestion.counter_snapshot().get("metrics_rejected_schema"))

    def test_a_device_with_no_policy_field_at_all_is_not_enforced(self):
        """A row cached before 0050 added the column. Absent must read as 'audit', not as enforce."""
        self.device.pop("conformance_policy", None)
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=999.0)]))
        self.assertEqual(self.names(), ["Systems/TEMPERATURE"])

    # -- enforcement --------------------------------------------------------------------------
    def test_an_out_of_range_value_is_dropped_and_its_siblings_are_written(self):
        """
        The offending metric only. Mirrors how an out-of-window timestamp is already handled:
        dropping the message would discard readings that conform perfectly well.
        """
        self.enforce()
        self.ingest(Payload([
            Metric("Systems/TEMPERATURE", double=999.0),
            Metric("Controller/MODE", string="AUTO"),
        ]))
        self.assertEqual(self.names(), ["Controller/MODE"])
        self.assertEqual(ingestion.counter_snapshot().get("metrics_rejected_schema"), 1)

    def test_a_conforming_value_is_written_under_enforcement(self):
        self.enforce()
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=50.0)]))
        self.assertEqual(self.names(), ["Systems/TEMPERATURE"])
        self.assertIsNone(ingestion.counter_snapshot().get("metrics_rejected_schema"))

    def test_a_boundary_value_is_written(self):
        """`minimum` is inclusive. The setpoint a machine sits at is the value it reports most."""
        self.enforce()
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=0.0)]))
        self.assertEqual(self.names(), ["Systems/TEMPERATURE"])

    def test_an_enum_violation_is_dropped(self):
        self.enforce()
        self.ingest(Payload([Metric("Controller/MODE", string="MELTING")]))
        self.assertEqual(self.names(), [])
        self.assertEqual(ingestion.counter_snapshot().get("metrics_rejected_schema"), 1)

    def test_a_type_violation_is_dropped(self):
        self.enforce()
        self.ingest(Payload([Metric("Systems/TEMPERATURE", string="hot")]))
        self.assertEqual(self.names(), [])

    # -- what enforcement must NOT drop --------------------------------------------------------
    def test_an_unmodelled_metric_survives_an_open_schema(self):
        """
        JSON Schema permits unnamed properties by default, so silence is permission. Dropping on
        silence would delete every reading from a device that gained a sensor before anyone
        updated its schema -- which is the ordinary way a fleet changes.
        """
        self.enforce()
        self.ingest(Payload([Metric("Newly/Added", double=1.0)]))
        self.assertEqual(self.names(), ["Newly/Added"])
        self.assertIsNone(ingestion.counter_snapshot().get("metrics_rejected_schema"))

    def test_an_unmodelled_metric_is_dropped_once_the_schema_closes_the_set(self):
        self.enforce()
        self.schema = ingestion.ModelledSchema(self.schema.metrics, closed=True)
        self.ingest(Payload([Metric("Newly/Added", double=1.0)]))
        self.assertEqual(self.names(), [])
        self.assertEqual(ingestion.counter_snapshot().get("metrics_rejected_schema"), 1)

    def test_an_unreadable_schema_enforces_nothing(self):
        """
        device_modelled_constraints() returns None both when nothing is bound and when the
        directory blinked. Neither is grounds for discarding a reading -- the second especially,
        since it would make our own outage look like the device's fault.
        """
        self.enforce()
        ingestion.device_modelled_constraints = lambda uuid: None
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=999.0)]))
        self.assertEqual(self.names(), ["Systems/TEMPERATURE"])

    def test_an_invalid_stored_pattern_never_drops(self):
        """The fault is the schema author's. A bad regex must not silence a healthy machine."""
        self.enforce()
        self.schema = ingestion.ModelledSchema({
            "Batch/ID": ingestion.MetricConstraint(
                types=frozenset({"string"}), pattern="([unclosed"),
        }, closed=True)
        self.ingest(Payload([Metric("Batch/ID", string="B1234")]))
        self.assertEqual(self.names(), ["Batch/ID"])
        self.assertIsNone(ingestion.counter_snapshot().get("metrics_rejected_schema"))

    def test_a_dropped_metric_is_still_reported_as_a_violation(self):
        """
        Enforcement must not cost the audit trail. The metric is gone from the historian, so the
        digital_thread row is the ONLY remaining evidence that the device sent anything at all.
        """
        self.enforce()
        recorded = []
        real = ingestion.record_payload_violations
        ingestion.record_payload_violations = lambda d, v, t: recorded.extend(v)
        try:
            self.ingest(Payload([Metric("Systems/TEMPERATURE", double=999.0)]))
        finally:
            ingestion.record_payload_violations = real

        self.assertEqual(len(recorded), 1)
        self.assertEqual(recorded[0]["metric"], "Systems/TEMPERATURE")
        self.assertEqual(recorded[0]["code"], "above_maximum")
        self.assertTrue(recorded[0]["dropped"])



if __name__ == "__main__":
    unittest.main(verbosity=2)
