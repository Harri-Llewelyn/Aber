# suite:
#   lanes: stack
#   why: Against a live stack, an export's ConceptDescription names a metric's unit as a reference to a
#     QUDT unit beside the MTConnect name (`unitId`, 0304), and the document still validates against the
#     official IDTA schema. With the unit tables or the unit map missing, the export succeeds and the
#     reference is simply absent, which no other suite would notice.

"""
A ConceptDescription's `unit` and `unitId`, as the deployed exporter writes them.

    python supabase/functions/aas-export/test_aas_export_units_and_sources.py

Needs a stack with the example metrics loaded: the subject is the AAS conformance device
(test-harness/aas_fixture.py), provisioned at pinned ids as the other AAS suites do, and the metric it
exports is `Systems/TEMPERATURE`, whose unit is CELSIUS. Without a reachable stack, or without that
metric, every check skips and says why. It reads and writes nothing in the catalogue.
"""
import http.client
import json
import os
import sys
import unittest
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
AAS_SCHEMA_PATH = REPO_ROOT / "test-harness" / "schemas" / "AAS_V3_0_JSON_Schema.json"
CROSSWALK = REPO_ROOT / "scripts" / "vocabularies" / "mtconnect-units-to-qudt.json"

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
ADMIN_EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
ADMIN_PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")

TEMPERATURE = "Systems/TEMPERATURE"

try:
    from jsonschema import Draft201909Validator
    HAVE_JSONSCHEMA = True
except ImportError:  # pragma: no cover - reported, never silently skipped
    HAVE_JSONSCHEMA = False

sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit


def call(token, method, path, payload=None, timeout=45):
    """One call to the gateway as the signed-in person; (status, parsed body, or the text when it is not JSON)."""
    headers = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = json.dumps(payload).encode() if payload is not None else None
    gateway = urllib.parse.urlsplit(SUPABASE_URL)
    connect = http.client.HTTPSConnection if gateway.scheme == "https" else http.client.HTTPConnection
    connection = connect(gateway.hostname, gateway.port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        status, text = response.status, response.read().decode(errors="replace")
    finally:
        connection.close()
    try:
        return status, json.loads(text) if text else []
    except ValueError:
        return status, {"raw": text[:300]}


def sign_in():
    try:
        status, data = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, ADMIN_EMAIL, ADMIN_PASSWORD)
    except OSError:
        return None
    return data.get("access_token") if status == 200 and isinstance(data, dict) else None


TOKEN = sign_in()
DEVICE = None
METRIC_ROW = None
SKIP_REASON = "no reachable stack"
if TOKEN:
    try:
        DEVICE = aas_fixture.ensure(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    except Exception as err:  # noqa: BLE001 -- reported, never silently skipped
        SKIP_REASON = f"the AAS fixture could not be provisioned: {err}"
    if DEVICE:
        status, rows = call(TOKEN, "GET", f"/rest/v1/metric_catalog?name=eq.{urllib.parse.quote(TEMPERATURE)}"
                                          "&select=semantic_id,units,standard")
        METRIC_ROW = rows[0] if status == 200 and rows else None
        if not METRIC_ROW or not METRIC_ROW.get("semantic_id") or not METRIC_ROW.get("units"):
            SKIP_REASON = f"the catalogue has no {TEMPERATURE} with a semantic id and a unit: load the example metrics"
            METRIC_ROW = None
LIVE = bool(METRIC_ROW)


def walk(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk(item)


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestTheUnitIsExportedAsAQudtUnit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.status, cls.body = call(TOKEN, "POST", "/functions/v1/aas-export", {"device_id": DEVICE["id"]}, timeout=60)
        cls.aas = cls.body.get("aas", {})
        cls.crosswalk = json.loads(CROSSWALK.read_text(encoding="utf-8"))["units"]

    def description_of(self, semantic_id):
        found = [c for c in self.aas.get("conceptDescriptions", []) if c.get("id") == semantic_id]
        self.assertEqual(len(found), 1, f"{semantic_id} has one ConceptDescription, found {len(found)}")
        return found[0]["embeddedDataSpecifications"][0]["dataSpecificationContent"]

    def test_the_export_succeeds(self):
        self.assertEqual(self.status, 200, str(self.body)[:300])

    def test_the_metrics_unit_is_the_mtconnect_name_and_the_qudt_unit_it_maps_to(self):
        entry = self.crosswalk.get(METRIC_ROW["units"])
        if entry is None or not entry["unit"]:
            self.skipTest(f"{METRIC_ROW['units']} maps to no QUDT unit in the crosswalk")
        content = self.description_of(METRIC_ROW["semantic_id"])
        self.assertEqual(content["unit"], METRIC_ROW["units"])
        self.assertEqual(content["unitId"], {
            "type": "ExternalReference",
            "keys": [{"type": "GlobalReference", "value": entry["unit"]}]})

    def test_a_concept_whose_unit_maps_to_none_has_no_unit_reference(self):
        unmapped = {name for name, entry in self.crosswalk.items() if not entry["unit"]}
        checked = 0
        for node in walk(self.aas.get("conceptDescriptions", [])):
            if node.get("modelType") == "DataSpecificationIec61360" and node.get("unit") in unmapped:
                self.assertNotIn("unitId", node)
                checked += 1
        if not checked:
            self.skipTest("no exported concept carries a unit the crosswalk maps to none")

    @unittest.skipUnless(HAVE_JSONSCHEMA, "jsonschema not installed")
    def test_the_export_validates_against_the_official_schema(self):
        schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        errors = list(Draft201909Validator(schema).iter_errors(self.aas))
        detail = "\n".join(
            f"  {'/'.join(str(x) for x in e.absolute_path) or '<root>'}: {e.message[:180]}" for e in errors[:10])
        self.assertEqual(len(errors), 0, f"AAS V3 schema violations:\n{detail}")


if __name__ == "__main__":
    if not LIVE:
        print(f"[test_aas_export_units_and_sources] checks skipped: {SKIP_REASON}")
    # The subject is removed after the report, so a failing run keeps its output. It is the shared
    # fixture, which the other AAS suites also provision and remove.
    result = None
    try:
        result = unittest.main(verbosity=2, exit=False).result
    finally:
        if TOKEN and DEVICE:
            aas_fixture.teardown(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
