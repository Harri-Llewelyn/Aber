# suite:
#   lanes: stack
#   why: A shell names its asset by more than its globalAssetId, and aas-export and aas-api build
#     that list from one function. Against the AAS fixture device this holds the exported shell's
#     specificAssetIds to the API's, and the names, order and semantic ids to what the Nameplate
#     says, with the nameplate empty and with it filled in. It changes the fixture's nameplate for
#     the length of the run and puts it back. A replay lane's empty list is held by the Deno unit
#     tests, since a lane needs a playback to exist.

"""
Tests for `assetInformation.specificAssetIds`, as the two AAS endpoints serve it.

A device's shell lists its serial number (`partInstanceId`), the manufacturer's product URI
(`uriOfTheProduct`) and its Sparkplug id (`sparkplugId`), in that order, each left out when it has
no value. The serial number and the URI are the Nameplate's own, with its semantic ids.
`supabase/functions/_shared/aas/specific_asset_ids_test.ts` holds the rules; this holds that the
deployed functions agree with each other and with the vendored IDTA schema.

Run:  python supabase/functions/aas-export/test_specific_asset_ids.py
"""
import base64
import http.client
import json
import os
import sys
import unittest
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
AAS_SCHEMA_PATH = REPO_ROOT / "test-harness" / "schemas" / "AAS_V3_0_JSON_Schema.json"

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
DEMO_EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
DEMO_PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")
API_BASE = "/functions/v1/aas-api"

# The nameplate elements' IRDIs, as 0002 seeds them and as the Nameplate itself carries them.
SERIAL_NUMBER_IRDI = "0112/2///61987#ABA951#009"
URI_OF_THE_PRODUCT_IRDI = "0112/2///61987#ABN590#002"
STORED_SERIAL = "AAS-NP-0042"
STORED_URI = "https://example.com/aber-conformance/0042"

try:
    from jsonschema import Draft201909Validator
    HAVE_JSONSCHEMA = True
except ImportError:  # pragma: no cover - reported, never silently skipped
    HAVE_JSONSCHEMA = False

sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit


def b64url(value: str) -> str:
    """IDTA-01002 encodes every Identifier in a path this way, unpadded."""
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def request(method: str, path: str, token: str, payload: dict | None = None, headers: dict | None = None):
    """(status, parsed JSON) for one call through the gateway as `token`'s holder; status 0 when it cannot be reached."""
    request_headers = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}", **(headers or {})}
    body = json.dumps(payload).encode() if payload is not None else None
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    gateway = urllib.parse.urlsplit(SUPABASE_URL)
    connect = http.client.HTTPSConnection if gateway.scheme == "https" else http.client.HTTPConnection
    connection = connect(gateway.hostname, gateway.port, timeout=45)
    try:
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        status, raw = response.status, response.read() or b"{}"
    except OSError:
        return 0, {}
    finally:
        connection.close()
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, {"raw": raw.decode(errors="replace")}


def sign_in() -> str | None:
    """A person's session token: aas-export checks the caller's role, aas-api reads as the caller."""
    try:
        status, data = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, DEMO_EMAIL, DEMO_PASSWORD)
    except OSError:
        return None
    return data.get("access_token") if status == 200 and isinstance(data, dict) else None


def provision(token):
    """The fixture device's row, creating it if need be. None when the stack is unreachable."""
    try:
        return aas_fixture.ensure(SUPABASE_URL, token, PUBLISHABLE_KEY)
    except Exception as err:  # noqa: BLE001 -- reported, never silently skipped
        print(f"[test_specific_asset_ids] could not provision the fixture: {err}")
        return None


TOKEN = sign_in()
DEVICE = provision(TOKEN) if TOKEN else None
LIVE = TOKEN is not None and DEVICE is not None
SKIP_REASON = "no reachable stack, or the AAS fixture could not be provisioned"


def set_nameplate(serial_number: str | None, uri_of_the_product: str | None) -> None:
    """The fixture's two identity columns, exactly one row changed. None clears a column."""
    status, rows = request(
        "PATCH",
        f"/rest/v1/device_nameplate?device_id=eq.{aas_fixture.DEVICE_UUID}",
        TOKEN,
        {"serial_number": serial_number, "uri_of_the_product": uri_of_the_product},
        {"Prefer": "return=representation"},
    )
    if status not in (200, 204) or (status == 200 and len(rows) != 1):
        raise AssertionError(f"the fixture's nameplate was not updated ({status}): {rows}")


class Served:
    """One device's shell as aas-export writes it and as aas-api serves it, read together."""

    def __init__(self):
        status, body = request("POST", "/functions/v1/aas-export", TOKEN, {"device_id": DEVICE["id"]})
        assert status == 200, f"aas-export returned {status}: {body}"
        self.exported = body["aas"]
        self.shell = self.exported["assetAdministrationShells"][0]
        path = f"{API_BASE}/shells/{b64url(self.shell['id'])}"
        status, self.api_shell = request("GET", path, TOKEN)
        assert status == 200, f"aas-api returned {status} for the shell: {self.api_shell}"
        status, self.api_information = request("GET", f"{path}/asset-information", TOKEN)
        assert status == 200, f"aas-api returned {status} for asset-information: {self.api_information}"

    def specific_asset_ids(self) -> list:
        return self.shell["assetInformation"].get("specificAssetIds", [])

    def nameplate_value(self, id_short: str):
        nameplate = next(s for s in self.exported["submodels"] if s["idShort"] == "DigitalNameplate")
        element = next((e for e in nameplate["submodelElements"] if e["idShort"] == id_short), None)
        return element.get("value") if element else None


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestSpecificAssetIds(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        # The fixture's own nameplate holds neither, and the other AAS suites read it as it is.
        set_nameplate(None, None)

    def read(self, serial_number: str | None, uri_of_the_product: str | None) -> Served:
        set_nameplate(serial_number, uri_of_the_product)
        return Served()

    def test_the_export_and_the_api_serve_the_same_identifiers(self):
        for serial, uri in ((None, None), (STORED_SERIAL, STORED_URI)):
            with self.subTest(serial=serial, uri=uri):
                served = self.read(serial, uri)
                self.assertTrue(served.specific_asset_ids(), "the shell names no identifier")
                self.assertEqual(served.api_shell["assetInformation"], served.shell["assetInformation"])
                self.assertEqual(served.api_information, served.shell["assetInformation"])

    def test_a_nameplate_with_neither_names_the_published_serial_number_and_the_sparkplug_id(self):
        served = self.read(None, None)
        self.assertEqual(
            [(i["name"], i["value"]) for i in served.specific_asset_ids()],
            [("partInstanceId", aas_fixture.BIRTH_VALUES["SERIAL_NUMBER"][1]),
             ("sparkplugId", DEVICE["sparkplug_id"])],
        )

    def test_a_filled_nameplate_names_all_three_in_order_with_the_nameplates_semantic_ids(self):
        served = self.read(STORED_SERIAL, STORED_URI)
        self.assertEqual(
            served.specific_asset_ids(),
            [
                {"name": "partInstanceId", "value": STORED_SERIAL,
                 "semanticId": {"type": "ExternalReference",
                                "keys": [{"type": "GlobalReference", "value": SERIAL_NUMBER_IRDI}]}},
                {"name": "uriOfTheProduct", "value": STORED_URI,
                 "semanticId": {"type": "ExternalReference",
                                "keys": [{"type": "GlobalReference", "value": URI_OF_THE_PRODUCT_IRDI}]}},
                {"name": "sparkplugId", "value": DEVICE["sparkplug_id"]},
            ],
        )

    def test_the_serial_number_and_the_uri_are_the_ones_the_nameplate_exports(self):
        for serial, uri in ((None, None), (STORED_SERIAL, STORED_URI)):
            with self.subTest(serial=serial, uri=uri):
                served = self.read(serial, uri)
                by_name = {i["name"]: i for i in served.specific_asset_ids()}
                self.assertEqual(by_name["partInstanceId"]["value"], served.nameplate_value("SerialNumber"))
                if "uriOfTheProduct" in by_name:
                    self.assertEqual(by_name["uriOfTheProduct"]["value"],
                                     served.nameplate_value("URIOfTheProduct"))
                else:
                    self.assertIsNone(served.nameplate_value("URIOfTheProduct"))

    def test_the_shells_own_identifiers_do_not_change(self):
        served = self.read(STORED_SERIAL, STORED_URI)
        global_asset_id = served.shell["assetInformation"]["globalAssetId"]
        self.assertTrue(global_asset_id.endswith(DEVICE["sparkplug_id"]), global_asset_id)
        self.assertEqual(served.shell["id"], f"{global_asset_id}/shell")
        self.assertTrue(all(s["id"].startswith(f"{global_asset_id}/submodel/")
                            for s in served.exported["submodels"]))

    @unittest.skipUnless(HAVE_JSONSCHEMA, "jsonschema not installed")
    def test_what_the_api_serves_validates_as_asset_information(self):
        schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        asset_information = {"$schema": schema["$schema"], "definitions": schema["definitions"],
                             "$ref": "#/definitions/AssetInformation"}
        for serial, uri in ((None, None), (STORED_SERIAL, STORED_URI)):
            with self.subTest(serial=serial, uri=uri):
                served = self.read(serial, uri)
                errors = [e.message for e in Draft201909Validator(asset_information)
                          .iter_errors(served.api_information)]
                self.assertEqual(errors, [])


if __name__ == "__main__":
    if not HAVE_JSONSCHEMA:
        print("[test_specific_asset_ids] jsonschema is not installed; schema validation is SKIPPED")
    runner = unittest.main(verbosity=2, exit=False)
    if LIVE:
        aas_fixture.teardown(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    else:
        print(f"[test_specific_asset_ids] live checks skipped: {SKIP_REASON}")
    raise SystemExit(0 if runner.result.wasSuccessful() else 1)
