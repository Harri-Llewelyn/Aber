"""
The Python half of the modelled-metrics contract.

`frontend/src/__tests__/modelledMetricsContract.test.js` asserts the same fixture against the
JavaScript mirror in `frontend/src/utils/deviceTags.js`. Neither language can import the other, so
`tests/fixtures/modelled-metrics.json` is the seam: changing one implementation fails its own suite
until the fixture is updated, and updating the fixture then fails the other. That is the drift
signal, and it is behavioural -- grepping both files for the word `required` would prove only that
they both spell it, not that they agree about a schema whose `required` is a string.

Writing this pair found a divergence that had been shipping: for `properties: ['A','B']` the JS
returned the ARRAY INDICES as metric names while the Python returned None. See the fixture's own
`_comment` for what that did to a device carrying such a schema.

`validate.py` imports psycopg2, paho and the Supabase client at module scope; they are stubbed here
before the import, the same way `test_declared_metrics.py` stubs ingestion.py's heavy imports, so
this stays a pure-logic test that needs no stack and no `protoc`.
"""

import json
import os
import sys
import types
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

for name in ("psycopg2", "paho", "paho.mqtt", "paho.mqtt.client", "supabase", "sparkplug_b_pb2"):
    if name not in sys.modules:
        module = types.ModuleType(name)
        module.__getattr__ = lambda _attr: MagicMock()  # noqa: E731
        sys.modules[name] = module
sys.modules["psycopg2"].connect = MagicMock()
sys.modules["supabase"].create_client = MagicMock()
sys.modules["paho.mqtt"].client = sys.modules["paho.mqtt.client"]

import validate  # noqa: E402

FIXTURE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "tests", "fixtures", "modelled-metrics.json",
)


class TestModelledMetricsContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURE, "r", encoding="utf-8") as handle:
            cls.fixture = json.load(handle)

    def test_fixture_is_not_empty(self):
        """A contract test exercising nothing reports green while the two sides drift freely."""
        self.assertGreater(len(self.fixture["cases"]), 5)

    def test_every_case_matches_the_contract(self):
        for case in self.fixture["cases"]:
            with self.subTest(case=case["name"]):
                result = validate.modelled_metrics(case["schema_definition"])
                if case["expected"] is None:
                    # None means "declares neither, cannot be evaluated" -- NOT "models nothing".
                    # Collapsing the two would flag every device with an unusable schema.
                    self.assertIsNone(result)
                else:
                    self.assertIsNotNone(result)
                    self.assertEqual(sorted(result), sorted(case["expected"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
