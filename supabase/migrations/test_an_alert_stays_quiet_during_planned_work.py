"""
An alert stays quiet during planned work: a suppression window on a device, a gateway or a cell
(0240, 0241).

    python supabase/migrations/test_an_alert_stays_quiet_during_planned_work.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * alert_suppression_windows and its CHECKs: one subject, an end after the start, a trimmed reason
    of at most 200 characters, and an early end that names who ended it.
  * Who writes: a Shopfloor Manager and an Administrator schedule, change and end a window; an
    Operator, an Auditor and a machine identity are refused, and nobody writes the table directly.
    Every signed-in role reads it, and anon does not.
  * What a window covers, decided as the row is read: a device's own alerts and those of every
    device in its cell at that moment, a gateway's own, and never a platform or machine identity
    alert. platform_alerts_active says suppressed before, during and after a window, and keeps
    every column it returned before.
  * The stamp: an occurrence that starts in a window, and one already firing when a window opens
    over it, record the window; nothing clears or moves it.
  * The audit rows: their action, the subject's lane, their class and their snapshots.
  * The longest window, alerts.suppression_max_days: a window of exactly the limit is accepted and
    one a minute longer refused, for a schedule and a change, measured from the window's own start;
    the setting's bounds, and only an Administrator changing it; a lowered limit leaving a window
    alone; and 7 days where the setting is missing or out of range.

EVERY TEST ROLLS BACK. platform_alerts is in the realtime publication: a committed row reaches every
connected dashboard as a firing alert.
"""
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

OPERATOR_ID = "a0d17240-0000-4000-8000-0000000240a1"
MANAGER_ID = "a0d17240-0000-4000-8000-0000000240a2"
ADMIN_ID = "a0d17240-0000-4000-8000-0000000240a3"
AUDITOR_ID = "a0d17240-0000-4000-8000-0000000240a4"
MACHINE_ID = "a0d17240-0000-4000-8000-0000000240a5"

PEOPLE = (
    (OPERATOR_ID, "Operator"), (MANAGER_ID, "Shopfloor_Manager"), (ADMIN_ID, "Administrator"),
    (AUDITOR_ID, "Auditor"),
)
ACTIONS = ["SUPPRESSION_WINDOW_SCHEDULED", "SUPPRESSION_WINDOW_CHANGED", "SUPPRESSION_WINDOW_ENDED",
           "SUPPRESSION_WINDOW_CANCELLED"]

LIMIT_KEY = "alerts.suppression_max_days"

# Every column platform_alerts_active returned before this file, then the four it adds.
VIEW_COLUMNS_BEFORE = [
    "id", "fingerprint", "entity_type", "entity_id", "sparkplug_id", "alert_name", "severity",
    "status", "summary", "starts_at", "ends_at", "recorded_at", "rule_uid", "labels", "values",
    "acknowledged_at", "acknowledged_by", "acknowledged_by_email", "acknowledgement_reason",
    "acknowledgement_note",
]
VIEW_COLUMNS = VIEW_COLUMNS_BEFORE + ["suppressed", "suppressing_window_id", "suppression_reason", "suppressed_until"]

# What the webhook upserts, as PostgREST's merge-duplicates writes it: every column it sends is
# updated on a conflict with the occurrence key, and the stamp is not among them.
UPSERT = """
    INSERT INTO public.platform_alerts
        (fingerprint, entity_type, entity_id, sparkplug_id, alert_name, severity, status, summary,
         starts_at, ends_at, rule_uid, labels, "values")
    VALUES (%(fingerprint)s, %(entity_type)s, %(entity_id)s, %(sparkplug_id)s, %(alert_name)s,
            'warning', %(status)s, 'summary', %(starts_at)s, %(ends_at)s, 'aber-device-offline',
            %(labels)s, NULL)
    ON CONFLICT (fingerprint, starts_at) DO UPDATE SET
        entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id,
        sparkplug_id = EXCLUDED.sparkplug_id, alert_name = EXCLUDED.alert_name,
        severity = EXCLUDED.severity, status = EXCLUDED.status, summary = EXCLUDED.summary,
        ends_at = EXCLUDED.ends_at, rule_uid = EXCLUDED.rule_uid, labels = EXCLUDED.labels,
        "values" = EXCLUDED."values"
    RETURNING id
"""


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class WindowsBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.schedule_alert_suppression_window("
                         "text, uuid, timestamp with time zone, timestamp with time zone, text)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0240 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, self.email(user_id)),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, NULL, '', now()) ON CONFLICT (id) DO NOTHING;", (MACHINE_ID,))

        # Two cells; a gateway in the first; a device filed in the first, one inheriting it from
        # the gateway, and one in no cell.
        self.cell = self.make_cell("Test_0240_Cell_A")
        self.other_cell = self.make_cell("Test_0240_Cell_B")
        self.gateway = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.gateways (id, name, cell_id, deployment) VALUES (%s, %s, %s, 'remote');",
                         (self.gateway, "Test_0240_GW", self.cell))
        self.device = self.make_device("Test_0240_Press", cell_id=self.cell, online=True)
        self.inheriting = self.make_device("Test_0240_Inheriting", gateway_id=self.gateway)
        self.loose = self.make_device("Test_0240_Loose")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    @staticmethod
    def email(user_id):
        return f"{user_id[-4:]}@suppression.test"

    def make_cell(self, name):
        cell_id = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES (%s, %s);", (cell_id, name))
        return cell_id

    def make_device(self, name, cell_id=None, gateway_id=None, online=False):
        device_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, cell_id, gateway_id, status, first_dbirth_at)"
            " VALUES (%s, %s, %s, %s, %s, %s);",
            (device_id, name, cell_id, gateway_id, "ONLINE" if online else None,
             "2026-11-01T00:00:00Z" if online else None))
        return device_id

    def sparkplug_id(self, entity_type, row_id):
        """The subject's wire id, or a made-up one for an id its table does not hold."""
        self.cur.execute(
            "SELECT coalesce((SELECT d.sparkplug_id FROM public.devices d WHERE %s = 'device' AND d.id = %s),"
            "                (SELECT g.sparkplug_id FROM public.gateways g WHERE %s = 'gateway' AND g.id = %s));",
            (entity_type, row_id, entity_type, row_id))
        return self.cur.fetchone()[0] or "dev0240000000000000000000"

    def alert(self, entity_id=None, entity_type="device", fingerprint=None, starts_at=None, status="firing"):
        """An occurrence as the webhook writes it, about `entity_id`; firing an hour ago by default."""
        sparkplug_id = None
        if entity_type in ("device", "gateway"):
            sparkplug_id = self.sparkplug_id(entity_type, entity_id)
        self.cur.execute("SELECT now() - interval '1 hour';")
        default_start = self.cur.fetchone()[0]
        self.cur.execute(UPSERT, {
            "fingerprint": fingerprint or f"fp-0240-{uuid.uuid4()}", "entity_type": entity_type,
            "entity_id": entity_id, "sparkplug_id": sparkplug_id, "alert_name": "Device Offline",
            "status": status, "starts_at": starts_at or default_start,
            "ends_at": None if status == "firing" else default_start,
            "labels": Json({"alertname": "Device Offline"}),
        })
        return self.cur.fetchone()[0]

    def window(self, starts="-1 hour", ends="+1 hour", reason="Planned maintenance", **subject):
        """A window written as the owner, past the functions, with its start and end relative to now.
        `subject` is one of device_id, gateway_id and cell_id."""
        self.cur.execute(
            "INSERT INTO public.alert_suppression_windows"
            "       (device_id, gateway_id, cell_id, starts_at, ends_at, reason, created_by)"
            " VALUES (%s, %s, %s, now() + %s::interval, now() + %s::interval, %s, %s) RETURNING id;",
            (subject.get("device_id"), subject.get("gateway_id"), subject.get("cell_id"),
             starts, ends, reason, MANAGER_ID))
        return self.cur.fetchone()[0]

    def as_person(self, user_id, sql, args=()):
        """Run `sql` as PostgREST would for a person's token. A refusal rolls back to the
        savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT suppression_call;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            claims = {"sub": user_id, "role": "authenticated"}
            if user_id != MACHINE_ID:
                claims["email"] = self.email(user_id)
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT suppression_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT suppression_call;")
        return rows

    def schedule(self, user_id, kind, subject_id, starts=None, ends="+2 hours", reason="Belt change"):
        """Schedule through the function; `starts` and `ends` are intervals from now, or None."""
        return self.as_person(
            user_id,
            "SELECT id, starts_at, ends_at, reason, created_by, created_by_email"
            "  FROM public.schedule_alert_suppression_window(%s, %s,"
            "       now() + %s::interval, now() + %s::interval, %s);",
            (kind, subject_id, starts, ends, reason))[0]

    def change(self, user_id, window_id, starts=None, ends=None, reason=None):
        return self.as_person(
            user_id,
            "SELECT id, starts_at, ends_at, reason FROM public.change_alert_suppression_window(%s,"
            "       now() + %s::interval, now() + %s::interval, %s);",
            (window_id, starts, ends, reason))[0]

    def end(self, user_id, window_id):
        return self.as_person(
            user_id,
            "SELECT id, ends_at, ended_by, ended_by_email FROM public.end_alert_suppression_window(%s);",
            (window_id,))[0]

    def active(self, alert_id, user_id=OPERATOR_ID):
        rows = self.as_person(
            user_id,
            "SELECT suppressed, suppressing_window_id, suppression_reason, suppressed_until"
            "  FROM public.platform_alerts_active WHERE id = %s;", (alert_id,))
        return rows[0] if rows else None

    def stamp(self, alert_id):
        self.cur.execute("SELECT suppression_window_id FROM public.platform_alerts WHERE id = %s;", (alert_id,))
        return self.cur.fetchone()[0]

    def now(self):
        self.cur.execute("SELECT now();")
        return self.cur.fetchone()[0]

    def audit_rows(self, action=None):
        self.cur.execute(
            "SELECT action, entity_type, entity_id::text, audit_domain, changed_by::text, actor_source,"
            "       old_data, new_data,"
            "       public.audit_event_class(action, entity_type, audit_domain, old_data, new_data)"
            "  FROM public.audit_trail"
            " WHERE action = ANY (%s) AND (%s::text IS NULL OR action = %s)"
            "   AND recorded_at >= now()"
            " ORDER BY id;", (ACTIONS, action, action))
        return self.cur.fetchall()

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, caught.exception.pgerror)
        return caught.exception


class TheTable(WindowsBase):
    def write(self, **columns):
        """Insert a window as the owner, past the functions, with one fixed statement; a column not
        named takes the value below, or NULL."""
        row = {"device_id": None, "gateway_id": None, "cell_id": None, "starts_at": "2026-11-05T09:00:00Z",
               "ends_at": "2026-11-05T10:00:00Z", "reason": "Planned maintenance", "created_by": MANAGER_ID,
               "ended_by": None, "ended_by_email": None, **columns}
        self.cur.execute("SAVEPOINT direct;")
        try:
            self.cur.execute(
                "INSERT INTO public.alert_suppression_windows"
                "       (device_id, gateway_id, cell_id, starts_at, ends_at, reason, created_by, ended_by, ended_by_email)"
                " VALUES (%(device_id)s, %(gateway_id)s, %(cell_id)s, %(starts_at)s, %(ends_at)s, %(reason)s,"
                "         %(created_by)s, %(ended_by)s, %(ended_by_email)s);", row)
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT direct;")
            raise
        self.cur.execute("RELEASE SAVEPOINT direct;")

    def test_one_subject_and_only_one(self):
        self.assertRefused("23514", self.write)
        self.assertRefused("23514", self.write, device_id=self.device, cell_id=self.cell)
        self.assertRefused("23514", self.write, device_id=self.device, gateway_id=self.gateway, cell_id=self.cell)
        for subject in ({"device_id": self.device}, {"gateway_id": self.gateway}, {"cell_id": self.cell}):
            self.write(**subject)

    def test_it_ends_after_it_starts(self):
        self.assertRefused("23514", self.write, device_id=self.device, ends_at="2026-11-05T09:00:00Z")
        self.assertRefused("23514", self.write, device_id=self.device, ends_at="2026-11-05T08:00:00Z")

    def test_the_reason_is_required_trimmed_and_short(self):
        self.assertRefused("23502", self.write, device_id=self.device, reason=None)
        self.assertRefused("23514", self.write, device_id=self.device, reason="")
        self.assertRefused("23514", self.write, device_id=self.device, reason=" padded ")
        self.assertRefused("23514", self.write, device_id=self.device, reason="x" * 201)
        self.write(device_id=self.device, reason="x" * 200)

    def test_an_early_end_names_who_ended_it(self):
        self.assertRefused("23514", self.write, device_id=self.device, ended_by_email="someone@suppression.test")
        self.write(device_id=self.device, ended_by=MANAGER_ID, ended_by_email="someone@suppression.test")

    def test_a_window_outlives_its_subject_and_holds_no_purge_back(self):
        # No foreign key, as for an alert's entity_id: deleting the subject deletes nothing else and
        # is refused by nothing here. The writers refuse a subject that is not there (Scheduling).
        self.cur.execute(
            "SELECT count(*) FROM pg_constraint WHERE contype = 'f'"
            "   AND conrelid = 'public.alert_suppression_windows'::regclass;")
        self.assertEqual(self.cur.fetchone()[0], 0)
        windows = [self.window(device_id=self.loose), self.window(cell_id=self.other_cell)]
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (self.loose,))
        self.cur.execute("DELETE FROM public.cells WHERE id = %s;", (self.other_cell,))
        self.assertEqual(self.cur.rowcount, 1)
        self.cur.execute("SELECT count(*) FROM public.alert_suppression_windows WHERE id = ANY (%s::uuid[]);", (windows,))
        self.assertEqual(self.cur.fetchone()[0], 2)


class WhoWrites(WindowsBase):
    def test_a_manager_and_an_administrator_schedule(self):
        for person in (MANAGER_ID, ADMIN_ID):
            _, starts, ends, reason, by, email = self.schedule(person, "device", self.device, reason="  Belt change  ")
            self.assertEqual((reason, by, email), ("Belt change", person, self.email(person)))
            self.assertEqual(starts, self.now())
            self.assertGreater(ends, starts)

    def test_an_operator_an_auditor_and_a_machine_identity_are_refused(self):
        for person in (OPERATOR_ID, AUDITOR_ID, MACHINE_ID):
            with self.subTest(person=person):
                self.assertRefused("42501", self.schedule, person, "device", self.device)
        window = self.window(device_id=self.device)
        for person in (OPERATOR_ID, AUDITOR_ID, MACHINE_ID):
            with self.subTest(person=person):
                self.assertRefused("42501", self.change, person, window, reason="Mine now")
                self.assertRefused("42501", self.end, person, window)
        self.assertEqual(self.audit_rows(), [])

    def test_a_manager_changes_and_ends(self):
        window = self.window(device_id=self.device)
        self.assertEqual(self.change(MANAGER_ID, window, reason="Gearbox swap")[3], "Gearbox swap")
        _, ends, by, email = self.end(ADMIN_ID, window)
        self.assertEqual((ends, by, email), (self.now(), ADMIN_ID, self.email(ADMIN_ID)))

    def test_nobody_writes_the_table_directly(self):
        window = self.window(device_id=self.device)
        for person in (OPERATOR_ID, MANAGER_ID, ADMIN_ID):
            with self.subTest(person=person):
                self.assertRefused("42501", self.as_person, person,
                                   "INSERT INTO public.alert_suppression_windows (device_id, starts_at, ends_at, reason, created_by)"
                                   " VALUES (%s, now(), now() + interval '1 hour', 'x', %s);", (self.device, person))
                self.assertRefused("42501", self.as_person, person,
                                   "UPDATE public.alert_suppression_windows SET reason = 'x' WHERE id = %s;", (window,))
                self.assertRefused("42501", self.as_person, person,
                                   "DELETE FROM public.alert_suppression_windows WHERE id = %s;", (window,))

    def test_every_signed_in_role_reads_and_anon_does_not(self):
        window = self.window(device_id=self.device)
        for person in (OPERATOR_ID, AUDITOR_ID, MANAGER_ID, ADMIN_ID):
            rows = self.as_person(person, "SELECT reason FROM public.alert_suppression_windows WHERE id = %s;", (window,))
            self.assertEqual(rows, [("Planned maintenance",)], person)
        for relation in ("alert_suppression_windows", "platform_alerts_active"):
            self.cur.execute("SELECT has_table_privilege('anon', %s, 'SELECT');", (f"public.{relation}",))
            self.assertFalse(self.cur.fetchone()[0], relation)


class Scheduling(WindowsBase):
    def test_a_start_in_the_past_is_now_and_a_future_one_is_kept(self):
        self.assertEqual(self.schedule(MANAGER_ID, "cell", self.cell, starts="-3 hours")[1], self.now())
        _, starts, _, _, _, _ = self.schedule(MANAGER_ID, "cell", self.cell, starts="+1 day", ends="+2 days")
        self.cur.execute("SELECT now() + interval '1 day';")
        self.assertEqual(starts, self.cur.fetchone()[0])

    def test_what_it_refuses(self):
        self.assertRefused("22023", self.schedule, MANAGER_ID, "area", self.cell)
        self.assertRefused("22023", self.schedule, MANAGER_ID, "device", self.device, ends=None)
        self.assertRefused("22023", self.schedule, MANAGER_ID, "device", self.device, ends="-1 minute")
        self.assertRefused("22023", self.schedule, MANAGER_ID, "device", self.device, starts="+2 hours", ends="+1 hour")
        self.assertRefused("22023", self.schedule, MANAGER_ID, "device", self.device, reason="   ")
        self.assertRefused("22023", self.schedule, MANAGER_ID, "device", self.device, reason="x" * 201)
        refusal = self.assertRefused("PGRST", self.schedule, MANAGER_ID, "gateway", str(uuid.uuid4()))
        self.assertIn('"P0002"', refusal.pgerror)
        self.assertEqual(self.audit_rows(), [])


class Changing(WindowsBase):
    def test_null_keeps_what_the_window_has(self):
        window = self.window(device_id=self.device, starts="+1 hour", ends="+3 hours")
        self.cur.execute("SELECT starts_at, ends_at FROM public.alert_suppression_windows WHERE id = %s;", (window,))
        starts, ends = self.cur.fetchone()
        self.assertEqual(self.change(MANAGER_ID, window, reason="Later")[1:], (starts, ends, "Later"))

    def test_an_upcoming_window_moves_and_a_past_start_is_now(self):
        window = self.window(device_id=self.device, starts="+1 hour", ends="+3 hours")
        self.assertEqual(self.change(MANAGER_ID, window, starts="-1 hour")[1], self.now())

    def test_a_started_window_keeps_its_start(self):
        window = self.window(device_id=self.device)
        self.assertRefused("23514", self.change, MANAGER_ID, window, starts="+10 minutes")
        self.change(MANAGER_ID, window, ends="+5 hours")

    def test_an_ended_window_is_kept_as_it_was(self):
        window = self.window(device_id=self.device, starts="-2 hours", ends="-1 hour")
        self.assertRefused("23514", self.change, MANAGER_ID, window, reason="Rewritten")

    def test_the_end_stays_after_now(self):
        window = self.window(device_id=self.device)
        self.assertRefused("22023", self.change, MANAGER_ID, window, ends="-1 minute")

    def test_changing_nothing_writes_nothing(self):
        window = self.window(device_id=self.device)
        self.change(MANAGER_ID, window, reason="Planned maintenance")
        self.assertEqual(self.audit_rows(), [])


class TheLongestWindow(WindowsBase):
    """alerts.suppression_max_days, which both writers hold a window to from its own start. The
    times are in hours, so no calendar day stretches one."""

    def setUp(self):
        super().setUp()
        self.set_limit(7)

    def set_limit(self, days):
        """As the owner, past the Settings page; the test rolls it back."""
        self.cur.execute("UPDATE public.system_settings SET value = to_jsonb(%s) WHERE key = %s;", (days, LIMIT_KEY))

    def assertTooLong(self, sentence, fn, *args, **kwargs):
        refusal = self.assertRefused("22023", fn, *args, **kwargs)
        self.assertEqual(refusal.diag.message_primary, sentence)

    def ends(self, window_id):
        self.cur.execute("SELECT ends_at FROM public.alert_suppression_windows WHERE id = %s;", (window_id,))
        return self.cur.fetchone()[0]

    def test_the_setting_is_declared_in_retention_from_1_to_90(self):
        self.cur.execute("SELECT value_type, category, label, min_value, max_value, read_only, sensitive"
                         "  FROM public.system_settings WHERE key = %s;", (LIMIT_KEY,))
        self.assertEqual(self.cur.fetchone(),
                         ("number", "Retention", "Longest suppression window (days)", 1, 90, False, False))

    def test_a_window_of_exactly_the_limit_is_accepted_and_a_minute_more_refused(self):
        sentence = "A window can last at most 7 days, set on Settings › Retention."
        self.schedule(MANAGER_ID, "device", self.device, ends="+168 hours")
        self.assertTooLong(sentence, self.schedule, MANAGER_ID, "device", self.device, ends="+168 hours 1 minute")
        # A start in the past is now, and the limit runs from there.
        self.assertTooLong(sentence, self.schedule, MANAGER_ID, "cell", self.cell, starts="-1 hour",
                           ends="+168 hours 1 minute")
        # A later start carries the limit with it.
        self.schedule(ADMIN_ID, "gateway", self.gateway, starts="+48 hours", ends="+216 hours")
        self.assertTooLong(sentence, self.schedule, ADMIN_ID, "gateway", self.gateway, starts="+48 hours",
                           ends="+216 hours 1 minute")
        self.assertEqual([r[0] for r in self.audit_rows()], ["SUPPRESSION_WINDOW_SCHEDULED"] * 2)

    def test_the_sentence_names_the_live_limit(self):
        self.set_limit(1)
        self.assertTooLong("A window can last at most 1 day, set on Settings › Retention.",
                           self.schedule, MANAGER_ID, "device", self.device, ends="+25 hours")
        self.set_limit(2)
        self.schedule(MANAGER_ID, "device", self.device, ends="+48 hours")
        self.assertTooLong("A window can last at most 2 days, set on Settings › Retention.",
                           self.schedule, MANAGER_ID, "device", self.device, ends="+48 hours 1 minute")

    def test_a_stored_part_day_is_its_whole_days(self):
        # The setting counts whole days and refuses a part one (0285). One written before that, or
        # with the guard's trigger off, is read as its whole days, and the sentence says whole days.
        self.cur.execute("ALTER TABLE public.system_settings DISABLE TRIGGER system_settings_whole_number_trg;")
        self.set_limit(1.5)
        self.cur.execute("ALTER TABLE public.system_settings ENABLE TRIGGER system_settings_whole_number_trg;")
        self.schedule(MANAGER_ID, "device", self.device, ends="+24 hours")
        self.assertTooLong("A window can last at most 1 day, set on Settings › Retention.",
                           self.schedule, MANAGER_ID, "device", self.device, ends="+24 hours 1 minute")

    def test_the_setting_refuses_a_part_day(self):
        self.cur.execute("SAVEPOINT part_day;")
        with self.assertRaises(psycopg2.errors.CheckViolation) as caught:
            self.set_limit(1.5)
        self.cur.execute("ROLLBACK TO SAVEPOINT part_day;")
        self.assertEqual(caught.exception.diag.message_primary, LIMIT_KEY + " must be a whole number of days")

    def test_a_change_is_measured_from_the_window_s_own_start(self):
        sentence = "A window can last at most 7 days, set on Settings › Retention."
        started = self.window(device_id=self.device, starts="-48 hours", ends="+1 hour")
        self.change(MANAGER_ID, started, ends="+120 hours")
        # A day more each time would creep past the limit; the stored start stops it.
        self.assertTooLong(sentence, self.change, MANAGER_ID, started, ends="+120 hours 1 minute")

        upcoming = self.window(cell_id=self.cell, starts="+24 hours", ends="+25 hours")
        self.change(MANAGER_ID, upcoming, starts="+48 hours", ends="+216 hours")
        self.assertTooLong(sentence, self.change, MANAGER_ID, upcoming, ends="+216 hours 1 minute")
        # Moving the start earlier lengthens the window, and is measured from the new start.
        self.assertTooLong(sentence, self.change, MANAGER_ID, upcoming, starts="+1 hour")
        self.assertTooLong(sentence, self.change, MANAGER_ID, upcoming, starts="-1 hour")

    def test_the_setting_is_held_to_1_to_90_and_only_an_administrator_changes_it(self):
        for days in (0, -1, 91):
            with self.subTest(days=days):
                self.cur.execute("SAVEPOINT limit_bound;")
                with self.assertRaises(psycopg2.errors.CheckViolation):
                    self.set_limit(days)
                self.cur.execute("ROLLBACK TO SAVEPOINT limit_bound;")
        for days in (1, 90):
            self.set_limit(days)

        update = "UPDATE public.system_settings SET value = to_jsonb(30) WHERE key = %s RETURNING key;"
        self.assertEqual(self.as_person(MANAGER_ID, update, (LIMIT_KEY,)), [])
        self.assertEqual(self.as_person(ADMIN_ID, update, (LIMIT_KEY,)), [(LIMIT_KEY,)])
        # The owner's writes above are audited too, with no person named.
        self.cur.execute("SELECT action, changed_by::text, new_data ->> 'value' FROM public.audit_trail"
                         " WHERE entity_type = 'system_settings' AND new_data ->> 'key' = %s"
                         "   AND changed_by IS NOT NULL AND recorded_at >= now();", (LIMIT_KEY,))
        self.assertEqual(self.cur.fetchall(), [("UPDATE", ADMIN_ID, "30")])

    def test_a_lowered_limit_leaves_a_window_alone(self):
        self.set_limit(30)
        window = self.schedule(MANAGER_ID, "device", self.device, ends="+480 hours")[0]
        before = self.ends(window)
        self.set_limit(7)
        self.assertEqual(self.ends(window), before)
        self.assertTrue(self.active(self.alert(self.device))[0])
        # A new reason changes no time, so it is not measured; a new end is.
        self.change(MANAGER_ID, window, reason="Gearbox swap")
        self.assertEqual(self.ends(window), before)
        self.assertTooLong("A window can last at most 7 days, set on Settings › Retention.",
                           self.change, MANAGER_ID, window, ends="+240 hours")
        self.change(MANAGER_ID, window, ends="+168 hours")

    def test_a_missing_or_out_of_range_setting_is_7_days(self):
        sentence = "A window can last at most 7 days, set on Settings › Retention."
        self.set_limit(30)
        self.cur.execute("UPDATE public.system_settings SET min_value = NULL, max_value = NULL, value = to_jsonb(365)"
                         " WHERE key = %s;", (LIMIT_KEY,))
        self.schedule(MANAGER_ID, "device", self.device, ends="+168 hours")
        self.assertTooLong(sentence, self.schedule, MANAGER_ID, "device", self.device, ends="+168 hours 1 minute")
        self.cur.execute("DELETE FROM public.system_settings WHERE key = %s;", (LIMIT_KEY,))
        self.schedule(MANAGER_ID, "device", self.device, ends="+168 hours")
        self.assertTooLong(sentence, self.schedule, MANAGER_ID, "device", self.device, ends="+168 hours 1 minute")


class Ending(WindowsBase):
    def test_a_started_window_ends_now(self):
        window = self.window(gateway_id=self.gateway)
        self.assertEqual(self.end(MANAGER_ID, window)[1:], (self.now(), MANAGER_ID, self.email(MANAGER_ID)))

    def test_an_upcoming_window_is_cancelled(self):
        window = self.window(cell_id=self.cell, starts="+1 hour", ends="+2 hours")
        self.assertEqual(self.end(MANAGER_ID, window)[0], window)
        self.cur.execute("SELECT count(*) FROM public.alert_suppression_windows WHERE id = %s;", (window,))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_an_ended_or_missing_window_is_refused(self):
        window = self.window(device_id=self.device, starts="-2 hours", ends="-1 hour")
        self.assertRefused("23514", self.end, MANAGER_ID, window)
        refusal = self.assertRefused("PGRST", self.end, MANAGER_ID, str(uuid.uuid4()))
        self.assertIn('"P0002"', refusal.pgerror)


class WhatAWindowCovers(WindowsBase):
    def test_a_device_window_covers_the_device_alone(self):
        window = self.window(device_id=self.device, reason="Belt change")
        mine, other = self.alert(self.device), self.alert(self.loose)
        self.cur.execute("SELECT now() + interval '1 hour';")
        until = self.cur.fetchone()[0]
        self.assertEqual(self.active(mine), (True, window, "Belt change", until))
        self.assertEqual(self.active(other), (False, None, None, None))

    def test_a_gateway_window_covers_the_gateway_s_own_alerts_and_not_its_devices(self):
        self.window(gateway_id=self.gateway)
        self.assertTrue(self.active(self.alert(self.gateway, entity_type="gateway"))[0])
        self.assertFalse(self.active(self.alert(self.inheriting))[0])
        # A device alert carrying the gateway's id is still a device alert.
        self.assertFalse(self.active(self.alert(self.gateway, entity_type="device"))[0])

    def test_a_cell_window_covers_each_device_in_the_cell_now(self):
        window = self.window(cell_id=self.cell)
        filed, inherited, loose = self.alert(self.device), self.alert(self.inheriting), self.alert(self.loose)
        self.assertEqual(self.active(filed)[1], window)
        self.assertEqual(self.active(inherited)[1], window)
        self.assertFalse(self.active(loose)[0])
        # Out of the cell, the alert is no longer suppressed; into it, it is. Nothing else is written.
        self.cur.execute("UPDATE public.devices SET cell_id = %s WHERE id = %s;", (self.other_cell, self.device))
        self.cur.execute("UPDATE public.devices SET cell_id = %s WHERE id = %s;", (self.cell, self.loose))
        self.assertFalse(self.active(filed)[0])
        self.assertTrue(self.active(loose)[0])

    def test_a_cell_window_does_not_cover_the_cell_s_gateway(self):
        self.window(cell_id=self.cell)
        self.assertFalse(self.active(self.alert(self.gateway, entity_type="gateway"))[0])

    def test_platform_and_machine_identity_alerts_are_never_covered(self):
        for subject in ({"device_id": self.device}, {"gateway_id": self.gateway}, {"cell_id": self.cell}):
            self.window(**subject)
        platform = self.alert(None, entity_type="platform")
        machine = self.alert(self.device, entity_type="service_identity")
        self.assertFalse(self.active(platform)[0])
        self.assertFalse(self.active(machine, user_id=ADMIN_ID)[0])
        for entity_type in ("platform", "service_identity"):
            self.cur.execute("SELECT public.platform_alert_suppressing_window(%s, %s, now());", (entity_type, self.device))
            self.assertIsNone(self.cur.fetchone()[0])
        self.assertIsNone(self.stamp(platform))
        self.assertIsNone(self.stamp(machine))

    def test_before_during_and_after(self):
        alert = self.alert(self.device)
        before = self.window(device_id=self.device, starts="+1 hour", ends="+2 hours")
        self.assertEqual(self.active(alert), (False, None, None, None))
        after = self.window(device_id=self.device, starts="-3 hours", ends="-2 hours")
        self.assertEqual(self.active(alert), (False, None, None, None))
        during = self.window(device_id=self.device, starts="-30 minutes", ends="+30 minutes")
        self.assertEqual(self.active(alert)[:2], (True, during))
        # The predicate at any moment, and the window's bounds: from its start, up to its end.
        for at, expected in (("+1 hour", before), ("+90 minutes", before), ("+2 hours", None),
                             ("-150 minutes", after), ("-2 hours", None), ("+29 minutes", during)):
            self.cur.execute("SELECT public.platform_alert_suppressing_window('device', %s, now() + %s::interval);",
                             (self.device, at))
            self.assertEqual(self.cur.fetchone()[0], expected, at)

    def test_of_several_windows_the_one_that_ends_last_answers(self):
        self.window(device_id=self.device, ends="+1 hour")
        later = self.window(cell_id=self.cell, ends="+4 hours")
        self.assertEqual(self.active(self.alert(self.device))[1], later)

    def test_an_acknowledged_alert_can_be_suppressed_too(self):
        alert = self.alert(self.device)
        self.as_person(OPERATOR_ID, "SELECT 1 FROM public.acknowledge_alert(%s, 'planned_work', NULL);", (alert,))
        self.window(device_id=self.device)
        rows = self.as_person(OPERATOR_ID, "SELECT acknowledgement_reason, suppressed FROM public.platform_alerts_active"
                                           " WHERE id = %s;", (alert,))
        self.assertEqual(rows, [("planned_work", True)])

    def test_the_view_keeps_every_column_it_returned(self):
        self.cur.execute(
            "SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute"
            " WHERE attrelid = 'public.platform_alerts_active'::regclass AND attnum > 0 AND NOT attisdropped;")
        self.assertEqual(self.cur.fetchone()[0], VIEW_COLUMNS)
        self.cur.execute(
            "SELECT 'security_invoker=true' = ANY (reloptions) FROM pg_class"
            " WHERE oid = 'public.platform_alerts_active'::regclass;")
        self.assertTrue(self.cur.fetchone()[0])


class TheStamp(WindowsBase):
    def test_an_occurrence_that_starts_in_a_window_records_it(self):
        window = self.window(device_id=self.device, starts="-2 hours")
        self.assertEqual(self.stamp(self.alert(self.device)), window)
        self.assertIsNone(self.stamp(self.alert(self.loose)))

    def test_an_occurrence_arriving_firing_inside_a_window_records_it(self):
        window = self.window(device_id=self.device, starts="-10 minutes")
        self.assertEqual(self.stamp(self.alert(self.device)), window)

    def test_a_window_opened_over_a_firing_alert_stamps_it(self):
        alert = self.alert(self.device)
        self.assertIsNone(self.stamp(alert))
        window = self.schedule(MANAGER_ID, "device", self.device)[0]
        self.assertEqual(self.stamp(alert), window)

    def test_a_window_that_starts_later_is_stamped_by_the_minute_job(self):
        alert = self.alert(self.inheriting)
        window = self.schedule(MANAGER_ID, "cell", self.cell, starts="+1 hour", ends="+2 hours")[0]
        self.assertIsNone(self.stamp(alert))
        # Its start arrives; the job pg_cron runs every minute stamps it.
        self.cur.execute("UPDATE public.alert_suppression_windows SET starts_at = now() - interval '1 second'"
                         " WHERE id = %s;", (window,))
        self.cur.execute("SELECT public.stamp_platform_alerts_suppression();")
        self.assertEqual(self.cur.fetchone()[0], 1)
        self.assertEqual(self.stamp(alert), window)
        self.cur.execute("SELECT jobname, schedule FROM cron.job WHERE command = 'SELECT public.stamp_platform_alerts_suppression()';")
        self.assertEqual(self.cur.fetchall(), [("stamp_platform_alerts_suppression", "* * * * *")])

    def test_only_the_newest_firing_occurrence_is_stamped(self):
        fingerprint = f"fp-0240-{uuid.uuid4()}"
        self.cur.execute("SELECT now() - interval '3 hours', now() - interval '2 hours';")
        older, newer = self.cur.fetchone()
        superseded = self.alert(self.device, fingerprint=fingerprint, starts_at=older)
        newest = self.alert(self.device, fingerprint=fingerprint, starts_at=newer)
        resolved = self.alert(self.device, status="resolved", starts_at=older)
        self.schedule(MANAGER_ID, "device", self.device)
        self.assertIsNone(self.stamp(superseded))
        self.assertIsNotNone(self.stamp(newest))
        self.assertIsNone(self.stamp(resolved))

    def test_nothing_clears_or_moves_it(self):
        alert = self.alert(self.device)
        window = self.schedule(MANAGER_ID, "device", self.device)[0]
        self.change(MANAGER_ID, window, reason="Longer")
        self.end(MANAGER_ID, window)
        self.assertEqual(self.stamp(alert), window)
        self.assertFalse(self.active(alert)[0])
        # The webhook's upsert, a direct clear and a direct move all leave it.
        self.cur.execute("SELECT fingerprint, starts_at FROM public.platform_alerts WHERE id = %s;", (alert,))
        fingerprint, starts_at = self.cur.fetchone()
        self.alert(self.device, fingerprint=fingerprint, starts_at=starts_at)
        self.cur.execute("UPDATE public.platform_alerts SET suppression_window_id = NULL WHERE id = %s;", (alert,))
        self.cur.execute("UPDATE public.platform_alerts SET suppression_window_id = %s WHERE id = %s;",
                         (str(uuid.uuid4()), alert))
        self.assertEqual(self.stamp(alert), window)

    def test_a_person_cannot_write_it(self):
        alert = self.alert(self.device)
        self.assertRefused("42501", self.as_person, ADMIN_ID,
                           "UPDATE public.platform_alerts SET suppression_window_id = %s WHERE id = %s;",
                           (str(uuid.uuid4()), alert))


class TheAuditRows(WindowsBase):
    def test_each_act_writes_one_row_in_the_subject_s_lane(self):
        lanes = (("device", self.device, "devices", "Test_0240_Press"),
                 ("gateway", self.gateway, "gateways", "Test_0240_GW"),
                 ("cell", self.cell, "cells", "Test_0240_Cell_A"))
        for kind, subject, lane, name in lanes:
            window = self.schedule(MANAGER_ID, kind, subject, reason="Belt change")[0]
            self.change(ADMIN_ID, window, reason="Gearbox swap")
            upcoming = self.schedule(MANAGER_ID, kind, subject, starts="+1 day", ends="+2 days")[0]
            self.end(MANAGER_ID, upcoming)
            # Ended once its start has passed.
            self.cur.execute("UPDATE public.alert_suppression_windows SET starts_at = now() - interval '1 hour'"
                             " WHERE id = %s;", (window,))
            self.end(ADMIN_ID, window)

            rows = [r for r in self.audit_rows() if r[2] == subject]
            self.assertEqual([r[0] for r in rows], [
                "SUPPRESSION_WINDOW_SCHEDULED", "SUPPRESSION_WINDOW_CHANGED", "SUPPRESSION_WINDOW_SCHEDULED",
                "SUPPRESSION_WINDOW_CANCELLED", "SUPPRESSION_WINDOW_ENDED"], kind)
            for action, entity_type, _, domain, by, source, old, new, klass in rows:
                self.assertEqual((entity_type, domain, source, klass), (lane, "asset", "user", "operational"), action)
                self.assertIn(by, (MANAGER_ID, ADMIN_ID))
                snapshot = new or old
                self.assertEqual((snapshot["name"], snapshot["subject_kind"], snapshot["subject_id"]),
                                 (name, kind, subject))
            scheduled, changed, _, cancelled, ended = rows
            self.assertIsNone(scheduled[6])
            self.assertEqual(scheduled[7]["reason"], "Belt change")
            self.assertEqual((changed[6]["reason"], changed[7]["reason"]), ("Belt change", "Gearbox swap"))
            self.assertEqual((cancelled[6]["window_id"], cancelled[7]), (upcoming, None))
            self.assertEqual((ended[6]["ended_by_email"], ended[7]["ended_by_email"]), (None, self.email(ADMIN_ID)))

    def test_the_map_of_kinds_lists_each_act(self):
        self.cur.execute("SELECT action, entity_type, classes FROM public.audit_trail_action_kinds()"
                         " WHERE action = ANY (%s) ORDER BY 1, 2;", (ACTIONS,))
        self.assertEqual(self.cur.fetchall(), [
            (action, kind, ["operational", "configuration", "lifecycle"])
            for action in sorted(ACTIONS) for kind in ("cells", "devices", "gateways")])

    def test_the_lane_s_readers_read_them(self):
        self.schedule(MANAGER_ID, "device", self.device)
        for person in (MANAGER_ID, AUDITOR_ID, ADMIN_ID):
            rows = self.as_person(person, "SELECT action FROM public.audit_trail WHERE entity_id = %s"
                                          "   AND action = 'SUPPRESSION_WINDOW_SCHEDULED';", (self.device,))
            self.assertEqual(rows, [("SUPPRESSION_WINDOW_SCHEDULED",)], person)


if __name__ == "__main__":
    unittest.main(verbosity=2)
