"""
A service token shows when it was last used (0209).

    python supabase/migrations/test_a_service_token_shows_when_it_was_last_used.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: a call made as PostgREST makes it (the pre-request hook, then the function, as
`authenticated` with the token's claims) records a minted token's use to the hour, and a second
call in the same hour writes nothing, not even a row lock. A jti with no TOKEN_MINTED row, one
minted for another identity, a person's session token, a key and anon record nothing or are
refused. The function takes no argument, so a caller records only its own token. The hook refuses
a revoked token and a withdrawn identity before the function runs. Only an Administrator or an
Auditor reads the table, and nobody writes it directly. A replay of 0209 keeps what was recorded.

EVERY TEST ROLLS BACK. Each mints its tokens as TOKEN_MINTED audit rows, as 0204's suite does.
"""
import json
import os
import unittest
import uuid
from pathlib import Path

import psycopg2
from psycopg2 import errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = Path(__file__).resolve().parent / "0209_a_service_token_shows_when_it_was_last_used.sql"

ADMIN_ID = "5e000000-0209-4000-8000-0000000000ad"
MANAGER_ID = "5e000000-0209-4000-8000-0000000000b2"
OPERATOR_ID = "5e000000-0209-4000-8000-0000000000c3"
AUDITOR_ID = "5e000000-0209-4000-8000-0000000000d4"
IDENTITY_ID = "5e000000-0209-4000-8000-0000000000e5"
OTHER_IDENTITY_ID = "5e000000-0209-4000-8000-0000000000f6"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class LastUseBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.service_token_last_use') IS NOT NULL;")
                if not cur.fetchone()[0]:
                    raise unittest.SkipTest("0209 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        people = {ADMIN_ID: "Administrator", MANAGER_ID: "Shopfloor_Manager",
                  OPERATOR_ID: "Operator", AUDITOR_ID: "Auditor"}
        # A person has an email and a password; a machine identity has neither.
        for user_id in people:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, %s)"
                " ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@last-use.test", "not-a-real-hash"),
            )
        for identity in (IDENTITY_ID, OTHER_IDENTITY_ID):
            self.cur.execute("INSERT INTO auth.users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING;", (identity,))
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in people.items():
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def mint(self, principal=IDENTITY_ID, age="1 hour", days=30):
        """A TOKEN_MINTED row for a `days`-day token issued `age` ago, as 0204's suite writes one. Its jti."""
        jti = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, old_data, new_data,"
            "                                actor_source, recorded_at)"
            " SELECT 'service_principals', %s, 'TOKEN_MINTED', NULL,"
            "        jsonb_build_object('jti', %s, 'issued_at', t, 'expires_at', t + make_interval(days => %s),"
            "                           'ttl_days', %s, 'roles', '[]'::jsonb),"
            "        'service', t"
            "   FROM (SELECT now() - %s::interval AS t) issued;",
            (principal, jti, days, days, age),
        )
        return jti

    def token(self, jti, sub=IDENTITY_ID):
        """The claims mint-service-token signs."""
        return {"sub": sub, "role": "authenticated", "jti": jti}

    def as_caller(self, claims, role="authenticated"):
        self.cur.execute("SELECT set_config('role', %s, true);", (role,))
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         ("" if claims is None else json.dumps(claims),))

    def done(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    def use(self, claims, role="authenticated"):
        """
        One POST /rpc/record_service_token_use as PostgREST runs it: the hook, then the call, in a
        subtransaction of its own, so a write gets an xid of its own. A refusal is re-raised.
        """
        self.cur.execute("SAVEPOINT use;")
        try:
            self.as_caller(claims, role)
            self.cur.execute("SELECT public.auth_pre_request();")
            self.cur.execute("SELECT public.record_service_token_use();")
            recorded = self.cur.fetchone()[0]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT use;")
            raise
        self.done()
        self.cur.execute("RELEASE SAVEPOINT use;")
        return recorded

    def row(self, jti):
        """(principal_id, last_used_at is this hour, xmin, xmax, ctid), or None."""
        self.cur.execute(
            "SELECT principal_id::text, last_used_at = date_trunc('hour', now(), 'UTC'), xmin::text, xmax::text,"
            "       ctid::text"
            "  FROM public.service_token_last_use WHERE jti = %s;", (jti,))
        return self.cur.fetchone()

    def refused(self, sql_text, params=None):
        self.cur.execute("SAVEPOINT refused;")
        try:
            with self.assertRaises(errors.InsufficientPrivilege):
                self.cur.execute(sql_text, params)
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT refused;")


class RecordingAUse(LastUseBase):

    def test_a_minted_token_s_use_is_recorded_to_the_hour(self):
        jti = self.mint()
        self.assertTrue(self.use(self.token(jti)))
        principal, this_hour = self.row(jti)[:2]
        self.assertEqual(principal, IDENTITY_ID)
        self.assertTrue(this_hour, "last_used_at is not the start of this hour")

    def test_the_hour_is_utc_s_whatever_the_session_s_time_zone(self):
        # Half an hour off UTC, so a local hour would start at :30 past a UTC one.
        self.cur.execute("SELECT set_config('TimeZone', 'Asia/Kolkata', true);")
        jti = self.mint()
        self.assertTrue(self.use(self.token(jti)))
        self.assertTrue(self.row(jti)[1], "last_used_at is not the start of this UTC hour")

    def test_a_second_call_in_the_same_hour_writes_nothing(self):
        jti = self.mint()
        self.assertTrue(self.use(self.token(jti)))
        before = self.row(jti)
        self.assertFalse(self.use(self.token(jti)))
        after = self.row(jti)
        self.assertEqual((after[2], after[4]), (before[2], before[4]), "the second call wrote a new row version")
        self.assertEqual(after[3], "0", "the second call took a row lock")

    def test_a_later_hour_moves_it_forward_and_nothing_moves_it_back(self):
        jti = self.mint()
        self.use(self.token(jti))
        self.cur.execute("UPDATE public.service_token_last_use SET last_used_at = last_used_at - interval '3 hours'"
                         " WHERE jti = %s;", (jti,))
        self.assertTrue(self.use(self.token(jti)))
        self.assertTrue(self.row(jti)[1])

        # A replica whose clock ran ahead recorded the next hour; this one does not undo it.
        self.cur.execute("UPDATE public.service_token_last_use SET last_used_at = last_used_at + interval '1 hour'"
                         " WHERE jti = %s;", (jti,))
        self.assertFalse(self.use(self.token(jti)))
        self.assertFalse(self.row(jti)[1])

    def test_a_use_writes_no_audit_row(self):
        jti = self.mint()
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_id = %s;", (IDENTITY_ID,))
        before = self.cur.fetchone()[0]
        self.use(self.token(jti))
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_id = %s;", (IDENTITY_ID,))
        self.assertEqual(self.cur.fetchone()[0], before)

    def test_a_replay_of_0209_keeps_what_was_recorded(self):
        jti = self.mint()
        self.use(self.token(jti))
        before = self.row(jti)
        oids = ("SELECT (SELECT oid FROM pg_class WHERE oid = 'public.service_token_last_use'::regclass),"
                "       (SELECT oid FROM pg_policy WHERE polname = 'service_token_last_use_select_privileged');")
        self.cur.execute(oids)
        table_and_policy = self.cur.fetchone()
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.cur.execute(oids)
        self.assertEqual(self.cur.fetchone(), table_and_policy, "the replay re-created the table or its policy")
        self.assertEqual(self.row(jti), before)


class WhatRecordsNothing(LastUseBase):

    def test_a_jti_with_no_token_minted_row(self):
        jti = str(uuid.uuid4())
        self.assertFalse(self.use(self.token(jti)))
        self.assertIsNone(self.row(jti))

    def test_another_identity_s_token(self):
        # Its jti, under this identity's sub: a caller cannot name a token that is not its own.
        theirs = self.mint(OTHER_IDENTITY_ID)
        self.assertFalse(self.use(self.token(theirs)))
        self.assertIsNone(self.row(theirs))

    def test_the_function_takes_no_argument(self):
        self.cur.execute("SELECT array_agg(pronargs) FROM pg_proc"
                         " WHERE proname = 'record_service_token_use' AND pronamespace = 'public'::regnamespace;")
        self.assertEqual(self.cur.fetchone()[0], [0])

    def test_a_person_s_session_token(self):
        session = str(uuid.uuid4())
        self.cur.execute("INSERT INTO auth.sessions (id, user_id) VALUES (%s, %s);", (session, ADMIN_ID))
        claims = {"sub": ADMIN_ID, "role": "authenticated", "session_id": session, "aal": "aal1"}
        self.assertFalse(self.use(claims))
        # A jti that matches a mint, but on a person's token: the sub decides.
        jti = self.mint()
        self.assertFalse(self.use({**claims, "jti": jti}))
        self.assertIsNone(self.row(jti))

    def test_a_key_or_claims_that_name_nobody(self):
        jti = self.mint()
        for claims in ({"role": "authenticated"}, {"role": "service_role"}, {"jti": jti},
                       {"sub": "not-a-uuid", "jti": jti}, None):
            with self.subTest(claims=claims):
                self.assertFalse(self.use(claims))
        self.assertIsNone(self.row(jti))

    def test_a_mint_older_than_any_live_token(self):
        jti = self.mint(age="92 days", days=90)
        self.assertFalse(self.use(self.token(jti)))
        self.assertIsNone(self.row(jti))

    def test_anon_and_the_service_role_are_refused(self):
        jti = self.mint()
        for role in ("anon", "service_role"):
            with self.subTest(role=role):
                self.as_caller(self.token(jti), role)
                try:
                    self.refused("SELECT public.record_service_token_use();")
                finally:
                    self.done()
        self.assertIsNone(self.row(jti))


class TheHookAnswersFirst(LastUseBase):
    """PostgREST runs auth_pre_request() before the call, so a refused token never reaches it."""

    def test_a_revoked_token(self):
        jti = self.mint()
        self.cur.execute("INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
                         " VALUES (%s, %s, now() + interval '1 day');", (jti, IDENTITY_ID))
        with self.assertRaises(errors.InsufficientPrivilege):
            self.use(self.token(jti))
        self.assertIsNone(self.row(jti))

    def test_a_withdrawn_identity(self):
        jti = self.mint()
        self.cur.execute("INSERT INTO public.revoked_service_principals (principal_id) VALUES (%s);", (IDENTITY_ID,))
        with self.assertRaises(errors.InsufficientPrivilege):
            self.use(self.token(jti))
        self.assertIsNone(self.row(jti))


class WhoReadsIt(LastUseBase):

    def visible(self, user_id):
        self.as_caller({"sub": user_id, "role": "authenticated"})
        try:
            self.cur.execute("SELECT jti FROM public.service_token_last_use;")
            return {r[0] for r in self.cur.fetchall()}
        finally:
            self.done()

    def test_an_administrator_and_an_auditor_read_it_and_nobody_else(self):
        jti = self.mint()
        self.use(self.token(jti))
        for user_id in (ADMIN_ID, AUDITOR_ID):
            self.assertIn(jti, self.visible(user_id), user_id)
        for user_id in (MANAGER_ID, OPERATOR_ID, IDENTITY_ID):
            self.assertNotIn(jti, self.visible(user_id), user_id)
        self.as_caller(None, "anon")
        try:
            self.refused("SELECT 1 FROM public.service_token_last_use;")
        finally:
            self.done()

    def test_nobody_writes_it_directly(self):
        jti = self.mint()
        self.as_caller({"sub": ADMIN_ID, "role": "authenticated"})
        try:
            self.refused("INSERT INTO public.service_token_last_use (jti, principal_id, last_used_at)"
                         " VALUES (%s, %s, now());", (jti, IDENTITY_ID))
            self.refused("UPDATE public.service_token_last_use SET last_used_at = now();")
            self.refused("DELETE FROM public.service_token_last_use;")
        finally:
            self.done()


if __name__ == "__main__":
    unittest.main(verbosity=2)
