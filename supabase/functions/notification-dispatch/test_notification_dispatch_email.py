"""
Aber's dispatcher emails an alert (0262, 0263), against the live stack: an alert written to
platform_alerts reaches a mail relay, addressed to the people whose roles the route names.

WHAT IS UNDER TEST, end to end: a firing occurrence is queued for the email channel by the trigger,
the queued row asks notification-dispatch for a pass through pg_net, the pass resolves the people
from user_roles and auth.users.email, and sends one message through the relay the functions pod's
SMTP_* variables name. A resolve follows in the same thread. An acknowledgement made before a
reminder is sent stops it. A machine identity's alert goes to Administrators only. A test goes to the
person who asked. The log keeps a count of people and no address.

THE RELAY is a pod of the ingestion image running a stdlib SMTP receiver on port 2525, which prints
each message it takes as one JSON line; this file reads them with `kubectl logs`. A Service named
`aber-test-smtp` in front of it is the host the functions pod must already be configured to send
through, because this file cannot change the pod's environment. Deploy the stack with

    --set supabaseAuth.smtp.host=aber-test-smtp --set supabaseAuth.smtp.port=25 \\
    --set supabaseAuth.smtp.from=aber@example.net

(GoTrue then sends its password-reset mail to the same pod, which takes it) and the suite skips,
saying so, on any other relay. It sends in the clear with no login, so it needs `smtp.user` empty
and a port other than 465. TLS, STARTTLS, AUTH, UTF-8 and every refusal are held by the Deno tests
in this directory (smtp_test.ts, mail_test.ts, email_test.ts) and were measured against a real
runtime when the client was chosen. A stack with networkPolicy.enabled needs the extraEgress rule
for the functions pod (help/site/upgrading.md), and is skipped here.

THE ROUTE IS CONFIGURED AS THE DATABASE OWNER, with psql in the database's pod: the dev Administrator
has a second factor, so no script signs in as one. What the stack held before (the roles told and
the two routes) is put back afterwards, and every occurrence this file wrote is deleted with its
messages. The settings changes and their restoration each leave an Audit Trail row, as any change of
a setting does.

Needs the stack up with notification-dispatch in the functions image, kubectl on the release's
namespace, and SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY. Skips without them.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \\
      python supabase/functions/notification-dispatch/test_notification_dispatch_email.py
"""
import base64
import email
import email.policy
import json
import os
import subprocess
import sys
import time
import unittest
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "enroll-gateway"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "test-harness"))
from test_enroll_gateway import PUBLISHABLE_KEY, SERVICE_ROLE_KEY  # noqa: E402
import stack_exec  # noqa: E402  -- kubectl exec into the release's pods

RECEIVER = "notification-dispatch-smtp"
RELAY_SERVICE = "aber-test-smtp"
RECEIVER_PORT = 2525
FINGERPRINT = "fp-stack-0262"
WAIT_SECONDS = int(os.getenv("NOTIFICATION_WAIT_SECONDS", "60"))
SETTING_KEYS = ("notifications.email_min_severity", "notifications.email_roles", "notifications.reminder_hours")
PRINCIPAL_ID = "b0000000-0000-4000-8000-000000000001"

# Takes each message, prints it as one JSON line (the envelope and the raw message, base64), and
# answers every command as a relay that offers neither STARTTLS nor AUTH.
RECEIVER_PY = r"""
import asyncio, base64, json
async def handle(r, w):
    async def say(text):
        w.write((text + '\r\n').encode()); await w.drain()
    mail_from, rcpts = None, []
    await say('220 aber-test-smtp ESMTP')
    while True:
        line = (await r.readline()).decode('utf-8', 'replace').rstrip('\r\n')
        if not line:
            break
        verb = line.split(' ', 1)[0].upper()
        if verb in ('EHLO', 'HELO'):
            await say('250-aber-test-smtp')
            await say('250 8BITMIME')
        elif verb == 'MAIL':
            mail_from, rcpts = line.split('<', 1)[1].split('>', 1)[0], []
            await say('250 Ok')
        elif verb == 'RCPT':
            rcpts.append(line.split('<', 1)[1].split('>', 1)[0])
            await say('250 Ok')
        elif verb == 'DATA':
            await say('354 End data with <CR><LF>.<CR><LF>')
            lines = []
            while True:
                l = await r.readline()
                if l in (b'.\r\n', b''):
                    break
                lines.append(l[1:] if l.startswith(b'..') else l)
            print(json.dumps({'from': mail_from, 'to': rcpts, 'raw': base64.b64encode(b''.join(lines)).decode()}), flush=True)
            await say('250 Ok: queued')
        elif verb == 'QUIT':
            await say('221 Bye')
            break
        else:
            await say('250 Ok')
    w.close()
async def main():
    server = await asyncio.start_server(handle, '0.0.0.0', 2525)
    await server.serve_forever()
asyncio.run(main())
"""


def kubectl(*args, check=True, input=None):
    result = subprocess.run(["kubectl", "-n", stack_exec.NAMESPACE, *args], capture_output=True, text=True, input=input)
    if check and result.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


def psql(sql):
    """One statement as postgres, the way the migrations run."""
    return stack_exec.output("supabase-db", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql).strip()


def literal(value):
    """A SQL string literal. Every value here is this file's own, never a caller's."""
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


def functions_env(name):
    return stack_exec.run("functions", "printenv", name).stdout.strip()


@unittest.skipIf(not SERVICE_ROLE_KEY or not PUBLISHABLE_KEY, "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY must be set")
class AnAlertIsEmailed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not stack_exec.running("supabase-db"):
            raise unittest.SkipTest(f"{stack_exec.describe('supabase-db')} is not running")
        if psql("SELECT to_regprocedure('public.notification_email_recipients(uuid, uuid)') IS NOT NULL") != "t":
            raise unittest.SkipTest("0263 is not applied on this stack")
        if "default-deny" in kubectl("get", "networkpolicy", "-o", "name", check=False):
            raise unittest.SkipTest("NetworkPolicies are on: the functions pod needs an extraEgress rule to the relay")
        host, port = functions_env("SMTP_HOST"), functions_env("SMTP_PORT")
        if host != RELAY_SERVICE or not port.isdigit() or port == "465" or functions_env("SMTP_USER"):
            raise unittest.SkipTest(
                f"the functions pod sends through {host or 'no relay'}:{port or '?'} as {functions_env('SMTP_USER') or 'no login'}; "
                f"deploy with supabaseAuth.smtp.host={RELAY_SERVICE}, a port other than 465 and no user to run this suite")
        cls.relay_port = int(port)
        cls.sender = functions_env("SMTP_ADMIN_EMAIL")
        cls.dashboard = functions_env("FRONTEND_PUBLIC_URL")

        # What the stack held, to put back.
        cls.saved = {k: psql(f"SELECT value::text FROM public.system_settings WHERE key = {literal(k)}") for k in SETTING_KEYS}

        started = stack_exec.run_probe(
            RECEIVER, stack_exec.default_probe_image(),
            "python -c \"import base64; exec(base64.b64decode('" + base64.b64encode(RECEIVER_PY.encode()).decode() + "'))\"",
            component="ingestion")
        if started.returncode != 0:
            raise unittest.SkipTest(f"the relay pod did not start: {started.stderr.strip()}")
        kubectl("wait", "--for=condition=Ready", f"pod/{RECEIVER}", "--timeout=120s")
        # A Service of its own, selecting this pod alone: the pod carries the ingestion component's
        # labels, which the real ingestion pod shares.
        kubectl("label", f"pod/{RECEIVER}", "aber.io/test-smtp=relay", "--overwrite")
        kubectl("apply", "-f", "-", input=json.dumps({
            "apiVersion": "v1", "kind": "Service", "metadata": {"name": RELAY_SERVICE},
            "spec": {"selector": {"aber.io/test-smtp": "relay"},
                     "ports": [{"port": cls.relay_port, "targetPort": RECEIVER_PORT}]},
        }))

        psql("UPDATE public.system_settings SET value = '\"warning\"' WHERE key = 'notifications.email_min_severity'")
        psql("UPDATE public.system_settings SET value = '12' WHERE key = 'notifications.reminder_hours'")
        cls.tell("Shopfloor_Manager")

    @classmethod
    def tearDownClass(cls):
        try:
            psql(f"DELETE FROM public.platform_alerts WHERE fingerprint LIKE {literal(FINGERPRINT + '%')}")
            psql("DELETE FROM public.notification_deliveries WHERE event = 'test' AND channel = 'email'"
                 " AND requested_by IS NOT NULL AND created_at > now() - interval '1 hour'")
            for key, value in cls.saved.items():
                if value:
                    psql(f"UPDATE public.system_settings SET value = {literal(value)}::jsonb WHERE key = {literal(key)}"
                         f" AND value IS DISTINCT FROM {literal(value)}::jsonb")
        finally:
            kubectl("delete", "service", RELAY_SERVICE, "--ignore-not-found", check=False)
            stack_exec.remove_probe(RECEIVER)

    @classmethod
    def tell(cls, *roles):
        psql("UPDATE public.system_settings SET value = " + literal(json.dumps(list(roles)))
             + "::jsonb WHERE key = 'notifications.email_roles'")

    # -- helpers -------------------------------------------------------------------------------
    def fire(self, suffix, severity="critical", entity_type="platform", entity_id=None):
        fingerprint = f"{FINGERPRINT}-{suffix}-{uuid.uuid4().hex[:8]}"
        return psql(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, entity_id, alert_name, severity, status,"
            "  summary, starts_at, labels, last_confirmed_at)"
            f" VALUES ({literal(fingerprint)}, {literal(entity_type)}, {literal(entity_id)}, 'Email dispatch test',"
            f"  {literal(severity)}, 'firing', 'Written by test_notification_dispatch_email.py.', now(),"
            "  '{\"alertname\": \"Email dispatch test\"}', now())"
            " RETURNING id").splitlines()[0]

    def people(self, *roles):
        """The addresses the database says hold these roles and can be told, as the suite expects them."""
        names = ", ".join(literal(r) for r in roles)
        rows = psql("SELECT DISTINCT lower(btrim(u.email)) FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id"
                    " JOIN auth.users u ON u.id = ur.user_id"
                    f" WHERE r.name IN ({names}) AND coalesce(btrim(u.email), '') <> ''"
                    " AND (u.banned_until IS NULL OR u.banned_until < now())"
                    " AND NOT EXISTS (SELECT 1 FROM public.access_removals a WHERE a.user_id = u.id)"
                    " ORDER BY 1")
        return rows.splitlines()

    def received(self, subject_part=None):
        out = []
        for line in kubectl("logs", f"pod/{RECEIVER}", check=False).splitlines():
            try:
                taken = json.loads(line)
                message = email.message_from_bytes(base64.b64decode(taken["raw"]), policy=email.policy.default)
            except (ValueError, KeyError):
                continue
            if subject_part and subject_part not in str(message["Subject"]):
                continue
            body = message.get_body(preferencelist=("plain",))
            out.append({"to": taken["to"], "from": taken["from"], "message": message,
                        "body": body.get_content() if body else ""})
        return out

    def wait_for(self, subject_part, count=1):
        deadline = time.time() + WAIT_SECONDS
        while time.time() < deadline:
            got = self.received(subject_part)
            if len(got) >= count:
                return got
            time.sleep(2)
        self.fail(f"no message with {subject_part!r} reached the relay in {WAIT_SECONDS}s; the queue holds "
                  + psql("SELECT string_agg(channel || ':' || event || ':' || state || ':' || coalesce(last_error, ''), ', ')"
                         " FROM public.notification_deliveries WHERE created_at > now() - interval '5 minutes'"))

    def row(self, alert_id, event, channel="email"):
        return psql("SELECT state || '|' || coalesce(recipients::text, '') || '|' || coalesce(refused::text, '') || '|'"
                    " || coalesce(response_status::text, '') FROM public.notification_deliveries"
                    f" WHERE alert_id = {literal(alert_id)} AND event = {literal(event)} AND channel = {literal(channel)}"
                    " ORDER BY created_at DESC LIMIT 1")

    def wait_for_state(self, alert_id, event, wanted):
        deadline = time.time() + WAIT_SECONDS
        while time.time() < deadline:
            state = self.row(alert_id, event).split("|")[0]
            if state in wanted:
                return state
            time.sleep(2)
        self.fail(f"the {event} email for {alert_id} is {self.row(alert_id, event)!r}, not one of {wanted}")

    # -- the tests -----------------------------------------------------------------------------
    def test_a_firing_alert_reaches_the_roles_told_with_its_facts(self):
        expected = self.people("Shopfloor_Manager")
        self.assertTrue(expected, "the stack has a Shopfloor Manager with an address (manager@aber.local)")
        alert_id = self.fire("firing")
        got = self.wait_for("Email dispatch test (firing)")[-1]
        self.assertEqual(sorted(got["to"]), expected, "the envelope names the roles' people and nobody else")
        self.assertEqual(got["from"], self.sender)
        message = got["message"]
        self.assertEqual(str(message["Subject"]), "[Aber] Critical: Email dispatch test - the platform (firing)")
        self.assertEqual(str(message["To"]), "undisclosed-recipients:;", "no recipient sees another's address")
        for address in expected:
            self.assertNotIn(address, str(message["To"]))
        self.assertEqual(message["Auto-Submitted"], "auto-generated")
        self.assertTrue(message["Message-ID"].startswith(f"<alert-{alert_id}.firing@"))
        self.assertEqual(message.get_content_type(), "text/plain")
        self.assertEqual(message.get_content_charset(), "utf-8")
        for fact in ("Severity: Critical", "Where:    the platform", "Written by test_notification_dispatch_email.py.",
                     "alertname: Email dispatch test"):
            self.assertIn(fact, got["body"])
        if self.dashboard:
            self.assertIn(self.dashboard, got["body"], "the link opens the dashboard")
        self.assertEqual(self.wait_for_state(alert_id, "firing", ("sent",)), "sent")
        state, recipients, refused, status = self.row(alert_id, "firing").split("|")
        self.assertEqual([int(recipients), int(refused), int(status)], [len(expected), 0, 250])

    def test_the_log_holds_a_count_and_no_address(self):
        alert_id = self.fire("log")
        self.wait_for_state(alert_id, "firing", ("sent",))
        everything = psql("SELECT row_to_json(d)::text FROM public.notification_deliveries d"
                          f" WHERE alert_id = {literal(alert_id)}")
        for address in self.people("Shopfloor_Manager"):
            self.assertNotIn(address, everything)

    def test_a_resolve_follows_in_the_same_thread(self):
        alert_id = self.fire("resolved")
        firing = self.wait_for("Email dispatch test - the platform (firing)")[-1]
        self.wait_for_state(alert_id, "firing", ("sent",))
        psql(f"UPDATE public.platform_alerts SET status = 'resolved', ends_at = now() WHERE id = {literal(alert_id)}")
        thread = f"<alert-{alert_id}.firing@{self.sender.split('@')[1]}>"
        self.assertEqual(str(firing["message"]["Message-ID"]), thread)
        deadline = time.time() + WAIT_SECONDS
        resolved = []
        while time.time() < deadline and not resolved:
            resolved = [m for m in self.received("(resolved)") if str(m["message"]["References"]) == thread]
            time.sleep(2)
        self.assertTrue(resolved, "the resolve names the firing message in References")
        self.assertEqual(str(resolved[-1]["message"]["In-Reply-To"]), thread)
        self.assertIn("has resolved", resolved[-1]["body"])

    def test_an_acknowledgement_before_the_reminder_stops_it(self):
        alert_id = self.fire("acknowledged")
        self.wait_for_state(alert_id, "firing", ("sent",))
        psql("UPDATE public.notification_deliveries SET finished_at = now() - interval '13 hours'"
             f" WHERE alert_id = {literal(alert_id)} AND event = 'firing' AND channel = 'email'")
        psql("INSERT INTO public.notification_deliveries (alert_id, event, channel, next_attempt_at)"
             f" VALUES ({literal(alert_id)}, 'reminder', 'email', now() + interval '1 hour')")
        psql("UPDATE public.platform_alerts SET acknowledged_at = now(), acknowledged_by = gen_random_uuid(),"
             f" acknowledgement_reason = 'investigating' WHERE id = {literal(alert_id)}")
        psql(f"UPDATE public.notification_deliveries SET next_attempt_at = now() WHERE alert_id = {literal(alert_id)}"
             " AND event = 'reminder' AND channel = 'email'")
        psql("SELECT public.sweep_notifications()")
        self.assertEqual(self.wait_for_state(alert_id, "reminder", ("dropped", "sent")), "dropped")

    def test_an_unacknowledged_alert_is_reminded_by_email(self):
        alert_id = self.fire("reminded")
        self.wait_for_state(alert_id, "firing", ("sent",))
        psql("UPDATE public.notification_deliveries SET finished_at = now() - interval '13 hours'"
             f" WHERE alert_id = {literal(alert_id)} AND event = 'firing' AND channel = 'email'")
        psql("SELECT public.sweep_notifications()")
        self.assertEqual(self.wait_for_state(alert_id, "reminder", ("sent",)), "sent")

    def test_a_machine_identity_s_alert_goes_to_administrators_only(self):
        self.tell("Shopfloor_Manager", "Administrator")
        try:
            administrators = self.people("Administrator")
            self.assertTrue(administrators)
            alert_id = self.fire("identity", entity_type="service_identity", entity_id=PRINCIPAL_ID)
            self.wait_for_state(alert_id, "firing", ("sent",))
            got = self.wait_for("Email dispatch test - a machine identity (firing)")[-1]
            self.assertEqual(sorted(got["to"]), administrators, "a Shopfloor Manager may not read it, so is not told")
        finally:
            self.tell("Shopfloor_Manager")

    def test_a_test_goes_to_the_person_who_asked(self):
        admin = psql("SELECT ur.user_id FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id"
                     " JOIN auth.users u ON u.id = ur.user_id WHERE r.name = 'Administrator'"
                     " AND coalesce(btrim(u.email), '') <> '' ORDER BY u.created_at LIMIT 1")
        self.assertTrue(admin, "the stack has an Administrator with an address")
        address = psql(f"SELECT lower(btrim(email)) FROM auth.users WHERE id = {literal(admin)}")
        row = psql("INSERT INTO public.notification_deliveries (event, channel, requested_by)"
                   f" VALUES ('test', 'email', {literal(admin)}) RETURNING id")
        got = self.wait_for("[Aber] A test email")[-1]
        self.assertEqual(got["to"], [address])
        self.assertIn("Nothing is firing.", got["body"])
        deadline = time.time() + WAIT_SECONDS
        state = ""
        while time.time() < deadline and state != "sent":
            state = psql(f"SELECT state FROM public.notification_deliveries WHERE id = {literal(row)}")
            time.sleep(2)
        self.assertEqual(state, "sent")


if __name__ == "__main__":
    unittest.main(verbosity=2)
