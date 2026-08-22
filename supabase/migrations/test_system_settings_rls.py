"""
RLS and grant tests for public.system_settings (migration 0031).

WHAT THIS SUITE IS ACTUALLY DEFENDING, because "admins can edit settings" is the easy half and
none of these tests are about it:

  1. THE KEY SET IS CLOSED. An Administrator may change a value and may not invent a key. That is
     enforced by the ABSENCE of INSERT and DELETE policies rather than by a rule anyone states, so
     it is exactly the kind of property a later migration can undo without failing anything.

  2. `updated_by` CANNOT BE FORGED. It is stamped by trigger from the JWT, and the column grant is
     what stops a PATCH supplying its own. That grant was INERT when this migration was first
     written: this database carries a `supabase_admin` DEFAULT ACL granting every privilege on
     every new public table to anon, authenticated and service_role, so `GRANT UPDATE (value)`
     landed on top of a table-level UPDATE that was already held. The migration's self-check
     caught it; these tests keep it caught.

  3. READS ARE OPEN TO EVERY AUTHENTICATED USER, deliberately, which is why nothing secret may
     live in this table. An Operator reading settings is not a leak -- it is the design, and the
     test asserting it is what makes a future "just put the S3 key in system_settings" obviously
     wrong rather than merely discouraged.

Runs against the deployed schema, as a real `authenticated` session with simulated JWT claims --
the same approach as test_user_roles_rls.py. Nothing here mocks the policy it is testing.
"""
import os
import unittest
import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "a0000000-0000-0000-0000-000000000001"
OPERATOR_ID = "a0000000-0000-0000-0000-000000000003"

SEEDED_KEY = "ui.digital_thread_lane_limit"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def as_user(cur, user_id):
    """Become `authenticated` with a JWT subject, the way PostgREST does."""
    cur.execute("SET LOCAL ROLE authenticated;")
    cur.execute(
        'SET LOCAL "request.jwt.claims" = %s;',
        ('{"sub": "%s"}' % user_id,),
    )
    # has_role() reads auth.uid(), which reads this claim rather than the one above on some
    # GoTrue versions. Setting both keeps the test honest against either.
    cur.execute('SET LOCAL "request.jwt.claim.sub" = %s;', (user_id,))


class SystemSettingsRLS(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.system_settings');")
                if cur.fetchone()[0] is None:
                    raise RuntimeError(
                        "public.system_settings does not exist -- run migration 0031 first."
                    )
                cur.execute(
                    "SELECT count(*) FROM public.system_settings WHERE key = %s;", (SEEDED_KEY,)
                )
                if cur.fetchone()[0] != 1:
                    raise RuntimeError(f"{SEEDED_KEY} is not seeded; 0031 did not run cleanly.")
                # Which roles the seeded personas actually hold, so a failure here reads as
                # "the fixture is wrong" rather than "the policy is wrong".
                cur.execute(
                    "SELECT r.name FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id"
                    " WHERE ur.user_id = %s;", (ADMIN_ID,)
                )
                roles = [row[0] for row in cur.fetchall()]
                if "Administrator" not in roles:
                    raise RuntimeError(f"seed user {ADMIN_ID} is not an Administrator: {roles}")
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()

    def tearDown(self):
        # Every test runs inside a transaction that is thrown away, so none of them can leave a
        # setting changed for the next one -- or for the running stack this suite is pointed at.
        self.conn.rollback()
        self.conn.close()

    # -- reads -------------------------------------------------------------------------------

    def test_an_operator_can_read_settings(self):
        """
        BY DESIGN, NOT BY OVERSIGHT. A setting shapes what a page renders, so an
        Administrator-only SELECT would break that page for everyone else in a way that reads as
        a bug. The cost of this decision is that nothing secret may ever live here.
        """
        with self.conn.cursor() as cur:
            as_user(cur, OPERATOR_ID)
            cur.execute("SELECT count(*) FROM public.system_settings;")
            self.assertGreater(cur.fetchone()[0], 0)

    # -- writes ------------------------------------------------------------------------------

    def test_an_administrator_can_change_a_value(self):
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            cur.execute(
                "UPDATE public.system_settings SET value = to_jsonb(42) WHERE key = %s;",
                (SEEDED_KEY,),
            )
            self.assertEqual(cur.rowcount, 1)

    def test_an_operator_cannot_change_a_value(self):
        """RLS returns zero rows updated rather than raising -- the row is invisible to the policy."""
        with self.conn.cursor() as cur:
            as_user(cur, OPERATOR_ID)
            cur.execute(
                "UPDATE public.system_settings SET value = to_jsonb(42) WHERE key = %s;",
                (SEEDED_KEY,),
            )
            self.assertEqual(cur.rowcount, 0)

    # -- the closed key set ------------------------------------------------------------------

    def test_an_administrator_cannot_invent_a_key(self):
        """
        THE PROPERTY THE WHOLE DESIGN RESTS ON. A settings table exists so that code can read a
        value; a row no code reads is a note that looks like configuration. There is no INSERT
        policy, and with RLS on, an operation with no permissive policy is denied.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(
                    "INSERT INTO public.system_settings (key, value, value_type, category, label)"
                    " VALUES ('ui.invented_key', to_jsonb(1), 'number', 'x', 'x');"
                )

    def test_an_administrator_cannot_delete_a_setting(self):
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("DELETE FROM public.system_settings WHERE key = %s;", (SEEDED_KEY,))

    def test_an_administrator_cannot_rename_a_key(self):
        """
        BLOCKED BY THE COLUMN GRANT, ONE LAYER EARLIER THAN EXPECTED. This test was written
        expecting the trigger to raise, because UPDATE is permitted on this table -- but the grant
        is `UPDATE (value)`, so `key` is not writable at all and Postgres refuses before any row
        is examined. Asserting the mechanism that actually fires, rather than the one that was
        designed to, is the difference between a test and a restatement of an intention.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(
                    "UPDATE public.system_settings SET key = 'ui.renamed' WHERE key = %s;",
                    (SEEDED_KEY,),
                )

    def test_the_trigger_blocks_a_rename_that_gets_past_the_grant(self):
        """
        THE SECOND LAYER, AND IT IS NOT REDUNDANT. `service_role` holds ALL on this table, so the
        column grant above does not constrain it -- and service_role is what every edge function
        and the ingestion daemon connect as. A key renamed from that side would silently
        disconnect a setting from the code that reads it, which is precisely what the trigger
        refuses.
        """
        with self.conn.cursor() as cur:
            cur.execute("SET LOCAL ROLE service_role;")
            with self.assertRaises(psycopg2.errors.RaiseException):
                cur.execute(
                    "UPDATE public.system_settings SET key = 'ui.renamed' WHERE key = %s;",
                    (SEEDED_KEY,),
                )

    # -- provenance --------------------------------------------------------------------------

    def test_updated_by_cannot_be_supplied_by_the_client(self):
        """
        THE TEST THAT ALMOST DID NOT EXIST. The column grant confining an Administrator's write to
        `value` was inert when 0031 was first applied, because Supabase's default ACL had already
        granted table-level UPDATE. Nothing about the feature looked wrong -- the settings page
        would have worked perfectly while `updated_by` was a field anyone could dictate.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(
                    "UPDATE public.system_settings SET updated_by = %s WHERE key = %s;",
                    (OPERATOR_ID, SEEDED_KEY),
                )

    def test_updated_by_is_stamped_from_the_jwt(self):
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            cur.execute(
                "UPDATE public.system_settings SET value = to_jsonb(7) WHERE key = %s"
                " RETURNING updated_by;",
                (SEEDED_KEY,),
            )
            self.assertEqual(str(cur.fetchone()[0]), ADMIN_ID)

    # -- typing ------------------------------------------------------------------------------

    def test_a_number_setting_refuses_a_string(self):
        """
        The CHECK, reached through the policy rather than as the table owner. `value_type` is only
        worth having if a reader can trust it, and a reader trusts it because this fails.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.CheckViolation):
                cur.execute(
                    "UPDATE public.system_settings SET value = to_jsonb('thirty'::text)"
                    " WHERE key = %s;",
                    (SEEDED_KEY,),
                )

    def test_value_type_cannot_be_changed_to_make_a_bad_value_fit(self):
        """The obvious way around the test above, if value_type were writable."""
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(
                    "UPDATE public.system_settings SET value_type = 'string' WHERE key = %s;",
                    (SEEDED_KEY,),
                )

    # -- anon --------------------------------------------------------------------------------

    def test_anon_cannot_read_settings(self):
        """Unauthenticated callers reach PostgREST too; the table is revoked from `anon` outright."""
        with self.conn.cursor() as cur:
            cur.execute("SET LOCAL ROLE anon;")
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT count(*) FROM public.system_settings;")


if __name__ == "__main__":
    unittest.main(verbosity=2)
