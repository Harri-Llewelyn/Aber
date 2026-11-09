"""
A threshold automation fires and resolves against the running stack (0270, 0271).

A Shopfloor Manager, a seeded person, applies an automation through PostgREST on a device this suite
makes. A breaching reading is written into the historian, and the suite waits for pg_cron's
evaluator to raise the alert: one occurrence, named for the automation, about the device, with its
labels and values and no Grafana rule. A later run confirms it. A normal reading is written and the
suite waits for the run that resolves it. Only the running stack has the whole path: pg_cron in the
platform database, its postgres_fdw link to the historian, and the Row Level Security PostgREST
applies to the person reading the alert back.

    python supabase/test_a_threshold_automation_fires_and_resolves.py

Needs SUPABASE_PUBLISHABLE_KEY and kubectl for the release (KUBE_NAMESPACE, default aber), as the
other stack suites do. Skips, with its reason, when the seeded Shopfloor Manager is absent or the
second factor is required of managers (a script cannot give a code), or when the historian cannot
be reached.

Each wait is bounded by the evaluator's interval: a minute, and a margin. The suite makes a device,
a metric in the catalogue, a reading in the historian and an automation, and removes them all at the
end, however it ends. The Audit Trail keeps its rows: the automation's creation and deletion, and the
device's.
"""
import json
import os
import sys
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-harness"))
import stack_exec  # noqa: E402
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
MANAGER = "manager@aber.local"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")

# The evaluator runs every minute; a wait is that and a margin for a slow run.
WAIT_SECONDS = 150
POLL_SECONDS = 5

stack_exec.TARGETS["historian"] = {"workload": "statefulset/timescaledb", "container": "timescaledb",
                                   "service": "timescaledb"}


def request(path, method="GET", token=None, body=None):
    """One call through the gateway: (status, parsed JSON or text)."""
    headers = {"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{SUPABASE_URL}{path}", method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            status, text = response.status, response.read().decode()
    except urllib.error.HTTPError as err:
        with err:
            status, text = err.code, err.read().decode()
    try:
        return status, json.loads(text) if text else None
    except ValueError:
        return status, text


def platform_sql(sql):
    return stack_exec.output("supabase-db", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql).strip()


def historian_sql(sql):
    return stack_exec.output("historian", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql).strip()


class ThresholdAutomation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not PUBLISHABLE_KEY:
            raise unittest.SkipTest("SUPABASE_PUBLISHABLE_KEY is unset; run this through `dev-cluster test`.")
        cls.created = {"automation": False, "trigger": None, "device": None, "metric": None, "asset": None}
        status, body = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, MANAGER, PASSWORD)
        if status == stack_sign_in.NO_SUCH_ACCOUNT:
            reason = f"could not sign in as {MANAGER} ({status}); the seed personas are absent"
            if STRICT:
                raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(reason)
        if status != 200:
            raise AssertionError(stack_sign_in.describe(MANAGER, status, body))
        cls.token = body["access_token"]
        try:
            platform_sql("SELECT 1;")
            historian_sql("SELECT 1;")
        except (RuntimeError, OSError) as err:
            raise unittest.SkipTest(f"the platform database or the historian cannot be reached with kubectl: {err}")
        suffix = uuid.uuid4().hex[:8]
        cls.metric = f"Test_0271_Stack/Spindle_{suffix}"
        cls.device_id = str(uuid.uuid4())
        cls.automation_key = f"probe{suffix}"
        cls.alias = f"Stack probe {suffix}"
        cls.created["metric"] = cls.metric
        platform_sql(f"INSERT INTO public.metric_catalog (name, datatype) VALUES ('{cls.metric}', 10);")
        cls.created["device"] = cls.device_id
        cls.sparkplug_id = platform_sql(
            f"INSERT INTO public.devices (id, name) VALUES ('{cls.device_id}', 'Stack probe {suffix}') RETURNING sparkplug_id;"
        ).splitlines()[0].strip()
        cls.created["asset"] = cls.sparkplug_id
        historian_sql(f"INSERT INTO assets (asset_id, asset_name) VALUES ('{cls.sparkplug_id}', 'Stack probe') ON CONFLICT DO NOTHING;")

    @classmethod
    def tearDownClass(cls):
        created = getattr(cls, "created", None)
        if not created:
            return
        # Each step on its own, so one that fails leaves the others done.
        steps = []
        if created["automation"]:
            steps.append(lambda: request("/rest/v1/rpc/delete_automation", "POST", cls.token,
                                         {"p_key": cls.automation_key}))
        if created["trigger"]:
            # The newest occurrence of a fingerprint is kept for ever, so the rows go with the suite.
            steps.append(lambda: platform_sql(
                f"DELETE FROM public.platform_alerts WHERE fingerprint LIKE 'condition:{created['trigger']}:%';"))
        if created["asset"]:
            steps.append(lambda: historian_sql(f"DELETE FROM telemetry WHERE asset_id = '{created['asset']}';"))
            steps.append(lambda: historian_sql(f"DELETE FROM assets WHERE asset_id = '{created['asset']}';"))
        if created["device"]:
            steps.append(lambda: platform_sql(f"DELETE FROM public.devices WHERE id = '{created['device']}';"))
        if created["metric"]:
            steps.append(lambda: platform_sql(f"DELETE FROM public.metric_catalog WHERE name = '{created['metric']}';"))
        errors = []
        for step in steps:
            try:
                step()
            except Exception as err:  # noqa: BLE001 -- every step runs; the first failure is reported
                errors.append(str(err))
        if errors:
            raise AssertionError("the suite could not remove everything it made: " + "; ".join(errors))

    def publish(self, value):
        historian_sql(f"INSERT INTO telemetry (time, asset_id, metric_name, val_double) "
                      f"VALUES (now(), '{self.sparkplug_id}', '{self.metric}', {value});")

    def alerts(self):
        fingerprint = urllib.parse.quote(f"like.condition:{self.trigger_id}:*", safe=".:*")
        status, rows = request(
            f"/rest/v1/platform_alerts?fingerprint={fingerprint}&order=starts_at.asc"
            "&select=status,alert_name,severity,entity_type,sparkplug_id,rule_uid,labels,values,summary,starts_at,"
            "ends_at,last_confirmed_at,fingerprint", token=self.token)
        self.assertEqual(status, 200, rows)
        return rows

    def wait_for(self, what, test):
        deadline = time.time() + WAIT_SECONDS
        while time.time() < deadline:
            found = test()
            if found:
                return found
            time.sleep(POLL_SECONDS)
        self.fail(f"{what}: not seen within {WAIT_SECONDS} s; pg_cron's evaluate_automations() runs every minute")

    def test_an_automation_fires_is_confirmed_and_resolves(self):
        cls = type(self)
        status, results = request("/rest/v1/rpc/apply_automations", "POST", self.token, {
            "p_dry_run": False,
            "p_doc": [{"id": self.automation_key, "alias": self.alias, "enabled": True,
                       "triggers": [{"trigger": "threshold", "device": self.device_id, "metric": self.metric,
                                     "above": 80, "for": "0s"}],
                       "actions": [{"action": "alert", "severity": "warning"}]}]})
        if status == 403 and "mfa_required" in json.dumps(results):
            raise unittest.SkipTest("security.require_mfa_for_managers is on, and a script cannot give a code")
        self.assertEqual(status, 200, results)
        self.assertEqual(results[0]["status"], "new", results)
        cls.created["automation"] = True
        status, rows = request(f"/rest/v1/automation_triggers?entity_id=eq.{self.device_id}&select=id", token=self.token)
        self.assertEqual((status, len(rows)), (200, 1), rows)
        cls.trigger_id = rows[0]["id"]
        cls.created["trigger"] = self.trigger_id

        # A breaching reading, and the run that raises it.
        self.publish(95)
        firing = self.wait_for("the firing alert", lambda: [a for a in self.alerts() if a["status"] == "firing"])
        self.assertEqual(len(firing), 1, "one occurrence for one firing")
        alert = firing[0]
        self.assertEqual(alert["fingerprint"], f"condition:{self.trigger_id}:{self.device_id}:{self.metric}")
        self.assertEqual((alert["alert_name"], alert["severity"], alert["entity_type"], alert["sparkplug_id"]),
                         (self.alias, "warning", "device", self.sparkplug_id))
        self.assertIsNone(alert["rule_uid"], "no Grafana rule")
        self.assertEqual(alert["labels"], {"severity": "warning", "entity_type": "device", "metric": self.metric,
                                           "automation": self.automation_key, "trigger_id": self.trigger_id})
        self.assertEqual(alert["values"], {"value": 95, "threshold": 80})
        self.assertIn(self.metric, alert["summary"])
        self.assertIsNone(alert["ends_at"])
        self.assertIsNotNone(alert["last_confirmed_at"])

        # The state every role reads.
        status, states = request(f"/rest/v1/automation_trigger_states?trigger_id=eq.{self.trigger_id}"
                                 "&select=pending_since,firing_since,last_value,comparison,threshold", token=self.token)
        self.assertEqual(status, 200, states)
        self.assertEqual([(s["last_value"], s["comparison"], s["threshold"], s["pending_since"]) for s in states],
                         [(95, "above", 80, None)])
        self.assertIsNotNone(states[0]["firing_since"])

        # The next run confirms it again and opens no second row.
        confirmed = alert["last_confirmed_at"]
        again = self.wait_for("a later confirmation", lambda: [a for a in self.alerts()
                                                               if a["status"] == "firing" and a["last_confirmed_at"] > confirmed])
        self.assertEqual(len(self.alerts()), 1)
        self.assertEqual(again[0]["starts_at"], alert["starts_at"])

        # A normal reading, and the run that resolves it.
        self.publish(60)
        resolved = self.wait_for("the resolved alert", lambda: [a for a in self.alerts() if a["status"] == "resolved"])
        self.assertEqual(len(self.alerts()), 1)
        self.assertEqual(resolved[0]["starts_at"], alert["starts_at"])
        self.assertIsNotNone(resolved[0]["ends_at"])
        status, states = request(f"/rest/v1/automation_trigger_states?trigger_id=eq.{self.trigger_id}"
                                 "&select=pending_since,firing_since,last_value", token=self.token)
        self.assertEqual((status, states), (200, [{"pending_since": None, "firing_since": None, "last_value": 60}]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
