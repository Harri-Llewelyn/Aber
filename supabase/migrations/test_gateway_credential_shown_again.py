"""
An Administrator can show a Host gateway's broker credential again (0164).

    python supabase/migrations/test_gateway_credential_shown_again.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: who may keep a copy and who may see it, that each showing is recorded without
the password, that only a Host or Simulated gateway keeps one, that issuing again replaces it, and
that archiving or deleting the gateway removes it -- the moment its broker account is disabled.

EVERY TEST ROLLS BACK. The suite writes Audit Trail rows and Vault secrets on purpose, and the audit
table cannot be pruned, so nothing it does is committed.
"""
import json
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "a0d17070-0000-4000-8000-0000000164a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000164b2"
OPERATOR_ID = "a0d17070-0000-4000-8000-0000000164c3"

KEEP = "public.keep_gateway_credential(uuid, text)"
SHOW = "public.show_gateway_credential(uuid)"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class ShownAgain(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s), to_regprocedure(%s);", (KEEP, SHOW))
        if None in self.cur.fetchone():
            self.skipTest("0164 is not applied to this database")
        # People, not just role grants: audit_trail.changed_by references auth.users, and the
        # showing and the archive both write a row as whoever is signed in.
        for user_id in (ADMIN_ID, MANAGER_ID, OPERATOR_ID):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, %s)"
                " ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@shown-again.test", "not-a-real-hash"),
            )
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s), (%s, %s)"
            " ON CONFLICT (user_id, role_id) DO NOTHING;",
            (ADMIN_ID, roles["Administrator"], MANAGER_ID, roles["Shopfloor_Manager"],
             OPERATOR_ID, roles["Operator"]),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def gateway(self, deployment="host"):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment) "
            "VALUES (%s, %s, 'shown-again suite', %s) RETURNING sparkplug_id;",
            (gid, f"Test_Shown_{gid[:8]}", deployment),
        )
        return gid, self.cur.fetchone()[0]

    def as_user(self, user_id):
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))

    def as_owner(self):
        self.cur.execute("RESET ROLE;")

    def keep(self, user_id, gid, password):
        self.as_user(user_id)
        self.cur.execute("SELECT public.keep_gateway_credential(%s, %s);", (gid, password))
        kept = self.cur.fetchone()[0]
        self.as_owner()
        return kept

    def show(self, user_id, gid):
        self.as_user(user_id)
        self.cur.execute("SELECT * FROM public.show_gateway_credential(%s);", (gid,))
        row = self.cur.fetchone()
        self.as_owner()
        return row

    def copies(self, gid):
        self.cur.execute(
            "SELECT count(*) FROM vault.secrets WHERE name = %s;", (f"gateway_broker_password:{gid}",)
        )
        return self.cur.fetchone()[0]

    # -- the grants -------------------------------------------------------------------------------

    def test_anon_may_execute_neither(self):
        for fn in (KEEP, SHOW):
            self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE');", (fn,))
            self.assertFalse(self.cur.fetchone()[0], fn)

    # -- keeping and showing ----------------------------------------------------------------------

    def test_a_manager_keeps_it_and_an_administrator_shows_it(self):
        gid, sparkplug_id = self.gateway()
        self.assertTrue(self.keep(MANAGER_ID, gid, "first-password"))
        username, password, issued_at = self.show(ADMIN_ID, gid)
        self.assertEqual((username, password), (sparkplug_id, "first-password"))
        self.assertIsNotNone(issued_at)

    def test_each_showing_is_recorded_without_the_password(self):
        gid, sparkplug_id = self.gateway()
        self.keep(ADMIN_ID, gid, "recorded-password")
        self.show(ADMIN_ID, gid)
        self.show(ADMIN_ID, gid)
        self.cur.execute(
            "SELECT changed_by::text, new_data::text FROM public.audit_trail"
            " WHERE entity_id = %s AND action = 'CREDENTIAL_SHOWN';",
            (gid,),
        )
        rows = self.cur.fetchall()
        self.assertEqual(len(rows), 2)
        for changed_by, new_data in rows:
            self.assertEqual(changed_by, ADMIN_ID)
            self.assertIn(sparkplug_id, new_data)
            self.assertNotIn("recorded-password", new_data)

    def test_issuing_again_replaces_the_copy(self):
        gid, _ = self.gateway()
        self.keep(ADMIN_ID, gid, "old-password")
        self.keep(ADMIN_ID, gid, "new-password")
        self.assertEqual(self.copies(gid), 1)
        self.assertEqual(self.show(ADMIN_ID, gid)[1], "new-password")

    def test_only_an_administrator_may_show_it(self):
        gid, _ = self.gateway()
        self.keep(ADMIN_ID, gid, "secret")
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(errors.InsufficientPrivilege):
            self.show(MANAGER_ID, gid)
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")

    def test_an_operator_may_not_keep_one(self):
        gid, _ = self.gateway()
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(errors.InsufficientPrivilege):
            self.keep(OPERATOR_ID, gid, "secret")
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
        self.assertEqual(self.copies(gid), 0)

    def test_remote_and_playback_gateways_keep_none(self):
        remote, _ = self.gateway("remote")
        self.assertFalse(self.keep(ADMIN_ID, remote, "secret"))
        self.assertEqual(self.copies(remote), 0)

        self.cur.execute("SELECT id::text FROM public.gateways WHERE is_shadow LIMIT 1;")
        row = self.cur.fetchone()
        if row:
            self.assertFalse(self.keep(ADMIN_ID, row[0], "secret"))
            self.assertEqual(self.copies(row[0]), 0)

    def test_no_copy_is_not_found_and_says_what_to_do(self):
        # raise_not_found() (0165): SQLSTATE PGRST, with the body PostgREST answers 404 with.
        gid, _ = self.gateway()
        self.cur.execute("SAVEPOINT missing;")
        with self.assertRaises(psycopg2.Error) as raised:
            self.show(ADMIN_ID, gid)
        self.cur.execute("ROLLBACK TO SAVEPOINT missing;")
        self.assertEqual(raised.exception.pgcode, "PGRST", str(raised.exception))
        body = json.loads(raised.exception.diag.message_primary)
        self.assertEqual(body["code"], "P0002")
        self.assertEqual(
            body["message"],
            f"no copy of gateway Test_Shown_{gid[:8]}'s credential is kept; "
            "issue a new one to be able to show it again",
        )
        self.assertEqual(json.loads(raised.exception.diag.message_detail), {"status": 404, "headers": {}})

    # -- the copy goes with the broker account ----------------------------------------------------

    def test_archiving_the_gateway_removes_the_copy(self):
        gid, _ = self.gateway()
        self.keep(ADMIN_ID, gid, "secret")
        self.assertEqual(self.copies(gid), 1)
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        self.assertEqual(self.copies(gid), 0)

    def test_deleting_the_gateway_removes_the_copy(self):
        gid, _ = self.gateway()
        self.keep(ADMIN_ID, gid, "secret")
        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (gid,))
        self.assertEqual(self.copies(gid), 0)

    def test_an_unrelated_update_keeps_the_copy(self):
        gid, _ = self.gateway()
        self.keep(ADMIN_ID, gid, "secret")
        self.cur.execute("UPDATE public.gateways SET description = 'renamed' WHERE id = %s;", (gid,))
        self.assertEqual(self.copies(gid), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
