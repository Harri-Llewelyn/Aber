# suite:
#   lanes: stack
#   why: Aber's dispatcher end to end (0247, 0248): a firing alert written with psql reaches a
#     receiver pod signed with the Standard Webhooks headers; an acknowledgement before the reminder
#     stops it, an unacknowledged alert is reminded, a resolve follows its firing message, and an
#     address whose host is not allowed is refused before anything is posted. Configures the webhook
#     as the database owner and puts back what the stack held. Needs kubectl, the functions image
#     with notification-dispatch, and NetworkPolicies off.

"""
Aber's dispatcher (0247, 0248), against the live stack: an alert reaches a webhook, signed.

WHAT IS UNDER TEST, end to end: a firing occurrence written to platform_alerts is queued by the
trigger, the queued row asks notification-dispatch for a pass through pg_net, and the pass posts a
CloudEvents event to a receiver, signed with the Standard Webhooks headers under the key this file
stored. An acknowledgement made before a reminder is sent stops it. A resolve arrives after its
firing message. An address whose host is not allowed is refused before anything is posted.

THE RECEIVER is a pod of the ingestion image, whose Python serves HTTP on 8080 and prints each
request as one JSON line; this file reads them with `kubectl logs`. The functions pod reaches it by
its pod IP, which is also the one allowed host. A stack with networkPolicy.enabled needs an
extraEgress rule from supabase-functions to that pod, and is skipped here.

THE WEBHOOK IS CONFIGURED AS THE DATABASE OWNER, with psql in the database's pod. The dev
Administrator has a second factor, so no script signs in as one. What the stack held before (the
address, the key and the three settings) is put back afterwards, and every occurrence this file
wrote is deleted with its messages. The settings changes and their restoration each leave an Audit
Trail row, as any change of a setting does.

Needs the stack up with notification-dispatch in the functions image, kubectl on the release's
namespace, and SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY. Skips without them.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \\
      python supabase/functions/notification-dispatch/test_notification_dispatch.py
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import time
import unittest
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "enroll-gateway"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "test-harness"))
from test_enroll_gateway import PUBLISHABLE_KEY, SERVICE_ROLE_KEY  # noqa: E402
import stack_exec  # noqa: E402  -- kubectl exec into the release's pods

RECEIVER = "notification-dispatch-receiver"
PORT = 8080
FINGERPRINT = "fp-stack-0247"
WAIT_SECONDS = int(os.getenv("NOTIFICATION_WAIT_SECONDS", "60"))
SETTING_KEYS = ("notifications.webhook_min_severity", "notifications.webhook_allowed_hosts", "notifications.reminder_hours")
VAULT_NAMES = ("notification_webhook_url", "notification_webhook_signing_key")

# Prints each request it is sent as one JSON line, and answers 204.
RECEIVER_PY = r"""
import http.server, json
class Hook(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()
        print(json.dumps({'path': self.path, 'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': body}), flush=True)
        self.send_response(204)
        self.end_headers()
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(('0.0.0.0', 8080), Hook).serve_forever()
"""


def kubectl(*args, check=True):
    result = subprocess.run(["kubectl", "-n", stack_exec.NAMESPACE, *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


def psql(sql):
    """One statement as postgres, the way the migrations run."""
    return stack_exec.output("supabase-db", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql).strip()


def literal(value):
    """A SQL string literal. Every value here is this file's own, never a caller's."""
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


def signature(key, msg_id, timestamp, body):
    raw = base64.b64decode(key[len("whsec_"):])
    mac = hmac.new(raw, f"{msg_id}.{timestamp}.{body}".encode(), hashlib.sha256).digest()
    return "v1," + base64.b64encode(mac).decode()


@unittest.skipIf(not SERVICE_ROLE_KEY or not PUBLISHABLE_KEY, "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY must be set")
class AnAlertReachesTheWebhook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not stack_exec.running("supabase-db"):
            raise unittest.SkipTest(f"{stack_exec.describe('supabase-db')} is not running")
        if psql("SELECT to_regprocedure('public.issue_notification_signing_key()') IS NOT NULL") != "t":
            raise unittest.SkipTest("0248 is not applied on this stack")
        if "default-deny" in kubectl("get", "networkpolicy", "-o", "name", check=False):
            raise unittest.SkipTest("NetworkPolicies are on: the functions pod needs an extraEgress rule to the receiver")

        # What the stack held, to put back.
        cls.saved_settings = {k: psql(f"SELECT value::text FROM public.system_settings WHERE key = {literal(k)}")
                              for k in SETTING_KEYS}
        cls.saved_vault = {n: psql(f"SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = {literal(n)}") or None
                           for n in VAULT_NAMES}

        started = stack_exec.run_probe(
            RECEIVER, stack_exec.default_probe_image(),
            "python -c \"import base64; exec(base64.b64decode('" + base64.b64encode(RECEIVER_PY.encode()).decode() + "'))\"",
            component="ingestion")
        if started.returncode != 0:
            raise unittest.SkipTest(f"the receiver pod did not start: {started.stderr.strip()}")
        kubectl("wait", "--for=condition=Ready", f"pod/{RECEIVER}", "--timeout=120s")
        cls.receiver_ip = kubectl("get", f"pod/{RECEIVER}", "-o", "jsonpath={.status.podIP}").strip()

        # The webhook, as an Administrator would set it: the address, a key, and the receiver's
        # host allowed. Written as the owner, so through the vault's own functions.
        cls.key = "whsec_" + base64.b64encode(secrets.token_bytes(32)).decode()
        cls.url = f"http://{cls.receiver_ip}:{PORT}/hook/{uuid.uuid4().hex}"
        cls.set_vault({"notification_webhook_url": cls.url, "notification_webhook_signing_key": cls.key})
        psql("UPDATE public.system_settings SET value = '\"warning\"' WHERE key = 'notifications.webhook_min_severity'")
        psql("UPDATE public.system_settings SET value = '12' WHERE key = 'notifications.reminder_hours'")
        psql("UPDATE public.system_settings SET value = " + literal(json.dumps([cls.receiver_ip]))
             + "::jsonb WHERE key = 'notifications.webhook_allowed_hosts'")

    @classmethod
    def tearDownClass(cls):
        try:
            psql(f"DELETE FROM public.platform_alerts WHERE fingerprint LIKE {literal(FINGERPRINT + '%')}")
            for key, value in cls.saved_settings.items():
                if value:
                    psql(f"UPDATE public.system_settings SET value = {literal(value)}::jsonb WHERE key = {literal(key)}"
                         f" AND value IS DISTINCT FROM {literal(value)}::jsonb")
            cls.set_vault(cls.saved_vault)
        finally:
            stack_exec.remove_probe(RECEIVER)

    @classmethod
    def set_vault(cls, values):
        for name, value in values.items():
            psql(f"DELETE FROM vault.secrets WHERE name = {literal(name)}")
            if value:
                psql(f"SELECT vault.create_secret({literal(value)}, {literal(name)}, 'test_notification_dispatch.py')")

    # -- helpers -------------------------------------------------------------------------------
    def fire(self, suffix, severity="critical"):
        fingerprint = f"{FINGERPRINT}-{suffix}-{uuid.uuid4().hex[:8]}"
        return psql(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, alert_name, severity, status, summary,"
            "  starts_at, labels, last_confirmed_at)"
            f" VALUES ({literal(fingerprint)}, 'platform', 'Notification dispatch test', {literal(severity)}, 'firing',"
            "  'Written by test_notification_dispatch.py.', now(), '{\"alertname\": \"Notification dispatch test\"}', now())"
            " RETURNING id").splitlines()[0]

    def received(self, alert_id=None, event_type=None):
        lines = kubectl("logs", f"pod/{RECEIVER}", check=False).splitlines()
        out = []
        for line in lines:
            try:
                request = json.loads(line)
                event = json.loads(request["body"])
            except (ValueError, KeyError):
                continue
            if alert_id and (event.get("data") or {}).get("alert_id") != alert_id:
                continue
            if event_type and event.get("type") != event_type:
                continue
            out.append((request, event))
        return out

    def wait_for(self, alert_id, event_type):
        deadline = time.time() + WAIT_SECONDS
        while time.time() < deadline:
            got = self.received(alert_id, event_type)
            if got:
                return got
            time.sleep(2)
        self.fail(f"no {event_type} for {alert_id} reached the receiver in {WAIT_SECONDS}s; the queue holds "
                  + psql(f"SELECT string_agg(event || ':' || state || ':' || coalesce(last_error, ''), ', ')"
                         f" FROM public.notification_deliveries WHERE alert_id = {literal(alert_id)}"))

    def state(self, alert_id, event):
        return psql(f"SELECT state FROM public.notification_deliveries WHERE alert_id = {literal(alert_id)}"
                    f" AND event = {literal(event)} ORDER BY created_at DESC LIMIT 1")

    def wait_for_state(self, alert_id, event, wanted):
        deadline = time.time() + WAIT_SECONDS
        while time.time() < deadline:
            if self.state(alert_id, event) in wanted:
                return self.state(alert_id, event)
            time.sleep(2)
        self.fail(f"the {event} message for {alert_id} is {self.state(alert_id, event)!r}, not one of {wanted}")

    # -- the tests -----------------------------------------------------------------------------
    def test_a_firing_alert_arrives_signed(self):
        alert_id = self.fire("firing")
        request, event = self.wait_for(alert_id, "aber.alert.firing")[0]
        headers = request["headers"]
        self.assertTrue(request["path"].startswith("/hook/"), "posted to the address, path and all")
        self.assertTrue(headers["content-type"].startswith("application/cloudevents+json"))
        self.assertEqual(headers["webhook-id"], event["id"])
        self.assertEqual(headers["webhook-signature"],
                         signature(self.key, headers["webhook-id"], headers["webhook-timestamp"], request["body"]))
        self.assertLess(abs(time.time() - int(headers["webhook-timestamp"])), 300)
        self.assertEqual([event["specversion"], event["datacontenttype"]], ["1.0", "application/json"])
        self.assertEqual([event["data"]["name"], event["data"]["severity"], event["data"]["subject"]["type"]],
                         ["Notification dispatch test", "critical", "platform"])
        self.assertEqual(self.wait_for_state(alert_id, "firing", ("sent",)), "sent")

    def test_an_acknowledgement_before_the_reminder_stops_it(self):
        alert_id = self.fire("acknowledged")
        self.wait_for(alert_id, "aber.alert.firing")
        self.wait_for_state(alert_id, "firing", ("sent",))
        # The firing message sent 13 hours ago: a reminder is due.
        psql("UPDATE public.notification_deliveries SET finished_at = now() - interval '13 hours'"
             f" WHERE alert_id = {literal(alert_id)} AND event = 'firing'")
        # A reminder queued but not yet due, then the acknowledgement, then due: the decision drops
        # it as it is about to be sent. The columns are written as the owner, since no script signs
        # in as a person here; acknowledge_alert() writes the same columns.
        psql("INSERT INTO public.notification_deliveries (alert_id, event, channel, next_attempt_at)"
             f" VALUES ({literal(alert_id)}, 'reminder', 'webhook', now() + interval '1 hour')")
        psql("UPDATE public.platform_alerts SET acknowledged_at = now(), acknowledged_by = gen_random_uuid(),"
             f" acknowledgement_reason = 'investigating' WHERE id = {literal(alert_id)}")
        psql(f"UPDATE public.notification_deliveries SET next_attempt_at = now() WHERE alert_id = {literal(alert_id)}"
             " AND event = 'reminder'")
        psql("SELECT public.sweep_notifications()")
        self.assertEqual(self.wait_for_state(alert_id, "reminder", ("dropped", "sent")), "dropped")
        self.assertEqual(self.received(alert_id, "aber.alert.reminder"), [])
        self.assertEqual(psql("SELECT public.queue_platform_alert_reminders()"), "0", "no new reminder for it either")

    def test_an_unacknowledged_alert_is_reminded(self):
        alert_id = self.fire("reminded")
        self.wait_for(alert_id, "aber.alert.firing")
        self.wait_for_state(alert_id, "firing", ("sent",))
        psql("UPDATE public.notification_deliveries SET finished_at = now() - interval '13 hours'"
             f" WHERE alert_id = {literal(alert_id)} AND event = 'firing'")
        psql("SELECT public.sweep_notifications()")
        _, event = self.wait_for(alert_id, "aber.alert.reminder")[0]
        self.assertEqual(event["data"]["alert_id"], alert_id)

    def test_a_resolve_arrives_after_its_firing_message(self):
        alert_id = self.fire("resolved")
        firing = self.wait_for(alert_id, "aber.alert.firing")
        self.wait_for_state(alert_id, "firing", ("sent",))
        psql(f"UPDATE public.platform_alerts SET status = 'resolved', ends_at = now() WHERE id = {literal(alert_id)}")
        _, event = self.wait_for(alert_id, "aber.alert.resolved")[0]
        self.assertIsNotNone(event["data"]["ends_at"])
        self.assertNotEqual(event["id"], firing[0][1]["id"], "each message has its own id")

    def test_an_address_whose_host_is_not_allowed_is_refused(self):
        psql("UPDATE public.system_settings SET value = '[\"elsewhere.example\"]'::jsonb"
             " WHERE key = 'notifications.webhook_allowed_hosts'")
        try:
            alert_id = self.fire("refused")
            deadline = time.time() + WAIT_SECONDS
            error = ""
            while time.time() < deadline and not error:
                error = psql(f"SELECT coalesce(last_error, '') FROM public.notification_deliveries WHERE alert_id = {literal(alert_id)}")
                time.sleep(2)
            self.assertEqual(error, "The webhook's host is not on its allowed hosts, so the message was refused.")
            self.assertEqual(self.received(alert_id), [], "nothing was posted")
        finally:
            psql("UPDATE public.system_settings SET value = " + literal(json.dumps([self.receiver_ip]))
                 + "::jsonb WHERE key = 'notifications.webhook_allowed_hosts'")
            psql("UPDATE public.notification_deliveries SET state = 'dropped', finished_at = now()"
                 " WHERE state = 'pending' AND alert_id IN (SELECT id FROM public.platform_alerts"
                 f" WHERE fingerprint LIKE {literal(FINGERPRINT + '-refused%')})")


if __name__ == "__main__":
    unittest.main(verbosity=2)
