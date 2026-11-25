# suite:
#   lanes: db
#   why: 0336 -- a device has the derived metrics its schemas name, several schemas' together and a
#     replay lane its original's; device_derived_metrics() and schema_derived_metric_problems() give the
#     fixture's answers, which the dashboard and the AAS exporter give too, and schema_modelled_metrics()
#     the modelled-metrics contract's. A threshold on a derived metric the device does not have is
#     refused and names its schemas, unless the automation watches it already.

"""
A device has the derived metrics its schemas name (0336), and a threshold on another is refused.

    python supabase/migrations/test_a_device_has_the_derived_metrics_its_schemas_name.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

  * test-harness/fixtures/device-derived-metrics.json, planted as rows: every device's derived metrics by
    device_derived_metrics(), and every reason by schema_derived_metric_problems(), word for word.
    frontend/src/__tests__/deviceDerivedMetrics.test.js and the AAS exporter's suite read the same file.
  * test-harness/fixtures/modelled-metrics.json: schema_modelled_metrics() is one more implementation of it.
  * automations_parse(): the refusal, on the device's own line, with the schemas it names; no refusal for
    a device that has the metric, for a measured metric, and for what the automation watches already.
  * A stored automation keeps working: applying what automations_document() renders changes nothing, also
    after a schema stops naming the metric.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
from pathlib import Path

import psycopg2
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

FIXTURES = Path(__file__).resolve().parents[2] / "test-harness" / "fixtures"
RULE = json.loads((FIXTURES / "device-derived-metrics.json").read_text(encoding="utf-8"))
MODELLED = json.loads((FIXTURES / "modelled-metrics.json").read_text(encoding="utf-8"))

PLAYBACK_GATEWAY = "SELECT id FROM public.gateways WHERE is_shadow ORDER BY created_at LIMIT 1;"
MANAGER_ID = "b2e60336-0000-4000-8000-0000000336b1"
SWITCH = "security.require_mfa_for_managers"
RATE = "Fixture_0336_D/PARTS_PER_HOUR"
NET = "Fixture_0336_D/NET"
COUNT = "Fixture_0336/PART_COUNT"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.device_derived_metrics(uuid[])') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0336 is not applied to this database")
        self.plant()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def plant(self):
        """The fixture's catalogue, schemas and devices, as the owner."""
        # A deprecated one is named while it is not, as it was on a site, then deprecated.
        for metric in RULE["catalog"]:
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, %s);",
                             (metric["name"], metric["datatype"],
                              Json(metric["derivation"]) if "derivation" in metric else None))
        self.schemas = {}
        for schema in RULE["schemas"]:
            self.cur.execute(
                "INSERT INTO public.schemas (schema_name, schema_definition, derived_metrics) VALUES (%s, %s, %s)"
                " RETURNING id::text;",
                (f"Fixture_0336_{schema['key']}", Json({"type": "object", "properties": {m: {} for m in schema["metrics"]}}),
                 schema["derived_metrics"]))
            self.schemas[schema["key"]] = self.cur.fetchone()[0]
        for metric in RULE["catalog"]:
            if metric.get("deprecated"):
                self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE name = %s;", (metric["name"],))
        self.cur.execute(PLAYBACK_GATEWAY)
        playback = self.cur.fetchone()[0]
        self.devices = {}
        for device in RULE["devices"]:
            lane_of = self.devices.get(device.get("shadow_of"))
            self.cur.execute(
                "INSERT INTO public.devices (name, status, last_birth_metrics, shadow_of, gateway_id)"
                " VALUES (%s, 'OFFLINE', %s, %s, %s) RETURNING id::text;",
                (f"Fixture 0336 {device['key']}", device.get("birth", []), lane_of, playback if lane_of else None))
            self.devices[device["key"]] = self.cur.fetchone()[0]
            for key in device["schemas"]:
                self.cur.execute("INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s);",
                                 (self.devices[device["key"]], self.schemas[key]))


class TheRule(Base):
    def test_every_device_of_the_fixture_has_exactly_its_derived_metrics(self):
        self.assertGreater(len(RULE["devices"]), 5)
        for device in RULE["devices"]:
            with self.subTest(device=device["key"]):
                self.cur.execute("SELECT metric_name FROM public.device_derived_metrics(ARRAY[%s::uuid])"
                                 " ORDER BY metric_name COLLATE \"C\";", (self.devices[device["key"]],))
                self.assertEqual([r[0] for r in self.cur.fetchall()], device["expected"])

    def test_without_ids_it_answers_for_every_device_at_once(self):
        self.cur.execute("SELECT device_id::text, array_agg(metric_name ORDER BY metric_name COLLATE \"C\")"
                         " FROM public.device_derived_metrics() WHERE device_id = ANY (%s::uuid[]) GROUP BY device_id;",
                         (list(self.devices.values()),))
        got = dict(self.cur.fetchall())
        for device in RULE["devices"]:
            self.assertEqual(got.get(self.devices[device["key"]], []), device["expected"], device["key"])

    def test_every_reason_is_the_fixtures_word_for_word(self):
        self.assertGreater(len(RULE["problems"]), 10)
        for case in RULE["problems"]:
            with self.subTest(case=case["about"]):
                self.cur.execute("SELECT problem FROM public.schema_derived_metric_problems(%s, %s, %s)"
                                 " WITH ORDINALITY AS p(metric_name, problem, ord) ORDER BY ord;",
                                 (Json(case["definition"]), case["names"], case.get("kept", [])))
                self.assertEqual([r[0] for r in self.cur.fetchall()], case["problems"])

    def test_what_a_definition_models_is_the_modelled_metrics_contract(self):
        self.assertGreater(len(MODELLED["cases"]), 5)
        for case in MODELLED["cases"]:
            with self.subTest(case=case["name"]):
                definition = case.get("schema_definition")
                self.cur.execute("SELECT public.schema_modelled_metrics(%s);",
                                 (None if definition is None else Json(definition),))
                # As the AAS exporter and i3X do, cannot be evaluated and models nothing are one answer.
                self.assertEqual(sorted(self.cur.fetchone()[0]), sorted(case["expected"] or []))


class AThresholdOnADerivedMetric(Base):
    def setUp(self):
        super().setUp()
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                         (MANAGER_ID, f"{MANAGER_ID}@derived-threshold.test"))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id)"
                         " SELECT %s, id FROM public.roles WHERE name = 'Shopfloor_Manager'"
                         " ON CONFLICT (user_id, role_id) DO NOTHING;", (MANAGER_ID,))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))

    def as_person(self, sql, args=()):
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(
            {"sub": MANAGER_ID, "role": "authenticated", "aal": "aal1"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute(sql, args)
        answer = self.cur.fetchone()[0]
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        return answer

    def apply(self, device, metric, dry_run=True, key="test-0336", **over):
        triggers = [{"trigger": "threshold", "device": device, "metric": metric, "above": 5}]
        document = [{"id": key, "alias": "Test 0336", "enabled": True, "triggers": triggers,
                     "actions": [{"action": "alert", "severity": "info"}], **over}]
        return self.as_person("SELECT public.apply_automations(%s::jsonb, %s);", (Json(document), dry_run))[0]

    def test_a_device_whose_schema_names_it_is_accepted(self):
        for device in ("one-schema", "several-schemas-have-the-union", "never-reported-anything"):
            with self.subTest(device=device):
                self.assertEqual(self.apply(self.devices[device], RATE)["status"], "new")

    def test_a_replay_lane_is_judged_by_its_originals_schemas(self):
        self.assertEqual(self.apply(self.devices["a-lane-has-its-originals"], RATE)["status"], "new")
        result = self.apply(self.devices["a-lane-has-its-originals"], NET)
        self.assertEqual(result["status"], "refused")
        self.assertIn("(Fixture_0336_press v1)", result["reasons"][0]["message"])

    def test_one_none_of_its_schemas_names_is_refused_and_the_schemas_are_said(self):
        result = self.apply(self.devices["several-schemas-have-the-union"], "Fixture_0336_D/AUTOMATIC")
        self.assertEqual(result["status"], "refused")
        self.assertEqual(result["reasons"], [{
            "path": "$[0].triggers[0].device",
            "message": "Fixture 0336 several-schemas-have-the-union does not have `Fixture_0336_D/AUTOMATIC`: none of its"
                       " schemas names it (Fixture_0336_meter v1, Fixture_0336_press v1). Name it in one of them on the"
                       " Schemas page."}])

    def test_a_device_with_no_schema_is_told_that(self):
        result = self.apply(self.devices["no-schema"], RATE)
        self.assertEqual([r["message"] for r in result["reasons"]], [
            f"Fixture 0336 no-schema has no schema, so it has no derived metric. Give it one that names `{RATE}`."])

    def test_the_reason_is_on_the_line_of_the_device_that_lacks_it(self):
        result = self.apply([self.devices["one-schema"], self.devices["no-schema"],
                             self.devices["reports-every-input-and-no-schema-names-it"]], RATE)
        self.assertEqual([r["path"] for r in result["reasons"]],
                         ["$[0].triggers[0].device[1]", "$[0].triggers[0].device[2]"])

    def test_a_measured_metric_is_not_asked_about(self):
        self.assertEqual(self.apply(self.devices["no-schema"], COUNT)["status"], "new")

    def test_what_an_automation_watches_already_stays_and_another_device_is_still_refused(self):
        device = self.devices["one-schema"]
        self.assertEqual(self.apply(device, RATE, dry_run=False)["status"], "new")
        # Its schema stops naming it, by the owner's hand: a published version is not edited by a person.
        self.cur.execute("UPDATE public.schemas SET derived_metrics = '{}' WHERE id = %s;", (self.schemas["press"],))
        self.assertEqual(self.apply(device, RATE)["status"], "unchanged")
        self.assertEqual(self.apply(device, RATE, alias="Renamed", dry_run=False)["status"], "changed")
        document = self.as_person("SELECT public.automations_document(ARRAY['test-0336']) -> 'automations';")
        again = self.as_person("SELECT public.apply_automations(%s::jsonb, true);", (Json(document),))
        self.assertEqual([r["status"] for r in again], ["unchanged"])
        # Another automation, and another device in the same one, are new.
        self.assertEqual(self.apply(device, RATE, key="test-0336-other")["status"], "refused")
        result = self.apply([device, self.devices["no-schema"]], RATE)
        self.assertEqual([r["path"] for r in result["reasons"]], ["$[0].triggers[0].device[1]"])

    def test_the_rule_and_its_words_are_no_browsers(self):
        for signature in ("device_derived_metrics(uuid[])", "device_lacks_derived_metric_words(uuid, text)",
                          "automations_parse(jsonb)"):
            with self.subTest(function=signature):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                                 " has_function_privilege('authenticated', %s, 'EXECUTE');",
                                 (f"public.{signature}", f"public.{signature}"))
                self.assertEqual(self.cur.fetchone(), (False, False))


if __name__ == "__main__":
    unittest.main()
