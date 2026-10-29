"""
The ingestion half of the schema-builder contract.

The dashboard's schema builders write each metric's `enum`, `minimum` and `maximum` from the catalog
and from the range typed beside it. `test-harness/fixtures/schema-builder-output.json` holds what
they write; `frontend/src/__tests__/schemaBuilderContract.test.jsx` asserts both builders produce it.
This file feeds that same definition to conformance.py and asserts what ingestion finds in each
reading, so a builder writing a key ingestion does not read, or in a shape it does not read, fails
one side or the other. Pure logic: conformance.py imports nothing heavier than `re`.
"""

import json
import os
import sys
import unittest

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import conformance  # noqa: E402

FIXTURE = os.path.join(
    os.path.dirname(INGESTION_DIR), "test-harness", "fixtures", "schema-builder-output.json")


class SchemaBuilderContractTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, "r", encoding="utf-8") as handle:
            cls.fixture = json.load(handle)
        cls.modelled = conformance.modelled_constraints([cls.fixture["schema_definition"]])

    def test_the_fixture_exercises_every_constraint_a_builder_writes(self):
        """A contract with no reading that breaks a facet says nothing about that facet."""
        codes = {code for *_reading, expected in self.fixture["readings"] for code in expected}
        self.assertTrue({"enum_mismatch", "below_minimum", "above_maximum"} <= codes)

    def test_ingestion_reads_each_written_constraint(self):
        """The builders' keys, parsed: a closed set as an enum, a range as two floats."""
        metrics = self.modelled.metrics
        self.assertEqual(metrics["Controller/EXECUTION"].enum,
                         frozenset({"READY", "ACTIVE", "INTERRUPTED", "FEED_HOLD", "STOPPED"}))
        self.assertEqual(metrics["Controller/MODE_CODE"].enum, frozenset({0, 1, 2}))
        self.assertEqual(metrics["MotionDevice/OnPath"].enum, frozenset({True}))
        self.assertEqual((metrics["Axes/S/LOAD"].minimum, metrics["Axes/S/LOAD"].maximum), (0.0, 150.0))
        self.assertEqual((metrics["Systems/TEMPERATURE"].minimum, metrics["Systems/TEMPERATURE"].maximum),
                         (-40.0, None))
        self.assertEqual(metrics["Controller/FIRMWARE"],
                         conformance.MetricConstraint(types=frozenset({"string"})))
        # Nothing a builder writes closes the set: a metric no schema names is recorded, never dropped.
        self.assertFalse(self.modelled.closed)

    def test_every_reading_gets_the_findings_the_fixture_expects(self):
        for metric, kind, value, expected in self.fixture["readings"]:
            with self.subTest(metric=metric, value=value):
                # A double is a float by the time it is checked: ingestion casts every integer type.
                observed = [(metric, kind, float(value) if kind == "double" else value)]
                found = conformance.payload_violations(observed, [], self.modelled)
                self.assertEqual([v["code"] for v in found], expected)
                # Each finding is one a device set to Enforce drops the reading for.
                for violation in found:
                    self.assertTrue(conformance.enforceable_violation(violation, self.modelled.closed))


if __name__ == "__main__":
    unittest.main(verbosity=2)
