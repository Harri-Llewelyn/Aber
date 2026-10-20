"""
A person's own preferences (0188, 0194): `user_settings`, one row per person, read and written by
that person alone.

What would fail quietly without these:

- Another person's row is invisible and cannot be written, created or taken over, so a shared
  control-room PC never shows one person's theme to the next.
- An Administrator reads nobody else's row either: nothing in it is anyone else's business.
- `anon` and `service_role` hold nothing on the table.
- The CHECKs refuse a value the dashboard does not know, and a row with no choice made carries
  the dashboard's defaults, single-key shortcuts on among them.
- The dashboard's first-sign-in seed (INSERT ... ON CONFLICT DO NOTHING) never overwrites a row
  another tab created, and its one-column save (PostgREST's upsert) leaves the other column alone.
- Deleting the account deletes the row; a person cannot delete it themselves.
- `updated_at` is the database's, and nothing is written to the Audit Trail.

A person is presented as PostgREST presents a verified JWT: their claims in `request.jwt.claims`
under the `authenticated` role.

Runs against the Supabase database, not the historian:

    python supabase/migrations/test_user_settings.py
"""
import json
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ALICE = "a1ce0188-0000-4000-8000-000000000001"
BOB = "b0b00188-0000-4000-8000-000000000002"
ADMIN = "ad300188-0000-4000-8000-000000000003"
# Written out, not formatted: the roles a caller is presented as.
SET_ROLE = {
    "authenticated": "SET LOCAL ROLE authenticated",
    "anon": "SET LOCAL ROLE anon",
}


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


class UserSettingsBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()
        cls.conn.autocommit = False

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        # Every test runs in one transaction, rolled back after: the people and rows below exist
        # only for it.
        self.cur = self.conn.cursor()
        for user_id, email in ((ALICE, "alice.0188@aber.test"), (BOB, "bob.0188@aber.test"),
                               (ADMIN, "admin.0188@aber.test")):
            # An email, so none of them is shaped like a machine principal, which may hold no role.
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                (user_id, email),
            )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id)"
            " SELECT %s, id FROM public.roles WHERE name = 'Administrator'"
            " ON CONFLICT DO NOTHING",
            (ADMIN,),
        )

    def tearDown(self):
        self.cur.close()
        self.conn.rollback()

    def as_person(self, user_id):
        self.cur.execute("RESET ROLE")
        claims = {"role": "authenticated", "sub": user_id}
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true)", (json.dumps(claims),))
        self.cur.execute(SET_ROLE["authenticated"])

    def as_owner(self):
        self.cur.execute("RESET ROLE")

    def seed(self, user_id, theme="dark", sidebar_mode="hover"):
        """A row, written as its owner would write it."""
        self.as_person(user_id)
        self.cur.execute(
            "INSERT INTO public.user_settings (user_id, theme, sidebar_mode) VALUES (%s, %s, %s)",
            (user_id, theme, sidebar_mode),
        )
        self.as_owner()

    def rows(self):
        self.cur.execute("SELECT user_id::text, theme, sidebar_mode FROM public.user_settings ORDER BY user_id")
        return self.cur.fetchall()


class TestEachPersonHasTheirOwn(UserSettingsBase):
    def test_a_person_reads_their_own_row_and_nobody_elses(self):
        self.seed(ALICE, theme="light")
        self.seed(BOB, sidebar_mode="collapsed")
        self.as_person(ALICE)
        self.assertEqual(self.rows(), [(ALICE, "light", "hover")])
        self.as_person(BOB)
        self.assertEqual(self.rows(), [(BOB, "dark", "collapsed")])

    def test_an_administrator_reads_nobody_elses_row(self):
        self.seed(ALICE, theme="light")
        self.as_person(ADMIN)
        self.cur.execute("SELECT public.has_role(ARRAY['Administrator'])")
        self.assertTrue(self.cur.fetchone()[0], "the fixture is not an Administrator")
        self.assertEqual(self.rows(), [])

    def test_a_person_cannot_create_a_row_for_someone_else(self):
        self.as_person(ALICE)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "INSERT INTO public.user_settings (user_id, theme) VALUES (%s, 'light')", (BOB,)
            )

    def test_a_person_cannot_change_someone_elses_row(self):
        self.seed(BOB)
        self.as_person(ALICE)
        self.cur.execute("UPDATE public.user_settings SET theme = 'light' WHERE user_id = %s", (BOB,))
        self.assertEqual(self.cur.rowcount, 0)
        self.as_owner()
        self.assertEqual(self.rows(), [(BOB, "dark", "hover")])

    def test_a_person_cannot_hand_their_row_to_someone_else(self):
        self.seed(ALICE)
        self.as_person(ALICE)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("UPDATE public.user_settings SET user_id = %s WHERE user_id = %s", (BOB, ALICE))

    def test_a_person_cannot_delete_their_row(self):
        self.seed(ALICE)
        self.as_person(ALICE)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("DELETE FROM public.user_settings WHERE user_id = %s", (ALICE,))

    def test_nobody_signed_out_reads_it(self):
        self.seed(ALICE)
        self.cur.execute(SET_ROLE["anon"])
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT 1 FROM public.user_settings")

    def test_anon_and_service_role_hold_nothing(self):
        for role in ("anon", "service_role"):
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                self.cur.execute(
                    "SELECT has_table_privilege(%s, 'public.user_settings', %s)", (role, privilege)
                )
                self.assertFalse(self.cur.fetchone()[0], f"{role} holds {privilege}")


class TestTheValues(UserSettingsBase):
    def test_a_row_with_nothing_chosen_carries_the_dashboards_defaults(self):
        self.as_person(ALICE)
        self.cur.execute("INSERT INTO public.user_settings (user_id) VALUES (%s)", (ALICE,))
        self.assertEqual(self.rows(), [(ALICE, "dark", "hover")])

    def test_single_key_shortcuts_are_on_until_turned_off(self):
        """0194: a one-column save turns them off and on again, and nothing turns them to null."""
        self.as_person(ALICE)
        self.cur.execute("INSERT INTO public.user_settings (user_id) VALUES (%s)", (ALICE,))
        read = "SELECT single_key_shortcuts FROM public.user_settings WHERE user_id = %s"
        self.cur.execute(read, (ALICE,))
        self.assertIs(self.cur.fetchone()[0], True)
        save = ("INSERT INTO public.user_settings (user_id, single_key_shortcuts) VALUES (%s, %s)"
                " ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id,"
                " single_key_shortcuts = EXCLUDED.single_key_shortcuts")
        for value in (False, True):
            self.cur.execute(save, (ALICE, value))
            self.cur.execute(read, (ALICE,))
            self.assertIs(self.cur.fetchone()[0], value)
        self.assertEqual(self.rows(), [(ALICE, "dark", "hover")])
        with self.assertRaises(psycopg2.errors.NotNullViolation):
            self.cur.execute(save, (ALICE, None))

    def test_an_unknown_theme_is_refused(self):
        self.as_person(ALICE)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("INSERT INTO public.user_settings (user_id, theme) VALUES (%s, 'blue')", (ALICE,))

    def test_an_unknown_sidebar_mode_is_refused(self):
        self.seed(ALICE)
        self.as_person(ALICE)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute(
                "UPDATE public.user_settings SET sidebar_mode = 'sideways' WHERE user_id = %s", (ALICE,)
            )

    def test_every_value_the_dashboard_offers_is_accepted(self):
        self.seed(ALICE)
        self.as_person(ALICE)
        for theme in ("dark", "light"):
            for mode in ("hover", "expanded", "collapsed"):
                self.cur.execute(
                    "UPDATE public.user_settings SET theme = %s, sidebar_mode = %s WHERE user_id = %s",
                    (theme, mode, ALICE),
                )
                self.assertEqual(self.rows(), [(ALICE, theme, mode)])

    def test_updated_at_is_the_databases(self):
        self.as_person(ALICE)
        self.cur.execute(
            "INSERT INTO public.user_settings (user_id, updated_at) VALUES (%s, '2000-01-01')", (ALICE,)
        )
        self.cur.execute(
            "SELECT updated_at > now() - interval '1 minute' FROM public.user_settings WHERE user_id = %s",
            (ALICE,),
        )
        self.assertTrue(self.cur.fetchone()[0])
        self.cur.execute(
            "UPDATE public.user_settings SET theme = 'light', updated_at = '2000-01-01' WHERE user_id = %s",
            (ALICE,),
        )
        self.cur.execute(
            "SELECT updated_at > now() - interval '1 minute' FROM public.user_settings WHERE user_id = %s",
            (ALICE,),
        )
        self.assertTrue(self.cur.fetchone()[0])


class TestTheDashboardsWrites(UserSettingsBase):
    def test_the_first_sign_in_seed_never_overwrites_a_row(self):
        """Another tab may have created the row between this tab's read and its seed."""
        self.seed(ALICE, theme="light", sidebar_mode="expanded")
        self.as_person(ALICE)
        self.cur.execute(
            "INSERT INTO public.user_settings (user_id, theme, sidebar_mode) VALUES (%s, 'dark', 'hover')"
            " ON CONFLICT (user_id) DO NOTHING",
            (ALICE,),
        )
        self.assertEqual(self.cur.rowcount, 0)
        self.assertEqual(self.rows(), [(ALICE, "light", "expanded")])

    def test_a_one_column_save_leaves_the_other_column_alone(self):
        """The statement PostgREST makes of upsert({user_id, theme}, {onConflict: 'user_id'})."""
        self.seed(ALICE, theme="dark", sidebar_mode="collapsed")
        self.as_person(ALICE)
        self.cur.execute(
            "INSERT INTO public.user_settings (user_id, theme) VALUES (%s, 'light')"
            " ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id, theme = EXCLUDED.theme",
            (ALICE,),
        )
        self.assertEqual(self.rows(), [(ALICE, "light", "collapsed")])

    def test_a_one_column_save_with_no_row_creates_one(self):
        self.as_person(ALICE)
        self.cur.execute(
            "INSERT INTO public.user_settings (user_id, sidebar_mode) VALUES (%s, 'expanded')"
            " ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id, sidebar_mode = EXCLUDED.sidebar_mode",
            (ALICE,),
        )
        self.assertEqual(self.rows(), [(ALICE, "dark", "expanded")])

    def test_a_save_cannot_reach_someone_elses_row_through_the_conflict(self):
        self.seed(BOB)
        self.as_person(ALICE)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "INSERT INTO public.user_settings (user_id, theme) VALUES (%s, 'light')"
                " ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme",
                (BOB,),
            )

    def test_nothing_is_written_to_the_audit_trail(self):
        self.seed(ALICE)
        self.as_person(ALICE)
        self.cur.execute("UPDATE public.user_settings SET theme = 'light' WHERE user_id = %s", (ALICE,))
        self.as_owner()
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'user_settings'")
        self.assertEqual(self.cur.fetchone()[0], 0)


class TestTheRowGoesWithTheAccount(UserSettingsBase):
    def test_deleting_the_account_deletes_the_row(self):
        self.seed(ALICE, theme="light")
        self.seed(BOB)
        self.as_owner()
        self.cur.execute("DELETE FROM auth.users WHERE id = %s", (ALICE,))
        self.assertEqual(self.rows(), [(BOB, "dark", "hover")])


if __name__ == "__main__":
    unittest.main(verbosity=2)
