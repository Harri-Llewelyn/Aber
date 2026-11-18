# suite:
#   lanes: stack
#   why: An id an imported site vocabulary holds is named by the file in an AAS export, and its
#     definition is the file's text only once an Administrator shares it (0306). The unit tests over
#     shell.ts hand it fixtures, so nothing there shows the deployed exporter reading the site tables
#     under the caller's row security, or the licensed text staying out of an export it should not reach.

"""
An imported vocabulary decides what an export says of its ids.

    python supabase/functions/aas-export/test_a_site_vocabulary_decides_what_an_export_says_of_its_ids.py

Needs the stack up and the AAS suites' account (AAS_TEST_EMAIL and AAS_TEST_PASSWORD), which must be an
Administrator whose session may write while the second factor is off (security.require_mfa_for_managers).
Where the stack asks for the second factor the writes are refused, and the tests skip, saying so: a script
cannot give a code. With no stack they skip too.

The subject is the fixture device test-harness/aas_fixture.py provisions, with a schema and two catalog
metrics of this suite's own beside it. Each test imports a vocabulary, exports the device and reads the
ConceptDescription of the id the metrics carry: with the definitions unshared (the file's preferred name,
a definition that defers to the file, and never the catalog's description), shared (the file's text),
for a published standard (a metric started from it is filed under KeyPerformanceIndicators) and after the
vocabulary is removed (the catalog's description again). Everything the run wrote is removed afterwards.
"""
import hashlib
import http.client
import json
import os
import sys
import unittest
import urllib.parse
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity
import stack_sign_in  # noqa: E402

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")

RUN = uuid.uuid4().hex[:8]
GROUP_ID = f"https://example.test/aber-808/{RUN}/GroupKpi"
ISO_ID = f"https://example.test/aber-808/{RUN}/IsoKpi"
GROUP_METRIC = f"Test808{RUN}/GroupKpi"
ISO_METRIC = f"Test808{RUN}/IsoKpi"
SCHEMA_NAME = f"Test808_{RUN}"
CATALOG_TEXT = "The catalog's own description, which must stay out of an export while a file holds the id."
LICENSED_TEXT = "The licensed definition, which stays home until the licence is confirmed."
GROUP_FILE = f"Group naming {RUN}"
ISO_FILE = f"ISO 22400 KPIs {RUN}"


def sha(label):
    return hashlib.sha256(f"{RUN}-{label}".encode()).hexdigest()


def sign_in():
    """A user JWT, or None when there is no stack or no such account."""
    try:
        status, data = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, EMAIL, PASSWORD)
    except OSError:
        return None
    return data.get("access_token") if status == 200 and isinstance(data, dict) else None


def request(method, path, token, payload=None, headers=None, timeout=60):
    """One request to the stack as the signed-in person: (status, decoded JSON)."""
    target = urllib.parse.urlsplit(SUPABASE_URL)
    connect = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
    connection = connect(target.hostname, target.port, timeout=timeout)
    try:
        sent = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        sent.update(headers or {})
        connection.request(method, path, body=json.dumps(payload) if payload is not None else None, headers=sent)
        response = connection.getresponse()
        raw = response.read()
        try:
            return response.status, json.loads(raw or b"null")
        except json.JSONDecodeError:
            return response.status, {"raw": raw.decode(errors="replace")}
    finally:
        connection.close()


def call(method, path, token, payload=None, headers=None):
    status, body = request(method, path, token, payload, headers)
    if status >= 400:
        raise AssertionError(f"{method} {path} answered {status}: {str(body)[:300]}")
    return body


TOKEN = sign_in()
DEVICE = None
PROVISIONED = False
if TOKEN:
    try:
        DEVICE = aas_fixture.ensure(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
        PROVISIONED = True
    except Exception as err:  # noqa: BLE001 -- reported, never silently skipped
        print(f"[test_a_site_vocabulary_decides_what_an_export_says_of_its_ids] could not provision the fixture: {err}")
LIVE = TOKEN is not None and DEVICE is not None
SKIP_REASON = "no reachable stack, or no person to sign in as"


class Vocabularies:
    """What this run wrote, so it can all be removed."""
    imported = []
    metrics = []
    schema_id = None
    iso_metric = None
    attached = False


def rpc(name, payload):
    return call("POST", f"/rest/v1/rpc/{name}", TOKEN, payload)


def import_vocabulary(label, kind, concepts, **file):
    described = {"name": file.pop("name"), "source_format": "aas-json", "kind": kind, "sha256": sha(label), **file}
    result = rpc("import_site_vocabulary", {"p_file": described, "p_concepts": concepts})
    Vocabularies.imported.append(result["id"])
    return result


def concept(semantic_id, name, definition):
    return {"semantic_id": semantic_id, "semantic_id_type": "IRI", "preferred_name": name, "definition": definition,
            "data_type": "REAL_MEASURE"}


def export_environment():
    return call("POST", "/functions/v1/aas-export", TOKEN, {"device_id": DEVICE["id"]})["aas"]


def description_of(environment, semantic_id):
    """The IEC 61360 content of the ConceptDescription of an id, or None."""
    for cd in environment.get("conceptDescriptions", []):
        if cd["id"] == semantic_id:
            content = cd["embeddedDataSpecifications"][0]["dataSpecificationContent"]
            return {"name": content["preferredName"][0]["text"], "definition": content["definition"][0]["text"]}
    return None


def element_names(environment, submodel_suffix):
    names = []
    for submodel in environment.get("submodels", []):
        if submodel["idShort"].endswith(submodel_suffix):
            for element in submodel.get("submodelElements", []):
                names.extend([element["idShort"]] + [v["idShort"] for v in element.get("value", []) if isinstance(v, dict)])
    return names


def provision():
    """The two metrics, a schema that models them and its attachment to the fixture device. Returns a reason
    to skip, or None."""
    status, body = request("POST", "/rest/v1/metric_catalog", TOKEN,
                           {"name": GROUP_METRIC, "datatype": 10, "semantic_id": GROUP_ID, "semantic_id_type": "IRI",
                            "description": CATALOG_TEXT},
                           {"Prefer": "return=representation"})
    if status == 403 or (status == 400 and "MFA" in str(body)):
        return f"the account's session may not write: {str(body)[:120]}"
    if status >= 400:
        raise AssertionError(f"POST metric_catalog answered {status}: {body}")
    Vocabularies.metrics.append(body[0]["id"])
    # The second metric, which a published standard's file takes over once that file is imported.
    iso = call("POST", "/rest/v1/metric_catalog", TOKEN,
               {"name": ISO_METRIC, "datatype": 10, "semantic_id": ISO_ID, "semantic_id_type": "IRI", "description": CATALOG_TEXT},
               {"Prefer": "return=representation"})
    Vocabularies.metrics.append(iso[0]["id"])
    Vocabularies.iso_metric = iso[0]["id"]
    schema = call("POST", "/rest/v1/schemas", TOKEN, {
        "schema_name": SCHEMA_NAME, "description": "A suite's own", "status": "active",
        "schema_definition": {"type": "object", "required": [GROUP_METRIC, ISO_METRIC],
                              "properties": {GROUP_METRIC: {"type": "number"}, ISO_METRIC: {"type": "number"}}},
    }, {"Prefer": "return=representation"})
    Vocabularies.schema_id = schema[0]["id"]
    return None


def link_iso_metric(vocabulary_id):
    """The second metric, started from the published standard's file: it links to it, with no standard."""
    call("PATCH", f"/rest/v1/metric_catalog?id=eq.{Vocabularies.iso_metric}", TOKEN, {"site_vocabulary_id": vocabulary_id})


def clean_up():
    """Best effort, in the order the foreign keys want. A failure here does not fail a suite that passed."""
    for vocabulary in Vocabularies.imported:
        request("POST", "/rest/v1/rpc/remove_site_vocabulary", TOKEN, {"p_id": vocabulary})
    if Vocabularies.attached:
        request("DELETE", f"/rest/v1/device_submodels?device_id=eq.{DEVICE['id']}&schema_id=eq.{Vocabularies.schema_id}", TOKEN)
    if Vocabularies.schema_id:
        request("DELETE", f"/rest/v1/schemas?id=eq.{Vocabularies.schema_id}", TOKEN)
    for metric in Vocabularies.metrics:
        request("DELETE", f"/rest/v1/metric_catalog?id=eq.{metric}", TOKEN)


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestAnExportReadsTheSiteVocabulary(unittest.TestCase):
    """In order: each test leaves what the next one starts from, as an Administrator's steps would."""

    @classmethod
    def setUpClass(cls):
        cls.skip_reason = provision()
        if cls.skip_reason is None:
            cls.group = import_vocabulary("group", "site_own", [concept(GROUP_ID, "Group KPI", LICENSED_TEXT)], name=GROUP_FILE)
            # The metric the id's definition is read for must be on the device before it is exported.
            call("POST", "/rest/v1/device_submodels", TOKEN, {"device_id": DEVICE["id"], "schema_id": Vocabularies.schema_id})
            Vocabularies.attached = True

    @classmethod
    def tearDownClass(cls):
        clean_up()

    def setUp(self):
        if self.skip_reason:
            self.skipTest(self.skip_reason)

    def test_1_an_unshared_vocabulary_names_the_concept_and_defers_its_definition_to_the_file(self):
        environment = export_environment()
        described = description_of(environment, GROUP_ID)
        self.assertEqual(described, {"name": "Group KPI", "definition": f"Group KPI, as {GROUP_FILE} defines it."})
        # Neither the licensed text nor the catalog's description reaches the export for this id.
        self.assertNotIn(LICENSED_TEXT, json.dumps(environment))
        self.assertNotEqual(described["definition"], CATALOG_TEXT)

    def test_2_the_catalogs_description_never_stands_in_for_the_licensed_text(self):
        # The metric's description is a copy of the licensed text: neither its ConceptDescription nor
        # its own element may carry it. Put back whatever happens, so the later tests read CATALOG_TEXT.
        call("PATCH", f"/rest/v1/metric_catalog?name=eq.{urllib.parse.quote(GROUP_METRIC)}", TOKEN, {"description": LICENSED_TEXT})
        try:
            self.assertNotIn(LICENSED_TEXT, json.dumps(export_environment()))
        finally:
            call("PATCH", f"/rest/v1/metric_catalog?name=eq.{urllib.parse.quote(GROUP_METRIC)}", TOKEN, {"description": CATALOG_TEXT})

    def test_3_once_the_licence_is_confirmed_the_export_carries_the_files_text(self):
        rpc("set_site_vocabulary_sharing", {"p_id": self.group["id"], "p_shareable": True})
        self.assertEqual(description_of(export_environment(), GROUP_ID), {"name": "Group KPI", "definition": LICENSED_TEXT})
        rpc("set_site_vocabulary_sharing", {"p_id": self.group["id"], "p_shareable": False})
        self.assertEqual(description_of(export_environment(), GROUP_ID)["definition"], f"Group KPI, as {GROUP_FILE} defines it.")

    def test_4_a_metric_started_from_a_published_standard_is_a_kpi_and_cites_the_standard(self):
        iso = import_vocabulary("iso", "published_standard", [concept(ISO_ID, "Overall equipment effectiveness", LICENSED_TEXT)],
                                name=ISO_FILE, standard_name="ISO 22400-2", standard_edition="2014", standard_publisher="ISO")
        link_iso_metric(iso["id"])
        environment = export_environment()
        self.assertIn(ISO_METRIC.replace("/", "_"), element_names(environment, "KeyPerformanceIndicators"))
        self.assertNotIn(GROUP_METRIC.replace("/", "_"), element_names(environment, "KeyPerformanceIndicators"))
        self.assertEqual(description_of(environment, ISO_ID),
                         {"name": "Overall equipment effectiveness",
                          "definition": "Overall equipment effectiveness, as ISO 22400-2:2014 defines it."})

    def test_5_removing_the_vocabulary_returns_the_id_to_the_catalogs_description(self):
        removed = rpc("remove_site_vocabulary", {"p_id": self.group["id"]})
        self.assertEqual(removed["concepts"], 1)
        Vocabularies.imported.remove(self.group["id"])
        self.assertEqual(description_of(export_environment(), GROUP_ID)["definition"], CATALOG_TEXT)


if __name__ == "__main__":
    if not LIVE:
        print(f"[test_a_site_vocabulary_decides_what_an_export_says_of_its_ids] skipped: {SKIP_REASON}")
    result = None
    try:
        result = unittest.main(verbosity=2, exit=False).result
    finally:
        # Only what this run provisioned: an AAS_TEST_DEVICE-style subject is nobody's to delete.
        if PROVISIONED:
            aas_fixture.teardown(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
