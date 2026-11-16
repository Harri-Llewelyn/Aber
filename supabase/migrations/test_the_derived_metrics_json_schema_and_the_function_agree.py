# suite:
#   lanes: db
#   why: 0297 -- every fixture in supabase/derived-metrics-fixtures/ through the JSON Schema the
#     dashboard serves (jsonschema) and through apply_derived_metrics(..., true): both accept each
#     valid one, both refuse each invalid one, or the schema accepts what only the database can know.
#     Every field of the schema is described and every object closed.

"""
The derived metrics JSON Schema and apply_derived_metrics() agree (0297).

    python supabase/migrations/test_the_derived_metrics_json_schema_and_the_function_agree.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one)
and the `jsonschema` package, which the db lane's CI job installs.

WHY. The browser holds a JSON Schema (frontend/public/json-schema/derived-metrics.schema.json) that
drives the editor's completion, hover help and inline errors. The database holds the rules
(apply_derived_metrics()), because the stack has no pg_jsonschema and the browser is a convenience.
Two statements of one vocabulary drift, and a drift is either an editor that accepts a file the
database refuses, or one that refuses a file the database would have applied.

WHAT IS HELD. Every file under supabase/derived-metrics-fixtures/ is one document and one reason:

  * valid/: the schema accepts it, and apply_derived_metrics(doc, true) refuses nothing in it and
    reports every metric new.
  * invalid/, with "database": false: the schema refuses it, and the function reports a reason at
    the path the fixture names.
  * invalid/, with "database": true: what only the database can know (an input that is not in the
    catalogue, derived or of the wrong datatype, units that differ, a name that exists, a name used
    twice). The schema accepts it, as it must, and the function reports a reason at the path the
    fixture names.

The fixtures name the metrics they need as @COUNTER@ and the like, and a long text as @X4001@
(4,001 characters), filled in from rows this suite makes. The schema is also held to its own rules:
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
SCHEMA_PATH = REPO / "frontend" / "public" / "json-schema" / "derived-metrics.schema.json"
FIXTURES = REPO / "supabase" / "derived-metrics-fixtures"

ADMIN_ID = "a0d17297-0000-4000-8000-0000000297b1"

G = "Test_0297_Guard"
COUNTER = f"{G}/Part_Count"
PHASE_A = f"{G}/Phase_A"
PHASE_B = f"{G}/Phase_B"
PHASE_KW = f"{G}/Phase_Kw"
STATE_TEXT = f"{G}/Execution"
STATE_BOOL = f"{G}/Door_Open"
STATE_FREE = f"{G}/Program"
LOADS = [f"{G}/Load_{n}" for n in range(1, 9)]
DERIVED = f"{G}/Parts_Per_Hour"
DERIVED_DEPRECATED = f"{G}/Old_Rate"
DEPRECATED_INPUT = f"{G}/Old_Gauge"
MEASURED_HELD = f"{G}/Held_By_A_Gauge"
UNKNOWN = f"{G}/Nothing_Publishes_This"

PLACEHOLDERS = {
    "@COUNTER@": COUNTER, "@PHASE_A@": PHASE_A, "@PHASE_B@": PHASE_B, "@PHASE_KW@": PHASE_KW,
    "@STATE_TEXT@": STATE_TEXT, "@STATE_BOOL@": STATE_BOOL, "@STATE_FREE@": STATE_FREE,
    "@DERIVED@": DERIVED, "@DERIVED_DEPRECATED@": DERIVED_DEPRECATED, "@DEPRECATED_INPUT@": DEPRECATED_INPUT,
    "@MEASURED_HELD@": MEASURED_HELD, "@UNKNOWN@": UNKNOWN,
    **{f"@LOAD_{n}@": name for n, name in enumerate(LOADS, 1)},
    "@X4000@": "x" * 4000, "@X4001@": "x" * 4001,
}

# What the vocabulary refuses, each by a fixture of that name. A refusal with no fixture is a refusal
# nothing holds the two statements of to account.
REQUIRED = {
    "invalid": [
        "document-is-not-a-list", "metric-is-not-a-mapping", "unknown-key", "a-unit-is-given", "a-datatype-is-given",
        "name-missing", "name-is-empty", "name-has-a-space", "name-used-twice", "description-is-too-long",
        "kind-missing", "kind-is-unknown", "input-missing", "input-is-not-a-name", "states-missing",
        "states-is-empty", "a-state-is-a-boolean", "a-state-is-empty", "a-state-is-listed-twice",
        "states-on-a-counter-rate", "inputs-on-a-counter-rate", "input-on-a-sum", "inputs-missing",
        "a-sum-has-one-input", "a-sum-has-nine-inputs", "an-input-has-no-sign", "a-sign-is-two",
        "an-input-has-an-unknown-key", "a-metric-is-an-input-twice", "input-is-not-in-the-catalogue",
        "an-input-of-a-sum-is-not-in-the-catalogue", "input-is-derived",
        "a-counter-rate-of-a-text-metric", "a-time-in-state-of-a-number", "a-state-the-input-cannot-report",
        "a-state-a-boolean-cannot-report", "a-sum-of-unlike-units", "the-name-is-a-measured-metric",
        "the-name-is-a-deprecated-derived-metric", "the-definition-differs", "the-description-differs",
        "a-group-in-another-case", "the-second-is-refused",
    ],
    "valid": ["the-example", "minimal", "an-empty-list", "a-time-in-state-of-a-boolean",
              "a-sum-that-opens-with-a-minus", "a-sum-of-eight-inputs", "two-derived-metrics", "an-input-that-is-deprecated"],
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
    """A schema error's place, as the function writes a path: $[0].inputs[1].sign."""
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
        self.cur.execute("SELECT to_regprocedure('public.apply_derived_metrics(jsonb, boolean)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0297 is not applied to this database")
        self.cur.execute("SELECT id FROM public.roles WHERE name = 'Administrator';")
        role = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (ADMIN_ID, "admin@derived-guard.test"))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                         " ON CONFLICT (user_id, role_id) DO NOTHING;", (ADMIN_ID, role))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb"
                         " WHERE key = 'security.require_mfa_for_managers';")
        numbers = [(COUNTER, None), (PHASE_A, "W"), (PHASE_B, "W"), (PHASE_KW, "kW")] + [(n, None) for n in LOADS]
        for name, units in numbers:
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units) VALUES (%s, 10, %s);", (name, units))
        self.cur.execute(
            "INSERT INTO public.metric_catalog (name, datatype, permitted_values) VALUES (%s, 12, ARRAY['ACTIVE', 'READY', 'STOPPED']);",
            (STATE_TEXT,))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 11), (%s, 12), (%s, 10);",
                         (STATE_BOOL, STATE_FREE, MEASURED_HELD))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, deprecated) VALUES (%s, 10, true);",
                         (DEPRECATED_INPUT,))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, description, derivation)"
                         " VALUES (%s, 10, 'Parts per hour.', %s::jsonb);",
                         (DERIVED, json.dumps({"kind": "counter_rate", "input": COUNTER})))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation, deprecated)"
                         " VALUES (%s, 10, %s::jsonb, true);",
                         (DERIVED_DEPRECATED, json.dumps({"kind": "counter_rate", "input": COUNTER})))
        # The Administrator's session, as PostgREST hands it to the database.
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": ADMIN_ID, "role": "authenticated", "email": "admin@derived-guard.test"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def preview(self, document):
        self.cur.execute("SELECT public.apply_derived_metrics(%s::jsonb, true);", (Json(document),))
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
                self.assertEqual(self.reasons(results), [], f"apply_derived_metrics() refuses {name}")
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
                    self.assertTrue(errors, f"the schema accepts {name}, which apply_derived_metrics() refuses")
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
                    # Short ones, as the documentation rule asks. The longest of them tells what to do instead.
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
                # A branch of a field described above it: the items of a list, and a kind's own rules.
                if re.search(r"/(oneOf|anyOf|allOf|items)(/\d+)?$", where):
                    continue
                fields += 1
                with self.subTest(where=where):
                    self.assertTrue(str(node.get("description", "")).strip(), f"{where} has no description")
        self.assertGreater(fields, 8)

    def test_every_object_is_closed(self):
        closed = 0
        for where, node in self.walk(self.schema, "#"):
            if node.get("type") == "object" or ("properties" in node and "allOf" not in where):
                with self.subTest(where=where):
                    self.assertIs(node.get("additionalProperties"), False, f"{where} lets an unknown key through")
                closed += 1
        self.assertGreaterEqual(closed, 2)

    def test_the_schema_names_the_vocabulary_the_database_has(self):
        """The name pattern and the limits, held to what the tables and the shape check allow."""
        props = self.schema["$defs"]["derivedMetric"]["properties"]
        self.cur.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
            " WHERE conname = 'metric_catalog_name_format' AND conrelid = 'public.metric_catalog'::regclass;")
        self.assertIn(props["name"]["pattern"], self.cur.fetchone()[0])
        self.assertIn(self.schema["$defs"]["input"]["properties"]["metric"]["pattern"], props["input"]["pattern"])
        # The kinds and the most inputs the shape check (0267) allows: 8 inputs take, 9 do not.
        self.cur.execute("SELECT public.derivation_shape_problem(%s::jsonb);", (Json({
            "kind": "sum", "inputs": [{"metric": f"A/M{n}", "sign": 1} for n in range(props["inputs"]["maxItems"])]}),))
        self.assertIsNone(self.cur.fetchone()[0])
        self.cur.execute("SELECT public.derivation_shape_problem(%s::jsonb);", (Json({
            "kind": "sum", "inputs": [{"metric": f"A/M{n}", "sign": 1} for n in range(props["inputs"]["maxItems"] + 1)]}),))
        self.assertIsNotNone(self.cur.fetchone()[0])
        for kind in props["kind"]["enum"]:
            self.cur.execute("SELECT public.derivation_shape_problem(%s::jsonb) IS DISTINCT FROM 'its kind is counter_rate, time_in_state or sum';",
                             (Json({"kind": kind}),))
            self.assertTrue(self.cur.fetchone()[0], kind)


if __name__ == "__main__":
    unittest.main(verbosity=2)
