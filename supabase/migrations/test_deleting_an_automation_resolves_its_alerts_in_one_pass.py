"""
Deleting an automation resolves its alerts in one pass (0257, 0287).

    python supabase/migrations/test_deleting_an_automation_resolves_its_alerts_in_one_pass.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * One resolve for a delete. Deleting an automation with 2,000 triggers and 1,000 firing alerts
    updates platform_alerts in ONE statement, not once for each trigger, and takes well under a
    second and a half. The count is what catches a return to a call for each row on any machine; the
    time is the bound the issue asked for (0.1 to 0.2 seconds where it was written, and 3 seconds or
    more with a call for each row).
  * What a delete resolves: the alerts of the trigger deleted, of every trigger of the automation
    deleted, and of a trigger that goes with its device. It resolves them as an occurrence ends,
    with an end that is not before its start.
  * What it leaves alone: a sibling trigger's alert, another automation's, a rule's, the outage
    alert a run that cannot read the historian raises, and an occurrence already resolved.
  * The update arm is as it was: a trigger archived, or given another device or metric, resolves its
    alerts; one given another threshold resolves nothing.
  * The trigger an alert names, which automation_alert_trigger_id() reads out of what
    automation_alert_fingerprint() composes, and no API role may run either.
  * The real path: a Shopfloor Manager deleting through delete_automation().

EVERY TEST ROLLS BACK. platform_alerts is in the realtime publication: a committed row reaches
every connected dashboard as a firing alert.
"""
import json
import os
import time
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MANAGER_ID = "a0d17287-0000-4000-8000-0000000287a1"
SWITCH = "security.require_mfa_for_managers"
METRIC = "Test_0287/Spindle_Temperature"
METRIC_2 = "Test_0287/Spindle_Load"

TRIGGERS = 2000
FIRING = 1000
BOUND_SECONDS = 1.5


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class ResolveBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.automation_alert_trigger_id(text)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0287 is not applied to this database")
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 10), (%s, 10);", (METRIC, METRIC_2))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def devices(self, count, prefix="Test_0287_Device_"):
        self.cur.execute(
            "INSERT INTO public.devices (name) SELECT %s || g FROM generate_series(1, %s) g RETURNING id;",
            (prefix, count))
        return [r[0] for r in self.cur.fetchall()]

    def automation(self, key, devices, metric=METRIC):
        """An automation with a threshold trigger for each device, in the order given. Returns its id
        and its trigger ids in that order."""
        self.cur.execute("INSERT INTO public.automations (key, alias) VALUES (%s, %s) RETURNING id;", (key, f"Test 0287 {key}"))
        automation = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO public.automation_triggers (automation_id, \"position\", device_position, kind, entity_id,"
            "       metric_name, comparison, threshold)"
            " SELECT %s, 0, d.n - 1, 'threshold', d.id, %s, 'above', 80"
            "   FROM unnest(%s::uuid[]) WITH ORDINALITY d(id, n) RETURNING id, device_position;",
            (automation, metric, [str(d) for d in devices]))
        return automation, [r[0] for r in sorted(self.cur.fetchall(), key=lambda r: r[1])]

    def firing(self, trigger_id, device_id, metric=METRIC, status="firing"):
        """The occurrence the evaluator writes for one trigger and device, firing since an hour ago."""
        self.cur.execute(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, entity_id, sparkplug_id, alert_name,"
            "       severity, status, starts_at, ends_at)"
            " SELECT public.automation_alert_fingerprint(%s, d.id, %s), 'device', d.id, d.sparkplug_id, 'Spindle hot',"
            "        'warning', %s, now() - interval '1 hour', CASE WHEN %s = 'resolved' THEN now() - interval '30 minutes' END"
            "   FROM public.devices d WHERE d.id = %s RETURNING id;",
            (trigger_id, metric, status, status, device_id))
        return self.cur.fetchone()[0]

    def other_alert(self, fingerprint, status="firing"):
        self.cur.execute(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, alert_name, severity, status, starts_at, ends_at)"
            " VALUES (%s, 'platform', 'Other', 'warning', %s, now() - interval '1 hour',"
            "         CASE WHEN %s = 'resolved' THEN now() - interval '30 minutes' END) RETURNING id;",
            (fingerprint, status, status))
        return self.cur.fetchone()[0]

    def status(self, alert_id):
        self.cur.execute(
            "SELECT status, ends_at IS NOT NULL AND ends_at >= starts_at FROM public.platform_alerts WHERE id = %s;",
            (alert_id,))
        return self.cur.fetchone()

    def assertResolved(self, alert_id, message=None):
        self.assertEqual(self.status(alert_id), ("resolved", True), message)

    def assertFiring(self, alert_id, message=None):
        self.assertEqual(self.status(alert_id)[0], "firing", message)


class ADeleteResolvesOnce(ResolveBase):
    def count_updates(self):
        """From here on, each UPDATE statement of platform_alerts adds one to a counter. A statement
        trigger fires once for a statement whatever rows it touches, and for none it touches."""
        self.cur.execute("CREATE TABLE public.zz_test_0287_updates (n integer NOT NULL);")
        self.cur.execute("INSERT INTO public.zz_test_0287_updates VALUES (0);")
        self.cur.execute(
            "CREATE FUNCTION public.zz_test_0287_count() RETURNS trigger LANGUAGE plpgsql AS"
            " $$ BEGIN UPDATE public.zz_test_0287_updates SET n = n + 1; RETURN NULL; END $$;")
        self.cur.execute(
            "CREATE TRIGGER zz_test_0287_count AFTER UPDATE ON public.platform_alerts"
            " FOR EACH STATEMENT EXECUTE FUNCTION public.zz_test_0287_count();")

    def updates(self):
        self.cur.execute("SELECT n FROM public.zz_test_0287_updates;")
        return self.cur.fetchone()[0]

    def test_deleting_an_automation_with_two_thousand_triggers_resolves_in_one_statement_and_in_time(self):
        devices = self.devices(TRIGGERS)
        automation, triggers = self.automation("test-0287-large", devices)
        self.cur.execute(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, entity_id, sparkplug_id, alert_name,"
            "       severity, status, starts_at, ends_at)"
            " SELECT public.automation_alert_fingerprint(t.id, t.entity_id, t.metric_name), 'device', d.id, d.sparkplug_id,"
            "        'Spindle hot', 'warning', CASE WHEN t.device_position < %s THEN 'firing' ELSE 'resolved' END,"
            "        now() - interval '1 hour',"
            "        CASE WHEN t.device_position < %s THEN NULL ELSE now() - interval '30 minutes' END"
            "   FROM public.automation_triggers t JOIN public.devices d ON d.id = t.entity_id"
            "  WHERE t.automation_id = %s AND t.device_position < %s;",
            (FIRING, FIRING, automation, FIRING + 10))

        # A sibling automation, a rule's alert and the outage alert, which the delete leaves alone.
        (other_device,) = self.devices(1, "Test_0287_Other_")
        _, (other_trigger,) = self.automation("test-0287-other", [other_device], METRIC_2)
        others = [self.firing(other_trigger, other_device, METRIC_2),
                  self.other_alert("rule:test-0287-a-grafana-rule"),
                  self.other_alert("condition:not-evaluated")]
        self.cur.execute("ANALYZE public.platform_alerts; ANALYZE public.automation_triggers;")
        self.count_updates()

        began = time.perf_counter()
        self.cur.execute("DELETE FROM public.automations WHERE id = %s;", (automation,))
        elapsed = time.perf_counter() - began

        self.assertEqual(self.updates(), 1, "one resolve for the delete, not one for each trigger")
        self.assertLess(elapsed, BOUND_SECONDS,
                        f"deleting an automation with {TRIGGERS} triggers and {FIRING} firing alerts took {elapsed:.2f} s")
        self.cur.execute(
            "SELECT count(*) FILTER (WHERE status = 'resolved' AND ends_at >= starts_at), count(*) FILTER (WHERE status = 'firing')"
            "  FROM public.platform_alerts WHERE alert_name = 'Spindle hot' AND entity_id <> %s;", (other_device,))
        self.assertEqual(self.cur.fetchone(), (FIRING + 10, 0), "every alert of the deleted triggers is resolved, with an end")
        for alert in others:
            self.assertFiring(alert, "an alert that is not one of the deleted triggers' stays firing")
        self.cur.execute("SELECT count(*) FROM public.automation_triggers WHERE automation_id = %s;", (automation,))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_deleting_one_trigger_resolves_its_alert_and_no_other(self):
        devices = self.devices(3)
        automation, triggers = self.automation("test-0287-one", devices)
        alerts = [self.firing(triggers[i], devices[i]) for i in range(3)]
        self.cur.execute("DELETE FROM public.automation_triggers WHERE id = %s;", (triggers[1],))
        self.assertFiring(alerts[0], "a sibling trigger's alert")
        self.assertResolved(alerts[1])
        self.assertFiring(alerts[2], "a sibling trigger's alert")

    def test_deleting_several_triggers_in_one_statement_resolves_each_alert_once(self):
        devices = self.devices(4)
        automation, triggers = self.automation("test-0287-some", devices)
        alerts = [self.firing(triggers[i], devices[i]) for i in range(4)]
        self.count_updates()
        self.cur.execute("DELETE FROM public.automation_triggers WHERE id = ANY(%s::uuid[]);", ([str(t) for t in triggers[:3]],))
        self.assertEqual(self.updates(), 1)
        self.assertEqual([self.status(a)[0] for a in alerts], ["resolved", "resolved", "resolved", "firing"])

    def test_a_delete_that_deletes_nothing_resolves_nothing(self):
        devices = self.devices(2)
        _, triggers = self.automation("test-0287-none", devices)
        alert = self.firing(triggers[0], devices[0])
        self.count_updates()
        self.cur.execute("DELETE FROM public.automation_triggers WHERE id = %s;", ("00000000-0000-4000-8000-000000000287",))
        self.assertEqual(self.updates(), 0)
        self.assertFiring(alert)

    def test_an_occurrence_already_resolved_keeps_its_end(self):
        devices = self.devices(1)
        automation, triggers = self.automation("test-0287-done", devices)
        done = self.firing(triggers[0], devices[0], status="resolved")
        self.cur.execute("SELECT ends_at FROM public.platform_alerts WHERE id = %s;", (done,))
        ended = self.cur.fetchone()[0]
        self.cur.execute("DELETE FROM public.automations WHERE id = %s;", (automation,))
        self.cur.execute("SELECT status, ends_at FROM public.platform_alerts WHERE id = %s;", (done,))
        self.assertEqual(self.cur.fetchone(), ("resolved", ended))

    def test_every_alert_of_a_trigger_is_resolved_whatever_its_device_and_metric(self):
        """Resolved by the trigger the fingerprint names: any device, any metric."""
        devices = self.devices(2)
        automation, triggers = self.automation("test-0287-prefix", devices)
        first = self.firing(triggers[0], devices[0], METRIC)
        second = self.firing(triggers[0], devices[1], METRIC_2)
        self.cur.execute("DELETE FROM public.automations WHERE id = %s;", (automation,))
        self.assertResolved(first)
        self.assertResolved(second)

    def test_deleting_a_device_resolves_the_alerts_of_the_triggers_that_name_it(self):
        devices = self.devices(2)
        automation, triggers = self.automation("test-0287-device", devices)
        alerts = [self.firing(triggers[i], devices[i]) for i in range(2)]
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (devices[0],))
        self.assertResolved(alerts[0])
        self.assertFiring(alerts[1])

    def test_a_manager_deleting_an_automation_resolves_its_alerts(self):
        self.cur.execute("SELECT id FROM public.roles WHERE name = 'Shopfloor_Manager';")
        role = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, 'a0d17287@automations.test', 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                         (MANAGER_ID,))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s) ON CONFLICT (user_id, role_id) DO NOTHING;",
                         (MANAGER_ID, role))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))
        devices = self.devices(5)
        _, triggers = self.automation("test-0287-real", devices)
        alerts = [self.firing(triggers[i], devices[i]) for i in range(5)]
        survivor = self.other_alert("rule:test-0287-survivor")

        claims = {"sub": MANAGER_ID, "role": "authenticated", "aal": "aal1", "email": "a0d17287@automations.test"}
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute("SELECT public.delete_automation('test-0287-real');")
        self.cur.execute("RESET ROLE;")

        for alert in alerts:
            self.assertResolved(alert)
        self.assertFiring(survivor)
        self.cur.execute("SELECT count(*) FROM public.automations WHERE key = 'test-0287-real';")
        self.assertEqual(self.cur.fetchone()[0], 0)


class TheUpdateArmIsAsItWas(ResolveBase):
    def test_archiving_a_trigger_resolves_its_alert_and_no_other(self):
        devices = self.devices(2)
        _, triggers = self.automation("test-0287-archive", devices)
        alerts = [self.firing(triggers[i], devices[i]) for i in range(2)]
        self.cur.execute("UPDATE public.automation_triggers SET is_archived = true, archived_at = now() WHERE id = %s;",
                         (triggers[0],))
        self.assertResolved(alerts[0])
        self.assertFiring(alerts[1])

    def test_a_trigger_given_another_device_or_metric_resolves_its_alert(self):
        devices = self.devices(3)
        _, triggers = self.automation("test-0287-move", devices[:2])
        alerts = [self.firing(triggers[i], devices[i]) for i in range(2)]
        self.cur.execute("UPDATE public.automation_triggers SET entity_id = %s WHERE id = %s;", (devices[2], triggers[0]))
        self.assertResolved(alerts[0])
        self.cur.execute("UPDATE public.automation_triggers SET metric_name = %s WHERE id = %s;", (METRIC_2, triggers[1]))
        self.assertResolved(alerts[1])

    def test_a_new_threshold_resolves_nothing(self):
        devices = self.devices(1)
        _, triggers = self.automation("test-0287-threshold", devices)
        alert = self.firing(triggers[0], devices[0])
        self.cur.execute("UPDATE public.automation_triggers SET threshold = 95, hold_seconds = 60 WHERE id = %s;", (triggers[0],))
        self.assertFiring(alert)

    def test_turning_an_automation_off_resolves_the_alerts_of_every_trigger(self):
        devices = self.devices(3)
        automation, triggers = self.automation("test-0287-off", devices)
        alerts = [self.firing(triggers[i], devices[i]) for i in range(3)]
        survivor = self.other_alert("rule:test-0287-survivor-off")
        self.cur.execute("UPDATE public.automations SET enabled = false WHERE id = %s;", (automation,))
        for alert in alerts:
            self.assertResolved(alert)
        self.assertFiring(survivor)


class TheTriggerAnAlertNames(ResolveBase):
    TRIGGER = "9b2d8f0e-1c3a-4e5b-8a7d-000000000287"
    DEVICE = "7c1e6a9d-2b4f-4d3c-9e8a-000000000287"

    def read(self, fingerprint):
        self.cur.execute("SELECT public.automation_alert_trigger_id(%s);", (fingerprint,))
        return self.cur.fetchone()[0]

    def test_it_reads_what_the_fingerprint_function_composes(self):
        self.cur.execute("SELECT public.automation_alert_fingerprint(%s, %s, 'Spindle/Load'),"
                         "       public.automation_alert_fingerprint(%s, NULL, NULL);",
                         (self.TRIGGER, self.DEVICE, self.TRIGGER))
        whole, prefix = self.cur.fetchone()
        self.assertEqual(self.read(whole), self.TRIGGER)
        self.assertEqual(self.read(prefix), self.TRIGGER)

    def test_a_metric_with_a_slash_or_a_dash_is_read_the_same(self):
        for metric in ("Spindle/Load", "Press-1/Parts per hour", "Line 2/Tank_Level"):
            with self.subTest(metric=metric):
                self.cur.execute("SELECT public.automation_alert_fingerprint(%s, %s, %s);", (self.TRIGGER, self.DEVICE, metric))
                self.assertEqual(self.read(self.cur.fetchone()[0]), self.TRIGGER)

    def test_a_fingerprint_that_is_not_an_automations_names_no_trigger(self):
        for fingerprint in ("condition:not-evaluated", f"condition:{self.TRIGGER}", f"rule:{self.TRIGGER}:x",
                            "grafana:abc", "", None):
            with self.subTest(fingerprint=fingerprint):
                self.assertIsNone(self.read(fingerprint))

    def test_no_api_role_may_run_the_functions_of_the_resolve(self):
        for function in ("public.automation_alert_trigger_id(text)", "public.resolve_automation_alerts(uuid[])",
                         "public.automation_triggers_gone_resolve_their_alerts()",
                         "public.automation_trigger_resolves_its_alerts()"):
            for role in ("anon", "authenticated", "service_role"):
                with self.subTest(function=function, role=role):
                    self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE');", (role, function))
                    self.assertFalse(self.cur.fetchone()[0])

    def test_resolving_no_triggers_resolves_nothing(self):
        devices = self.devices(1)
        _, triggers = self.automation("test-0287-empty", devices)
        alert = self.firing(triggers[0], devices[0])
        for sql in ("SELECT public.resolve_automation_alerts(ARRAY[]::uuid[]);", "SELECT public.resolve_automation_alerts(NULL::uuid[]);"):
            self.cur.execute(sql)
            self.assertEqual(self.cur.fetchone()[0], 0)
        self.assertFiring(alert)


if __name__ == "__main__":
    unittest.main()
