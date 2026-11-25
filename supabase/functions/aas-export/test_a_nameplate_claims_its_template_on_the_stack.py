# suite:
#   lanes: stack
#   why: A device's nameplate names its IDTA template once every mandatory element has a value, and the
#     deployed functions must agree on it: the JSON export, the AASX package in both serialisations and
#     aas-api. They read the template's rows from the database as two different callers, so a row that
#     one of them cannot read is a claim in one answer and none in another, and both answer 200. Against
#     the AAS fixture device, whose nameplate it fills in, changes and puts back.

"""
A nameplate claims its template, on the deployed stack.

The AAS fixture device's nameplate has no product URI, order code or address. This suite fills them in,
reads the claim from every endpoint, then takes one mandatory value away and reads that there is none.
The rule itself is held by `_shared/aas/nameplate_claim_test.ts`, and the documents' validity by
`test_a_complete_nameplate_names_its_template.py`.

Run:  python supabase/functions/aas-export/test_a_nameplate_claims_its_template_on_the_stack.py
"""
import base64
import http.client
import io
import json
import os
import sys
import unittest
import urllib.parse
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
DEMO_EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
DEMO_PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")
API = "/functions/v1/aas-api"

sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit

NAMEPLATE = "https://admin-shell.io/idta/nameplate/3/0/Nameplate"
STREET = "0173-1#02-AAO128#002"
# What the fixture's own nameplate lacks, the optional state with it.
FILLED = {
    "uri_of_the_product": "https://example.com/aber-conformance/0485",
    "order_code_of_manufacturer": "ABER-0485",
    "address_street": "1 Example Road",
    "address_zipcode": "SA1 8EN",
    "address_city_town": "Swansea",
    "address_state_county": "West Glamorgan",
    "address_national_code": "GB",
}


def b64url(value: str) -> str:
    """IDTA-01002 encodes every Identifier in a path this way, unpadded."""
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def request(method, path, token, payload=None, headers=None):
    """(status, body bytes) for one call through the gateway as `token`'s holder; status 0 when unreachable."""
    sent = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}", **(headers or {})}
    body = json.dumps(payload).encode() if payload is not None else None
    if body is not None:
        sent["Content-Type"] = "application/json"
    gateway = urllib.parse.urlsplit(SUPABASE_URL)
    connect = http.client.HTTPSConnection if gateway.scheme == "https" else http.client.HTTPConnection
    connection = connect(gateway.hostname, gateway.port, timeout=45)
    try:
        connection.request(method, path, body=body, headers=sent)
        response = connection.getresponse()
        return response.status, response.read()
    except OSError:
        return 0, b""
    finally:
        connection.close()


def get_json(path, token):
    status, raw = request("GET", path, token)
    return status, json.loads(raw or b"{}")


def sign_in():
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
        print(f"[test_a_nameplate_claims_its_template_on_the_stack] could not provision the fixture: {err}")
        return None


TOKEN = sign_in()
DEVICE = provision(TOKEN) if TOKEN else None
LIVE = TOKEN is not None and DEVICE is not None
SKIP_REASON = "no reachable stack, or the AAS fixture could not be provisioned"


def set_nameplate(values):
    """The fixture's nameplate columns, exactly one row changed. None clears a column."""
    status, raw = request("PATCH", f"/rest/v1/device_nameplate?device_id=eq.{aas_fixture.DEVICE_UUID}", TOKEN,
                          values, {"Prefer": "return=representation"})
    if status != 200 or len(json.loads(raw)) != 1:
        raise AssertionError(f"the fixture's nameplate was not updated ({status}): {raw[:300]!r}")


def id_of(element):
    keys = element.get("semanticId", {}).get("keys", [])
    return keys[0]["value"] if keys else None


class Served:
    """One device's nameplate as each endpoint serves it, read together."""

    def __init__(self):
        status, raw = request("POST", "/functions/v1/aas-export", TOKEN, {"device_id": DEVICE["id"]})
        assert status == 200, f"aas-export returned {status}: {raw[:300]!r}"
        body = json.loads(raw)
        self.stats, self.exported = body["stats"], body["aas"]
        self.nameplate = next(s for s in self.exported["submodels"] if s["idShort"] == "DigitalNameplate")
        self.id = self.nameplate["id"]
        status, self.from_api = get_json(f"{API}/submodels/{b64url(self.id)}", TOKEN)
        assert status == 200, f"aas-api returned {status}: {self.from_api}"

    def element(self, id_short, within=None):
        return next(e for e in (within or self.nameplate["submodelElements"]) if e["idShort"] == id_short)


def package(query):
    status, raw = request("POST", f"/functions/v1/aas-export?{query}", TOKEN, {"device_id": DEVICE["id"]})
    assert status == 200, f"aas-export?{query} returned {status}: {raw[:300]!r}"
    return zipfile.ZipFile(io.BytesIO(raw))


class NameplateCase(unittest.TestCase):
    """One state of the fixture's nameplate, read once. Subclasses say which."""

    values: dict = {}

    @classmethod
    def setUpClass(cls):
        # The other AAS suites read the fixture's nameplate as it is. Registered before the change it undoes.
        cls.addClassCleanup(set_nameplate, dict.fromkeys(FILLED))
        set_nameplate({**FILLED, **cls.values})
        cls.served = Served()


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestACompleteNameplate(NameplateCase):
    def test_the_export_names_the_template_and_its_stats_count_it(self):
        self.assertEqual(id_of(self.served.nameplate), NAMEPLATE)
        self.assertEqual((self.served.stats["claimed_templates"], self.served.stats["nameplate_missing_elements"]), (1, 0))

    def test_aas_api_serves_the_same_submodel(self):
        """Read as the caller, where the export reads as the service role: the template's rows must be both's."""
        self.assertEqual(self.served.from_api, self.served.nameplate)

    def test_both_packages_carry_the_claim(self):
        environment = json.loads(package("format=aasx").read("aasx/aasenv-root.json"))
        packaged = next(s for s in environment["submodels"] if s["id"] == self.served.id)
        self.assertEqual(packaged, self.served.nameplate)
        self.assertIn(f"<value>{NAMEPLATE}</value>",
                      package("format=aasx&serialization=xml").read("aasx/data.xml").decode("utf-8"))

    def test_each_element_has_its_template_s_type(self):
        kinds = {e["idShort"]: (e["modelType"], e.get("valueType")) for e in self.served.nameplate["submodelElements"]}
        self.assertEqual(kinds["ManufacturerName"], ("MultiLanguageProperty", None))
        self.assertEqual(kinds["ManufacturerProductDesignation"], ("MultiLanguageProperty", None))
        self.assertEqual(kinds["URIOfTheProduct"], ("Property", "xs:anyURI"))
        self.assertEqual(kinds["OrderCodeOfManufacturer"], ("Property", "xs:string"))
        self.assertEqual(kinds["AddressInformation"], ("SubmodelElementCollection", None))

    def test_the_address_is_the_one_recorded_with_its_ids(self):
        address = self.served.element("AddressInformation")["value"]
        self.assertEqual(
            {e["idShort"]: e["value"][0]["text"] for e in address},
            {"Street": FILLED["address_street"], "Zipcode": FILLED["address_zipcode"],
             "CityTown": FILLED["address_city_town"], "StateCounty": FILLED["address_state_county"],
             "NationalCode": FILLED["address_national_code"]})
        self.assertEqual(id_of(self.served.element("Street", address)), STREET)

    def test_a_dotted_path_and_the_value_form_reach_into_the_address(self):
        base = f"{API}/submodels/{b64url(self.served.id)}"
        status, street = get_json(f"{base}/submodel-elements/AddressInformation.Street", TOKEN)
        self.assertEqual((status, street["modelType"]), (200, "MultiLanguageProperty"))
        status, value = get_json(f"{base}/submodel-elements/AddressInformation.Street/$value", TOKEN)
        self.assertEqual((status, value), (200, [{"en": FILLED["address_street"]}]))
        status, values = get_json(f"{base}/$value", TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(values["AddressInformation"]["CityTown"], [{"en": FILLED["address_city_town"]}])
        self.assertEqual(values["OrderCodeOfManufacturer"], FILLED["order_code_of_manufacturer"])

    def test_every_id_it_carries_resolves(self):
        for identifier in (NAMEPLATE, STREET):
            with self.subTest(identifier):
                status, described = get_json(f"{API}/concept-descriptions/{b64url(identifier)}", TOKEN)
                self.assertEqual((status, described.get("id")), (200, identifier))

    def test_it_holds_no_element_of_the_platform_s(self):
        held = {e["idShort"] for e in self.served.nameplate["submodelElements"]}
        self.assertEqual(held & {"AssetSparkplugId", "EdgeGatewayName", "EdgeGatewaySparkplugId"}, set())


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestANameplateThatLacksOneElement(NameplateCase):
    values = {"address_national_code": None}

    def test_neither_endpoint_names_the_template(self):
        self.assertNotIn("semanticId", self.served.nameplate)
        self.assertEqual(self.served.from_api, self.served.nameplate)
        self.assertEqual((self.served.stats["claimed_templates"], self.served.stats["nameplate_missing_elements"]), (0, 1))

    def test_the_rest_of_the_address_is_still_exported(self):
        self.assertEqual({e["idShort"] for e in self.served.element("AddressInformation")["value"]},
                         {"Street", "Zipcode", "CityTown", "StateCounty"})


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestThePlatformsOwnSubmodel(NameplateCase):
    def test_the_export_and_aas_api_serve_how_the_platform_reaches_the_asset(self):
        platform = next(s for s in self.served.exported["submodels"] if s["idShort"] == "PlatformConnection")
        self.assertNotIn("semanticId", platform)
        self.assertEqual({e["idShort"]: e.get("value") for e in platform["submodelElements"]},
                         {"AssetSparkplugId": DEVICE["sparkplug_id"], "EdgeGatewayName": aas_fixture.GATEWAY_NAME,
                          "EdgeGatewaySparkplugId": "gwy" + aas_fixture.GATEWAY_UUID.replace("-", "")[:21]})
        status, served = get_json(f"{API}/submodels/{b64url(platform['id'])}", TOKEN)
        self.assertEqual((status, served), (200, platform))
        self.assertTrue(platform["id"].endswith(f"{DEVICE['sparkplug_id']}/submodel/PlatformConnection"), platform["id"])


if __name__ == "__main__":
    runner = unittest.main(verbosity=2, exit=False)
    if LIVE:
        aas_fixture.teardown(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    else:
        print(f"[test_a_nameplate_claims_its_template_on_the_stack] live checks skipped: {SKIP_REASON}")
    raise SystemExit(0 if runner.result.wasSuccessful() else 1)
