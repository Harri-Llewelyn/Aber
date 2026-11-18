# suite:
#   lanes: unit
#   why: A catalog metric carrying a QUDT quantity kind as its semantic id (0304) is typed in QUDT's own
#     namespace, as a 223P id is. An id nothing recognises is typed local, which is a wrong namespace that
#     nothing else flags: the type is still served, and a client simply finds a BMS reading in the
#     namespace of no standard.

"""
The i3X namespace of a QUDT quantity kind. QUDT issues its own ids, http://qudt.org/vocab/quantitykind/<Name>,
so i3X files the type of a metric that carries one in QUDT's namespace, as an i3X projection: a scalar type
adapted from a kind is an in-exact implementation of it, which the guide marks with `?projection=i3X`.

Run: python -m unittest discover -s i3x
"""
import os
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import address_space as A  # noqa: E402
import i3x_service  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
KINDS = "http://qudt.org/vocab/quantitykind"
PROJECTION = KINDS + A.PROJECTION_SUFFIX
TEMPERATURE = KINDS + "/Temperature"


def zone_temperature(**changes):
    row = {"name": "BMS/ZONE_TEMPERATURE", "datatype": 10, "semantic_id": TEMPERATURE,
           "description": "Zone air temperature", "standard": "ASHRAE 223P", "units": "CELSIUS"}
    row.update(changes)
    return row


class TestTheNamespaceOfAnId(unittest.TestCase):
    def test_a_quantity_kind_is_in_qudts_namespace_as_an_i3x_projection(self):
        self.assertEqual(A.metric_type_namespace(TEMPERATURE), PROJECTION)
        self.assertEqual(A.metric_type_namespace(KINDS + "/VolumeFlowRate"), PROJECTION)
        self.assertEqual(A.metric_type_namespace(KINDS + "/CENTER-OF-GRAVITY_X"), PROJECTION)

    def test_it_is_the_standards_own_and_so_only_ever_a_projection_of_it(self):
        self.assertTrue(PROJECTION.endswith(A.PROJECTION_SUFFIX))
        self.assertFalse(PROJECTION.startswith("https://aber.local/"))
        self.assertNotIn(PROJECTION, A._LOCAL_STANDARD_NAMESPACES)

    def test_the_namespace_has_a_display_name_that_says_it_is_a_projection(self):
        namespaces = A.namespaces([A.metric_type_from_catalog(zone_temperature())])
        self.assertEqual([(n["uri"], n["displayName"]) for n in namespaces if n["uri"] == PROJECTION],
                         [(PROJECTION, "QUDT quantity kinds (i3X projection)")])

    def test_an_id_that_is_not_a_quantity_kinds_is_local(self):
        for semantic_id in ("http://qudt.org/vocab/unit/DEG_C",              # a unit is not a kind
                            KINDS,                                           # the namespace itself
                            "https://qudt.org/vocab/quantitykind/Temperature",   # QUDT's IRIs are http
                            "http://qudt.org/3.5.2/vocab/quantitykind/Temperature",
                            "https://aber.local/semantics/qudt/quantitykind/Temperature",
                            "http://data.ashrae.org/standard223#Temperature"):
            with self.subTest(semantic_id=semantic_id):
                self.assertNotEqual(A.metric_type_namespace(semantic_id), PROJECTION)
        self.assertEqual(A.metric_type_namespace("http://qudt.org/vocab/unit/DEG_C"), A.NS_LOCAL)

    def test_223p_and_the_other_namespaces_are_as_they_were(self):
        self.assertEqual(A.metric_type_namespace("http://data.ashrae.org/standard223#TemperatureSensor"),
                         "http://data.ashrae.org/standard223" + A.PROJECTION_SUFFIX)
        self.assertEqual(A.metric_type_namespace("https://aber.local/semantics/iso22400/OEE"),
                         "https://aber.local/semantics/iso22400")
        self.assertEqual(A.metric_type_namespace(None), A.NS_LOCAL)


class TestTheTypeOfAMetric(unittest.TestCase):
    def test_a_catalog_row_is_typed_in_qudts_namespace_by_its_id(self):
        metric_type = A.metric_type_from_catalog(zone_temperature())
        self.assertEqual(metric_type["namespaceUri"], PROJECTION)
        self.assertEqual(metric_type["sourceTypeId"], TEMPERATURE)
        self.assertEqual(metric_type["displayName"], "BMS/ZONE_TEMPERATURE")
        # The metric keeps the standard it is filed under: the namespace is where its id is defined.
        self.assertEqual(metric_type["metadata"]["standard"], "ASHRAE 223P")

    def test_a_custom_metric_with_a_kind_is_typed_there_too(self):
        metric_type = A.metric_type_from_catalog(zone_temperature(name="Hydraulic/OIL_TEMPERATURE", standard=None))
        self.assertEqual(metric_type["namespaceUri"], PROJECTION)

    def test_the_space_advertises_the_namespace_when_a_type_uses_it_and_not_otherwise(self):
        with_kind = i3x_service._build_types({"schemas": [], "metric_catalog": [zone_temperature()]})
        without = i3x_service._build_types({"schemas": [], "metric_catalog": []})
        self.assertIn(PROJECTION, [n["uri"] for n in A.namespaces(with_kind)])
        self.assertNotIn(PROJECTION, [n["uri"] for n in A.namespaces(without)])


class TestTheKindsTheSeedHolds(unittest.TestCase):
    def test_every_kind_the_migration_seeds_lands_in_it(self):
        migration = next((REPO_ROOT / "supabase/migrations").glob("0304_*.sql")).read_text(encoding="utf-8")
        ids = re.findall(r"^\('(http://qudt\.org/vocab/quantitykind/[^']+)', ", migration, re.M)
        self.assertGreater(len(ids), 1000, "read no QUDT quantity kinds: the seed's shape changed")
        self.assertEqual({A.metric_type_namespace(i) for i in ids}, {PROJECTION})

    def test_every_unit_the_migration_seeds_is_not_a_kind_and_stays_local(self):
        migration = next((REPO_ROOT / "supabase/migrations").glob("0304_*.sql")).read_text(encoding="utf-8")
        ids = re.findall(r"^\('(http://qudt\.org/vocab/unit/[^']+)', ", migration, re.M)
        self.assertGreater(len(ids), 50, "read no QUDT units: the seed's shape changed")
        self.assertEqual({A.metric_type_namespace(i) for i in ids}, {A.NS_LOCAL})

    def test_the_example_bms_readings_cite_kinds_that_land_in_it(self):
        example = (REPO_ROOT / "supabase/example-metrics.sql").read_text(encoding="utf-8")
        cited = re.findall(r"'(http://qudt\.org/vocab/quantitykind/[A-Za-z]+)'", example)
        self.assertGreaterEqual(len(set(cited)), 5)
        self.assertEqual({A.metric_type_namespace(i) for i in cited}, {PROJECTION})


if __name__ == "__main__":
    unittest.main(verbosity=2)
