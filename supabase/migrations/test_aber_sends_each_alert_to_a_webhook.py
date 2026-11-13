# suite:
#   lanes: db
#   why: 0247 to 0250 -- that an alert is queued once as it starts firing and once as it resolves,
#     and never on a repeat upsert or a stamp; every arm of the send decision, and that a suppressed
#     alert is held until its window ends; that reminders stop when the alert is acknowledged,
#     resolved or no longer confirmed by its writer; the Notifications settings, their rules and who
#     writes them; the webhook's address, signing key and test by role; and that no machine
#     identity's alert is ever selected for the webhook.

"""
Aber queues each alert for the channels that carry it, decides each message as it is sent, and
reminds while an alert fires unacknowledged (0247, 0248, 0249, 0250).

    python supabase/migrations/test_aber_sends_each_alert_to_a_webhook.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * The trigger on platform_alerts queues a firing message when an occurrence starts firing and a
    resolve when it resolves, and nothing on a repeat upsert or a last_confirmed_at stamp. Nothing
    is queued before the webhook has an address and a key, below its route, or about a machine
    identity. Queueing asks for one pass a transaction.
  * platform_alert_send_decision(), every arm of its table, the suppression hold (0250) among them:
    a firing message or a reminder waits while a window covers its alert and is sent once it ends,
    and an occurrence that resolved inside its window sends nothing.
  * The reminders: due after notifications.reminder_hours, only while confirmed by the writer,
    firing, unacknowledged and the newest occurrence, and never twice at once.
  * The three Notifications settings: their seeds, each one's rule, who reads them and who writes.
  * The webhook's address (a foreign credential), its signing key (shown once, rotated, audited in
    the security lane as configuration) and its test, by role.
  * Visibility: no row about a machine identity's alert is ever selected for the webhook, and the
    delivery log is read through platform_alerts' own policy.
  * The lease, the dispatch secret and the dispatcher's record of each outcome.

EVERY TEST ROLLS BACK. platform_alerts is in the realtime publication, and a committed queue row
would ask pg_net for a pass.
"""
import base64
import json
import os
import unittest

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

OPERATOR_ID = "a0d17247-0000-4000-8000-0000000247a1"
MANAGER_ID = "a0d17247-0000-4000-8000-0000000247a2"
ADMIN_ID = "a0d17247-0000-4000-8000-0000000247a3"
AUDITOR_ID = "a0d17247-0000-4000-8000-0000000247a4"
PRINCIPAL_ID = "a0d17247-0000-4000-8000-0000000247d1"

PEOPLE = ((OPERATOR_ID, "Operator"), (MANAGER_ID, "Shopfloor_Manager"), (ADMIN_ID, "Administrator"),
          (AUDITOR_ID, "Auditor"))
NON_ADMINS = (OPERATOR_ID, MANAGER_ID, AUDITOR_ID)
WEBHOOK_URL = "https://hooks.example.net/receiver/path-issued-by-the-receiver"

# What grafana-alert-webhook upserts, as PostgREST's merge-duplicates writes it, stamp included.
UPSERT = """
    INSERT INTO public.platform_alerts
        (fingerprint, entity_type, entity_id, sparkplug_id, alert_name, severity, status, summary,
         starts_at, ends_at, rule_uid, labels, "values", last_confirmed_at)
    VALUES (%(fingerprint)s, %(entity_type)s, %(entity_id)s, %(sparkplug_id)s, %(alert_name)s,
            %(severity)s, %(status)s, 'summary', %(starts_at)s, %(ends_at)s, 'aber-device-offline',
            %(labels)s, NULL, %(confirmed)s)
    ON CONFLICT (fingerprint, starts_at) DO UPDATE SET
        entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id,
        sparkplug_id = EXCLUDED.sparkplug_id, alert_name = EXCLUDED.alert_name,
        severity = EXCLUDED.severity, status = EXCLUDED.status, summary = EXCLUDED.summary,
        ends_at = EXCLUDED.ends_at, rule_uid = EXCLUDED.rule_uid, labels = EXCLUDED.labels,
        "values" = EXCLUDED."values", last_confirmed_at = EXCLUDED.last_confirmed_at
    RETURNING id
"""


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class DispatchBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regclass('public.notification_deliveries') IS NOT NULL"
                         " AND to_regprocedure('public.issue_notification_signing_key()') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0247 and 0248 are not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id[-4:]}@dispatch.test"))
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        # A clean slate inside the transaction: no webhook, and the seeded routes.
        self.cur.execute("DELETE FROM vault.secrets WHERE name IN"
                         " ('notification_webhook_url', 'notification_webhook_signing_key');")
        self.cur.execute("UPDATE public.system_settings SET value = '\"warning\"'"
                         " WHERE key = 'notifications.webhook_min_severity';")
        self.cur.execute("UPDATE public.system_settings SET value = '12' WHERE key = 'notifications.reminder_hours';")
        self.cur.execute("UPDATE public.system_settings SET value = '[\"hooks.example.net\"]'"
                         " WHERE key = 'notifications.webhook_allowed_hosts';")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- people --------------------------------------------------------------------------------
    def as_person(self, user_id, sql, args=()):
        """Run `sql` as PostgREST would for a person's token. A refusal rolls back to the
        savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT as_person;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            claims = {"sub": user_id, "role": "authenticated", "email": f"{user_id[-4:]}@dispatch.test"}
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT as_person;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT as_person;")
        return rows

    def as_service(self, sql, args=()):
        self.cur.execute("SAVEPOINT as_service;")
        try:
            self.cur.execute("SELECT set_config('role', 'service_role', true);")
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT as_service;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT as_service;")
        return rows

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, caught.exception.pgerror)
        return caught.exception

    # -- the webhook ---------------------------------------------------------------------------
    def configure(self):
        """An address and a key, through the Administrator's own functions."""
        self.as_person(ADMIN_ID, "SELECT public.set_notification_webhook_url(%s);", (WEBHOOK_URL,))
        return self.as_person(ADMIN_ID, "SELECT public.issue_notification_signing_key();")[0][0]

    # -- alerts --------------------------------------------------------------------------------
    def upsert(self, fingerprint="fp-0247", starts_at="2026-11-05T09:00:00Z", status="firing", ends_at=None,
               severity="warning", entity_type="device", entity_id=None, sparkplug_id="dev0247000000000400080000",
               alert_name="Device Offline", confirmed="now"):
        if confirmed == "now":
            self.cur.execute("SELECT now();")
            confirmed = self.cur.fetchone()[0]
        self.cur.execute(UPSERT, {
            "fingerprint": fingerprint, "entity_type": entity_type, "entity_id": entity_id,
            "sparkplug_id": sparkplug_id, "alert_name": alert_name, "severity": severity, "status": status,
            "starts_at": starts_at, "ends_at": ends_at, "labels": Json({"alertname": alert_name}),
            "confirmed": confirmed,
        })
        return self.cur.fetchone()[0]

    def resolve(self, fingerprint="fp-0247", starts_at="2026-11-05T09:00:00Z", **kw):
        return self.upsert(fingerprint=fingerprint, starts_at=starts_at, status="resolved",
                           ends_at="2026-11-05T09:30:00Z", **kw)

    def machine_alert(self, fingerprint="fp-0247-token"):
        return self.upsert(fingerprint=fingerprint, entity_type="service_identity", entity_id=PRINCIPAL_ID,
                           sparkplug_id=None, alert_name="Service Token Expiring")

    def queued(self, alert_id):
        self.cur.execute("SELECT event, channel, state FROM public.notification_deliveries"
                         " WHERE alert_id = %s ORDER BY created_at, event;", (alert_id,))
        return self.cur.fetchall()

    def set_state(self, alert_id, event, state, finished_ago="0 seconds"):
        self.cur.execute(
            "UPDATE public.notification_deliveries SET state = %s,"
            "       finished_at = CASE WHEN %s = 'pending' THEN NULL ELSE now() - %s::interval END"
            " WHERE alert_id = %s AND event = %s;", (state, state, finished_ago, alert_id, event))

    def decide(self, alert_id, event, channel="webhook"):
        self.cur.execute("SELECT public.platform_alert_send_decision(%s, %s, %s);", (alert_id, event, channel))
        return self.cur.fetchone()[0]

    def requests(self):
        self.cur.execute("SELECT count(*) FROM net.http_request_queue WHERE url LIKE '%%/notification-dispatch';")
        return self.cur.fetchone()[0]


class TheQueue(DispatchBase):
    def test_nothing_is_queued_until_the_webhook_has_an_address_and_a_key(self):
        alert_id = self.upsert(fingerprint="fp-0247-unset")
        self.assertEqual(self.queued(alert_id), [])
        self.as_person(ADMIN_ID, "SELECT public.set_notification_webhook_url(%s);", (WEBHOOK_URL,))
        alert_id = self.upsert(fingerprint="fp-0247-no-key")
        self.assertEqual(self.queued(alert_id), [], "an address alone sends nothing unsigned")

    def test_an_occurrence_starting_to_fire_is_queued_once(self):
        self.configure()
        alert_id = self.upsert()
        self.assertEqual(self.queued(alert_id), [("firing", "webhook", "pending")])

    def test_a_repeat_upsert_and_a_stamp_queue_nothing(self):
        self.configure()
        alert_id = self.upsert()
        self.upsert()  # Grafana's repeat: the same occurrence, the same status, a new stamp.
        self.cur.execute("UPDATE public.platform_alerts SET last_confirmed_at = now() WHERE id = %s;", (alert_id,))
        self.cur.execute("UPDATE public.platform_alerts SET status = status WHERE id = %s;", (alert_id,))
        self.assertEqual(self.queued(alert_id), [("firing", "webhook", "pending")])

    def test_a_resolve_is_queued_after_its_firing_message(self):
        self.configure()
        alert_id = self.upsert()
        self.resolve()
        self.resolve()  # A repeated resolve is not a second one.
        self.assertEqual(self.queued(alert_id), [("firing", "webhook", "pending"), ("resolved", "webhook", "pending")])

    def test_an_occurrence_that_arrives_resolved_queues_nothing(self):
        self.configure()
        alert_id = self.resolve(fingerprint="fp-0247-never-seen")
        self.assertEqual(self.queued(alert_id), [])

    def test_an_alert_below_the_route_is_not_queued_and_its_resolve_neither(self):
        self.configure()
        alert_id = self.upsert(severity="info")
        self.resolve(severity="info")
        self.assertEqual(self.queued(alert_id), [])
        self.cur.execute("UPDATE public.system_settings SET value = '\"critical\"'"
                         " WHERE key = 'notifications.webhook_min_severity';")
        warning = self.upsert(fingerprint="fp-0247-warning", severity="warning")
        critical = self.upsert(fingerprint="fp-0247-critical", severity="critical")
        self.assertEqual([len(self.queued(warning)), len(self.queued(critical))], [0, 1])

    def test_a_route_raised_after_the_firing_still_queues_its_resolve(self):
        self.configure()
        alert_id = self.upsert(severity="warning")
        self.cur.execute("UPDATE public.system_settings SET value = '\"critical\"'"
                         " WHERE key = 'notifications.webhook_min_severity';")
        self.resolve(severity="warning")
        self.assertEqual([e for e, _, _ in self.queued(alert_id)], ["firing", "resolved"])

    def test_a_machine_identity_s_alert_is_never_queued_for_the_webhook(self):
        self.configure()
        alert_id = self.machine_alert()
        self.assertEqual(self.queued(alert_id), [])

    def test_queueing_asks_for_one_pass_a_transaction(self):
        self.configure()
        before = self.requests()
        self.upsert(fingerprint="fp-0247-one")
        self.upsert(fingerprint="fp-0247-two")
        self.assertEqual(self.requests() - before, 1)
        self.cur.execute("SELECT headers ->> 'x-dispatch-secret' FROM net.http_request_queue"
                         " WHERE url LIKE '%%/notification-dispatch' ORDER BY id DESC LIMIT 1;")
        secret = self.cur.fetchone()[0]
        self.cur.execute("SELECT public.notification_dispatch_secret_matches(%s);", (secret,))
        self.assertTrue(self.cur.fetchone()[0], "the request carries the dispatch secret")


class TheSendDecision(DispatchBase):
    def setUp(self):
        super().setUp()
        self.configure()

    def test_an_occurrence_that_is_gone_is_dropped(self):
        self.assertEqual(self.decide("00000000-0000-4000-8000-000000000247", "firing"), "drop")

    def test_a_machine_identity_s_alert_is_dropped_for_the_webhook_whatever_the_event(self):
        alert_id = self.machine_alert()
        for event in ("firing", "reminder", "resolved"):
            self.assertEqual(self.decide(alert_id, event), "drop", event)

    def test_a_firing_occurrence_unacknowledged_is_sent(self):
        alert_id = self.upsert()
        self.assertEqual([self.decide(alert_id, "firing"), self.decide(alert_id, "reminder")], ["send", "send"])

    def test_resolved_before_the_firing_message_went_out_drops_it(self):
        alert_id = self.upsert()
        self.resolve()
        self.assertEqual([self.decide(alert_id, "firing"), self.decide(alert_id, "reminder")], ["drop", "drop"])

    def test_a_replaced_occurrence_is_dropped(self):
        old = self.upsert(starts_at="2026-11-05T08:00:00Z")
        self.upsert(starts_at="2026-11-05T09:00:00Z")
        self.assertEqual(self.decide(old, "firing"), "drop")

    def test_an_acknowledgement_drops_firing_and_reminder_and_keeps_the_resolve(self):
        alert_id = self.upsert()
        self.set_state(alert_id, "firing", "sent")
        self.as_person(OPERATOR_ID, "SELECT id FROM public.acknowledge_alert(%s, 'investigating', NULL);", (alert_id,))
        self.assertEqual([self.decide(alert_id, "firing"), self.decide(alert_id, "reminder")], ["drop", "drop"])
        self.resolve()
        self.assertEqual(self.decide(alert_id, "resolved"), "send", "a resolve still goes, as its firing went")

    def test_a_reminder_needs_its_writer_s_confirmation(self):
        fresh = self.upsert(fingerprint="fp-0247-fresh")
        self.cur.execute("SELECT now() - interval '12 hours 59 minutes';")
        stale_but_inside = self.upsert(fingerprint="fp-0247-inside", confirmed=self.cur.fetchone()[0])
        self.cur.execute("SELECT now() - interval '13 hours 1 minute';")
        stale = self.upsert(fingerprint="fp-0247-stale", confirmed=self.cur.fetchone()[0])
        never = self.upsert(fingerprint="fp-0247-never", confirmed=None)
        condition = self.upsert(fingerprint="condition:press-4-overheat")
        self.cur.execute("SELECT now() - interval '6 minutes';")
        condition_stale = self.upsert(fingerprint="condition:press-4-late", confirmed=self.cur.fetchone()[0])
        self.assertEqual([self.decide(a, "reminder") for a in (fresh, stale_but_inside, stale, never, condition, condition_stale)],
                         ["send", "send", "drop", "drop", "send", "drop"])
        self.assertEqual(self.decide(stale, "firing"), "send", "the firing message does not need the stamp")

    def test_a_resolve_follows_its_firing_message(self):
        for state, decision in (("sent", "send"), ("pending", "hold"), ("dropped", "drop"), ("dead", "drop")):
            with self.subTest(firing=state):
                fingerprint = f"fp-0247-resolve-{state}"
                alert_id = self.upsert(fingerprint=fingerprint)
                self.set_state(alert_id, "firing", state)
                self.resolve(fingerprint=fingerprint)
                self.assertEqual(self.decide(alert_id, "resolved"), decision)

    def test_a_resolve_with_no_firing_message_is_dropped(self):
        self.cur.execute("DELETE FROM vault.secrets WHERE name = 'notification_webhook_url';")
        alert_id = self.upsert(fingerprint="fp-0247-unannounced")
        self.resolve(fingerprint="fp-0247-unannounced")
        self.assertEqual(self.decide(alert_id, "resolved"), "drop")

    def test_an_event_outside_the_set_is_refused(self):
        alert_id = self.upsert()
        self.assertRefused("22023", self.decide, alert_id, "test")


class ASuppressedAlertIsHeld(DispatchBase):
    """0250: a firing message or a reminder waits while a suppression window (0240) covers its alert,
    and a resolve goes only if its firing message went."""

    def setUp(self):
        super().setUp()
        self.configure()
        self.device = "a0d17250-0000-4000-8000-0000000250d1"
        self.cur.execute("INSERT INTO public.devices (id, name) VALUES (%s, 'Test_0250_Press');", (self.device,))
        self.cur.execute("SELECT public.claim_notification_dispatch(60);")
        self.holder = self.cur.fetchone()[0]

    def window(self, starts="-1 hour", ends="+1 hour"):
        """A window on the device, written as the owner, its start and end relative to now."""
        self.cur.execute(
            "INSERT INTO public.alert_suppression_windows (device_id, starts_at, ends_at, reason, created_by)"
            " VALUES (%s, now() + %s::interval, now() + %s::interval, 'Belt change', %s) RETURNING id;",
            (self.device, starts, ends, MANAGER_ID))
        return self.cur.fetchone()[0]

    def fire(self, fingerprint="fp-0250"):
        return self.upsert(fingerprint=fingerprint, entity_id=self.device)

    def row_id(self, alert_id, event):
        self.cur.execute("SELECT id FROM public.notification_deliveries WHERE alert_id = %s AND event = %s;",
                         (alert_id, event))
        return self.cur.fetchone()[0]

    def dispatch(self, alert_id, event):
        """What notification-dispatch does with one due row: decide it, and record what it decided."""
        decision = self.decide(alert_id, event)
        outcome = {"send": "sent", "hold": "held", "drop": "dropped"}[decision]
        self.cur.execute("SELECT public.record_notification_delivery(%s, %s, %s, %s, NULL, NULL);",
                         (self.holder, self.row_id(alert_id, event), outcome, 60 if outcome == "held" else None))
        return decision

    def test_a_firing_alert_inside_a_window_is_held_not_sent_and_not_dropped(self):
        self.window()
        alert_id = self.fire()
        self.assertEqual(self.dispatch(alert_id, "firing"), "hold")
        self.cur.execute("SELECT state, attempts, next_attempt_at > now() FROM public.notification_deliveries"
                         " WHERE id = %s;", (self.row_id(alert_id, "firing"),))
        self.assertEqual(self.cur.fetchone(), ("pending", 0, True), "held: still queued, no attempt, due again later")

    def test_a_window_ended_early_lets_the_next_decision_send(self):
        window_id = self.window()
        alert_id = self.fire()
        self.assertEqual(self.dispatch(alert_id, "firing"), "hold")
        self.as_person(MANAGER_ID, "SELECT id FROM public.end_alert_suppression_window(%s);", (window_id,))
        self.assertEqual(self.decide(alert_id, "firing"), "send", "still firing once the window ends, so it is sent")

    def test_an_occurrence_that_resolved_inside_its_window_sends_neither_message(self):
        self.window()
        alert_id = self.fire()
        self.assertEqual(self.dispatch(alert_id, "firing"), "hold")
        self.resolve(fingerprint="fp-0250", entity_id=self.device)
        self.assertEqual(self.decide(alert_id, "resolved"), "hold", "its firing message is still pending")
        self.assertEqual(self.dispatch(alert_id, "firing"), "drop")
        self.assertEqual(self.dispatch(alert_id, "resolved"), "drop")
        self.assertEqual([s for _, _, s in self.queued(alert_id)], ["dropped", "dropped"])

    def test_a_reminder_is_held_inside_a_window(self):
        alert_id = self.fire()
        self.set_state(alert_id, "firing", "sent", finished_ago="13 hours")
        self.assertEqual(self.decide(alert_id, "reminder"), "send")
        self.window()
        self.assertEqual(self.decide(alert_id, "reminder"), "hold")

    def test_a_resolve_whose_firing_message_went_is_sent_inside_a_window(self):
        alert_id = self.fire()
        self.assertEqual(self.dispatch(alert_id, "firing"), "send")
        self.window()
        self.resolve(fingerprint="fp-0250", entity_id=self.device)
        self.assertEqual(self.decide(alert_id, "resolved"), "send", "the receiver was told it fired")

    def test_an_acknowledged_alert_inside_a_window_is_dropped_not_held(self):
        self.window()
        alert_id = self.fire()
        self.as_person(OPERATOR_ID, "SELECT id FROM public.acknowledge_alert(%s, 'planned_work', NULL);", (alert_id,))
        self.assertEqual([self.decide(alert_id, "firing"), self.decide(alert_id, "reminder")], ["drop", "drop"])

    def test_a_window_that_has_not_started_or_has_ended_holds_nothing(self):
        self.window(starts="+1 hour", ends="+2 hours")
        self.window(starts="-2 hours", ends="-1 hour")
        alert_id = self.fire()
        self.assertEqual(self.decide(alert_id, "firing"), "send")


class TheReminders(DispatchBase):
    def setUp(self):
        super().setUp()
        self.configure()

    def sent_alert(self, fingerprint="fp-0247", ago="13 hours", **kw):
        alert_id = self.upsert(fingerprint=fingerprint, **kw)
        self.set_state(alert_id, "firing", "sent", finished_ago=ago)
        return alert_id

    def remind(self):
        self.cur.execute("SELECT public.queue_platform_alert_reminders();")
        return self.cur.fetchone()[0]

    def reminders(self, alert_id):
        return [s for e, _, s in self.queued(alert_id) if e == "reminder"]

    def test_a_reminder_is_queued_past_the_interval_and_not_twice(self):
        alert_id = self.sent_alert()
        self.assertEqual(self.remind(), 1)
        self.assertEqual(self.remind(), 0, "one is already waiting")
        self.assertEqual(self.reminders(alert_id), ["pending"])

    def test_not_before_the_interval(self):
        alert_id = self.sent_alert(ago="11 hours 59 minutes")
        self.remind()
        self.assertEqual(self.reminders(alert_id), [])
        self.cur.execute("UPDATE public.system_settings SET value = '6' WHERE key = 'notifications.reminder_hours';")
        self.remind()
        self.assertEqual(self.reminders(alert_id), ["pending"], "the interval is the setting's")

    def test_the_next_reminder_counts_from_the_last_one_whatever_became_of_it(self):
        alert_id = self.sent_alert(ago="30 hours")
        self.cur.execute(
            "INSERT INTO public.notification_deliveries (alert_id, event, channel, state, finished_at, created_at)"
            " VALUES (%s, 'reminder', 'webhook', 'dead', now(), now() - interval '2 hours');", (alert_id,))
        self.remind()
        self.assertEqual(self.reminders(alert_id), ["dead"], "a dead reminder is not queued again at once")
        self.cur.execute("UPDATE public.notification_deliveries SET created_at = now() - interval '12 hours'"
                         " WHERE alert_id = %s AND event = 'reminder';", (alert_id,))
        self.remind()
        self.assertEqual(sorted(self.reminders(alert_id)), ["dead", "pending"])

    def test_no_reminder_unconfirmed_acknowledged_resolved_or_unsent(self):
        self.cur.execute("SELECT now() - interval '14 hours';")
        unconfirmed = self.sent_alert(fingerprint="fp-0247-unconfirmed", confirmed=self.cur.fetchone()[0])
        acknowledged = self.sent_alert(fingerprint="fp-0247-acknowledged")
        self.as_person(MANAGER_ID, "SELECT id FROM public.acknowledge_alert(%s, 'known_cause', NULL);", (acknowledged,))
        resolved = self.sent_alert(fingerprint="fp-0247-resolved")
        self.resolve(fingerprint="fp-0247-resolved")
        unsent = self.upsert(fingerprint="fp-0247-unsent")
        dead = self.sent_alert(fingerprint="fp-0247-dead")
        self.set_state(dead, "firing", "dead", finished_ago="13 hours")
        self.assertEqual(self.remind(), 0)
        for alert_id in (unconfirmed, acknowledged, resolved, unsent, dead):
            self.assertEqual(self.reminders(alert_id), [])

    def test_no_reminder_for_a_replaced_occurrence_or_below_the_route(self):
        old = self.sent_alert(starts_at="2026-11-05T08:00:00Z")
        self.upsert(starts_at="2026-11-05T09:00:00Z")
        low = self.sent_alert(fingerprint="fp-0247-low")
        self.cur.execute("UPDATE public.system_settings SET value = '\"critical\"'"
                         " WHERE key = 'notifications.webhook_min_severity';")
        self.remind()
        self.assertEqual([self.reminders(old), self.reminders(low)], [[], []])

    def test_a_withdrawn_acknowledgement_reminds_again(self):
        alert_id = self.sent_alert()
        self.as_person(OPERATOR_ID, "SELECT id FROM public.acknowledge_alert(%s, 'investigating', NULL);", (alert_id,))
        self.assertEqual(self.remind(), 0)
        self.as_person(OPERATOR_ID, "SELECT id FROM public.withdraw_alert_acknowledgement(%s);", (alert_id,))
        self.assertEqual(self.remind(), 1)

    def test_the_sweep_asks_for_a_pass_only_when_a_row_is_due(self):
        self.cur.execute("UPDATE public.notification_deliveries SET next_attempt_at = now() + interval '1 hour'"
                         " WHERE state = 'pending';")
        self.cur.execute("SELECT public.sweep_notifications();")
        self.assertFalse(self.cur.fetchone()[0], "nothing due, nothing asked")
        self.sent_alert()
        self.cur.execute("SELECT public.sweep_notifications();")
        self.assertTrue(self.cur.fetchone()[0], "the reminder it queued is due")


class TheSettings(DispatchBase):
    def update_setting(self, user_id, key, value):
        return self.as_person(user_id, "UPDATE public.system_settings SET value = %s WHERE key = %s RETURNING key;",
                              (Json(value), key))

    def test_five_closed_keys_in_the_notifications_category(self):
        self.cur.execute(
            "SELECT key, value_type, category, sensitive, read_only, min_value, max_value FROM public.system_settings"
            " WHERE starts_with(key, 'notifications.') ORDER BY key;")
        self.assertEqual(self.cur.fetchall(), [
            ("notifications.email_min_severity", "string", "Notifications", False, False, None, None),
            ("notifications.email_roles", "json", "Notifications", False, False, None, None),
            ("notifications.reminder_hours", "number", "Notifications", False, False, 1, 168),
            ("notifications.webhook_allowed_hosts", "json", "Notifications", True, False, None, None),
            ("notifications.webhook_min_severity", "string", "Notifications", False, False, None, None),
        ])

    def test_the_seeded_defaults(self):
        self.conn.rollback()  # Before setUp's own changes.
        self.cur.execute("SELECT key, value FROM public.system_settings WHERE starts_with(key, 'notifications.')"
                         " ORDER BY key;")
        self.assertEqual(self.cur.fetchall(), [
            ("notifications.email_min_severity", "warning"), ("notifications.email_roles", []),
            ("notifications.reminder_hours", 12), ("notifications.webhook_allowed_hosts", []),
            ("notifications.webhook_min_severity", "warning"),
        ])

    def test_each_setting_s_own_rule(self):
        for key, value in (("notifications.webhook_min_severity", "urgent"),
                           ("notifications.webhook_allowed_hosts", ["https://hooks.example.net"]),
                           ("notifications.webhook_allowed_hosts", ["hooks.example.net:8443"]),
                           ("notifications.webhook_allowed_hosts", ["Hooks.Example.net"]),
                           ("notifications.webhook_allowed_hosts", ["a.example", "a.example"]),
                           ("notifications.webhook_allowed_hosts", {"host": "a.example"}),
                           ("notifications.webhook_allowed_hosts", [f"h{i}.example" for i in range(21)]),
                           ("notifications.reminder_hours", 0),
                           ("notifications.reminder_hours", 169),
                           ("notifications.reminder_hours", 1.5)):
            with self.subTest(key=key, value=value):
                self.assertRefused("23514", self.update_setting, ADMIN_ID, key, value)
        for key, value in (("notifications.webhook_min_severity", "critical"),
                           ("notifications.webhook_min_severity", "info"),
                           ("notifications.webhook_allowed_hosts", ["hooks.example.net", "10.0.0.7", "[fd00::7]"]),
                           ("notifications.webhook_allowed_hosts", []),
                           ("notifications.reminder_hours", 1),
                           ("notifications.reminder_hours", 168)):
            with self.subTest(key=key, value=value):
                self.assertEqual(self.update_setting(ADMIN_ID, key, value), [(key,)])

    def test_only_an_administrator_changes_them(self):
        for user_id in NON_ADMINS:
            for key, value in (("notifications.webhook_min_severity", "critical"),
                               ("notifications.reminder_hours", 24),
                               ("notifications.webhook_allowed_hosts", ["elsewhere.example"])):
                with self.subTest(user=user_id, key=key):
                    self.assertEqual(self.update_setting(user_id, key, value), [], "RLS affects no row")
        self.cur.execute("SELECT value FROM public.system_settings WHERE key = 'notifications.reminder_hours';")
        self.assertEqual(self.cur.fetchone()[0], 12)

    def test_every_role_reads_the_routes_and_only_an_administrator_the_hosts(self):
        sql = "SELECT key FROM public.system_settings WHERE starts_with(key, 'notifications.') ORDER BY key;"
        for user_id in NON_ADMINS:
            self.assertEqual(self.as_person(user_id, sql),
                             [("notifications.email_min_severity",), ("notifications.email_roles",),
                              ("notifications.reminder_hours",), ("notifications.webhook_min_severity",)])
        self.assertEqual(len(self.as_person(ADMIN_ID, sql)), 5)

    def test_a_change_is_audited_as_any_setting_is(self):
        self.update_setting(ADMIN_ID, "notifications.reminder_hours", 6)
        self.cur.execute("SELECT action, audit_domain, changed_by::text FROM public.audit_trail"
                         " WHERE entity_type = 'system_settings' AND new_data ->> 'key' = 'notifications.reminder_hours'"
                         "   AND recorded_at >= now();")
        self.assertEqual(self.cur.fetchall(), [("UPDATE", "security", ADMIN_ID)])


class TheWebhook(DispatchBase):
    def status(self, user_id):
        return self.as_person(user_id, "SELECT public.notification_webhook_status();")[0][0]

    def test_the_address_is_a_foreign_credential_an_administrator_sets(self):
        for user_id in NON_ADMINS:
            self.assertRefused("42501", self.as_person, user_id,
                               "SELECT public.set_notification_webhook_url(%s);", (WEBHOOK_URL,))
        for bad in ("hooks.example.net/x", "ftp://hooks.example.net/x", "https://user:pw@hooks.example.net/x",
                    "https://hooks.example.net/a b", ""):
            with self.subTest(url=bad):
                self.assertRefused("22023", self.as_person, ADMIN_ID,
                                   "SELECT public.set_notification_webhook_url(%s);", (bad,))
        self.as_person(ADMIN_ID, "SELECT public.set_notification_webhook_url(%s);", (f"  {WEBHOOK_URL} ",))
        self.cur.execute("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'notification_webhook_url';")
        self.assertEqual(self.cur.fetchone()[0], WEBHOOK_URL, "trimmed")
        probe = "SELECT public.notification_webhook_url_is_set();"
        self.assertEqual([self.as_person(u, probe)[0][0] for u in (ADMIN_ID, *NON_ADMINS)], [True, False, False, False])

    def test_the_status_is_an_administrator_s_alone(self):
        self.configure()
        admin = self.status(ADMIN_ID)
        self.assertEqual([admin["visible"], admin["url_set"], admin["signing_key_issued_at"] is not None], [True, True, True])
        for user_id in NON_ADMINS:
            self.assertEqual(self.status(user_id), {"visible": False, "url_set": None, "signing_key_issued_at": None})

    def test_the_signing_key_is_shown_once_rotated_and_audited(self):
        for user_id in NON_ADMINS:
            self.assertRefused("42501", self.as_person, user_id, "SELECT public.issue_notification_signing_key();")
        first = self.as_person(ADMIN_ID, "SELECT public.issue_notification_signing_key();")[0][0]
        self.assertTrue(first.startswith("whsec_"))
        self.assertEqual(len(base64.b64decode(first[len("whsec_"):])), 32)
        second = self.as_person(ADMIN_ID, "SELECT public.issue_notification_signing_key();")[0][0]
        self.assertNotEqual(first, second)
        self.cur.execute("SELECT count(*), max(decrypted_secret) FROM vault.decrypted_secrets"
                         " WHERE name = 'notification_webhook_signing_key';")
        self.assertEqual(self.cur.fetchone(), (1, second), "one key: the old one stopped signing")
        self.cur.execute(
            "SELECT action, entity_type, audit_domain, changed_by::text, actor_source, old_data IS NULL,"
            "       new_data ->> 'replaced', new_data::text LIKE %s OR coalesce(old_data::text, '') LIKE %s,"
            "       public.audit_event_class(action, entity_type, audit_domain, old_data, new_data)"
            "  FROM public.audit_trail WHERE action = 'SIGNING_KEY_ISSUED' AND recorded_at >= now() ORDER BY id;",
            ("%whsec_%", "%whsec_%"))
        self.assertEqual(self.cur.fetchall(), [
            ("SIGNING_KEY_ISSUED", "notification_channels", "security", ADMIN_ID, "user", True, "false", False, "configuration"),
            ("SIGNING_KEY_ISSUED", "notification_channels", "security", ADMIN_ID, "user", False, "true", False, "configuration"),
        ])

    def test_the_rotation_is_in_the_security_lane_an_operator_cannot_read(self):
        self.configure()
        sql = "SELECT count(*) FROM public.audit_trail WHERE action = 'SIGNING_KEY_ISSUED' AND recorded_at >= now();"
        self.assertEqual([self.as_person(u, sql)[0][0] for u in (OPERATOR_ID, MANAGER_ID, AUDITOR_ID, ADMIN_ID)],
                         [0, 0, 1, 1])

    def test_the_destination_is_the_dispatcher_s_alone(self):
        key = self.configure()
        destination = self.as_service("SELECT public.notification_webhook_destination();")[0][0]
        self.assertEqual(destination, {"url": WEBHOOK_URL, "signing_key": key, "allowed_hosts": ["hooks.example.net"]})
        self.assertRefused("42501", self.as_person, ADMIN_ID, "SELECT public.notification_webhook_destination();")

    def test_a_test_is_an_administrator_s_and_needs_an_address_and_a_key(self):
        self.assertRefused("55000", self.as_person, ADMIN_ID, "SELECT public.queue_test_notification();")
        self.as_person(ADMIN_ID, "SELECT public.set_notification_webhook_url(%s);", (WEBHOOK_URL,))
        self.assertRefused("55000", self.as_person, ADMIN_ID, "SELECT public.queue_test_notification();")
        self.as_person(ADMIN_ID, "SELECT public.issue_notification_signing_key();")
        for user_id in NON_ADMINS:
            self.assertRefused("42501", self.as_person, user_id, "SELECT public.queue_test_notification();")
        before = self.requests()
        test_id = self.as_person(ADMIN_ID, "SELECT public.queue_test_notification();")[0][0]
        self.cur.execute("SELECT event, channel, state, alert_id, requested_by::text FROM public.notification_deliveries"
                         " WHERE id = %s;", (test_id,))
        self.assertEqual(self.cur.fetchone(), ("test", "webhook", "pending", None, ADMIN_ID))
        self.assertEqual(self.requests() - before, 1, "a test asks for a pass")
        # Every role reads the outcome in the log.
        self.assertEqual(self.as_person(OPERATOR_ID, "SELECT event FROM public.notification_deliveries WHERE id = %s;",
                                        (test_id,)), [("test",)])

    def test_the_newest_twenty_finished_tests_are_kept(self):
        self.configure()
        for _ in range(23):
            test_id = self.as_person(ADMIN_ID, "SELECT public.queue_test_notification();")[0][0]
            self.cur.execute("UPDATE public.notification_deliveries SET state = 'sent', finished_at = now(),"
                             " created_at = clock_timestamp() WHERE id = %s;", (test_id,))
        self.as_person(ADMIN_ID, "SELECT public.queue_test_notification();")
        self.cur.execute("SELECT count(*) FILTER (WHERE state <> 'pending'), count(*) FILTER (WHERE state = 'pending')"
                         " FROM public.notification_deliveries WHERE event = 'test';")
        self.assertEqual(self.cur.fetchone(), (20, 1))

    def test_removing_the_address_stops_the_webhook_and_drops_what_waits(self):
        self.configure()
        alert_id = self.upsert()
        for user_id in NON_ADMINS:
            self.assertRefused("42501", self.as_person, user_id, "SELECT public.clear_notification_webhook_url();")
        self.assertEqual(self.as_person(ADMIN_ID, "SELECT public.clear_notification_webhook_url();"), [(1,)])
        self.assertEqual(self.queued(alert_id), [("firing", "webhook", "dropped")])
        self.assertEqual(self.status(ADMIN_ID)["url_set"], False)
        self.assertIsNotNone(self.status(ADMIN_ID)["signing_key_issued_at"], "the key is kept")
        self.assertEqual(self.queued(self.upsert(fingerprint="fp-0247-after")), [])


class Visibility(DispatchBase):
    def setUp(self):
        super().setUp()
        self.configure()
        self.cur.execute("SELECT public.claim_notification_dispatch(60);")
        self.holder = self.cur.fetchone()[0]

    def due(self):
        self.cur.execute("SELECT id, event, alert ->> 'id' FROM public.notification_deliveries_due(%s, 100);", (self.holder,))
        return self.cur.fetchall()

    def test_no_machine_identity_s_alert_is_ever_selected_for_the_webhook(self):
        alert_id = self.machine_alert()
        # Not queued; and a row put there by hand is still not selected.
        self.cur.execute("INSERT INTO public.notification_deliveries (alert_id, event, channel)"
                         " VALUES (%s, 'firing', 'webhook') RETURNING id;", (alert_id,))
        forced = self.cur.fetchone()[0]
        device = self.upsert()
        selected = self.due()
        self.assertNotIn(str(forced), [str(i) for i, _, _ in selected])
        self.assertIn(str(device), [a for _, _, a in selected])

    def test_the_log_is_read_through_platform_alerts_own_policy(self):
        alert_id = self.machine_alert()
        self.cur.execute("INSERT INTO public.notification_deliveries (alert_id, event, channel)"
                         " VALUES (%s, 'firing', 'webhook');", (alert_id,))
        sql = "SELECT count(*) FROM public.notification_deliveries WHERE alert_id = %s;"
        self.assertEqual([self.as_person(u, sql, (alert_id,))[0][0] for u in (OPERATOR_ID, MANAGER_ID, ADMIN_ID)], [0, 0, 1])

    def test_no_role_writes_the_queue(self):
        alert_id = self.upsert()
        for user_id in (OPERATOR_ID, ADMIN_ID):
            self.assertRefused("42501", self.as_person, user_id,
                               "UPDATE public.notification_deliveries SET state = 'sent' WHERE alert_id = %s;", (alert_id,))
        self.assertRefused("42501", self.as_service, "DELETE FROM public.notification_deliveries;")

    def test_a_due_row_carries_its_alert(self):
        self.upsert()
        self.cur.execute("SELECT event, alert FROM public.notification_deliveries_due(%s, 100);", (self.holder,))
        event, alert = self.cur.fetchone()
        self.assertEqual(event, "firing")
        self.assertEqual(sorted(alert), ["ends_at", "id", "labels", "name", "severity", "starts_at", "status",
                                         "subject", "summary", "values"])
        self.assertEqual(alert["subject"], {"type": "device", "id": None, "sparkplug_id": "dev0247000000000400080000",
                                            "name": None})


class TheDispatcher(DispatchBase):
    def claim(self):
        self.cur.execute("SELECT public.claim_notification_dispatch(60);")
        return self.cur.fetchone()[0]

    def record(self, holder, row_id, outcome, retry=None, status=None, error=None):
        self.cur.execute("SELECT public.record_notification_delivery(%s, %s, %s, %s, %s, %s);",
                         (holder, row_id, outcome, retry, status, error))
        return self.cur.fetchone()[0]

    def row(self, row_id):
        self.cur.execute("SELECT state, attempts, next_attempt_at > now(), finished_at IS NOT NULL, response_status,"
                         "       last_error FROM public.notification_deliveries WHERE id = %s;", (row_id,))
        return self.cur.fetchone()

    def test_one_pass_at_a_time(self):
        holder = self.claim()
        self.assertIsNotNone(holder)
        self.assertIsNone(self.claim(), "a second pass is refused")
        self.cur.execute("SELECT requested FROM public.notification_dispatch_lease;")
        self.assertTrue(self.cur.fetchone()[0])
        self.cur.execute("SELECT public.renew_notification_dispatch(%s, 60), public.renew_notification_dispatch(gen_random_uuid(), 60);", (holder,))
        self.assertEqual(self.cur.fetchone(), (True, False))
        before = self.requests()
        self.cur.execute("SELECT public.release_notification_dispatch(%s);", (holder,))
        self.assertTrue(self.cur.fetchone()[0])
        self.assertEqual(self.requests() - before, 1, "the refused claim is answered with one more pass")
        self.assertIsNotNone(self.claim())

    def in_savepoint(self, fn, *args):
        self.cur.execute("SAVEPOINT refused;")
        try:
            return fn(*args)
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT refused;")

    def test_only_the_holder_reads_or_records(self):
        self.configure()
        alert_id = self.upsert()
        self.cur.execute("SELECT id FROM public.notification_deliveries WHERE alert_id = %s;", (alert_id,))
        row_id = self.cur.fetchone()[0]
        self.assertRefused("55P03", self.in_savepoint, self.cur.execute,
                           "SELECT * FROM public.notification_deliveries_due(gen_random_uuid(), 10);")
        self.assertRefused("55P03", self.in_savepoint, self.record, "00000000-0000-4000-8000-000000000000", row_id, "sent")
        holder = self.claim()
        self.cur.execute("UPDATE public.notification_dispatch_lease SET held_until = now() - interval '1 second';")
        self.assertRefused("55P03", self.in_savepoint, self.record, holder, row_id, "sent")
        self.assertEqual(self.row(row_id)[0], "pending", "a pass that outlived its lease writes nothing")

    def test_each_outcome_as_it_is_recorded(self):
        self.configure()
        holder = self.claim()
        rows = {}
        for name in ("sent", "dropped", "held", "failed", "dead"):
            alert_id = self.upsert(fingerprint=f"fp-0247-{name}")
            self.cur.execute("SELECT id FROM public.notification_deliveries WHERE alert_id = %s;", (alert_id,))
            rows[name] = self.cur.fetchone()[0]
        self.assertEqual(self.record(holder, rows["sent"], "sent", status=204), "sent")
        self.assertEqual(self.record(holder, rows["dropped"], "dropped"), "dropped")
        self.assertEqual(self.record(holder, rows["held"], "held", retry=60), "pending")
        self.assertEqual(self.record(holder, rows["failed"], "failed", retry=30, status=503, error="The receiver answered 503."), "pending")
        self.assertEqual(self.record(holder, rows["dead"], "dead", status=None, error="x" * 600), "dead")
        self.assertEqual(self.row(rows["sent"]), ("sent", 1, False, True, 204, None))
        self.assertEqual(self.row(rows["dropped"]), ("dropped", 0, False, True, None, None))
        self.assertEqual(self.row(rows["held"]), ("pending", 0, True, False, None, None), "a hold is not an attempt")
        self.assertEqual(self.row(rows["failed"]), ("pending", 1, True, False, 503, "The receiver answered 503."))
        self.assertEqual(self.row(rows["dead"])[:4], ("dead", 1, False, True))
        self.assertEqual(len(self.row(rows["dead"])[5]), 500)
        self.assertIsNone(self.record(holder, rows["sent"], "failed", retry=30), "a finished row is not changed")
        self.assertRefused("22023", self.record, holder, rows["held"], "failed")

    def test_the_dispatcher_s_functions_are_the_service_role_s(self):
        for fn in ("public.claim_notification_dispatch(integer)", "public.notification_deliveries_due(uuid, integer)",
                   "public.record_notification_delivery(uuid, uuid, text, integer, integer, text)",
                   "public.platform_alert_send_decision(uuid, text, text)",
                   "public.notification_dispatch_secret_matches(text)"):
            self.cur.execute("SELECT has_function_privilege('service_role', %s, 'EXECUTE'),"
                             "       has_function_privilege('authenticated', %s, 'EXECUTE');", (fn, fn))
            self.assertEqual(self.cur.fetchone(), (True, False), fn)

    def test_the_dispatch_secret_is_the_vault_s(self):
        self.cur.execute("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'notification_dispatch_secret';")
        secret = self.cur.fetchone()[0]
        self.assertEqual(len(secret), 64)
        self.assertEqual(self.as_service("SELECT public.notification_dispatch_secret_matches(%s),"
                                         " public.notification_dispatch_secret_matches(%s);", (secret, secret + "x"))[0],
                         (True, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
