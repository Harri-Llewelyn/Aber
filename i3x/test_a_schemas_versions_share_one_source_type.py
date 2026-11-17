# suite:
#   lanes: unit
#   why: 0298 -- that every version of one schema names one source type in the i3X address space, as
#     every version of it names one Submodel in the AAS export: the semantic id when there is one,
#     else the lineage's name (the first version's), never the version's own name (X_v2). A row
#     without a lineage name, from a database that has not replayed 0298, still falls back to its own
#     name. The read that fetches the name is held to real columns by the same fake test_i3x_service
#     uses, so a column the migrations lack fails here and not on the live stack.

"""
Every version of a schema names one i3X source type (0298).

    python i3x/test_a_schemas_versions_share_one_source_type.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import address_space as A  # noqa: E402
import i3x_service  # noqa: E402
import test_i3x_service as shared  # noqa: E402

ROOT = "11111111-1111-4111-8111-111111111111"
SECOND = "22222222-2222-4222-8222-222222222222"
THIRD = "33333333-3333-4333-8333-333333333333"
SEMANTIC = "https://admin-shell.io/idta/example/Mill/1/0"


def version(schema_id, name, number, lineage, semantic_id=None):
    return {
        "id": schema_id, "schema_name": name, "lineage_name": lineage, "version": number,
        "status": "active" if number == 3 else "archived", "description": None,
        "semantic_id": semantic_id, "change_description": None,
        "schema_definition": {"properties": {"Flow": {}}},
    }


class TestSourceTypeOfASchemaVersion(unittest.TestCase):
    def test_every_version_of_a_schema_names_the_lineage(self):
        rows = [
            version(ROOT, "Robot_Arm_Schema", 1, "Robot_Arm_Schema"),
            version(SECOND, "Robot_Arm_Schema_v2", 2, "Robot_Arm_Schema"),
            # fork_schema() suffixed this name, and stripping one _v<n> would not recover the lineage.
            version(THIRD, "Robot_Arm_Schema_v2_2_v3", 3, "Robot_Arm_Schema"),
        ]
        self.assertEqual({A.schema_source_type_id(row) for row in rows}, {"Robot_Arm_Schema"})

    def test_a_semantic_id_still_wins(self):
        row = version(SECOND, "Mill_v2", 2, "Mill", semantic_id=SEMANTIC)
        self.assertEqual(A.schema_source_type_id(row), SEMANTIC)

    def test_a_row_with_no_lineage_name_is_its_own_lineage(self):
        self.assertEqual(A.schema_source_type_id({"id": "s1", "schema_name": "Local Pump"}), "Local Pump")
        self.assertEqual(A.schema_source_type_id({"id": "s1"}), "s1")

    def test_the_type_served_for_each_version_carries_it(self):
        served = [
            A.object_type_from_schema(version(SECOND, "Robot_Arm_Schema_v2", 2, "Robot_Arm_Schema")),
            A.object_type_from_schema(version(ROOT, "Robot_Arm_Schema", 1, "Robot_Arm_Schema")),
        ]
        self.assertEqual([t["sourceTypeId"] for t in served], ["Robot_Arm_Schema"] * 2)
        # The type's own name and version are the version's: they are what a person picks.
        self.assertEqual([t["displayName"] for t in served], ["Robot_Arm_Schema_v2", "Robot_Arm_Schema"])
        self.assertEqual([t["version"] for t in served], ["2", "1"])

    def test_a_device_carries_its_versions_lineage_through_the_address_space(self):
        rows = shared._seeded_rows()
        rows["schemas"] = [
            version(SECOND, "Robot_Arm_Schema_v2", 2, "Robot_Arm_Schema"),
            version(ROOT, "Robot_Arm_Schema", 1, "Robot_Arm_Schema"),
        ]
        rows["device_schemas"] = [{"device_id": "d-explicit", "schema_id": SECOND}]
        space = i3x_service._read_address_space(shared.ColumnCheckingPostgrest(rows))
        objects = i3x_service._build_objects(space)
        types = {t["elementId"]: t["sourceTypeId"] for t in i3x_service._build_types(space)}
        self.assertEqual(objects["dev-explicit"]["metadata"]["sourceTypeId"], "Robot_Arm_Schema")
        self.assertEqual(types[SECOND], "Robot_Arm_Schema")
        self.assertEqual(types[ROOT], "Robot_Arm_Schema")


if __name__ == "__main__":
    unittest.main()
