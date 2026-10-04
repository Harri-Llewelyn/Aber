"""
The cold archive's destination, and who may see it (0134).

WHAT IS ACTUALLY AT STAKE. `system_settings` is readable by every signed-in user on purpose -- a
setting shapes what a page renders for every role -- so `0134` adds `sensitive` and one clause on
the SELECT policy. If that clause is ever lost, five rows naming where a plant's entire history is
written, and under which access key, become readable by every Operator with a login. Nothing else
in the chain would notice: the page would keep working, the exporter would keep exporting, and the
only symptom would be a disclosure nobody is looking for.

So this suite asserts the clause from both sides -- a caller without the role sees none of them, and
an Administrator sees all of them -- and that the two functions which reach past RLS admit only who
they are meant to.

THE CREDENTIAL IS NEVER ASSERTED BY VALUE, because nothing can read it back: `set_archive_credential()`
writes to the vault and no counterpart returns it. `archive_credential_is_set()` answers the only
question a page is allowed to ask.

Runs against the Supabase database, not the historian:

    python supabase/migrations/test_cold_archive_destination.py
"""
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Pinned ids that differ EARLY, not just in the last block: a generated id derived from these has
# limited width, and two ids differing only at the end can collide in it.
ADMIN_ID = "d5771465-0000-4000-8000-00000000ad11"
OPERATOR_ID = "e6881576-0000-4000-8000-00000000009e"

SENSITIVE_KEYS = (
    "archive.endpoint",
    "archive.region",
    "archive.bucket",
    "archive.access_key_id",
    "archive.path_style",
)


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


def ensure_auth_user(cur, user_id):
    """
    Make `user_id` exist in `auth.users`.

    NOT BOILERPLATE: `log_audit_trail_event()` writes `changed_by = auth.uid()` under a foreign
    key to `auth.users`, so a fixture that fakes a session without an account fails on the AUDIT
    insert. The emailed shape is tried first -- an id-only row is indistinguishable from one of the
    stack's own machine principals, which have their own trigger. Each attempt is savepointed so a
    failure here cannot abort the caller's transaction.
    """
    for columns, values in (
        ("id, email, encrypted_password", "%s, %s, 'x'"),
        ("id", "%s"),
    ):
        args = (user_id, f"{user_id}@test.invalid") if "email" in columns else (user_id,)
        try:
            cur.execute("SAVEPOINT au;")
            cur.execute(
                f"INSERT INTO auth.users ({columns}) VALUES ({values}) "
                "ON CONFLICT (id) DO NOTHING;",
                args,
            )
            cur.execute("RELEASE SAVEPOINT au;")
            return
        except psycopg2.Error:
            cur.execute("ROLLBACK TO SAVEPOINT au;")
    raise RuntimeError(f"could not create auth user {user_id}")


def as_user(cur, user_id):
    """Become `authenticated` with a JWT subject, the way PostgREST 12.2 does: claims only."""
    cur.execute("SET LOCAL ROLE authenticated;")
    cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))


class ColdArchiveDestination(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # NOT autocommit: ensure_auth_user() savepoints each attempt, and a savepoint outside a
        # transaction block is an error rather than a no-op.
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.cold_archive_destination()');")
                if cur.fetchone()[0] is None:
                    raise RuntimeError("cold_archive_destination() is absent -- 0134 did not run.")

                # By NAME, not by a hardcoded id: roles.id is an integer from a sequence.
                cur.execute("SELECT id, name FROM public.roles WHERE name IN %s;",
                            (("Administrator", "Operator"),))
                by_name = {name: rid for rid, name in cur.fetchall()}
                for needed in ("Administrator", "Operator"):
                    if needed not in by_name:
                        raise RuntimeError(f"role {needed!r} is missing; 0001 did not run cleanly.")

                for user_id in (ADMIN_ID, OPERATOR_ID):
                    ensure_auth_user(cur, user_id)
                cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (ADMIN_ID, by_name["Administrator"], OPERATOR_ID, by_name["Operator"]),
                )

                # Asserted rather than assumed: if has_role() cannot see these rows, every test
                # below would "pass" by being denied for the wrong reason.
                cur.execute(
                    "SELECT r.name FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id"
                    " WHERE ur.user_id = %s;", (ADMIN_ID,))
                roles = [row[0] for row in cur.fetchall()]
                if "Administrator" not in roles:
                    raise RuntimeError(f"fixture {ADMIN_ID} is not an Administrator: {roles}")
            conn.commit()
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls):
        conn = get_connection()
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM public.user_roles WHERE user_id IN %s;",
                            ((ADMIN_ID, OPERATOR_ID),))
                cur.execute("DELETE FROM auth.users WHERE id IN %s;",
                            ((ADMIN_ID, OPERATOR_ID),))
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()

    def tearDown(self):
        # Every test runs inside a transaction that is thrown away, so none can leave a destination
        # changed for the next -- or for the stack this suite may be pointed at.
        self.conn.rollback()
        self.conn.close()

    # -- the clause that hides them ---------------------------------------------------------------

    def test_the_destination_is_flagged_sensitive(self):
        """The column is the mechanism; a row that is not flagged is not protected by it."""
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT key FROM public.system_settings WHERE key = ANY(%s) AND NOT sensitive;",
                (list(SENSITIVE_KEYS),))
            unflagged = [r[0] for r in cur.fetchall()]
        self.assertEqual(unflagged, [], f"readable by every signed-in user: {unflagged}")

    def test_an_operator_cannot_see_the_destination(self):
        """
        RLS FILTERS ROWS RATHER THAN REFUSING THE QUERY, so the Settings page keeps working for an
        Operator and simply renders fewer rows. The assertion is that none of the five is among them.
        """
        with self.conn.cursor() as cur:
            as_user(cur, OPERATOR_ID)
            cur.execute(
                "SELECT count(*) FROM public.system_settings WHERE key = ANY(%s);",
                (list(SENSITIVE_KEYS),))
            self.assertEqual(cur.fetchone()[0], 0)

    def test_an_operator_can_still_see_the_ordinary_settings(self):
        """
        The negative above is only meaningful beside this. A policy that hid everything would pass
        it and break the Settings page for every role but one.
        """
        with self.conn.cursor() as cur:
            as_user(cur, OPERATOR_ID)
            cur.execute("SELECT count(*) FROM public.system_settings WHERE NOT sensitive;")
            self.assertGreater(cur.fetchone()[0], 0)

    def test_an_administrator_sees_all_of_them(self):
        """Otherwise the page that is supposed to configure this shows an Administrator nothing."""
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            cur.execute(
                "SELECT count(*) FROM public.system_settings WHERE key = ANY(%s);",
                (list(SENSITIVE_KEYS),))
            self.assertEqual(cur.fetchone()[0], len(SENSITIVE_KEYS))

    # -- the functions that reach past it ----------------------------------------------------------

    def test_the_destination_function_gives_an_administrator_nothing(self):
        """
        It returns the SECRET, so its audience is the ingestion principal and nobody else. An
        Administrator configures the destination and never needs it back -- and a function that
        would return it is one somebody can be persuaded to call.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            cur.execute("SELECT count(*) FROM public.cold_archive_destination();")
            self.assertEqual(cur.fetchone()[0], 0)

    def test_an_operator_cannot_set_the_credential(self):
        """Administrator only, and refused with the errcode PostgREST maps to 403."""
        with self.conn.cursor() as cur:
            as_user(cur, OPERATOR_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT public.set_archive_credential('not-mine');")

    def test_an_administrator_can_set_the_credential_and_only_learns_that_it_is_set(self):
        """
        The write path end to end, and the one question a page may ask afterwards. The value is
        never asserted because nothing returns it -- that is the property, not a gap in the test.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            cur.execute("SELECT public.set_archive_credential('wJalrXUtnFEMI');")
            cur.execute("SELECT public.archive_credential_is_set();")
            self.assertTrue(cur.fetchone()[0])

    def test_an_empty_credential_is_refused(self):
        """
        Saving an empty string would leave the vault holding a credential that cannot authenticate,
        and `archive_credential_is_set()` would then report a configured stack.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.Error):
                cur.execute("SELECT public.set_archive_credential('   ');")

    def test_an_operator_is_not_told_whether_a_credential_exists(self):
        """
        `archive_credential_is_set()` is SECURITY DEFINER and would otherwise answer for everyone.
        False reads as "not configured", which is correct for somebody who cannot configure it.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            cur.execute("SELECT public.set_archive_credential('wJalrXUtnFEMI');")
            as_user(cur, OPERATOR_ID)
            cur.execute("SELECT public.archive_credential_is_set();")
            self.assertFalse(cur.fetchone()[0])

    # -- re-pointing a destination that has been written to ----------------------------------------

    def test_setting_a_destination_for_the_first_time_is_not_a_change(self):
        """The guard must not make the empty case -- every new install -- impossible to configure."""
        with self.conn.cursor() as cur:
            cur.execute("UPDATE public.system_settings SET value = to_jsonb(''::text) "
                        "WHERE key = 'archive.bucket';")
            cur.execute("UPDATE public.system_settings SET value = to_jsonb('plant-history'::text) "
                        "WHERE key = 'archive.bucket';")
            cur.execute("SELECT value #>> '{}' FROM public.system_settings WHERE key='archive.bucket';")
            self.assertEqual(cur.fetchone()[0], "plant-history")


if __name__ == "__main__":
    unittest.main(verbosity=2)
