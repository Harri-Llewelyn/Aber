"""
Unit tests for payload conformance auditing -- the SCHEMA_REJECTION half of the audit trail.

WHAT THIS PROTECTS, IN ORDER OF HOW BADLY IT FAILS.

  1. THE DEDUPLICATION. `record_payload_violations()` writes to `public.audit_trail`, which is
     append-only to every application role and cannot be pruned by the application at all. DDATA
     arrives continuously, so a regression that writes one row per message does not degrade -- it
     fills the disk, and the first symptom is the database refusing writes. archived migration 0005 made
     this argument about heartbeat UPDATEs and gave the trigger a guard; these rows go through an
     RPC that the trigger never sees, so the ONLY guard is the one in Python and it is tested here.

  2. THAT NOTHING IS DROPPED FOR NON-CONFORMANCE. `payload_violations()` is a reporter, not a
     gate. A change that made it start refusing telemetry would destroy the evidence of the fault
     it is reporting, on the strength of a schema that may itself be what is wrong. There is a test
     below whose entire job is to fail if that happens.

  3. THE `None` / EMPTY-MAP DISTINCTION. A device with NO schema attached must produce no schema
     violations; a device with a schema that models NOTHING must produce one per metric. Both are
     `falsy` in Python and the difference is invisible at a glance, which is exactly why it is
     asserted rather than trusted.

Follows the stubbing approach of test_audit_write_dedup.py and test_declared_metrics.py: the
daemon's heavy imports are replaced before ingestion.py is loaded, since none of them are reachable
from the code under test.
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
import registry  # noqa: E402


OBSERVED_AT = datetime(2026, 8, 21, 9, 30, tzinfo=timezone.utc)


def device(**overrides):
    row = {"id": "device-uuid", "name": "Sim_CNC_Mill_01"}
    row.update(overrides)
    return row


def schema_of(metrics, closed=False):
    """
    A ModelledSchema from a terse `{name: types-or-None}` map.

    Most of these tests care only about `type`, which is all the reader understood before enum,
    bounds and pattern were added. Passing a MetricConstraint explicitly is supported for the ones
    that exercise a deeper facet, so the terse form stays readable without hiding the real shape.
    """
    return ingestion.ModelledSchema(
        {
            name: value if isinstance(value, ingestion.MetricConstraint)
            else ingestion.MetricConstraint(types=value)
            for name, value in metrics.items()
        },
        closed,
    )


VALUE_FOR_KIND = {"double": 1.0, "string": "x", "bool": True}


# =================================================================================================
# modelled_constraints() -- reading a JSON Schema into the map the check runs against
# =================================================================================================
class ModelledConstraintsTestCase(unittest.TestCase):

    def test_properties_contribute_their_declared_type(self):
        result = ingestion.modelled_constraints([{
            "properties": {
                "Systems/TEMPERATURE": {"type": "number"},
                "Controller/EXECUTION": {"type": "string"},
            }
        }]).metrics
        self.assertEqual(result["Systems/TEMPERATURE"].types, frozenset({"number"}))
        self.assertEqual(result["Controller/EXECUTION"].types, frozenset({"string"}))

    def test_a_required_metric_absent_from_properties_is_declared_without_a_constraint(self):
        """
        `required` names a metric; it says nothing about its type. None means "no constraint",
        which must not be confused with "constrained to nothing".
        """
        result = ingestion.modelled_constraints([{"required": ["safety_interlock"]}]).metrics
        self.assertIn("safety_interlock", result)
        self.assertIsNone(result["safety_interlock"].types)

    def test_a_property_without_a_type_is_declared_without_a_constraint(self):
        result = ingestion.modelled_constraints(
            [{"properties": {"Anything": {"description": "x"}}}]).metrics
        self.assertIsNone(result["Anything"].types)

    def test_a_type_list_admits_every_member(self):
        result = ingestion.modelled_constraints([{
            "properties": {"Mixed": {"type": ["number", "string"]}}
        }]).metrics
        self.assertEqual(result["Mixed"].types, frozenset({"number", "string"}))

    def test_the_union_across_submodels_widens_rather_than_narrows(self):
        """
        Mirrors modelled_metrics_across() in validate.py. A device may carry several submodels and
        a metric modelled by ANY of them is modelled -- a per-schema check would flag a device for
        publishing what another of its own submodels accounts for.
        """
        result = ingestion.modelled_constraints([
            {"properties": {"Shared": {"type": "number"}}},
            {"properties": {"Shared": {"type": "string"}, "OnlyHere": {"type": "boolean"}}},
        ]).metrics
        self.assertEqual(result["Shared"].types, frozenset({"number", "string"}))
        self.assertEqual(result["OnlyHere"].types, frozenset({"boolean"}))

    def test_required_does_not_erase_a_type_declared_beside_it(self):
        """
        The mirror of the test below, and the pair is the point. WITHIN one schema a metric that is
        both `required` and typed in `properties` keeps its type -- the `required` entry adds no
        type information, so treating it as "unconstrained" would silently disable the type check
        for every required metric in the plant, which is most of the interesting ones.
        """
        result = ingestion.modelled_constraints([{
            "required": ["Systems/TEMPERATURE"],
            "properties": {"Systems/TEMPERATURE": {"type": "number"}},
        }]).metrics
        self.assertEqual(result["Systems/TEMPERATURE"].types, frozenset({"number"}))

    def test_an_unconstrained_declaration_wins_over_a_constrained_one(self):
        """
        The union is what the device is PERMITTED to send, so the widest permission is the answer.
        Order must not matter, which is why both directions are asserted.
        """
        constrained = {"properties": {"M": {"type": "number"}}}
        unconstrained = {"required": ["M"]}

        self.assertIsNone(
            ingestion.modelled_constraints([constrained, unconstrained]).metrics["M"].types)
        self.assertIsNone(
            ingestion.modelled_constraints([unconstrained, constrained]).metrics["M"].types)

    def test_malformed_definitions_are_skipped_rather_than_raising(self):
        """
        `schemas.schema_definition` is operator-supplied JSONB with no server-side shape check. A
        malformed one must not take the ingestion callback thread down.
        """
        result = ingestion.modelled_constraints(
            [None, "not-an-object", 42, {"properties": "nope"}])
        self.assertEqual(result.metrics, {})
        self.assertFalse(result.closed)


# =================================================================================================
# payload_violations() -- the verdict
# =================================================================================================
class PayloadViolationsTestCase(unittest.TestCase):

    def test_a_conforming_payload_produces_nothing(self):
        violations = ingestion.payload_violations(
            observed=[("Systems/TEMPERATURE", "double", 1.0)],
            dropped=[],
            modelled=schema_of({"Systems/TEMPERATURE": frozenset({"number"})}),
        )
        self.assertEqual(violations, [])

    def test_an_unmodelled_metric_is_reported_and_not_dropped(self):
        """
        THE LOAD-BEARING ASSERTION OF THE WHOLE FEATURE. `dropped` must be False: the sample is
        still written to the historian, and a change that starts refusing it destroys the evidence
        of the fault being reported.
        """
        violations = ingestion.payload_violations(
            observed=[("Rogue/Metric", "double", 1.0)],
            dropped=[],
            modelled=schema_of({"Systems/TEMPERATURE": frozenset({"number"})}),
        )
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["code"], "unmodelled_metric")
        self.assertEqual(violations[0]["metric"], "Rogue/Metric")
        self.assertFalse(violations[0]["dropped"])

    def test_a_type_mismatch_names_both_sides(self):
        violations = ingestion.payload_violations(
            observed=[("Systems/TEMPERATURE", "string", "x")],
            dropped=[],
            modelled=schema_of({"Systems/TEMPERATURE": frozenset({"number"})}),
        )
        self.assertEqual(violations[0]["code"], "type_mismatch")
        self.assertEqual(violations[0]["observed_type"], "string")
        self.assertEqual(violations[0]["expected_types"], ["number"])
        self.assertFalse(violations[0]["dropped"])

    def test_integer_is_satisfied_by_a_sparkplug_numeric(self):
        """
        Sparkplug's int and long wire types are cast to float by process_ddata before they reach a
        column, so there is no integer kind to match on. Rejecting `{"type": "integer"}` would flag
        every correctly-modelled counter in the plant.
        """
        violations = ingestion.payload_violations(
            observed=[("Parts/Count", "double", 1.0)],
            dropped=[],
            modelled=schema_of({"Parts/Count": frozenset({"integer"})}),
        )
        self.assertEqual(violations, [])

    def test_an_unconstrained_metric_accepts_any_value_kind(self):
        modelled = schema_of({"Anything": None})
        for kind in ("double", "string", "bool"):
            with self.subTest(kind=kind):
                self.assertEqual(
                    ingestion.payload_violations(
                        [("Anything", kind, VALUE_FOR_KIND[kind])], [], modelled), []
                )

    def test_no_schema_attached_produces_no_schema_violations(self):
        """
        `None` means nothing is bound, so there is nothing to judge against -- the ordinary state
        of a newly onboarded device, which must not be accused of anything.
        """
        violations = ingestion.payload_violations(
            observed=[("Whatever", "double", 1.0)], dropped=[], modelled=None
        )
        self.assertEqual(violations, [])

    def test_an_empty_schema_makes_every_metric_unmodelled(self):
        """
        The counterpart to the test above, and the reason the two answers cannot be conflated: a
        schema IS bound and it models nothing, which is a real finding.
        """
        violations = ingestion.payload_violations(
            observed=[("Whatever", "double", 1.0)], dropped=[], modelled=schema_of({})
        )
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["code"], "unmodelled_metric")

    def test_dropped_metrics_are_reported_even_with_no_schema(self):
        """
        A lost sample is a fact about the payload, not about the schema, so it survives the
        `modelled is None` short-circuit that suppresses the conformance half.
        """
        violations = ingestion.payload_violations(
            observed=[],
            dropped=[(None, "unresolved_alias", "alias 7 is not in the alias table")],
            modelled=None,
        )
        self.assertEqual(len(violations), 1)
        self.assertTrue(violations[0]["dropped"])
        self.assertEqual(violations[0]["code"], "unresolved_alias")

    def test_dropped_and_non_conforming_are_distinguishable_in_one_payload(self):
        violations = ingestion.payload_violations(
            observed=[("Rogue/Metric", "double", 1.0)],
            dropped=[("Systems/TEMPERATURE", "timestamp_out_of_window", "clock skew")],
            modelled=schema_of({"Systems/TEMPERATURE": frozenset({"number"})}),
        )
        by_code = {v["code"]: v for v in violations}
        self.assertTrue(by_code["timestamp_out_of_window"]["dropped"])
        self.assertFalse(by_code["unmodelled_metric"]["dropped"])



# =================================================================================================
# The facets beyond `type` -- enum, bounds, pattern, additionalProperties
#
# These sat in stored schemas and were read past in silence: the documents were already JSON
# Schema and only the reader was shallow. Each test below is a constraint an operator could
# already have written into `schemas.schema_definition` and watched do nothing.
# =================================================================================================
class DeeperConstraintsTestCase(unittest.TestCase):

    def test_enum_is_read_and_a_value_outside_it_is_a_violation(self):
        modelled = schema_of({"Controller/EXECUTION": ingestion.MetricConstraint(
            types=frozenset({"string"}), enum=frozenset({"ACTIVE", "READY"}))})

        self.assertEqual(
            ingestion.payload_violations([("Controller/EXECUTION", "string", "ACTIVE")], [], modelled), [])

        violations = ingestion.payload_violations(
            [("Controller/EXECUTION", "string", "MELTING")], [], modelled)
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["code"], "enum_mismatch")
        self.assertEqual(violations[0]["permitted"], ["ACTIVE", "READY"])

    def test_bounds_are_read_in_both_directions(self):
        modelled = schema_of({"Systems/TEMPERATURE": ingestion.MetricConstraint(
            types=frozenset({"number"}), minimum=0.0, maximum=100.0)})

        self.assertEqual(
            ingestion.payload_violations([("Systems/TEMPERATURE", "double", 50.0)], [], modelled), [])
        self.assertEqual(
            ingestion.payload_violations(
                [("Systems/TEMPERATURE", "double", -1.0)], [], modelled)[0]["code"],
            "below_minimum")
        self.assertEqual(
            ingestion.payload_violations(
                [("Systems/TEMPERATURE", "double", 101.0)], [], modelled)[0]["code"],
            "above_maximum")

    def test_a_bound_is_inclusive(self):
        """
        `minimum` is inclusive in every JSON Schema draft. Off-by-one here rejects the exact
        setpoint a machine is meant to sit at, which is the value it will report most often.
        """
        modelled = schema_of({"M": ingestion.MetricConstraint(minimum=0.0, maximum=100.0)})
        self.assertEqual(ingestion.payload_violations([("M", "double", 0.0)], [], modelled), [])
        self.assertEqual(ingestion.payload_violations([("M", "double", 100.0)], [], modelled), [])

    def test_pattern_is_read_for_strings(self):
        modelled = schema_of({"Batch/ID": ingestion.MetricConstraint(
            types=frozenset({"string"}), pattern=r"^B[0-9]{4}$")})

        self.assertEqual(
            ingestion.payload_violations([("Batch/ID", "string", "B1234")], [], modelled), [])
        self.assertEqual(
            ingestion.payload_violations([("Batch/ID", "string", "nope")], [], modelled)[0]["code"],
            "pattern_mismatch")

    def test_an_invalid_stored_pattern_is_charged_to_the_schema_not_the_device(self):
        """
        A regular expression that does not compile is the schema author's mistake. It is reported
        so somebody can see it, under its own code, and enforceable_violation() refuses to drop on
        it -- otherwise a typo in a schema silences a machine that is publishing correctly.
        """
        modelled = schema_of({"M": ingestion.MetricConstraint(
            types=frozenset({"string"}), pattern="([unclosed")})
        violations = ingestion.payload_violations([("M", "string", "anything")], [], modelled)

        self.assertEqual(violations[0]["code"], "schema_pattern_invalid")
        self.assertFalse(ingestion.enforceable_violation(violations[0], closed=True))

    def test_a_type_mismatch_reports_alone(self):
        """
        A string where a number is modelled fails `minimum` too. Reporting both buries the fault
        that explains the other, so type short-circuits.
        """
        modelled = schema_of({"M": ingestion.MetricConstraint(
            types=frozenset({"number"}), minimum=0.0)})
        violations = ingestion.payload_violations([("M", "string", "x")], [], modelled)

        self.assertEqual([v["code"] for v in violations], ["type_mismatch"])

    def test_bounds_are_not_applied_to_a_string(self):
        """
        Comparing a str against a float raises in Python 3. A schema that puts `minimum` on a
        string metric is malformed, and it must not take the callback thread down.
        """
        modelled = schema_of({"M": ingestion.MetricConstraint(minimum=0.0)})
        self.assertEqual(ingestion.payload_violations([("M", "string", "x")], [], modelled), [])

    def test_additional_properties_false_closes_the_set(self):
        parsed = ingestion.modelled_constraints([
            {"properties": {"Known": {"type": "number"}}, "additionalProperties": False}])
        self.assertTrue(parsed.closed)

    def test_a_closed_set_makes_an_unmodelled_metric_enforceable(self):
        """
        THE ONLY THING THAT MAKES AN UNMODELLED METRIC DROPPABLE. JSON Schema permits unnamed
        properties by default, so silence is permission -- dropping on silence would delete every
        reading from a device that gained a sensor before anyone updated its schema, which is the
        ordinary way a fleet changes.
        """
        v = {"code": "unmodelled_metric", "dropped": False}
        self.assertFalse(ingestion.enforceable_violation(v, closed=False))
        self.assertTrue(ingestion.enforceable_violation(v, closed=True))

    def test_an_already_dropped_finding_is_never_re_decided(self):
        """
        An unresolved alias or an out-of-window timestamp was skipped by the loop for its own
        reasons. This policy does not own that decision and must not appear to.
        """
        v = {"code": "unresolved_alias", "dropped": True}
        self.assertFalse(ingestion.enforceable_violation(v, closed=True))

    def test_every_value_facet_is_enforceable(self):
        for code in ("type_mismatch", "enum_mismatch", "below_minimum", "above_maximum",
                     "pattern_mismatch"):
            with self.subTest(code=code):
                self.assertTrue(
                    ingestion.enforceable_violation({"code": code, "dropped": False}, closed=False))


# =================================================================================================
# The permissive union, across the facets it now has to widen
# =================================================================================================
class ConstraintUnionTestCase(unittest.TestCase):

    def test_a_schema_without_an_enum_widens_the_union_to_unconstrained(self):
        """
        The same rule `type` already followed: the union is what the device is PERMITTED to send,
        and a submodel that lists no enum permits anything.
        """
        for order in ([{"properties": {"M": {"enum": ["A"]}}}, {"required": ["M"]}],
                      [{"required": ["M"]}, {"properties": {"M": {"enum": ["A"]}}}]):
            with self.subTest(order=order):
                self.assertIsNone(ingestion.modelled_constraints(order).metrics["M"].enum)

    def test_two_enums_union_rather_than_intersect(self):
        parsed = ingestion.modelled_constraints([
            {"properties": {"M": {"enum": ["A"]}}},
            {"properties": {"M": {"enum": ["B"]}}},
        ])
        self.assertEqual(parsed.metrics["M"].enum, frozenset({"A", "B"}))

    def test_the_widest_bound_survives(self):
        parsed = ingestion.modelled_constraints([
            {"properties": {"M": {"minimum": 10, "maximum": 20}}},
            {"properties": {"M": {"minimum": 0, "maximum": 100}}},
        ])
        self.assertEqual(parsed.metrics["M"].minimum, 0.0)
        self.assertEqual(parsed.metrics["M"].maximum, 100.0)

    def test_differing_patterns_widen_to_unconstrained(self):
        """
        Two patterns cannot be combined into one expression meaning "either" without building an
        alternation and hoping both are well formed. Widening is the permissive answer and matches
        every other facet.
        """
        parsed = ingestion.modelled_constraints([
            {"properties": {"M": {"pattern": "^A"}}},
            {"properties": {"M": {"pattern": "^B"}}},
        ])
        self.assertIsNone(parsed.metrics["M"].pattern)

    def test_an_identical_pattern_survives_the_union(self):
        parsed = ingestion.modelled_constraints([
            {"properties": {"M": {"pattern": "^A"}}},
            {"properties": {"M": {"pattern": "^A"}}},
        ])
        self.assertEqual(parsed.metrics["M"].pattern, "^A")

    def test_a_boolean_is_not_a_bound(self):
        """
        `True` is an int in Python, so a Draft 4 document spelling `exclusiveMinimum: true` beside
        a minimum must not be read as a bound of 1.
        """
        parsed = ingestion.modelled_constraints([{"properties": {"M": {"minimum": True}}}])
        self.assertIsNone(parsed.metrics["M"].minimum)

# =================================================================================================
# record_payload_violations() -- the deduplication that keeps the audit table finite
# =================================================================================================
class RecordViolationsTestCase(unittest.TestCase):

    def setUp(self):
        self._real_client = ingestion.supabase_client
        self._real_flag = ingestion.AUDIT_PAYLOAD_REJECTIONS
        self.client = MagicMock()
        ingestion.supabase_client = self.client
        ingestion.AUDIT_PAYLOAD_REJECTIONS = True
        ingestion._last_violation_signature.clear()
        registry.reset()

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        ingestion.AUDIT_PAYLOAD_REJECTIONS = self._real_flag
        ingestion._last_violation_signature.clear()
        registry.reset()

    def violation(self, metric="Rogue/Metric", code="unmodelled_metric"):
        return [{"metric": metric, "code": code, "detail": "d", "dropped": False}]

    def rpc_calls(self):
        return [c for c in self.client.rpc.call_args_list]

    def test_a_new_fault_is_recorded(self):
        ingestion.record_payload_violations(device(), self.violation(), OBSERVED_AT)

        self.assertEqual(len(self.rpc_calls()), 1)
        name, payload = self.rpc_calls()[0].args
        self.assertEqual(name, "record_ingestion_rejection")
        self.assertEqual(payload["p_device_id"], "device-uuid")
        self.assertEqual(len(payload["p_violations"]), 1)

    def test_the_same_fault_repeated_writes_exactly_once(self):
        """
        THE TEST THIS FILE EXISTS FOR. Ten identical messages are one problem, not ten, and
        audit_trail cannot be pruned by any application role.
        """
        for _ in range(10):
            ingestion.record_payload_violations(device(), self.violation(), OBSERVED_AT)

        self.assertEqual(len(self.rpc_calls()), 1)
        self.assertEqual(ingestion.counter_snapshot().get("payload_violations_recorded"), 1)
        self.assertEqual(ingestion.counter_snapshot().get("payload_violations_suppressed"), 9)

    def test_a_different_fault_is_recorded_again(self):
        ingestion.record_payload_violations(device(), self.violation("A"), OBSERVED_AT)
        ingestion.record_payload_violations(device(), self.violation("B"), OBSERVED_AT)

        self.assertEqual(len(self.rpc_calls()), 2)

    def test_the_detail_text_alone_does_not_re_trigger_a_write(self):
        """
        The signature is (metric, code) and deliberately excludes `detail`, which carries a
        timestamp on the clock-skew path -- so including it would make every message a new fault
        and defeat the deduplication entirely.
        """
        first = [{"metric": "M", "code": "timestamp_out_of_window",
                  "detail": "timestamp 2026-08-21T09:30:00 ...", "dropped": True}]
        second = [{"metric": "M", "code": "timestamp_out_of_window",
                   "detail": "timestamp 2026-08-21T09:31:00 ...", "dropped": True}]

        ingestion.record_payload_violations(device(), first, OBSERVED_AT)
        ingestion.record_payload_violations(device(), second, OBSERVED_AT)

        self.assertEqual(len(self.rpc_calls()), 1)

    def test_a_clean_payload_writes_nothing(self):
        ingestion.record_payload_violations(device(), [], OBSERVED_AT)
        self.assertEqual(self.rpc_calls(), [])

    def test_recovery_then_regression_is_recorded_again(self):
        """
        A fault that returns after being fixed must reappear in the thread. Without the memo being
        cleared on a clean payload, a repaired-then-regressed device stays silent forever -- which
        is indistinguishable from health, the worst failure an audit trail can have.
        """
        ingestion.record_payload_violations(device(), self.violation(), OBSERVED_AT)
        ingestion.record_payload_violations(device(), [], OBSERVED_AT)
        ingestion.record_payload_violations(device(), self.violation(), OBSERVED_AT)

        self.assertEqual(len(self.rpc_calls()), 2)

    def test_a_failed_write_is_retried_on_the_next_message(self):
        """
        The memo is set only after the RPC succeeds. Marking it first would let one transient
        PostgREST failure swallow the fault until its signature happened to change.
        """
        self.client.rpc.side_effect = RuntimeError("PostgREST unavailable")
        ingestion.record_payload_violations(device(), self.violation(), OBSERVED_AT)
        self.assertEqual(ingestion.counter_snapshot().get("payload_violation_write_failures"), 1)

        self.client.rpc.side_effect = None
        ingestion.record_payload_violations(device(), self.violation(), OBSERVED_AT)
        self.assertEqual(ingestion.counter_snapshot().get("payload_violations_recorded"), 1)

    def test_the_flag_switches_the_whole_path_off(self):
        ingestion.AUDIT_PAYLOAD_REJECTIONS = False
        ingestion.record_payload_violations(device(), self.violation(), OBSERVED_AT)
        self.assertEqual(self.rpc_calls(), [])

    def test_two_devices_are_deduplicated_independently(self):
        """
        The memo is keyed by device. A fleet-wide fault -- a gateway firmware change that renames a
        metric on every machine it serves -- must produce one row per device, not one in total.
        """
        ingestion.record_payload_violations(device(id="a"), self.violation(), OBSERVED_AT)
        ingestion.record_payload_violations(device(id="b"), self.violation(), OBSERVED_AT)
        ingestion.record_payload_violations(device(id="a"), self.violation(), OBSERVED_AT)

        self.assertEqual(len(self.rpc_calls()), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
