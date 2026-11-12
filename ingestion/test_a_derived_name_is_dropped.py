"""
Unit tests for a reading published under a derived metric's name (a metric Aber computes).

    python ingestion/test_a_derived_name_is_dropped.py

A derived metric is a `metric_catalog` row with a definition, and nothing publishes it: Aber computes
it from other metrics at read time. A device that publishes the name would put a second source under
the computed series, so ingestion drops that reading and files a finding. The rule is held here from
four sides:

  * THE DROP HOLDS UNDER EITHER POLICY. `audit` keeps every other violating reading, and this is not
    one of those: with no schema, an open schema and an enforcing device alike, the reading is not
    written, its measured siblings in the same group and the same message are, and a finding with
    the code `derived_name` is recorded for it.
  * THE NAMES COME FROM THE CATALOGUE, through the UNS bridge's TTL cache. One read serves a TTL; an
    addition takes effect when it ends; a read that fails answers the names last read and does not
    cost a read per message; and before any read has succeeded nothing is dropped.
  * A BIRTH IS NOT A READING, BUT IT CARRIES A VALUE. The device's Config view keeps the values a
    birth declares, so a derived name's value is left out of them and the finding is filed once.
  * THE COUNT IS ITS OWN SERIES, beside the schema counter that only an enforcing device raises, so
    neither number is blurred by the other.

No broker and no database: the daemon's imports are stubbed as the sibling suites do, and a fake
PostgREST client answers the catalogue.
"""
import json
import os
import sys
import unittest
from unittest import mock

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

# Loaded first: it stubs the daemon's imports before ingestion.py is imported, and supplies the
# payload builders and the base class that wires a fake historian connection.
import test_telemetry_batching as batching  # noqa: E402
from test_telemetry_batching import BatchingTestCase, Metric, Payload  # noqa: E402

import conformance  # noqa: E402
import ingestion  # noqa: E402
import metrics  # noqa: E402
import uns_publish  # noqa: E402

DERIVED = "Controller/PARTS_PER_HOUR"
MEASURED = "Controller/PART_COUNT"
DEFINITION = {"kind": "counter_rate", "input": MEASURED}


class Result:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    """`.select(...).not_.is_("derivation", "null")`, and nothing else."""

    def __init__(self, supabase, table):
        self.supabase = supabase
        self.table = table
        self._negated = False
        self._filters = []

    def select(self, columns, *_args, **_kwargs):
        self.supabase.selects.append(columns)
        return self

    @property
    def not_(self):
        self._negated = True
        return self

    def is_(self, column, value):
        self._filters.append((self._negated, column, value))
        self._negated = False
        return self

    def execute(self):
        rows = self.supabase.tables.get(self.table, [])
        for negated, column, value in self._filters:
            assert value == "null", value
            rows = [r for r in rows if (r.get(column) is None) != negated]
        return Result([{"name": r["name"]} for r in rows])


class FakeSupabase:
    def __init__(self, derived=(DERIVED,)):
        measured = [{"name": MEASURED, "derivation": None},
                    {"name": "Controller/EXECUTION", "derivation": None}]
        self.tables = {"metric_catalog": measured + [{"name": n, "derivation": DEFINITION} for n in derived]}
        self.reads = 0
        self.selects = []
        self.rpcs = []
        self.failing = False

    def derive(self, name):
        """A derived metric added on the Metrics page."""
        self.tables["metric_catalog"].append({"name": name, "derivation": DEFINITION})

    def table(self, name):
        self.reads += 1
        if self.failing:
            raise RuntimeError("catalogue unavailable")
        return FakeQuery(self, name)

    def rpc(self, name, args):
        self.rpcs.append((name, args))
        return mock.MagicMock()

    def rejections(self):
        """Every violation filed through record_ingestion_rejection(), in order."""
        return [v for args in self.rejection_calls() for v in args["p_violations"]]

    def rejection_calls(self):
        return [args for name, args in self.rpcs if name == "record_ingestion_rejection"]


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class DerivedNameTestCase(BatchingTestCase):
    """A device on a stack whose catalogue holds one derived metric."""

    def setUp(self):
        super().setUp()
        uns_publish.reset_cache()
        ingestion._last_violation_signature.clear()
        ingestion._derived_name_warned.clear()
        self.supabase = FakeSupabase()
        self._real_client = ingestion.supabase_client
        self._real_constraints = ingestion.device_modelled_constraints
        ingestion.supabase_client = self.supabase
        # No schema is bound unless a test says so.
        self.schema = None
        ingestion.device_modelled_constraints = lambda uuid: self.schema

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        ingestion.device_modelled_constraints = self._real_constraints
        uns_publish.reset_cache()
        super().tearDown()

    def names(self):
        """The metric name of every row that reached the historian."""
        return [r[2] for r in self.rows()]

    def counters(self):
        return ingestion.counter_snapshot()

    def enforce(self):
        self.device["conformance_policy"] = "enforce"


class TheDropHoldsUnderEitherPolicy(DerivedNameTestCase):
    def test_under_audit_the_reading_is_not_written_and_its_siblings_are(self):
        self.ingest(Payload([Metric(DERIVED, double=12.0), Metric(MEASURED, double=40.0)]))
        self.assertEqual(self.names(), [MEASURED])

    def test_under_enforce_the_reading_is_not_written_and_its_siblings_are(self):
        self.enforce()
        self.schema = ingestion.ModelledSchema({MEASURED: ingestion.MetricConstraint()}, closed=False)
        self.ingest(Payload([Metric(DERIVED, double=12.0), Metric(MEASURED, double=40.0)]))
        self.assertEqual(self.names(), [MEASURED])

    def test_a_schema_that_models_the_name_does_not_save_it(self):
        # The schema builders do not offer a derived name, but a schema written by hand can model
        # one; the catalogue is what decides.
        self.enforce()
        self.schema = ingestion.ModelledSchema(
            {DERIVED: ingestion.MetricConstraint(types=frozenset({"number"}))}, closed=True)
        self.ingest(Payload([Metric(DERIVED, double=12.0)]))
        self.assertEqual(self.names(), [])

    def test_a_message_of_nothing_else_writes_no_telemetry_and_still_files_the_finding(self):
        self.ingest(Payload([Metric(DERIVED, double=12.0)]))
        self.assertEqual(self.rows(), [])
        self.assertEqual([v["code"] for v in self.supabase.rejections()], ["derived_name"])

    def test_every_value_kind_is_dropped_by_its_name(self):
        self.ingest(Payload([Metric(DERIVED, string="ACTIVE"), Metric(DERIVED, boolean=True),
                             Metric(MEASURED, double=1.0)]))
        self.assertEqual(self.names(), [MEASURED])

    def test_the_name_is_compared_exactly(self):
        for near in (DERIVED.lower(), DERIVED + "/EXTRA", "Other/PARTS_PER_HOUR", DERIVED.split("/")[0]):
            with self.subTest(name=near):
                self.ingest(Payload([Metric(near, double=1.0)]))
                self.assertIn(near, self.names())

    def test_a_measured_name_of_the_same_group_is_untouched(self):
        self.ingest(Payload([Metric(MEASURED, double=40.0), Metric("Controller/EXECUTION", string="ACTIVE")]))
        self.assertEqual(sorted(self.names()), sorted([MEASURED, "Controller/EXECUTION"]))
        self.assertEqual(self.supabase.rejections(), [])
        self.assertEqual(self.counters()["metrics_dropped_derived_name"], 0)

    def test_the_rest_of_the_message_is_handled_as_before(self):
        # The reading is judged before its timestamp, so the sanity window is charged to the
        # sibling alone.
        old = batching.NOW_MS - ingestion.TELEMETRY_MAX_AGE_SECONDS * 1000 * 2
        self.ingest(Payload([Metric(DERIVED, double=1.0, timestamp=old),
                             Metric(MEASURED, double=2.0, timestamp=old)]))
        self.assertEqual(self.names(), [])
        self.assertEqual(self.counters()["metrics_rejected_timestamp"], 1)
        self.assertEqual(self.counters()["metrics_dropped_derived_name"], 1)


class TheFindingAndTheCount(DerivedNameTestCase):
    def test_a_finding_with_its_own_code_is_filed_as_dropped(self):
        self.ingest(Payload([Metric(DERIVED, double=12.0)]))
        self.assertEqual(self.supabase.rejections(), [{
            "metric": DERIVED, "code": "derived_name",
            "detail": conformance.DERIVED_NAME_DETAIL, "dropped": True,
        }])

    def test_the_words_say_whose_name_it_is_and_what_to_do(self):
        detail = conformance.DERIVED_NAME_DETAIL
        self.assertIn("Aber computes", detail)
        self.assertIn("another name", detail)

    def test_the_finding_is_the_same_under_every_policy(self):
        self.ingest(Payload([Metric(DERIVED, double=12.0)]))
        audit = self.supabase.rejections()
        self.supabase.rpcs.clear()
        ingestion._last_violation_signature.clear()
        self.enforce()
        self.ingest(Payload([Metric(DERIVED, double=13.0)]))
        self.assertEqual(self.supabase.rejections(), audit)

    def test_a_device_publishing_it_on_every_message_files_one_row(self):
        for value in (1.0, 2.0, 3.0):
            self.ingest(Payload([Metric(DERIVED, double=value)]))
        self.assertEqual(len(self.supabase.rejection_calls()), 1)

    def test_it_is_counted_in_its_own_series_and_not_the_schema_counter(self):
        self.ingest(Payload([Metric(DERIVED, double=12.0), Metric(MEASURED, double=1.0)]))
        self.assertEqual(self.counters()["metrics_dropped_derived_name"], 1)
        self.assertEqual(self.counters()["metrics_rejected_schema"], 0)

    def test_an_enforcing_device_raises_the_schema_counter_as_it_did(self):
        self.enforce()
        self.schema = ingestion.ModelledSchema({
            "Systems/TEMPERATURE": ingestion.MetricConstraint(types=frozenset({"number"}), maximum=100.0),
        }, closed=False)
        self.ingest(Payload([Metric("Systems/TEMPERATURE", double=999.0), Metric(DERIVED, double=1.0)]))
        self.assertEqual(self.counters()["metrics_rejected_schema"], 1)
        self.assertEqual(self.counters()["metrics_dropped_derived_name"], 1)

    def test_the_series_is_exported_with_its_help(self):
        series, labels = metrics.COUNTER_MAP["metrics_dropped_derived_name"]
        self.assertEqual((series, labels), ("aber_ingestion_derived_name_dropped_total", {}))
        self.assertIn(series, metrics.HELP)
        self.assertEqual(metrics.COUNTER_MAP["metrics_rejected_schema"][0], "aber_ingestion_schema_rejected_total")

    def test_the_log_says_it_once_in_a_while_and_names_the_device(self):
        with self.assertLogs("ingestion", level="WARNING") as captured:
            for value in (1.0, 2.0):
                self.ingest(Payload([Metric(DERIVED, double=value)]))
        lines = [line for line in captured.output if "derived metric" in line]
        self.assertEqual(len(lines), 1)
        self.assertIn(DERIVED, lines[0])
        self.assertIn(batching.DEVICE, lines[0])

    def test_the_auditing_switch_stops_the_row_and_not_the_drop(self):
        real = ingestion.AUDIT_PAYLOAD_REJECTIONS
        ingestion.AUDIT_PAYLOAD_REJECTIONS = False
        try:
            self.ingest(Payload([Metric(DERIVED, double=12.0), Metric(MEASURED, double=1.0)]))
        finally:
            ingestion.AUDIT_PAYLOAD_REJECTIONS = real
        self.assertEqual(self.names(), [MEASURED])
        self.assertEqual(self.supabase.rejections(), [])
        self.assertEqual(self.counters()["metrics_dropped_derived_name"], 1)


class TheNamesComeFromTheCatalogue(DerivedNameTestCase):
    def setUp(self):
        super().setUp()
        self.clock = Clock()
        patch = mock.patch.object(uns_publish.time, "time", self.clock)
        patch.start()
        self.addCleanup(patch.stop)

    def test_it_reads_the_derived_rows_only(self):
        self.ingest(Payload([Metric(MEASURED, double=1.0)]))
        self.assertEqual(self.supabase.selects, ["name"])
        self.assertEqual(ingestion.derived_metric_names(), frozenset({DERIVED}))

    def test_one_read_serves_every_message_inside_the_freshness(self):
        for value in range(5):
            self.ingest(Payload([Metric(MEASURED, double=float(value))]))
        self.assertEqual(self.supabase.reads, 1)

    def test_a_name_added_later_is_dropped_once_the_freshness_ends(self):
        self.ingest(Payload([Metric("Power/TOTAL", double=1.0)]))
        self.supabase.derive("Power/TOTAL")

        self.clock.now += uns_publish.UNS_CONTEXT_TTL_SECONDS - 1
        self.ingest(Payload([Metric("Power/TOTAL", double=2.0)]))
        self.assertEqual(self.names().count("Power/TOTAL"), 2)

        self.clock.now += 1
        self.ingest(Payload([Metric("Power/TOTAL", double=3.0)]))
        self.assertEqual(self.names().count("Power/TOTAL"), 2)

    def test_it_shares_the_units_cache_and_its_freshness(self):
        self.ingest(Payload([Metric(MEASURED, double=1.0)]))
        uns_publish.units_of(self.supabase)
        self.assertEqual(sorted(uns_publish._context._data), [("derived",), ("units",)])
        self.assertEqual(uns_publish._context.ttl, uns_publish.UNS_CONTEXT_TTL_SECONDS)

    def test_a_failed_read_keeps_the_names_last_read(self):
        self.ingest(Payload([Metric(MEASURED, double=1.0)]))
        self.supabase.failing = True
        self.clock.now += uns_publish.UNS_CONTEXT_TTL_SECONDS
        self.ingest(Payload([Metric(DERIVED, double=2.0), Metric(MEASURED, double=3.0)]))
        self.assertEqual(self.names(), [MEASURED, MEASURED])

    def test_a_failed_read_is_held_for_the_freshness_and_costs_no_read_per_message(self):
        self.ingest(Payload([Metric(MEASURED, double=1.0)]))
        self.supabase.failing = True
        self.clock.now += uns_publish.UNS_CONTEXT_TTL_SECONDS
        before = self.supabase.reads
        for value in range(5):
            self.ingest(Payload([Metric(MEASURED, double=float(value))]))
        self.assertEqual(self.supabase.reads - before, 1)

    def test_a_failed_read_says_so_and_is_tried_again_after_the_freshness(self):
        self.supabase.failing = True
        with self.assertLogs("ingestion", level="WARNING") as captured:
            self.ingest(Payload([Metric(DERIVED, double=1.0)]))
        self.assertTrue(any("Could not read the derived metrics" in line for line in captured.output))
        self.supabase.failing = False
        self.clock.now += uns_publish.UNS_CONTEXT_TTL_SECONDS
        self.ingest(Payload([Metric(DERIVED, double=2.0)]))
        self.assertEqual(self.names(), [DERIVED])

    def test_before_any_read_has_succeeded_nothing_is_dropped(self):
        self.supabase.failing = True
        self.ingest(Payload([Metric(DERIVED, double=1.0), Metric(MEASURED, double=2.0)]))
        self.assertEqual(sorted(self.names()), sorted([DERIVED, MEASURED]))
        self.assertEqual(self.supabase.rejections(), [])

    def test_with_no_database_client_nothing_is_dropped(self):
        ingestion.supabase_client = None
        self.ingest(Payload([Metric(DERIVED, double=1.0)]))
        self.assertEqual(self.names(), [DERIVED])
        self.assertEqual(self.supabase.reads, 0)


class ABirthDeclaringTheNameKeepsNoValueForIt(DerivedNameTestCase):
    def setUp(self):
        super().setUp()
        self.device["sparkplug_id"] = batching.DEVICE
        # store_birth_parameters() stores through a gate; the rows it sends are what is read back.
        self.parameters = []

        def rpc(name, args):
            self.supabase.rpcs.append((name, args))
            if name == "ingest_store_birth_parameters":
                self.parameters.extend(args["p_rows"])
            return mock.MagicMock()
        self.supabase.rpc = rpc

    def birth(self, *metrics):
        payload = Payload(list(metrics))
        ingestion.store_birth_parameters(batching.DEVICE, payload)
        ingestion.record_derived_birth_names(self.device, payload)

    def test_the_value_is_left_out_of_the_device_s_parameters(self):
        self.birth(Metric(DERIVED, double=0.0), Metric(MEASURED, double=40.0))
        self.assertEqual([row["metric_name"] for row in self.parameters], [MEASURED])

    def test_a_finding_is_filed_for_it_as_for_a_reading(self):
        self.birth(Metric(DERIVED, double=0.0), Metric(MEASURED, double=40.0))
        self.assertEqual(self.supabase.rejections(), [{
            "metric": DERIVED, "code": "derived_name",
            "detail": conformance.DERIVED_NAME_DETAIL, "dropped": True,
        }])
        self.assertEqual(self.counters()["metrics_dropped_derived_name"], 1)

    def test_a_birth_with_no_derived_name_files_nothing(self):
        self.birth(Metric(MEASURED, double=40.0))
        self.assertEqual(self.supabase.rejections(), [])
        self.assertEqual([row["metric_name"] for row in self.parameters], [MEASURED])

    def test_a_rebirth_files_the_same_finding_once_however_the_readings_run_between(self):
        self.birth(Metric(DERIVED, double=0.0))
        self.ingest(Payload([Metric(MEASURED, double=1.0)]))
        self.birth(Metric(DERIVED, double=0.0))
        self.assertEqual(len(self.supabase.rejection_calls()), 1)

    def test_the_birth_s_finding_is_filed_again_once_a_clean_birth_has_cleared_it(self):
        self.birth(Metric(DERIVED, double=0.0))
        self.birth(Metric(MEASURED, double=40.0))
        self.birth(Metric(DERIVED, double=0.0))
        self.assertEqual(len(self.supabase.rejection_calls()), 2)

    def test_process_dbirth_files_it(self):
        patched = {}
        for name, replacement in (
            ("resolve_device", lambda wire_id, use_cache=True, include_archived=False: self.device),
            ("verify_gateway_binding", lambda device, gw, group=None: None),
            ("record_declared_metrics", lambda device, payload: None),
            ("mark_device_seen", lambda *a, **k: None),
            ("register_birth_aliases", lambda *a, **k: 0),
        ):
            patched[name] = getattr(ingestion, name)
            setattr(ingestion, name, replacement)
        self.device.update({"status": "ONLINE", "identity_source": ingestion.SOURCE_SPARKPLUG_ID,
                            "_identity_source": ingestion.SOURCE_SPARKPLUG_ID,
                            "first_dbirth_at": "2026-08-01T09:00:00+00:00"})
        try:
            ingestion.process_dbirth(batching.DEVICE, batching.NODE,
                                     Payload([Metric(DERIVED, double=0.0), Metric(MEASURED, double=40.0)]),
                                     None, group_id=batching.GROUP)
        finally:
            for name, original in patched.items():
                setattr(ingestion, name, original)
        self.assertEqual([row["metric_name"] for row in self.parameters], [MEASURED])
        self.assertEqual([v["code"] for v in self.supabase.rejections()], ["derived_name"])


class TheConformanceModuleStaysPure(unittest.TestCase):
    def test_the_entry_is_a_dropped_metric(self):
        self.assertEqual(conformance.derived_name_drop(DERIVED),
                         (DERIVED, "derived_name", conformance.DERIVED_NAME_DETAIL))
        found = conformance.payload_violations([], [conformance.derived_name_drop(DERIVED)], None)
        self.assertEqual(found, [{
            "metric": DERIVED, "code": "derived_name",
            "detail": conformance.DERIVED_NAME_DETAIL, "dropped": True,
        }])

    def test_it_is_never_a_schema_fault_to_enforce(self):
        found = conformance.payload_violations([], [conformance.derived_name_drop(DERIVED)], None)[0]
        self.assertFalse(conformance.enforceable_violation(found, closed=True))

    def test_the_contract_fixture_holds_the_words_the_dashboard_copy_is_held_to(self):
        fixture = os.path.join(os.path.dirname(INGESTION_DIR), "test-harness", "fixtures",
                               "payload-conformance.json")
        with open(fixture, "r", encoding="utf-8") as handle:
            cases = json.load(handle)["cases"]
        details = {entry[2] for case in cases for entry in case.get("dropped", [])
                   if entry[1] == conformance.DERIVED_NAME_CODE}
        self.assertEqual(details, {conformance.DERIVED_NAME_DETAIL})

    def test_a_schema_alone_never_produces_the_code(self):
        modelled = conformance.modelled_constraints([{"properties": {DERIVED: {"type": "number"}}}])
        found = conformance.payload_violations([(DERIVED, "double", 1.0)], [], modelled)
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
