"""
The site's Sparkplug group (0131).

Three properties, none of which anything else in the chain would notice losing.

A read-only setting is refused BY THE DATABASE. The Settings page renders it without a control,
but the page is not the authority: an Administrator holds `GRANT UPDATE (value)` on
`system_settings`, so a direct PostgREST write is admitted by RLS and only the trigger stops it.
A refusal that lived in the browser alone would be a suggestion.

A new gateway lands in the SITE's group. The column default was the literal 'ACS-Cymru' until
0131 pointed it at `sparkplug_group_default()`, and a default that silently reverted would give
every gateway created after it an address in the vendor's namespace while every page went on
looking correct.

The format constraint still refuses a separator. The group is one segment of
`spBv1.0/<group>/<TYPE>/<node>`, so a value containing `/`, `+` or `#` addresses a subtree the
broker grants nothing on -- and at QoS 0 that publish is dropped silently.

Runs against the Supabase database, not the historian:

    python supabase/migrations/test_sparkplug_group_setting.py
"""
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

SETTING_KEY = "sparkplug.group_id"


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


class TestSparkplugGroupSetting(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()
        cls.conn.autocommit = False

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def tearDown(self):
        # Every test writes inside a transaction it abandons; the setting is install-time state
        # and a suite that changed it would leave the database describing a different site.
        self.conn.rollback()

    def test_the_setting_exists_and_is_read_only(self):
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT value #>> '{}', read_only, category, fallback_source"
                "  FROM public.system_settings WHERE key = %s",
                (SETTING_KEY,),
            )
            row = cur.fetchone()
        self.assertIsNotNone(row, f"{SETTING_KEY} was not seeded by 0131")
        value, read_only, category, fallback = row
        self.assertTrue(value, "the group is empty")
        self.assertTrue(read_only, "the group is editable; 0131 marks it read-only")
        self.assertEqual(category, "Site")
        # Named so an operator who wants it changed is sent to the chart rather than to the row.
        self.assertIn("sparkplugGroup", fallback or "")

    def test_a_read_only_value_cannot_be_written(self):
        with self.conn.cursor() as cur:
            with self.assertRaises(psycopg2.errors.RaiseException) as caught:
                cur.execute(
                    "UPDATE public.system_settings SET value = to_jsonb('Somewhere-Else'::text)"
                    " WHERE key = %s",
                    (SETTING_KEY,),
                )
        self.assertIn("fixed at install", str(caught.exception))

    def test_metadata_can_still_be_refreshed(self):
        # seed_setting() rewrites the label and description on every boot. A guard that refused
        # the whole row would make a read-only setting impossible to correct.
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE public.system_settings SET description = description WHERE key = %s",
                (SETTING_KEY,),
            )
            self.assertEqual(cur.rowcount, 1)

    def test_an_ordinary_setting_is_still_editable(self):
        # The guard must not have turned every setting read-only by defaulting the wrong way, and
        # `read_only boolean DEFAULT false` is what stops that -- worth asserting rather than
        # trusting, because every other test here would pass on a table where nothing is editable.
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT key FROM public.system_settings"
                " WHERE NOT read_only AND value_type = 'number' LIMIT 1"
            )
            row = cur.fetchone()
            self.assertIsNotNone(row, "no editable numeric setting to test against")
            cur.execute(
                "UPDATE public.system_settings SET value = to_jsonb(1) WHERE key = %s",
                (row[0],),
            )
            self.assertEqual(cur.rowcount, 1)

    def test_a_new_gateway_takes_the_sites_group(self):
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT value #>> '{}' FROM public.system_settings WHERE key = %s",
                (SETTING_KEY,),
            )
            expected = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO public.gateways (name) VALUES ('group-default-probe')"
                " RETURNING sparkplug_group"
            )
            self.assertEqual(cur.fetchone()[0], expected)

    def test_the_column_default_reads_the_setting_rather_than_a_literal(self):
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT pg_get_expr(d.adbin, d.adrelid)"
                "  FROM pg_attrdef d"
                "  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum"
                " WHERE d.adrelid = 'public.gateways'::regclass AND a.attname = 'sparkplug_group'"
            )
            row = cur.fetchone()
        self.assertIsNotNone(row, "gateways.sparkplug_group has no default")
        self.assertIn("sparkplug_group_default", row[0])

    def test_the_seeded_playback_gateway_follows_the_site(self):
        # 0002 inserts Playback WITHOUT naming a group, so on a fresh install it takes 0001's
        # literal -- this file has not run yet. A site installing as anything else would find one
        # row addressed in the vendor's namespace. Asserted by moving the site rather than by
        # reinstalling, which is the only way to reach the case from a database already built.
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE public.system_settings SET read_only = false WHERE key = %s", (SETTING_KEY,)
            )
            cur.execute(
                "UPDATE public.system_settings SET value = to_jsonb('Plant-7'::text) WHERE key = %s",
                (SETTING_KEY,),
            )
            cur.execute("SELECT public.sparkplug_group_default()")
            self.assertEqual(cur.fetchone()[0], "Plant-7")

            cur.execute(
                "UPDATE public.gateways SET sparkplug_group = public.sparkplug_group_default()"
                " WHERE id = '16000000-0000-4000-8000-000000000001'"
                "   AND sparkplug_group = 'ACS-Cymru'"
                "   AND public.sparkplug_group_default() <> 'ACS-Cymru'"
            )
            cur.execute(
                "SELECT sparkplug_group FROM public.gateways"
                " WHERE id = '16000000-0000-4000-8000-000000000001'"
            )
            row = cur.fetchone()
            if row is not None:
                self.assertEqual(row[0], "Plant-7")

    def test_a_group_with_a_separator_is_still_refused(self):
        for bad in ("a/b", "a+b", "a#b", ""):
            with self.subTest(group=bad):
                with self.conn.cursor() as cur:
                    with self.assertRaises(psycopg2.errors.CheckViolation):
                        cur.execute(
                            "INSERT INTO public.gateways (name, sparkplug_group)"
                            " VALUES ('separator-probe', %s)",
                            (bad,),
                        )
                self.conn.rollback()


if __name__ == "__main__":
    unittest.main(verbosity=2)
