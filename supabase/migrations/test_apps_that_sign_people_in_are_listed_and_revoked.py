"""
Apps that sign people in are listed, and an approval or an app can be taken back (0217).

    python supabase/migrations/test_apps_that_sign_people_in_are_listed_and_revoked.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: list_apps() shows an Administrator every app not removed, the stack's four
marked, with how many people allow each, and never a secret; app_approvals() shows who allows one;
list_my_app_approvals() shows a person their own and nobody else's. revoke_app_approval() does what
GoTrue's revoke does, for that person and that app only: the approval is revoked and that app's
sessions for them end with their refresh tokens. remove_app() refuses the stack's own, and for any
other revokes every approval, ends every session and removes it. Each act writes its Audit Trail
row naming who did it, whether a dashboard call or GoTrue itself wrote the table, and 0002's
re-seed on a boot writes none.

GoTrue's own writes are made as GoTrue's role (`SET LOCAL ROLE supabase_auth_admin`, which the
test fixture lets `postgres` do), with no token, as GoTrue makes them.

EVERY TEST ROLLS BACK. The acts write Audit Trail rows, and the audit table cannot be pruned.
"""
import json
import os
import re
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

SEED = Path(__file__).resolve().parent / "0002_seed_data.sql"

ADMIN_ID = "a0d17070-0000-4000-8000-0000000217a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000217a2"
OPERATOR_ID = "a0d17070-0000-4000-8000-0000000217a3"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000217a4"
OTHER_ID = "a0d17070-0000-4000-8000-0000000217b1"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000217c1"
MACHINE_ID = "a0d17070-0000-4000-8000-0000000217d1"

GRAFANA = "c0ffee00-0000-4000-8000-000000000001"
NODE_RED = "c0ffee00-0000-4000-8000-000000000002"
STUDIO = "c0ffee00-0000-4000-8000-000000000003"
FORGE = "c0ffee00-0000-4000-8000-000000000004"
STACK = [GRAFANA, NODE_RED, STUDIO, FORGE]
REPORTS = "a0d17070-0000-4000-8000-0000000217e1"     # added through GoTrue's admin API
GONE = "a0d17070-0000-4000-8000-0000000217e2"        # removed already
FIXTURE_APPS = STACK + [REPORTS, GONE]

ADMIN_BROWSER = "a0d17070-0000-4000-8000-0000000217f0"
OPERATOR_BROWSER = "a0d17070-0000-4000-8000-0000000217f1"
OPERATOR_GRAFANA = "a0d17070-0000-4000-8000-0000000217f2"
OPERATOR_GRAFANA_2 = "a0d17070-0000-4000-8000-0000000217f3"
OPERATOR_NODE_RED = "a0d17070-0000-4000-8000-0000000217f4"
OPERATOR_REPORTS = "a0d17070-0000-4000-8000-0000000217f5"
OTHER_GRAFANA = "a0d17070-0000-4000-8000-0000000217f6"
OTHER_REPORTS = "a0d17070-0000-4000-8000-0000000217f7"

NOW = datetime(2026, 10, 28, 9, 0, tzinfo=timezone.utc)

LIST_COLUMNS = ["id", "client_name", "registration_type", "part_of_stack", "client_type",
                "redirect_uris", "client_uri", "created_at", "people_allowing"]
APPROVAL_COLUMNS = ["user_id", "email", "display_name", "scopes", "granted_at"]
MY_COLUMNS = ["client_id", "client_name", "client_uri", "part_of_stack", "scopes", "granted_at"]
APP_FACT_KEYS = {"name", "registration_type", "client_type", "redirect_uris", "grant_types",
                 "client_uri", "part_of_stack"}
APPROVAL_KEYS = {"email", "app", "scopes", "granted_at"}


def email_of(user_id):
    return f"{user_id}@apps.test"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def seed_block(client_id):
    """0002's DO block that registers the stack app with this pinned id, as db-init runs it."""
    text = SEED.read_text(encoding="utf-8")
    at = text.index(f"v_client_id CONSTANT UUID := '{client_id}'")
    start = text.rindex("DO $$", 0, at)
    end = text.index("END $$;", at) + len("END $$;")
    return text[start:end]


class AppsBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.remove_app(uuid)'), to_regclass('auth.oauth_consents');")
        if None in self.cur.fetchone():
            self.skipTest("0217 or the GoTrue fixture's auth.oauth_consents is not in this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        people = [
            (ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"), (OPERATOR_ID, "Operator"),
            (AUDITOR_ID, "Auditor"), (OTHER_ID, "Operator"), (NO_ROLE_ID, None),
        ]
        for user_id, role in people:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, email_of(user_id)),
            )
            if role:
                self.cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (user_id, roles[role]),
                )
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, NULL, NULL, now()) ON CONFLICT (id) DO NOTHING;",
            (MACHINE_ID,),
        )
        self.cur.execute(
            "INSERT INTO public.person_profiles (user_id, display_name) VALUES (%s, 'Owain Operator')"
            " ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name;",
            (OPERATOR_ID,),
        )
        # (id, name, registration, redirect addresses, removed)
        apps = [
            (GRAFANA, "Aber Grafana", "manual", "http://grafana.test/login/generic_oauth", None),
            (NODE_RED, "Aber Node-RED", "manual", "http://nodered.test/auth/strategy/callback", None),
            (STUDIO, "Aber Supabase Studio", "manual", "http://studio.test/oauth2/callback", None),
            (FORGE, "Aber Forge", "manual", "http://git.test/oauth2/callback", None),
            (REPORTS, "Shift Reports", "manual", "https://reports.test/cb, https://reports.test/cb2", None),
            (GONE, "Old Tool", "manual", "https://old.test/cb", NOW - timedelta(days=30)),
        ]
        for app_id, name, registration, redirects, removed in apps:
            self.cur.execute(
                "INSERT INTO auth.oauth_clients"
                " (id, registration_type, client_name, redirect_uris, grant_types, client_uri,"
                "  client_secret_hash, created_at, deleted_at)"
                " VALUES (%s, %s, %s, %s, 'authorization_code,refresh_token', %s, 'a-hash', %s, %s)"
                " ON CONFLICT (id) DO UPDATE SET client_name = EXCLUDED.client_name,"
                "  redirect_uris = EXCLUDED.redirect_uris, grant_types = EXCLUDED.grant_types,"
                "  client_uri = EXCLUDED.client_uri, client_secret_hash = EXCLUDED.client_secret_hash,"
                "  created_at = EXCLUDED.created_at, deleted_at = EXCLUDED.deleted_at;",
                (app_id, registration, name, redirects, f"https://{name.lower().replace(' ', '-')}.test",
                 NOW - timedelta(days=60), removed),
            )
        # (person, app, scopes, granted, revoked)
        self.cur.execute("DELETE FROM auth.oauth_consents WHERE client_id = ANY(%s::uuid[]);", (FIXTURE_APPS,))
        consents = [
            (OPERATOR_ID, GRAFANA, "openid email profile", NOW - timedelta(days=3), None),
            (OPERATOR_ID, NODE_RED, "openid email", NOW - timedelta(days=1), None),
            (OPERATOR_ID, REPORTS, "openid", NOW - timedelta(days=2), None),
            (OPERATOR_ID, GONE, "openid", NOW - timedelta(days=40), None),
            (OTHER_ID, GRAFANA, "openid email profile", NOW - timedelta(hours=5), None),
            (OTHER_ID, REPORTS, "openid", NOW - timedelta(hours=6), None),
            (AUDITOR_ID, GRAFANA, "openid", NOW - timedelta(days=9), NOW - timedelta(days=8)),
        ]
        for user_id, app_id, scopes, granted, revoked in consents:
            self.cur.execute(
                "INSERT INTO auth.oauth_consents (user_id, client_id, scopes, granted_at, revoked_at)"
                " VALUES (%s, %s, %s, %s, %s);",
                (user_id, app_id, scopes, granted, revoked),
            )
        # (session, person, app)
        sessions = [
            (ADMIN_BROWSER, ADMIN_ID, None),
            (OPERATOR_BROWSER, OPERATOR_ID, None),
            (OPERATOR_GRAFANA, OPERATOR_ID, GRAFANA),
            (OPERATOR_GRAFANA_2, OPERATOR_ID, GRAFANA),
            (OPERATOR_NODE_RED, OPERATOR_ID, NODE_RED),
            (OPERATOR_REPORTS, OPERATOR_ID, REPORTS),
            (OTHER_GRAFANA, OTHER_ID, GRAFANA),
            (OTHER_REPORTS, OTHER_ID, REPORTS),
        ]
        for session_id, user_id, app_id in sessions:
            self.start_session(session_id, user_id, app_id)

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def start_session(self, session_id, user_id, app_id=None):
        """What GoTrue does at a sign-in: one session row and its refresh tokens, two here."""
        self.cur.execute(
            "INSERT INTO auth.sessions (id, user_id, oauth_client_id, created_at, updated_at)"
            " VALUES (%s, %s, %s, now(), now());",
            (session_id, user_id, app_id),
        )
        for n in range(2):
            self.cur.execute(
                "INSERT INTO auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id)"
                " VALUES (%s, %s, false, now(), now(), %s);",
                (f"{session_id}-{n}", user_id, session_id),
            )

    def call(self, user_id, sql, args=(), session_id=ADMIN_BROWSER, role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id`. A refusal rolls back to the
        savepoint, so the test can go on, and is raised."""
        claims = {"sub": user_id, "role": role, "session_id": session_id}
        self.cur.execute("SAVEPOINT apps_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
            columns = [d.name for d in self.cur.description] if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT apps_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT apps_call;")
        self.columns = columns
        return rows

    def as_gotrue(self, sql, args=()):
        """Run `sql` as GoTrue does: its own role, and no token."""
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("SET LOCAL ROLE supabase_auth_admin;")
        try:
            self.cur.execute(sql, args)
        finally:
            self.cur.execute("RESET ROLE;")

    def dicts(self, rows):
        return [dict(zip(self.columns, r)) for r in rows]

    def apps(self, caller=ADMIN_ID):
        rows = self.dicts(self.call(caller, "SELECT * FROM public.list_apps();"))
        return {str(a["id"]): a for a in rows if str(a["id"]) in FIXTURE_APPS}

    def approvals(self, app_id, caller=ADMIN_ID):
        return self.dicts(self.call(caller, "SELECT * FROM public.app_approvals(%s);", (app_id,)))

    def mine(self, caller):
        return self.dicts(self.call(caller, "SELECT * FROM public.list_my_app_approvals();"))

    def revoke(self, user_id, app_id, caller=ADMIN_ID):
        return self.call(caller, "SELECT public.revoke_app_approval(%s, %s);", (user_id, app_id))[0][0]

    def remove(self, app_id, caller=ADMIN_ID):
        return self.call(caller, "SELECT public.remove_app(%s);", (app_id,))[0][0]

    def consent(self, user_id, app_id):
        self.cur.execute(
            "SELECT scopes, granted_at, revoked_at FROM auth.oauth_consents WHERE user_id = %s AND client_id = %s;",
            (user_id, app_id),
        )
        return self.cur.fetchone()

    def sessions_of(self, user_id):
        self.cur.execute("SELECT id::text FROM auth.sessions WHERE user_id = %s ORDER BY id;", (user_id,))
        return [r[0] for r in self.cur.fetchall()]

    def refresh_tokens_of(self, session_id):
        self.cur.execute("SELECT count(*) FROM auth.refresh_tokens WHERE session_id = %s;", (session_id,))
        return self.cur.fetchone()[0]

    def deleted_at(self, app_id):
        self.cur.execute("SELECT deleted_at FROM auth.oauth_clients WHERE id = %s;", (app_id,))
        return self.cur.fetchone()[0]

    def last_audit_id(self):
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail;")
        return self.cur.fetchone()[0]

    def rows_since(self, since):
        self.cur.execute(
            "SELECT entity_type, entity_id::text, action, old_data, new_data, changed_by::text, actor_source,"
            "       audit_domain, causation_id"
            "  FROM public.audit_trail WHERE id > %s ORDER BY id;",
            (since,),
        )
        keys = ["entity_type", "entity_id", "action", "old_data", "new_data", "changed_by",
                "actor_source", "audit_domain", "causation_id"]
        return [dict(zip(keys, r)) for r in self.cur.fetchall()]

    def txid(self):
        self.cur.execute("SELECT txid_current();")
        return self.cur.fetchone()[0]

    def assert_not_found(self, sql, args=(), caller=ADMIN_ID):
        with self.assertRaises(psycopg2.Error) as refused:
            self.call(caller, sql, args)
        self.assertEqual(refused.exception.pgcode, "PGRST")
        self.assertEqual(json.loads(refused.exception.diag.message_primary)["code"], "P0002")

    def refused_by_api(self, session_id, user_id):
        """Whether auth_pre_request() refuses a token naming this session, as PostgREST runs it."""
        claims = {"sub": user_id, "role": "authenticated", "session_id": session_id}
        self.cur.execute("SAVEPOINT pre_request;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute("SELECT public.auth_pre_request();")
        except psycopg2.Error as error:
            self.cur.execute("ROLLBACK TO SAVEPOINT pre_request;")
            return error.pgcode == "PGRST" and json.loads(error.diag.message_primary)["code"] == "session_not_found"
        self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT pre_request;")
        return False


class ListingTheApps(AppsBase):
    def test_an_administrator_sees_every_app_not_removed(self):
        apps = self.apps()
        self.assertEqual(self.columns, LIST_COLUMNS)
        self.assertEqual(set(apps), set(STACK + [REPORTS]))

    def test_the_stacks_own_come_first_and_are_marked(self):
        rows = self.dicts(self.call(ADMIN_ID, "SELECT * FROM public.list_apps();"))
        ids = [str(r["id"]) for r in rows]
        self.assertLess(max(ids.index(a) for a in STACK), ids.index(REPORTS))
        apps = self.apps()
        for app_id in STACK:
            self.assertTrue(apps[app_id]["part_of_stack"], app_id)
        self.assertFalse(apps[REPORTS]["part_of_stack"])

    def test_each_row_says_how_it_was_registered_and_where_it_sends_people(self):
        reports = self.apps()[REPORTS]
        self.assertEqual(reports["client_name"], "Shift Reports")
        self.assertEqual(reports["registration_type"], "manual")
        self.assertEqual(reports["client_type"], "confidential")
        self.assertEqual(reports["redirect_uris"], ["https://reports.test/cb", "https://reports.test/cb2"])
        self.assertEqual(reports["created_at"], NOW - timedelta(days=60))

    def test_people_allowing_counts_the_approvals_in_force(self):
        apps = self.apps()
        # The Auditor's Grafana approval was revoked; the Operator's of a removed app does not count.
        self.assertEqual(apps[GRAFANA]["people_allowing"], 2)
        self.assertEqual(apps[NODE_RED]["people_allowing"], 1)
        self.assertEqual(apps[REPORTS]["people_allowing"], 2)
        self.assertEqual(apps[STUDIO]["people_allowing"], 0)

    def test_no_secret_is_returned(self):
        self.apps()
        self.assertNotIn("client_secret_hash", self.columns)

    def test_only_an_administrator_may_list_them(self):
        for caller in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NO_ROLE_ID, MACHINE_ID):
            with self.subTest(caller=caller):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.apps(caller)

    def test_anon_and_service_role_may_not_execute_them(self):
        for fn in ("SELECT * FROM public.list_apps();",
                   f"SELECT * FROM public.app_approvals('{GRAFANA}');",
                   "SELECT * FROM public.list_my_app_approvals();",
                   f"SELECT public.revoke_app_approval('{OPERATOR_ID}', '{GRAFANA}');",
                   f"SELECT public.remove_app('{REPORTS}');"):
            for role in ("anon", "service_role"):
                with self.subTest(fn=fn, role=role):
                    with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                        self.call(ADMIN_ID, fn, role=role)


class WhoAllowsAnApp(AppsBase):
    def test_every_approval_in_force_newest_first(self):
        rows = self.approvals(GRAFANA)
        self.assertEqual(self.columns, APPROVAL_COLUMNS)
        self.assertEqual([str(r["user_id"]) for r in rows], [OTHER_ID, OPERATOR_ID])
        operator = rows[1]
        self.assertEqual(operator["email"], email_of(OPERATOR_ID))
        self.assertEqual(operator["display_name"], "Owain Operator")
        self.assertEqual(operator["scopes"], ["openid", "email", "profile"])
        self.assertEqual(operator["granted_at"], NOW - timedelta(days=3))
        self.assertIsNone(rows[0]["display_name"])

    def test_a_removed_or_unknown_app_is_not_found(self):
        self.assert_not_found("SELECT * FROM public.app_approvals(%s);", (GONE,))
        self.assert_not_found("SELECT * FROM public.app_approvals(%s);", (str(uuid.uuid4()),))

    def test_only_an_administrator_may_ask(self):
        for caller in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NO_ROLE_ID, MACHINE_ID):
            with self.subTest(caller=caller):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.approvals(GRAFANA, caller)


class YourOwnApprovals(AppsBase):
    def test_a_person_sees_their_own_in_force_and_nobody_elses(self):
        rows = self.mine(OPERATOR_ID)
        self.assertEqual(self.columns, MY_COLUMNS)
        # Newest first; the removed app is left out, as GoTrue's own list leaves it out.
        self.assertEqual([str(r["client_id"]) for r in rows], [NODE_RED, REPORTS, GRAFANA])
        grafana = rows[2]
        self.assertEqual(grafana["client_name"], "Aber Grafana")
        self.assertTrue(grafana["part_of_stack"])
        self.assertEqual(grafana["scopes"], ["openid", "email", "profile"])
        self.assertEqual([str(r["client_id"]) for r in self.mine(OTHER_ID)], [GRAFANA, REPORTS])

    def test_a_revoked_approval_is_not_listed(self):
        self.assertEqual(self.mine(AUDITOR_ID), [])

    def test_an_administrator_sees_only_their_own_here(self):
        self.assertEqual(self.mine(ADMIN_ID), [])

    def test_a_caller_with_no_role_is_refused(self):
        for caller in (NO_ROLE_ID, MACHINE_ID):
            with self.subTest(caller=caller):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.mine(caller)


class AnAdministratorRevokesAnApproval(AppsBase):
    def test_the_approval_and_that_apps_sessions_for_that_person_end(self):
        self.assertEqual(self.revoke(OPERATOR_ID, GRAFANA), 2)
        self.assertIsNotNone(self.consent(OPERATOR_ID, GRAFANA)[2])
        for gone in (OPERATOR_GRAFANA, OPERATOR_GRAFANA_2):
            self.assertNotIn(gone, self.sessions_of(OPERATOR_ID))
            self.assertEqual(self.refresh_tokens_of(gone), 0)
            self.assertTrue(self.refused_by_api(gone, OPERATOR_ID))
        # Their dashboard and their other apps, and the other person's Grafana, are untouched.
        self.assertEqual(self.sessions_of(OPERATOR_ID), sorted([OPERATOR_BROWSER, OPERATOR_NODE_RED, OPERATOR_REPORTS]))
        self.assertEqual(self.sessions_of(OTHER_ID), sorted([OTHER_GRAFANA, OTHER_REPORTS]))
        self.assertIsNone(self.consent(OTHER_ID, GRAFANA)[2])
        self.assertIsNone(self.consent(OPERATOR_ID, NODE_RED)[2])
        self.assertFalse(self.refused_by_api(OPERATOR_BROWSER, OPERATOR_ID))

    def test_the_app_asks_again_next_time(self):
        self.revoke(OPERATOR_ID, GRAFANA)
        self.assertNotIn(GRAFANA, [str(r["client_id"]) for r in self.mine(OPERATOR_ID)])
        self.assertEqual(self.apps()[GRAFANA]["people_allowing"], 1)

    def test_one_row_in_the_persons_lane_names_the_administrator(self):
        before = self.last_audit_id()
        self.revoke(OPERATOR_ID, GRAFANA)
        rows = self.rows_since(before)
        self.assertEqual(len(rows), 1, rows)
        row = rows[0]
        self.assertEqual((row["entity_type"], row["entity_id"], row["action"]),
                         ("user_roles", OPERATOR_ID, "APP_APPROVAL_REVOKED"))
        self.assertEqual((row["changed_by"], row["actor_source"], row["audit_domain"]), (ADMIN_ID, "user", "security"))
        self.assertIsNone(row["old_data"])
        self.assertEqual(set(row["new_data"]), APPROVAL_KEYS | {"revoked_at"})
        self.assertEqual(row["new_data"]["email"], email_of(OPERATOR_ID))
        self.assertEqual(row["new_data"]["app"], {"id": GRAFANA, "name": "Aber Grafana"})
        self.assertEqual(row["new_data"]["scopes"], ["openid", "email", "profile"])
        self.assertEqual(row["causation_id"], self.txid())

    def test_what_is_refused_writes_nothing(self):
        before = self.last_audit_id()
        # Revoked already, never given, an unknown person.
        self.assert_not_found("SELECT public.revoke_app_approval(%s, %s);", (AUDITOR_ID, GRAFANA))
        self.assert_not_found("SELECT public.revoke_app_approval(%s, %s);", (OTHER_ID, NODE_RED))
        self.assert_not_found("SELECT public.revoke_app_approval(%s, %s);", (str(uuid.uuid4()), GRAFANA))
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.revoke(MACHINE_ID, GRAFANA)
        for caller in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NO_ROLE_ID, MACHINE_ID):
            with self.subTest(caller=caller):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.revoke(OTHER_ID, GRAFANA, caller=caller)
        self.assertIsNone(self.consent(OTHER_ID, GRAFANA)[2])
        self.assertIn(OTHER_GRAFANA, self.sessions_of(OTHER_ID))
        self.assertEqual(self.rows_since(before), [])


class RemovingAnApp(AppsBase):
    def test_a_stack_app_cannot_be_removed(self):
        before = self.last_audit_id()
        for app_id in STACK:
            with self.subTest(app=app_id):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as refused:
                    self.remove(app_id)
                self.assertIn("part of Aber", refused.exception.diag.message_primary)
                self.assertIsNone(self.deleted_at(app_id))
        self.assertIsNone(self.consent(OPERATOR_ID, GRAFANA)[2])
        self.assertIn(OPERATOR_GRAFANA, self.sessions_of(OPERATOR_ID))
        self.assertEqual(self.rows_since(before), [])

    def test_removing_ends_every_approval_and_session_and_takes_it_off_the_list(self):
        result = self.remove(REPORTS)
        self.assertEqual(result, {"name": "Shift Reports", "approvals_ended": 2, "sessions_ended": 2})
        self.assertIsNotNone(self.deleted_at(REPORTS))
        for user_id in (OPERATOR_ID, OTHER_ID):
            self.assertIsNotNone(self.consent(user_id, REPORTS)[2])
        for gone, user_id in ((OPERATOR_REPORTS, OPERATOR_ID), (OTHER_REPORTS, OTHER_ID)):
            self.assertNotIn(gone, self.sessions_of(user_id))
            self.assertEqual(self.refresh_tokens_of(gone), 0)
        self.assertIn(OPERATOR_GRAFANA, self.sessions_of(OPERATOR_ID))
        self.assertIn(OTHER_GRAFANA, self.sessions_of(OTHER_ID))
        self.assertNotIn(REPORTS, self.apps())
        self.assertNotIn(REPORTS, [str(r["client_id"]) for r in self.mine(OPERATOR_ID)])

    def test_the_removal_and_each_ended_approval_are_recorded_in_one_act(self):
        before = self.last_audit_id()
        self.remove(REPORTS)
        rows = self.rows_since(before)
        by_action = {}
        for row in rows:
            by_action.setdefault(row["action"], []).append(row)
        self.assertEqual(sorted(by_action), ["APP_APPROVAL_REVOKED", "APP_REMOVED"])
        removed = by_action["APP_REMOVED"]
        self.assertEqual(len(removed), 1)
        removed = removed[0]
        self.assertEqual((removed["entity_type"], removed["entity_id"]), ("oauth_clients", REPORTS))
        self.assertEqual((removed["changed_by"], removed["actor_source"], removed["audit_domain"]),
                         (ADMIN_ID, "user", "security"))
        self.assertEqual(set(removed["new_data"]), APP_FACT_KEYS | {"removed_at"})
        self.assertEqual(removed["new_data"]["name"], "Shift Reports")
        self.assertFalse(removed["new_data"]["part_of_stack"])
        self.assertEqual(removed["new_data"]["redirect_uris"], ["https://reports.test/cb", "https://reports.test/cb2"])
        revoked = by_action["APP_APPROVAL_REVOKED"]
        self.assertEqual(sorted(r["entity_id"] for r in revoked), sorted([OPERATOR_ID, OTHER_ID]))
        for row in revoked:
            self.assertEqual(row["changed_by"], ADMIN_ID)
            self.assertEqual(row["new_data"]["app"], {"id": REPORTS, "name": "Shift Reports"})
        self.assertEqual({r["causation_id"] for r in rows}, {self.txid()})
        self.assertNotIn("a-hash", json.dumps([r["new_data"] for r in rows]))

    def test_a_removed_or_unknown_app_is_not_found_and_only_an_administrator_may_remove(self):
        before = self.last_audit_id()
        self.assert_not_found("SELECT public.remove_app(%s);", (GONE,))
        self.assert_not_found("SELECT public.remove_app(%s);", (str(uuid.uuid4()),))
        for caller in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NO_ROLE_ID, MACHINE_ID):
            with self.subTest(caller=caller):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.remove(REPORTS, caller=caller)
        self.assertIsNone(self.deleted_at(REPORTS))
        self.assertEqual(self.rows_since(before), [])


class GoTruesOwnWrites(AppsBase):
    """What GoTrue writes for a person, or for its admin API, recorded with who did it."""

    def test_an_approval_on_the_consent_page_names_the_person(self):
        self.cur.execute("DELETE FROM auth.oauth_consents WHERE user_id = %s AND client_id = %s;", (OTHER_ID, NODE_RED))
        before = self.last_audit_id()
        self.as_gotrue(
            "INSERT INTO auth.oauth_consents (id, user_id, client_id, scopes, granted_at)"
            " VALUES (gen_random_uuid(), %s, %s, 'openid email', now());",
            (OTHER_ID, NODE_RED),
        )
        rows = self.rows_since(before)
        self.assertEqual(len(rows), 1, rows)
        row = rows[0]
        self.assertEqual((row["entity_type"], row["entity_id"], row["action"]), ("user_roles", OTHER_ID, "APP_APPROVED"))
        self.assertEqual((row["changed_by"], row["actor_source"]), (OTHER_ID, "user"))
        self.assertEqual(set(row["new_data"]), APPROVAL_KEYS)
        self.assertEqual(row["new_data"]["app"], {"id": NODE_RED, "name": "Aber Node-RED"})
        self.assertEqual(row["new_data"]["scopes"], ["openid", "email"])

    def test_the_persons_own_revoke_names_them(self):
        before = self.last_audit_id()
        # UserRevokeOAuthGrant: the consent's revoked_at, then that app's sessions for the person.
        self.as_gotrue(
            "UPDATE auth.oauth_consents SET revoked_at = now() WHERE user_id = %s AND client_id = %s;",
            (OPERATOR_ID, GRAFANA),
        )
        self.as_gotrue("DELETE FROM auth.sessions WHERE user_id = %s AND oauth_client_id = %s;", (OPERATOR_ID, GRAFANA))
        rows = self.rows_since(before)
        self.assertEqual([(r["action"], r["entity_id"], r["changed_by"], r["actor_source"]) for r in rows],
                         [("APP_APPROVAL_REVOKED", OPERATOR_ID, OPERATOR_ID, "user")])
        self.assertNotIn(OPERATOR_GRAFANA, self.sessions_of(OPERATOR_ID))

    def test_approving_again_after_a_revoke_is_an_approval(self):
        before = self.last_audit_id()
        # UpsertOAuthServerConsent on the revoked row: new scopes and time, revoked_at cleared.
        self.as_gotrue(
            "UPDATE auth.oauth_consents SET scopes = 'openid email', granted_at = now(), revoked_at = NULL"
            " WHERE user_id = %s AND client_id = %s;",
            (AUDITOR_ID, GRAFANA),
        )
        rows = self.rows_since(before)
        self.assertEqual([(r["action"], r["changed_by"]) for r in rows], [("APP_APPROVED", AUDITOR_ID)])
        self.assertEqual(rows[0]["new_data"]["scopes"], ["openid", "email"])

    def test_an_update_that_leaves_the_approval_as_it_was_writes_nothing(self):
        before = self.last_audit_id()
        self.as_gotrue("UPDATE auth.oauth_consents SET scopes = scopes WHERE client_id = %s;", (GRAFANA,))
        self.cur.execute("UPDATE auth.oauth_consents SET revoked_at = revoked_at + interval '1 second'"
                         " WHERE user_id = %s AND client_id = %s;", (AUDITOR_ID, GRAFANA))
        self.assertEqual(self.rows_since(before), [])

    def test_the_admin_apis_registration_and_removal_are_recorded_as_a_service(self):
        new_app = str(uuid.uuid4())
        before = self.last_audit_id()
        self.as_gotrue(
            "INSERT INTO auth.oauth_clients (id, registration_type, client_name, redirect_uris, grant_types,"
            " client_secret_hash, client_type)"
            " VALUES (%s, 'manual', 'Line Board', 'https://board.test/cb', 'authorization_code', 'a-hash', 'confidential');",
            (new_app,),
        )
        self.as_gotrue("UPDATE auth.oauth_clients SET updated_at = now() WHERE id = %s;", (new_app,))
        self.as_gotrue("UPDATE auth.oauth_clients SET deleted_at = now() WHERE id = %s;", (new_app,))
        rows = self.rows_since(before)
        self.assertEqual([r["action"] for r in rows], ["APP_REGISTERED", "APP_REMOVED"])
        for row in rows:
            self.assertEqual((row["entity_type"], row["entity_id"]), ("oauth_clients", new_app))
            self.assertEqual((row["changed_by"], row["actor_source"], row["audit_domain"]), (None, "service", "security"))
            self.assertIsNone(row["old_data"])
        self.assertEqual(set(rows[0]["new_data"]), APP_FACT_KEYS)
        self.assertEqual(rows[0]["new_data"]["grant_types"], ["authorization_code"])
        self.assertNotIn("a-hash", json.dumps(rows[0]["new_data"]))

    def test_deleting_a_live_app_outright_is_a_removal(self):
        before = self.last_audit_id()
        self.cur.execute("DELETE FROM auth.oauth_clients WHERE id IN (%s, %s);", (REPORTS, GONE))
        rows = self.rows_since(before)
        # The app already removed is not removed twice; the consents went with it and write nothing.
        self.assertEqual([(r["action"], r["entity_id"], r["actor_source"]) for r in rows],
                         [("APP_REMOVED", REPORTS, "migration")])


class TheBootsReseed(AppsBase):
    """0002's seed of a stack app, run as db-init runs it on every boot."""

    def seed_grafana(self):
        self.cur.execute("SELECT set_config('aber.grafana_oauth_client_secret', 'a-test-secret', true);")
        self.cur.execute("SELECT set_config('aber.grafana_public_url', 'http://grafana.test', true);")
        self.cur.execute(seed_block(GRAFANA))

    def test_a_reseed_of_a_registered_app_writes_nothing(self):
        before = self.last_audit_id()
        self.seed_grafana()
        self.seed_grafana()
        self.assertEqual(self.rows_since(before), [])
        self.assertEqual(self.apps()[GRAFANA]["redirect_uris"], ["http://grafana.test/login/generic_oauth"])

    def test_the_first_seed_writes_one_registration(self):
        self.cur.execute("DELETE FROM auth.oauth_clients WHERE id = %s;", (GRAFANA,))
        before = self.last_audit_id()
        self.seed_grafana()
        self.seed_grafana()
        rows = self.rows_since(before)
        self.assertEqual([(r["action"], r["entity_id"], r["changed_by"], r["actor_source"]) for r in rows],
                         [("APP_REGISTERED", GRAFANA, None, "migration")])
        self.assertTrue(rows[0]["new_data"]["part_of_stack"])
        self.assertEqual(rows[0]["new_data"]["name"], "Aber Grafana")

    def test_a_stack_app_removed_behind_the_dashboard_is_restored_and_recorded(self):
        self.as_gotrue("UPDATE auth.oauth_clients SET deleted_at = now() WHERE id = %s;", (GRAFANA,))
        before = self.last_audit_id()
        self.seed_grafana()
        rows = self.rows_since(before)
        self.assertEqual([(r["action"], r["actor_source"]) for r in rows], [("APP_RESTORED", "migration")])
        self.assertIsNone(self.deleted_at(GRAFANA))

    def test_the_seed_block_is_the_one_0002_runs(self):
        block = seed_block(GRAFANA)
        self.assertTrue(block.startswith("DO $$"))
        self.assertIn("ON CONFLICT (id) DO UPDATE SET", block)
        self.assertIsNotNone(re.search(r"deleted_at\s+= NULL", block))


class TheFunctions(AppsBase):
    def test_each_runs_as_its_owner_with_a_pinned_search_path(self):
        for fn in ("public.list_apps()", "public.app_approvals(uuid)", "public.list_my_app_approvals()",
                   "public.revoke_app_approval(uuid, uuid)", "public.remove_app(uuid)",
                   "public.log_app_registration()", "public.log_app_approval()"):
            with self.subTest(fn=fn):
                self.cur.execute("SELECT prosecdef, proconfig FROM pg_proc WHERE oid = %s::regprocedure;", (fn,))
                secdef, config = self.cur.fetchone()
                self.assertTrue(secdef)
                self.assertIn("search_path=public", config)

    def test_the_trigger_functions_and_helpers_are_nobodys_to_call(self):
        for fn in ("public.log_app_registration()", "public.log_app_approval()", "public.stack_app_ids()",
                   "public.app_facts(jsonb)", "public.app_list_items(text, text)"):
            for role in ("anon", "authenticated", "service_role"):
                with self.subTest(fn=fn, role=role):
                    self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE');", (role, fn))
                    self.assertFalse(self.cur.fetchone()[0])

    def test_the_stacks_own_are_the_four_0002_seeds(self):
        self.cur.execute("SELECT public.stack_app_ids()::text[];")
        self.assertEqual(sorted(self.cur.fetchone()[0]), sorted(STACK))
        seeded = re.findall(r"v_client_id CONSTANT UUID := '([0-9a-f-]+)'", SEED.read_text(encoding="utf-8"))
        self.assertEqual(sorted(seeded), sorted(STACK))


if __name__ == "__main__":
    unittest.main()
