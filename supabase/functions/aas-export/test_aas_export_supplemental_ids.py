# suite:
#   lanes: stack
#   why: Against a live stack, a metric given further semantic ids exports them: its Property carries
#     them as supplementalSemanticIds beside its own semanticId, each has a ConceptDescription, the
#     document still validates against the official IDTA schema, and a metric with none exports no such
#     key. The ids are added through the REST API as an Administrator and removed afterwards.

"""
A metric's further semantic ids are exported on its Property (0299).

    python supabase/functions/aas-export/test_aas_export_supplemental_ids.py

Needs a stack with the example metrics loaded and an Administrator who can write the catalogue: with
`security.require_mfa_for_managers` on, the sign-in below has no second factor and the write is refused,
which skips the checks and says why. Without a reachable stack every check skips.

The subject is the AAS conformance device (test-harness/aas_fixture.py), provisioned at pinned ids as the
other AAS suites do. The three further ids are added to `Systems/TEMPERATURE` and taken away again at the
end, by id. A metric to which the site has given further ids of its own is left as it is, and the checks skip.
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

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
ADMIN_EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
ADMIN_PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")

METRIC = "Systems/TEMPERATURE"
OTHER_METRIC = "Controller/EXECUTION"
FURTHER = (
    ("0112/2///61987#ABA000#001", "IRDI", "Test: an ECLASS-style identifier"),
    ("nsu=http://example.org/UA/Test/;i=4242", "ExpandedNodeId", "Test: an OPC UA node"),
    ("https://example.org/test/concepts/temperature", "IRI", None),
)

try:
    from jsonschema import Draft201909Validator
    HAVE_JSONSCHEMA = True
except ImportError:  # pragma: no cover - reported, never silently skipped
    HAVE_JSONSCHEMA = False

sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit


def call(token, method, path, payload=None, prefer=None, timeout=45):
    """One call to the gateway as the signed-in person; (status, parsed body, or the text when it is not JSON)."""
    headers = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
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


def rest(token, method, path, payload=None, prefer=None):
    """One PostgREST call; (status, parsed body)."""
    return call(token, method, f"/rest/v1{path}", payload, prefer)


def export(token, device_id):
    return call(token, "POST", "/functions/v1/aas-export", {"device_id": device_id}, timeout=60)


def sign_in():
    try:
        status, data = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, ADMIN_EMAIL, ADMIN_PASSWORD)
    except OSError:
        return None
    return data.get("access_token") if status == 200 and isinstance(data, dict) else None


def remove_further_ids():
    """The suite's own three rows, by id."""
    if not (TOKEN and METRIC_ROW):
        return
    for semantic_id, _, _ in FURTHER:
        rest(TOKEN, "DELETE", f"/metric_semantic_ids?metric_id=eq.{METRIC_ROW['id']}"
                              f"&semantic_id=eq.{urllib.parse.quote(semantic_id, safe='')}")


TOKEN = sign_in()
DEVICE = None
METRIC_ROW = None
SKIP_REASON = "no reachable stack"
FURTHER_ADDED = False
if TOKEN:
    try:
        DEVICE = aas_fixture.ensure(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    except Exception as err:  # noqa: BLE001 -- reported, never silently skipped
        SKIP_REASON = f"the AAS fixture could not be provisioned: {err}"
    if DEVICE:
        status, rows = rest(TOKEN, "GET", f"/metric_catalog?name=eq.{urllib.parse.quote(METRIC)}&select=id,semantic_id")
        METRIC_ROW = rows[0] if status == 200 and rows else None
        if not METRIC_ROW or not METRIC_ROW.get("semantic_id"):
            SKIP_REASON = f"the catalogue has no {METRIC} with a semantic id: load the example metrics"
            METRIC_ROW = None
    if METRIC_ROW:
        # An earlier run that died leaves its rows; the primary key would then refuse these.
        remove_further_ids()
        status, held = rest(TOKEN, "GET", f"/metric_semantic_ids?metric_id=eq.{METRIC_ROW['id']}&select=semantic_id")
        if status != 200 or held:
            SKIP_REASON = (f"{METRIC} holds further semantic ids of the site's own ({len(held)}), which the export would carry too"
                           if status == 200 else f"the further ids of {METRIC} could not be read (HTTP {status}): {held}")
            METRIC_ROW = None
    if METRIC_ROW:
        for semantic_id, semantic_id_type, source in FURTHER:
            status, body = rest(TOKEN, "POST", "/metric_semantic_ids", {
                "metric_id": METRIC_ROW["id"], "semantic_id": semantic_id,
                "semantic_id_type": semantic_id_type, "source": source,
            })
            if status not in (200, 201, 204):
                SKIP_REASON = f"the catalogue refused a further id as this sign-in (HTTP {status}): {body}"
                break
        else:
            FURTHER_ADDED = True
LIVE = FURTHER_ADDED


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestFurtherIdsAreExported(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.status, cls.body = export(TOKEN, DEVICE["id"])
        cls.aas = cls.body.get("aas", {})

    @staticmethod
    def walk(node):
        if isinstance(node, dict):
            yield node
            for value in node.values():
                yield from TestFurtherIdsAreExported.walk(value)
        elif isinstance(node, list):
            for item in node:
                yield from TestFurtherIdsAreExported.walk(item)

    def element_named(self, id_short):
        found = [n for n in self.walk(self.aas.get("submodels", []))
                 if n.get("modelType") == "Property" and n.get("idShort") == id_short]
        self.assertEqual(len(found), 1, f"{id_short} is in the export once, found {len(found)}")
        return found[0]

    @staticmethod
    def values(references):
        return [key["value"] for reference in references for key in reference["keys"]]

    def test_the_export_succeeds(self):
        self.assertEqual(self.status, 200, str(self.body)[:300])

    def test_the_property_carries_each_further_id_beside_its_own(self):
        element = self.element_named("Systems_TEMPERATURE")
        self.assertEqual(self.values([element["semanticId"]]), [METRIC_ROW["semantic_id"]])
        further = element["supplementalSemanticIds"]
        self.assertEqual(sorted(self.values(further)), sorted(semantic_id for semantic_id, _, _ in FURTHER))
        for reference in further:
            self.assertEqual(reference["type"], "ExternalReference")
            self.assertEqual([key["type"] for key in reference["keys"]], ["GlobalReference"])

    def test_a_metric_given_none_exports_no_such_key(self):
        self.assertNotIn("supplementalSemanticIds", self.element_named(OTHER_METRIC.replace("/", "_")))

    def test_each_further_id_has_a_concept_description(self):
        described = {c["id"] for c in self.aas.get("conceptDescriptions", [])}
        for semantic_id, _, _ in FURTHER:
            self.assertIn(semantic_id, described)

    @unittest.skipUnless(HAVE_JSONSCHEMA, "jsonschema not installed")
    def test_the_export_validates_against_the_official_schema(self):
        schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        errors = list(Draft201909Validator(schema).iter_errors(self.aas))
        detail = "\n".join(
            f"  {'/'.join(str(x) for x in e.absolute_path) or '<root>'}: {e.message[:180]}" for e in errors[:10])
        self.assertEqual(len(errors), 0, f"AAS V3 schema violations:\n{detail}")

    def test_after_the_ids_are_removed_the_export_carries_none(self):
        remove_further_ids()
        status, body = export(TOKEN, DEVICE["id"])
        self.assertEqual(status, 200, str(body)[:300])
        elements = [n for n in self.walk(body.get("aas", {}).get("submodels", []))
                    if n.get("modelType") == "Property" and n.get("idShort") == "Systems_TEMPERATURE"]
        self.assertEqual(len(elements), 1)
        self.assertNotIn("supplementalSemanticIds", elements[0])


if __name__ == "__main__":
    if not LIVE:
        print(f"[test_aas_export_supplemental_ids] checks skipped: {SKIP_REASON}")
    # The rows and the subject are removed after the report, so a failing run keeps its output. The
    # subject is the shared fixture, which the other AAS suites also provision and remove.
    result = None
    try:
        result = unittest.main(verbosity=2, exit=False).result
    finally:
        remove_further_ids()
        if TOKEN and DEVICE:
            aas_fixture.teardown(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
