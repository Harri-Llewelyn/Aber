"""
Alert history is kept for 90 days, and a site still at 7 moves to 90 once (0244, with 0001's prune
and 0002's seed).

    python supabase/migrations/test_alert_history_is_kept_for_90_days.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

A boot here is 0002's own block for the setting, read out of the migration so a copy cannot drift
from it, run twice as db-init runs it on two boots. What is held:

  * A fresh install seeds 90, with 1.8's description, and a second boot keeps it.
  * An upgrade from 1.7's row at 7 moves it to 90, and a second boot keeps 90.
  * A site at 30 keeps 30 across both boots, and takes 1.8's description.
  * A person who sets 7 after the upgrade keeps it on the next boot.
  * prune_platform_alerts() falls back to 90 days where the setting cannot be read.
  * What 0244 checks: the description is no longer 1.7's and names 90 days.

Every test rolls back.
"""
import json
import os
import unittest
from pathlib import Path

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

SEED = Path(__file__).resolve().parent / "0002_seed_data.sql"
KEY = "alerts.retention_days"

# What every release from 1.0.0 to 1.7.x wrote, the text 0002's guard matches.
OLD_DESCRIPTION = (
    "How long a resolved or superseded alert occurrence is kept before the nightly prune removes "
    "it. The telemetry that triggered the alert is retained separately under the historian's own "
    "policy, so shortening this destroys no measurement -- only the record that a threshold was "
    "crossed. A currently firing alert is never removed however old it is."
)

ADMIN_ID = "a0d17244-0000-4000-8000-0000000244a1"


def boot_block():
    """0002's block for the setting: the once-only move, then its seed_setting() call."""
    seed = SEED.read_text(encoding="utf-8")
    start = seed.index("-- 1.8.0 keeps alert history for 90 days")
    call = seed.index(f"SELECT public.seed_setting(\n    '{KEY}',", start)
    return seed[start:seed.index("\n);\n", call) + len("\n);")]


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class RetentionBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.block = boot_block()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def boot(self):
        self.cur.execute(self.block)

    def setting(self):
        self.cur.execute("SELECT (value #>> '{}')::numeric, description FROM public.system_settings WHERE key = %s;", (KEY,))
        return self.cur.fetchone()

    def as_it_was(self, value, description=OLD_DESCRIPTION):
        """The row as an earlier release left it, written past the triggers' stamps as a boot would."""
        self.cur.execute(
            "UPDATE public.system_settings SET value = to_jsonb(%s::numeric), description = %s WHERE key = %s;",
            (value, description, KEY))


class TheOnceOnlyMove(RetentionBase):
    def test_the_block_is_the_guard_then_the_seed(self):
        self.assertIn("UPDATE public.system_settings", self.block)
        self.assertIn("to_jsonb(90)", self.block)
        self.assertLess(self.block.index("UPDATE public.system_settings"), self.block.index("SELECT public.seed_setting("))

    def test_a_fresh_install_seeds_90_and_keeps_it(self):
        self.cur.execute("DELETE FROM public.system_settings WHERE key = %s;", (KEY,))
        for boot in (1, 2):
            with self.subTest(boot=boot):
                self.boot()
                value, description = self.setting()
                self.assertEqual(value, 90)
                self.assertNotEqual(description, OLD_DESCRIPTION)
                self.assertIn("90 days", description)

    def test_an_upgrade_from_1_7_at_7_moves_to_90_once(self):
        self.as_it_was(7)
        for boot in (1, 2):
            with self.subTest(boot=boot):
                self.boot()
                self.assertEqual(self.setting()[0], 90)

    def test_a_site_at_30_keeps_30_and_takes_the_new_description(self):
        self.as_it_was(30)
        for boot in (1, 2):
            with self.subTest(boot=boot):
                self.boot()
                value, description = self.setting()
                self.assertEqual(value, 30)
                self.assertNotEqual(description, OLD_DESCRIPTION)

    def test_a_7_chosen_after_the_upgrade_stays(self):
        self.as_it_was(7)
        self.boot()
        self.assertEqual(self.setting()[0], 90)
        # An Administrator sets 7 on the Settings page, as PostgREST writes it.
        self.cur.execute("SELECT id FROM public.roles WHERE name = 'Administrator';")
        role = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, 'admin@retention.test', 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;", (ADMIN_ID,))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s) ON CONFLICT DO NOTHING;",
                         (ADMIN_ID, role))
        self.cur.execute("SELECT set_config('role', 'authenticated', true);")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": ADMIN_ID, "role": "authenticated"}),))
        self.cur.execute("UPDATE public.system_settings SET value = to_jsonb(7) WHERE key = %s RETURNING key;", (KEY,))
        self.assertEqual(self.cur.fetchall(), [(KEY,)], "the Administrator's write reached no row")
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        for boot in (2, 3):
            with self.subTest(boot=boot):
                self.boot()
                self.assertEqual(self.setting()[0], 7)

    def test_a_7_with_another_description_is_not_moved(self):
        # Only 1.7's exact text is the guard; nothing else reads as a release's default.
        self.as_it_was(7, OLD_DESCRIPTION + " ")
        self.boot()
        self.assertEqual(self.setting()[0], 7)

    def test_the_migrated_database_no_longer_holds_1_7_s_description(self):
        value, description = self.setting()
        self.assertNotEqual(description, OLD_DESCRIPTION)
        self.assertIn("90 days", description)


class ThePruneFallsBackTo90Days(RetentionBase):
    def insert_resolved(self, fingerprint, ended_days_ago):
        self.cur.execute(
            "INSERT INTO public.platform_alerts"
            "   (fingerprint, entity_type, alert_name, severity, status, starts_at, ends_at, recorded_at)"
            " VALUES (%s, 'platform', 'Fixture', 'info', 'resolved',"
            "         now() - make_interval(secs => (%s + 1) * 86400.0),"
            "         now() - make_interval(secs => %s * 86400.0),"
            "         now() - make_interval(secs => (%s + 1) * 86400.0));",
            (fingerprint, ended_days_ago, ended_days_ago, ended_days_ago))

    def kept(self, fingerprint):
        self.cur.execute("SELECT count(*) FROM public.platform_alerts WHERE fingerprint = %s;", (fingerprint,))
        return self.cur.fetchone()[0] == 1

    def test_without_the_setting_the_prune_keeps_90_days(self):
        self.cur.execute("DELETE FROM public.system_settings WHERE key = %s;", (KEY,))
        self.insert_resolved("t-0244-30-days", 30)
        self.insert_resolved("t-0244-89-days", 89)
        self.insert_resolved("t-0244-100-days", 100)
        self.cur.execute("SELECT public.prune_platform_alerts();")
        self.assertTrue(self.kept("t-0244-30-days"), "a 30-day-old alert was pruned, as a 7-day fallback would")
        self.assertTrue(self.kept("t-0244-89-days"))
        self.assertFalse(self.kept("t-0244-100-days"))

    def test_the_function_declares_90_days_and_not_7(self):
        self.cur.execute("SELECT prosrc FROM pg_proc WHERE oid = 'public.prune_platform_alerts(interval)'::regprocedure;")
        body = self.cur.fetchone()[0]
        self.assertIn("interval '90 days'", body)
        self.assertNotIn("interval '7 days'", body)


if __name__ == "__main__":
    unittest.main()
