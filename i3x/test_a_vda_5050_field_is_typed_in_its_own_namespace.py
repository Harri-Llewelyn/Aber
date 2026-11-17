# suite:
#   lanes: unit
#   why: A catalog metric carrying a VDA 5050 id (0302) is typed in the namespace the id is minted in.
#     An id nothing recognises is typed local, which is a wrong namespace that nothing else flags:
#     the type is still served, and a client simply finds AGV readings in the namespace of no standard.

"""
The i3X namespace of a VDA 5050 field. The VDA issues no concept identifiers, so Aber mints them,
under https://aber.local/semantics/vda5050/v3.0/State/<path>, and i3X files their types in that
local namespace, as it does MTConnect's and ISO 22400's.

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
VDA = "https://aber.local/semantics/vda5050/v3.0"
CHARGE = VDA + "/State/powerSupply.stateOfCharge"


def charge_row(**changes):
    row = {"name": "AGV/powerSupply/stateOfCharge", "datatype": 10, "semantic_id": CHARGE,
           "description": "State of Charge in %", "standard": "VDA 5050"}
    row.update(changes)
    return row


class TestTheNamespaceOfAnId(unittest.TestCase):
    def test_a_vda_5050_id_is_in_the_vda_5050_namespace(self):
        self.assertEqual(A.metric_type_namespace(CHARGE), VDA)
        self.assertEqual(A.metric_type_namespace(VDA + "/State/driving"), VDA)

    def test_the_namespace_has_a_display_name_that_says_the_ids_are_minted_here(self):
        namespaces = A.namespaces([A.metric_type_from_catalog(charge_row())])
        self.assertEqual([(n["uri"], n["displayName"]) for n in namespaces if n["uri"] == VDA],
                         [(VDA, "VDA 5050 3.0 (Aber ids)")])

    def test_it_is_local_and_never_a_projection_of_the_vdas_own(self):
        self.assertTrue(VDA.startswith("https://aber.local/"))
        self.assertFalse(VDA.endswith(A.PROJECTION_SUFFIX))
        self.assertIn(VDA, A._LOCAL_STANDARD_NAMESPACES)

    def test_an_id_under_another_version_or_authority_is_local_to_this_deployment(self):
        for semantic_id in ("https://aber.local/semantics/vda5050/v2.0/State/driving",
                            "https://aber.local/semantics/vda5050/v3.0",
                            "https://www.vda5050.org/State/driving",
                            "https://github.com/VDA5050/VDA5050/State/driving"):
            with self.subTest(semantic_id=semantic_id):
                self.assertEqual(A.metric_type_namespace(semantic_id), A.NS_LOCAL)


class TestTheTypeOfAMetric(unittest.TestCase):
    def test_a_catalog_row_is_typed_in_the_vda_5050_namespace_by_its_id(self):
        metric_type = A.metric_type_from_catalog(charge_row())
        self.assertEqual(metric_type["namespaceUri"], VDA)
        self.assertEqual(metric_type["sourceTypeId"], CHARGE)
        self.assertEqual(metric_type["displayName"], "AGV/powerSupply/stateOfCharge")
        self.assertEqual(metric_type["metadata"]["standard"], "VDA 5050")

    def test_an_enum_field_carries_its_permitted_values_as_a_hint_not_an_enum(self):
        metric_type = A.metric_type_from_catalog(charge_row(
            name="AGV/operatingMode", datatype=12, semantic_id=VDA + "/State/operatingMode",
            permitted_values=["STARTUP", "AUTOMATIC", "MANUAL"]))
        self.assertEqual(metric_type["schema"]["x-permitted-values"], ["STARTUP", "AUTOMATIC", "MANUAL"])
        self.assertNotIn("enum", metric_type["schema"])

    def test_the_space_advertises_the_namespace_when_a_type_uses_it_and_not_otherwise(self):
        with_agv = i3x_service._build_types({"schemas": [], "metric_catalog": [charge_row()]})
        without = i3x_service._build_types({"schemas": [], "metric_catalog": []})
        self.assertIn(VDA, [n["uri"] for n in A.namespaces(with_agv)])
        self.assertNotIn(VDA, [n["uri"] for n in A.namespaces(without)])


class TestTheNamespaceIsWhereTheIdsAreMinted(unittest.TestCase):
    def test_the_dashboard_and_the_generator_mint_under_it(self):
        standards = (REPO_ROOT / "frontend/src/utils/standards.js").read_text(encoding="utf-8")
        minted = re.search(r"export const VDA5050_SEMANTIC_NAMESPACE = `\$\{LOCAL_SEMANTIC_NAMESPACE\}([^`]+)`",
                           standards)
        self.assertIsNotNone(minted, "standards.js names no VDA5050_SEMANTIC_NAMESPACE")
        self.assertEqual("https://aber.local/semantics" + minted.group(1), VDA)

        generator = (REPO_ROOT / "scripts/lib/vda5050-vocabulary.mjs").read_text(encoding="utf-8")
        self.assertIn(f"export const SEMANTIC_BASE = '{VDA}';", generator)

    def test_every_field_the_migration_seeds_lands_in_it(self):
        migration = next((REPO_ROOT / "supabase/migrations").glob("0302_*.sql")).read_text(encoding="utf-8")
        ids = re.findall(r"^INSERT INTO public\.vda5050_vocabulary VALUES \(.*'((?:[^']|'')*)'\)$",
                         migration, re.M)
        self.assertGreater(len(ids), 20, "read no VDA 5050 rows: the seed's shape changed")
        self.assertEqual({A.metric_type_namespace(i) for i in ids}, {VDA})


if __name__ == "__main__":
    unittest.main(verbosity=2)
