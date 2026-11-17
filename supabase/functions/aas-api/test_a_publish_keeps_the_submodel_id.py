# suite:
#   lanes: stack
#   why: 0298 and the exporter -- that publishing a schema version leaves a device's Submodel id where
#     it was and moves administration.version, in the JSON export and through aas-api; that aas-api
#     answers the id an earlier version's name made, on both submodel routes, with the current
#     Submodel; that a name no version of the device's lineages ever had is still a 404; and that the
#     file carries only the new id. A wrong id here is a third-party AAS server that collects one
#     Submodel per version, or an ERP reading a Submodel that stopped existing at the last publish.

"""
Publishing a schema version keeps a device's Submodel id (0298), against a running stack.

Two layers, as test_aas_api.py has: the offline ones read the source, and the live ones provision
their own gateway, device and schema lineage at pinned ids (never the conformance fixture's, so the
other AAS suites see the device they expect), publish a second version as the Administrator, and
read the shell before and after. Skipped with no reachable stack.

Run:  python supabase/functions/aas-api/test_a_publish_keeps_the_submodel_id.py
"""
import base64
import json
import os
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402
import stack_sign_in  # noqa: E402

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
DEMO_EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
DEMO_PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")

API = f"{SUPABASE_URL}/functions/v1/aas-api"
EXPORT = f"{SUPABASE_URL}/functions/v1/aas-export"

GATEWAY_UUID = "1c000000-0000-4000-8000-000000000298"
DEVICE_UUID = "2c000000-0000-4000-8000-000000000298"
GATEWAY_NAME = "AAS_Lineage_Gateway"
DEVICE_NAME = "AAS_Lineage_Device"
SCHEMA_NAME = "AAS_Lineage_Schema"
METRICS = ["Systems/TEMPERATURE", "OEE/AVAILABILITY"]


def b64url(value):
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def call(method, url, token, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("apikey", PUBLISHABLE_KEY)
    req.add_header("Authorization", f"Bearer {token}")
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            raw = res.read() or b"{}"
            return res.status, json.loads(raw)
    except urllib.error.HTTPError as err:
        raw = err.read() or b"{}"
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"raw": raw.decode(errors="replace")}
    except OSError:
        return 0, {}


def sign_in():
    try:
        status, data = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, DEMO_EMAIL, DEMO_PASSWORD)
    except OSError:
        return None
    return data.get("access_token") if status == 200 and isinstance(data, dict) else None


TOKEN = sign_in()
LIVE = TOKEN is not None and bool(PUBLISHABLE_KEY)
SKIP_REASON = "no reachable stack, or no publishable key to reach it with"


def rest(method, path, payload=None):
    return aas_fixture._request(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY, method, path, payload)


def provision():
    """The gateway, the device and version 1 of a schema, attached. Returns the device row."""
    aas_fixture._upsert(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY, "gateways", {
        "id": GATEWAY_UUID, "name": GATEWAY_NAME, "status": "ONLINE", "deployment": "host",
    }, on_conflict="id")
    device = aas_fixture._upsert(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY, "devices", {
        "id": DEVICE_UUID, "name": DEVICE_NAME, "gateway_id": GATEWAY_UUID,
        "status": "OFFLINE", "is_quarantined": False,
    }, on_conflict="id")[0]
    schema = aas_fixture._upsert(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY, "schemas", {
        "schema_name": SCHEMA_NAME,
        "description": "Subject of the Submodel id suite. Provisioned at runtime.",
        "schema_definition": {
            "type": "object",
            "properties": {m: {"type": "number"} for m in METRICS},
        },
        "status": "active",
    }, on_conflict="schema_name")[0]
    if not rest("GET", f"/device_submodels?device_id=eq.{DEVICE_UUID}&schema_id=eq.{schema['id']}&select=id"):
        rest("POST", "/device_submodels", {"device_id": DEVICE_UUID, "schema_id": schema["id"]})
    return device, schema


def teardown():
    """Best effort, newest version first: a version's parent cannot go before it."""
    for path in (
        f"/device_submodels?device_id=eq.{DEVICE_UUID}",
        f"/devices?id=eq.{DEVICE_UUID}",
        f"/gateways?id=eq.{GATEWAY_UUID}",
    ):
        try:
            rest("DELETE", path)
        except aas_fixture.FixtureError:
            pass
    try:
        versions = rest("GET", f"/schemas?lineage_name=eq.{SCHEMA_NAME}&select=id,version&order=version.desc")
        for row in versions:
            rest("DELETE", f"/schemas?id=eq.{row['id']}")
    except aas_fixture.FixtureError:
        pass


def exported():
    """The device's JSON export: the Environment."""
    status, body = call("POST", EXPORT, TOKEN, {"device_id": DEVICE_UUID})
    assert status == 200, f"export {status}: {body}"
    return body["aas"]


def telemetry(environment):
    found = [s for s in environment["submodels"] if s["id"].endswith("/OperationalTelemetry")]
    assert len(found) == 1, f"expected one OperationalTelemetry Submodel, got {[s['id'] for s in found]}"
    return found[0]


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestPublishingKeepsTheSubmodelId(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        teardown()
        cls.device, cls.v1 = provision()
        cls.before = telemetry(exported())
        status, forked = call("POST", f"{SUPABASE_URL}/rest/v1/rpc/fork_schema", TOKEN,
                              {"parent_schema_id": cls.v1["id"], "change_description": "second"})
        assert status == 200, f"fork_schema {status}: {forked}"
        cls.draft = forked
        # A draft attached beside the version in force is tried before it is published.
        rest("POST", "/device_submodels", {"device_id": DEVICE_UUID, "schema_id": forked["id"]})
        cls.beside = [s["id"] for s in exported()["submodels"] if "/OperationalTelemetry" in s["id"]]
        # Publishing moves the device to the draft and drops the row of the version it replaces.
        status, published = call("POST", f"{SUPABASE_URL}/rest/v1/rpc/publish_schema_version", TOKEN,
                                 {"draft_schema_id": forked["id"]})
        assert status == 200, f"publish_schema_version {status}: {published}"
        cls.environment = exported()
        cls.after = telemetry(cls.environment)

    @classmethod
    def tearDownClass(cls):
        teardown()

    def test_the_id_is_the_lineages_and_survives_the_publish(self):
        self.assertTrue(self.before["id"].endswith(f"/submodel/{SCHEMA_NAME}/OperationalTelemetry"))
        self.assertEqual(self.after["id"], self.before["id"])
        self.assertEqual(self.draft["schema_name"], SCHEMA_NAME + "_v2")
        self.assertEqual(self.draft["lineage_name"], SCHEMA_NAME)
        self.assertEqual(self.draft["lineage_root_id"], self.v1["id"])

    def test_the_version_moves(self):
        self.assertEqual(self.before["administration"], {"version": "1"})
        self.assertEqual(self.after["administration"], {"version": "2"})

    def test_the_kpi_submodel_carries_the_version_too(self):
        kpi = [s for s in self.environment["submodels"] if s["id"].endswith("/KeyPerformanceIndicators")]
        self.assertEqual([s["administration"] for s in kpi], [{"version": "2"}])

    def test_a_draft_beside_the_version_in_force_took_a_qualified_key(self):
        self.assertEqual(
            sorted(i.split("/submodel/")[1] for i in self.beside),
            [f"{SCHEMA_NAME}/OperationalTelemetry", f"{SCHEMA_NAME}_v2/OperationalTelemetry"],
        )

    def test_the_file_carries_the_new_id_only(self):
        text = json.dumps(self.environment)
        self.assertNotIn(f"{SCHEMA_NAME}_v2/", text)

    def test_the_export_says_how_many_keys_clashed(self):
        status, body = call("POST", EXPORT, TOKEN, {"device_id": DEVICE_UUID})
        self.assertEqual(status, 200)
        self.assertEqual(body["stats"]["submodel_key_clashes"], 0)

    def test_aas_api_serves_the_new_id(self):
        status, body = call("GET", f"{API}/submodels/{b64url(self.after['id'])}", TOKEN)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["administration"], {"version": "2"})

    def test_aas_api_serves_the_current_submodel_under_the_old_id(self):
        old = self.after["id"].replace(f"/{SCHEMA_NAME}/", f"/{SCHEMA_NAME}_v2/")
        status, body = call("GET", f"{API}/submodels/{b64url(old)}", TOKEN)
        self.assertEqual(status, 200, body)
        # The current Submodel, which carries the id the files carry.
        self.assertEqual(body["id"], self.after["id"])
        self.assertEqual(body["administration"], {"version": "2"})

    def test_the_route_through_the_shell_serves_the_old_id_too(self):
        shell = self.environment["assetAdministrationShells"][0]
        old = self.after["id"].replace(f"/{SCHEMA_NAME}/", f"/{SCHEMA_NAME}_v2/")
        status, body = call("GET", f"{API}/shells/{b64url(shell['id'])}/submodels/{b64url(old)}", TOKEN)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["id"], self.after["id"])

    def test_a_name_no_version_had_is_still_not_found(self):
        unknown = self.after["id"].replace(f"/{SCHEMA_NAME}/", f"/{SCHEMA_NAME}_v9/")
        status, _ = call("GET", f"{API}/submodels/{b64url(unknown)}", TOKEN)
        self.assertEqual(status, 404)
        # Nor a role the lineage does not make.
        derived = self.after["id"].replace("/OperationalTelemetry", "/DerivedMetrics").replace(
            f"/{SCHEMA_NAME}/", f"/{SCHEMA_NAME}_v2/")
        status, _ = call("GET", f"{API}/submodels/{b64url(derived)}", TOKEN)
        self.assertEqual(status, 404)


class TestSource(unittest.TestCase):
    def test_both_submodel_routes_try_the_old_id_after_the_exact_one(self):
        source = (REPO_ROOT / "supabase" / "functions" / "aas-api" / "index.ts").read_text(encoding="utf-8")
        self.assertEqual(source.count("await submodelIn("), 2)
        self.assertIn('from "../_shared/aas/previousSubmodelIds.ts"', source)


if __name__ == "__main__":
    unittest.main()
