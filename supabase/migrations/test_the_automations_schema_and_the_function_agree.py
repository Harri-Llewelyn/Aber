"""
The automations JSON Schema and apply_automations() agree (0256).

    python supabase/migrations/test_the_automations_schema_and_the_function_agree.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one)
and the `jsonschema` package, which the db lane's CI job installs.

WHY. The browser holds a JSON Schema (frontend/public/json-schema/automations.schema.json) that
drives the editor's completion, hover help and inline errors. The database holds the rules
(apply_automations()), because the stack has no pg_jsonschema and the browser is a convenience. Two
statements of one vocabulary drift, and a drift is either an editor that accepts a file the
database refuses, or one that refuses a file the database would have applied.

WHAT IS HELD. Every file under supabase/automations-fixtures/ is one document and one reason:

  * valid/: the schema accepts it, and apply_automations(doc, true) refuses nothing in it.
  * invalid/, with "database": false: the schema refuses it, and the function reports a reason at
    the path the fixture names.
  * invalid/, with "database": true: what only the database can know (a device that is not there or
    is archived, a metric that is not in the catalogue or is not a number, an id used twice). The
    schema accepts it, as it must, and the function reports a reason at the path the fixture names.

The fixtures name the devices and metrics they need as @DEVICE_A@, @METRIC@ and the like, filled in
from rows this suite makes. The schema is also held to its own rules: every field has a description,
and every object is closed.

EVERY TEST ROLLS BACK.
"""
import json
import os
import re
import unittest
from pathlib import Path

import jsonschema
import psycopg2
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO / "frontend" / "public" / "json-schema" / "automations.schema.json"
FIXTURES = REPO / "supabase" / "automations-fixtures"

MANAGER_ID = "a0d17256-0000-4000-8000-0000000256a2"

# Differing in the first block: sparkplug_id is generated from the first 21 hex characters.
DEVICE_A = "a0d17256-1000-4000-8000-000000000001"
DEVICE_B = "b0d17256-1000-4000-8000-000000000002"
DEVICE_ARCHIVED = "c0d17256-1000-4000-8000-000000000003"
DEVICE_MISSING = "d0d17256-1000-4000-8000-000000000004"
METRIC = "Test_0256_Guard/Spindle_Temperature"
METRIC_TEXT = "Test_0256_Guard/Mode"
METRIC_UNKNOWN = "Test_0256_Guard/Nothing_Publishes_This"

PLACEHOLDERS = {
    "@DEVICE_A@": DEVICE_A, "@DEVICE_B@": DEVICE_B, "@DEVICE_ARCHIVED@": DEVICE_ARCHIVED,
    "@DEVICE_MISSING@": DEVICE_MISSING, "@METRIC@": METRIC, "@METRIC_TEXT@": METRIC_TEXT,
    "@METRIC_UNKNOWN@": METRIC_UNKNOWN,
}

# What the vocabulary refuses, each by a fixture of that name. A refusal with no fixture is a refusal
# nothing holds the two statements of to account.
REQUIRED = {
    "invalid": [
        "unknown-automation-key", "unknown-trigger-key", "unknown-action-key", "unknown-trigger-type",
        "unknown-action-type", "above-and-below", "neither-above-nor-below", "severity-unknown",
        "severity-missing", "conditions-are-not-empty", "id-has-capitals", "id-is-too-long",
        "id-missing", "id-used-twice", "device-does-not-exist", "device-is-archived",
        "device-is-not-an-id", "device-is-listed-twice", "metric-is-not-in-the-catalogue",
        "metric-is-not-a-number", "for-is-words", "below-carries-a-unit",
        "enabled-without-a-trigger", "actions-is-empty", "two-actions", "document-is-not-a-list",
    ],
    "valid": ["the-example", "minimal", "a-list-of-devices", "disabled-without-triggers", "conditions-left-empty"],
}


def load_fixtures(kind):
    out = []
    for path in sorted((FIXTURES / kind).glob("*.json")):
        text = path.read_text(encoding="utf-8")
        for token, value in PLACEHOLDERS.items():
            text = text.replace(token, value)
        out.append((path.stem, json.loads(text)))
    return out


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def pointer(error):
    """A schema error's place, as the function writes a path: $[0].triggers[1].above."""
    out = "$"
    for part in error.absolute_path:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out


class Agreement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.validator = jsonschema.Draft202012Validator(cls.schema)

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.apply_automations(jsonb, boolean)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0256 is not applied to this database")
        self.cur.execute("SELECT id FROM public.roles WHERE name = 'Shopfloor_Manager';")
        role = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (MANAGER_ID, "manager@guard.test"))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                         " ON CONFLICT (user_id, role_id) DO NOTHING;", (MANAGER_ID, role))
        for device, name, archived in ((DEVICE_A, "Test_0256_Guard_A", False), (DEVICE_B, "Test_0256_Guard_B", False),
                                       (DEVICE_ARCHIVED, "Test_0256_Guard_Archived", True)):
            self.cur.execute("INSERT INTO public.devices (id, name, is_archived, archived_at) VALUES (%s, %s, %s, %s);",
                             (device, name, archived, "2026-11-01T00:00:00Z" if archived else None))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 10), (%s, 12);",
                         (METRIC, METRIC_TEXT))
        # The Manager's session, as PostgREST hands it to the database.
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": MANAGER_ID, "role": "authenticated", "email": "manager@guard.test"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def preview(self, document):
        self.cur.execute("SELECT public.apply_automations(%s::jsonb, true);", (Json(document),))
        return self.cur.fetchone()[0]

    @staticmethod
    def reasons(results):
        return [(r["path"], r["message"]) for item in results for r in item["reasons"]]

    # -- the fixtures ----------------------------------------------------------------------------

    def test_every_valid_document_is_accepted_by_both(self):
        fixtures = load_fixtures("valid")
        self.assertGreaterEqual(len(fixtures), len(REQUIRED["valid"]))
        for name, fixture in fixtures:
            with self.subTest(fixture=name):
                document = fixture["document"]
                errors = sorted(pointer(e) + ": " + e.message for e in self.validator.iter_errors(document))
                self.assertEqual(errors, [], f"the schema refuses {name}")
                results = self.preview(document)
                self.assertEqual(self.reasons(results), [], f"apply_automations() refuses {name}")
                self.assertEqual([r["status"] for r in results], ["new"] * len(document))

    def test_every_invalid_document_is_refused_by_both_where_the_schema_can_tell(self):
        fixtures = load_fixtures("invalid")
        self.assertGreaterEqual(len(fixtures), len(REQUIRED["invalid"]))
        for name, fixture in fixtures:
            with self.subTest(fixture=name):
                document = fixture["document"]
                errors = list(self.validator.iter_errors(document))
                if fixture["database"]:
                    self.assertEqual([pointer(e) + ": " + e.message for e in errors], [],
                                     f"{name} is the database's to refuse, and the schema refuses it too")
                else:
                    self.assertTrue(errors, f"the schema accepts {name}, which apply_automations() refuses")
                results = self.preview(document)
                paths = [path for path, _ in self.reasons(results)]
                self.assertIn(fixture["path"], paths, f"{name}: the reasons are at {paths}")
                self.assertIn("refused", [r["status"] for r in results])

    def test_a_refusal_carries_a_sentence_and_every_valid_one_carries_none(self):
        for name, fixture in load_fixtures("invalid"):
            for path, message in self.reasons(self.preview(fixture["document"])):
                with self.subTest(fixture=name, path=path):
                    self.assertTrue(path == "$" or re.match(r"^\$\[\d+\]", path), path)
                    self.assertGreater(len(message), 20)
                    # A sentence a person can act on: short ones, as the documentation rule asks.
                    self.assertLessEqual(len(message.split()), 40, message)

    def test_each_refusal_the_vocabulary_makes_has_a_fixture(self):
        for kind in ("invalid", "valid"):
            have = {path.stem for path in (FIXTURES / kind).glob("*.json")}
            for name in REQUIRED[kind]:
                with self.subTest(kind=kind, fixture=name):
                    self.assertIn(name, have)

    def test_a_file_that_applies_nothing_is_not_a_refusal(self):
        self.assertEqual(self.preview([]), [])

    # -- the schema itself -----------------------------------------------------------------------

    def test_the_schema_is_a_valid_draft_2020_12_schema(self):
        jsonschema.Draft202012Validator.check_schema(self.schema)

    def walk(self, node, where):
        """Every schema object that describes a field or a type, with where it is."""
        if isinstance(node, dict):
            yield where, node
            for key, child in node.items():
                if key in ("properties", "$defs"):
                    for name, sub in child.items():
                        yield from self.walk(sub, f"{where}/{key}/{name}")
                elif key == "items":
                    yield from self.walk(child, f"{where}/{key}")
                elif key in ("oneOf", "anyOf", "allOf"):
                    for i, sub in enumerate(child):
                        yield from self.walk(sub, f"{where}/{key}/{i}")

    def test_every_field_and_type_has_a_description(self):
        fields = 0
        for where, node in self.walk(self.schema, "#"):
            if "/properties/" in where or "/$defs/" in where or where == "#":
                if re.search(r"/(oneOf|anyOf|allOf|items)(/\d+)?$", where):
                    continue  # a branch of a field described above it
                fields += 1
                with self.subTest(where=where):
                    self.assertTrue(str(node.get("description", "")).strip(), f"{where} has no description")
        self.assertGreater(fields, 10)

    def test_every_object_is_closed(self):
        closed = 0
        for where, node in self.walk(self.schema, "#"):
            if node.get("type") == "object" or "properties" in node:
                with self.subTest(where=where):
                    self.assertIs(node.get("additionalProperties"), False, f"{where} lets an unknown key through")
                closed += 1
        self.assertGreaterEqual(closed, 3)

    def test_the_schema_names_the_vocabulary_the_database_has(self):
        """The enum and the const values, held to what the tables allow."""
        defs = self.schema["$defs"]
        self.assertEqual(defs["alertAction"]["properties"]["severity"]["enum"], ["critical", "warning", "info"])
        self.cur.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
            " WHERE conname = 'platform_alerts_severity_valid' AND conrelid = 'public.platform_alerts'::regclass;")
        severities = set(re.findall(r"'([a-z]+)'::text", self.cur.fetchone()[0]))
        self.assertEqual(set(defs["alertAction"]["properties"]["severity"]["enum"]), severities)
        self.assertEqual(defs["thresholdTrigger"]["properties"]["trigger"]["const"], "threshold")
        self.assertEqual(defs["alertAction"]["properties"]["action"]["const"], "alert")
        # The id's pattern is the table's.
        self.cur.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
            " WHERE conname = 'automations_key_format' AND conrelid = 'public.automations'::regclass;")
        self.assertIn(defs["automation"]["properties"]["id"]["pattern"], self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
