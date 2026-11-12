"""
A number setting says whether it counts whole things (0285), and a part value never stops a
proposal (0286).

    python supabase/migrations/test_a_number_setting_says_whether_it_counts_whole_things.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * Every number setting is decided. DECISIONS lists each with the reader that decided it, and the
    test fails on a number setting it does not list, so a new one is decided when it is added.
    system_settings.whole_number is true for the nine that count whole things and false for the
    fraction, is never null, and is true only for a number.
  * The guard, for each kind: a whole setting refuses 1.5 and 0.5 and says "<key> must be a whole
    number", with "of hours", "of days" or "of seconds" by the key's last word, and accepts 2 and
    2.0; the fraction accepts 0.125. It binds an Administrator through the API's role and the service
    role, an INSERT as well as an UPDATE, and it looks at a row only when its value or its flag
    changes: a label refreshed on a row holding a part value passes, and a flag set over one is
    refused.
  * The reminder interval's refusal is the sentence 0248 gave it, from the generic guard, and
    notification_setting_guard() keeps every other arm.
  * The upgrade, by running 0285's file in the transaction over a database as 1.8.0 left it: a part
    value stored in each of the nine is rounded down, with a NOTICE naming the key, the old value and
    the new one, and an Audit Trail row that carries both; the fraction is left; the flags are set;
    a floor is never undercut; and a replay writes nothing and says nothing.
  * The two readers that took a part day as it was: a stored part day is its whole days, and the
    suppression refusal says whole days.
  * The cap on open proposals (0286): saving 10.5 is refused, and a stored 10.5 (written past the
    guard) admits a proposal at its floor and refuses the one after, with the cap's own sentence and
    never a cast error.

EVERY TEST ROLLS BACK.
"""
import json
import os
import re
import unittest
import uuid
from pathlib import Path

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

FILE = Path(__file__).with_name("0285_a_number_setting_says_whether_it_counts_whole_things.sql")
GUARD_TRIGGER = "system_settings_whole_number_trg"
ROW = "test_0285.row"
FLAG_ROW = "UPDATE public.system_settings SET whole_number = true WHERE key = %s;"
GUARD_OFF = "ALTER TABLE public.system_settings DISABLE TRIGGER system_settings_whole_number_trg;"
GUARD_ON = "ALTER TABLE public.system_settings ENABLE TRIGGER system_settings_whole_number_trg;"

ADMIN_ID = "a0d17285-0000-4000-8000-0000000285a1"
OPERATOR_ID = "a0d17285-0000-4000-8000-0000000285a2"

# Every number setting, whether it counts whole things, and the reader that decided it.
DECISIONS = {
    "proposals.max_open_per_person": (True, "enforce_open_proposal_cap() compares a count of proposals with it"),
    "proposals.open_expiry_days": (True, "expire_open_proposals() turns days into an interval"),
    "proposals.retention_days": (True, "prune_closed_proposals() turns days into an interval"),
    "alerts.retention_days": (True, "prune_platform_alerts() builds an interval from days"),
    "alerts.suppression_max_days": (True, "check_alert_suppression_window_length() took 1.5 as 36 hours"),
    "archive.tier_after_days": (True, "cold_archive_backlog_state() reads it ::integer; cold_archive.py takes int()"),
    "notifications.reminder_hours": (True, "queue_platform_alert_reminders(); 0248 already refused a part hour"),
    "history.export_max_days": (True, "telemetry_export_max_days() measures a window in seconds; nobody needs 1.5 days"),
    "ui.audit_trail_poll_seconds": (True, "AuditTrailTab.jsx multiplies it by 1000 for setInterval; nobody needs a fraction"),
    "site_map.min_pin_spacing": (False, "place_cell_in_its_area() compares a distance with it: a fraction of a plan"),
}
WHOLE = sorted(key for key, (whole, _) in DECISIONS.items() if whole)
UNIT_WORDS = {"_hours": " of hours", "_days": " of days", "_seconds": " of seconds"}

# A database as 1.8.0 left it: a part value in each whole setting, and one in the fraction.
STORED_PART = {
    "proposals.max_open_per_person": 10.5,
    "proposals.open_expiry_days": 7.25,
    "proposals.retention_days": 90.5,
    "alerts.retention_days": 1.5,
    "alerts.suppression_max_days": 2.7,
    "archive.tier_after_days": 14.9,
    "notifications.reminder_hours": 5.5,
    "history.export_max_days": 3.2,
    "ui.audit_trail_poll_seconds": 30.5,
}
ROUNDED = {"proposals.max_open_per_person": 10, "proposals.open_expiry_days": 7, "proposals.retention_days": 90,
           "alerts.retention_days": 1, "alerts.suppression_max_days": 2, "archive.tier_after_days": 14,
           "notifications.reminder_hours": 5, "history.export_max_days": 3, "ui.audit_trail_poll_seconds": 30}


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def unit_words(key):
    return next((words for suffix, words in UNIT_WORDS.items() if key.endswith(suffix)), "")


class SettingsBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.system_settings_whole_number_guard()') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0285 is not applied to this database")
        self.cur.execute("SELECT name, id FROM public.roles;")
        roles = dict(self.cur.fetchall())
        for user_id, role in ((ADMIN_ID, "Administrator"), (OPERATOR_ID, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, "%s@whole-number.test" % user_id[-4:]))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- helpers ---------------------------------------------------------------------------------
    def run_as(self, user, role, statement, args=()):
        """Run one statement as PostgREST would for `user` under `role`. A refusal rolls back to the
        savepoint, so the test goes on, and is raised."""
        self.cur.execute("SAVEPOINT as_role;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            claims = {"sub": user, "role": role, "aal": "aal1", "email": "%s@whole-number.test" % user[-4:]}
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(statement, args)
            rows = self.cur.rowcount
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT as_role;")
            raise
        finally:
            self.cur.execute("RESET ROLE;")
            self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT as_role;")
        return rows

    def save(self, key, value, user=ADMIN_ID, role="authenticated"):
        """An Administrator's change of a setting through the API's role."""
        return self.run_as(user, role, "UPDATE public.system_settings SET value = %s WHERE key = %s;",
                           (Json(value), key))

    def owner_save(self, key, value):
        self.cur.execute("UPDATE public.system_settings SET value = %s WHERE key = %s;", (Json(value), key))
        return self.cur.rowcount

    def refused(self, fn, *args, **kwargs):
        """The CheckViolation `fn` raises; the transaction goes on after it."""
        self.cur.execute("SAVEPOINT refused;")
        try:
            with self.assertRaises(psycopg2.errors.CheckViolation) as caught:
                fn(*args, **kwargs)
            return caught.exception
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
            self.cur.execute("RELEASE SAVEPOINT refused;")

    def past_the_guard(self, statement, args=()):
        """Write as a row stored before the guard would be: with its trigger off, for this statement."""
        self.cur.execute(GUARD_OFF)
        try:
            self.cur.execute(statement, args)
        finally:
            self.cur.execute(GUARD_ON)

    def store_past_the_guard(self, key, value):
        self.past_the_guard("UPDATE public.system_settings SET value = %s WHERE key = %s;", (Json(value), key))

    def stored(self, key):
        self.cur.execute("SELECT value FROM public.system_settings WHERE key = %s;", (key,))
        return self.cur.fetchone()[0]

    def flag(self, key):
        self.cur.execute("SELECT whole_number FROM public.system_settings WHERE key = %s;", (key,))
        return self.cur.fetchone()[0]


class TestEverySettingIsDecided(SettingsBase):
    def test_every_number_setting_is_listed_with_the_reader_that_decided_it(self):
        self.cur.execute("SELECT key FROM public.system_settings WHERE value_type = 'number' ORDER BY key;")
        live = [key for (key,) in self.cur.fetchall()]
        self.assertEqual(live, sorted(DECISIONS),
                         "a number setting is added or gone: decide whether it counts whole things in DECISIONS,"
                         " and set whole_number beside its bounds in its migration")

    def test_each_is_flagged_as_decided(self):
        self.cur.execute("SELECT key, whole_number FROM public.system_settings WHERE value_type = 'number';")
        self.assertEqual(dict(self.cur.fetchall()), {key: whole for key, (whole, _) in DECISIONS.items()})

    def test_nine_are_whole_and_the_fraction_is_not(self):
        self.assertEqual(len(WHOLE), 9)
        self.assertFalse(self.flag("site_map.min_pin_spacing"))

    def test_the_flag_is_never_null_and_is_false_by_default(self):
        self.cur.execute("SELECT is_nullable, column_default, data_type FROM information_schema.columns"
                         " WHERE table_schema = 'public' AND table_name = 'system_settings'"
                         "   AND column_name = 'whole_number';")
        self.assertEqual(self.cur.fetchall(), [("NO", "false", "boolean")])

    def test_only_a_number_can_be_whole(self):
        self.cur.execute("SELECT count(*) FROM public.system_settings WHERE whole_number AND value_type <> 'number';")
        self.assertEqual(self.cur.fetchone()[0], 0)
        error = self.refused(self.cur.execute,
                             "UPDATE public.system_settings SET whole_number = true"
                             " WHERE key = 'notifications.webhook_min_severity';")
        self.assertEqual(error.diag.constraint_name, "system_settings_whole_number_is_a_number")

    def test_no_whole_setting_holds_a_part_value(self):
        self.cur.execute("SELECT key FROM public.system_settings WHERE whole_number"
                         " AND (value #>> '{}')::numeric <> trunc((value #>> '{}')::numeric);")
        self.assertEqual(self.cur.fetchall(), [])

    def test_seed_setting_still_takes_its_seven_arguments(self):
        # The flag is no argument of seed_setting(): one more, defaulted, would make every
        # seven-argument call ambiguous while 0001 declares the seven-argument form on every boot.
        self.cur.execute("SELECT count(*) FROM pg_proc WHERE proname = 'seed_setting'"
                         " AND pronamespace = 'public'::regnamespace;")
        self.assertEqual(self.cur.fetchone()[0], 1)
        self.cur.execute("SELECT public.seed_setting('test_0285.probe', to_jsonb(3), 'number', 'Test', 'Probe');")
        self.assertFalse(self.flag("test_0285.probe"))


class TestAWholeSetting(SettingsBase):
    def test_each_refuses_a_part_value_in_its_own_words(self):
        for key in WHOLE:
            for value in (1.5, 10.25, 0.5):
                with self.subTest(key=key, value=value):
                    error = self.refused(self.owner_save, key, value)
                    self.assertEqual(error.pgcode, "23514")
                    self.assertEqual(error.diag.message_primary, "%s must be a whole number%s" % (key, unit_words(key)))

    def test_the_reminder_interval_keeps_the_sentence_0248_gave_it(self):
        error = self.refused(self.save, "notifications.reminder_hours", 1.5)
        self.assertEqual(error.diag.message_primary, "notifications.reminder_hours must be a whole number of hours")

    def test_the_cap_says_no_unit(self):
        error = self.refused(self.save, "proposals.max_open_per_person", 10.5)
        self.assertEqual(error.diag.message_primary, "proposals.max_open_per_person must be a whole number")

    def test_each_accepts_a_whole_value_however_it_is_written(self):
        for key in WHOLE:
            self.cur.execute("SELECT min_value FROM public.system_settings WHERE key = %s;", (key,))
            floor = self.cur.fetchone()[0]
            low = int(floor) if floor is not None else 30
            for value in (low, float(low), low + 1, low + 2.0):
                with self.subTest(key=key, value=value):
                    self.assertEqual(self.owner_save(key, value), 1)
                    self.assertEqual(float(self.stored(key)), float(value))

    def test_an_administrator_through_the_api_role_is_refused_and_a_whole_value_saves(self):
        for key in WHOLE:
            with self.subTest(key=key):
                self.refused(self.save, key, 2.5)
                self.assertEqual(self.save(key, 2 if key != "proposals.retention_days" else 8), 1)

    def test_the_service_role_is_refused_too(self):
        for key in ("proposals.max_open_per_person", "alerts.retention_days", "notifications.reminder_hours"):
            with self.subTest(key=key):
                error = self.refused(self.save, key, 3.5, ADMIN_ID, "service_role")
                self.assertEqual(error.diag.message_primary, "%s must be a whole number%s" % (key, unit_words(key)))

    def test_a_row_made_whole_with_a_part_value_is_refused_and_one_made_part_is_not(self):
        sql = ("INSERT INTO public.system_settings (key, value, value_type, category, label, whole_number)"
               " VALUES (%s, %s, 'number', 'Test', 'A test', %s);")
        error = self.refused(self.cur.execute, sql, ("test_0285.counted", Json(2.5), True))
        self.assertEqual(error.diag.message_primary, "test_0285.counted must be a whole number")
        self.cur.execute(sql, ("test_0285.counted", Json(2), True))
        self.cur.execute(sql, ("test_0285.measured", Json(2.5), False))
        self.assertEqual(self.stored("test_0285.measured"), 2.5)

    def test_a_value_that_is_not_a_number_is_left_to_the_type_check(self):
        # The guard reads a number and nothing else; the table's own CHECK refuses the rest.
        error = self.refused(self.owner_save, "proposals.max_open_per_person", "ten")
        self.assertEqual(error.diag.constraint_name, "system_settings_value_matches_type")


class TestAFractionSetting(SettingsBase):
    def test_the_pin_spacing_takes_a_part_value(self):
        for value in (0.125, 0.01, 0.5, 0):
            with self.subTest(value=value):
                self.assertEqual(self.save("site_map.min_pin_spacing", value), 1)
                self.assertEqual(float(self.stored("site_map.min_pin_spacing")), float(value))

    def test_its_bounds_still_hold(self):
        for value in (0.6, -0.1):
            with self.subTest(value=value):
                error = self.refused(self.save, "site_map.min_pin_spacing", value)
                self.assertEqual(error.diag.constraint_name, "system_settings_value_within_bounds")


class TestTheGuardLooksAtWhatChanged(SettingsBase):
    KEY = "alerts.retention_days"

    def test_a_label_refreshed_on_a_row_holding_a_part_value_passes(self):
        # seed_setting() refreshes the label and the description on every replay that changes them,
        # and a stored part value must not turn that into a failed boot.
        self.store_past_the_guard(self.KEY, 1.5)
        self.cur.execute("UPDATE public.system_settings SET label = label || ' ', description = 'x' WHERE key = %s;",
                         (self.KEY,))
        self.assertEqual(self.cur.rowcount, 1)
        self.assertEqual(self.stored(self.KEY), 1.5)

    def test_the_same_value_written_again_passes(self):
        self.store_past_the_guard(self.KEY, 1.5)
        self.assertEqual(self.owner_save(self.KEY, 1.5), 1)

    def a_row(self, value):
        self.cur.execute("INSERT INTO public.system_settings (key, value, value_type, category, label)"
                         " VALUES (%s, %s, 'number', 'Test', 'A test');", (ROW, Json(value)))

    def test_a_flag_set_over_a_stored_part_value_is_refused(self):
        self.a_row(2.5)
        error = self.refused(self.cur.execute, FLAG_ROW, (ROW,))
        self.assertEqual(error.diag.message_primary, ROW + " must be a whole number")

    def test_a_flag_set_over_a_whole_value_passes(self):
        self.a_row(2)
        self.cur.execute(FLAG_ROW, (ROW,))
        self.assertEqual(self.cur.rowcount, 1)

    def test_a_change_to_a_part_value_is_still_refused_after_the_label_is_refreshed(self):
        self.store_past_the_guard(self.KEY, 1.5)
        self.refused(self.owner_save, self.KEY, 2.5)


class TestTheNotificationGuardKeepsItsOtherArms(SettingsBase):
    def test_it_no_longer_names_the_reminder_interval(self):
        self.cur.execute("SELECT pg_get_functiondef('public.notification_setting_guard()'::regprocedure);")
        self.assertNotIn("reminder_hours", self.cur.fetchone()[0])

    def test_it_is_still_a_security_definer_function_no_browser_role_runs(self):
        self.cur.execute("SELECT prosecdef, has_function_privilege('authenticated', oid, 'EXECUTE'),"
                         " has_function_privilege('anon', oid, 'EXECUTE')"
                         " FROM pg_proc WHERE oid = 'public.notification_setting_guard()'::regprocedure;")
        self.assertEqual(self.cur.fetchone(), (True, False, False))

    def test_each_other_arm_still_refuses_what_it_did(self):
        for key, value, sentence in (
                ("notifications.webhook_min_severity", "urgent", "must be info, warning or critical"),
                ("notifications.email_min_severity", "loud", "must be info, warning or critical"),
                ("notifications.email_roles", ["Nobody"], "names 'Nobody', which is not a role"),
                ("notifications.webhook_allowed_hosts", ["https://hooks.example.net"], None)):
            with self.subTest(key=key):
                error = self.refused(self.save, key, value)
                self.assertEqual(error.pgcode, "23514")
                self.assertTrue(error.diag.message_primary.startswith(key + " "), error.diag.message_primary)
                if sentence:
                    self.assertEqual(error.diag.message_primary, "%s %s" % (key, sentence))

    def test_each_other_arm_still_accepts_what_it_did(self):
        self.assertEqual(self.save("notifications.webhook_min_severity", "critical"), 1)
        self.assertEqual(self.save("notifications.email_roles", ["Administrator"]), 1)


class TestTheUpgrade(SettingsBase):
    """0285's file, run in the transaction over a database as 1.8.0 left it."""

    def as_1_8_0(self, part=None):
        self.cur.execute(GUARD_OFF)
        self.cur.execute("UPDATE public.system_settings SET whole_number = false;")
        for key, value in (part or STORED_PART).items():
            self.cur.execute("UPDATE public.system_settings SET value = %s WHERE key = %s;", (Json(value), key))
        self.cur.execute("UPDATE public.system_settings SET value = to_jsonb(0.125) WHERE key = 'site_map.min_pin_spacing';")
        self.cur.execute(GUARD_ON)

    def upgrade(self):
        del self.conn.notices[:]
        self.cur.execute(FILE.read_text(encoding="utf-8"))
        return [n for n in self.conn.notices if "0285:" in n]

    def mark(self):
        """The newest audit row so far: what the file writes is after it. recorded_at is the
        transaction's start, one value for the whole test, so the id is what orders the rows."""
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail;")
        self.after_id = self.cur.fetchone()[0]

    def audit_rows(self, key):
        self.cur.execute("SELECT action, actor_source, old_data ->> 'value', new_data ->> 'value'"
                         " FROM public.audit_trail WHERE entity_type = 'system_settings'"
                         "   AND new_data ->> 'key' = %s AND id > %s ORDER BY id;", (key, self.after_id))
        return self.cur.fetchall()

    def test_each_part_value_in_a_whole_setting_is_rounded_down(self):
        self.as_1_8_0()
        self.upgrade()
        for key, rounded in ROUNDED.items():
            with self.subTest(key=key):
                self.assertEqual(self.stored(key), rounded)
                self.assertTrue(self.flag(key))

    def test_the_fraction_is_left_as_it_was_and_unflagged(self):
        self.as_1_8_0()
        self.upgrade()
        self.assertEqual(self.stored("site_map.min_pin_spacing"), 0.125)
        self.assertFalse(self.flag("site_map.min_pin_spacing"))

    def test_each_rounding_is_a_notice_naming_the_key_the_old_value_and_the_new_one(self):
        self.as_1_8_0()
        notices = self.upgrade()
        self.assertEqual(len(notices), len(ROUNDED), notices)
        for key, old in STORED_PART.items():
            with self.subTest(key=key):
                line = [n for n in notices if "0285: %s held" % key in n]
                self.assertEqual(len(line), 1, notices)
                self.assertIn("0285: %s held %s and now holds %s;" % (key, old, ROUNDED[key]), line[0])

    def test_each_rounding_is_in_the_audit_trail_with_the_old_value_and_the_new_one(self):
        self.as_1_8_0()
        self.mark()
        self.upgrade()
        for key, old in STORED_PART.items():
            with self.subTest(key=key):
                rows = self.audit_rows(key)
                self.assertIn(("UPDATE", "migration", str(old), str(ROUNDED[key])), rows)

    def test_a_floor_is_never_undercut(self):
        # A fractional floor, which no setting has: floor(2.7) is 2, below it, so the value is the
        # floor's own ceiling and the table's bounds still hold.
        self.as_1_8_0()
        self.cur.execute("UPDATE public.system_settings SET min_value = 2.5 WHERE key = 'alerts.suppression_max_days';")
        self.upgrade()
        self.assertEqual(self.stored("alerts.suppression_max_days"), 3)

    def test_a_replay_with_nothing_to_round_writes_nothing_and_says_nothing(self):
        self.as_1_8_0()
        self.upgrade()
        self.mark()
        notices = self.upgrade()
        self.assertEqual(notices, [])
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE id > %s;", (self.after_id,))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_a_part_value_that_reaches_a_replay_is_rounded_again(self):
        self.as_1_8_0()
        self.upgrade()
        self.store_past_the_guard("alerts.retention_days", 4.5)
        notices = self.upgrade()
        self.assertEqual(len(notices), 1, notices)
        self.assertEqual(self.stored("alerts.retention_days"), 4)

    def test_values_the_site_chose_that_are_whole_are_kept(self):
        self.as_1_8_0(part={"alerts.retention_days": 30, "proposals.max_open_per_person": 25})
        notices = self.upgrade()
        self.assertEqual(notices, [])
        self.assertEqual(self.stored("alerts.retention_days"), 30)
        self.assertEqual(self.stored("proposals.max_open_per_person"), 25)

    def test_the_file_leaves_the_guard_and_the_trigger_in_place(self):
        self.as_1_8_0()
        self.upgrade()
        self.cur.execute("SELECT tgenabled, tgtype FROM pg_trigger WHERE tgname = %s"
                         " AND tgrelid = 'public.system_settings'::regclass;", (GUARD_TRIGGER,))
        self.assertEqual(self.cur.fetchall(), [("O", 23)])


class TestTheDayReaders(SettingsBase):
    def window(self, extra):
        self.cur.execute("SELECT public.check_alert_suppression_window_length(now(), now() + %s::interval);", (extra,))

    def test_a_stored_part_day_is_its_whole_days_for_a_suppression_window(self):
        self.store_past_the_guard("alerts.suppression_max_days", 1.5)
        self.window("24 hours")
        self.cur.execute("SAVEPOINT too_long;")
        with self.assertRaises(psycopg2.Error) as caught:
            self.window("24 hours 1 minute")
        self.cur.execute("ROLLBACK TO SAVEPOINT too_long;")
        self.assertEqual(caught.exception.pgcode, "22023")
        self.assertEqual(caught.exception.diag.message_primary,
                         "A window can last at most 1 day, set on Settings › Retention.")

    def test_the_refusal_says_whole_days(self):
        for days, words in ((2, "2 days"), (7, "7 days"), (90, "90 days")):
            with self.subTest(days=days):
                self.owner_save("alerts.suppression_max_days", days)
                self.cur.execute("SAVEPOINT too_long;")
                with self.assertRaises(psycopg2.Error) as caught:
                    self.window("%d days 1 minute" % days)
                self.cur.execute("ROLLBACK TO SAVEPOINT too_long;")
                self.assertEqual(caught.exception.diag.message_primary,
                                 "A window can last at most %s, set on Settings › Retention." % words)
                self.window("%d days" % days)

    def test_a_missing_or_out_of_range_limit_is_still_seven_days(self):
        self.cur.execute("DELETE FROM public.system_settings WHERE key = 'alerts.suppression_max_days';")
        self.window("7 days")
        self.cur.execute("SAVEPOINT too_long;")
        with self.assertRaises(psycopg2.Error):
            self.window("7 days 1 minute")
        self.cur.execute("ROLLBACK TO SAVEPOINT too_long;")

    def test_a_stored_part_day_is_its_whole_days_for_an_export(self):
        for stored, expected in ((1.5, 1), (14.9, 14), (366, 366), (3, 3)):
            with self.subTest(stored=stored):
                self.store_past_the_guard("history.export_max_days", stored)
                self.cur.execute("SELECT public.telemetry_export_max_days();")
                self.assertEqual(self.cur.fetchone()[0], expected)

    def test_an_export_limit_outside_its_bounds_or_missing_is_fourteen(self):
        self.past_the_guard("UPDATE public.system_settings SET max_value = NULL, min_value = NULL"
                            " WHERE key = 'history.export_max_days';")
        for stored in (0.5, 367.5, 1000):
            with self.subTest(stored=stored):
                self.store_past_the_guard("history.export_max_days", stored)
                self.cur.execute("SELECT public.telemetry_export_max_days();")
                self.assertEqual(self.cur.fetchone()[0], 14)
        self.cur.execute("DELETE FROM public.system_settings WHERE key = 'history.export_max_days';")
        self.cur.execute("SELECT public.telemetry_export_max_days();")
        self.assertEqual(self.cur.fetchone()[0], 14)


class TestTheProposalCap(SettingsBase):
    """0286: the cap on open proposals reads a stored part value as its floor."""

    KEY = "proposals.max_open_per_person"

    def device(self):
        device_id = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.devices (id, name) VALUES (%s, %s);", (device_id, "Test_0286_" + device_id[:8]))
        return device_id

    def propose(self, device_id):
        return self.run_as(OPERATOR_ID, "authenticated",
                           "INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
                           " VALUES ('devices', %s, %s::jsonb, 'the label is worn off');",
                           (device_id, json.dumps({"description": "worn"})))

    def test_saving_a_part_value_is_refused_with_the_rule(self):
        error = self.refused(self.save, self.KEY, 10.5)
        self.assertEqual(error.diag.message_primary, self.KEY + " must be a whole number")

    def test_a_stored_part_value_admits_a_proposal_at_its_floor(self):
        self.store_past_the_guard(self.KEY, 1.5)
        self.assertEqual(self.propose(self.device()), 1)
        # The second is over the floor, and the person is told the rule, not a database error.
        self.cur.execute("SAVEPOINT second;")
        with self.assertRaises(psycopg2.errors.CheckViolation) as caught:
            self.propose(self.device())
        self.cur.execute("ROLLBACK TO SAVEPOINT second;")
        self.assertEqual(caught.exception.diag.message_primary,
                         "you already have 1 open proposal(s), which is the limit; decide or withdraw one first")

    def test_a_stored_ten_and_a_half_admits_the_tenth_and_refuses_the_eleventh(self):
        self.store_past_the_guard(self.KEY, 10.5)
        for _ in range(10):
            self.assertEqual(self.propose(self.device()), 1)
        self.cur.execute("SAVEPOINT eleventh;")
        with self.assertRaises(psycopg2.errors.CheckViolation) as caught:
            self.propose(self.device())
        self.cur.execute("ROLLBACK TO SAVEPOINT eleventh;")
        self.assertEqual(caught.exception.diag.message_primary,
                         "you already have 10 open proposal(s), which is the limit; decide or withdraw one first")

    def test_a_whole_setting_is_read_as_it_always_was(self):
        self.owner_save(self.KEY, 2)
        self.assertEqual(self.propose(self.device()), 1)
        self.assertEqual(self.propose(self.device()), 1)
        self.cur.execute("SAVEPOINT third;")
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.propose(self.device())
        self.cur.execute("ROLLBACK TO SAVEPOINT third;")

    def test_a_missing_setting_is_ten(self):
        self.cur.execute("DELETE FROM public.system_settings WHERE key = %s;", (self.KEY,))
        for _ in range(10):
            self.propose(self.device())
        self.cur.execute("SAVEPOINT eleventh;")
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.propose(self.device())
        self.cur.execute("ROLLBACK TO SAVEPOINT eleventh;")

    def test_the_function_reads_the_cap_as_a_floor_and_stays_security_definer(self):
        self.cur.execute("SELECT prosrc, prosecdef, has_function_privilege('anon', oid, 'EXECUTE'),"
                         " has_function_privilege('authenticated', oid, 'EXECUTE')"
                         " FROM pg_proc WHERE oid = 'public.enforce_open_proposal_cap()'::regprocedure;")
        body, definer, anon, authenticated = self.cur.fetchone()
        self.assertTrue(re.search(r"floor\(\(value #>> '\{\}'\)::numeric\)::integer", body), body)
        self.assertEqual((definer, anon, authenticated), (True, False, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
