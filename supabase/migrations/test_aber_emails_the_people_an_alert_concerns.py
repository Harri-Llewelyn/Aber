# suite:
#   lanes: db
#   why: 0262 and 0263 -- that email is a channel beside the webhook, off until a role is named,
#     with its own route and the roles told, each setting's rule and who writes it; that it is
#     queued and reminded as the webhook is and decided by the same arms (acknowledgement,
#     suppression, the writer's confirmation); that a machine identity's alert is carried only when
#     Administrators are told and goes to them alone; who a message is resolved to at send time (by
#     auth.users.email, never a person with no address, a banned or removed account or a machine
#     identity); that the log keeps counts and no address; and the Administrator's test.

"""
Aber emails the people whose roles an alert's email route names (0262, 0263).

    python supabase/migrations/test_aber_emails_the_people_an_alert_concerns.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * The route: notifications.email_min_severity and notifications.email_roles, their seeds, the rule
    each one's guard applies, who reads them and who writes. Email starts off: no role is named.
  * The queue: an email is queued beside the webhook's when an occurrence starts firing, only once a
    role is named, only at or above the route, and a resolve follows each channel's own firing message.
  * The send decision for the email channel: acknowledgement drops it, a suppression window holds it,
    a reminder needs its writer's confirmation, and a machine identity's alert is carried only when
    Administrators are told. The webhook still never carries one.
  * The reminders: email is reminded as the webhook is, and not about a machine identity once
    Administrators are no longer told.
  * The people: who a message is resolved to at send time (the role's people with an address and
    access, by their auth.users.email), who is left out, a machine identity's alert to Administrators
    only, a test to the person who asked, and a pass that does not hold the lease refused.
  * The log: counts of people and of refusals, never an address, readable as the webhook's rows are.
  * The test: only an Administrator queues one, to their own address, and the newest 20 are kept.

EVERY TEST ROLLS BACK. platform_alerts is in the realtime publication, and a committed queue row
would ask pg_net for a pass.
"""
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

OPERATOR_ID = "a0d17262-0000-4000-8000-0000000262a1"
MANAGER_ID = "a0d17262-0000-4000-8000-0000000262a2"
ADMIN_ID = "a0d17262-0000-4000-8000-0000000262a3"
AUDITOR_ID = "a0d17262-0000-4000-8000-0000000262a4"
PRINCIPAL_ID = "a0d17262-0000-4000-8000-0000000262d1"

PEOPLE = ((OPERATOR_ID, "Operator", "operator@email.test"), (MANAGER_ID, "Shopfloor_Manager", "manager@email.test"),
          (ADMIN_ID, "Administrator", "admin@email.test"), (AUDITOR_ID, "Auditor", "auditor@email.test"))
NON_ADMINS = (OPERATOR_ID, MANAGER_ID, AUDITOR_ID)
WEBHOOK_URL = "https://hooks.example.net/receiver/path-issued-by-the-receiver"

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


class EmailBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.notification_email_recipients(uuid, uuid)') IS NOT NULL"
                         " AND to_regprocedure('public.queue_test_email_notification()') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0262 and 0263 are not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role, email in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;", (user_id, email))
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        # A clean slate inside the transaction: no webhook, email off, and the seeded routes.
        self.cur.execute("DELETE FROM vault.secrets WHERE name IN"
                         " ('notification_webhook_url', 'notification_webhook_signing_key');")
        self.cur.execute("UPDATE public.system_settings SET value = '\"warning\"'"
                         " WHERE key IN ('notifications.email_min_severity', 'notifications.webhook_min_severity');")
        self.cur.execute("UPDATE public.system_settings SET value = '[]' WHERE key = 'notifications.email_roles';")
        self.cur.execute("UPDATE public.system_settings SET value = '12' WHERE key = 'notifications.reminder_hours';")
        self.cur.execute("SELECT public.claim_notification_dispatch(60);")
        self.holder = self.cur.fetchone()[0]

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
            claims = {"sub": user_id, "role": "authenticated", "email": "someone@email.test"}
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

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, caught.exception.pgerror)
        return caught.exception

    # -- the route -----------------------------------------------------------------------------
    def tell(self, *roles):
        self.cur.execute("UPDATE public.system_settings SET value = %s WHERE key = 'notifications.email_roles';",
                         (Json(list(roles)),))

    def configure_webhook(self):
        self.as_person(ADMIN_ID, "SELECT public.set_notification_webhook_url(%s);", (WEBHOOK_URL,))
        self.as_person(ADMIN_ID, "SELECT public.issue_notification_signing_key();")

    # -- alerts --------------------------------------------------------------------------------
    def upsert(self, fingerprint="fp-0262", starts_at="2026-11-09T09:00:00Z", status="firing", ends_at=None,
               severity="warning", entity_type="device", entity_id=None, sparkplug_id="dev0262000000000400080000",
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

    def resolve(self, fingerprint="fp-0262", starts_at="2026-11-09T09:00:00Z", **kw):
        return self.upsert(fingerprint=fingerprint, starts_at=starts_at, status="resolved",
                           ends_at="2026-11-09T09:30:00Z", **kw)

    def machine_alert(self, fingerprint="fp-0262-token"):
        return self.upsert(fingerprint=fingerprint, entity_type="service_identity", entity_id=PRINCIPAL_ID,
                           sparkplug_id=None, alert_name="Service Token Expiring")

    def queued(self, alert_id, channel="email"):
        self.cur.execute("SELECT event, state FROM public.notification_deliveries"
                         " WHERE alert_id = %s AND channel = %s ORDER BY created_at, event;", (alert_id, channel))
        return self.cur.fetchall()

    def set_state(self, alert_id, event, state, finished_ago="0 seconds", channel="email"):
        self.cur.execute(
            "UPDATE public.notification_deliveries SET state = %s,"
            "       finished_at = CASE WHEN %s = 'pending' THEN NULL ELSE now() - %s::interval END"
            " WHERE alert_id = %s AND event = %s AND channel = %s;", (state, state, finished_ago, alert_id, event, channel))

    def decide(self, alert_id, event, channel="email"):
        self.cur.execute("SELECT public.platform_alert_send_decision(%s, %s, %s);", (alert_id, event, channel))
        return self.cur.fetchone()[0]

    def delivery_id(self, alert_id, event="firing", channel="email"):
        self.cur.execute("SELECT id FROM public.notification_deliveries WHERE alert_id = %s AND event = %s"
                         " AND channel = %s ORDER BY created_at DESC LIMIT 1;", (alert_id, event, channel))
        return self.cur.fetchone()[0]

    def recipients(self, delivery_id):
        """The addresses the database resolves, of this suite's own people: a database that has been used
        holds other suites' committed administrators, who are told too, as they should be."""
        self.cur.execute("SELECT public.notification_email_recipients(%s, %s);", (self.holder, delivery_id))
        return [a for a in self.cur.fetchone()[0] if a.endswith("@email.test")]

    def told(self, alert_id, event="firing"):
        return self.recipients(self.delivery_id(alert_id, event))


class TheRoute(EmailBase):
    def update_setting(self, user_id, key, value):
        return self.as_person(user_id, "UPDATE public.system_settings SET value = %s WHERE key = %s RETURNING key;",
                              (Json(value), key))

    def test_email_starts_off_and_at_warning(self):
        self.conn.rollback()  # Before setUp's own changes.
        self.cur.execute("SELECT key, value FROM public.system_settings WHERE key IN"
                         " ('notifications.email_min_severity', 'notifications.email_roles') ORDER BY key;")
        self.assertEqual(self.cur.fetchall(), [("notifications.email_min_severity", "warning"),
                                               ("notifications.email_roles", [])])

    def test_each_setting_s_own_rule(self):
        for key, value in (("notifications.email_min_severity", "urgent"),
                           ("notifications.email_min_severity", 3),
                           ("notifications.email_roles", ["Plumber"]),
                           ("notifications.email_roles", ["Administrator", "Administrator"]),
                           ("notifications.email_roles", ["administrator"]),
                           ("notifications.email_roles", [1]),
                           ("notifications.email_roles", {"role": "Administrator"})):
            with self.subTest(key=key, value=value):
                self.assertRefused("23514", self.update_setting, ADMIN_ID, key, value)
        for key, value in (("notifications.email_min_severity", "critical"),
                           ("notifications.email_min_severity", "info"),
                           ("notifications.email_roles", ["Administrator", "Shopfloor_Manager", "Operator", "Auditor"]),
                           ("notifications.email_roles", ["Auditor"]),
                           ("notifications.email_roles", [])):
            with self.subTest(key=key, value=value):
                self.assertEqual(self.update_setting(ADMIN_ID, key, value), [(key,)])

    def test_only_an_administrator_changes_them_and_every_role_reads_them(self):
        for user_id in NON_ADMINS:
            for key, value in (("notifications.email_min_severity", "critical"),
                               ("notifications.email_roles", ["Operator"])):
                with self.subTest(user=user_id, key=key):
                    self.assertEqual(self.update_setting(user_id, key, value), [], "RLS affects no row")
        self.cur.execute("SELECT value FROM public.system_settings WHERE key = 'notifications.email_roles';")
        self.assertEqual(self.cur.fetchone()[0], [])
        sql = ("SELECT key FROM public.system_settings WHERE key IN"
               " ('notifications.email_min_severity', 'notifications.email_roles') ORDER BY key;")
        for user_id in NON_ADMINS + (ADMIN_ID,):
            self.assertEqual(self.as_person(user_id, sql),
                             [("notifications.email_min_severity",), ("notifications.email_roles",)])

    def test_a_setting_that_is_not_a_list_of_roles_means_no_roles(self):
        # Set as the owner, past the guard, as a replay of an older value might.
        self.cur.execute("ALTER TABLE public.system_settings DISABLE TRIGGER notification_setting_guard_trg;")
        self.cur.execute("UPDATE public.system_settings SET value = '[\"Administrator\"]'"
                         " WHERE key = 'notifications.email_roles';")
        self.cur.execute("SELECT public.notification_email_roles();")
        self.assertEqual(self.cur.fetchone()[0], ["Administrator"])
        self.cur.execute("ALTER TABLE public.system_settings ENABLE TRIGGER notification_setting_guard_trg;")


class TheQueue(EmailBase):
    def test_nothing_is_queued_until_a_role_is_named(self):
        alert_id = self.upsert()
        self.assertEqual(self.queued(alert_id), [])
        self.tell("Shopfloor_Manager")
        alert_id = self.upsert(fingerprint="fp-0262-after")
        self.assertEqual(self.queued(alert_id), [("firing", "pending")])

    def test_an_occurrence_starting_to_fire_is_queued_once_and_a_repeat_queues_nothing(self):
        self.tell("Shopfloor_Manager")
        alert_id = self.upsert()
        self.upsert()
        self.cur.execute("UPDATE public.platform_alerts SET last_confirmed_at = now() WHERE id = %s;", (alert_id,))
        self.assertEqual(self.queued(alert_id), [("firing", "pending")])

    def test_a_resolve_follows_the_firing_message_once(self):
        self.tell("Shopfloor_Manager")
        alert_id = self.upsert()
        self.resolve()
        self.resolve()
        self.assertEqual(self.queued(alert_id), [("firing", "pending"), ("resolved", "pending")])

    def test_an_alert_below_the_route_is_not_queued_and_its_resolve_neither(self):
        self.tell("Shopfloor_Manager")
        alert_id = self.upsert(severity="info")
        self.resolve(severity="info")
        self.assertEqual(self.queued(alert_id), [])
        self.cur.execute("UPDATE public.system_settings SET value = '\"info\"'"
                         " WHERE key = 'notifications.email_min_severity';")
        self.assertEqual(self.queued(self.upsert(fingerprint="fp-0262-info", severity="info")), [("firing", "pending")])
        self.cur.execute("UPDATE public.system_settings SET value = '\"critical\"'"
                         " WHERE key = 'notifications.email_min_severity';")
        warning = self.upsert(fingerprint="fp-0262-warning", severity="warning")
        critical = self.upsert(fingerprint="fp-0262-critical", severity="critical")
        self.assertEqual([len(self.queued(warning)), len(self.queued(critical))], [0, 1])

    def test_a_route_raised_after_the_firing_still_queues_its_resolve(self):
        self.tell("Shopfloor_Manager")
        alert_id = self.upsert(severity="warning")
        self.cur.execute("UPDATE public.system_settings SET value = '\"critical\"'"
                         " WHERE key = 'notifications.email_min_severity';")
        self.resolve(severity="warning")
        self.assertEqual([e for e, _ in self.queued(alert_id)], ["firing", "resolved"])

    def test_email_and_the_webhook_are_queued_side_by_side_each_on_its_own_route(self):
        self.configure_webhook()
        self.tell("Shopfloor_Manager")
        self.cur.execute("UPDATE public.system_settings SET value = '\"critical\"'"
                         " WHERE key = 'notifications.webhook_min_severity';")
        alert_id = self.upsert(severity="warning")
        self.assertEqual([self.queued(alert_id, "email"), self.queued(alert_id, "webhook")], [[("firing", "pending")], []])
        self.cur.execute("UPDATE public.system_settings SET value = '\"info\"'"
                         " WHERE key = 'notifications.webhook_min_severity';")
        both = self.upsert(fingerprint="fp-0262-both", severity="warning")
        self.assertEqual([len(self.queued(both, "email")), len(self.queued(both, "webhook"))], [1, 1])
        self.resolve(fingerprint="fp-0262-both", severity="warning")
        self.assertEqual([len(self.queued(both, "email")), len(self.queued(both, "webhook"))], [2, 2])

    def test_the_webhook_alone_is_unchanged_while_no_role_is_named(self):
        self.configure_webhook()
        alert_id = self.upsert()
        self.assertEqual([self.queued(alert_id, "email"), self.queued(alert_id, "webhook")], [[], [("firing", "pending")]])

    def test_a_machine_identity_s_alert_is_queued_for_email_only_when_administrators_are_told(self):
        self.tell("Shopfloor_Manager", "Operator")
        self.assertEqual(self.queued(self.machine_alert()), [], "no Administrator is told, so no one may read it")
        self.tell("Shopfloor_Manager", "Administrator")
        self.assertEqual(self.queued(self.machine_alert(fingerprint="fp-0262-token-2")), [("firing", "pending")])

    def test_the_webhook_never_carries_a_machine_identity_s_alert(self):
        self.configure_webhook()
        self.tell("Administrator")
        alert_id = self.machine_alert()
        self.assertEqual([self.queued(alert_id, "webhook"), self.queued(alert_id, "email")], [[], [("firing", "pending")]])

    def test_the_channel_check_admits_email_and_nothing_else(self):
        self.cur.execute("SAVEPOINT bad;")
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("INSERT INTO public.notification_deliveries (event, channel) VALUES ('test', 'sms');")
        self.cur.execute("ROLLBACK TO SAVEPOINT bad;")
        self.cur.execute("INSERT INTO public.notification_deliveries (event, channel) VALUES ('test', 'email');")


class TheSendDecision(EmailBase):
    def setUp(self):
        super().setUp()
        self.tell("Shopfloor_Manager", "Administrator")

    def test_an_occurrence_that_is_gone_is_dropped(self):
        self.assertEqual(self.decide("00000000-0000-4000-8000-000000000262", "firing"), "drop")

    def test_a_firing_occurrence_unacknowledged_is_sent(self):
        alert_id = self.upsert()
        self.assertEqual([self.decide(alert_id, "firing"), self.decide(alert_id, "reminder")], ["send", "send"])

    def test_resolved_before_the_firing_message_went_out_drops_it(self):
        alert_id = self.upsert()
        self.resolve()
        self.assertEqual([self.decide(alert_id, "firing"), self.decide(alert_id, "reminder")], ["drop", "drop"])

    def test_an_acknowledgement_stops_the_firing_message_and_every_reminder_and_keeps_the_resolve(self):
        alert_id = self.upsert()
        self.set_state(alert_id, "firing", "sent")
        self.as_person(MANAGER_ID, "SELECT id FROM public.acknowledge_alert(%s, 'investigating', NULL);", (alert_id,))
        self.assertEqual([self.decide(alert_id, "firing"), self.decide(alert_id, "reminder")], ["drop", "drop"])
        self.resolve()
        self.assertEqual(self.decide(alert_id, "resolved"), "send", "a resolve still goes, as its firing went")

    def test_a_reminder_needs_its_writer_s_confirmation(self):
        fresh = self.upsert(fingerprint="fp-0262-fresh")
        self.cur.execute("SELECT now() - interval '13 hours 1 minute';")
        stale = self.upsert(fingerprint="fp-0262-stale", confirmed=self.cur.fetchone()[0])
        self.assertEqual([self.decide(fresh, "reminder"), self.decide(stale, "reminder")], ["send", "drop"])

    def test_a_resolve_follows_its_own_channel_s_firing_message(self):
        self.configure_webhook()
        alert_id = self.upsert()
        self.set_state(alert_id, "firing", "sent", channel="email")
        self.set_state(alert_id, "firing", "dead", channel="webhook")
        self.resolve()
        self.assertEqual([self.decide(alert_id, "resolved", "email"), self.decide(alert_id, "resolved", "webhook")],
                         ["send", "drop"])

    def test_a_machine_identity_s_alert_is_dropped_for_email_unless_administrators_are_told(self):
        alert_id = self.machine_alert()
        self.assertEqual([self.decide(alert_id, e) for e in ("firing", "reminder")], ["send", "send"])
        self.tell("Shopfloor_Manager")
        for event in ("firing", "reminder", "resolved"):
            self.assertEqual(self.decide(alert_id, event), "drop", event)
        self.assertEqual(self.decide(alert_id, "firing", "webhook"), "drop", "and never to the webhook")

    def test_a_suppression_window_holds_it_until_the_window_ends(self):
        device = "a0d17262-0000-4000-8000-0000000262e1"
        self.cur.execute("INSERT INTO public.devices (id, name) VALUES (%s, 'Test_0262_Press');", (device,))
        self.cur.execute(
            "INSERT INTO public.alert_suppression_windows (device_id, starts_at, ends_at, reason, created_by)"
            " VALUES (%s, now() - interval '1 hour', now() + interval '1 hour', 'Belt change', %s) RETURNING id;",
            (device, MANAGER_ID))
        window_id = self.cur.fetchone()[0]
        alert_id = self.upsert(entity_id=device)
        self.assertEqual([self.decide(alert_id, "firing"), self.decide(alert_id, "reminder")], ["hold", "hold"])
        self.as_person(MANAGER_ID, "SELECT id FROM public.end_alert_suppression_window(%s);", (window_id,))
        self.assertEqual(self.decide(alert_id, "firing"), "send", "still firing once the window ends")

    def test_an_acknowledged_alert_inside_a_window_is_dropped_not_held(self):
        device = "a0d17262-0000-4000-8000-0000000262e2"
        self.cur.execute("INSERT INTO public.devices (id, name) VALUES (%s, 'Test_0262_Press_2');", (device,))
        self.cur.execute(
            "INSERT INTO public.alert_suppression_windows (device_id, starts_at, ends_at, reason, created_by)"
            " VALUES (%s, now() - interval '1 hour', now() + interval '1 hour', 'Belt change', %s);", (device, MANAGER_ID))
        alert_id = self.upsert(fingerprint="fp-0262-ack", entity_id=device)
        self.as_person(OPERATOR_ID, "SELECT id FROM public.acknowledge_alert(%s, 'planned_work', NULL);", (alert_id,))
        self.assertEqual([self.decide(alert_id, "firing"), self.decide(alert_id, "reminder")], ["drop", "drop"])


class TheReminders(EmailBase):
    def setUp(self):
        super().setUp()
        self.tell("Shopfloor_Manager", "Administrator")

    def sent_alert(self, fingerprint="fp-0262", ago="13 hours", **kw):
        alert_id = self.upsert(fingerprint=fingerprint, **kw)
        self.set_state(alert_id, "firing", "sent", finished_ago=ago)
        return alert_id

    def remind(self):
        self.cur.execute("SELECT public.queue_platform_alert_reminders();")
        return self.cur.fetchone()[0]

    def test_email_is_reminded_past_the_interval_and_not_twice(self):
        alert_id = self.sent_alert()
        self.assertEqual(self.remind(), 1)
        self.assertEqual(self.remind(), 0)
        self.assertEqual([e for e, _ in self.queued(alert_id)], ["firing", "reminder"])

    def test_each_channel_is_reminded_on_its_own_clock(self):
        self.configure_webhook()
        alert_id = self.upsert()
        self.set_state(alert_id, "firing", "sent", finished_ago="13 hours", channel="email")
        self.set_state(alert_id, "firing", "sent", finished_ago="1 hour", channel="webhook")
        self.assertEqual(self.remind(), 1)
        self.assertEqual([len(self.queued(alert_id, "email")), len(self.queued(alert_id, "webhook"))], [2, 1])

    def test_no_reminder_once_roles_that_carried_it_are_no_longer_told_or_below_the_route(self):
        quiet = self.sent_alert(fingerprint="fp-0262-quiet", severity="warning")
        self.cur.execute("UPDATE public.system_settings SET value = '\"critical\"'"
                         " WHERE key = 'notifications.email_min_severity';")
        self.assertEqual(self.remind(), 0)
        self.assertEqual([e for e, _ in self.queued(quiet)], ["firing"])
        self.cur.execute("UPDATE public.system_settings SET value = '\"info\"'"
                         " WHERE key = 'notifications.email_min_severity';")
        self.tell()
        self.assertEqual(self.remind(), 0, "no role is told, so email is not configured")

    def test_no_reminder_about_a_machine_identity_once_administrators_are_not_told(self):
        alert_id = self.machine_alert()
        self.set_state(alert_id, "firing", "sent", finished_ago="13 hours")
        self.tell("Shopfloor_Manager")
        self.assertEqual(self.remind(), 0)
        self.tell("Administrator")
        self.assertEqual(self.remind(), 1)


class ThePeople(EmailBase):
    def setUp(self):
        super().setUp()
        self.tell("Shopfloor_Manager")
        self.alert_id = self.upsert()

    def test_the_people_in_the_roles_named_by_their_address(self):
        self.assertEqual(self.told(self.alert_id), ["manager@email.test"])
        self.tell("Administrator", "Shopfloor_Manager")
        self.alert_id = self.upsert(fingerprint="fp-0262-two")
        self.assertEqual(self.told(self.alert_id), ["admin@email.test", "manager@email.test"])

    def test_a_role_not_named_is_not_told(self):
        self.tell("Auditor")
        alert_id = self.upsert(fingerprint="fp-0262-auditor")
        self.assertEqual(self.told(alert_id), ["auditor@email.test"])

    def test_an_address_is_lower_cased_trimmed_and_listed_once(self):
        self.cur.execute("UPDATE auth.users SET email = '  Manager@Email.Test ' WHERE id = %s;", (MANAGER_ID,))
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, 'manager@email.test', 'not-a-real-hash', now());", ("a0d17262-0000-4000-8000-0000000262a9",))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) SELECT %s, id FROM public.roles"
                         " WHERE name = 'Shopfloor_Manager';", ("a0d17262-0000-4000-8000-0000000262a9",))
        self.assertEqual(self.told(self.alert_id), ["manager@email.test"])

    def test_a_person_with_no_address_gets_nothing(self):
        for blank in (None, "", "   "):
            with self.subTest(email=blank):
                self.cur.execute("UPDATE auth.users SET email = %s WHERE id = %s;", (blank, MANAGER_ID))
                self.assertEqual(self.told(self.alert_id), [])

    def test_a_banned_or_removed_account_gets_nothing(self):
        self.cur.execute("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = %s;", (MANAGER_ID,))
        self.assertEqual(self.told(self.alert_id), [], "GoTrue bans an account whose access was removed")
        self.cur.execute("UPDATE auth.users SET banned_until = now() - interval '1 day' WHERE id = %s;", (MANAGER_ID,))
        self.assertEqual(self.told(self.alert_id), ["manager@email.test"], "a ban that has ended removes nothing")
        self.cur.execute("INSERT INTO public.access_removals (user_id, removed_by) VALUES (%s, %s);", (MANAGER_ID, ADMIN_ID))
        self.assertEqual(self.told(self.alert_id), [])

    def test_a_machine_identity_is_never_told(self):
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, NULL, NULL, now());", (PRINCIPAL_ID,))
        self.cur.execute("SELECT public.notification_email_address(%s);", (PRINCIPAL_ID,))
        self.assertIsNone(self.cur.fetchone()[0])

    def test_a_machine_identity_s_alert_goes_to_administrators_only(self):
        self.tell("Shopfloor_Manager", "Operator", "Administrator")
        alert_id = self.machine_alert()
        self.assertEqual(self.told(alert_id), ["admin@email.test"])

    def test_the_people_are_resolved_when_it_is_sent_not_when_it_was_queued(self):
        self.tell("Administrator")
        self.assertEqual(self.told(self.alert_id), ["admin@email.test"], "the route as it stands now")
        self.tell()
        self.assertEqual(self.told(self.alert_id), [], "nobody left to tell")

    def test_a_pruned_occurrence_and_an_unknown_row_have_nobody(self):
        delivery = self.delivery_id(self.alert_id)
        self.cur.execute("UPDATE public.notification_deliveries SET alert_id = NULL, event = 'test', requested_by = NULL"
                         " WHERE id = %s;", (delivery,))
        self.assertEqual(self.recipients(delivery), [], "a test with nobody behind it")
        self.assertEqual(self.recipients("00000000-0000-4000-8000-000000000262"), [])

    def test_a_webhook_row_has_no_email_recipients(self):
        self.cur.execute("INSERT INTO public.notification_deliveries (alert_id, event, channel)"
                         " VALUES (%s, 'reminder', 'webhook') RETURNING id;", (self.alert_id,))
        self.assertEqual(self.recipients(self.cur.fetchone()[0]), [])

    def test_a_test_goes_to_the_person_who_asked(self):
        delivery = self.as_person(ADMIN_ID, "SELECT public.queue_test_email_notification();")[0][0]
        self.assertEqual(self.recipients(delivery), ["admin@email.test"])
        self.cur.execute("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = %s;", (ADMIN_ID,))
        self.assertEqual(self.recipients(delivery), [], "an account that can no longer sign in is told nothing")

    def test_only_the_holder_resolves_people(self):
        delivery = self.delivery_id(self.alert_id)
        self.assertRefused("55P03", self.cur.execute, "SELECT public.notification_email_recipients(%s, %s);",
                           ("00000000-0000-4000-8000-000000000999", delivery))
        self.conn.rollback()


class TheTest(EmailBase):
    def queue(self, user_id):
        return self.as_person(user_id, "SELECT public.queue_test_email_notification();")[0][0]

    def test_only_an_administrator_queues_one(self):
        for user_id in NON_ADMINS:
            self.assertRefused("42501", self.queue, user_id)

    def test_a_request_with_no_person_behind_it_is_refused(self):
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.assertRefused("42501", self.cur.execute, "SELECT public.queue_test_email_notification();")

    def test_it_is_queued_for_the_email_channel_by_the_person_who_asked(self):
        delivery = self.queue(ADMIN_ID)
        self.cur.execute("SELECT event, channel, state, alert_id, requested_by::text FROM public.notification_deliveries"
                         " WHERE id = %s;", (delivery,))
        self.assertEqual(self.cur.fetchone(), ("test", "email", "pending", None, ADMIN_ID))

    def test_an_account_with_no_address_is_told_so(self):
        self.cur.execute("UPDATE auth.users SET email = NULL WHERE id = %s;", (ADMIN_ID,))
        self.assertRefused("55000", self.queue, ADMIN_ID)

    def test_the_newest_twenty_finished_tests_are_kept(self):
        for _ in range(23):
            delivery = self.queue(ADMIN_ID)
            self.cur.execute("UPDATE public.notification_deliveries SET state = 'sent', finished_at = now()"
                             " WHERE id = %s;", (delivery,))
        self.queue(ADMIN_ID)
        self.cur.execute("SELECT count(*) FROM public.notification_deliveries WHERE event = 'test' AND channel = 'email'"
                         " AND state = 'sent';")
        self.assertEqual(self.cur.fetchone()[0], 20)

    def test_a_test_asks_for_a_pass_and_needs_no_role_to_be_named(self):
        self.cur.execute("SELECT count(*) FROM net.http_request_queue WHERE url LIKE '%%/notification-dispatch';")
        before = self.cur.fetchone()[0]
        self.queue(ADMIN_ID)
        self.cur.execute("SELECT count(*) FROM net.http_request_queue WHERE url LIKE '%%/notification-dispatch';")
        self.assertEqual(self.cur.fetchone()[0] - before, 1)


class TheLog(EmailBase):
    def setUp(self):
        super().setUp()
        self.tell("Shopfloor_Manager")
        self.alert_id = self.upsert()
        self.row = self.delivery_id(self.alert_id)

    def record(self, outcome, **kw):
        args = {"retry": None, "status": None, "error": None, "recipients": None, "refused": None}
        args.update(kw)
        self.cur.execute("SELECT public.record_notification_email_delivery(%s, %s, %s, %s, %s, %s, %s, %s);",
                         (self.holder, self.row, outcome, args["retry"], args["status"], args["error"],
                          args["recipients"], args["refused"]))
        return self.cur.fetchone()[0]

    def read(self):
        self.cur.execute("SELECT state, attempts, response_status, last_error, recipients, refused"
                         " FROM public.notification_deliveries WHERE id = %s;", (self.row,))
        return self.cur.fetchone()

    def test_a_send_records_how_many_people_and_nothing_else_about_them(self):
        self.assertEqual(self.record("sent", status=250, recipients=3, refused=0), "sent")
        self.assertEqual(self.read(), ("sent", 1, 250, None, 3, 0))

    def test_a_send_that_the_relay_part_refused_keeps_its_note_and_the_counts(self):
        self.record("sent", status=250, recipients=2, refused=1, error="The relay refused 1 of 3 addresses: 550 No such user")
        self.assertEqual(self.read(), ("sent", 1, 250, "The relay refused 1 of 3 addresses: 550 No such user", 2, 1))

    def test_a_failure_is_retried_and_a_dead_one_stays_dead(self):
        self.assertEqual(self.record("failed", retry=30, status=451, error="451 Try again later"), "pending")
        self.assertEqual(self.read()[:4], ("pending", 1, 451, "451 Try again later"))
        self.assertEqual(self.record("dead", status=550, error="550 No"), "dead")
        self.assertIsNone(self.record("sent", recipients=1, refused=0), "only a pending row changes")
        self.assertEqual(self.read()[0], "dead")

    def test_a_held_row_records_no_counts(self):
        self.assertEqual(self.record("held", retry=60), "pending")
        self.assertEqual(self.read(), ("pending", 0, None, None, None, None))

    def test_the_log_holds_no_column_that_could_be_an_address(self):
        self.cur.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'"
                         " AND table_name = 'notification_deliveries' AND column_name ~* '(address|email|recipient)'"
                         " AND data_type <> 'integer';")
        self.assertEqual(self.cur.fetchall(), [])

    def test_every_role_reads_the_counts_and_the_alert_a_row_is_about_through_its_own_policy(self):
        self.record("sent", status=250, recipients=2, refused=0)
        machine = self.machine_alert()
        self.tell("Administrator")
        machine = self.machine_alert(fingerprint="fp-0262-token-log")
        sql = "SELECT recipients, refused FROM public.notification_deliveries WHERE alert_id = %s;"
        for user_id in NON_ADMINS:
            self.assertEqual(self.as_person(user_id, sql, (self.alert_id,)), [(2, 0)])
            self.assertEqual(self.as_person(user_id, sql, (machine,)), [], "a machine identity's alert is not listed")
        self.assertEqual(len(self.as_person(ADMIN_ID, sql, (machine,))), 1)

    def test_only_the_dispatcher_records(self):
        for user_id in (ADMIN_ID, MANAGER_ID):
            self.assertRefused("42501", self.as_person, user_id,
                               "SELECT public.record_notification_email_delivery(%s, %s, 'sent');", (self.holder, self.row))
            self.assertRefused("42501", self.as_person, user_id,
                               "SELECT public.notification_email_recipients(%s, %s);", (self.holder, self.row))

    def test_a_pass_that_does_not_hold_the_lease_records_nothing(self):
        self.assertRefused("55P03", self.cur.execute, "SELECT public.record_notification_email_delivery(%s, %s, 'sent');",
                           ("00000000-0000-4000-8000-000000000999", self.row))


if __name__ == "__main__":
    unittest.main(verbosity=2)
