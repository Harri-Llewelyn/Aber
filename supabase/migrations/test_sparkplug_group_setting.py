"""
The site's Sparkplug group (0131), and a gateway's own.

Four properties, none of which anything else in the chain would notice losing.

A read-only setting is refused BY THE DATABASE. The Settings page renders it without a control,
but the page is not the authority: an Administrator holds `GRANT UPDATE (value)` on
`system_settings`, so a direct PostgREST write is admitted by RLS and only the trigger stops it.
A refusal that lived in the browser alone would be a suggestion.

A new gateway lands in the SITE's group. The column default was the literal 'Aber' until
0131 pointed it at `sparkplug_group_default()`, and a default that silently reverted would give
every gateway created after it an address in the vendor's namespace while every page went on
looking correct.

The format constraint still refuses a separator. The group is one segment of
`spBv1.0/<group>/<TYPE>/<node>`, so a value containing `/`, `+` or `#` addresses a subtree the
broker grants nothing on -- and at QoS 0 that publish is dropped silently.

A gateway's group is changed only by those who may edit a gateway. The Edit Gateway dialog offers
the field to them; RLS (gateways_update_privileged) is what refuses everyone else, and it refuses
by changing no row rather than by raising, so the row count is what is asserted.

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
        # seed_setting() rewrites the label and description whenever a migration corrects them. A
        # guard that refused the whole row would make a read-only setting impossible to correct.
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
                "   AND sparkplug_group = 'Aber'"
                "   AND public.sparkplug_group_default() <> 'Aber'"
            )
            cur.execute(
                "SELECT sparkplug_group FROM public.gateways"
                " WHERE id = '16000000-0000-4000-8000-000000000001'"
            )
            row = cur.fetchone()
            if row is not None:
                self.assertEqual(row[0], "Plant-7")

    def test_an_absent_setting_is_refused_rather_than_named(self):
        # No group has a default since #389. A settings row that went missing must not hand the
        # next gateway a group nobody chose; the insert fails instead, naming the setting.
        with self.conn.cursor() as cur:
            cur.execute("DELETE FROM public.system_settings WHERE key = %s", (SETTING_KEY,))
            with self.assertRaises(psycopg2.errors.RaiseException) as raised:
                cur.execute("SELECT public.sparkplug_group_default()")
            self.assertIn("sparkplug.group_id", str(raised.exception))

    def test_the_seed_refuses_a_run_that_names_no_group(self):
        # 0002's own block, read out of the migration so a copy here cannot drift from it. db-init
        # always passes the chart's value; a run without one must stop rather than seed a group
        # into a setting that can never change.
        here = os.path.dirname(os.path.abspath(__file__))
        seed = open(os.path.join(here, "0002_seed_data.sql"), encoding="utf-8").read()
        start = seed.index("DO $$", seed.index("-- READ-ONLY ONCE SEEDED"))
        block = seed[start:seed.index("END;\n$$;", start) + len("END;\n$$;")]
        with self.conn.cursor() as cur:
            cur.execute("SELECT set_config('aber.sparkplug_group', '', true)")
            with self.assertRaises(psycopg2.errors.RaiseException) as raised:
                cur.execute(block)
            self.assertIn("sparkplug_group is not set", str(raised.exception))

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


class TestWhoMayChangeAGatewaysGroup(unittest.TestCase):
    """
    The Edit Gateway dialog offers the group to whoever may edit a gateway, and the database is what
    holds the line: gateways_update_privileged admits an Administrator and a Shopfloor Manager. A
    role it does not admit changes nothing, and a change that lands is one audit row. Rolled back.
    """

    PEOPLE = {
        "Administrator": "a0d18100-0000-4000-8000-0000000810a1",
        "Shopfloor_Manager": "a0d18100-0000-4000-8000-0000000810b2",
        "Operator": "a0d18100-0000-4000-8000-0000000810c3",
        "Auditor": "a0d18100-0000-4000-8000-0000000810d4",
    }
    GATEWAY = "0a810000-0000-4000-8000-000000000810"

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        # People, not only role grants: audit_trail.changed_by references auth.users.
        self.cur.execute("SELECT id, name FROM public.roles")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for role, user_id in self.PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, 'not-a-hash')"
                " ON CONFLICT (id) DO NOTHING",
                (user_id, f"{user_id}@group-edit.test"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING",
                (user_id, roles[role]),
            )
        self.cur.execute(
            "INSERT INTO public.gateways (id, name) VALUES (%s, 'Group_Edit_Gateway')"
            " RETURNING sparkplug_group",
            (self.GATEWAY,),
        )
        self.registered = self.cur.fetchone()[0]

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def change_group_as(self, role, group):
        """Rows changed by `role` setting the group, as PostgREST would run the PATCH."""
        self.cur.execute("SET LOCAL ROLE authenticated")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s', ('{"sub": "%s"}' % self.PEOPLE[role],))
        # Not reset in a `finally`: after a refusal the transaction is aborted, and tearDown's
        # rollback ends the SET LOCAL anyway.
        self.cur.execute(
            "UPDATE public.gateways SET sparkplug_group = %s WHERE id = %s", (group, self.GATEWAY)
        )
        changed = self.cur.rowcount
        self.cur.execute("RESET ROLE")
        return changed

    def group(self):
        self.cur.execute("SELECT sparkplug_group FROM public.gateways WHERE id = %s", (self.GATEWAY,))
        return self.cur.fetchone()[0]

    def test_a_role_that_may_not_edit_a_gateway_cannot_change_its_group(self):
        for role in ("Operator", "Auditor"):
            with self.subTest(role=role):
                self.assertEqual(self.change_group_as(role, "Plant-B"), 0,
                                 f"{role} changed a gateway's Sparkplug group")
                self.assertEqual(self.group(), self.registered)

    def test_an_administrator_and_a_manager_can_and_each_change_is_audited(self):
        self.assertEqual(self.change_group_as("Shopfloor_Manager", "Plant-B"), 1)
        self.assertEqual(self.change_group_as("Administrator", "Plant-C"), 1)
        self.assertEqual(self.group(), "Plant-C")
        self.cur.execute(
            "SELECT old_data ->> 'sparkplug_group', new_data ->> 'sparkplug_group', changed_by::text"
            "  FROM public.audit_trail"
            " WHERE causation_id = txid_current() AND entity_type = 'gateways'"
            "   AND action = 'UPDATE' AND entity_id = %s ORDER BY id",
            (self.GATEWAY,),
        )
        self.assertEqual(self.cur.fetchall(), [
            (self.registered, "Plant-B", self.PEOPLE["Shopfloor_Manager"]),
            ("Plant-B", "Plant-C", self.PEOPLE["Administrator"]),
        ])

    def test_an_administrator_is_refused_a_group_that_is_not_one_topic_level(self):
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.change_group_as("Administrator", "Plant/B")


if __name__ == "__main__":
    unittest.main(verbosity=2)
