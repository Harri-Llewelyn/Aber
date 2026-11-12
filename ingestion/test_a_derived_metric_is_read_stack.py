"""
A derived metric is read from real readings, and an automation on it fires and resolves (0282, 0283).

    python ingestion/test_a_derived_metric_is_read_stack.py

The unit suites hold each rule over local tables. This suite holds the whole path against the
running stack, in five steps:

  1. a fixture Host gateway and device, a measured counter and a derived counter rate built on it,
     both added to the catalogue as the database's owner;
  2. a Sparkplug 3.0.0 edge node in this process publishes as the gateway, with the credential the
     Gateways page issues: an NBIRTH, a DBIRTH of the device declaring the counter, and then a
     DDATA of a rising count every few seconds for a little over two minutes;
  3. once the minute that holds the last reading has ended, a Shopfloor Manager reads
     derived_series() and derived_current() through PostgREST. The rate of every minute the counter
     rose in is positive and none is carried, and the current value is the one worked out here from
     the raw readings, by the rule: the increase over the hour, over the minutes that have a
     predecessor;
  4. the manager applies an automation on the derived metric, and pg_cron's evaluator raises its
     alert: one occurrence named for the automation, about the device, with the value it read;
  5. the manager deletes the automation, and the alert resolves.

Needs the stack up, the environment test_playback_replay.py reads (its helpers are reused),
`SUPABASE_DB_*` for the owner connection, and the seeded Shopfloor Manager. It skips, with its
reason, when that person is absent or the second factor is required of managers (a script cannot
give a code). `REQUIRE_PLAYBACK_REPLAY=1` makes every skip a failure.

The whole run is about six minutes: the counter is published for two minutes, the minute that
holds the last reading must end before any read sees it, and pg_cron runs the evaluator once a
minute. Everything the suite made is removed afterwards, the historian rows, the alert rows and the
audit rows included.
"""

import json
import os
import secrets
import sys
import time
import traceback
import unittest
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

INGESTION = Path(__file__).resolve().parent
sys.path.insert(0, str(INGESTION))
sys.path.insert(0, str(INGESTION.parent / "test-harness"))

import stack_sign_in  # noqa: E402
import test_a_derived_name_is_dropped_stack as edge  # noqa: E402 -- the fixture edge node, as a module
from test_playback_replay import (  # noqa: E402
    PUBLISHABLE_KEY, SUPABASE_URL, Session, _request, historian, sign_in, skip_or_fail,
)
from test_playback_replay import setUpModule as stack_is_up  # noqa: E402
from test_recorded_capture_replay import delete_broker_account, owner_connection, poll  # noqa: E402

PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
MANAGER = "manager@aber.local"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")

# Pinned, so a run killed before its cleanup leaves rows the next run reclaims. They differ in the
# first hex block from each other and from every other fixture: `sparkplug_id` is the first 21 hex
# characters of the uuid.
GATEWAY_ID = "7c000000-0000-4000-8000-000000000001"
DEVICE_ID = "7d000000-0000-4000-8000-000000000001"

DOUBLE = 10
# The counter rises by this much with each reading, a reading every PACE seconds, for READINGS of them.
STEP = 5
PACE = 8
READINGS = 16
# The evaluator runs every minute; a wait is that and a margin.
WAIT_SECONDS = 150
POLL_SECONDS = 5
BIRTH_TIMEOUT = 45
HISTORIAN_TIMEOUT = 60

STAGES = ("the fixture", "the readings", "the reads")


def setUpModule():
    stack_is_up()
    if edge.IMPORT_ERROR is not None:
        skip_or_fail(f"paho-mqtt or the Sparkplug binding is unavailable ({edge.IMPORT_ERROR}); "
                     f"npm run proto generates ingestion/sparkplug_b_pb2.py")


def minute_of(moment):
    return moment.replace(second=0, microsecond=0)


class ADerivedMetricIsRead(unittest.TestCase):
    """One run, walked in setUpClass in three stages; each test asserts one fact about it."""

    @classmethod
    def setUpClass(cls):
        cls.reached = []
        cls.broken = None
        cls.session = cls.manager = cls.edge = cls.gateway = cls.device = cls.owner = None
        cls.catalogue_ids = []
        cls.trigger_id = None
        cls.automation_made = False
        group = "T324R" + secrets.token_hex(5)
        cls.measured = f"{group}/PART_COUNT"
        cls.derived = f"{group}/PARTS_PER_HOUR"
        cls.automation_key = "derived" + secrets.token_hex(4)
        cls.alias = f"Stack derived probe {cls.automation_key}"
        cls.addClassCleanup(cls._clean_up)
        for stage, step in zip(STAGES, (cls._fixture, cls._readings, cls._reads)):
            try:
                step()
            except unittest.SkipTest:
                raise
            except Exception as err:  # noqa: BLE001 -- every test needing the stage reports it
                traceback.print_exc()
                cls.broken = f"{stage} did not complete: {err}"
                return
            cls.reached.append(stage)

    def _needs(self, stage):
        if stage not in self.reached:
            self.fail(self.broken or f"{stage} was not reached")

    # ------------------------------------------------------------------------------------------
    # Stage 1: the manager, the catalogue rows, the fixture and its edge node
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _fixture(cls):
        status, body = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, MANAGER, PASSWORD)
        if status == stack_sign_in.NO_SUCH_ACCOUNT:
            reason = f"could not sign in as {MANAGER} ({status}); the seed personas are absent"
            if STRICT:
                raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(reason)
        if status != 200:
            raise AssertionError(stack_sign_in.describe(MANAGER, status, body))
        cls.manager = body["access_token"]
        cls.owner = owner_connection()
        cls.owner.autocommit = True
        with cls.owner.cursor() as cur:
            cur.execute("INSERT INTO public.metric_catalog (name, datatype, units) VALUES (%s, %s, 'COUNT')"
                        " ON CONFLICT (name) DO NOTHING RETURNING id", (cls.measured, DOUBLE))
            cls.catalogue_ids += [row[0] for row in cur.fetchall()]
            cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, %s)"
                        " ON CONFLICT (name) DO NOTHING RETURNING id",
                        (cls.derived, DOUBLE, json.dumps({"kind": "counter_rate", "input": cls.measured})))
            cls.catalogue_ids += [row[0] for row in cur.fetchall()]
        cls.session = Session(sign_in())
        cls.gateway = cls.session.upsert("gateways", {
            "id": GATEWAY_ID, "name": "DERIVED_READ_Gateway", "deployment": "host",
            "description": "Fixture for ingestion/test_a_derived_metric_is_read_stack.py. Safe to delete.",
        })
        cls.device = cls.session.upsert("devices", {
            "id": DEVICE_ID, "name": "DERIVED_READ_Device", "gateway_id": cls.gateway["id"],
            "description": "Fixture for ingestion/test_a_derived_metric_is_read_stack.py. Safe to delete.",
        })
        cls.asset = cls.device["sparkplug_id"]
        status, body = _request(
            f"{SUPABASE_URL}/functions/v1/gateway-credential", method="POST", body={"gateway_id": cls.gateway["id"]},
            headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {cls.session.token}", "Content-Type": "application/json"},
        )
        if status != 200 or not (body or {}).get("password"):
            raise AssertionError(f"could not issue the fixture gateway's broker credential: {status} {body}")
        cls.edge = cls._connect_edge_node(body["password"])

    @classmethod
    def _connect_edge_node(cls, password):
        """A new credential can take a moment to reach the running broker, so a refusal is retried."""
        deadline = time.monotonic() + edge.BROKER_ACCEPT_TIMEOUT
        while True:
            node = edge.SmallEdgeNode(cls.gateway["sparkplug_group"], cls.gateway["sparkplug_id"], password)
            try:
                rc = node.connect()
            except OSError as err:
                node.stop()
                raise AssertionError(f"cannot reach the broker ({err})")
            if rc == 0 and node.subscribed.is_set():
                return node
            node.stop()
            if time.monotonic() >= deadline:
                raise AssertionError(f"the broker did not accept the fixture gateway (CONNACK {rc})")
            time.sleep(2)

    # ------------------------------------------------------------------------------------------
    # Stage 2: the counter is born, and rises for a little over two minutes
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _readings(cls):
        cls.edge.birth(cls.asset, cls.device["name"], [cls.measured])

        def born():
            with cls.owner.cursor() as cur:
                cur.execute("SELECT last_birth_metrics FROM public.devices WHERE id = %s", (DEVICE_ID,))
                row = cur.fetchone()
            return (row or [[]])[0] or []
        if cls.measured not in poll(born, lambda names: cls.measured in names, BIRTH_TIMEOUT, 2):
            raise AssertionError(f"the daemon did not record the fixture device's DBIRTH within {BIRTH_TIMEOUT}s")
        cls.counts = []
        for i in range(READINGS):
            value = float(STEP * (i + 1))
            if not cls.edge.data(cls.asset, [cls.measured], [value]):
                raise AssertionError("a DDATA could not be handed to the broker")
            cls.counts.append(value)
            time.sleep(PACE)
        cls.stored = poll(cls._stored_rows, lambda rows: len(rows) >= READINGS, HISTORIAN_TIMEOUT, 2)
        if len(cls.stored) < READINGS:
            raise AssertionError(f"the historian holds {len(cls.stored)} of the {READINGS} readings published")

    @classmethod
    def _stored_rows(cls):
        """(time, value) of every reading of the counter, oldest first, from the historian."""
        conn = historian()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT time, val_double FROM telemetry WHERE asset_id = %s AND metric_name = %s"
                            " ORDER BY time", (cls.asset, cls.measured))
                return [(when, float(value)) for when, value in cur.fetchall()]
        finally:
            conn.close()

    # ------------------------------------------------------------------------------------------
    # Stage 3: the minute that holds the last reading ends, and the manager reads
    # ------------------------------------------------------------------------------------------
    def rpc(self, name, body):
        return _request(f"{SUPABASE_URL}/rest/v1/rpc/{name}", method="POST", body=body,
                        headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {self.manager}",
                                 "Content-Type": "application/json"})

    @classmethod
    def _reads(cls):
        last = cls.stored[-1][0]
        # Whole minutes only are read: wait for the minute that holds the last reading to end, and for
        # the one after it, which holds none and is read as carried.
        ends = minute_of(last) + timedelta(minutes=2)
        time.sleep(max(0.0, (ends - datetime.now(timezone.utc)).total_seconds()) + 3)
        started = minute_of(cls.stored[0][0])
        cls.window = (started - timedelta(minutes=1), ends)
        status, body = _request(
            f"{SUPABASE_URL}/rest/v1/rpc/derived_series", method="POST",
            body={"from_ts": cls.window[0].isoformat(), "to_ts": cls.window[1].isoformat(), "bucket": "1 minute",
                  "asset_ids": [cls.asset], "metric_names": [cls.derived]},
            headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {cls.manager}", "Content-Type": "application/json"},
        )
        cls.series = (status, body)
        status, body = _request(
            f"{SUPABASE_URL}/rest/v1/rpc/derived_current", method="POST",
            body={"asset_ids": [cls.asset], "metric_names": [cls.derived]},
            headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {cls.manager}", "Content-Type": "application/json"},
        )
        cls.current = (status, body)

    # ------------------------------------------------------------------------------------------
    # What the run showed
    # ------------------------------------------------------------------------------------------
    def test_a_manager_reads_the_derived_series(self):
        self._needs("the reads")
        status, rows = self.series
        self.assertEqual(status, 200, rows)
        self.assertTrue(rows, "derived_series() returned no row for the fixture device")
        self.assertEqual({r["metric_name"] for r in rows}, {self.derived})
        self.assertEqual({r["asset_id"] for r in rows}, {self.asset})

    def test_every_minute_the_counter_rose_in_has_a_positive_rate_that_is_not_carried(self):
        self._needs("the reads")
        _, rows = self.series
        rose = {minute_of(when) for when, _ in self.stored}
        read = {datetime.fromisoformat(r["bucket_ts"]): r for r in rows}
        # The first minute has no predecessor, so it has no rate of its own; every later one has.
        for minute in sorted(rose)[1:]:
            with self.subTest(minute=minute.isoformat()):
                self.assertIn(minute, read)
                self.assertGreater(read[minute]["avg_double"], 0)
                self.assertFalse(read[minute]["is_carried"])
                self.assertGreater(read[minute]["n_rows"], 0)

    def test_a_minute_after_the_last_reading_counts_nothing_and_says_it_is_carried(self):
        self._needs("the reads")
        _, rows = self.series
        last = minute_of(self.stored[-1][0])
        later = [r for r in rows if datetime.fromisoformat(r["bucket_ts"]) > last]
        self.assertTrue(later, "no minute after the last reading was read")
        for row in later:
            self.assertEqual((row["avg_double"], row["is_carried"], row["n_rows"]), (0, True, 0))

    def test_the_current_value_is_the_rate_over_the_hour_by_the_rule(self):
        self._needs("the reads")
        status, rows = self.current
        self.assertEqual(status, 200, rows)
        self.assertEqual(len(rows), 1, rows)
        got = rows[0]
        self.assertEqual((got["asset_id"], got["metric_name"], got["window_minutes"]), (self.asset, self.derived, 60))
        # Worked out from the raw readings: each minute's last value, the increases between the
        # consecutive minutes from the first reading's to the last whole minute (the counter held in
        # the quiet ones), over the hours of those minutes.
        by_minute = {}
        for when, value in self.stored:
            by_minute[minute_of(when)] = value
        first = min(by_minute)
        observed = datetime.fromisoformat(got["observed_at"])
        minutes = int((observed - first).total_seconds() // 60) - 1
        increase = by_minute[max(by_minute)] - by_minute[first]
        self.assertGreater(minutes, 0)
        self.assertAlmostEqual(got["value"], increase * 60 / minutes, delta=increase * 60 / minutes * 0.001)

    def test_a_measured_metric_is_refused_by_both(self):
        self._needs("the fixture")
        status, body = self.rpc("derived_series", {
            "from_ts": self.window[0].isoformat(), "to_ts": self.window[1].isoformat(), "bucket": "1 minute",
            "asset_ids": [self.asset], "metric_names": [self.measured]})
        self.assertEqual(status, 400, body)
        self.assertIn("is not a derived metric", json.dumps(body))
        status, body = self.rpc("derived_current", {"asset_ids": [self.asset], "metric_names": [self.measured]})
        self.assertEqual(status, 400, body)

    def test_an_automation_on_the_derived_metric_fires_with_its_value_and_resolves_when_deleted(self):
        self._needs("the reads")
        status, results = self.rpc("apply_automations", {
            "p_dry_run": False,
            "p_doc": [{"id": self.automation_key, "alias": self.alias, "enabled": True,
                       "triggers": [{"trigger": "threshold", "device": DEVICE_ID, "metric": self.derived,
                                     "above": 0, "for": "0s"}],
                       "actions": [{"action": "alert", "severity": "warning"}]}]})
        if status == 403 and "mfa_required" in json.dumps(results):
            raise unittest.SkipTest("security.require_mfa_for_managers is on, and a script cannot give a code")
        self.assertEqual(status, 200, results)
        self.assertEqual(results[0]["status"], "new", results)
        type(self).automation_made = True
        status, rows = self.get(f"/rest/v1/automation_triggers?entity_id=eq.{DEVICE_ID}&select=id")
        self.assertEqual((status, len(rows)), (200, 1), rows)
        type(self).trigger_id = rows[0]["id"]

        firing = self.wait_for("the firing alert", lambda: [a for a in self.alerts() if a["status"] == "firing"])
        self.assertEqual(len(firing), 1, "one occurrence for one firing")
        alert = firing[0]
        self.assertEqual(alert["fingerprint"], f"condition:{self.trigger_id}:{DEVICE_ID}:{self.derived}")
        self.assertEqual((alert["alert_name"], alert["severity"], alert["sparkplug_id"]), (self.alias, "warning", self.asset))
        self.assertIsNone(alert["rule_uid"], "no Grafana rule")
        self.assertGreater(alert["values"]["value"], 0)
        self.assertEqual(alert["values"]["threshold"], 0)
        self.assertIn(self.derived, alert["summary"])

        # The state every role reads names the minute the value was read at, not the last reading.
        status, states = self.get(f"/rest/v1/automation_trigger_states?trigger_id=eq.{self.trigger_id}"
                                  "&select=last_value,last_observed_at,comparison,threshold")
        self.assertEqual(status, 200, states)
        self.assertEqual(len(states), 1)
        observed = datetime.fromisoformat(states[0]["last_observed_at"])
        self.assertEqual(observed, minute_of(observed), "the value is read at a whole minute")
        self.assertGreater(states[0]["last_value"], 0)

        # Deleting the automation resolves what it raised.
        status, body = self.rpc("delete_automation", {"p_key": self.automation_key})
        self.assertEqual(status, 200, body)
        type(self).automation_made = False
        resolved = self.wait_for("the resolved alert", lambda: [a for a in self.alerts() if a["status"] == "resolved"])
        self.assertEqual(len(self.alerts()), 1)
        self.assertIsNotNone(resolved[0]["ends_at"])

    def get(self, path):
        return _request(f"{SUPABASE_URL}{path}", headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {self.manager}"})

    def alerts(self):
        fingerprint = urllib.parse.quote(f"like.condition:{self.trigger_id}:*", safe=".:*")
        status, rows = self.get(f"/rest/v1/platform_alerts?fingerprint={fingerprint}&order=starts_at.asc"
                                "&select=status,alert_name,severity,sparkplug_id,rule_uid,values,summary,starts_at,ends_at,fingerprint")
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

    # ------------------------------------------------------------------------------------------
    # Everything the suite made
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _clean_up(cls):
        if cls.edge is not None:
            cls.edge.stop()

        def attempt(what, action):
            try:
                action()
            except Exception as err:  # noqa: BLE001 -- cleanup must not mask a real failure
                print(f"cleanup warning: {what}: {err}")

        if cls.automation_made and cls.manager:
            attempt("the automation", lambda: _request(
                f"{SUPABASE_URL}/rest/v1/rpc/delete_automation", method="POST", body={"p_key": cls.automation_key},
                headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {cls.manager}", "Content-Type": "application/json"}))
        if cls.owner is not None and cls.trigger_id:
            # The newest occurrence of a fingerprint is kept for ever, so the rows go with the suite.
            attempt("the alert rows", lambda: cls._owner_sql(
                "DELETE FROM public.platform_alerts WHERE fingerprint LIKE %s", (f"condition:{cls.trigger_id}:%",)))
        if cls.session is not None:
            attempt("the device", lambda: cls.session.rest(f"/devices?id=eq.{DEVICE_ID}", method="DELETE"))
            attempt("the gateway", lambda: cls.session.rest(f"/gateways?id=eq.{GATEWAY_ID}", method="DELETE"))
        if cls.gateway:
            def drop_account():
                result = delete_broker_account(cls.gateway["sparkplug_id"])
                if result.returncode != 0:
                    raise RuntimeError(result.stderr.strip() or result.stdout.strip())
            attempt("the broker account", drop_account)
        if cls.device:
            attempt("the historian rows", cls._delete_telemetry)
        if cls.owner is not None:
            attempt("the catalogue and audit rows", cls._delete_owned_rows)
            attempt("the owner connection", cls.owner.close)

    @classmethod
    def _owner_sql(cls, sql, args=()):
        with cls.owner.cursor() as cur:
            cur.execute(sql, args)

    @classmethod
    def _delete_telemetry(cls):
        conn = historian()
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("DELETE FROM telemetry WHERE asset_id = %s", (cls.asset,))
            cur.execute("DELETE FROM assets WHERE asset_id = %s", (cls.asset,))
        conn.close()

    @classmethod
    def _delete_owned_rows(cls):
        with cls.owner.cursor() as cur:
            if cls.device:
                cur.execute("DELETE FROM public.asset_config WHERE asset_id = %s", (cls.asset,))
            # The derived row first: it names the counter it is built on.
            cur.execute("DELETE FROM public.metric_catalog WHERE name = %s", (cls.derived,))
            cur.execute("DELETE FROM public.metric_catalog WHERE name = %s", (cls.measured,))
            cur.execute("DELETE FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[])",
                        ([GATEWAY_ID, DEVICE_ID, *cls.catalogue_ids],))


if __name__ == "__main__":
    unittest.main(verbosity=2)
