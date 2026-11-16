# suite:
#   lanes: db
#   why: 0292 -- an automation's alert says its reading's unit. unit_symbol() answers the symbol the
#     dashboard shows for a unit code and NULL for a code with none, for every unit the Add Metric
#     list offers, and is IMMUTABLE with its search_path pinned. A measured metric's value and
#     threshold are worded with the unit its catalogue row holds ("82.4 °C" against "80 °C", "42%",
#     "90°", a code with no symbol as the code), in the detail and in the summary an evaluation writes.
#     A metric with no unit or no catalogue row, a time in state and a derived metric read as they did,
#     and an alert's labels and values keep the code and the number. A replay keeps the four functions,
#     and a boot's order, 0283 and then 0292, ends with the unit.

"""
An automation's alert says its reading's unit (0292).

    python supabase/migrations/test_an_automations_alert_says_its_readings_unit.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).
The db lane has no historian, so a local table stands in for the foreign telemetry_latest inside the
transaction, as the suite for 0270 and 0271 does. Every test rolls back.

What is held here:

  * unit_symbol() answers the symbol for a code ("°C" for CELSIUS) and NULL for a code with none, for
    every unit the Add Metric dialog offers (the MTConnect UNIT and NATIVE_UNIT rows), is IMMUTABLE
    with its search_path pinned, and is granted to no API role. Mirror check 104 holds the pairs to
    UNIT_SYMBOLS in utils/units.js.
  * with_unit() says withUnit(): a % or a ° against the number, any other symbol after a space, a code
    with no symbol as it is, and no code leaves the text.
  * automation_value_words() and automation_threshold_words() give a measured metric's value and
    threshold its unit: "82.4 °C" against "80 °C", "42%" against "50%", "90°", a unit with no symbol as
    its code. A metric with no unit, or none in the catalogue, is as it prints. A time in state and a
    derived metric are worded as 0283 words them, whatever unit the row carries.
  * An evaluation says it in the detail machine_condition_rows() gives and in the summary of the alert
    it raises, and only there: the alert's labels and values keep the metric's name and the numbers.
  * The files. A replay of 0292 keeps the four functions, and 0283 run before it, as a boot runs them,
    leaves the words with no unit until 0292 gives it back.
"""
import json
import os
import unittest
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = "0292_an_automation_s_alert_says_its_reading_s_unit.sql"
PRECEDING = "0283_a_threshold_automation_reads_a_derived_metric.sql"

MANAGER_ID = "a0d17292-0000-4000-8000-0000000292a1"
# A device's sparkplug_id is its uuid's first 21 hex characters.
DEVICE = "a1d17292-1000-4000-8000-000000000001"
DEVICE_NAME = "Test_0292_Lathe_3"
SWITCH = "security.require_mfa_for_managers"

TEMPERATURE = "Test_0292/Spindle_Temperature"
HUMIDITY = "Test_0292/Cabinet_Humidity"
ANGLE = "Test_0292/Spindle_Angle"
PRESSURE = "Test_0292/Coolant_Pressure"
STRANGE = "Test_0292/Strange_Reading"
BARE = "Test_0292/Bare_Reading"
NO_ROW = "Test_0292/Not_In_The_Catalogue"
# (name, units): the unit is what the catalogue row holds.
MEASURED = ((TEMPERATURE, "CELSIUS"), (HUMIDITY, "PERCENT"), (ANGLE, "DEGREE"), (PRESSURE, "BAR"),
            (STRANGE, "FURLONG"), (BARE, None))


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def trigger(metric, **over):
    t = {"trigger": "threshold", "device": DEVICE, "metric": metric, "above": 80, "for": "5m"}
    t.update(over)
    return {k: v for k, v in t.items() if v is not None}


def automation(key, triggers):
    return {"id": key, "alias": f"Test 0292 {key}", "description": "Check the coolant first.", "enabled": True,
            "triggers": triggers, "actions": [{"action": "alert", "severity": "warning"}]}


class UnitWordsBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.unit_symbol(text)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0292 is not applied to this database")
        self.cur.execute("SELECT id FROM public.roles WHERE name = 'Shopfloor_Manager';")
        role = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                         (MANAGER_ID, "a1@unit-words.test"))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                         " ON CONFLICT (user_id, role_id) DO NOTHING;", (MANAGER_ID, role))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))
        self.cur.execute("INSERT INTO public.areas (name) VALUES ('Test_0292_Machining') RETURNING id;")
        area = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.cells (name, area_id) VALUES ('Test_0292_Cell', %s) RETURNING id;", (area,))
        cell = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.devices (id, name, cell_id, location_scope) VALUES (%s, %s, %s, 'cell') "
                         "RETURNING sparkplug_id;", (DEVICE, DEVICE_NAME, cell))
        self.sparkplug = self.cur.fetchone()[0]
        for name, units in MEASURED:
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units) VALUES (%s, 10, %s);", (name, units))
        self.cur.execute("SELECT date_trunc('second', now()) - interval '1 hour';")
        self.t0 = self.cur.fetchone()[0]

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    def one(self, sql, args=()):
        self.owner()
        self.cur.execute(sql, args)
        return self.cur.fetchone()[0]

    def value_words(self, metric, value):
        return self.one("SELECT public.automation_value_words(%s, %s::double precision);", (metric, value))

    def threshold_words(self, metric, threshold):
        return self.one("SELECT public.automation_threshold_words(%s, %s::double precision);", (metric, threshold))


class TheSymbols(UnitWordsBase):
    def test_a_code_with_a_symbol_answers_it_and_one_without_answers_null(self):
        for code, symbol in (("CELSIUS", "°C"), ("PERCENT", "%"), ("DEGREE", "°"), ("COUNT", "count"),
                             ("CUBIC_METER", "m³"), ("OHM", "Ω"), ("MICROMETER", "µm"), ("REVOLUTION/MINUTE", "rpm")):
            with self.subTest(code=code):
                self.assertEqual(self.one("SELECT public.unit_symbol(%s);", (code,)), symbol)
        for code in ("FURLONG", "celsius", "", "KILOWATT/HOUR", None):
            with self.subTest(code=code):
                self.assertIsNone(self.one("SELECT public.unit_symbol(%s);", (code,)))

    def test_every_unit_the_add_metric_list_offers_has_a_symbol(self):
        self.owner()
        self.cur.execute("SELECT name FROM public.mtconnect_vocabulary WHERE kind IN ('UNIT', 'NATIVE_UNIT')"
                         " AND public.unit_symbol(name) IS NULL ORDER BY name;")
        self.assertEqual(self.cur.fetchall(), [])
        self.cur.execute("SELECT count(*) > 0 FROM public.mtconnect_vocabulary WHERE kind IN ('UNIT', 'NATIVE_UNIT');")
        self.assertTrue(self.cur.fetchone()[0], "the vocabulary holds no unit, so the check above checked nothing")

    def test_the_symbols_are_a_pure_lookup_granted_to_no_api_role(self):
        self.owner()
        for fn in ("public.unit_symbol(text)", "public.with_unit(text, text)"):
            with self.subTest(fn=fn):
                self.cur.execute("SELECT provolatile, proconfig FROM pg_proc WHERE oid = %s::regprocedure;", (fn,))
                volatility, config = self.cur.fetchone()
                self.assertEqual(volatility, "i")
                self.assertEqual(config, ['search_path=""'])
        for fn in ("public.unit_symbol(text)", "public.with_unit(text, text)",
                   "public.automation_value_words(text, double precision)",
                   "public.automation_threshold_words(text, double precision)"):
            for role in ("anon", "authenticated", "service_role"):
                with self.subTest(fn=fn, role=role):
                    self.assertFalse(self.one("SELECT has_function_privilege(%s, %s, 'EXECUTE');", (role, fn)))

    def test_a_percent_and_a_degree_stand_against_the_number_and_any_other_follows_a_space(self):
        for text, code, words in (("82.4", "CELSIUS", "82.4 °C"), ("42", "PERCENT", "42%"), ("90", "DEGREE", "90°"),
                                  ("3.2", "BAR", "3.2 bar"), ("12", "REVOLUTION/MINUTE", "12 rpm"),
                                  ("7", "FURLONG", "7 FURLONG"), ("5", None, "5"), ("5", "", "5")):
            with self.subTest(code=code):
                self.assertEqual(self.one("SELECT public.with_unit(%s, %s);", (text, code)), words)


class TheWords(UnitWordsBase):
    def test_a_celsius_metric_says_its_value_and_threshold_in_degrees_celsius(self):
        self.assertEqual(self.value_words(TEMPERATURE, 82.4), "82.4 °C")
        self.assertEqual(self.threshold_words(TEMPERATURE, 80), "80 °C")

    def test_a_percent_metric_and_a_degree_metric_stand_against_the_number(self):
        self.assertEqual(self.value_words(HUMIDITY, 42), "42%")
        self.assertEqual(self.threshold_words(HUMIDITY, 50), "50%")
        self.assertEqual(self.value_words(ANGLE, 90), "90°")
        self.assertEqual(self.threshold_words(ANGLE, 45.5), "45.5°")

    def test_another_symbol_follows_a_space(self):
        self.assertEqual(self.value_words(PRESSURE, 3.2), "3.2 bar")
        self.assertEqual(self.threshold_words(PRESSURE, 4), "4 bar")

    def test_a_unit_with_no_symbol_says_its_code_as_the_dashboard_does(self):
        self.assertEqual(self.value_words(STRANGE, 7.5), "7.5 FURLONG")
        self.assertEqual(self.threshold_words(STRANGE, 10), "10 FURLONG")

    def test_a_metric_with_no_unit_and_one_the_catalogue_does_not_hold_say_the_number_as_it_prints(self):
        for metric in (BARE, NO_ROW):
            with self.subTest(metric=metric):
                self.assertEqual(self.value_words(metric, 80.12345678), "80.12345678")
                self.assertEqual(self.threshold_words(metric, 0.9), "0.9")
        self.cur.execute("UPDATE public.metric_catalog SET units = '' WHERE name = %s;", (BARE,))
        self.assertEqual(self.value_words(BARE, 3), "3")

    def test_the_number_is_printed_as_it_was_and_only_the_unit_is_added(self):
        for value in (82.4, 80, 0.1, 1e-05, 123456789.123, -4.5):
            with self.subTest(value=value):
                bare = self.value_words(BARE, value)
                self.assertEqual(self.value_words(TEMPERATURE, value), f"{bare} °C")

    def test_a_time_in_state_and_a_derived_metric_are_worded_as_they_were(self):
        counter, state = "Test_0292/Part_Count", "Test_0292/Execution"
        phase_a, phase_b = "Test_0292/Phase_A", "Test_0292/Phase_B"
        for name, datatype, units in ((counter, 10, "COUNT"), (state, 12, None),
                                    (phase_a, 10, "KILOWATT"), (phase_b, 10, "KILOWATT")):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units) VALUES (%s, %s, %s);",
                             (name, datatype, units))
        rate, uptime, power = "Test_0292/Parts_Per_Hour", "Test_0292/Uptime", "Test_0292/Power"
        for name, derivation in ((rate, {"kind": "counter_rate", "input": counter}),
                                 (uptime, {"kind": "time_in_state", "input": state, "states": ["ACTIVE"]}),
                                 (power, {"kind": "sum", "inputs": [{"metric": phase_a, "sign": 1}, {"metric": phase_b, "sign": 1}]})):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s);",
                             (name, Json(derivation)))
        self.assertEqual(self.value_words(rate, 4.16666666), "4.167 over the last hour")
        self.assertEqual(self.threshold_words(rate, 5), "5")
        self.assertEqual(self.value_words(uptime, 0.4166), "41.7% over the last hour")
        self.assertEqual(self.threshold_words(uptime, 0.9), "90%")
        self.assertEqual(self.value_words(power, 7), "7 at the last whole minute")
        self.assertEqual(self.threshold_words(power, 5), "5")
        # Whatever unit a derived row carries, its words are 0283's.
        self.cur.execute("UPDATE public.metric_catalog SET units = 'COUNT/HOUR' WHERE name = %s;", (rate,))
        self.assertEqual(self.value_words(rate, 4.16666666), "4.167 over the last hour")
        self.assertEqual(self.threshold_words(rate, 5), "5")


class TheAlert(UnitWordsBase):
    """An evaluation, with a local table where the foreign telemetry_latest is."""

    def setUp(self):
        super().setUp()
        self.owner()
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry_latest CASCADE;"
            "CREATE TABLE timescale.telemetry_latest ("
            ' "time" timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,'
            " val_double double precision, val_string text, val_bool boolean);")

    def reading(self, metric, value):
        self.owner()
        self.cur.execute("INSERT INTO timescale.telemetry_latest (\"time\", asset_id, metric_name, val_double)"
                         " VALUES (%s, %s, %s, %s);", (self.t0, self.sparkplug, metric, value))

    def apply(self, *documents):
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": MANAGER_ID, "role": "authenticated", "aal": "aal1",
                                      "email": "a1@unit-words.test"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute("SELECT public.apply_automations(%s::jsonb, false);", (Json(list(documents)),))
        results = self.cur.fetchone()[0]
        self.owner()
        self.assertEqual([r["status"] for r in results], ["new"] * len(documents), results)

    def evaluate(self, seconds):
        self.owner()
        self.cur.execute("SELECT public.evaluate_automations(%s);", (self.t0 + timedelta(seconds=seconds),))

    def alert(self, metric):
        self.owner()
        self.cur.execute("SELECT summary, labels, \"values\" FROM public.platform_alerts WHERE entity_id = %s"
                         " AND status = 'firing' AND labels ->> 'metric' = %s;", (DEVICE, metric))
        return self.cur.fetchall()

    def detail(self, metric):
        self.owner()
        self.cur.execute("SELECT detail FROM public.machine_condition_rows() WHERE metric_name = %s;", (metric,))
        return [row[0] for row in self.cur.fetchall()]

    def test_an_alert_on_a_celsius_metric_reads_82_4_degrees_against_80(self):
        self.apply(automation("hot", [trigger(TEMPERATURE, above=80)]))
        self.reading(TEMPERATURE, 82.4)
        self.assertEqual(self.detail(TEMPERATURE), [f"{TEMPERATURE} is 82.4 °C, above 80 °C"])
        self.evaluate(0)
        self.evaluate(300)
        (summary, _, _), = self.alert(TEMPERATURE)
        self.assertEqual(summary, f"{DEVICE_NAME}: {TEMPERATURE} is 82.4 °C, above 80 °C for 5m")

    def test_a_percent_metric_below_its_threshold_reads_a_percentage(self):
        self.apply(automation("damp", [trigger(HUMIDITY, above=None, below=50, **{"for": None})]))
        self.reading(HUMIDITY, 42)
        self.assertEqual(self.detail(HUMIDITY), [f"{HUMIDITY} is 42%, below 50%"])
        self.evaluate(0)
        (summary, _, _), = self.alert(HUMIDITY)
        self.assertEqual(summary, f"{DEVICE_NAME}: {HUMIDITY} is 42%, below 50%")

    def test_a_unit_with_no_symbol_reads_its_code_and_a_metric_with_no_unit_reads_as_it_did(self):
        self.apply(automation("odd", [trigger(STRANGE, above=5, **{"for": None}), trigger(BARE, above=80, **{"for": None})]))
        self.reading(STRANGE, 7.5)
        self.reading(BARE, 91.5)
        self.assertEqual(self.detail(STRANGE), [f"{STRANGE} is 7.5 FURLONG, above 5 FURLONG"])
        self.assertEqual(self.detail(BARE), [f"{BARE} is 91.5, above 80"])
        self.evaluate(0)
        (summary, _, _), = self.alert(STRANGE)
        self.assertEqual(summary, f"{DEVICE_NAME}: {STRANGE} is 7.5 FURLONG, above 5 FURLONG")
        (summary, _, _), = self.alert(BARE)
        self.assertEqual(summary, f"{DEVICE_NAME}: {BARE} is 91.5, above 80")

    def test_the_labels_and_the_values_keep_the_code_and_the_number(self):
        self.apply(automation("hot", [trigger(TEMPERATURE, above=80, **{"for": None})]))
        self.reading(TEMPERATURE, 82.4)
        self.evaluate(0)
        (summary, labels, values), = self.alert(TEMPERATURE)
        self.assertIn("°C", summary)
        self.assertEqual(labels["metric"], TEMPERATURE)
        self.assertEqual(set(labels), {"severity", "entity_type", "metric", "automation", "trigger_id"})
        self.assertEqual(values, {"value": 82.4, "threshold": 80})
        self.assertFalse(any("°" in str(v) for v in [*labels.values(), *values.values()]))

    def test_a_threshold_a_file_holds_is_the_number_it_wrote(self):
        self.apply(automation("hot", [trigger(TEMPERATURE, above=80.5, **{"for": None})]))
        self.reading(TEMPERATURE, 82.4)
        self.owner()
        self.cur.execute("SELECT t.threshold FROM public.automation_triggers t JOIN public.automations a ON a.id = t.automation_id"
                         " WHERE a.key = 'hot';")
        self.assertEqual(self.cur.fetchall(), [(Decimal("80.5"),)])
        self.assertEqual(self.detail(TEMPERATURE), [f"{TEMPERATURE} is 82.4 °C, above 80.5 °C"])


class TheFiles(UnitWordsBase):
    """The migration's file, and 0283's before it, as a boot runs them: 0283 declares the two words
    functions again with no unit, and 0292 runs after it."""

    FUNCTIONS = ("public.unit_symbol(text)", "public.with_unit(text, text)",
                 "public.automation_value_words(text, double precision)",
                 "public.automation_threshold_words(text, double precision)")

    def run_file(self, name):
        self.owner()
        self.cur.execute((Path(__file__).with_name(name)).read_text(encoding="utf-8"))

    def oids(self):
        oids = []
        for fn in self.FUNCTIONS:
            self.cur.execute("SELECT to_regprocedure(%s)::oid;", (fn,))
            oids.append(self.cur.fetchone()[0])
        return oids

    def test_a_replay_keeps_the_functions_and_their_words(self):
        before = self.oids()
        self.assertEqual(len(before), 4)
        self.run_file(MIGRATION)
        self.assertEqual(self.oids(), before)
        self.assertEqual(self.value_words(TEMPERATURE, 82.4), "82.4 °C")

    def test_a_boot_runs_0283_and_then_0292_and_each_value_ends_in_its_unit(self):
        self.run_file(PRECEDING)
        self.assertEqual(self.value_words(TEMPERATURE, 82.4), "82.4", "0283 declares the words again with no unit")
        self.run_file(MIGRATION)
        self.assertEqual(self.value_words(TEMPERATURE, 82.4), "82.4 °C")
        self.assertEqual(self.threshold_words(TEMPERATURE, 80), "80 °C")
        self.assertEqual(self.value_words(HUMIDITY, 42), "42%")


if __name__ == "__main__":
    unittest.main(verbosity=2)
