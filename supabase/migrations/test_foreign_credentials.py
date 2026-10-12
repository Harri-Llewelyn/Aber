"""
The foreign credentials' one writer and one probe (0178).

The cold archive's S3 key and the off-site backup key are set by an Administrator from the page
that uses them, through set_archive_credential() and set_backup_offsite_credential(), and asked
about through their `_is_set()` probes. All four call set_foreign_credential() and
foreign_credential_is_set(). Four properties, each of which would fail quietly:

- Administrator only, refused with insufficient_privilege, which PostgREST answers 403.
- The probe says whether, never what: false, then true once set, and false for anybody else.
- The value is never readable back by an API role: the writer returns nothing, the vault's tables
  refuse authenticated, and neither helper can be called through PostgREST, so no page can name
  a stack-internal secret either.
- A second write rotates in place: one row, the same id, the new value, which the consumer's
  reader returns at its next call.

Every write is rolled back. Runs against the Supabase database, not the historian:

    python supabase/migrations/test_foreign_credentials.py
"""
import os
import unittest

import psycopg2
from psycopg2 import sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Pinned ids that differ EARLY: a generated id derived from these has limited width.
ADMIN_ID = "a1781781-0000-4000-8000-0000000000ad"
OPERATOR_ID = "b2892892-0000-4000-8000-00000000009e"

# (vault name, writer, probe) for each foreign credential a page sets.
CREDENTIALS = (
    ("archive_secret_access_key", "set_archive_credential", "archive_credential_is_set"),
    ("backup_offsite_secret_access_key", "set_backup_offsite_credential", "backup_offsite_credential_is_set"),
)

HELPERS = (
    "public.set_foreign_credential(text, text, text, text)",
    "public.foreign_credential_is_set(text)",
)

# The off-site destination's six settings, complete, so its reader returns the key.
DESTINATION = {
    "p_endpoint": "https://s3.eu-west-2.amazonaws.com",
    "p_region": "eu-west-2",
    "p_bucket": "aber-backups",
    "p_prefix": "site-a/backups",
    "p_access_key_id": "AKIAEXAMPLEONLY",
    "p_recipient": "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
    "p_path_style": False,
}


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


def ensure_auth_user(cur, user_id):
    """An auth.users row, which the audit trigger's foreign key needs; savepointed per attempt."""
    for statement, args in (
        ("INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, 'x') ON CONFLICT (id) DO NOTHING",
         (user_id, f"{user_id}@test.invalid")),
        ("INSERT INTO auth.users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING", (user_id,)),
    ):
        try:
            cur.execute("SAVEPOINT au")
            cur.execute(statement, args)
            cur.execute("RELEASE SAVEPOINT au")
            return
        except psycopg2.Error:
            cur.execute("ROLLBACK TO SAVEPOINT au")
    raise RuntimeError(f"could not create auth user {user_id}")


def as_user(cur, user_id):
    """Become `authenticated` with a JWT subject, the way PostgREST does: claims only."""
    cur.execute("SET LOCAL ROLE authenticated")
    cur.execute('SET LOCAL "request.jwt.claims" = %s', ('{"sub": "%s"}' % user_id,))


def as_owner(cur):
    """Back to the suite's own session: the database owner, and the backup service's shape."""
    cur.execute("RESET ROLE")
    cur.execute('RESET "request.jwt.claims"')


class ForeignCredentials(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure(%s)", (HELPERS[0],))
                if cur.fetchone()[0] is None:
                    raise RuntimeError("set_foreign_credential() is absent -- 0178 did not run.")
                cur.execute("SELECT id, name FROM public.roles WHERE name IN ('Administrator', 'Operator')")
                by_name = {name: rid for rid, name in cur.fetchall()}
                for user_id in (ADMIN_ID, OPERATOR_ID):
                    ensure_auth_user(cur, user_id)
                cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING",
                    (ADMIN_ID, by_name["Administrator"], OPERATOR_ID, by_name["Operator"]),
                )
            conn.commit()
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls):
        conn = get_connection()
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM public.user_roles WHERE user_id IN %s", ((ADMIN_ID, OPERATOR_ID),))
                cur.execute("DELETE FROM auth.users WHERE id IN %s", ((ADMIN_ID, OPERATOR_ID),))
        finally:
            conn.close()

    def setUp(self):
        # Neither credential stored, whatever an earlier suite or the stack left; rolled back after.
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("DELETE FROM vault.secrets WHERE name = ANY(%s)", ([c[0] for c in CREDENTIALS],))

    def tearDown(self):
        self.cur.close()
        self.conn.rollback()
        self.conn.close()

    def call(self, fn, *args):
        self.cur.execute(
            sql.SQL("SELECT public.{}({})").format(sql.Identifier(fn), sql.SQL(", ").join(sql.Placeholder() * len(args))),
            args,
        )
        return self.cur.fetchone()[0]

    def stored(self, name):
        """(id, value) as the vault holds it, read as the owner: the one place the value is."""
        as_owner(self.cur)
        self.cur.execute("SELECT id, decrypted_secret FROM vault.decrypted_secrets WHERE name = %s", (name,))
        rows = self.cur.fetchall()
        self.assertLessEqual(len(rows), 1, f"{name} is stored {len(rows)} times")
        return rows[0] if rows else (None, None)

    # -- who may write ---------------------------------------------------------------------------

    def test_an_operator_is_refused_with_the_code_postgrest_answers_403(self):
        for name, writer, _ in CREDENTIALS:
            with self.subTest(writer=writer):
                self.cur.execute("SAVEPOINT refused")
                as_user(self.cur, OPERATOR_ID)
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as raised:
                    self.call(writer, "not-mine")
                self.assertEqual(raised.exception.pgcode, "42501")
                self.cur.execute("ROLLBACK TO SAVEPOINT refused")
                self.assertEqual(self.stored(name), (None, None))

    def test_an_empty_value_is_refused(self):
        as_user(self.cur, ADMIN_ID)
        for _, writer, _ in CREDENTIALS:
            for empty in ("", "   "):
                with self.subTest(writer=writer, value=empty):
                    self.cur.execute("SAVEPOINT refused")
                    with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                        self.call(writer, empty)
                    self.cur.execute("ROLLBACK TO SAVEPOINT refused")

    # -- whether, never what ---------------------------------------------------------------------

    def test_the_probe_is_false_then_true_and_false_for_anybody_else(self):
        for _, writer, probe in CREDENTIALS:
            with self.subTest(probe=probe):
                as_user(self.cur, ADMIN_ID)
                self.assertIs(self.call(probe), False)
                self.call(writer, "first-key")
                self.assertIs(self.call(probe), True)
                as_user(self.cur, OPERATOR_ID)
                self.assertIs(self.call(probe), False)

    def test_the_value_is_never_readable_back(self):
        # Each writer answers nothing at all: void, which psycopg2 reads as an empty string.
        for _, writer, _ in CREDENTIALS:
            self.cur.execute("SELECT prorettype::regtype::text FROM pg_proc WHERE oid = %s::regprocedure",
                             (f"public.{writer}(text)",))
            self.assertEqual(self.cur.fetchone()[0], "void", writer)
        as_user(self.cur, ADMIN_ID)
        self.assertIn(self.call("set_archive_credential", "readable?"), (None, ""))
        for relation in ("secrets", "decrypted_secrets"):
            with self.subTest(relation=relation):
                self.cur.execute("SAVEPOINT refused")
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.cur.execute(sql.SQL("SELECT * FROM vault.{}").format(sql.Identifier(relation)))
                self.cur.execute("ROLLBACK TO SAVEPOINT refused")
        # The cold archive's reader returns its row to the ingestion principal alone.
        self.cur.execute("SELECT count(*) FROM public.cold_archive_destination()")
        self.assertEqual(self.cur.fetchone()[0], 0)
        as_owner(self.cur)
        for role in ("anon", "authenticated", "service_role"):
            self.cur.execute("SELECT has_function_privilege(%s, 'public.backup_offsite_destination()', 'EXECUTE')", (role,))
            self.assertFalse(self.cur.fetchone()[0], f"{role} may read the off-site key")

    def test_neither_helper_is_callable_through_postgrest(self):
        """So an Administrator cannot name a stack-internal secret, such as gateway_revoke_secret."""
        for role in ("anon", "authenticated", "service_role"):
            for helper in HELPERS:
                self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE')", (role, helper))
                self.assertFalse(self.cur.fetchone()[0], f"{role} may execute {helper}")
        as_user(self.cur, ADMIN_ID)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.call("set_foreign_credential", "gateway_revoke_secret", "overwritten", "x", "x")

    # -- rotation --------------------------------------------------------------------------------

    def test_a_second_write_rotates_in_place(self):
        for name, writer, probe in CREDENTIALS:
            with self.subTest(writer=writer):
                as_user(self.cur, ADMIN_ID)
                self.call(writer, "  first-key  ")
                first_id, first_value = self.stored(name)
                self.assertEqual(first_value, "first-key", "the value is stored trimmed")
                as_user(self.cur, ADMIN_ID)
                self.call(writer, "second-key")
                second_id, second_value = self.stored(name)
                self.assertEqual(second_id, first_id, "a rotation made a new row")
                self.assertEqual(second_value, "second-key")
                as_user(self.cur, ADMIN_ID)
                self.assertIs(self.call(probe), True)

    def test_the_backup_service_reads_a_rotated_key_at_its_next_call(self):
        """backup_offsite_destination() is what the service calls on each poll; no cache between."""
        as_user(self.cur, ADMIN_ID)
        self.cur.execute(
            "SELECT public.set_backup_offsite_destination(%(p_endpoint)s, %(p_region)s, %(p_bucket)s, "
            "%(p_prefix)s, %(p_access_key_id)s, %(p_recipient)s, %(p_path_style)s)", DESTINATION)
        self.call("set_backup_offsite_credential", "first-key")
        as_owner(self.cur)
        self.cur.execute("SELECT public.backup_offsite_destination() ->> 'secret_key'")
        self.assertEqual(self.cur.fetchone()[0], "first-key")
        as_user(self.cur, ADMIN_ID)
        self.call("set_backup_offsite_credential", "second-key")
        as_owner(self.cur)
        self.cur.execute("SELECT public.backup_offsite_destination() ->> 'secret_key'")
        self.assertEqual(self.cur.fetchone()[0], "second-key")


if __name__ == "__main__":
    unittest.main(verbosity=2)
