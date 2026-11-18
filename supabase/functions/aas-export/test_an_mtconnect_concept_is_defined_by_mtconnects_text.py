# suite:
#   lanes: stack
#   why: An MTConnect concept in an AAS export is defined by the text MTConnect publishes (0301).
#     The unit test over shell.ts hands it a fixture with no definitions, so nothing there shows the
#     database serving MTConnect's text, or the deployed exporter reading it.

"""
POSITION, EXECUTION and the rest of the MTConnect data item types are defined in an export by the
vocabulary's own text, not by a metric's description or a sentence naming the concept.

    python supabase/functions/aas-export/test_an_mtconnect_concept_is_defined_by_mtconnects_text.py

Needs the stack up and a person who may export (the AAS suites' account, AAS_TEST_EMAIL and
AAS_TEST_PASSWORD). The export is of the fixture device test-harness/aas_fixture.py provisions, whose
telemetry metrics include Controller/EXECUTION; the fixture is removed afterwards. With no stack the
tests skip.
"""
import http.client
import json
import os
import re
import sys
import unittest
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity
import stack_sign_in  # noqa: E402

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")

MIGRATION = REPO_ROOT / "supabase" / "migrations" / "0301_an_mtconnect_concept_carries_its_own_definition.sql"
MTC = "https://aber.local/semantics/mtconnect/v2.0/DataItemType/"
# The model's markup is gone from every definition, and this is the one the issue quotes.
POSITION_TEXT = "point along an axis in a cartesian coordinate system."


def migration_text(name):
    """The text 0301's generated block gives a data item type, read from the file."""
    match = re.search(r"^  \('" + re.escape(name) + r"', '((?:[^']|'')*)'\),?$",
                      MIGRATION.read_text(encoding="utf-8"), re.M)
    if not match:
        raise AssertionError(f"0301 holds no text for {name}")
    return match.group(1).replace("''", "'")


def sign_in():
    """A user JWT, or None when there is no stack or no such account."""
    try:
        status, data = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, EMAIL, PASSWORD)
    except OSError:
        return None
    return data.get("access_token") if status == 200 and isinstance(data, dict) else None


def call(method, path, token, payload=None, timeout=30):
    """One request to the stack as the signed-in person, answered as its decoded JSON."""
    target = urllib.parse.urlsplit(SUPABASE_URL)
    connect = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
    connection = connect(target.hostname, target.port, timeout=timeout)
    try:
        connection.request(method, path, body=json.dumps(payload) if payload is not None else None,
                           headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}",
                                    "Content-Type": "application/json"})
        response = connection.getresponse()
        raw = response.read()
        if response.status >= 400:
            raise AssertionError(f"{method} {path} answered {response.status}: {raw[:300]!r}")
        return json.loads(raw or b"[]")
    finally:
        connection.close()


def get_json(path, token):
    return call("GET", path, token)


def export_environment(token, device_id):
    return call("POST", "/functions/v1/aas-export", token, {"device_id": device_id}, timeout=60)["aas"]


TOKEN = sign_in()
DEVICE = None
PROVISIONED = False
if TOKEN:
    try:
        DEVICE = aas_fixture.ensure(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
        PROVISIONED = True
    except Exception as err:  # noqa: BLE001 -- reported, never silently skipped
        print(f"[test_an_mtconnect_concept_is_defined_by_mtconnects_text] could not provision the fixture: {err}")
LIVE = TOKEN is not None
SKIP_REASON = "no reachable stack, or no person to sign in as"


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestTheViewServesMtconnectsText(unittest.TestCase):
    def defined(self, semantic_id):
        query = urllib.parse.urlencode({"semantic_id": f"eq.{semantic_id}", "select": "name,definition,standard"})
        return get_json(f"/rest/v1/concept_definitions?{query}", TOKEN)

    def test_position_is_defined_by_mtconnect(self):
        self.assertEqual(self.defined(MTC + "POSITION"),
                         [{"name": "POSITION", "definition": POSITION_TEXT, "standard": "MTConnect"}])

    def test_the_text_is_the_one_the_migration_carries(self):
        for name in ("EXECUTION", "TEMPERATURE"):
            with self.subTest(name=name):
                self.assertEqual([row["definition"] for row in self.defined(MTC + name)],
                                 [migration_text(name)])

    def test_a_type_mtconnect_does_not_document_defines_nothing(self):
        self.assertEqual(self.defined(MTC + "ELEVATION"), [])


@unittest.skipUnless(LIVE and DEVICE, SKIP_REASON)
class TestAnExportDefinesTheConceptByMtconnectsText(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.environment = export_environment(TOKEN, DEVICE["id"])
        cls.concepts = {c["id"]: c for c in cls.environment.get("conceptDescriptions", [])}

    @staticmethod
    def definition(concept):
        content = concept["embeddedDataSpecifications"][0]["dataSpecificationContent"]
        return content["definition"][0]["text"]

    def test_execution_is_defined_by_mtconnect_not_by_a_sentence_naming_it(self):
        concept = self.concepts.get(MTC + "EXECUTION")
        self.assertIsNotNone(concept, "the fixture device's export carries no EXECUTION concept")
        self.assertEqual(self.definition(concept), migration_text("EXECUTION"))
        self.assertNotEqual(self.definition(concept), "EXECUTION, as MTConnect defines it.")

    def test_every_concept_a_vocabulary_defines_is_defined_by_it(self):
        ids = list(self.concepts)
        self.assertTrue(ids)
        query = urllib.parse.urlencode({
            "semantic_id": "in.(" + ",".join('"' + i + '"' for i in ids) + ")",
            "select": "semantic_id,definition"})
        defined = {row["semantic_id"]: row["definition"]
                   for row in get_json(f"/rest/v1/concept_definitions?{query}", TOKEN)}
        self.assertTrue(any(i.startswith(MTC) for i in defined), "no MTConnect concept is defined by the view")
        # IEC 61360 definitions are cut at 1,023 characters, as shell.ts cuts them.
        self.assertEqual({i: self.definition(self.concepts[i]) for i in defined},
                         {i: text[:1023] for i, text in defined.items()})


if __name__ == "__main__":
    if not LIVE:
        print(f"[test_an_mtconnect_concept_is_defined_by_mtconnects_text] skipped: {SKIP_REASON}")
    result = None
    try:
        result = unittest.main(verbosity=2, exit=False).result
    finally:
        # Only what this run provisioned: an AAS_TEST_DEVICE-style subject is nobody's to delete.
        if PROVISIONED:
            aas_fixture.teardown(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
