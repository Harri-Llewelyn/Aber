# suite:
#   lanes: db
#   why: 0295 -- every fixture in supabase/device-schemas-fixtures/ through the JSON Schema the
#     dashboard serves (jsonschema) and through apply_device_schemas(..., true): both accept each
#     valid one, both refuse each invalid one, or the schema accepts what only the database can know.
#     Every field of the schema is described and every object closed.

"""
The device schemas JSON Schema and apply_device_schemas() agree (0295).

    python supabase/migrations/test_the_device_schemas_json_schema_and_the_function_agree.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one)
and the `jsonschema` package, which the db lane's CI job installs.

WHY. The browser holds a JSON Schema (frontend/public/json-schema/device-schemas.schema.json) that
drives the editor's completion, hover help and inline errors. The database holds the rules
(apply_device_schemas()), because the stack has no pg_jsonschema and the browser is a convenience.
Two statements of one vocabulary drift, and a drift is either an editor that accepts a file the
database refuses, or one that refuses a file the database would have applied.

WHAT IS HELD. Every file under supabase/device-schemas-fixtures/ is one document and one reason:

  * valid/: the schema accepts it, and apply_device_schemas(doc, true) refuses nothing in it.
  * invalid/, with "database": false: the schema refuses it, and the function reports a reason at
    the path the fixture names.
  * invalid/, with "database": true: what only the database can know (a metric that is not in the
    catalogue, a derived one, a range on a metric that is not a number, a derived metric whose input
    the schema does not list, a name used twice). The schema accepts it, as it must, and the function reports a reason at the path the fixture names.

The fixtures name the metrics they need as @METRIC_NUMBER@ and the like, and a long text as @X121@
(121 characters), filled in from rows this suite makes. The schema is also held to its own rules:
every field has a description, and every object is closed.

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
SCHEMA_PATH = REPO / "frontend" / "public" / "json-schema" / "device-schemas.schema.json"
FIXTURES = REPO / "supabase" / "device-schemas-fixtures"

ADMIN_ID = "a0d17295-0000-4000-8000-0000000295b1"

METRIC_NUMBER = "Test_0295_Guard/Spindle_Load"
METRIC_NUMBER_2 = "Test_0295_Guard/Bearing_Temperature"
METRIC_TEXT = "Test_0295_Guard/Mode"
METRIC_BOOL = "Test_0295_Guard/Door_Open"
METRIC_DERIVED = "Test_0295_Guard/Parts_Per_Hour"
METRIC_DERIVED_OLD = "Test_0295_Guard/Parts_Per_Hour_Old"
METRIC_DERIVED_STATE = "Test_0295_Guard/Automatic"
METRIC_DEPRECATED = "Test_0295_Guard/Old_Gauge"
METRIC_UNKNOWN = "Test_0295_Guard/Nothing_Publishes_This"
SEMANTIC_ID = "https://example.test/0295/guard/spindle-load"

PLACEHOLDERS = {
    "@METRIC_NUMBER@": METRIC_NUMBER, "@METRIC_NUMBER_2@": METRIC_NUMBER_2, "@METRIC_TEXT@": METRIC_TEXT,
    "@METRIC_BOOL@": METRIC_BOOL, "@METRIC_DERIVED@": METRIC_DERIVED, "@METRIC_DEPRECATED@": METRIC_DEPRECATED,
    "@METRIC_DERIVED_OLD@": METRIC_DERIVED_OLD, "@METRIC_DERIVED_STATE@": METRIC_DERIVED_STATE,
    "@METRIC_UNKNOWN@": METRIC_UNKNOWN, "@SEMANTIC_ID@": SEMANTIC_ID,
    "@X121@": "x" * 121, "@X1001@": "x" * 1001, "@X4001@": "x" * 4001,
}

# What the vocabulary refuses, each by a fixture of that name. A refusal with no fixture is a refusal
# nothing holds the two statements of to account.
REQUIRED = {
    "invalid": [
        "document-is-not-a-list", "schema-is-not-a-mapping", "unknown-schema-key", "unknown-metric-key",
        "name-missing", "name-is-empty", "name-has-a-leading-space", "name-is-too-long",
        "name-is-only-a-version", "a-new-name-ends-in-a-version", "name-used-twice",
        "a-version-and-its-schema-are-one-name", "description-is-too-long", "semantic-id-type-unknown",
        "semantic-id-type-without-an-id", "change-description-is-too-long", "metrics-missing",
        "metrics-is-empty", "metric-name-missing", "metric-is-not-in-the-catalogue", "metric-is-derived",
        "metric-is-deprecated", "metric-is-listed-twice", "minimum-is-text", "maximum-is-a-boolean",
        "minimum-is-above-the-maximum", "a-range-on-a-text-metric", "a-range-on-a-boolean-metric",
        "metric-semantic-id-differs", "the-second-schema-is-refused", "derived-metrics-is-not-a-list",
        "derived-metric-is-not-text", "derived-metric-is-not-in-the-catalogue", "derived-metric-is-measured",
        "derived-metric-is-deprecated", "derived-metric-is-listed-twice", "derived-metric-lacks-an-input",
        "derived-metric-counts-a-state-that-is-not-permitted",
    ],
    "valid": ["the-example", "minimal", "an-empty-list", "both-bounds", "only-a-minimum", "only-a-maximum",
              "a-text-and-a-boolean-metric", "two-schemas", "a-derived-metric", "no-derived-metrics"],
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
    """A schema error's place, as the function writes a path: $[0].metrics[1].minimum."""
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
        self.cur.execute("SELECT to_regprocedure('public.apply_device_schemas(jsonb, boolean)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0295 is not applied to this database")
        self.cur.execute("SELECT id FROM public.roles WHERE name = 'Administrator';")
        role = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (ADMIN_ID, "admin@guard.test"))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                         " ON CONFLICT (user_id, role_id) DO NOTHING;", (ADMIN_ID, role))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb"
                         " WHERE key = 'security.require_mfa_for_managers';")
        self.cur.execute(
            "INSERT INTO public.metric_catalog (name, datatype, semantic_id, semantic_id_type) VALUES"
            " (%s, 10, %s, 'IRI'), (%s, 10, NULL, NULL), (%s, 12, NULL, NULL), (%s, 11, NULL, NULL);",
            (METRIC_NUMBER, SEMANTIC_ID, METRIC_NUMBER_2, METRIC_TEXT, METRIC_BOOL))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, deprecated) VALUES (%s, 10, true);",
                         (METRIC_DEPRECATED,))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units, derivation)"
                         " VALUES (%s, 10, 'COUNT/HOUR', %s::jsonb);",
                         (METRIC_DERIVED, json.dumps({"kind": "counter_rate", "input": METRIC_NUMBER})))
        # One that was deprecated after it was made, and one whose input's permitted values lost its state.
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s::jsonb);",
                         (METRIC_DERIVED_OLD, json.dumps({"kind": "counter_rate", "input": METRIC_NUMBER})))
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE name = %s;", (METRIC_DERIVED_OLD,))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s::jsonb);",
                         (METRIC_DERIVED_STATE, json.dumps({"kind": "time_in_state", "input": METRIC_TEXT, "states": ["AUTO"]})))
        self.cur.execute("UPDATE public.metric_catalog SET permitted_values = '{MANUAL,SETUP}' WHERE name = %s;", (METRIC_TEXT,))
        # The Administrator's session, as PostgREST hands it to the database.
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": ADMIN_ID, "role": "authenticated", "email": "admin@guard.test"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def preview(self, document):
        self.cur.execute("SELECT public.apply_device_schemas(%s::jsonb, true);", (Json(document),))
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
                self.assertEqual(self.reasons(results), [], f"apply_device_schemas() refuses {name}")
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
                    self.assertTrue(errors, f"the schema accepts {name}, which apply_device_schemas() refuses")
                results = self.preview(document)
                paths = [path for path, _ in self.reasons(results)]
                self.assertIn(fixture["path"], paths, f"{name}: the reasons are at {paths}")
                self.assertIn("refused", [r["status"] for r in results])

    def test_a_refusal_carries_a_sentence_a_person_can_act_on(self):
        for name, fixture in load_fixtures("invalid"):
            for path, message in self.reasons(self.preview(fixture["document"])):
                with self.subTest(fixture=name, path=path):
                    self.assertTrue(path == "$" or re.match(r"^\$\[\d+\]", path), path)
                    self.assertGreater(len(message), 20)
                    # Short ones, as the documentation rule asks.
                    self.assertLessEqual(len(message.split()), 45, message)

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
        self.assertGreater(fields, 8)

    def test_every_object_is_closed(self):
        closed = 0
        for where, node in self.walk(self.schema, "#"):
            if node.get("type") == "object" or "properties" in node:
                with self.subTest(where=where):
                    self.assertIs(node.get("additionalProperties"), False, f"{where} lets an unknown key through")
                closed += 1
        self.assertGreaterEqual(closed, 2)

    def test_the_schema_names_the_vocabulary_the_database_has(self):
        """The enum and the limits, held to what the tables allow."""
        schema_def = self.schema["$defs"]["deviceSchema"]["properties"]
        self.cur.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
            " WHERE conname = 'schemas_semantic_id_type_valid' AND conrelid = 'public.schemas'::regclass;")
        types = set(re.findall(r"'([A-Za-z]+)'::text", self.cur.fetchone()[0]))
        self.assertEqual(set(schema_def["semantic_id_type"]["enum"]), types)
        self.cur.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
            " WHERE conname = 'metric_catalog_name_format' AND conrelid = 'public.metric_catalog'::regclass;")
        self.assertIn(self.schema["$defs"]["metric"]["properties"]["name"]["pattern"], self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
