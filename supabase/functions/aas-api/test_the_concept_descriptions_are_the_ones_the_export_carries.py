# suite:
#   lanes: stack
#   why: aas-api's two ConceptDescription routes against a running stack. For a device of the suite's
#     own, every ConceptDescription its aas-export Environment carries is served the same by
#     /concept-descriptions and by its id, and the listing holds each id once, in id order, across its
#     pages. An id no listed shell references is a 404: nobody's, a catalog metric no schema models, and
#     one only an archived device carries. An imported vocabulary that does not share its definitions
#     keeps its text out of both routes, as out of the export. The Deno tests hand the module a stubbed
#     client, so nothing there shows the deployed function reading the rows as its caller.

"""
aas-api serves the ConceptDescriptions its shells reference, as aas-export's file carries them.

    python supabase/functions/aas-api/test_the_concept_descriptions_are_the_ones_the_export_carries.py

Needs the stack up and the AAS suites' account (AAS_TEST_EMAIL and AAS_TEST_PASSWORD). The account
writes a gateway, two devices, two schemas and four catalog metrics of the suite's own, at pinned ids
and run-unique names, and removes them afterwards. Where its session may not write (a role without the
grant, or a stack that asks for the second factor) the tests skip, saying so. The licence test also
imports a vocabulary, which only an Administrator may: it skips on its own for anyone else. With no
stack, everything skips.
"""
import base64
import datetime
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
import stack_sign_in  # noqa: E402  -- after sys.path, by necessity

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")

API = "/functions/v1/aas-api"

# Pinned, so a run that died is cleaned up by the next. The two devices differ in the first 21 hex
# digits, which make the sparkplug_id.
GATEWAY_UUID = "1d514001-0000-4000-8000-000000000001"
DEVICE_UUID = "2d514001-0000-4000-8000-000000000001"
ARCHIVED_UUID = "2d514002-0000-4000-8000-000000000001"
GATEWAY_NAME = "AAS_CD_Gateway"
DEVICE_NAME = "AAS_CD_Device"
ARCHIVED_NAME = "AAS_CD_Archived_Device"

# Run-unique, so no other device on the stack references these ids. The prefix finds a dead run's rows.
PREFIX = "Test514"
RUN = uuid.uuid4().hex[:8]
BASE = f"https://example.test/aber-514/{RUN}/"
TEMPERATURE_ID = BASE + "Temperature"
GROUP_ID = BASE + "GroupKpi"
SCHEMA_ID = BASE + "PressLine"
ARCHIVED_METRIC_ID = BASE + "OnlyOnAnArchivedDevice"
ARCHIVED_SCHEMA_ID = BASE + "ArchivedLine"
UNMODELLED_ID = BASE + "InTheCatalogOnly"
TEMPERATURE = f"{PREFIX}{RUN}/Temperature"
GROUP = f"{PREFIX}{RUN}/GroupKpi"
ARCHIVED_METRIC = f"{PREFIX}{RUN}/Archived"
UNMODELLED = f"{PREFIX}{RUN}/Unmodelled"
LICENSED_TEXT = "The licensed definition, which stays home until the licence is confirmed."
GROUP_FILE = f"{PREFIX} group naming {RUN}"


def b64url(value):
    """IDTA-01002 encodes every Identifier in a path this way, unpadded as the specification shows."""
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def request(method, path, token, payload=None, headers=None, timeout=60):
    """(status, decoded JSON) for one request to the stack: the URL is split and connected to, not opened."""
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
    except OSError:
        return 0, {}
    finally:
        connection.close()


def call(method, path, token, payload=None, headers=None):
    status, body = request(method, path, token, payload, headers)
    if status >= 400 or status == 0:
        raise AssertionError(f"{method} {path} answered {status}: {str(body)[:300]}")
    return body


def sign_in():
    """A person's session token, not the service key: the function reads as its caller."""
    try:
        status, data = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, EMAIL, PASSWORD)
    except OSError:
        return None
    return data.get("access_token") if status == 200 and isinstance(data, dict) else None


TOKEN = sign_in()
LIVE = TOKEN is not None and bool(PUBLISHABLE_KEY)
SKIP_REASON = "no reachable stack, or no person to sign in as"

REPRESENTATION = {"Prefer": "return=representation"}
UPSERT = {"Prefer": "resolution=merge-duplicates,return=representation"}


def clean_up():
    """Everything a run of this suite wrote, this one's or a dead one's. Best effort, in the order the keys want."""
    status, files = request("GET", f"/rest/v1/site_vocabularies?select=id&name=like.{PREFIX}*", TOKEN)
    for row in files if status == 200 and isinstance(files, list) else []:
        request("POST", "/rest/v1/rpc/remove_site_vocabulary", TOKEN, {"p_id": row["id"]})
    for path in (
        f"/device_submodels?device_id=in.({DEVICE_UUID},{ARCHIVED_UUID})",
        f"/devices?id=in.({DEVICE_UUID},{ARCHIVED_UUID})",
        f"/gateways?id=eq.{GATEWAY_UUID}",
        f"/schemas?schema_name=like.{PREFIX}*",
        f"/metric_catalog?name=like.{PREFIX}*",
    ):
        request("DELETE", f"/rest/v1{path}", TOKEN)


def metric(name, semantic_id, description):
    return {"name": name, "datatype": 10, "semantic_id": semantic_id, "semantic_id_type": "IRI",
            "description": description}


def schema(name, semantic_id, metrics):
    return {"schema_name": name, "description": f"A schema of {PREFIX}'s own.", "status": "active",
            "semantic_id": semantic_id, "semantic_id_type": "IRI",
            "schema_definition": {"type": "object", "properties": {m: {"type": "number"} for m in metrics}}}


class Refused(Exception):
    """A write the account's session may not make: the suite skips rather than fails."""


def write(method, path, payload, headers=None):
    """One write to PostgREST: its body, or Refused where the account's role or second factor stops it."""
    status, body = request(method, f"/rest/v1{path}", TOKEN, payload, headers)
    if status in (401, 403) or (status == 400 and "MFA" in str(body)):
        raise Refused(f"the account's session may not write to {path.split('?')[0]}: {str(body)[:120]}")
    if status >= 400 or status == 0:
        raise AssertionError(f"{method} {path} answered {status}: {str(body)[:300]}")
    return body


def provision():
    """The suite's subject. Returns a reason to skip, or None."""
    try:
        write("POST", "/metric_catalog", metric(TEMPERATURE, TEMPERATURE_ID, "The press's temperature."),
              REPRESENTATION)
        # The group metric's own description is a copy of the licensed text, which neither route may serve.
        write("POST", "/metric_catalog", metric(GROUP, GROUP_ID, LICENSED_TEXT), REPRESENTATION)
        write("POST", "/metric_catalog", metric(ARCHIVED_METRIC, ARCHIVED_METRIC_ID, "Only an archived device's."),
              REPRESENTATION)
        write("POST", "/metric_catalog", metric(UNMODELLED, UNMODELLED_ID, "No schema models it."), REPRESENTATION)

        line = write("POST", "/schemas", schema(f"{PREFIX}_{RUN}_Line", SCHEMA_ID, [TEMPERATURE, GROUP]),
                     REPRESENTATION)[0]
        archived_line = write("POST", "/schemas", schema(f"{PREFIX}_{RUN}_Archived", ARCHIVED_SCHEMA_ID,
                                                         [ARCHIVED_METRIC]), REPRESENTATION)[0]

        write("POST", "/gateways?on_conflict=id", {
            "id": GATEWAY_UUID, "name": GATEWAY_NAME, "status": "ONLINE", "deployment": "host",
        }, UPSERT)
        for device_id, name in ((DEVICE_UUID, DEVICE_NAME), (ARCHIVED_UUID, ARCHIVED_NAME)):
            write("POST", "/devices?on_conflict=id", {
                "id": device_id, "name": name, "gateway_id": GATEWAY_UUID, "status": "OFFLINE",
                "is_quarantined": False,
            }, UPSERT)
        write("POST", "/device_submodels", {"device_id": DEVICE_UUID, "schema_id": line["id"]})
        write("POST", "/device_submodels", {"device_id": ARCHIVED_UUID, "schema_id": archived_line["id"]})
        # Archived as the dashboard archives one, so /shells no longer lists its shell.
        write("PATCH", f"/devices?id=eq.{ARCHIVED_UUID}",
              {"is_archived": True, "archived_at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    except Refused as refused:
        return str(refused)
    return None


def exported():
    """The device's JSON export: its Environment's ConceptDescriptions, by id."""
    environment = call("POST", "/functions/v1/aas-export", TOKEN, {"device_id": DEVICE_UUID})["aas"]
    return {cd["id"]: cd for cd in environment.get("conceptDescriptions", [])}


def api(path):
    return request("GET", f"{API}{path}", TOKEN)


def walk(limit):
    """Every page of /concept-descriptions, following the cursor: the ids in order, the objects by id, the pages."""
    ids, objects, pages, cursor = [], {}, 0, None
    while True:
        query = f"/concept-descriptions?limit={limit}" + (f"&cursor={urllib.parse.quote(cursor, safe='')}" if cursor else "")
        status, body = api(query)
        assert status == 200, f"GET {query} answered {status}: {body}"
        assert len(body["result"]) <= limit, f"a page of limit {limit} held {len(body['result'])}"
        for cd in body["result"]:
            ids.append(cd["id"])
            objects[cd["id"]] = cd
        pages += 1
        cursor = (body.get("paging_metadata") or {}).get("cursor")
        if not cursor or pages > 500:
            return ids, objects, pages


def definition_of(cd):
    return cd["embeddedDataSpecifications"][0]["dataSpecificationContent"]["definition"][0]["text"]


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestTheRoutesServeWhatTheExportCarries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        clean_up()
        cls.skip_reason = provision()

    @classmethod
    def tearDownClass(cls):
        clean_up()

    def setUp(self):
        if self.skip_reason:
            self.skipTest(self.skip_reason)

    def test_the_export_carries_the_ids_the_suite_planted(self):
        # The precondition of every test below: without these, agreement would be vacuous.
        carried = exported()
        for semantic_id in (TEMPERATURE_ID, GROUP_ID, SCHEMA_ID):
            self.assertIn(semantic_id, carried)

    def test_each_one_fetched_by_its_id_is_the_one_the_export_carries(self):
        for semantic_id, cd in exported().items():
            with self.subTest(id=semantic_id):
                status, body = api(f"/concept-descriptions/{b64url(semantic_id)}")
                self.assertEqual(status, 200, body)
                self.assertEqual(body, cd)

    def test_the_listing_holds_each_once_in_id_order_and_as_the_export_carries_it(self):
        carried = exported()
        ids, objects, _ = walk(100)
        self.assertEqual(ids, sorted(set(ids)))
        for semantic_id, cd in carried.items():
            with self.subTest(id=semantic_id):
                self.assertEqual(objects.get(semantic_id), cd)

    def test_a_cursor_walks_the_same_listing_a_few_at_a_time(self):
        whole, _, pages = walk(100)
        if pages > 1:
            self.skipTest(f"the stack's listing is more than one page of 100 ({len(whole)}+ ids)")
        stepped, _, stepped_pages = walk(3)
        self.assertEqual(stepped, whole)
        self.assertGreaterEqual(stepped_pages, 2, "the planted ids alone fill more than one page of 3")

    def test_an_id_no_listed_shell_references_is_a_404(self):
        for semantic_id in ("https://example.test/aber-514/nobody", UNMODELLED_ID, ARCHIVED_METRIC_ID,
                            ARCHIVED_SCHEMA_ID):
            with self.subTest(id=semantic_id):
                status, body = api(f"/concept-descriptions/{b64url(semantic_id)}")
                self.assertEqual(status, 404, body)
                self.assertEqual(body["messages"][0]["messageType"], "Error")
                self.assertEqual(body["messages"][0]["code"], "404")
        _, objects, _ = walk(100)
        for semantic_id in (UNMODELLED_ID, ARCHIVED_METRIC_ID, ARCHIVED_SCHEMA_ID):
            self.assertNotIn(semantic_id, objects)

    def test_an_identifier_that_is_not_base64url_is_a_400(self):
        status, body = api("/concept-descriptions/!!!not-base64!!!")
        self.assertEqual(status, 400, body)

    def test_the_root_names_both_routes(self):
        status, body = api("")
        self.assertEqual(status, 404)
        self.assertIn("/concept-descriptions", body["served"])
        self.assertIn("/concept-descriptions/{cdIdentifier}", body["served"])

    def test_an_unshared_vocabulary_keeps_its_text_out_of_both_routes_as_out_of_the_export(self):
        described = {"name": GROUP_FILE, "source_format": "aas-json", "kind": "site_own",
                     "sha256": hashlib.sha256(f"{RUN}-group".encode()).hexdigest()}
        concepts = [{"semantic_id": GROUP_ID, "semantic_id_type": "IRI", "preferred_name": "Group KPI",
                     "definition": LICENSED_TEXT}]
        status, body = request("POST", "/rest/v1/rpc/import_site_vocabulary", TOKEN,
                               {"p_file": described, "p_concepts": concepts})
        if status != 200:
            self.skipTest(f"the account may not import a vocabulary ({status}): {str(body)[:120]}")
        try:
            carried = exported()[GROUP_ID]
            self.assertEqual(definition_of(carried), f"Group KPI, as {GROUP_FILE} defines it.")
            status, one = api(f"/concept-descriptions/{b64url(GROUP_ID)}")
            self.assertEqual(status, 200, one)
            self.assertEqual(one, carried)
            _, objects, _ = walk(100)
            self.assertEqual(objects.get(GROUP_ID), carried)
            self.assertNotIn(LICENSED_TEXT, json.dumps(one))
            self.assertNotIn(LICENSED_TEXT, json.dumps(objects))
        finally:
            # The other tests compare against an export made without it, whichever order they run in.
            request("POST", "/rest/v1/rpc/remove_site_vocabulary", TOKEN, {"p_id": body["id"]})


if __name__ == "__main__":
    if not LIVE:
        print(f"[test_the_concept_descriptions_are_the_ones_the_export_carries] skipped: {SKIP_REASON}")
    result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result.wasSuccessful() else 1)
