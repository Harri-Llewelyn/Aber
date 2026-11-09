"""
A threshold automation raises its alert from the database (0270, 0271).

    python supabase/migrations/test_a_threshold_automation_raises_its_alert_from_the_database.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).
The db lane has no historian, so a local table stands in for the foreign telemetry_latest inside the
transaction, as the System page's suite does, and the tests that want an outage leave the foreign
table as it is, which raises on connect. One class reads a real historian when
ABER_TEST_HISTORIAN names one (see the end of this file); every other test rolls back.

What is held here:

  * The read. machine_condition_rows() answers one row for each breaching live threshold pair in the
    shape platform_health_rows() answers; machine_condition_readings() every pair with a latest value.
    A pair with no value is not a breach, NaN and a flag are no value, a disabled automation, an
    archived trigger and an archived device are not read, and no API role may execute either.
  * The hold. A breach that has held for `for` fires, not before; a hold shorter than the interval
    fires at the next run; a breach that stops first never fires and its next breach starts the hold
    again; a changed threshold starts it again.
  * The alert. One occurrence for each firing, with its fingerprint, name, severity, subject, labels,
    values, summary and no rule_uid, stamped confirmed by every run; resolved with its ends_at when
    the value stops breaching; never a second open row for one fingerprint.
  * Silence. A pair with no value leaves its state as it was: a firing alert stays and is confirmed,
    a pending breach neither starts nor clears and fires once its hold is served.
  * The lifecycle. A disabled automation, an archived trigger and a trigger given another device or
    metric raise nothing, and their state rows go.
  * An outage. A run that cannot read the historian writes nothing but one platform alert, which
    stays one alert for as long as the outage lasts and resolves at the first run that reads.
  * The state table: every role reads it, nobody writes it, anon touches nothing.
  * The job: scheduled once, every minute, and the confirmation window of a condition: fingerprint
    is the interval and a margin.
"""
import json
import os
import unittest
from datetime import timedelta
from decimal import Decimal

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

OPERATOR_ID = "a0d17271-0000-4000-8000-0000000271a1"
MANAGER_ID = "a0d17271-0000-4000-8000-0000000271a2"
PEOPLE = ((OPERATOR_ID, "Operator"), (MANAGER_ID, "Shopfloor_Manager"))

# Differing in the first block: a device's sparkplug_id is its uuid's first 21 hex characters.
DEV_A = "a1d17271-1000-4000-8000-000000000001"
DEV_B = "b1d17271-1000-4000-8000-000000000002"
METRIC = "Test_0271/Spindle_Temperature"
METRIC_2 = "Test_0271/Spindle_Load"
METRIC_FLAG = "Test_0271/Spindle_Running"
NOT_EVALUATED = "condition:not-evaluated"
SWITCH = "security.require_mfa_for_managers"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def trigger(device=DEV_A, metric=METRIC, **over):
    t = {"trigger": "threshold", "device": device, "metric": metric, "above": 80, "for": "5m"}
    t.update(over)
    return {k: v for k, v in t.items() if v is not None}


def automation(key="spindle", triggers=None, severity="warning", **over):
    a = {"id": key, "alias": "Spindle bearing hot", "description": "Check the coolant first.",
         "enabled": True, "triggers": [trigger()] if triggers is None else triggers,
         "actions": [{"action": "alert", "severity": severity}]}
    a.update(over)
    return a


class EvaluatorBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.evaluate_automations(timestamp with time zone)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0271 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id[-4:]}@evaluator.test"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))

        self.cur.execute("INSERT INTO public.areas (name) VALUES ('Test_0271_Machining') RETURNING id;")
        area = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.cells (name, area_id) VALUES ('Test_0271_Cell', %s) RETURNING id;", (area,))
        cell = self.cur.fetchone()[0]
        self.sparkplug = {}
        for device, name in ((DEV_A, "Test_0271_Lathe_3"), (DEV_B, "Test_0271_Lathe_4")):
            self.cur.execute("INSERT INTO public.devices (id, name, cell_id) VALUES (%s, %s, %s) RETURNING sparkplug_id;",
                             (device, name, cell))
            self.sparkplug[device] = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 10), (%s, 10), (%s, 11);",
                         (METRIC, METRIC_2, METRIC_FLAG))
        # An hour back, so a run a few minutes on is still in the past.
        self.cur.execute("SELECT date_trunc('second', now()) - interval '1 hour';")
        self.t0 = self.cur.fetchone()[0]

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- the historian -----------------------------------------------------------------------
    def stand_in(self):
        """A local table where the foreign telemetry_latest is, for this transaction."""
        self.owner()
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry_latest CASCADE;"
            "CREATE TABLE timescale.telemetry_latest ("
            ' "time" timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,'
            " val_double double precision, val_string text, val_bool boolean);")

    def reading(self, value, device=DEV_A, metric=METRIC, **columns):
        self.owner()
        self.cur.execute("DELETE FROM timescale.telemetry_latest WHERE asset_id = %s AND metric_name = %s;",
                         (self.sparkplug[device], metric))
        self.cur.execute(
            "INSERT INTO timescale.telemetry_latest (\"time\", asset_id, metric_name, val_double, val_string, val_bool)"
            " VALUES (%s, %s, %s, %s, %s, %s);",
            (self.t0, self.sparkplug[device], metric, value, columns.get("text"), columns.get("flag")))

    def silence(self, device=DEV_A, metric=METRIC):
        """The historian returns no value for the pair."""
        self.owner()
        self.cur.execute("DELETE FROM timescale.telemetry_latest WHERE asset_id = %s AND metric_name = %s;",
                         (self.sparkplug[device], metric))

    # ---- people ------------------------------------------------------------------------------
    def owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    def as_person(self, user_id, sql, args=()):
        self.cur.execute("SAVEPOINT evaluator_call;")
        try:
            self.cur.execute("RESET ROLE;")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": "authenticated", "aal": "aal1",
                                          "email": f"{user_id[-4:]}@evaluator.test"}),))
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT evaluator_call;")
            raise
        finally:
            self.owner()
        self.cur.execute("RELEASE SAVEPOINT evaluator_call;")
        return rows

    def apply(self, *documents):
        results = self.as_person(MANAGER_ID, "SELECT public.apply_automations(%s::jsonb, false);",
                                 (Json(list(documents)),))[0][0]
        self.assertEqual([r["status"] for r in results], ["new"] * len(documents), results)
        return results

    def trigger_id(self, key="spindle", device=DEV_A):
        self.owner()
        self.cur.execute("SELECT t.id FROM public.automation_triggers t JOIN public.automations a ON a.id = t.automation_id"
                         " WHERE a.key = %s AND t.entity_id = %s;", (key, device))
        return self.cur.fetchone()[0]

    # ---- the evaluator -----------------------------------------------------------------------
    def at(self, seconds):
        return self.t0 + timedelta(seconds=seconds)

    def evaluate(self, seconds=0):
        self.owner()
        self.cur.execute("SELECT public.evaluate_automations(%s);", (self.at(seconds),))
        return self.cur.fetchone()[0]

    def alerts(self, trigger_id, device=DEV_A, metric=METRIC):
        self.owner()
        self.cur.execute(
            "SELECT status, starts_at, ends_at, last_confirmed_at FROM public.platform_alerts"
            " WHERE fingerprint = public.automation_alert_fingerprint(%s, %s, %s) ORDER BY starts_at;",
            (trigger_id, device, metric))
        return self.cur.fetchall()

    def state(self, trigger_id, device=DEV_A, metric=METRIC):
        self.owner()
        self.cur.execute(
            "SELECT pending_since, firing_since, last_evaluated_at, last_value, last_observed_at, comparison, threshold"
            "  FROM public.automation_trigger_states WHERE trigger_id = %s AND entity_id = %s AND metric_name = %s;",
            (trigger_id, device, metric))
        return self.cur.fetchone()

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, str(caught.exception))
        return caught.exception


class Standing(EvaluatorBase):
    """With a local table for the historian."""

    def setUp(self):
        super().setUp()
        self.stand_in()


class TheRead(Standing):
    def test_a_breaching_pair_is_a_row_in_the_shape_platform_health_rows_answers(self):
        self.apply(automation())
        self.reading(91.5)
        self.cur.execute("SELECT condition, sparkplug_id, subject, value, detail, trigger_id, entity_id, metric_name"
                         "  FROM public.machine_condition_rows();")
        self.assertEqual(self.cur.fetchall(), [
            ("threshold", self.sparkplug[DEV_A], "Test_0271_Lathe_3", Decimal("91.5"),
             f"{METRIC} is 91.5, above 80", self.trigger_id(), DEV_A, METRIC)])
        self.cur.execute("SELECT pg_get_function_result('public.machine_condition_rows()'::regprocedure),"
                         "       pg_get_function_result('public.platform_health_rows()'::regprocedure);")
        rows, health = self.cur.fetchone()
        self.assertTrue(rows.startswith(health[:-1]), "the first five columns are platform_health_rows()'s")

    def test_every_pair_with_a_value_is_read_and_only_the_breaching_ones_are_rows(self):
        self.apply(automation(triggers=[trigger(DEV_A, above=80), trigger(DEV_B, below=10, **{"above": None})]))
        self.reading(70, DEV_A)
        self.reading(5, DEV_B)
        self.cur.execute("SELECT entity_id::text, value, breached FROM public.machine_condition_readings() ORDER BY entity_id;")
        self.assertEqual(self.cur.fetchall(), [(DEV_A, 70.0, False), (DEV_B, 5.0, True)])
        self.cur.execute("SELECT entity_id::text FROM public.machine_condition_rows();")
        self.assertEqual(self.cur.fetchall(), [(DEV_B,)])

    def test_above_and_below_are_strict(self):
        self.apply(automation(triggers=[trigger(DEV_A, above=80), trigger(DEV_B, below=10, **{"above": None})]))
        self.reading(80, DEV_A)
        self.reading(10, DEV_B)
        self.cur.execute("SELECT count(*) FROM public.machine_condition_rows();")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_no_reading_is_not_a_breach(self):
        self.apply(automation())
        self.cur.execute("SELECT count(*) FROM public.machine_condition_readings();")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_a_nan_a_flag_and_a_text_are_no_reading(self):
        self.apply(automation(triggers=[trigger(DEV_A), trigger(DEV_B)]))
        self.reading(float("nan"), DEV_A)
        self.reading(None, DEV_B, flag=True)
        self.cur.execute("SELECT count(*) FROM public.machine_condition_readings();")
        self.assertEqual(self.cur.fetchone()[0], 0)
        self.reading(None, DEV_B, text="hot")
        self.cur.execute("SELECT count(*) FROM public.machine_condition_readings();")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_the_value_is_compared_whenever_it_arrived(self):
        self.apply(automation())
        self.owner()
        self.cur.execute("INSERT INTO timescale.telemetry_latest (\"time\", asset_id, metric_name, val_double)"
                         " VALUES (now() - interval '40 days', %s, %s, 99);", (self.sparkplug[DEV_A], METRIC))
        self.cur.execute("SELECT value, breached FROM public.machine_condition_readings();")
        self.assertEqual(self.cur.fetchall(), [(99.0, True)])

    def test_only_a_live_pair_is_read(self):
        self.apply(automation("a-live", triggers=[trigger(DEV_A)]), automation("b-off", triggers=[trigger(DEV_B)], enabled=False))
        self.reading(99, DEV_A)
        self.reading(99, DEV_B)
        self.cur.execute("SELECT entity_id::text FROM public.machine_condition_readings();")
        self.assertEqual(self.cur.fetchall(), [(DEV_A,)], "a disabled automation is not read")
        self.owner()
        self.cur.execute("UPDATE public.automation_triggers SET is_archived = true, archived_at = now() WHERE entity_id = %s;", (DEV_A,))
        self.cur.execute("SELECT count(*) FROM public.machine_condition_readings();")
        self.assertEqual(self.cur.fetchone()[0], 0, "an archived trigger is not read")

    def test_an_archived_device_is_not_read(self):
        self.apply(automation(triggers=[trigger(DEV_A), trigger(DEV_B)]))
        self.reading(99, DEV_A)
        self.reading(99, DEV_B)
        self.as_person(MANAGER_ID, "UPDATE public.devices SET is_archived = true, archived_at = now() WHERE id = %s;", (DEV_B,))
        self.cur.execute("SELECT entity_id::text FROM public.machine_condition_readings();")
        self.assertEqual(self.cur.fetchall(), [(DEV_A,)])

    def test_each_metric_is_its_own_pair_and_a_device_with_both_is_read_for_each(self):
        self.apply(automation(triggers=[trigger(DEV_A, METRIC), trigger(DEV_A, METRIC_2, above=50), trigger(DEV_B, METRIC_2, above=50)]))
        self.reading(91, DEV_A, METRIC)
        self.reading(40, DEV_A, METRIC_2)
        self.reading(60, DEV_B, METRIC_2)
        self.reading(99, DEV_B, METRIC)  # nothing watches this pair
        self.cur.execute("SELECT entity_id::text, metric_name, breached FROM public.machine_condition_readings()"
                         " ORDER BY metric_name, entity_id;")
        self.assertEqual(self.cur.fetchall(), [(DEV_A, METRIC_2, False), (DEV_B, METRIC_2, True), (DEV_A, METRIC, True)])

    def test_no_api_role_may_execute_either_function_or_the_evaluator(self):
        for signature in ("machine_condition_rows()", "machine_condition_readings()",
                          "evaluate_automations(timestamp with time zone)"):
            with self.subTest(function=signature):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                                 "       has_function_privilege('authenticated', %s, 'EXECUTE'),"
                                 "       has_function_privilege('service_role', %s, 'EXECUTE');",
                                 (f"public.{signature}",) * 3)
                self.assertEqual(self.cur.fetchone(), (False, False, False))
        self.assertRefused("42501", self.as_person, MANAGER_ID, "SELECT public.evaluate_automations();")


class TheHold(Standing):
    def test_a_breach_fires_when_it_has_held_and_not_before(self):
        self.apply(automation())
        t = self.trigger_id()
        self.reading(91)
        for seconds in (0, 60, 240):
            self.evaluate(seconds)
            self.assertEqual(self.alerts(t), [], f"at {seconds} s the breach is five minutes short")
        self.assertEqual(self.state(t)[:2], (self.at(0), None))
        self.evaluate(299)
        self.assertEqual(self.alerts(t), [])
        self.evaluate(300)
        alerts = self.alerts(t)
        self.assertEqual([(a[0], a[1], a[2]) for a in alerts], [("firing", self.at(300), None)])
        self.assertEqual(self.state(t)[:2], (None, self.at(300)))

    def test_a_hold_of_nothing_fires_at_the_first_run(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"])

    def test_a_hold_shorter_than_the_interval_fires_at_the_next_run(self):
        self.apply(automation(triggers=[trigger(**{"for": "30s"})]))
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.assertEqual(self.alerts(t), [])
        self.evaluate(60)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"])
        self.assertEqual(self.alerts(t)[0][1], self.at(60), "the run that found the hold served, not the breach's start")

    def test_a_breach_that_stops_first_never_fires_and_the_next_starts_the_hold_again(self):
        self.apply(automation())
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.evaluate(120)
        self.reading(70)
        self.evaluate(180)
        self.assertEqual(self.state(t)[:2], (None, None))
        self.reading(95)
        self.evaluate(240)
        self.assertEqual(self.state(t)[:2], (self.at(240), None), "the hold starts again from this breach")
        self.evaluate(420)
        self.assertEqual(self.alerts(t), [], "nine minutes since the first breach, three since this one")
        self.evaluate(540)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"])

    def test_a_changed_threshold_starts_the_hold_again(self):
        self.apply(automation())
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.evaluate(240)
        self.owner()
        self.cur.execute("UPDATE public.automation_triggers SET threshold = 85 WHERE id = %s;", (t,))
        self.evaluate(300)
        self.assertEqual(self.alerts(t), [], "the five minutes were served against 80, not 85")
        self.assertEqual(self.state(t)[0], self.at(300))
        self.assertEqual(self.state(t)[6], 85.0)
        self.evaluate(600)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"])

    def test_a_shorter_hold_than_the_one_the_breach_began_under_fires_at_the_next_run(self):
        self.apply(automation())
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.owner()
        self.cur.execute("UPDATE public.automation_triggers SET hold_seconds = 60 WHERE id = %s;", (t,))
        self.evaluate(60)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"])


class TheAlert(Standing):
    def fire(self, **over):
        self.apply(automation(**over))
        t = self.trigger_id()
        self.reading(91.5)
        self.evaluate(0)
        self.evaluate(300)
        return t

    def test_it_is_one_occurrence_in_the_shape_the_webhook_writes(self):
        t = self.fire(severity="critical")
        self.cur.execute(
            "SELECT fingerprint, entity_type, entity_id::text, sparkplug_id, alert_name, severity, status, summary,"
            "       starts_at, ends_at, rule_uid, labels, \"values\", acknowledged_at, last_confirmed_at"
            "  FROM public.platform_alerts WHERE fingerprint LIKE %s;", (f"condition:{t}:%",))
        (fingerprint, entity_type, entity_id, sparkplug_id, name, severity, status, summary, starts, ends, rule_uid,
         labels, values, acknowledged, confirmed), = self.cur.fetchall()
        self.assertEqual(fingerprint, f"condition:{t}:{DEV_A}:{METRIC}")
        self.assertEqual((entity_type, entity_id, sparkplug_id), ("device", DEV_A, self.sparkplug[DEV_A]))
        self.assertEqual((name, severity, status), ("Spindle bearing hot", "critical", "firing"))
        self.assertEqual(summary, f"Test_0271_Lathe_3: {METRIC} is 91.5, above 80 for 5m")
        self.assertEqual((starts, ends, rule_uid, acknowledged), (self.at(300), None, None, None))
        self.assertEqual(labels, {"severity": "critical", "entity_type": "device", "metric": METRIC,
                                  "automation": "spindle", "trigger_id": str(t)})
        self.assertEqual(values, {"value": 91.5, "threshold": 80})
        self.assertEqual(confirmed, self.at(300))

    def test_the_summary_leaves_out_a_hold_of_nothing_and_says_below(self):
        self.apply(automation(triggers=[trigger(**{"for": None, "above": None, "below": 10})]))
        t = self.trigger_id()
        self.reading(4)
        self.evaluate(0)
        self.cur.execute("SELECT summary FROM public.platform_alerts WHERE fingerprint LIKE %s;", (f"condition:{t}:%",))
        self.assertEqual(self.cur.fetchone()[0], f"Test_0271_Lathe_3: {METRIC} is 4, below 10")

    def test_a_run_confirms_every_row_it_holds_firing(self):
        t = self.fire()
        self.evaluate(360)
        self.assertEqual(self.alerts(t)[0][3], self.at(360))
        self.evaluate(420)
        self.assertEqual(self.alerts(t)[0][3], self.at(420))
        self.assertEqual(len(self.alerts(t)), 1, "a repeat is no new occurrence")

    def test_it_resolves_when_the_value_stops_breaching(self):
        t = self.fire()
        self.reading(79.9)
        self.evaluate(360)
        self.assertEqual([(a[0], a[2]) for a in self.alerts(t)], [("resolved", self.at(360))])
        self.assertEqual(self.state(t)[:2], (None, None))
        self.evaluate(420)
        self.assertEqual(self.alerts(t)[0][3], self.at(300), "a resolved row is confirmed by nobody")

    def test_each_firing_is_its_own_occurrence(self):
        t = self.fire()
        self.reading(70)
        self.evaluate(360)
        self.reading(95)
        self.evaluate(420)
        self.evaluate(720)
        alerts = self.alerts(t)
        self.assertEqual([(a[0], a[1], a[2]) for a in alerts],
                         [("resolved", self.at(300), self.at(360)), ("firing", self.at(720), None)])

    def test_a_resolved_alert_follows_its_firing_message_into_the_queue(self):
        t = self.fire()
        self.cur.execute("SELECT count(*) FROM public.notification_deliveries d JOIN public.platform_alerts a ON a.id = d.alert_id"
                         " WHERE a.fingerprint LIKE %s;", (f"condition:{t}:%",))
        queued_for_firing = self.cur.fetchone()[0]
        self.reading(70)
        self.evaluate(360)
        self.cur.execute("SELECT count(*) FROM public.notification_deliveries d JOIN public.platform_alerts a ON a.id = d.alert_id"
                         " WHERE a.fingerprint LIKE %s;", (f"condition:{t}:%",))
        # No channel is configured in the db lane, so nothing is queued for either; with one, the
        # resolve is queued for each channel that was queued the firing message.
        self.assertEqual(self.cur.fetchone()[0], queued_for_firing)

    def test_an_alert_the_lifecycle_resolved_is_fired_again_when_the_pair_still_breaches(self):
        t = self.fire(triggers=[trigger(**{"for": None})])
        self.owner()
        self.cur.execute("UPDATE public.platform_alerts SET status = 'resolved', ends_at = now()"
                         " WHERE fingerprint LIKE %s;", (f"condition:{t}:%",))
        self.evaluate(360)
        alerts = self.alerts(t)
        self.assertEqual([a[0] for a in alerts], ["resolved", "firing"], "the state does not claim a firing nobody holds")
        self.assertEqual(alerts[1][1], self.at(360))

    def test_an_open_alert_the_state_does_not_know_is_adopted_not_doubled(self):
        t = self.fire()
        self.owner()
        self.cur.execute("DELETE FROM public.automation_trigger_states WHERE trigger_id = %s;", (t,))
        self.evaluate(360)
        self.evaluate(420)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"], "one open row for one fingerprint")
        self.assertEqual(self.state(t)[:2], (None, self.at(300)))
        self.reading(70)
        self.evaluate(480)
        self.assertEqual([a[0] for a in self.alerts(t)], ["resolved"])

    def test_a_confirmed_row_is_reminded_and_one_the_run_stopped_confirming_is_not(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        t = self.trigger_id()
        self.reading(91)
        self.owner()
        self.cur.execute("SELECT public.evaluate_automations();")
        self.cur.execute("SELECT public.platform_alert_is_confirmed(a) FROM public.platform_alerts a WHERE fingerprint LIKE %s;",
                         (f"condition:{t}:%",))
        self.assertEqual(self.cur.fetchone()[0], True)
        self.cur.execute("UPDATE public.platform_alerts SET last_confirmed_at = now() - interval '6 minutes'"
                         " WHERE fingerprint LIKE %s;", (f"condition:{t}:%",))
        self.cur.execute("SELECT public.platform_alert_is_confirmed(a) FROM public.platform_alerts a WHERE fingerprint LIKE %s;",
                         (f"condition:{t}:%",))
        self.assertEqual(self.cur.fetchone()[0], False)

    def test_one_run_judges_many_pairs_on_their_own(self):
        self.apply(automation(triggers=[trigger(DEV_A, **{"for": None}), trigger(DEV_B, **{"for": None})]),
                   automation("load", triggers=[trigger(DEV_A, METRIC_2, **{"for": None, "above": 50})], severity="info"))
        a, b, c = self.trigger_id(device=DEV_A), self.trigger_id(device=DEV_B), self.trigger_id("load")
        self.reading(91, DEV_A)
        self.reading(60, DEV_B)
        self.reading(40, DEV_A, METRIC_2)
        self.assertEqual(self.evaluate(0), 3)
        self.assertEqual([x[0] for x in self.alerts(a)], ["firing"])
        self.assertEqual(self.alerts(b, DEV_B), [])
        self.assertEqual(self.alerts(c, DEV_A, METRIC_2), [])
        self.reading(85, DEV_B)
        self.reading(90, DEV_A, METRIC_2)
        self.evaluate(60)
        self.assertEqual([x[0] for x in self.alerts(b, DEV_B)], ["firing"])
        self.assertEqual([x[0] for x in self.alerts(c, DEV_A, METRIC_2)], ["firing"])
        self.cur.execute("SELECT severity FROM public.platform_alerts WHERE fingerprint = public.automation_alert_fingerprint(%s, %s, %s);",
                         (c, DEV_A, METRIC_2))
        self.assertEqual(self.cur.fetchone()[0], "info")


class Silence(Standing):
    def test_a_value_that_does_not_change_still_fires_after_its_hold(self):
        self.apply(automation())
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.evaluate(300)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"], "report by exception sends nothing while it holds")

    def test_a_pair_with_no_value_leaves_a_firing_alert_standing_and_confirmed(self):
        self.apply(automation())
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.evaluate(300)
        before = self.state(t)
        self.silence()
        self.evaluate(360)
        self.evaluate(420)
        self.assertEqual([(a[0], a[2], a[3]) for a in self.alerts(t)], [("firing", None, self.at(420))])
        self.assertEqual(self.state(t), before, "nothing was read, so nothing was written")

    def test_a_pair_with_no_value_neither_starts_nor_clears_a_pending_breach(self):
        self.apply(automation())
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.silence()
        self.evaluate(120)
        self.assertEqual(self.state(t)[0], self.at(0), "silence did not clear it")
        self.evaluate(300)
        self.assertEqual(self.alerts(t), [])
        self.reading(91)
        self.evaluate(360)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"], "the hold was served from the first breach")

    def test_a_pair_with_no_value_never_starts_one(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        t = self.trigger_id()
        self.evaluate(0)
        self.evaluate(600)
        self.assertEqual(self.alerts(t), [])
        self.assertIsNone(self.state(t))


class TheLifecycle(Standing):
    def test_a_disabled_automation_raises_nothing_and_its_state_goes(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"])
        self.as_person(MANAGER_ID, "SELECT public.set_automation_enabled('spindle', false);")
        self.assertEqual([a[0] for a in self.alerts(t)], ["resolved"], "0257 resolves it as the switch goes off")
        self.evaluate(60)
        self.assertEqual([a[0] for a in self.alerts(t)], ["resolved"])
        self.assertIsNone(self.state(t))
        self.as_person(MANAGER_ID, "SELECT public.set_automation_enabled('spindle', true);")
        self.evaluate(120)
        self.assertEqual([a[0] for a in self.alerts(t)], ["resolved", "firing"], "turned on again, it starts afresh")

    def test_a_disabled_automation_raises_nothing_at_all(self):
        self.apply(automation(triggers=[trigger(**{"for": None})], enabled=False))
        t = self.trigger_id()
        self.reading(91)
        self.assertEqual(self.evaluate(0), 0)
        self.assertEqual(self.alerts(t), [])
        self.assertIsNone(self.state(t))

    def test_an_archived_trigger_raises_nothing_and_its_state_goes(self):
        self.apply(automation(triggers=[trigger(DEV_A, **{"for": None}), trigger(DEV_B, **{"for": None})]))
        a, b = self.trigger_id(device=DEV_A), self.trigger_id(device=DEV_B)
        self.reading(91, DEV_A)
        self.reading(91, DEV_B)
        self.evaluate(0)
        self.as_person(MANAGER_ID, "UPDATE public.devices SET is_archived = true, archived_at = now() WHERE id = %s;", (DEV_B,))
        self.evaluate(60)
        self.assertEqual([x[0] for x in self.alerts(b, DEV_B)], ["resolved"])
        self.assertIsNone(self.state(b, DEV_B))
        self.assertEqual([x[0] for x in self.alerts(a, DEV_A)], ["firing"], "its other device is untouched")
        self.as_person(MANAGER_ID, "UPDATE public.devices SET is_archived = false, archived_at = NULL WHERE id = %s;", (DEV_B,))
        self.evaluate(120)
        self.assertEqual([x[0] for x in self.alerts(b, DEV_B)], ["resolved", "firing"],
                         "the automation is still on, so a restored device's trigger is read again")

    def test_restoring_a_device_enables_nothing(self):
        self.apply(automation(triggers=[trigger(DEV_B, **{"for": None})]))
        t = self.trigger_id(device=DEV_B)
        self.reading(91, DEV_B)
        self.as_person(MANAGER_ID, "UPDATE public.devices SET is_archived = true, archived_at = now() WHERE id = %s;", (DEV_B,))
        self.as_person(MANAGER_ID, "UPDATE public.devices SET is_archived = false, archived_at = NULL WHERE id = %s;", (DEV_B,))
        self.assertEqual(self.evaluate(0), 0, "its last trigger went with the device, so the automation was turned off")
        self.assertEqual(self.alerts(t, DEV_B), [])

    def test_a_trigger_given_another_metric_leaves_an_old_row_that_cannot_fire(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        t = self.trigger_id()
        self.reading(91)
        self.reading(5, DEV_A, METRIC_2)
        self.evaluate(0)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"])
        self.owner()
        self.cur.execute("UPDATE public.automation_triggers SET metric_name = %s, threshold = 50 WHERE id = %s;", (METRIC_2, t))
        self.assertEqual([a[0] for a in self.alerts(t)], ["resolved"], "0257 resolves the old fingerprint")
        self.assertIsNotNone(self.state(t), "the old row is still there until the next run")
        self.reading(91)  # the old pair still breaches, and nothing watches it now
        self.evaluate(60)
        self.assertEqual([a[0] for a in self.alerts(t)], ["resolved"], "the old pair is not read, so it cannot fire")
        self.assertIsNone(self.state(t))
        self.assertIsNotNone(self.state(t, DEV_A, METRIC_2))
        self.assertEqual(self.alerts(t, DEV_A, METRIC_2), [])
        self.reading(60, DEV_A, METRIC_2)
        self.evaluate(120)
        self.assertEqual([a[0] for a in self.alerts(t, DEV_A, METRIC_2)], ["firing"])

    def test_a_trigger_given_another_device_leaves_an_old_row_that_cannot_fire(self):
        self.apply(automation(triggers=[trigger(DEV_A, **{"for": None})]))
        t = self.trigger_id()
        self.reading(91, DEV_A)
        self.reading(91, DEV_B)
        self.evaluate(0)
        self.owner()
        self.cur.execute("UPDATE public.automation_triggers SET entity_id = %s WHERE id = %s;", (DEV_B, t))
        self.evaluate(60)
        self.assertIsNone(self.state(t, DEV_A))
        self.assertEqual([a[0] for a in self.alerts(t, DEV_A)], ["resolved"])
        self.assertEqual([a[0] for a in self.alerts(t, DEV_B)], ["firing"])

    def test_deleting_an_automation_takes_its_state_and_its_alerts(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        t = self.trigger_id()
        self.reading(91)
        self.evaluate(0)
        self.as_person(MANAGER_ID, "SELECT public.delete_automation('spindle');")
        self.assertEqual([a[0] for a in self.alerts(t)], ["resolved"])
        self.assertIsNone(self.state(t))
        self.assertEqual(self.evaluate(60), 0)

    def test_a_trigger_of_another_kind_is_not_read(self):
        self.apply(automation())
        self.owner()
        self.cur.execute("SELECT id FROM public.automations WHERE key = 'spindle';")
        auto = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.automation_triggers (automation_id, position, kind) VALUES (%s, 5, 'stopped_reporting');", (auto,))
        self.reading(91)
        self.assertEqual(self.evaluate(0), 1)


class AnOutage(EvaluatorBase):
    """The foreign telemetry_latest as the db lane has it: nothing answers, so a read raises on connect."""

    def not_evaluated(self):
        self.owner()
        self.cur.execute("SELECT status, severity, entity_type, entity_id, sparkplug_id, alert_name, summary, starts_at, ends_at,"
                         "       rule_uid, labels, last_confirmed_at FROM public.platform_alerts WHERE fingerprint = %s ORDER BY starts_at;",
                         (NOT_EVALUATED,))
        return self.cur.fetchall()

    def test_the_foreign_table_raises_when_nothing_answers(self):
        self.apply(automation())
        self.assertRefused("08001", lambda: (self.owner(), self.cur.execute("SELECT * FROM public.machine_condition_readings();")))

    def test_a_run_that_cannot_read_writes_nothing_but_the_one_alert(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        t = self.trigger_id()
        self.owner()
        # A firing alert and a state a run before the outage left.
        self.cur.execute("INSERT INTO public.automation_trigger_states (trigger_id, entity_id, metric_name, firing_since,"
                         " last_evaluated_at, last_value, comparison, threshold) VALUES (%s, %s, %s, %s, %s, 91, 'above', 80);",
                         (t, DEV_A, METRIC, self.at(-60), self.at(-60)))
        self.cur.execute("INSERT INTO public.platform_alerts (fingerprint, entity_type, entity_id, sparkplug_id, alert_name,"
                         " severity, status, starts_at, last_confirmed_at)"
                         " VALUES (public.automation_alert_fingerprint(%s, %s, %s), 'device', %s, %s, 'Spindle bearing hot',"
                         " 'warning', 'firing', %s, %s);", (t, DEV_A, METRIC, DEV_A, self.sparkplug[DEV_A], self.at(-60), self.at(-60)))
        state, alerts = self.state(t), self.alerts(t)
        self.assertEqual(self.evaluate(0), 0)
        self.assertEqual(self.state(t), state, "an outage fires nothing and resolves nothing")
        self.assertEqual(self.alerts(t), alerts, "not even a confirmation: nobody observed it")
        (status, severity, entity_type, entity_id, sparkplug_id, name, summary, starts, ends, rule_uid, labels, confirmed), = self.not_evaluated()
        self.assertEqual((status, severity, entity_type, entity_id, sparkplug_id), ("firing", "warning", "platform", None, None))
        self.assertEqual((name, starts, ends, rule_uid, confirmed), ("Automations Not Evaluated", self.at(0), None, None, self.at(0)))
        self.assertEqual(labels, {"severity": "warning", "entity_type": "platform"})
        self.assertRegex(summary, r"^The historian could not be read \(SQLSTATE 08001\), so no automation was judged\.")

    def test_it_is_one_alert_for_as_long_as_the_outage_lasts(self):
        self.apply(automation())
        self.evaluate(0)
        self.evaluate(60)
        self.evaluate(120)
        rows = self.not_evaluated()
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0][0], rows[0][7], rows[0][11]), ("firing", self.at(0), self.at(120)))

    def test_the_first_run_that_reads_resolves_it_and_a_later_outage_is_a_new_occurrence(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        t = self.trigger_id()
        self.evaluate(0)
        self.assertEqual([r[0] for r in self.not_evaluated()], ["firing"])
        self.stand_in()
        self.reading(91)
        self.evaluate(60)
        rows = self.not_evaluated()
        self.assertEqual([(r[0], r[8]) for r in rows], [("resolved", self.at(60))])
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"], "and the read it made counted")
        self.owner()
        self.cur.execute("DROP TABLE timescale.telemetry_latest;"
                         "CREATE FOREIGN TABLE timescale.telemetry_latest (\"time\" timestamptz NOT NULL, asset_id text NOT NULL,"
                         " metric_name text NOT NULL, val_double double precision, val_string text, val_bool boolean)"
                         " SERVER timescaledb_server OPTIONS (schema_name 'public', table_name 'telemetry_latest');")
        self.evaluate(120)
        self.assertEqual([(r[0], r[7]) for r in self.not_evaluated()], [("resolved", self.at(0)), ("firing", self.at(120))])

    def test_nothing_to_read_is_no_outage(self):
        self.evaluate(0)
        self.assertEqual(self.not_evaluated(), [])
        self.apply(automation(enabled=False))
        self.assertEqual(self.evaluate(60), 0)
        self.assertEqual(self.not_evaluated(), [], "no live trigger asks the historian anything, so none can fail")

    def test_an_outage_with_nothing_left_to_read_resolves_the_alert_it_raised(self):
        self.apply(automation())
        self.evaluate(0)
        self.assertEqual([r[0] for r in self.not_evaluated()], ["firing"])
        self.as_person(MANAGER_ID, "SELECT public.delete_automation('spindle');")
        self.evaluate(60)
        self.assertEqual([r[0] for r in self.not_evaluated()], ["resolved"])


class TheStateTable(Standing):
    def test_every_signed_in_role_reads_it_and_anon_does_not(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        self.reading(91)
        self.evaluate(0)
        for user_id in (OPERATOR_ID, MANAGER_ID):
            with self.subTest(user=user_id):
                self.assertEqual(self.as_person(user_id, "SELECT count(*) FROM public.automation_trigger_states WHERE metric_name = %s;",
                                                (METRIC,)), [(1,)])
        self.cur.execute("SAVEPOINT anon_read;")
        self.cur.execute("SET LOCAL ROLE anon;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT count(*) FROM public.automation_trigger_states;")
        self.cur.execute("ROLLBACK TO SAVEPOINT anon_read;")

    def test_nobody_writes_it_directly(self):
        self.apply(automation(triggers=[trigger(**{"for": None})]))
        self.reading(91)
        self.evaluate(0)
        for statement in ("UPDATE public.automation_trigger_states SET firing_since = NULL;",
                          "DELETE FROM public.automation_trigger_states;",
                          "INSERT INTO public.automation_trigger_states (trigger_id, entity_id, metric_name, last_evaluated_at,"
                          " comparison, threshold) VALUES (gen_random_uuid(), gen_random_uuid(), 'x', now(), 'above', 1);"):
            for user_id in (OPERATOR_ID, MANAGER_ID):
                with self.subTest(user=user_id, statement=statement):
                    self.assertRefused("42501", self.as_person, user_id, statement)

    def test_it_holds_its_checks(self):
        self.apply(automation())
        t = self.trigger_id()
        for statement in (
                "UPDATE public.automation_trigger_states SET pending_since = now(), firing_since = now();",
                "UPDATE public.automation_trigger_states SET comparison = 'equals';"):
            self.reading(91)
            self.evaluate(0)
            self.owner()
            with self.subTest(statement=statement):
                self.cur.execute("SAVEPOINT check_row;")
                with self.assertRaises(psycopg2.errors.CheckViolation):
                    self.cur.execute(statement)
                self.cur.execute("ROLLBACK TO SAVEPOINT check_row;")
        self.assertIsNotNone(self.state(t))


class TheJob(EvaluatorBase):
    def test_it_is_scheduled_once_every_minute(self):
        self.cur.execute("SELECT schedule, command, active FROM cron.job WHERE jobname = 'evaluate_automations';")
        self.assertEqual(self.cur.fetchall(), [("* * * * *", "SELECT public.evaluate_automations()", True)])

    def test_the_confirmation_window_of_a_condition_is_the_interval_and_a_margin(self):
        self.cur.execute("SELECT public.platform_alert_confirmation_window('condition:x'),"
                         "       public.platform_alert_confirmation_window(public.automation_alert_fingerprint(gen_random_uuid(), gen_random_uuid(), 'm')),"
                         "       public.platform_alert_confirmation_window(%s),"
                         "       public.platform_alert_confirmation_window('a3f9c2e17b');", (NOT_EVALUATED,))
        self.assertEqual(self.cur.fetchone(), (timedelta(minutes=5), timedelta(minutes=5), timedelta(minutes=5), timedelta(hours=13)))

    def test_a_second_run_at_the_same_time_finds_nothing_to_do(self):
        self.owner()
        self.cur.execute("SELECT pg_try_advisory_xact_lock(hashtextextended('evaluate_automations', 0));")
        self.assertTrue(self.cur.fetchone()[0])
        # Another session holds it: the run returns at once without reading anything.
        other = get_connection()
        try:
            with other.cursor() as cur:
                cur.execute("SELECT public.evaluate_automations();")
                self.assertEqual(cur.fetchone()[0], 0)
        finally:
            other.rollback()
            other.close()


# ---- a real historian ------------------------------------------------------------------------
# ABER_TEST_HISTORIAN=host:port:password names a historian built as lint-historian.mjs builds it
# (the init scripts, then the maintenance files), reachable from the database under test as `host`.
# The suite points the foreign server at it for one transaction and writes readings through the
# foreign telemetry table, so the evaluator reads them in the same remote transaction and the
# rollback takes them away again. The CI lane has none.
HISTORIAN = os.getenv("ABER_TEST_HISTORIAN", "")


@unittest.skipUnless(HISTORIAN, "ABER_TEST_HISTORIAN names no historian")
class ARealHistorian(EvaluatorBase):
    def setUp(self):
        super().setUp()
        host, port, password = HISTORIAN.split(":", 2)
        self.cur.execute("ALTER SERVER timescaledb_server OPTIONS (SET host %s, SET port %s, SET dbname 'postgres', SET sslmode 'disable');",
                         (host, port))
        self.cur.execute("ALTER USER MAPPING FOR postgres SERVER timescaledb_server OPTIONS (SET user 'postgres', SET password %s);",
                         (password,))
        # The historian's readings name an asset it knows, which no foreign table here writes.
        self.cur.execute("CREATE FOREIGN TABLE timescale.test_assets (asset_id text NOT NULL, asset_name text)"
                         " SERVER timescaledb_server OPTIONS (schema_name 'public', table_name 'assets');")
        for device in self.sparkplug.values():
            self.cur.execute("INSERT INTO timescale.test_assets (asset_id, asset_name) VALUES (%s, 'Test_0271');", (device,))

    def publish(self, device, metric, value, ago="1 minute"):
        self.cur.execute("INSERT INTO timescale.telemetry (time, asset_id, metric_name, val_double)"
                         " VALUES (now() - %s::interval, %s, %s, %s);", (ago, self.sparkplug[device], metric, value))

    def test_the_newest_value_of_each_series_is_read_and_compared(self):
        self.apply(automation(triggers=[trigger(DEV_A, **{"for": None}), trigger(DEV_B, **{"for": None})]),
                   automation("load", triggers=[trigger(DEV_A, METRIC_2, **{"for": None, "above": 50})]))
        self.publish(DEV_A, METRIC, 99, "2 hours")
        self.publish(DEV_A, METRIC, 70, "1 hour")        # the newest value is below the threshold
        self.publish(DEV_B, METRIC, 85)
        self.publish(DEV_A, METRIC_2, 60)
        self.publish(DEV_B, METRIC_2, 99)               # nothing watches this pair
        self.cur.execute("SELECT entity_id::text, metric_name, value, breached FROM public.machine_condition_readings()"
                         " ORDER BY metric_name, entity_id;")
        self.assertEqual(self.cur.fetchall(), [(DEV_A, METRIC_2, 60.0, True), (DEV_A, METRIC, 70.0, False), (DEV_B, METRIC, 85.0, True)])

    def test_it_fires_and_resolves_against_the_historian(self):
        self.apply(automation(triggers=[trigger(**{"for": "1m"})]))
        t = self.trigger_id()
        self.publish(DEV_A, METRIC, 91)
        self.evaluate(0)
        self.assertEqual(self.alerts(t), [])
        self.evaluate(60)
        self.assertEqual([a[0] for a in self.alerts(t)], ["firing"])
        self.publish(DEV_A, METRIC, 70, "10 seconds")
        self.evaluate(120)
        self.assertEqual([a[0] for a in self.alerts(t)], ["resolved"])

    def test_the_filter_reaches_the_historian_once_for_each_metric(self):
        self.apply(automation(triggers=[trigger(DEV_A, METRIC), trigger(DEV_B, METRIC), trigger(DEV_A, METRIC_2, above=50)]))
        self.owner()
        # The join's own shape, with the arrays and the metric the function holds in variables.
        self.cur.execute(
            "EXPLAIN (VERBOSE, COSTS OFF) SELECT l.asset_id FROM public.automation_triggers t"
            " JOIN public.devices d ON d.id = t.entity_id"
            " JOIN timescale.telemetry_latest l ON l.asset_id = d.sparkplug_id AND l.metric_name = t.metric_name"
            " WHERE t.metric_name = 'm' AND l.asset_id = ANY (ARRAY['a', 'b']) AND l.metric_name = 'm';")
        remote = [line for (line,) in self.cur.fetchall() if "Remote SQL" in line]
        self.assertEqual(len(remote), 1, "one remote query")
        self.assertIn("asset_id = ANY", remote[0])
        self.assertIn("metric_name = ", remote[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
