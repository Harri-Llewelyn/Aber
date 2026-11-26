# suite:
#   lanes: unit
#   why: The i3X object and the AAS shell of one device name each other. Each device's metadata.system
#     names its shell's id and globalAssetId under the site's AAS_BASE_IRI, by the rule shell.ts uses,
#     which test-harness/fixtures/asset-identities.json holds both to. A device with a recorded
#     nameplate has one Nameplate component, typed in the IDTA nameplate namespace with the projection
#     suffix, whose value is the nameplate's fields and which has no history. The reads are held to real
#     columns by the fake test_i3x_service uses, so a column the migrations lack fails here.

"""
A device's i3X object names its AAS shell and carries its nameplate.

    python i3x/test_a_device_names_its_shell_and_carries_its_nameplate.py
"""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import address_space as A  # noqa: E402
import i3x_service  # noqa: E402
import test_i3x_service as shared  # noqa: E402

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[1] / "test-harness" / "fixtures" / "asset-identities.json")
    .read_text(encoding="utf-8")
)

PLATE_ID = A.nameplate_element_id("dev-explicit")
RECORDED = {
    "device_id": "d-explicit",
    "updated_at": "2026-11-20T09:30:00+00:00",
    "manufacturer_name": "Acme Machine Tools",
    "serial_number": "SN-0042",
    "date_of_manufacture": "2024-03-01",
    "address_city_town": "Cardiff",
    "address_national_code": "GB",
    "software_version": "   ",
}


def space_with(nameplates, **overrides):
    """The shared seeded rows, with these device_nameplate rows, read and built as a request is."""
    rows = shared._seeded_rows()
    rows["device_nameplate"] = nameplates
    for relation, value in overrides.items():
        rows[relation] = value
    pg = shared.ColumnCheckingPostgrest(rows)
    space = i3x_service._read_address_space(pg)
    return pg, space, i3x_service._build_objects(space)


class TestTheIdentitiesAgreeWithTheShell(unittest.TestCase):
    def test_every_case_of_the_contract(self):
        self.assertGreaterEqual(len(CONTRACT["cases"]), 4, "the contract lost its cases")
        for case in CONTRACT["cases"]:
            with self.subTest(case=case["name"]):
                sid, base, expected = case["sparkplug_id"], case["base_iri"], case["expected"]
                self.assertEqual(A.aas_global_asset_id(sid, base), expected["globalAssetId"])
                self.assertEqual(A.aas_shell_id(sid, base), expected["shellId"])
                element = A.metric_element_id(sid, case["metric"]) if case["metric"] else sid
                self.assertEqual(element, expected["elementId"])

    def test_an_unset_base_is_the_shells_default(self):
        default = next(c for c in CONTRACT["cases"] if c["base_iri"] == A.AAS_DEFAULT_BASE_IRI)
        self.assertEqual(A.aas_global_asset_id(default["sparkplug_id"]), default["expected"]["globalAssetId"])

    def test_every_device_names_its_shell_under_the_sites_base(self):
        with mock.patch.object(i3x_service, "AAS_BASE_IRI", "https://plant.example.com/ids/asset"):
            _, _, objects = space_with([])
        for sid in ("dev-explicit", "dev-inherits", "dev-nowhere"):
            with self.subTest(device=sid):
                system = objects[sid]["metadata"]["system"]
                self.assertEqual(system["aasGlobalAssetId"], f"https://plant.example.com/ids/asset/{sid}")
                self.assertEqual(system["aasShellId"], f"https://plant.example.com/ids/asset/{sid}/shell")
                # The elementId is the sparkplug_id, which the shell's globalAssetId ends in.
                self.assertTrue(system["aasGlobalAssetId"].endswith("/" + objects[sid]["elementId"]))


class TestADeviceCarriesItsNameplate(unittest.TestCase):
    def setUp(self):
        i3x_service._space_cache_clear()

    def test_it_is_a_leaf_component_of_its_device(self):
        _, _, objects = space_with([RECORDED])
        plate, device = objects[PLATE_ID], objects["dev-explicit"]
        self.assertEqual(
            (plate["typeElementId"], plate["parentId"], plate["isComposition"], plate["displayName"]),
            (A.NAMEPLATE_TYPE_ID, "dev-explicit", False, "Nameplate"),
        )
        self.assertEqual(plate["metadata"]["relationships"], {"ComponentOf": ["dev-explicit"]})
        self.assertIn(PLATE_ID, device["metadata"]["relationships"]["HasComponent"])
        # A device with nothing else to be made of is a composition of its nameplate.
        self.assertTrue(device["isComposition"])
        self.assertEqual(plate["metadata"]["sourceTypeId"], "https://admin-shell.io/idta/nameplate/3/0/Nameplate")

    def test_a_device_with_none_or_an_empty_one_has_none(self):
        blank = {"device_id": "d-inherits", "updated_at": "2026-11-20T09:30:00+00:00", "serial_number": "  "}
        _, space, objects = space_with([RECORDED, blank])
        self.assertNotIn(A.nameplate_element_id("dev-inherits"), objects)
        self.assertNotIn(A.nameplate_element_id("dev-nowhere"), objects)
        self.assertNotIn("HasComponent", objects["dev-nowhere"]["metadata"]["relationships"])
        self.assertFalse(objects["dev-nowhere"]["isComposition"])

    def test_its_type_is_the_templates_projection_and_is_served_while_one_exists(self):
        _, space, _ = space_with([RECORDED])
        types = {t["elementId"]: t for t in i3x_service._build_types(space)}
        plate = types[A.NAMEPLATE_TYPE_ID]
        self.assertEqual(plate["namespaceUri"], "https://admin-shell.io/idta/nameplate/3/0?projection=i3X")
        self.assertIn(plate["namespaceUri"], [n["uri"] for n in A.namespaces(list(types.values()))])
        _, bare, _ = space_with([])
        self.assertNotIn(A.NAMEPLATE_TYPE_ID, {t["elementId"] for t in i3x_service._build_types(bare)})

    def test_its_value_is_the_nameplates_fields_and_conforms_to_its_type(self):
        pg, _, _ = space_with([RECORDED])
        req = shared.FakeRequest(body={"elementIds": [PLATE_ID]}, pg=pg)
        i3x_service.h_objects_value(req)
        result = req.result[0]["result"]
        self.assertEqual((result["quality"], result["timestamp"]), ("Good", "2026-11-20T09:30:00Z"))
        value = result["value"]
        self.assertEqual(value["ManufacturerName"], "Acme Machine Tools")
        self.assertEqual(value["SerialNumber"], "SN-0042")
        self.assertEqual(value["DateOfManufacture"], "2024-03-01")
        # A value of spaces is none, as the shell reads it.
        self.assertIsNone(value["SoftwareVersion"])
        self.assertEqual(value["AddressInformation"], {
            "Street": None, "Zipcode": None, "CityTown": "Cardiff", "StateCounty": None, "NationalCode": "GB",
        })
        schema = A.NAMEPLATE_TYPE["schema"]
        self.assertEqual(set(value), set(schema["properties"]))
        self.assertEqual(set(value["AddressInformation"]),
                         set(schema["properties"]["AddressInformation"]["properties"]))
        if shared.HAVE_JSONSCHEMA:
            shared.jsonschema.validate(value, schema)

    def test_it_is_good_whatever_its_devices_state(self):
        devices = shared._seeded_rows()["devices"]
        devices[0] = dict(devices[0], status="OFFLINE", is_quarantined=True)
        pg, _, _ = space_with([RECORDED], devices=devices)
        req = shared.FakeRequest(body={"elementIds": [PLATE_ID, "dev-explicit"], "maxDepth": 0}, pg=pg)
        i3x_service.h_objects_value(req)
        plate, device = (r["result"] for r in req.result)
        self.assertEqual(plate["quality"], "Good")
        # It is under the device's components, and stays out of the device's own map of metrics.
        self.assertEqual(device["components"][PLATE_ID]["value"]["SerialNumber"], "SN-0042")
        self.assertNotIn("SerialNumber", device["value"] or {})

    def test_it_has_no_history(self):
        pg, _, _ = space_with([RECORDED])
        req = shared.FakeRequest(body={
            "elementIds": [PLATE_ID],
            "startTime": "2026-11-01T00:00:00Z",
            "endTime": "2026-11-02T00:00:00Z",
        }, pg=pg)
        i3x_service.h_objects_history(req)
        self.assertEqual(req.result[0]["result"]["values"], [])
        self.assertNotIn("telemetry", [relation for relation, _ in pg.calls])

    def test_it_is_not_read_from_the_historian_as_a_metric(self):
        pg, space, objects = space_with([RECORDED])
        with mock.patch.object(i3x_service, "_filled", set()):
            i3x_service._fill_from_historian(pg, space, objects, {"dev-explicit"})
        self.assertNotIn("telemetry_latest", [relation for relation, _ in pg.calls])

    def test_every_edge_has_its_inverse(self):
        _, _, objects = space_with([RECORDED])
        edges = objects[PLATE_ID]["metadata"]["relationships"]["ComponentOf"]
        for parent in edges:
            self.assertIn(PLATE_ID, objects[parent]["metadata"]["relationships"]["HasComponent"])


if __name__ == "__main__":
    unittest.main()
